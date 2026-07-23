// /api/checkout – create a Razorpay order/subscription, then verify payment.
//   POST { plan_id }                  → { key_id, order_id|subscription_id, amount, purchase_id, interval }
//   POST ?verify=1 { purchase_id, razorpay_payment_id, razorpay_order_id|razorpay_subscription_id, razorpay_signature }
//                                      → { ok:true }  (activates the licence)
// Login required (Authorization: Bearer <token>).
import {
  cors, sb, backendConfigured, getUserByToken,
  rzp, razorpayConfigured, verifyHmac,
  validateCoupon, applyReferral, syncPurchaseKey,
  regionForCountry, countryFromReq, priceForPlan,
} from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });
  if (!razorpayConfigured()) return res.status(500).json({ error: 'Payments not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET' });

  const user = await getUserByToken(req);
  if (!user) return res.status(401).json({ error: 'Log in required' });

  try {
    // ── Step 2: verify a completed payment and activate the licence ──────────
    if (req.query.verify) {
      const { purchase_id, razorpay_payment_id, razorpay_order_id, razorpay_subscription_id, razorpay_signature } = req.body || {};
      if (!purchase_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification fields' });
      }
      const rows = await sb(`purchases?id=eq.${encodeURIComponent(purchase_id)}&user_email=eq.${encodeURIComponent(user.email)}&select=*`);
      const purchase = rows[0];
      if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

      // Razorpay signature: one-time = order_id|payment_id, subscription = payment_id|subscription_id
      const payload = razorpay_subscription_id
        ? `${razorpay_payment_id}|${razorpay_subscription_id}`
        : `${razorpay_order_id}|${razorpay_payment_id}`;
      if (!verifyHmac(payload, razorpay_signature, process.env.RAZORPAY_KEY_SECRET)) {
        return res.status(400).json({ error: 'Payment signature verification failed' });
      }

      const now = new Date();
      // One-time purchase: if the plan has a validity window (duration_days),
      // access expires after it; otherwise it's lifetime (null). Monthly:
      // ~31 days per cycle, extended by the subscription webhook.
      let expires_at;
      if (purchase.interval === 'monthly') {
        expires_at = new Date(now.getTime() + 31 * 864e5).toISOString();
      } else if (purchase.duration_days && purchase.duration_days > 0) {
        expires_at = new Date(now.getTime() + purchase.duration_days * 864e5).toISOString();
      } else {
        expires_at = null; // lifetime
      }
      const patch = {
        razorpay_payment_id,
        starts_at: now.toISOString(),
        status: purchase.interval === 'monthly' ? 'active' : 'paid',
        expires_at,
      };
      await sb(`purchases?id=eq.${encodeURIComponent(purchase_id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await applyReferral(purchase_id); // bump code use + reward referrer (idempotent)
      // Auto-generate the activation key for this purchase (validity = plan).
      const fresh = (await sb(`purchases?id=eq.${encodeURIComponent(purchase_id)}&select=*`).catch(() => []))[0];
      const key = fresh ? await syncPurchaseKey(fresh) : null;
      return res.status(200).json({ ok: true, key });
    }

    // ── Step 1: create the order/subscription for the chosen plan ────────────
    const { plan_id, code } = req.body || {};
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const planRows = await sb(`plans?id=eq.${encodeURIComponent(plan_id)}&active=eq.true&select=*`);
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ error: 'Plan not found or inactive' });

    // Geo price: charge in the visitor's own region currency (resolved from the
    // Vercel edge country). Falls back to the plan's legacy INR price when the
    // plan has no regional prices configured, so existing plans are unchanged.
    const region = regionForCountry(countryFromReq(req));
    const pr = priceForPlan(plan, region);
    const currency = pr.currency;

    // Referral / discount code. Discount applies to one-time plans; for monthly
    // subscriptions the code still records the referrer (rewarded on payment)
    // but does not change the recurring amount. Coupons are INR-denominated, so
    // the amount discount only applies when charging in INR; for other
    // currencies the referrer is still recorded but the price isn't altered.
    let coupon = null, discount_paise = 0, amount = pr.amount;
    if (code) {
      const v = await validateCoupon(code, pr.amount, user.email); // throws if invalid
      if (v) {
        coupon = v.coupon;
        if (plan.interval !== 'monthly' && currency === 'INR') { discount_paise = v.discount_paise; amount = v.final_paise; }
      }
    }
    const referrer_email = coupon?.owner_email || null;
    const couponCode = coupon?.code || null;

    // Free after discount (one-time only): grant access without Razorpay.
    if (plan.interval !== 'monthly' && amount <= 0) {
      const now = new Date();
      const freeExpiry = plan.duration_days && plan.duration_days > 0
        ? new Date(now.getTime() + plan.duration_days * 864e5).toISOString() : null;
      const rows = await sb('purchases', {
        method: 'POST',
        body: JSON.stringify([{
          user_email: user.email, plan_id: plan.id, interval: 'once', duration_days: plan.duration_days || null,
          amount_paise: 0, discount_paise, coupon_code: couponCode, referrer_email,
          status: 'paid', starts_at: now.toISOString(), expires_at: freeExpiry,
        }]),
      });
      await applyReferral(rows[0].id);
      const fresh = (await sb(`purchases?id=eq.${encodeURIComponent(rows[0].id)}&select=*`).catch(() => []))[0];
      const key = fresh ? await syncPurchaseKey(fresh) : null;
      return res.status(200).json({ free: true, key });
    }

    let order_id = null, subscription_id = null;
    if (plan.interval === 'monthly') {
      // Use the region's own Razorpay subscription plan (created in that
      // currency). Falls back to the legacy INR plan id for unconfigured regions.
      const rzpPlanId = pr.razorpay_plan_id || plan.razorpay_plan_id;
      if (!rzpPlanId) return res.status(400).json({ error: 'This plan is not available in your region yet.' });
      const sub = await rzp('subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: rzpPlanId, total_count: 120, customer_notify: 1,
          notes: { email: user.email, region },
        }),
      });
      subscription_id = sub.id;
    } else {
      const order = await rzp('orders', {
        method: 'POST',
        body: JSON.stringify({
          amount, currency,
          receipt: `jb_${Date.now()}`, notes: { email: user.email, plan: plan.name, region },
        }),
      });
      order_id = order.id;
    }

    // currency/region are stored best-effort — wrapped so a pre-migration DB
    // without those columns still records the purchase.
    const basePurchase = {
      user_email: user.email, plan_id: plan.id, interval: plan.interval,
      duration_days: plan.duration_days || null,
      amount_paise: amount, discount_paise, coupon_code: couponCode, referrer_email,
      status: 'created',
      razorpay_order_id: order_id, razorpay_subscription_id: subscription_id,
    };
    let purchaseRows;
    try {
      purchaseRows = await sb('purchases', { method: 'POST', body: JSON.stringify([{ ...basePurchase, currency, region }]) });
    } catch {
      purchaseRows = await sb('purchases', { method: 'POST', body: JSON.stringify([basePurchase]) });
    }

    return res.status(200).json({
      key_id: process.env.RAZORPAY_KEY_ID,
      purchase_id: purchaseRows[0].id,
      order_id, subscription_id,
      amount, currency, symbol: pr.symbol, discount_paise, list_price: pr.amount,
      interval: plan.interval, name: plan.name, email: user.email,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
