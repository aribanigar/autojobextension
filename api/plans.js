// /api/plans – list plans (public) and manage them (admin only)
//   GET                       → active plans, for the checkout page
//   GET   ?all=1   (admin)    → every plan incl. inactive
//   POST           (admin)    → create a plan (creates a Razorpay plan if monthly)
//   PATCH          (admin)    → update a plan (name, price, features, active…)
//   DELETE ?id=…   (admin)    → delete a plan
import { cors, sb, backendConfigured, getUserByToken, rzp, razorpayConfigured } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!backendConfigured()) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }

  try {
    // Public: the checkout page lists active plans without logging in.
    if (req.method === 'GET' && !req.query.all) {
      const rows = await sb('plans?active=eq.true&order=price_paise.asc' +
        '&select=id,name,description,price_paise,interval,features');
      return res.status(200).json(rows);
    }

    // Everything else needs an admin.
    const user = await getUserByToken(req);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });

    if (req.method === 'GET') {
      return res.status(200).json(await sb('plans?order=created_at.desc'));
    }

    if (req.method === 'POST') {
      const { name, description = '', price_paise, interval = 'once', features = {}, active = true } = req.body || {};
      if (!name || !Number.isInteger(price_paise) || price_paise < 0) {
        return res.status(400).json({ error: 'name and a non-negative integer price_paise (in paise) are required' });
      }
      if (!['once', 'monthly'].includes(interval)) {
        return res.status(400).json({ error: "interval must be 'once' or 'monthly'" });
      }

      // Recurring plans need a matching Razorpay plan object.
      let razorpay_plan_id = null;
      if (interval === 'monthly') {
        if (!razorpayConfigured()) {
          return res.status(400).json({ error: 'Razorpay keys not set — cannot create a recurring plan. Set RAZORPAY_KEY_ID/SECRET or use a one-time plan.' });
        }
        const rp = await rzp('plans', {
          method: 'POST',
          body: JSON.stringify({
            period: 'monthly', interval: 1,
            item: { name, amount: price_paise, currency: 'INR', description: description || name },
          }),
        });
        razorpay_plan_id = rp.id;
      }

      const rows = await sb('plans', {
        method: 'POST',
        body: JSON.stringify([{ name, description, price_paise, interval, razorpay_plan_id, features, active }]),
      });
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const allowed = {};
      for (const k of ['name', 'description', 'price_paise', 'features', 'active']) {
        if (k in fields) allowed[k] = fields[k];
      }
      const rows = await sb(`plans?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(allowed),
      });
      return res.status(200).json(rows[0] || null);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`plans?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
