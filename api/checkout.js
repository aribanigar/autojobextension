// /api/checkout – create a Razorpay order/subscription, then verify payment.
//   POST { plan_id }                  → { key_id, order_id|subscription_id, amount, purchase_id, interval }
//   POST ?verify=1 { purchase_id, razorpay_payment_id, razorpay_order_id|razorpay_subscription_id, razorpay_signature }
//                                      → { ok:true }  (activates the licence)
// Login required (Authorization: Bearer <token>).
import {
  cors, sb, backendConfigured, getUserByToken,
  rzp, razorpayConfigured, verifyHmac,
  validateCoupon, applyReferral,
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
      const patch = {
        razorpay_payment_id,
        starts_at: now.toISOString(),
        status: purchase.interval === 'monthly' ? 'active' : 'paid',
        expires_at: purchase.interval === 'monthly'
          ? new Date(now.getTime() + 31 * 864e5).toISOString() // +31 days; webhook renews
          : null,                                              // lifetime
      };
      await sb(`purchases?id=eq.${encodeURIComponent(purchase_id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await applyReferral(purchase_id); // bump code use + reward referrer (idempotent)
      return res.status(200).json({ ok: true });
    }

    // ── Step 1: create the order/subscription for the chosen plan ────────────
    const { plan_id, code } = req.body || {};
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const planRows = await sb(`plans?id=eq.${encodeURIComponent(plan_id)}&active=eq.true&select=*`);
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ error: 'Plan not found or inactive' });

    // Referral / discount code. Discount applies to one-time plans; for monthly
    // subscriptions the code still records the referrer (rewarded on payment)
    // but does not change the recurring amount.
    let coupon = null, discount_paise = 0, amount = plan.price_paise;
    if (code) {
      const v = await validateCoupon(code, plan.price_paise, user.email); // throws if invalid
      if (v) {
        coupon = v.coupon;
        if (plan.interval !== 'monthly') { discount_paise = v.discount_paise; amount = v.final_paise; }
      }
    }
    const referrer_email = coupon?.owner_email || null;
    const couponCode = coupon?.code || null;

    // Free after discount (one-time only): grant access without Razorpay.
    if (plan.interval !== 'monthly' && amount <= 0) {
      const rows = await sb('purchases', {
        method: 'POST',
        body: JSON.stringify([{
          user_email: user.email, plan_id: plan.id, interval: 'once',
          amount_paise: 0, discount_paise, coupon_code: couponCode, referrer_email,
          status: 'paid', starts_at: new Date().toISOString(), expires_at: null,
        }]),
      });
      await applyReferral(rows[0].id);
      return res.status(200).json({ free: true });
    }

    let order_id = null, subscription_id = null;
    if (plan.interval === 'monthly') {
      if (!plan.razorpay_plan_id) return res.status(400).json({ error: 'This plan has no Razorpay plan id' });
      const sub = await rzp('subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: plan.razorpay_plan_id, total_count: 120, customer_notify: 1,
          notes: { email: user.email },
        }),
      });
      subscription_id = sub.id;
    } else {
      const order = await rzp('orders', {
        method: 'POST',
        body: JSON.stringify({
          amount, currency: 'INR',
          receipt: `jb_${Date.now()}`, notes: { email: user.email, plan: plan.name },
        }),
      });
      order_id = order.id;
    }

    const purchaseRows = await sb('purchases', {
      method: 'POST',
      body: JSON.stringify([{
        user_email: user.email, plan_id: plan.id, interval: plan.interval,
        amount_paise: amount, discount_paise, coupon_code: couponCode, referrer_email,
        status: 'created',
        razorpay_order_id: order_id, razorpay_subscription_id: subscription_id,
      }]),
    });

    return res.status(200).json({
      key_id: process.env.RAZORPAY_KEY_ID,
      purchase_id: purchaseRows[0].id,
      order_id, subscription_id,
      amount, discount_paise, list_price: plan.price_paise,
      interval: plan.interval, name: plan.name, email: user.email,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
