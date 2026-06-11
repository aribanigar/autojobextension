// background.js – JobBot service worker

const DEFAULT_PROFILE = {
  personal: { name: '', email: '', phone: '', location: '', postalCode: '', gender: '' },
  professional: {
    currentTitle: '', currentCompany: '', experience: '3',
    currentSalary: '', expectedSalary: '', noticePeriod: '30 days',
    skills: '', education: "Bachelor's Degree", languages: 'English, Hindi',
    coverLetter: ''
  },
  preferences: {
    workMode: 'hybrid', travelPercentage: '25',
    willingToRelocate: false, onlyEasyApply: true, workAuth: true
  }
};

const VALID_PLATFORMS = ['linkedin', 'indeed', 'naukri'];
const stats = { linkedin: 0, indeed: 0, naukri: 0, skipped: 0 };

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
  const total = stats.linkedin + stats.indeed + stats.naukri;
  chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

// ── CRM account session ──────────────────────────────────────────────────────
// Logs in with the email/password from preferences and caches the bearer
// token; rows synced with it are saved under that account and stay there.
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

// Real-time CRM sync under the user's account; falls back to the legacy
// shared key if no account is configured. Re-logs in once on 401.
async function syncToCRM(row) {
  const prefs = await getPrefs();
  if (!prefs.crmUrl) return;
  const url = `${prefs.crmUrl.replace(/\/+$/, '')}/api/jobs`;
  const post = headers =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(row) });
  try {
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

    case 'CLOSE_TAB':
      // A finished apply popup asks to close itself (page scripts can't close
      // tabs they didn't open; the extension can).
      if (_sender.tab?.id != null) chrome.tabs.remove(_sender.tab.id);
      break;

    case 'GET_CRM_TOKEN':
      // Content scripts use this for AI calls so requests run as the user
      getCrmToken().then(token => sendResponse({ token }));
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
