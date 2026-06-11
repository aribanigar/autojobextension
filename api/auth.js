// /api/auth – email/password accounts for the JobBot CRM
// POST { action: 'signup' | 'login', email, password }
//   → { token, email }   (token is sent as  Authorization: Bearer <token>)
// Passwords are stored as scrypt hashes (salt:hash) in the Supabase `users`
// table – see schema.sql. Sessions are a random bearer token per user.

import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

const hashPassword = (password, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }

  const { action, email: rawEmail, password } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || String(password).length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const existing = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id,email,password_hash`);
    const token = randomBytes(32).toString('hex');

    if (action === 'signup') {
      if (existing.length) return res.status(409).json({ error: 'An account with this email already exists – log in instead' });
      await sb('users', {
        method: 'POST',
        body: JSON.stringify([{ email, password_hash: hashPassword(String(password)), token }]),
      });
      return res.status(201).json({ token, email });
    }

    if (action === 'login') {
      if (!existing.length || !verifyPassword(String(password), existing[0].password_hash)) {
        return res.status(401).json({ error: 'Wrong email or password' });
      }
      await sb(`users?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify({ token }) });
      return res.status(200).json({ token, email });
    }

    return res.status(400).json({ error: "action must be 'signup' or 'login'" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
