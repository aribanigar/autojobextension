// /api/referral – a logged-in user's own referral code + stats.
//   GET (Authorization: Bearer <token>) → { code, link, uses, reward_days, discount }
// Creates a code for the user on first call (derived from their email, unique).
import { cors, sb, backendConfigured, getUserByToken } from './_lib.js';

// Default terms for a user's auto-generated referral code. Admins can edit any
// code's terms later in the admin panel.
const DEFAULT_DISCOUNT_TYPE = 'percent';
const DEFAULT_DISCOUNT_VALUE = 20; // 20% off for the buyer
const DEFAULT_REWARD_DAYS = 15;    // 15 free days for the referrer per purchase

function makeCode(email) {
  const base = String(email).split('@')[0].replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6) || 'REF';
  // short deterministic-ish suffix from the email so it's stable per account
  let h = 0; for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${base}${(h % 1000).toString().padStart(3, '0')}`;
}

export default async function handler(req, res) {
  cors(res, 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const user = await getUserByToken(req);
  if (!user) return res.status(401).json({ error: 'Log in required' });

  try {
    let rows = await sb(`coupons?owner_email=eq.${encodeURIComponent(user.email)}&order=created_at.asc&limit=1&select=*`);
    let coupon = rows[0];
    if (!coupon) {
      let code = makeCode(user.email);
      // Ensure uniqueness (rare collision)
      if ((await sb(`coupons?code=eq.${encodeURIComponent(code)}&select=id`)).length) code += Math.floor(Math.random() * 90 + 10);
      const created = await sb('coupons', {
        method: 'POST',
        body: JSON.stringify([{
          code, owner_email: user.email,
          discount_type: DEFAULT_DISCOUNT_TYPE, discount_value: DEFAULT_DISCOUNT_VALUE,
          reward_days: DEFAULT_REWARD_DAYS, active: true,
        }]),
      });
      coupon = created[0];
    }

    const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    return res.status(200).json({
      code: coupon.code,
      link: `${base}/checkout.html?ref=${coupon.code}`,
      uses: coupon.used_count || 0,
      reward_days: coupon.reward_days,
      discount: coupon.discount_type === 'flat'
        ? `₹${(coupon.discount_value / 100).toLocaleString('en-IN')} off`
        : `${coupon.discount_value}% off`,
      active: coupon.active,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
