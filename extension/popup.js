// popup.js – JobBot v2 controller

document.addEventListener('DOMContentLoaded', async () => {

  // ── State ────────────────────────────────────────────────────────────────
  let running  = false;
  let platform = null;
  let statsTimer = null;
  let statusTimer = null;

  // ── Tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
      if (btn.dataset.tab === 'history') loadHistory();
    });
  });

  // ── Active tab detection ─────────────────────────────────────────────────
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;
  } catch { /* permission denied */ }

  const url = activeTab?.url || '';
  if      (url.includes('linkedin.com/jobs')) platform = 'linkedin';
  else if (url.includes('indeed.com') || url.includes('apply.indeed.com')) platform = 'indeed';
  else if (url.includes('naukri.com'))        platform = 'naukri';

  const pill = document.getElementById('platform-pill');
  if (platform && pill) {
    pill.textContent = platform.charAt(0).toUpperCase() + platform.slice(1);
    pill.className   = `pill pill--${platform}`;
  } else {
    setStatus('Open LinkedIn Jobs, Indeed, or Naukri first', 'warn');
  }

  // ── Load profile ──────────────────────────────────────────────────────────
  const profile = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, r => res(r?.profile || {}))
  );
  applyToForm(profile);

  function applyToForm(p) {
    const s = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
    const c = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

    s('f-name',     p.personal?.name);
    s('f-email',    p.personal?.email);
    s('f-phone',    p.personal?.phone);
    s('f-location', p.personal?.location);
    s('f-gender',   p.personal?.gender);
    s('f-title',    p.professional?.currentTitle);
    s('f-company',  p.professional?.currentCompany);
    s('f-exp',      p.professional?.experience);
    s('f-curr-sal', p.professional?.currentSalary);
    s('f-exp-sal',  p.professional?.expectedSalary);
    s('f-notice',   p.professional?.noticePeriod);
    s('f-edu',      p.professional?.education);
    s('f-skills',   p.professional?.skills);
    s('f-langs',    p.professional?.languages);
    s('f-cover',    p.professional?.coverLetter);
    s('p-mode',     p.preferences?.workMode);
    s('p-travel',   p.preferences?.travelPercentage);
    c('p-relocate', p.preferences?.willingToRelocate);
    c('p-easyonly', p.preferences?.onlyEasyApply !== false);
    c('p-auth',     p.preferences?.workAuth !== false);
    s('p-crm-url',  p.preferences?.crmUrl);
    s('p-crm-key',  p.preferences?.crmKey);
    c('p-ai',       p.preferences?.aiEnabled);
  }

  function readForm() {
    const v = id => document.getElementById(id)?.value?.trim() || '';
    const c = id => document.getElementById(id)?.checked ?? false;
    return {
      personal: {
        name:     v('f-name'),
        email:    v('f-email'),
        phone:    v('f-phone'),
        location: v('f-location'),
        gender:   v('f-gender'),
      },
      professional: {
        currentTitle:   v('f-title'),
        currentCompany: v('f-company'),
        experience:     v('f-exp') || '3',
        currentSalary:  v('f-curr-sal'),
        expectedSalary: v('f-exp-sal'),
        noticePeriod:   v('f-notice') || '30 days',
        education:      v('f-edu'),
        skills:         v('f-skills'),
        languages:      v('f-langs') || 'English, Hindi',
        coverLetter:    v('f-cover'),
      },
      preferences: {
        workMode:          v('p-mode') || 'hybrid',
        travelPercentage:  v('p-travel') || '25',
        willingToRelocate: c('p-relocate'),
        onlyEasyApply:     c('p-easyonly'),
        workAuth:          c('p-auth'),
        crmUrl:            v('p-crm-url').replace(/\/+$/, ''),
        crmKey:            v('p-crm-key'),
        aiEnabled:         c('p-ai'),
      },
    };
  }

  async function persistProfile(p) {
    return new Promise(res =>
      chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: p }, () => res(true))
    );
  }

  // ── Save buttons ──────────────────────────────────────────────────────────
  function flash(okId) {
    const el = document.getElementById(okId);
    if (!el) return;
    el.style.display = 'inline-block';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 2500);
  }

  document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
    await persistProfile(readForm());
    flash('ok-profile');
  });

  document.getElementById('btn-save-prefs')?.addEventListener('click', async () => {
    await persistProfile(readForm());
    flash('ok-prefs');
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function refreshStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, res => {
      if (!res?.stats) return;
      bump('s-li', res.stats.linkedin || 0);
      bump('s-in', res.stats.indeed   || 0);
      bump('s-nk', res.stats.naukri   || 0);
      bump('s-sk', res.stats.skipped  || 0);
    });
  }

  function bump(id, newVal) {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = parseInt(el.textContent) || 0;
    if (cur === newVal) return;
    el.textContent = newVal;
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 350);
  }

  refreshStats();
  statsTimer = setInterval(refreshStats, 2500);

  // ── Poll agent status ─────────────────────────────────────────────────────
  async function pollStatus() {
    if (!activeTab?.id) return;
    try {
      const res = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_STATUS' });
      if (res?.running !== running) setRunning(res.running);
    } catch { /* content script not injected yet */ }
  }

  await pollStatus();
  statusTimer = setInterval(pollStatus, 2200);

  // ── Start / Stop ──────────────────────────────────────────────────────────
  document.getElementById('btn-start')?.addEventListener('click', async () => {
    if (!platform) {
      setStatus('Go to LinkedIn Jobs, Indeed, or Naukri first', 'err');
      return;
    }
    if (!activeTab?.id) {
      setStatus('Cannot access this tab', 'err');
      return;
    }

    const p = readForm();
    await persistProfile(p);

    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_AGENT', profile: p });
    } catch {
      // Content script not loaded – inject it
      try {
        await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 400)); // wait for script to init
        await chrome.tabs.sendMessage(activeTab.id, { type: 'START_AGENT', profile: p });
      } catch {
        setStatus('Failed to start — try reloading the job page', 'err');
        return;
      }
    }

    setRunning(true);
  });

  document.getElementById('btn-stop')?.addEventListener('click', async () => {
    if (activeTab?.id) {
      try {
        await chrome.tabs.sendMessage(activeTab.id, { type: 'STOP_AGENT' });
      } catch { /* ignore */ }
    }
    setRunning(false);
  });

  function setRunning(state) {
    running = state;

    const startBtn  = document.getElementById('btn-start');
    const stopBtn   = document.getElementById('btn-stop');
    const runPill   = document.getElementById('run-pill');
    const logoIcon  = document.getElementById('logo-icon');

    if (startBtn) startBtn.style.display = state ? 'none' : '';
    if (stopBtn)  stopBtn.style.display  = state ? ''     : 'none';
    if (runPill)  runPill.style.display  = state ? 'flex' : 'none';
    if (logoIcon) logoIcon.classList.toggle('rocking', state);

    if (state) {
      setStatus(`Agent running on ${platform}…`, 'run');
    } else {
      setStatus('Agent stopped', 'warn');
    }
  }

  function setStatus(msg, type = '') {
    const el = document.getElementById('status-txt');
    if (!el) return;
    el.textContent = msg;
    el.className = `status-txt${type ? ' s-' + type : ''}`;
  }

  // ── History ───────────────────────────────────────────────────────────────
  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, res => {
      const items = res?.history || [];
      const list  = document.getElementById('hist-list');
      const total = document.getElementById('hist-total');
      if (!list) return;

      if (total) total.textContent = items.length;

      if (!items.length) {
        list.innerHTML = `
          <div class="empty">
            <span class="empty-ico">📭</span>
            <span class="empty-title">No applications yet</span>
            <span class="empty-sub">Start the agent on LinkedIn, Indeed or Naukri</span>
          </div>`;
        return;
      }

      list.innerHTML = items.map(item => {
        const d    = new Date(item.ts || Date.now());
        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const plat = String(item.platform || '').toLowerCase();
        return `
          <div class="hist-item">
            <span class="hist-plat p-${plat}">${plat}</span>
            <span class="hist-title">${htmlEsc(item.title || 'Applied')}</span>
            <span class="hist-time">${date} ${time}</span>
          </div>`;
      }).join('');
    });
  }

  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Clear all application history and reset stats?')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
        refreshStats();
        loadHistory();
      });
    }
  });

  function htmlEsc(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // Cleanup on popup close
  window.addEventListener('unload', () => {
    clearInterval(statsTimer);
    clearInterval(statusTimer);
  });

});
