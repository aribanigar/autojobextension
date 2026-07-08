// /api/my-key – the logged-in user's own activation key (from a purchase or an
// admin grant). GET (Authorization: Bearer <token>) → { key, active, lifetime, expires_at }
// The dashboard uses this to auto-show/save the key so the user can paste it
// into the extension without hunting for it.
import { cors, sb, backendConfigured, getUserByToken } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const user = await getUserByToken(req);
  if (!user) return res.status(401).json({ error: 'Log in required' });

  try {
    const rows = await sb(
      `license_keys?email=eq.${encodeURIComponent(user.email)}&status=eq.active&order=created_at.desc&limit=10&select=*`
    );
    const now = Date.now();
    // Prefer an active key: lifetime, or not-yet-expired, or unused.
    const pick = rows.find(k => k.lifetime || !k.expires_at || new Date(k.expires_at).getTime() > now) || rows[0];
    if (!pick) return res.status(200).json({ key: null });
    const active = pick.lifetime || !pick.expires_at || new Date(pick.expires_at).getTime() > now;
    return res.status(200).json({
      key: pick.key, active, lifetime: !!pick.lifetime,
      expires_at: pick.lifetime ? null : pick.expires_at,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
