// api/_lib.js – shared helpers for the JobBot backend.
// Underscore prefix keeps Vercel from routing this as an HTTP endpoint.

import { createHmac, timingSafeEqual } from 'crypto';

export function cors(res, methods = 'GET,POST,PATCH,DELETE,OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
}

export function backendConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Supabase REST helper (service_role key – bypasses RLS).
export async function sb(path, init = {}) {
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

export function isAdminEmail(email) {
  const admin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!admin && String(email || '').trim().toLowerCase() === admin;
}

// Resolve the caller from an Authorization: Bearer <token> header.
// Because auth.js overwrites users.token on every login, only the MOST RECENT
// login's token matches here — that is exactly what enforces one active session
// (an older session's token stops working the moment you log in elsewhere).
export async function getUserByToken(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const rows = await sb(
    `users?token=eq.${encodeURIComponent(m[1])}&select=id,email,is_admin`
  ).catch(() => []);
  if (!rows.length) return null;
  const u = rows[0];
  return { id: u.id, email: u.email, is_admin: !!u.is_admin || isAdminEmail(u.email) };
}

// The user's current active licence, or null. A licence is valid when a
// purchase is paid/active and not past its expiry (lifetime = null expiry).
export async function activeLicense(email) {
  if (!email) return null;
  const nowIso = new Date().toISOString();
  const rows = await sb(
    `purchases?user_email=eq.${encodeURIComponent(email)}` +
    `&status=in.(paid,active)` +
    `&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso)})` +
    `&order=created_at.desc&limit=1`
  ).catch(() => []);
  return rows.length ? rows[0] : null;
}

// ── Razorpay ────────────────────────────────────────────────────────────────
export function razorpayConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function rzp(path, init = {}) {
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString('base64');
  const r = await fetch(`https://api.razorpay.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error?.description || `Razorpay ${r.status}: ${text}`);
  return data;
}

// Constant-time HMAC-SHA256 signature check (payment / webhook verification).
export function verifyHmac(payload, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Read the raw request body (needed for webhook signature verification, where
// the exact bytes matter). Falls back to JSON.stringify if already parsed.
export function readRawBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'string') return resolve(req.body);
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data || (req.body ? JSON.stringify(req.body) : '')));
    req.on('error', () => resolve(''));
  });
}
