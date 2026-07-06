// /api/auth – email/password accounts for AutoApplier.
// POST { action, ... }:
//   signup { email, password }                 → { token, email, is_admin }
//   login  { email, password }                 → { token, email, is_admin }
//   change { email, password, newPassword }    → { ok } (verify current, set new)
//   forgot { email }                           → { ok } (emails a reset link)
//   reset  { token, password }                 → { ok } (set new via reset token)
// Passwords are scrypt hashes (salt:hash) in the `users` table. Sessions are a
// random bearer token per user (one active session — login overwrites it).
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

// Send the password-reset email via Resend (https://resend.com). Requires
// RESEND_API_KEY; RESEND_FROM optional (defaults to Resend's test sender).
async function sendResetEmail(email, link) {
  if (!process.env.RESEND_API_KEY) return { ok: false, reason: 'no-email-provider' };
  const from = process.env.RESEND_FROM || 'AutoApplier <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: email, subject: 'Reset your AutoApplier password',
      html: `<div style="font-family:system-ui,sans-serif;max-width:440px;margin:auto">
        <h2>Reset your password</h2>
        <p>Click the button below to set a new password. This link expires in 1 hour.</p>
        <p><a href="${link}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600">Reset password</a></p>
        <p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>
        <p style="color:#888;font-size:12px">Or paste this link: ${link}</p>
      </div>`,
    }),
  });
  return { ok: r.ok };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }

  const { action, email: rawEmail, password, newPassword, token: resetToken } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  try {
    // ── Forgot: email a reset link (needs only an email) ────────────────────
    if (action === 'forgot') {
      if (!emailOk) return res.status(400).json({ error: 'Enter a valid email address' });
      const rows = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id`);
      // Always respond OK so we don't reveal whether an email is registered.
      if (rows.length) {
        const rt = randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + 3600 * 1000).toISOString(); // 1h
        await sb(`users?id=eq.${rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ reset_token: rt, reset_expires: expires }) });
        const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
        const sent = await sendResetEmail(email, `${base}/reset.html?token=${rt}`);
        if (!sent.ok && sent.reason === 'no-email-provider') {
          return res.status(200).json({ ok: true, emailed: false, note: 'Email provider not configured (set RESEND_API_KEY). Ask an admin to reset your password.' });
        }
      }
      return res.status(200).json({ ok: true, emailed: true });
    }

    // ── Reset: set a new password using the emailed token ───────────────────
    if (action === 'reset') {
      if (!resetToken) return res.status(400).json({ error: 'Missing reset token' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const rows = await sb(`users?reset_token=eq.${encodeURIComponent(resetToken)}&select=id,reset_expires`);
      if (!rows.length) return res.status(400).json({ error: 'Invalid or already-used reset link' });
      if (!rows[0].reset_expires || new Date(rows[0].reset_expires).getTime() < Date.now()) {
        return res.status(400).json({ error: 'This reset link has expired — request a new one' });
      }
      await sb(`users?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password_hash: hashPassword(String(password)), reset_token: null, reset_expires: null, token: null }),
      });
      return res.status(200).json({ ok: true });
    }

    // ── Change: logged-in user sets a new password (knows the current one) ──
    if (action === 'change') {
      if (!emailOk) return res.status(400).json({ error: 'Enter a valid email address' });
      if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      const rows = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id,password_hash`);
      if (!rows.length || !verifyPassword(String(password), rows[0].password_hash)) {
        return res.status(401).json({ error: 'Current password is wrong' });
      }
      await sb(`users?id=eq.${rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ password_hash: hashPassword(String(newPassword)) }) });
      return res.status(200).json({ ok: true });
    }

    // ── Signup / login (require a valid email + password) ───────────────────
    if (!emailOk) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id,email,password_hash,is_admin`);
    const token = randomBytes(32).toString('hex');
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const admin = row => !!(row?.is_admin) || (!!adminEmail && email === adminEmail);

    if (action === 'signup') {
      if (existing.length) return res.status(409).json({ error: 'An account with this email already exists – log in instead' });
      const created = await sb('users', {
        method: 'POST',
        body: JSON.stringify([{ email, password_hash: hashPassword(String(password)), token }]),
      });
      return res.status(201).json({ token, email, is_admin: admin(created?.[0]) });
    }

    if (action === 'login') {
      if (!existing.length || !verifyPassword(String(password), existing[0].password_hash)) {
        return res.status(401).json({ error: 'Wrong email or password' });
      }
      await sb(`users?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify({ token }) });
      return res.status(200).json({ token, email, is_admin: admin(existing[0]) });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
