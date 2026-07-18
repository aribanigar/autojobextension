// /api/telemetry – anonymous field-health beacons from the extension.
//   POST { anon_id, version, platform, type, detail, host }
// No auth (it must capture failures that happen before a user is even logged in),
// but strictly bounded + an event-type allowlist, and it only ever INSERTs one
// small row. It ALWAYS returns 204 and never throws, so a broken/absent telemetry
// table (or any error) can never affect the extension. Read via the admin console.
import { cors, sb, backendConfigured } from './_lib.js';

const TYPES = new Set([
  'run_start', 'applied', 'agent_error', 'agent_warning',
  'selector_miss', 'no_cards', 'apply_failed', 'captcha', 'js_error', 'backend_error',
]);
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export default async function handler(req, res) {
  cors(res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (backendConfigured()) {
      const b = req.body || {};
      const type = String(b.type || '').trim();
      if (TYPES.has(type)) {
        await sb('telemetry', {
          method: 'POST',
          body: JSON.stringify([{
            anon_id:  clip(b.anon_id, 64),
            version:  clip(b.version, 16),
            platform: clip(b.platform, 20),
            type,
            detail:   clip(b.detail, 200),
            host:     clip(b.host, 120),
          }]),
        }).catch(() => {});   // e.g. table not created yet → silently ignore
      }
    }
  } catch { /* telemetry must never error */ }
  return res.status(204).end();
}
