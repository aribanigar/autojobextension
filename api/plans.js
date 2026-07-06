// /api/plans – public list of active plans for the checkout page.
// (Plan management is admin-only and lives in /api/admin.)
import { cors, sb, backendConfigured } from './_lib.js';

export default async function handler(req, res) {
  cors(res, 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!backendConfigured()) {
    return res.status(500).json({ error: 'Backend not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY' });
  }
  try {
    const rows = await sb('plans?active=eq.true&order=price_paise.asc' +
      '&select=id,name,description,price_paise,interval,duration_days,features');
    return res.status(200).json(rows);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
