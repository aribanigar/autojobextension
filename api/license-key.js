// /api/license-key – validate (and activate) an admin-issued license key.
//   POST { key } → { valid, active, expires_at, validity_days, label }
// On the FIRST successful validation the key activates: its validity window
// starts now (expires_at = now + validity_days). After that it's time-limited.
// The extension calls this on Start; the CRM calls it on login. Both treat
// active:true as "allowed".
import { cors, sb, backendConfigured } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
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
    return res.status(200).json({
      valid: true, active, lifetime, expires_at: lifetime ? null : expires_at,
      validity_days: lk.validity_days, label: lk.label || null, email: lk.email || null,
      error: active ? undefined : 'This key has expired',
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
