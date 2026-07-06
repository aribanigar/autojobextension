// /api/razorpay-webhook – Razorpay server-to-server events (the reliable source
// of truth for granting/revoking access, especially for subscription renewals).
// Configure in Razorpay Dashboard → Settings → Webhooks with the same secret set
// in RAZORPAY_WEBHOOK_SECRET, subscribing to: order.paid, payment.captured,
// subscription.charged, subscription.activated, subscription.halted,
// subscription.cancelled, subscription.completed.
import { sb, backendConfigured, verifyHmac, readRawBody, applyReferral } from './_lib.js';

// Vercel must NOT pre-parse the body — signature is over the raw bytes.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!backendConfigured()) return res.status(500).json({ error: 'Backend not configured' });

  const raw = await readRawBody(req);
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !verifyHmac(raw, signature, secret)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const patchPurchase = (filter, fields) =>
    sb(`purchases?${filter}`, { method: 'PATCH', body: JSON.stringify(fields) }).catch(() => {});

  try {
    const type = event.event;
    const sub = event.payload?.subscription?.entity;
    const order = event.payload?.order?.entity;
    const payment = event.payload?.payment?.entity;
    const now = new Date();

    // One-time payments — mark the matching order paid (lifetime access).
    if ((type === 'order.paid' || type === 'payment.captured') && (order?.id || payment?.order_id)) {
      const orderId = order?.id || payment?.order_id;
      const updated = await sb(`purchases?razorpay_order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paid', starts_at: now.toISOString(), razorpay_payment_id: payment?.id || null, expires_at: null }),
      }).catch(() => []);
      if (Array.isArray(updated) && updated[0]) await applyReferral(updated[0].id); // reward referrer (idempotent)
    }

    // Subscription lifecycle.
    if (sub?.id) {
      const filter = `razorpay_subscription_id=eq.${encodeURIComponent(sub.id)}`;
      if (type === 'subscription.activated' || type === 'subscription.charged') {
        // Extend access ~31 days from the charge; current_end if provided.
        const end = sub.current_end
          ? new Date(sub.current_end * 1000)
          : new Date(now.getTime() + 31 * 864e5);
        const updated = await sb(`purchases?${filter}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'active', starts_at: now.toISOString(), expires_at: end.toISOString() }),
        }).catch(() => []);
        if (Array.isArray(updated) && updated[0]) await applyReferral(updated[0].id);
      } else if (type === 'subscription.halted' || type === 'subscription.cancelled' || type === 'subscription.completed') {
        await patchPurchase(filter, { status: 'expired' });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Always 200 so Razorpay doesn't hammer retries on a transient error we log.
    return res.status(200).json({ ok: false, note: String(e.message || e) });
  }
}
