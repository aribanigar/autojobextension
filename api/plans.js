// /api/plans – public list of active plans for the checkout page.
// (Plan management is admin-only and lives in /api/admin.)
//
// Geo-priced & privacy-preserving: the visitor's country is resolved server-side
// (Vercel edge header) to a region, and each plan is returned with ONLY that
// region's price. The full per-region `prices` map never leaves the server, so a
// visitor in India can't see the UAE/US/UK price and vice versa.
import { cors, sb, backendConfigured, regionForCountry, countryFromReq, priceForPlan } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!backendConfigured()) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }
  try {
    const region = regionForCountry(countryFromReq(req));
    // Select the prices map for server-side resolution; fall back gracefully if
    // the column doesn't exist yet (pre-migration → legacy INR pricing).
    let rows;
    try {
      rows = await sb('plans?active=eq.true&order=price_paise.asc' +
        '&select=id,name,description,price_paise,interval,duration_days,features,prices');
    } catch {
      rows = await sb('plans?active=eq.true&order=price_paise.asc' +
        '&select=id,name,description,price_paise,interval,duration_days,features');
    }
    // Return only the resolved price per plan — NEVER the full prices map.
    const out = rows.map(p => {
      const pr = priceForPlan(p, region);
      return {
        id: p.id, name: p.name, description: p.description,
        interval: p.interval, duration_days: p.duration_days, features: p.features,
        currency: pr.currency, symbol: pr.symbol, amount: pr.amount,
        price_paise: pr.amount, // back-compat: older clients read price_paise
      };
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
