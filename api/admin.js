// /api/admin – AutoApplier admin operations
// POST { action: 'login', email, password }           → { token, role, email }
// POST { action: 'create_user', email, password }     → { ok, email }   (needs admin token)
// POST { action: 'list_users' }                       → [{ email, created_at }]
// POST { action: 'delete_user', email }               → { ok }
//
// Admin token is a deterministic SHA-256 of the fixed credentials — no
// extra env vars needed. ADMIN_EMAIL/ADMIN_PASSWORD can override defaults.

import { createHash, scryptSync, randomBytes } from 'crypto';

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'arfatshah.qa@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Autoapplier@54321';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const adminToken = () =>
  createHash('sha256')
    .update(`autoapplier-admin:${ADMIN_EMAIL}:${ADMIN_PASSWORD}`)
    .digest('hex');

const verifyAdmin = req => {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  return m && m[1] === adminToken();
};

async function sb(path, init = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey:        process.env.SUPABASE_SERVICE_KEY,
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

const hashPassword = (pw, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, email: rawEmail, password } = req.body || {};

  // ── Admin login (no Supabase required) ──────────────────────────────────
  if (action === 'login') {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    return res.status(200).json({ token: adminToken(), role: 'admin', email: ADMIN_EMAIL });
  }

  // ── All other actions require a valid admin token + Supabase ─────────────
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Admin auth required' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }

  try {
    if (action === 'create_user') {
      const email = String(rawEmail || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Valid email required' });
      if (!password || String(password).length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const existing = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id`);
      if (existing.length) return res.status(409).json({ error: 'Email already registered' });
      const token = randomBytes(32).toString('hex');
      await sb('users', {
        method: 'POST',
        body: JSON.stringify([{ email, password_hash: hashPassword(String(password)), token }]),
      });
      return res.status(201).json({ ok: true, email });
    }

    if (action === 'list_users') {
      const users = await sb('users?select=email,created_at&order=created_at.desc&limit=500');
      return res.status(200).json(users);
    }

    if (action === 'delete_user') {
      const email = String(rawEmail || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email required' });
      await sb(`users?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
