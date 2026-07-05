// /api/admin – admin-only overview and manual licence control.
//   GET  ?view=users      → all accounts + whether each has an active licence
//   GET  ?view=purchases  → all purchase rows (most recent first)
//   POST { action:'grant',  email, days? }  → give a manual licence (days null = lifetime)
//   POST { action:'revoke', email }         → expire all of a user's licences
//   POST { action:'set_admin', email, is_admin } → toggle another user's admin flag
// Requires an admin bearer token.
import { cors, sb, backendConfigured, getUserByToken } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const user = await getUserByToken(req);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });

  try {
    if (req.method === 'GET') {
      if (req.query.view === 'purchases') {
        const rows = await sb('purchases?order=created_at.desc&limit=500');
        return res.status(200).json(rows);
      }
      // users + active-licence flag
      const users = await sb('users?select=id,email,is_admin,created_at&order=created_at.desc&limit=1000');
      const nowIso = new Date().toISOString();
      const active = await sb(
        `purchases?status=in.(paid,active)&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso)})&select=user_email,interval,expires_at`
      );
      const byEmail = {};
      active.forEach(p => { byEmail[p.user_email] = p; });
      return res.status(200).json(users.map(u => ({
        ...u,
        licensed: !!byEmail[u.email],
        interval: byEmail[u.email]?.interval || null,
        expires_at: byEmail[u.email]?.expires_at || null,
      })));
    }

    if (req.method === 'POST') {
      const { action, email, days, is_admin } = req.body || {};
      const target = String(email || '').trim().toLowerCase();
      if (!action) return res.status(400).json({ error: 'action required' });

      if (action === 'grant') {
        if (!target) return res.status(400).json({ error: 'email required' });
        const now = new Date();
        const expires_at = days ? new Date(now.getTime() + Number(days) * 864e5).toISOString() : null;
        const rows = await sb('purchases', {
          method: 'POST',
          body: JSON.stringify([{
            user_email: target, interval: days ? 'monthly' : 'once',
            amount_paise: 0, status: days ? 'active' : 'paid',
            starts_at: now.toISOString(), expires_at,
          }]),
        });
        return res.status(201).json(rows[0]);
      }

      if (action === 'revoke') {
        if (!target) return res.status(400).json({ error: 'email required' });
        await sb(`purchases?user_email=eq.${encodeURIComponent(target)}&status=in.(paid,active)`, {
          method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }),
        });
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_admin') {
        if (!target) return res.status(400).json({ error: 'email required' });
        await sb(`users?email=eq.${encodeURIComponent(target)}`, {
          method: 'PATCH', body: JSON.stringify({ is_admin: !!is_admin }),
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
