// Build static SEO landing pages, sitemap.xml and robots.txt for AutoApplier.
//   node scripts/build-seo.mjs
// Pages are plain static HTML (served by Vercel, cleanUrls → /linkedin-auto-apply).
// They add NO serverless functions and touch NO app logic — pure SEO surface.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://jobs.qckserve.in';
const GA = 'G-39RMDHJLXG';
const TODAY = '2026-07-23';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonld = o => JSON.stringify(o).replace(/</g, '\\u003c');

// Shared head: title, meta, canonical, OG/Twitter, GA, structured data.
function head({ title, desc, path, jsonLd = [] }) {
  const url = BASE + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${url}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="AutoApplier" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${BASE}/assets/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${BASE}/assets/og.png" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/favicon.svg" />
<link rel="stylesheet" href="/assets/seo.css" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA}');</script>
${jsonLd.map(o => `<script type="application/ld+json">${jsonld(o)}</script>`).join('\n')}
</head>`;
}

const nav = `<header class="nav"><div class="wrap nav-in">
<a class="brand" href="/"><img src="/favicon.svg" alt="AutoApplier logo" width="26" height="26" /> AutoApplier</a>
<nav class="nav-links">
  <a href="/linkedin-auto-apply">LinkedIn</a>
  <a href="/indeed-auto-apply">Indeed</a>
  <a href="/naukri-auto-apply">Naukri</a>
  <a href="/bayt-auto-apply">Bayt</a>
  <a href="/best-auto-apply-tools">Compare</a>
</nav>
<a class="btn btn-primary" href="/">Get started</a>
</div></header>`;

const footer = `<footer class="foot"><div class="wrap">
<div class="foot-grid">
  <div>
    <a class="brand" href="/"><img src="/favicon.svg" alt="AutoApplier" width="24" height="24" /> AutoApplier</a>
    <p class="muted">Auto apply to jobs on LinkedIn, Indeed, Naukri and Bayt — the agent opens each listing, fills the form, answers screening questions and submits, hands-free.</p>
  </div>
  <div>
    <h4>Auto apply</h4>
    <a href="/linkedin-auto-apply">LinkedIn auto apply</a>
    <a href="/indeed-auto-apply">Indeed auto apply</a>
    <a href="/naukri-auto-apply">Naukri auto apply</a>
    <a href="/bayt-auto-apply">Bayt auto apply</a>
  </div>
  <div>
    <h4>Product</h4>
    <a href="/">Home</a>
    <a href="/checkout">Pricing</a>
    <a href="/best-auto-apply-tools">Best auto apply tools</a>
    <a href="/crm.html">Application tracker</a>
  </div>
</div>
<div class="foot-b muted">© <span id="yr"></span> AutoApplier. Automated job applications for LinkedIn, Indeed, Naukri and Bayt.</div>
</div><script>document.getElementById('yr').textContent=new Date().getFullYear();</script></footer>`;

const softwareApp = {
  '@context': 'https://schema.org', '@type': 'SoftwareApplication',
  name: 'AutoApplier', applicationCategory: 'BusinessApplication',
  operatingSystem: 'Chrome, Edge',
  description: 'Browser extension that automatically applies to jobs on LinkedIn, Indeed, Naukri and Bayt.',
  url: BASE,
  offers: { '@type': 'Offer', priceCurrency: 'INR', price: '799', category: 'subscription' },
};
const org = {
  '@context': 'https://schema.org', '@type': 'Organization',
  name: 'AutoApplier', url: BASE, logo: BASE + '/favicon.svg',
  sameAs: [],
};
const faqLd = faqs => ({
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});
const crumbs = (name, path) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
    { '@type': 'ListItem', position: 2, name, item: BASE + path },
  ],
});

const checks = items => `<ul class="ticks">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
const steps = items => `<ol class="steps">${items.map((s, i) => `<li><span class="n">${i + 1}</span><div><b>${s.t}</b><p>${s.d}</p></div></li>`).join('')}</ol>`;
const faqBlock = faqs => `<section class="sec"><div class="wrap"><h2>Frequently asked questions</h2><div class="faqs">${faqs.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></div></section>`;

// ── Platform landing pages ───────────────────────────────────────────────────
const platforms = [
  {
    slug: 'linkedin-auto-apply', name: 'LinkedIn', logo: 'linkedin.png',
    title: 'LinkedIn Auto Apply Bot — Auto Apply to Easy Apply Jobs | AutoApplier',
    desc: 'Auto apply to LinkedIn Easy Apply jobs automatically. AutoApplier opens each listing, fills the form, answers screening questions from your profile, clicks Next through every step and submits — hands-free.',
    h1: 'Auto apply to LinkedIn jobs, automatically',
    lead: 'AutoApplier is a Chrome and Edge extension that runs LinkedIn Easy Apply for you. Run your normal LinkedIn Jobs search, press Start, and the agent opens each role, fills the application, answers the screening questions from your saved profile, clicks Next through every step and submits — then moves to the next job.',
    what: 'LinkedIn auto apply means letting software complete LinkedIn Easy Apply applications on your behalf. Instead of clicking into every posting and re-typing the same details, AutoApplier reads each Easy Apply modal, maps its fields to your profile, handles the multi-step Next / Review / Submit flow, and applies to job after job across every results page until you tell it to stop.',
    stepList: [
      { t: 'Search on LinkedIn as usual', d: 'Open LinkedIn Jobs, apply your filters (title, location, Easy Apply), and get your results list — exactly how you search today.' },
      { t: 'Press Start', d: 'Open AutoApplier and hit Start. The agent begins opening Easy Apply jobs one by one, with human-like timing.' },
      { t: 'It fills and submits', d: 'Name, email, phone, experience, notice period, work authorization and screening questions are answered from your saved profile — including custom questions it learns and reuses.' },
      { t: 'It clicks through every step', d: 'The multi-page Easy Apply flow (Next → Review → Submit) is handled automatically, resume step included.' },
      { t: 'It moves to the next job', d: 'After each submit it paginates and keeps going, logging every application in the built-in tracker.' },
    ],
    benefits: [
      'Applies to LinkedIn Easy Apply roles hands-free, page after page',
      'Answers screening questions from your profile and remembers new ones',
      'Human-like pacing — runs on your own login inside your own browser',
      'Pauses and alerts you on captchas, then resumes automatically',
      'Pick every matching job, or tick only the roles you want',
      'Every application logged automatically in the CRM tracker',
    ],
    faqs: [
      { q: 'Does AutoApplier work with LinkedIn Easy Apply?', a: 'Yes. LinkedIn Easy Apply is fully supported. The agent handles the multi-step Easy Apply modal — filling fields, answering screening questions, selecting a resume, and clicking Next, Review and Submit.' },
      { q: 'Is it safe to auto apply on LinkedIn?', a: 'The agent runs entirely inside your own browser using your own login, with human-like timing. It never auto-solves captchas and does nothing you could not do yourself. You stay in full control and can stop it instantly.' },
      { q: 'Can I choose which LinkedIn jobs it applies to?', a: 'Yes. Let it apply to every job that matches your search, or tick only the specific listings you want and it applies to just those, in the order you picked.' },
      { q: 'Do I have to watch it apply?', a: 'No. Once you press Start it runs on its own across pages and listings. It only pauses for a captcha, which it flags and then resumes automatically once solved.' },
      { q: 'Which browsers does the LinkedIn auto apply extension support?', a: 'Google Chrome and Microsoft Edge. AutoApplier is a Manifest V3 extension you load unpacked — download the zip, unzip, and add it from your browser extensions page.' },
    ],
  },
  {
    slug: 'indeed-auto-apply', name: 'Indeed', logo: 'indeed.png',
    title: 'Indeed Auto Apply — Automatically Apply to Indeed Jobs | AutoApplier',
    desc: 'Auto apply to Indeed jobs automatically. AutoApplier opens each Apply-with-Indeed listing, fills the multi-step form, answers screening questions from your profile, clicks Continue and submits — hands-free.',
    h1: 'Auto apply to Indeed jobs, automatically',
    lead: 'AutoApplier runs Indeed applications for you. Search Indeed as normal, press Start, and the agent opens each Apply-with-Indeed job, works through the multi-step Continue flow, answers screening questions from your saved profile and submits — then moves straight to the next job.',
    what: 'Indeed auto apply means automating the Apply-with-Indeed flow end to end. AutoApplier detects Apply-with-Indeed buttons, follows the cross-page application (including the hop to apply.indeed.com), fills each step from your profile, clicks Continue and Submit, hands off captchas to you, and keeps applying across results pages so you never re-type the same answers again.',
    stepList: [
      { t: 'Search on Indeed as usual', d: 'Run your normal Indeed search with your filters and location. No new workflow to learn.' },
      { t: 'Press Start', d: 'Open AutoApplier and hit Start. It begins opening Apply-with-Indeed jobs one at a time.' },
      { t: 'It completes the multi-step form', d: 'Contact details, experience, and screening questions are filled from your profile across every Continue step.' },
      { t: 'It handles the Indeed apply hop', d: 'The cross-origin jump to apply.indeed.com is handled automatically, so the run continues without you.' },
      { t: 'It submits and continues', d: 'Each application is submitted and logged, then the agent paginates to the next job.' },
    ],
    benefits: [
      'Completes Apply-with-Indeed multi-step forms automatically',
      'Survives the apply.indeed.com hop and resumes on its own',
      'Answers screening questions from your saved profile',
      'Two-tier dedupe so it never applies to the same job twice',
      'Captcha hand-off with a desktop alert, then auto-resume',
      'Applies across every results page until you stop it',
    ],
    faqs: [
      { q: 'Can AutoApplier auto apply to Indeed jobs?', a: 'Yes. AutoApplier supports Apply-with-Indeed end to end — detecting the apply button, completing the multi-step Continue flow, answering screening questions and submitting, then moving to the next job.' },
      { q: 'Does it handle the redirect to apply.indeed.com?', a: 'Yes. The cross-origin hop to apply.indeed.com is handled automatically. The run state is preserved so the agent resumes and keeps applying without you restarting anything.' },
      { q: 'Will it apply to the same Indeed job twice?', a: 'No. A two-tier dedupe tracks jobs it has already attempted and applied to, so each listing is only processed once.' },
      { q: 'What happens on an Indeed captcha?', a: 'The agent never auto-solves captchas. It highlights the captcha, sends a desktop alert, and resumes automatically the moment you solve it.' },
      { q: 'Which browsers work for Indeed auto apply?', a: 'Chrome and Edge. AutoApplier is a Manifest V3 extension you load unpacked from your browser extensions page.' },
    ],
  },
  {
    slug: 'naukri-auto-apply', name: 'Naukri', logo: 'naukri.png',
    title: 'Naukri Auto Apply — Automatically Apply to Naukri Jobs (India) | AutoApplier',
    desc: 'Auto apply to Naukri and Naukri Gulf jobs automatically. AutoApplier applies to matching roles, answers chatbot screening questions from your profile and moves through listings hands-free.',
    h1: 'Auto apply to Naukri jobs, automatically',
    lead: 'AutoApplier applies to Naukri and Naukri Gulf jobs for you. Search Naukri as usual, press Start, and the agent applies to matching roles, answers the Naukri chatbot screening questions from your saved profile, and works through listing after listing — hands-free.',
    what: 'Naukri auto apply means automating applications on Naukri.com (and Naukri Gulf for the Middle East). AutoApplier clicks Apply on matching roles, answers the Naukri chatbot questions — notice period, current and expected CTC, experience, location — from your profile, remembers answers you fill manually so it can reuse them, and continues across the results so you apply to far more roles in less time.',
    stepList: [
      { t: 'Search on Naukri as usual', d: 'Run your normal Naukri or Naukri Gulf search with your filters. Nothing new to learn.' },
      { t: 'Press Start', d: 'Open AutoApplier and hit Start. It begins applying to matching roles one by one.' },
      { t: 'It answers the Naukri chatbot', d: 'Notice period, current CTC, expected CTC, total experience and location questions are answered from your profile.' },
      { t: 'It learns and reuses answers', d: 'Any question you answer manually is remembered and auto-filled the next time a similar question appears.' },
      { t: 'It keeps applying', d: 'Each application is logged and the agent continues through the listings until you stop it.' },
    ],
    benefits: [
      'Applies to Naukri.com and Naukri Gulf roles automatically',
      'Answers the Naukri chatbot (notice period, CTC, experience) from your profile',
      'Smart memory — learns answers you type and reuses them',
      'Ideal for the India and Gulf job markets',
      'Runs on your own login with human-like pacing',
      'Every application tracked in the built-in CRM',
    ],
    faqs: [
      { q: 'Can AutoApplier auto apply on Naukri.com?', a: 'Yes. AutoApplier applies to matching Naukri roles and answers the Naukri chatbot screening questions — notice period, current and expected CTC, experience and location — from your saved profile.' },
      { q: 'Does it support Naukri Gulf?', a: 'Yes. Naukri Gulf is supported as a separate platform for Middle East roles, using the same profile and learned answers.' },
      { q: 'Does it remember my Naukri answers?', a: 'Yes. Any question you fill manually is saved and auto-filled next time a similar question appears, so screening questions get faster over time.' },
      { q: 'Is Naukri auto apply safe for my account?', a: 'The agent runs inside your own browser using your own login, with human-like timing, and never auto-solves captchas. You stay in control and can stop instantly.' },
      { q: 'Which browsers does it need?', a: 'Chrome or Edge. AutoApplier is a Manifest V3 extension loaded unpacked from your extensions page.' },
    ],
  },
  {
    slug: 'bayt-auto-apply', name: 'Bayt', logo: 'bayt.png',
    title: 'Bayt Auto Apply — Automatically Apply to Bayt Jobs (Middle East) | AutoApplier',
    desc: 'Auto apply to Bayt.com jobs automatically. AutoApplier opens each Easy Apply role, answers the additional questions from your profile, remembers your answers and moves through listings hands-free.',
    h1: 'Auto apply to Bayt jobs, automatically',
    lead: 'AutoApplier applies to Bayt.com jobs for you. Search Bayt as usual, press Start, and the agent opens each Easy Apply role, answers the additional application questions from your saved profile, remembers new answers, and works through listing after listing across the Middle East job market.',
    what: 'Bayt auto apply means automating applications on Bayt.com, the leading Middle East job site. AutoApplier finds Easy Apply roles, opens the application, answers the additional questions from your profile, captures and reuses any answer you provide manually, and paginates through results — so you cover far more Gulf and MENA roles without re-typing the same details.',
    stepList: [
      { t: 'Search on Bayt as usual', d: 'Run your normal Bayt.com search with your filters and location across the Middle East.' },
      { t: 'Press Start', d: 'Open AutoApplier and hit Start. It begins opening Easy Apply roles one at a time.' },
      { t: 'It answers the additional questions', d: 'Bayt’s extra application questions are answered from your saved profile, with a per-job time cap so it never stalls.' },
      { t: 'It remembers your answers', d: 'Anything you fill manually is stored and reused automatically on future Bayt forms.' },
      { t: 'It keeps applying', d: 'Each application is logged and the agent moves through the listings until you stop it.' },
    ],
    benefits: [
      'Applies to Bayt.com Easy Apply roles automatically',
      'Answers Bayt’s additional questions from your profile',
      'Remembers and reuses answers you fill manually',
      'Built for the Middle East and MENA job market',
      'Runs on your own login with human-like pacing',
      'Every application logged in the built-in tracker',
    ],
    faqs: [
      { q: 'Can AutoApplier auto apply to Bayt.com jobs?', a: 'Yes. AutoApplier opens each Bayt Easy Apply role, answers the additional application questions from your saved profile and submits, then moves to the next job.' },
      { q: 'Does it remember my Bayt answers?', a: 'Yes. Any answer you provide manually is captured and auto-filled the next time the same or a similar question appears on a Bayt form.' },
      { q: 'Is it built for the Middle East job market?', a: 'Yes. Bayt.com is the leading Gulf and MENA job site, and AutoApplier also supports Naukri Gulf, so it fits Middle East job seekers well.' },
      { q: 'Is Bayt auto apply safe?', a: 'The agent runs inside your own browser with your own login and human-like timing, never auto-solving captchas. You can stop it at any moment.' },
      { q: 'Which browsers does it support?', a: 'Chrome and Edge, as a Manifest V3 extension loaded unpacked from your extensions page.' },
    ],
  },
];

function platformPage(p) {
  const others = platforms.filter(o => o.slug !== p.slug);
  const path = '/' + p.slug;
  const body = `<body>
${nav}
<main>
<section class="hero"><div class="wrap">
  <div class="hero-grid">
    <div>
      <div class="pill"><img src="/assets/logos/${p.logo}" alt="${p.name}" height="18" /> ${p.name} auto apply</div>
      <h1>${p.h1}</h1>
      <p class="lead">${p.lead}</p>
      <div class="cta-row">
        <a class="btn btn-primary btn-lg" href="/">Start applying on autopilot →</a>
        <a class="btn btn-ghost btn-lg" href="/checkout">See pricing</a>
      </div>
      <p class="micro">Works on Chrome &amp; Edge · runs on your own login · stop anytime</p>
    </div>
  </div>
</div></section>

<section class="sec"><div class="wrap narrow">
  <h2>What is ${p.name} auto apply?</h2>
  <p>${p.what}</p>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <h2>How AutoApplier works on ${p.name}</h2>
  ${steps(p.stepList)}
</div></section>

<section class="sec"><div class="wrap">
  <h2>Why use AutoApplier for ${p.name}</h2>
  ${checks(p.benefits)}
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <h2>One agent for every job board</h2>
  <p class="muted">AutoApplier isn’t just ${p.name}. The same extension and the same profile apply for you across all four supported job boards:</p>
  <div class="cards">
    ${others.map(o => `<a class="pcard" href="/${o.slug}"><img src="/assets/logos/${o.logo}" alt="${o.name}" height="22" /><b>${o.name} auto apply</b><span>Automate applications on ${o.name}.</span></a>`).join('')}
  </div>
</div></section>

<section class="cta-band"><div class="wrap">
  <h2>Apply to more ${p.name} jobs in less time</h2>
  <p>Set up your profile once and let AutoApplier work through page after page while you do something else.</p>
  <a class="btn btn-primary btn-lg" href="/">Get started free →</a>
</div></section>

${faqBlock(p.faqs)}
</main>
${footer}
</body></html>`;

  return head({
    title: p.title, desc: p.desc, path,
    jsonLd: [softwareApp, org, crumbs(`${p.name} auto apply`, path), faqLd(p.faqs)],
  }) + body;
}

// ── Comparison / "best auto apply tools" listicle ────────────────────────────
function bestToolsPage() {
  const path = '/best-auto-apply-tools';
  const faqs = [
    { q: 'What is the best auto apply tool for jobs in 2026?', a: 'The best tool depends on the job boards you use. AutoApplier is built for LinkedIn Easy Apply, Indeed, Naukri, Naukri Gulf and Bayt — it fully submits applications (not just autofill), answers screening questions from your profile, and is priced for the India, Middle East, US and UK markets.' },
    { q: 'What is the difference between auto apply and autofill?', a: 'Autofill only pre-fills form fields — you still click Submit on every job. A true auto apply tool like AutoApplier completes the whole application, clicks through the multi-step flow, and submits it, then moves to the next job on its own.' },
    { q: 'Do auto apply tools work on LinkedIn Easy Apply?', a: 'AutoApplier handles LinkedIn Easy Apply end to end — the multi-step modal, screening questions, resume step and Submit. Many tools only autofill or only work on a single board.' },
    { q: 'Are auto apply extensions safe to use?', a: 'AutoApplier runs inside your own browser using your own login, with human-like timing, and never auto-solves captchas — it does nothing you could not do yourself, and you can stop it instantly.' },
    { q: 'How much does AutoApplier cost?', a: 'AutoApplier uses simple, transparent pricing shown in your local currency, with a single activation key that unlocks both the extension and the built-in application tracker.' },
  ];
  const rows = [
    ['AutoApplier', 'LinkedIn, Indeed, Naukri, Naukri Gulf, Bayt', 'Full submit', 'Yes (learns answers)', 'India, Middle East, US, UK'],
    ['LoopCV', 'Mostly LinkedIn / job feeds', 'Mixed', 'Limited', 'Global'],
    ['LazyApply', 'LinkedIn Easy Apply focus', 'Full submit', 'Basic', 'Global'],
    ['Simplify', 'Autofill across ATS', 'Autofill only', 'Basic', 'US-centric'],
    ['Sonara', 'Curated feeds', 'Assisted', 'Limited', 'US-centric'],
  ];
  const table = `<div class="tablewrap"><table class="cmp">
  <thead><tr><th>Tool</th><th>Job boards</th><th>Submits or autofill</th><th>Screening answers</th><th>Best for</th></tr></thead>
  <tbody>${rows.map((r, i) => `<tr${i === 0 ? ' class="hi"' : ''}>${r.map((c, j) => `<td>${j === 0 ? `<b>${esc(c)}</b>` : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
  const itemList = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    itemListElement: rows.map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: r[0] })),
  };
  const body = `<body>
${nav}
<main>
<section class="hero"><div class="wrap">
  <h1>Best auto apply tools for jobs in 2026</h1>
  <p class="lead">Auto apply tools submit job applications for you instead of making you fill the same forms over and over. Here is how the leading options compare — by job board coverage, whether they truly submit or only autofill, how they handle screening questions, and who each is best for.</p>
</div></section>

<section class="sec"><div class="wrap">
  <h2>Auto apply tools compared</h2>
  ${table}
  <p class="micro">Comparison reflects each tool’s primary, publicly described focus and can change as products update. AutoApplier is our own product.</p>
</div></section>

<section class="sec sec-alt"><div class="wrap narrow">
  <h2>Why AutoApplier ranks first for LinkedIn, Indeed, Naukri &amp; Bayt</h2>
  <p>Most auto apply tools are built around US ATS portals or only autofill a form and leave you to click Submit. AutoApplier is different: it <b>fully submits</b> applications on <b>LinkedIn Easy Apply, Indeed, Naukri, Naukri Gulf and Bayt</b>, answers screening questions from your saved profile, and <b>learns the answers you type</b> so future applications get faster. It runs on your own login inside your own browser, hands captchas back to you, and logs every application in a built-in tracker. Pricing is shown in your local currency for the India, Middle East, US and UK markets.</p>
  <div class="cta-row"><a class="btn btn-primary btn-lg" href="/">Try AutoApplier →</a><a class="btn btn-ghost btn-lg" href="/checkout">See pricing</a></div>
</div></section>

<section class="sec"><div class="wrap">
  <h2>Auto apply, board by board</h2>
  <div class="cards">
    ${platforms.map(o => `<a class="pcard" href="/${o.slug}"><img src="/assets/logos/${o.logo}" alt="${o.name}" height="22" /><b>${o.name} auto apply</b><span>How AutoApplier automates ${o.name}.</span></a>`).join('')}
  </div>
</div></section>

${faqBlock(faqs)}
</main>
${footer}
</body></html>`;
  return head({
    title: 'Best Auto Apply Tools for Jobs in 2026 (LinkedIn, Indeed, Naukri, Bayt) | AutoApplier',
    desc: 'Compare the best auto apply tools for jobs in 2026. See which tools truly submit applications (not just autofill), which job boards they cover, and how they handle screening questions.',
    path, jsonLd: [org, itemList, crumbs('Best auto apply tools', path), faqLd(faqs)],
  }) + body;
}

// ── Write pages ──────────────────────────────────────────────────────────────
const pages = [];
for (const p of platforms) { const f = `${p.slug}.html`; writeFileSync(join(ROOT, f), platformPage(p)); pages.push('/' + p.slug); }
writeFileSync(join(ROOT, 'best-auto-apply-tools.html'), bestToolsPage()); pages.push('/best-auto-apply-tools');

// Sitemap (marketing + SEO pages only; app/utility pages excluded).
const sitemapUrls = [
  { loc: '/', pr: '1.0' }, { loc: '/checkout', pr: '0.8' },
  ...pages.map(u => ({ loc: u, pr: '0.9' })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u => `  <url><loc>${BASE}${u.loc}</loc><lastmod>${TODAY}</lastmod><changefreq>weekly</changefreq><priority>${u.pr}</priority></url>`).join('\n')}
</urlset>`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);

const robots = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin.html
Disallow: /reset.html
Sitemap: ${BASE}/sitemap.xml
`;
writeFileSync(join(ROOT, 'robots.txt'), robots);

console.log('Built SEO pages:', pages.join(', '));
console.log('Wrote sitemap.xml (', sitemapUrls.length, 'urls ) and robots.txt');
