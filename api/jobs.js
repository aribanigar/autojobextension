// /api/jobs – JobBot CRM API, backed by Supabase Postgres (REST)
// Env vars required (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (Settings → API in Supabase)
//   CRM_API_KEY           any secret string you choose; the extension and
//                         dashboard must send it as the x-api-key header

const TABLE = 'jobs';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
}

async function sb(path, init = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...init.headers,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel environment variables',
    });
  }
  // Who is calling? Bearer token → that account's data only.
  // Legacy x-api-key (CRM_API_KEY) → admin, sees everything.
  let user = null;
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (bearer) {
    const rows = await sb(`users?token=eq.${encodeURIComponent(bearer[1])}&select=email`).catch(() => []);
    if (!rows.length) return res.status(401).json({ error: 'Session expired – log in again' });
    user = rows[0].email;
  } else if (!process.env.CRM_API_KEY || (req.headers['x-api-key'] || '') !== process.env.CRM_API_KEY) {
    return res.status(401).json({ error: 'Log in required' });
  }
  const own = user ? `&user_email=eq.${encodeURIComponent(user)}` : '';

  try {
    if (req.method === 'GET') {
      const { status, platform, q, limit } = req.query;
      let path = `${TABLE}?order=applied_at.desc&limit=${Math.min(parseInt(limit, 10) || 200, 500)}${own}`;
      if (status)   path += `&status=eq.${encodeURIComponent(status)}`;
      if (platform) path += `&platform=eq.${encodeURIComponent(platform)}`;
      if (q)        path += `&title=ilike.${encodeURIComponent('%' + q + '%')}`;
      return res.status(200).json(await sb(path));
    }

    if (req.method === 'POST') {
      const { platform, title, company, url, status = 'applied', fit_score = null, notes = null } = req.body || {};
      if (!platform) return res.status(400).json({ error: 'platform required' });
      const rows = await sb(TABLE, {
        method: 'POST',
        body: JSON.stringify([{ platform, title, company, url, status, fit_score, notes, user_email: user }]),
      });
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const allowed = {};
      for (const k of ['status', 'notes', 'fit_score', 'company', 'title']) {
        if (k in fields) allowed[k] = fields[k];
      }
      const rows = await sb(`${TABLE}?id=eq.${encodeURIComponent(id)}${own}`, {
        method: 'PATCH',
        body: JSON.stringify(allowed),
      });
      return res.status(200).json(rows[0] || null);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`${TABLE}?id=eq.${encodeURIComponent(id)}${own}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
