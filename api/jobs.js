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
  // Who is calling?
  //   x-license-key    → an admin-issued key; rows are owned by that key.
  //   Bearer <token>   → an email/password account (must have an active licence).
  //   x-api-key        → legacy admin key, sees everything.
  let user = null, isAdmin = false, licenseKey = null;

  const rawKey = (req.headers['x-license-key'] || '').trim().toUpperCase();
  if (rawKey) {
    const now = new Date().toISOString();
    const lk = await sb(`license_keys?key=eq.${encodeURIComponent(rawKey)}&select=key,status,expires_at`).catch(() => []);
    if (!lk.length || lk[0].status === 'revoked') return res.status(401).json({ error: 'Invalid license key' });
    if (lk[0].expires_at && lk[0].expires_at < now) return res.status(402).json({ error: 'License key expired' });
    licenseKey = lk[0].key;
  }

  const bearer = licenseKey ? null : (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (licenseKey) {
    // Already validated above — rows are scoped to this key below.
  } else if (bearer) {
    const rows = await sb(`users?token=eq.${encodeURIComponent(bearer[1])}&select=email,is_admin`).catch(() => []);
    if (!rows.length) return res.status(401).json({ error: 'Session expired – log in again' });
    user = rows[0].email;
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    isAdmin = !!rows[0].is_admin || (!!adminEmail && user.toLowerCase() === adminEmail);

    // Paywall: only accounts with an active licence (or admins) may use the CRM.
    if (!isAdmin) {
      const nowIso = new Date().toISOString();
      const lic = await sb(
        `purchases?user_email=eq.${encodeURIComponent(user)}&status=in.(paid,active)` +
        `&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso)})&select=id&limit=1`
      ).catch(() => []);
      if (!lic.length) return res.status(402).json({ error: 'Purchase required — buy a plan to use JobBot' });
    }
  } else if (!process.env.CRM_API_KEY || (req.headers['x-api-key'] || '') !== process.env.CRM_API_KEY) {
    return res.status(401).json({ error: 'Log in required' });
  }
  const own = licenseKey ? `&license_key=eq.${encodeURIComponent(licenseKey)}`
            : user ? `&user_email=eq.${encodeURIComponent(user)}` : '';

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
        body: JSON.stringify([{ platform, title, company, url, status, fit_score, notes, user_email: user, license_key: licenseKey }]),
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
