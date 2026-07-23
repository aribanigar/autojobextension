// /api/config – public, non-secret front-end configuration.
// Only exposes values that are safe to ship to the browser (a Google OAuth
// *client ID* is public by design). Never put secrets here.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json({
    googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  });
}
