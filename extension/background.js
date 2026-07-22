// background.js – JobBot service worker

const DEFAULT_PROFILE = {
  personal: { name: '', email: '', phone: '', location: '', postalCode: '', gender: '', dateOfBirth: '', nationality: '', maritalStatus: '', linkedin: '' },
  professional: {
    currentTitle: '', currentCompany: '', experience: '3',
    currentSalary: '', expectedSalary: '', noticePeriod: '30 days',
    skills: '', education: "Bachelor's Degree", languages: 'English, Hindi',
    coverLetter: ''
  },
  preferences: {
    workMode: 'hybrid', travelPercentage: '25',
    willingToRelocate: false, onlyEasyApply: true, workAuth: true,
    humanPace: false, paceDaily: 0
  }
};

const VALID_PLATFORMS = ['linkedin', 'indeed', 'naukri', 'naukrigulf', 'bayt'];
const stats = { linkedin: 0, indeed: 0, naukri: 0, naukrigulf: 0, bayt: 0, skipped: 0 };

// The agent must only ever run after an explicit Start click in THIS browser
// session. Clear any stale running flag left behind by a crash/closed browser,
// so opening a job site never auto-starts the agent on its own.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.set({ jobbot_running: false }));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ jobbot_running: false }));

// Stats survive service-worker eviction: hydrate on startup, persist on change
const statsReady = new Promise(resolve => {
  chrome.storage.local.get('jobbot_stats', d => {
    if (d.jobbot_stats) Object.assign(stats, d.jobbot_stats);
    updateBadge();
    resolve();
  });
});

function persistStats() {
  chrome.storage.local.set({ jobbot_stats: { ...stats } });
}

function updateBadge() {
  const total = stats.linkedin + stats.indeed + stats.naukri + (stats.naukrigulf || 0) + (stats.bayt || 0);
  chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

// ── CRM account session ──────────────────────────────────────────────────────
// Default backend so users only need to paste their license key (no URL setup).
const DEFAULT_CRM = 'https://jobs.qckserve.in';
const crmBase = prefs => (prefs.crmUrl || DEFAULT_CRM).replace(/\/+$/, '');

// ── In-app update checker ────────────────────────────────────────────────────
// The extension ships as a downloadable zip (not the Web Store), so it can't
// silently self-update. Instead we compare the INSTALLED version against a small
// version.json on the backend; when a newer build exists the popup shows an
// "Update available" banner with a one-click download. This is purely
// informational and NON-BLOCKING: if the check fails, the server is older, or the
// user stays on the old build, everything keeps working exactly as before. Old
// builds without this code are completely unaffected — nothing is ever gated on
// the version, so an out-of-date extension is never disabled.
const VERSION_URL = () => `${DEFAULT_CRM}/version.json?t=${Date.now()}`;

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  try {
    const r = await fetch(VERSION_URL(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const latest = String(d.version || '');
    const info = {
      current, latest,
      available: !!latest && cmpVer(latest, current) > 0,
      url: d.url || `${DEFAULT_CRM}/jobbot-extension.zip`,
      notes: d.notes || '',
      checkedAt: Date.now(),
    };
    try { chrome.storage.local.set({ jobbot_update: info }); } catch {}
    return info;
  } catch {
    // Offline / old server / blocked — never disrupt the extension.
    return { current, latest: current, available: false, checkedAt: Date.now() };
  }
}

// Best-effort checks on install and browser startup (in addition to the popup
// asking on open). Extra listeners are fine — they compose with the ones above.
chrome.runtime.onInstalled.addListener(() => { try { checkForUpdate(); } catch {} });
chrome.runtime.onStartup.addListener(() => { try { checkForUpdate(); } catch {} });

// ── Telemetry relay ──────────────────────────────────────────────────────────
// POST an anonymous field-health beacon to the OWNER's backend (always the
// default host, even if the user set a custom crmUrl). Fire-and-forget: never
// awaited, never throws, wrapped so a failed beacon can't affect anything.
function sendTelemetry(event) {
  try {
    fetch(`${DEFAULT_CRM}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event || {}),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Background-side beacon (e.g. backend unreachable). Deduped to ≤1 per key per
// 5 min so a repeated failure doesn't spam. Reads the anon id + version inline.
const _beaconSeen = new Map();
function bgBeacon(type, detail) {
  try {
    const k = type + '|' + (detail || ''); const now = Date.now();
    if (_beaconSeen.get(k) && now - _beaconSeen.get(k) < 300000) return;
    _beaconSeen.set(k, now);
    let ver = ''; try { ver = chrome.runtime.getManifest().version; } catch {}
    chrome.storage.local.get('jobbot_anon', d => {
      void chrome.runtime.lastError;
      sendTelemetry({ anon_id: (d && d.jobbot_anon) || null, version: ver, platform: null, type, detail, host: 'background' });
    });
  } catch {}
}

function getPrefs() {
  return new Promise(res =>
    chrome.storage.local.get('jobbot_profile', d => res(d.jobbot_profile?.preferences || {})));
}

async function getCrmToken(force = false) {
  const prefs = await getPrefs();
  if (!prefs.crmUrl || !prefs.crmEmail || !prefs.crmPassword) return null;
  if (!force) {
    const cached = await new Promise(res =>
      chrome.storage.local.get('jobbot_crm_token', d => res(d.jobbot_crm_token || null)));
    if (cached) return cached;
  }
  try {
    const r = await fetch(`${prefs.crmUrl.replace(/\/+$/, '')}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email: prefs.crmEmail, password: prefs.crmPassword }),
    });
    if (!r.ok) return null;
    const { token } = await r.json();
    if (token) chrome.storage.local.set({ jobbot_crm_token: token });
    return token || null;
  } catch { return null; }
}

// ── Licence check ────────────────────────────────────────────────────────────
// The agent may only run for an account with an active paid licence. Result is
// cached briefly so a run's restarts (watchdog / auto-resume) don't hammer the
// endpoint. A definitive "not active" blocks immediately; a network error falls
// back to the last known-good result for up to 24h so a transient outage never
// locks out a paying user.
// Stable per-device id (this browser install). Used to bind a license key to a
// single device — activating the key elsewhere logs this device out.
async function getDeviceId() {
  const d = await new Promise(res => {
    try { chrome.storage.local.get('jobbot_device_id', x => { void chrome.runtime.lastError; res(x || {}); }); }
    catch { res({}); }
  });
  let id = d.jobbot_device_id;
  if (!id) {
    try { id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : null; } catch { id = null; }
    if (!id) id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { chrome.storage.local.set({ jobbot_device_id: id }); } catch {}
  }
  return id;
}

let _licCache = null; // { active, expires_at, ts }
async function getLicense(force = false, claim = false) {
  const prefs = await getPrefs();
  const base = crmBase(prefs);
  if (!force && _licCache && Date.now() - _licCache.ts < 5 * 60 * 1000) return _licCache;

  // ── Primary: admin-issued license KEY ──────────────────────────────────────
  if (prefs.licenseKey) {
    try {
      const deviceId = await getDeviceId();
      const r = await fetch(`${base}/api/license-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: prefs.licenseKey, device_id: deviceId, claim: !!claim }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.valid) {
        if (d.device_conflict) { _licCache = { active: false, reason: 'device', ts: Date.now() }; return _licCache; }
        _licCache = { active: !!d.active, expires_at: d.expires_at, reason: d.active ? undefined : 'expired', ts: Date.now() };
        return _licCache;
      }
      return { active: false, reason: 'bad-key' }; // invalid/revoked
    } catch {
      bgBeacon('backend_error', 'license unreachable');
      if (_licCache && _licCache.active && Date.now() - _licCache.ts < 24 * 3600 * 1000) return _licCache;
      return { active: false, reason: 'offline' };
    }
  }

  // ── Fallback: email/password account (self-serve Razorpay users) ────────────
  let token = await getCrmToken();
  if (!token) return { active: false, reason: 'no-key' };
  const call = t => fetch(`${base}/api/license`, { headers: { Authorization: `Bearer ${t}` } });
  try {
    let r = await call(token);
    if (r.status === 401) { token = await getCrmToken(true); if (token) r = await call(token); }
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    _licCache = { active: !!d.active, is_admin: !!d.is_admin, ts: Date.now() };
    return _licCache;
  } catch {
    bgBeacon('backend_error', 'license unreachable');
      if (_licCache && _licCache.active && Date.now() - _licCache.ts < 24 * 3600 * 1000) return _licCache;
    return { active: false, reason: 'offline' };
  }
}

// ── Per-user AI (Gemini) ─────────────────────────────────────────────────────
// Runs the AI question here in the background worker using the USER'S OWN key.
// The key stays local to their browser and the usage is billed to their Google
// account — the app owner never sees the key or pays for the call.
function profileSummary(p = {}) {
  const per = p.personal || {}, pro = p.professional || {}, prf = p.preferences || {};
  return [
    per.name && `Name: ${per.name}`,
    per.email && `Email: ${per.email}`,
    per.phone && `Phone: ${per.phone}`,
    per.location && `Location: ${per.location}`,
    per.gender && `Gender: ${per.gender}`,
    per.dateOfBirth && `Date of birth: ${per.dateOfBirth}`,
    per.nationality && `Nationality: ${per.nationality}`,
    per.maritalStatus && `Marital status: ${per.maritalStatus}`,
    per.linkedin && `LinkedIn: ${per.linkedin}`,
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

async function geminiAnswer(apiKey, question, options = [], profile = {}) {
  if (!apiKey || !question) return null;
  const opts = Array.isArray(options) && options.length
    ? `\nChoose EXACTLY one of these options and reply with that option text verbatim:\n${options.map(o => `- ${o}`).join('\n')}`
    : '\nReply with a short, direct answer (a number, "Yes"/"No", or at most one sentence). No explanations.';
  const prompt =
    `You are filling out a job application form on behalf of this candidate:\n${profileSummary(profile)}\n\n` +
    `Application question: "${question}"${opts}\n\n` +
    `Answer in the candidate's favor when reasonable, but never fabricate credentials they don't have.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
        }),
        signal: ctrl.signal,
      }
    );
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim() || null;
  } catch { clearTimeout(t); return null; }
}

// Real-time CRM sync. Prefers the license key (rows owned by that key), then
// an email/password account, then the legacy shared key.
async function syncToCRM(row) {
  const prefs = await getPrefs();
  const url = `${crmBase(prefs)}/api/jobs`;
  const post = headers =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(row) });
  try {
    if (prefs.licenseKey) { await post({ 'x-license-key': prefs.licenseKey }); return; }
    let token = await getCrmToken();
    if (token) {
      const r = await post({ Authorization: `Bearer ${token}` });
      if (r.status === 401) {
        token = await getCrmToken(true); // session expired → fresh login
        if (token) await post({ Authorization: `Bearer ${token}` });
      }
    } else if (prefs.crmKey) {
      await post({ 'x-api-key': prefs.crmKey });
    }
  } catch { /* offline / misconfigured – local stats still work */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'GET_TAB_ID':
      // Lets content scripts learn their own tab id, so a run can be bound to
      // the one tab where the user pressed Start (no cross-tab auto-starts).
      sendResponse({ tabId: _sender.tab?.id ?? null });
      break;

    case 'OPEN_TAB':
      // Open a job in its OWN tab. Using the extension API (chrome.tabs.create)
      // bypasses the page's popup blocker, which silently blocks window.open from
      // a content script outside a user gesture. Used by the Naukri Gulf flow:
      // the list tab opens a job tab; that tab applies + closes itself; the list
      // tab then continues with the next job. Returns the new tab id.
      try {
        chrome.tabs.create({ url: msg.url, active: msg.active !== false }, tab => {
          void chrome.runtime.lastError;
          sendResponse({ tabId: tab?.id ?? null });
        });
      } catch { sendResponse({ tabId: null }); }
      return true;

    case 'CLOSE_TAB':
      // A finished apply popup asks to close itself (page scripts can't close
      // tabs they didn't open; the extension can). Also stamp a timestamp so the
      // original search tab can continue with the next job WITHOUT waiting for
      // focus to return — this is what lets a new-tab apply flow keep running
      // while the user is on a different tab.
      try { chrome.storage.local.set({ jobbot_apply_closed: Date.now() }); } catch {}
      if (_sender.tab?.id != null) chrome.tabs.remove(_sender.tab.id);
      break;

    case 'GET_CRM_TOKEN':
      // Content scripts use this for AI calls so requests run as the user
      getCrmToken().then(token => sendResponse({ token }));
      return true;

    case 'GET_LICENSE':
      // Content script asks before starting the agent — no licence, no run.
      // claim:true (from popup "Save & Activate") binds the key to this device.
      getLicense(msg.force, msg.claim).then(lic => sendResponse(lic));
      return true;

    case 'GET_UPDATE':
      // Popup asks for the last-known update status (fast, from storage).
      chrome.storage.local.get('jobbot_update', d => {
        void chrome.runtime.lastError;
        const cur = chrome.runtime.getManifest().version;
        sendResponse(d.jobbot_update || { current: cur, latest: cur, available: false });
      });
      return true;

    case 'CHECK_UPDATE':
      // Force a fresh check against the backend version.json.
      checkForUpdate().then(info => sendResponse(info)).catch(() => sendResponse({ available: false }));
      return true;

    case 'TELEMETRY':
      // Relay an anonymous field-health beacon from a content script.
      sendTelemetry(msg.event);
      break;

    case 'DO_UPDATE':
      // Start the update: open the new build's download (the zip is served with
      // Content-Disposition: attachment, so the browser downloads it). The popup
      // shows the short reload steps. We never uninstall or touch user data —
      // chrome.storage.local (profile, key, learned answers) is preserved because
      // the manifest "key" pins a stable extension id across the update.
      chrome.storage.local.get('jobbot_update', d => {
        void chrome.runtime.lastError;
        const url = (d.jobbot_update && d.jobbot_update.url) || `${DEFAULT_CRM}/jobbot-extension.zip`;
        try { chrome.tabs.create({ url }); } catch {}
        sendResponse({ ok: true, url });
      });
      return true;

    case 'NOTIFY':
      // Desktop notification so the user notices a captcha even on another tab.
      try {
        chrome.notifications?.create('jobbot-' + Date.now(), {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: msg.title || 'JobBot',
          message: msg.message || '',
          priority: 2,
        }, () => void chrome.runtime.lastError);
      } catch {}
      break;

    case 'GEMINI_ANSWER':
      // Each user's own Gemini key: the call runs here (background worker),
      // straight to Google, so the key stays on their machine and the usage is
      // billed to them — never to the app's shared account.
      geminiAnswer(msg.apiKey, msg.question, msg.options || [], msg.profile || {})
        .then(answer => sendResponse({ answer }))
        .catch(() => sendResponse({ answer: null }));
      return true;

    case 'GET_PROFILE':
      chrome.storage.local.get('jobbot_profile', d => {
        sendResponse({ profile: d.jobbot_profile || DEFAULT_PROFILE });
      });
      return true;

    case 'SAVE_PROFILE':
      chrome.storage.local.set({ jobbot_profile: msg.profile }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'GET_STATS':
      statsReady.then(() => sendResponse({ stats: { ...stats } }));
      return true;

    case 'JOB_APPLIED': {
      const plat = msg.platform;
      if (VALID_PLATFORMS.includes(plat)) stats[plat] = (stats[plat] || 0) + 1;
      persistStats();

      chrome.storage.local.get('jobbot_history', d => {
        const h = Array.isArray(d.jobbot_history) ? d.jobbot_history : [];
        h.unshift({ platform: plat, title: msg.title ?? '', url: msg.url ?? '', ts: Date.now() });
        chrome.storage.local.set({ jobbot_history: h.slice(0, 500) });
      });

      syncToCRM({ platform: plat, title: msg.title ?? '', url: msg.url ?? '', status: 'applied' });
      updateBadge();
      break;
    }

    case 'JOB_SKIPPED':
      stats.skipped = (stats.skipped || 0) + 1;
      persistStats();
      if (msg.title || msg.url) {
        syncToCRM({ platform: msg.platform, title: msg.title ?? '', url: msg.url ?? '', status: 'skipped' });
      }
      break;

    case 'GET_HISTORY':
      chrome.storage.local.get('jobbot_history', d => {
        sendResponse({ history: d.jobbot_history || [] });
      });
      return true;

    case 'CLEAR_HISTORY':
      chrome.storage.local.remove('jobbot_history', () => {
        VALID_PLATFORMS.forEach(k => { stats[k] = 0; });
        stats.skipped = 0;
        persistStats();
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      });
      return true;

    case 'RESET_STATS':
      VALID_PLATFORMS.forEach(k => { stats[k] = 0; });
      stats.skipped = 0;
      persistStats();
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
      break;
  }
});
