// /api/ai – Gemini-powered smart-apply endpoint
// Env vars required:
//   GEMINI_API_KEY  from https://aistudio.google.com/apikey
//   CRM_API_KEY     same shared secret as /api/jobs
//
// POST { kind: 'answer'|'fit'|'cover', question?, options?, job?, profile? }
//   answer → best answer for an application question (picks from options if given)
//   fit    → { score: 0-100, reason } for profile vs job description
//   cover  → short tailored cover letter

const MODEL = 'gemini-2.0-flash';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
}

// Valid caller = a logged-in user WITH an active licence (or admin), or the
// legacy admin key. Returns 'ok' | 'unauth' | 'unpaid'.
async function authorize(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (bearer && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const base = process.env.SUPABASE_URL + '/rest/v1/';
    const h = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    const users = await fetch(
      `${base}users?token=eq.${encodeURIComponent(bearer[1])}&select=email,is_admin`, { headers: h }
    ).then(x => x.json()).catch(() => []);
    if (!Array.isArray(users) || !users.length) return 'unauth';
    const email = users[0].email;
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (users[0].is_admin || (adminEmail && email.toLowerCase() === adminEmail)) return 'ok';
    const nowIso = new Date().toISOString();
    const lic = await fetch(
      `${base}purchases?user_email=eq.${encodeURIComponent(email)}&status=in.(paid,active)` +
      `&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(nowIso)})&select=id&limit=1`, { headers: h }
    ).then(x => x.json()).catch(() => []);
    return (Array.isArray(lic) && lic.length) ? 'ok' : 'unpaid';
  }
  const keyOk = !!process.env.CRM_API_KEY && (req.headers['x-api-key'] || '') === process.env.CRM_API_KEY;
  return keyOk ? 'ok' : 'unauth';
}

function profileSummary(p = {}) {
  const per = p.personal || {}, pro = p.professional || {}, prf = p.preferences || {};
  return [
    per.name && `Name: ${per.name}`,
    per.location && `Location: ${per.location}`,
    pro.currentTitle && `Current title: ${pro.currentTitle} at ${pro.currentCompany || 'current company'}`,
    pro.experience && `Experience: ${pro.experience} years`,
    pro.skills && `Skills: ${pro.skills}`,
    pro.education && `Education: ${pro.education}`,
    pro.currentSalary && `Current salary: ${pro.currentSalary}`,
    pro.expectedSalary && `Expected salary: ${pro.expectedSalary}`,
    pro.noticePeriod && `Notice period: ${pro.noticePeriod}`,
    pro.languages && `Languages: ${pro.languages}`,
    `Work mode preference: ${prf.workMode || 'hybrid'}`,
    `Willing to relocate: ${prf.willingToRelocate ? 'Yes' : 'No'}`,
    `Authorized to work: ${prf.workAuth !== false ? 'Yes' : 'No'}`,
  ].filter(Boolean).join('\n');
}

async function gemini(prompt, maxTokens = 300) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  return text.trim();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'AI not configured: set GEMINI_API_KEY in Vercel environment variables' });
  }
  const authz = await authorize(req);
  if (authz === 'unauth') return res.status(401).json({ error: 'Log in required' });
  if (authz === 'unpaid') return res.status(402).json({ error: 'Purchase required — buy a plan to use JobBot' });

  const { kind, question, options, job, profile } = req.body || {};

  try {
    if (kind === 'answer') {
      if (!question) return res.status(400).json({ error: 'question required' });
      const opts = Array.isArray(options) && options.length
        ? `\nChoose EXACTLY one of these options and reply with that option text verbatim:\n${options.map(o => `- ${o}`).join('\n')}`
        : '\nReply with a short, direct answer (a number, "Yes"/"No", or at most one sentence). No explanations.';
      const answer = await gemini(
        `You are filling out a job application form on behalf of this candidate:\n${profileSummary(profile)}\n\n` +
        `Application question: "${question}"${opts}\n\n` +
        `Answer in the candidate's favor when reasonable, but never fabricate credentials they don't have.`
      );
      return res.status(200).json({ answer });
    }

    if (kind === 'fit') {
      if (!job) return res.status(400).json({ error: 'job (title/description) required' });
      const raw = await gemini(
        `Candidate profile:\n${profileSummary(profile)}\n\nJob posting:\n${String(job).slice(0, 6000)}\n\n` +
        `Rate how well this candidate fits this job. Respond with ONLY valid JSON: {"score": <0-100 integer>, "reason": "<one sentence>"}`
      );
      const m = raw.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : { score: null, reason: raw };
      return res.status(200).json(parsed);
    }

    if (kind === 'cover') {
      if (!job) return res.status(400).json({ error: 'job (title/description) required' });
      const cover = await gemini(
        `Candidate profile:\n${profileSummary(profile)}\n\nJob posting:\n${String(job).slice(0, 6000)}\n\n` +
        `Write a concise, specific cover note (3-5 sentences, first person, no placeholders, no "Dear Hiring Manager" header) tailored to this job.`,
        500
      );
      return res.status(200).json({ cover });
    }

    return res.status(400).json({ error: "kind must be 'answer', 'fit', or 'cover'" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
