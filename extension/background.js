// background.js – JobBot service worker

const DEFAULT_PROFILE = {
  personal: { name: '', email: '', phone: '', location: '', gender: '' },
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

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
      sendResponse({ stats: { ...stats } });
      break;

    case 'JOB_APPLIED': {
      const plat = msg.platform;
      if (VALID_PLATFORMS.includes(plat)) stats[plat] = (stats[plat] || 0) + 1;

      chrome.storage.local.get('jobbot_history', d => {
        const h = Array.isArray(d.jobbot_history) ? d.jobbot_history : [];
        h.unshift({ platform: plat, title: msg.title ?? '', url: msg.url ?? '', ts: Date.now() });
        chrome.storage.local.set({ jobbot_history: h.slice(0, 500) });
      });

      const total = stats.linkedin + stats.indeed + stats.naukri;
      chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
      break;
    }

    case 'JOB_SKIPPED':
      stats.skipped = (stats.skipped || 0) + 1;
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
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      });
      return true;

    case 'RESET_STATS':
      VALID_PLATFORMS.forEach(k => { stats[k] = 0; });
      stats.skipped = 0;
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
      break;
  }
});
