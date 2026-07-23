// /api/license-key – validate (and activate) an admin-issued license key.
//   POST { key, device_id?, claim? } → { valid, active, device_conflict?, … }
// On the FIRST successful validation the key activates: its validity window
// starts now (expires_at = now + validity_days). After that it's time-limited.
// The extension calls this on Start; the CRM calls it on login. Both treat
// active:true as "allowed".
//
// Single-device: a key binds to ONE device. The extension sends a device_id and
// `claim:true` on "Save & Activate" — that takes the key over for this device.
// Later verifies (claim:false) from a DIFFERENT device return active:false with
// device_conflict:true, so the losing device logs out. Requests WITHOUT a
// device_id (the CRM, older builds) are validated but never bound, so existing
// integrations keep working unchanged. The binding is wrapped in try/catch so a
// pre-migration DB (no device_id column) simply skips enforcement and never
// blocks a valid key.
import { cors, sb, backendConfigured } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  const deviceId = String((req.body && req.body.device_id) || '').trim().slice(0, 100);
  const claim = !!(req.body && req.body.claim);
  if (!key) return res.status(400).json({ error: 'Enter your license key' });

  try {
    const rows = await sb(`license_keys?key=eq.${encodeURIComponent(key)}&select=*`);
    const lk = rows[0];
    if (!lk) return res.status(404).json({ valid: false, error: 'Invalid license key' });
    if (lk.status === 'revoked') return res.status(403).json({ valid: false, error: 'This key has been revoked' });

    const now = Date.now();
    const lifetime = !!lk.lifetime;
    let expires_at = lk.expires_at;

    // First use of a time-limited, not-yet-activated key → start the clock.
    if (!lifetime && !expires_at && !lk.activated_at) {
      expires_at = new Date(now + (lk.validity_days || 30) * 864e5).toISOString();
      await sb(`license_keys?id=eq.${encodeURIComponent(lk.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ activated_at: new Date(now).toISOString(), expires_at }),
      });
    }

    const active = lifetime || (!!expires_at && new Date(expires_at).getTime() > now);

    // Anti-sharing thresholds. A genuine user has a laptop + maybe a desktop and
    // switches occasionally; a shared key hops across many devices and switches
    // often. Crossing either bound auto-LOCKS the key until an admin resets it.
    const DEVICE_LIMIT_30D = 4;   // distinct devices allowed in a rolling 30 days
    const SWITCH_LIMIT_24H = 8;   // device takeovers allowed in a rolling 24 hours
    const nowIso = new Date(now).toISOString();
    const pushHist = (hist, id) => [...hist, { id, at: nowIso }].slice(-60);

    // ── Single-device binding + anti-sharing throttle ─────────────────────────
    let device_conflict = false;
    let locked = lk.status === 'locked';   // an admin-resettable auto-lock
    if (active && !locked && deviceId) {
      const bound = String(lk.device_id || '').trim();
      const patchId = `license_keys?id=eq.${encodeURIComponent(lk.id)}`;
      const history = Array.isArray(lk.device_history) ? lk.device_history : [];
      try {
        if (claim) {
          if (!bound || bound === deviceId) {
            // First activation on this device, or re-activating the same one.
            await sb(patchId, {
              method: 'PATCH',
              body: JSON.stringify({
                device_id: deviceId,
                device_bound_at: bound ? (lk.device_bound_at || nowIso) : nowIso,
                device_seen_at: nowIso,
                device_history: bound === deviceId ? history : pushHist(history, deviceId),
              }),
            });
          } else {
            // Takeover attempt from a NEW device → run the anti-sharing checks.
            const cut24 = now - 24 * 3600e3, cut30 = now - 30 * 864e5;
            const distinct = new Set(history.filter(h => new Date(h.at).getTime() >= cut30).map(h => h.id));
            distinct.add(deviceId);
            const switches24 = history.filter(h => new Date(h.at).getTime() >= cut24).length + 1;
            if (distinct.size > DEVICE_LIMIT_30D || switches24 > SWITCH_LIMIT_24H) {
              // Too many devices / too much switching → lock; admin must unlock.
              await sb(patchId, { method: 'PATCH', body: JSON.stringify({ status: 'locked' }) });
              locked = true;
            } else {
              // Within limits → hand the key over to this device.
              await sb(patchId, {
                method: 'PATCH',
                body: JSON.stringify({
                  device_id: deviceId, device_bound_at: nowIso, device_seen_at: nowIso,
                  device_history: pushHist(history, deviceId),
                }),
              });
            }
          }
        } else if (bound && bound !== deviceId) {
          // A verify from a different device → this device is locked out (the
          // key is currently held elsewhere). Not a takeover: it must re-Activate.
          device_conflict = true;
        } else {
          // Same device, or not bound yet → refresh last-seen (bind if empty).
          await sb(patchId, {
            method: 'PATCH',
            body: JSON.stringify(bound
              ? { device_seen_at: nowIso }
              : { device_id: deviceId, device_bound_at: nowIso, device_seen_at: nowIso, device_history: pushHist(history, deviceId) }),
          });
        }
      } catch { /* column missing / db hiccup → skip enforcement, never block a valid key */ }
    }

    if (locked) {
      return res.status(200).json({
        valid: true, active: false, locked: true, lifetime,
        expires_at: lifetime ? null : expires_at, validity_days: lk.validity_days,
        label: lk.label || null, email: lk.email || null,
        error: 'This key is locked for use on too many devices. Contact the admin to unlock it.',
      });
    }

    if (device_conflict) {
      return res.status(200).json({
        valid: true, active: false, device_conflict: true, lifetime,
        expires_at: lifetime ? null : expires_at, validity_days: lk.validity_days,
        label: lk.label || null, email: lk.email || null,
        error: 'This key is active on another device. Re-activate here to use it on this one.',
      });
    }

    return res.status(200).json({
      valid: true, active, lifetime, expires_at: lifetime ? null : expires_at,
      validity_days: lk.validity_days, label: lk.label || null, email: lk.email || null,
      error: active ? undefined : 'This key has expired',
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
