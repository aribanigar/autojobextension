// /api/admin – AutoApplier admin console (combined).
// Auth: POST { action:'login', email, password } → { token, role:'admin' }.
//   The admin token is a deterministic SHA-256 of the fixed credentials
//   (ADMIN_EMAIL / ADMIN_PASSWORD env, with defaults). All other actions
//   require  Authorization: Bearer <that token>.
//
// User management (invite/provision):
//   create_user { email, password }        → make an account
//   list_users                             → accounts + whether each is licensed
//   delete_user { email }                  → remove an account
//
// Licence control (works alongside self-service Razorpay checkout):
//   grant   { email, days? }               → give access (days null = lifetime)
//   revoke  { email }                      → cancel a user's active licences
//   list_purchases                         → all purchase rows
//
// Plan management (what the checkout page sells):
//   create_plan { name, price_paise, interval, description?, features?, active? }
//   list_plans                             → every plan
//   update_plan { id, ...fields }          → edit a plan
//   delete_plan { id }                     → remove a plan
import { createHash, scryptSync, randomBytes } from 'crypto';
import { sb, backendConfigured, rzp, razorpayConfigured, issueKeyForEmail } from './_lib.js';

// .trim() guards against a trailing space/newline accidentally saved in the
// Vercel env value — the most common cause of "my correct password won't work".
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL    || 'arfatshah.qa@gmail.com').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Autoapplier@54321').trim();

// Normalize an admin-supplied per-region price map and, for monthly plans,
// ensure each region has a Razorpay subscription plan in its currency. Reuses an
// existing Razorpay plan id when the region's amount+currency is unchanged (a
// Razorpay plan's amount is immutable, so a changed price needs a fresh plan).
// Throws a descriptive error if Razorpay rejects a currency. Shared by
// create_plan and update_plan so editing behaves exactly like creating.
async function normalizeRegionPrices({ name, description, interval, prices, oldPrices = {} }) {
  const DEFCUR = { IN: 'INR', AE: 'AED', US: 'USD', GB: 'GBP', DEFAULT: 'USD' };
  const norm = {};
  for (const [region, e] of Object.entries(prices || {})) {
    if (!e || !Number.isFinite(+e.amount) || +e.amount < 0) continue;
    const currency = ['INR', 'AED', 'USD', 'GBP'].includes(e.currency) ? e.currency : (DEFCUR[region] || 'USD');
    const amount = Math.round(+e.amount);
    let razorpay_plan_id = e.razorpay_plan_id || null;
    if (interval === 'monthly' && !razorpay_plan_id) {
      const old = oldPrices[region];
      if (old && old.currency === currency && Math.round(+old.amount) === amount && old.razorpay_plan_id) {
        razorpay_plan_id = old.razorpay_plan_id; // unchanged → reuse existing Razorpay plan
      } else {
        if (!razorpayConfigured()) throw new Error('Razorpay keys not set — cannot create a recurring plan');
        try {
          const rp = await rzp('plans', {
            method: 'POST',
            body: JSON.stringify({ period: 'monthly', interval: 1, item: { name: `${name} — ${region}`, amount, currency, description: description || name } }),
          });
          razorpay_plan_id = rp.id;
        } catch (err) {
          throw new Error(`Razorpay could not create a ${currency} plan for ${region}: ${String(err.message || err)}. Enable international payments on Razorpay, or paste a razorpay_plan_id for ${region} manually.`);
        }
      }
    }
    norm[region] = { currency, amount, razorpay_plan_id };
  }
  return norm;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const adminToken = () =>
  createHash('sha256').update(`autoapplier-admin:${ADMIN_EMAIL}:${ADMIN_PASSWORD}`).digest('hex');

const verifyAdmin = req => {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  return m && m[1] === adminToken();
};

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
  if (!backendConfigured()) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }

  const email = String(rawEmail || '').trim().toLowerCase();

  try {
    // ── Users ──────────────────────────────────────────────────────────────
    if (action === 'create_user') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
      if (!password || String(password).length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const existing = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id`);
      if (existing.length) return res.status(409).json({ error: 'Email already registered' });
      const token = randomBytes(32).toString('hex');
      await sb('users', { method: 'POST', body: JSON.stringify([{ email, password_hash: hashPassword(String(password)), token }]) });
      return res.status(201).json({ ok: true, email });
    }

    if (action === 'list_users') {
      // Include the lead-capture fields (name, phone) so the console can show who
      // to contact. Falls back gracefully on a pre-migration DB without them.
      let users;
      try {
        users = await sb('users?select=email,name,phone,created_at,is_admin&order=created_at.desc&limit=1000');
      } catch {
        users = await sb('users?select=email,created_at,is_admin&order=created_at.desc&limit=1000');
      }
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

    if (action === 'delete_user') {
      if (!email) return res.status(400).json({ error: 'email required' });
      await sb(`users?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset_password') {
      if (!email) return res.status(400).json({ error: 'email required' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const rows = await sb(`users?email=eq.${encodeURIComponent(email)}&select=id`);
      if (!rows.length) return res.status(404).json({ error: 'No account with that email' });
      // New password + clear the session so the user must log in again.
      await sb(`users?id=eq.${rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ password_hash: hashPassword(String(password)), token: null }) });
      return res.status(200).json({ ok: true });
    }

    // ── Licence control ────────────────────────────────────────────────────
    if (action === 'grant') {
      if (!email) return res.status(400).json({ error: 'email required' });
      const now = new Date();
      const { days } = req.body || {};
      const expires_at = days ? new Date(now.getTime() + Number(days) * 864e5).toISOString() : null;
      const rows = await sb('purchases', {
        method: 'POST',
        body: JSON.stringify([{
          user_email: email, interval: days ? 'monthly' : 'once',
          amount_paise: 0, status: days ? 'active' : 'paid',
          starts_at: now.toISOString(), expires_at,
        }]),
      });
      return res.status(201).json(rows[0]);
    }

    if (action === 'revoke') {
      if (!email) return res.status(400).json({ error: 'email required' });
      await sb(`purchases?user_email=eq.${encodeURIComponent(email)}&status=in.(paid,active)`, {
        method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }),
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'list_purchases') {
      return res.status(200).json(await sb('purchases?order=created_at.desc&limit=500'));
    }

    // ── Demo requests ──────────────────────────────────────────────────────
    if (action === 'list_demos') {
      try {
        return res.status(200).json(await sb('demo_requests?order=created_at.desc&limit=1000'));
      } catch {
        return res.status(200).json({ schema_missing: true }); // table not created yet
      }
    }
    if (action === 'delete_demo') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`demo_requests?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ── Plan management ────────────────────────────────────────────────────
    if (action === 'list_plans') {
      return res.status(200).json(await sb('plans?order=created_at.desc'));
    }

    if (action === 'create_plan') {
      const { name, description = '', price_paise, interval = 'once', duration_days = null, features = {}, active = true, prices = null } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (!['once', 'monthly'].includes(interval)) return res.status(400).json({ error: "interval must be 'once' or 'monthly'" });
      const dur = duration_days ? Number(duration_days) : null; // one-time validity; null = lifetime

      // ── Geo-priced plan: a per-region { IN, AE, US, GB, DEFAULT } price map ──
      if (prices && typeof prices === 'object' && Object.keys(prices).length) {
        let norm;
        try { norm = await normalizeRegionPrices({ name, description, interval, prices }); }
        catch (err) { return res.status(400).json({ error: String(err.message || err) }); }
        if (!Object.keys(norm).length) return res.status(400).json({ error: 'Provide at least one region price' });
        // Legacy back-compat fields so any INR-only path keeps working: prefer IN,
        // else DEFAULT, else the first configured region.
        const legacy = norm.IN || norm.DEFAULT || Object.values(norm)[0];
        const rows = await sb('plans', {
          method: 'POST',
          body: JSON.stringify([{
            name, description, price_paise: legacy.amount, interval, duration_days: dur,
            razorpay_plan_id: norm.IN?.razorpay_plan_id || null, features, active, prices: norm,
          }]),
        });
        return res.status(201).json(rows[0]);
      }

      // ── Legacy single-price (INR) plan — unchanged behaviour ────────────────
      if (!Number.isInteger(price_paise) || price_paise < 0) {
        return res.status(400).json({ error: 'name and a non-negative integer price_paise are required' });
      }
      let razorpay_plan_id = null;
      if (interval === 'monthly') {
        if (!razorpayConfigured()) return res.status(400).json({ error: 'Razorpay keys not set — cannot create a recurring plan' });
        const rp = await rzp('plans', {
          method: 'POST',
          body: JSON.stringify({ period: 'monthly', interval: 1, item: { name, amount: price_paise, currency: 'INR', description: description || name } }),
        });
        razorpay_plan_id = rp.id;
      }
      const rows = await sb('plans', { method: 'POST', body: JSON.stringify([{ name, description, price_paise, interval, duration_days: dur, razorpay_plan_id, features, active }]) });
      return res.status(201).json(rows[0]);
    }

    if (action === 'update_plan') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const allowed = {};
      for (const k of ['name', 'description', 'price_paise', 'duration_days', 'features', 'active']) if (k in fields) allowed[k] = fields[k];

      // Editing regional prices → normalize + (for monthly) create/reuse the
      // Razorpay plan per currency, then keep the legacy INR fields in sync.
      if ('prices' in fields && fields.prices && typeof fields.prices === 'object') {
        const cur = (await sb(`plans?id=eq.${encodeURIComponent(id)}&select=interval,name,description,prices`).catch(() => []))[0] || {};
        let norm;
        try {
          norm = await normalizeRegionPrices({
            name: fields.name || cur.name || 'Plan',
            description: fields.description ?? cur.description ?? '',
            interval: cur.interval || 'once',
            prices: fields.prices,
            oldPrices: (cur.prices && typeof cur.prices === 'object') ? cur.prices : {},
          });
        } catch (err) { return res.status(400).json({ error: String(err.message || err) }); }
        if (!Object.keys(norm).length) return res.status(400).json({ error: 'Provide at least one region price' });
        allowed.prices = norm;
        const legacy = norm.IN || norm.DEFAULT || Object.values(norm)[0];
        if (legacy) allowed.price_paise = legacy.amount;
        allowed.razorpay_plan_id = norm.IN?.razorpay_plan_id || null;
      }

      const rows = await sb(`plans?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(allowed) });
      return res.status(200).json(rows[0] || null);
    }

    if (action === 'delete_plan') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`plans?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ── Referral / discount codes ──────────────────────────────────────────
    if (action === 'create_coupon') {
      const { code, owner_email = null, discount_type = 'percent', discount_value, reward_days = 0, max_uses = null, active = true } = req.body || {};
      const c = String(code || '').trim().toUpperCase();
      if (!c) return res.status(400).json({ error: 'code required' });
      if (!['percent', 'flat'].includes(discount_type)) return res.status(400).json({ error: "discount_type must be 'percent' or 'flat'" });
      if (!Number.isInteger(discount_value) || discount_value < 0) return res.status(400).json({ error: 'discount_value must be a non-negative integer (percent, or paise for flat)' });
      const exists = await sb(`coupons?code=eq.${encodeURIComponent(c)}&select=id`);
      if (exists.length) return res.status(409).json({ error: 'A code with that name already exists' });
      const rows = await sb('coupons', {
        method: 'POST',
        body: JSON.stringify([{
          code: c, owner_email: owner_email ? String(owner_email).trim().toLowerCase() : null,
          discount_type, discount_value, reward_days: Number(reward_days) || 0,
          max_uses: max_uses ? Number(max_uses) : null, active: !!active,
        }]),
      });
      return res.status(201).json(rows[0]);
    }

    if (action === 'list_coupons') {
      return res.status(200).json(await sb('coupons?order=created_at.desc&limit=500'));
    }

    if (action === 'update_coupon') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const allowed = {};
      for (const k of ['discount_type', 'discount_value', 'reward_days', 'max_uses', 'active', 'owner_email']) if (k in fields) allowed[k] = fields[k];
      const rows = await sb(`coupons?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(allowed) });
      return res.status(200).json(rows[0] || null);
    }

    if (action === 'delete_coupon') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`coupons?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ── License keys ───────────────────────────────────────────────────────
    // Issue a key FOR AN EMAIL (free lifetime or limited access). Optionally
    // create/set the account password so the admin can hand over ready-to-use
    // credentials; the user can change the password later.
    if (action === 'issue_key') {
      const { email: kEmail, validity_days = 30, lifetime = false, password, label = '' } = req.body || {};
      const em = String(kEmail || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Valid email required' });

      // Ensure the account exists (create with the admin-set password if given).
      const existing = await sb(`users?email=eq.${encodeURIComponent(em)}&select=id`);
      if (!existing.length) {
        if (password && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        const pw = password || randomBytes(6).toString('hex'); // random if admin didn't set one
        await sb('users', { method: 'POST', body: JSON.stringify([{ email: em, password_hash: hashPassword(String(pw)), token: randomBytes(32).toString('hex') }]) });
      } else if (password) {
        if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        await sb(`users?id=eq.${existing[0].id}`, { method: 'PATCH', body: JSON.stringify({ password_hash: hashPassword(String(password)) }) });
      }

      const key = await issueKeyForEmail(em, {
        validity_days: lifetime ? 0 : Math.max(1, Number(validity_days) || 30),
        lifetime: !!lifetime, label: label || 'admin grant',
      });
      return res.status(201).json({ key: key.key, email: em, lifetime: !!lifetime, expires_at: key.expires_at });
    }

    if (action === 'create_keys') {
      const { validity_days = 30, label = '', count = 1 } = req.body || {};
      const days = Math.max(1, Number(validity_days) || 30);
      const n = Math.min(50, Math.max(1, Number(count) || 1));
      const group = () => randomBytes(2).toString('hex').toUpperCase();
      const rowsToInsert = [];
      for (let i = 0; i < n; i++) {
        rowsToInsert.push({ key: `AA-${group()}-${group()}-${group()}`, validity_days: days, label: label || null, status: 'active' });
      }
      const created = await sb('license_keys', { method: 'POST', body: JSON.stringify(rowsToInsert) });
      return res.status(201).json(created);
    }

    if (action === 'list_keys') {
      return res.status(200).json(await sb('license_keys?order=created_at.desc&limit=500'));
    }

    if (action === 'revoke_key') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`license_keys?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) });
      return res.status(200).json({ ok: true });
    }

    if (action === 'enable_key') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`license_keys?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_key') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`license_keys?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // Reset / unlock a key's device binding. Clears the bound device + switch
    // history so the customer can re-activate on their current machine, and
    // lifts an auto-lock (status 'locked' → 'active'; a 'revoked' key stays
    // revoked). This is the "my key got locked, please unlock it" support action.
    if (action === 'reset_device') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sb(`license_keys?id=eq.${encodeURIComponent(id)}&select=status`).catch(() => []);
      const patch = { device_id: null, device_bound_at: null, device_seen_at: null, device_history: [] };
      if (rows[0]?.status === 'locked') patch.status = 'active';
      await sb(`license_keys?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    // ── Telemetry (field-health) ─────────────────────────────────────────────
    // Recent anonymous beacons from the extension so the admin can spot a job
    // site changing its DOM or an integration breaking. Returns [] gracefully if
    // the telemetry table hasn't been created yet.
    if (action === 'list_telemetry') {
      const rows = await sb('telemetry?order=created_at.desc&limit=300').catch(() => []);
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
