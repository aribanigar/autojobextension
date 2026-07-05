// /api/license – is this account allowed to use the app right now?
//   GET  (Authorization: Bearer <token>)
//     → { active: bool, is_admin: bool, email, plan, interval, expires_at, features }
// Called by the browser extension on Start and by the CRM dashboard after login.
// A 401 here means the session token is stale (someone logged in elsewhere) —
// this is what enforces one active session per account.
import { cors, backendConfigured, getUserByToken, activeLicense } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const user = await getUserByToken(req);
  if (!user) return res.status(401).json({ error: 'Session expired — log in again' });

  // Admins always have access (so you can test without buying).
  if (user.is_admin) {
    return res.status(200).json({ active: true, is_admin: true, email: user.email, plan: 'admin' });
  }

  try {
    const lic = await activeLicense(user.email);
    return res.status(200).json({
      active: !!lic,
      is_admin: false,
      email: user.email,
      plan: lic?.plan_id || null,
      interval: lic?.interval || null,
      expires_at: lic?.expires_at || null,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
