// api/_lib.js – shared helpers for the JobBot backend.
// Underscore prefix keeps Vercel from routing this as an HTTP endpoint.

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

// A fresh license-key string: AA-XXXX-XXXX-XXXX.
export function newKeyString() {
  const g = () => randomBytes(2).toString('hex').toUpperCase();
  return `AA-${g()}-${g()}-${g()}`;
}

// Issue a PRE-ACTIVATED key for an email (used by purchases and admin grants).
// The validity clock starts now. lifetime → never expires.
export async function issueKeyForEmail(email, { validity_days = 30, lifetime = false, label = null, purchase_id = null } = {}) {
  const now = new Date();
  const expires_at = lifetime ? null : new Date(now.getTime() + (validity_days || 30) * 864e5).toISOString();
  const rows = await sb('license_keys', {
    method: 'POST',
    body: JSON.stringify([{
      key: newKeyString(), email: email ? String(email).trim().toLowerCase() : null,
      validity_days: lifetime ? 0 : (validity_days || 30), lifetime, label,
      status: 'active', activated_at: now.toISOString(), expires_at, purchase_id,
    }]),
  });
  return rows[0];
}

// Ensure a purchase has a linked license key whose expiry matches the purchase.
// Idempotent per purchase: creates the key once, then keeps its expiry in sync.
//
// A single payment fans out to several near-simultaneous callers — the client
// /checkout?verify=1 plus the subscription.activated AND subscription.charged
// webhooks — which would otherwise each create a key (the buyer ends up with
// two or three). Guards, in order:
//   1) purchase already linked        → renewal: extend that key.
//   2) a key already exists for this purchase_id (another caller beat us) →
//      adopt it instead of making another. The key row itself carries
//      purchase_id, so this holds even before purchases.license_key is written.
//   3) otherwise create one, then self-heal: if a concurrent caller also just
//      created one, keep the earliest (deterministic) and delete OUR extra.
// We only ever delete a key we just created this call and never returned to any
// client, so no activated key or CRM data is ever affected.
export async function syncPurchaseKey(purchase) {
  if (!purchase || !purchase.user_email) return null;
  const lifetime = !purchase.expires_at; // null expiry = lifetime
  const pid = purchase.id ? encodeURIComponent(purchase.id) : null;
  const syncExpiry = key => sb(`license_keys?key=eq.${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: JSON.stringify({ expires_at: purchase.expires_at || null, lifetime, status: 'active' }),
  }).catch(() => {});
  const linkPurchase = key => pid && sb(`purchases?id=eq.${pid}`, {
    method: 'PATCH', body: JSON.stringify({ license_key: key }),
  }).catch(() => {});

  // 1) Already linked → renewal.
  if (purchase.license_key) {
    await syncExpiry(purchase.license_key);
    return purchase.license_key;
  }

  // 2) Adopt a key another caller already created for this purchase.
  if (pid) {
    const existing = await sb(`license_keys?purchase_id=eq.${pid}&order=created_at.asc,key.asc&select=key`).catch(() => []);
    if (Array.isArray(existing) && existing.length) {
      await syncExpiry(existing[0].key);
      await linkPurchase(existing[0].key);
      return existing[0].key;
    }
  }

  // 3) Create the key.
  const now = new Date();
  const rows = await sb('license_keys', {
    method: 'POST',
    body: JSON.stringify([{
      key: newKeyString(), email: String(purchase.user_email).toLowerCase(),
      validity_days: purchase.duration_days || 0, lifetime,
      label: 'purchase', status: 'active',
      activated_at: now.toISOString(), expires_at: purchase.expires_at || null,
      purchase_id: purchase.id,
    }]),
  });
  let myKey = rows[0].key;

  // Self-heal the concurrent-create race: if an earlier key now exists for this
  // purchase, drop the one we just made and use the earliest (deterministic
  // winner, same for every caller). Deleting our own brand-new, never-returned
  // key is safe.
  if (pid) {
    const all = await sb(`license_keys?purchase_id=eq.${pid}&order=created_at.asc,key.asc&select=key`).catch(() => []);
    if (Array.isArray(all) && all.length > 1 && all[0].key !== myKey) {
      await sb(`license_keys?key=eq.${encodeURIComponent(myKey)}`, { method: 'DELETE' }).catch(() => {});
      myKey = all[0].key;
    }
    await linkPurchase(myKey);
  }
  return myKey;
}

// ── Geo pricing ──────────────────────────────────────────────────────────────
// Prices are stored per REGION on plans.prices (JSONB). A visitor only ever sees
// the price for THEIR region — resolved server-side from Vercel's edge country
// header — so prices in other regions stay private (never sent to the browser).
// Regions: IN (India, ₹), AE (Middle East, AED), US (USA, $), GB (UK, £), plus a
// DEFAULT for the rest of the world. Amounts are in the currency's smallest unit
// (paise/fils/cents = major × 100), matching Razorpay.
export const CURRENCY_SYMBOL = { INR: '₹', AED: 'AED', USD: '$', GBP: '£' };
export const PRICE_REGIONS = ['IN', 'AE', 'US', 'GB', 'DEFAULT'];
const MIDDLE_EAST = new Set(['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'EG', 'IQ', 'YE', 'PS', 'SY']);

export function regionForCountry(cc) {
  cc = String(cc || '').toUpperCase();
  if (cc === 'IN') return 'IN';
  if (cc === 'US') return 'US';
  if (cc === 'GB' || cc === 'UK') return 'GB';
  if (MIDDLE_EAST.has(cc)) return 'AE';
  return 'DEFAULT';
}

// Trust ONLY Vercel's edge-set country in production (the client can't spoof it
// there — Vercel overwrites any inbound value). Fall back to ?cc= only when that
// header is absent (local/preview), which also means a visitor can never probe
// another region's price in production.
export function countryFromReq(req) {
  const vercel = req.headers && req.headers['x-vercel-ip-country'];
  if (vercel) return String(vercel).toUpperCase();
  const q = req.query && (req.query.cc || req.query.country);
  return String(q || '').toUpperCase();
}

// The single price a region should see for a plan. Resolution: the region's own
// entry → DEFAULT (rest of world) → legacy price_paise/INR. Never another
// specific region, so an IN visitor can't be shown the US/AE/GB price and vice
// versa. Plans with no prices map behave exactly as before (everyone sees INR).
export function priceForPlan(plan, region) {
  const prices = (plan && plan.prices && typeof plan.prices === 'object') ? plan.prices : {};
  const entry = (prices[region] && Number.isFinite(+prices[region].amount)) ? prices[region]
    : (prices.DEFAULT && Number.isFinite(+prices.DEFAULT.amount)) ? prices.DEFAULT : null;
  if (entry) {
    const currency = CURRENCY_SYMBOL[entry.currency] ? entry.currency : 'INR';
    return {
      region: prices[region] === entry ? region : 'DEFAULT',
      currency, symbol: CURRENCY_SYMBOL[currency],
      amount: Math.max(0, Math.round(+entry.amount)),
      razorpay_plan_id: entry.razorpay_plan_id || null,
    };
  }
  // Legacy single-currency plan (no regional prices configured).
  return { region: 'IN', currency: 'INR', symbol: '₹', amount: plan.price_paise || 0, razorpay_plan_id: plan.razorpay_plan_id || null };
}

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

// ── Referrals / discount codes ───────────────────────────────────────────────
// Validate a code against a plan price. Returns { coupon, discount_paise, final_paise }
// or throws an Error with a user-facing message. buyerEmail can't use their own code.
export async function validateCoupon(code, priceP, buyerEmail) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const rows = await sb(`coupons?code=eq.${encodeURIComponent(c)}&select=*`);
  const coupon = rows[0];
  if (!coupon || !coupon.active) throw new Error('That code is invalid or no longer active');
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) throw new Error('That code has been fully redeemed');
  if (coupon.owner_email && buyerEmail && coupon.owner_email.toLowerCase() === String(buyerEmail).toLowerCase()) {
    throw new Error("You can't use your own referral code");
  }
  let discount = coupon.discount_type === 'flat'
    ? Math.min(coupon.discount_value, priceP)
    : Math.round(priceP * coupon.discount_value / 100);
  discount = Math.max(0, Math.min(discount, priceP));
  return { coupon, discount_paise: discount, final_paise: priceP - discount };
}

// Add `days` of access to a referrer, stacking on top of any current expiry.
// Skips if they already have lifetime access.
export async function creditReferrerDays(email, days) {
  if (!email || !days) return;
  const nowIso = new Date().toISOString();
  const active = await sb(
    `purchases?user_email=eq.${encodeURIComponent(email)}&status=in.(paid,active)` +
    `&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso)})&select=expires_at`
  ).catch(() => []);
  if (active.some(p => p.expires_at == null)) return; // already lifetime
  let base = Date.now();
  for (const p of active) { const t = new Date(p.expires_at).getTime(); if (t > base) base = t; }
  const expires = new Date(base + days * 864e5).toISOString();
  await sb('purchases', {
    method: 'POST',
    body: JSON.stringify([{
      user_email: email, interval: 'referral', amount_paise: 0,
      status: 'active', starts_at: new Date().toISOString(), expires_at: expires, rewarded: true,
    }]),
  });
}

// Idempotently finalise a purchase's referral: bump the code's used_count and
// credit the referrer once. Safe to call from both verify and webhook.
export async function applyReferral(purchaseId) {
  const rows = await sb(`purchases?id=eq.${encodeURIComponent(purchaseId)}&select=*`).catch(() => []);
  const p = rows[0];
  if (!p || p.rewarded || !p.coupon_code) return;
  const cs = await sb(`coupons?code=eq.${encodeURIComponent(p.coupon_code)}&select=*`).catch(() => []);
  const coupon = cs[0];
  if (coupon) {
    await sb(`coupons?id=eq.${coupon.id}`, { method: 'PATCH', body: JSON.stringify({ used_count: (coupon.used_count || 0) + 1 }) }).catch(() => {});
    if (p.referrer_email && coupon.reward_days > 0) {
      await creditReferrerDays(p.referrer_email, coupon.reward_days).catch(() => {});
    }
  }
  await sb(`purchases?id=eq.${encodeURIComponent(purchaseId)}`, { method: 'PATCH', body: JSON.stringify({ rewarded: true }) }).catch(() => {});
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
