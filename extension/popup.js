// popup.js – JobBot v2 controller

document.addEventListener('DOMContentLoaded', async () => {

  // ── State ────────────────────────────────────────────────────────────────
  const DEFAULT_CRM = 'https://jobs.qckserve.in';   // defined up-front (used by the buy link)
  let running  = false;
  let platform = null;
  let statsTimer = null;
  let statusTimer = null;

  // ── In-app update checker ──────────────────────────────────────────────────
  // Shows an "Update available" banner when the backend advertises a newer build,
  // with a one-click download + reload steps. Fully self-contained and optional:
  // if messaging fails the banner just stays hidden and the popup works normally.
  (function initUpdateChecker() {
    const el = id => document.getElementById(id);
    const banner = el('update-banner');
    try { const v = el('app-ver'); if (v) v.textContent = 'v' + chrome.runtime.getManifest().version; } catch {}
    if (!banner) return;

    const ask = type => new Promise(res => {
      try { chrome.runtime.sendMessage({ type }, r => { void chrome.runtime.lastError; res(r || {}); }); }
      catch { res({}); }
    });

    const render = info => {
      if (!info || !info.available || !info.latest) { banner.style.display = 'none'; return; }
      let dismissed = '';
      try { dismissed = localStorage.getItem('jobbot_update_dismissed') || ''; } catch {}
      if (dismissed === info.latest) { banner.style.display = 'none'; return; }
      const vEl = el('update-ver'), nEl = el('update-notes');
      if (vEl) vEl.textContent = 'v' + info.latest;
      if (nEl) nEl.textContent = info.notes || '';
      const steps = el('update-steps'); if (steps) steps.style.display = 'none';
      banner._latest = info.latest;
      banner.style.display = 'block';
    };

    ask('GET_UPDATE').then(render);      // fast: last-known
    ask('CHECK_UPDATE').then(render);    // fresh: re-check now

    el('update-btn')?.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'DO_UPDATE' }, () => { void chrome.runtime.lastError; }); } catch {}
      const steps = el('update-steps'); if (steps) steps.style.display = 'block';
      const b = el('update-btn'); if (b) b.textContent = '⬇️ Downloading… follow the steps below';
    });
    el('update-x')?.addEventListener('click', () => {
      banner.style.display = 'none';
      try { if (banner._latest) localStorage.setItem('jobbot_update_dismissed', banner._latest); } catch {}
    });

    // Manual "Check for updates" link: force a fresh re-check and give feedback.
    const link = el('check-updates');
    link?.addEventListener('click', e => {
      e.preventDefault();
      const orig = link.textContent;
      link.textContent = 'Checking…';
      ask('CHECK_UPDATE').then(info => {
        if (info && info.available && info.latest) {
          try { localStorage.removeItem('jobbot_update_dismissed'); } catch {} // user explicitly asked, so re-show
          render(info);
          link.textContent = orig;
        } else {
          link.textContent = "You're up to date ✓";
          setTimeout(() => { link.textContent = orig; }, 2500);
        }
      });
    });
  })();

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
  else if (url.includes('naukrigulf.com'))    platform = 'naukrigulf'; // separate platform (check BEFORE naukri.com; 'naukrigulf.com' doesn't contain 'naukri.com')
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
    s('f-zip',      p.personal?.postalCode);
    s('f-gender',   p.personal?.gender);
    s('f-dob',         p.personal?.dateOfBirth);
    s('f-nationality', p.personal?.nationality);
    s('f-marital',     p.personal?.maritalStatus);
    s('f-linkedin',    p.personal?.linkedin);
    s('f-title',    p.professional?.currentTitle);
    s('f-company',  p.professional?.currentCompany);
    s('f-exp',      p.professional?.experience);
    s('f-currency', p.professional?.currency != null ? p.professional.currency : '₹');
    s('f-curr-sal', p.professional?.currentSalary);
    s('f-exp-sal',  p.professional?.expectedSalary);
    updateCurrencyHints();
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
    s('p-license',   p.preferences?.licenseKey);
    s('p-crm-url',   p.preferences?.crmUrl);
    s('p-crm-email', p.preferences?.crmEmail);
    s('p-crm-pass',  p.preferences?.crmPassword);
    s('p-gemini',    p.preferences?.geminiKey);
    c('p-ai',        p.preferences?.aiEnabled);
    c('p-humanpace', p.preferences?.humanPace);
    s('p-pace-daily', p.preferences?.paceDaily || 0);
    syncPaceDaily();
    updateBuyLink(p.preferences?.crmUrl);
  }

  // Show the daily-limit field only when Human pace is on.
  function syncPaceDaily() {
    const on = document.getElementById('p-humanpace')?.checked;
    const wrap = document.getElementById('p-pace-daily-wrap');
    if (wrap) wrap.style.display = on ? 'block' : 'none';
  }
  document.getElementById('p-humanpace')?.addEventListener('change', syncPaceDaily);

  // The subscription-plans (checkout) URL, from the configured backend or the
  // default. Never the extension itself.
  function checkoutUrl() {
    const url = (document.getElementById('p-crm-url')?.value || '').trim();
    const base = (url || DEFAULT_CRM).replace(/\/+$/, '');
    return `${base}/checkout.html`;
  }
  function updateBuyLink() {
    const a = document.getElementById('p-buy');
    if (a) a.href = checkoutUrl();
  }
  document.getElementById('p-crm-url')?.addEventListener('input', updateBuyLink);

  // Salary currency: reflect the chosen symbol in the two salary field labels.
  function updateCurrencyHints() {
    const cur = document.getElementById('f-currency')?.value ?? '₹';
    const txt = cur ? `(${cur})` : '';
    const a = document.getElementById('cur-sym-1'); if (a) a.textContent = txt;
    const b = document.getElementById('cur-sym-2'); if (b) b.textContent = txt;
  }
  document.getElementById('f-currency')?.addEventListener('change', updateCurrencyHints);

  // Bulletproof: open the plans page in a real browser tab on click. In a popup,
  // chrome.tabs.create reliably opens the checkout page (an <a> can fail if the
  // href wasn't set yet). This is what makes "Buy / manage plan" work.
  document.getElementById('p-buy')?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = checkoutUrl();
    try { chrome.tabs.create({ url }); } catch { window.open(url, '_blank'); }
  });

  // Save & Activate: persist the key (and everything), then verify activation.
  // Works for a license key OR an email/password account (the check tries the
  // key first, then falls back to the account).
  document.getElementById('p-activate')?.addEventListener('click', async () => {
    const note = document.getElementById('p-license-note');
    await persistProfile(readForm());               // save the key + all prefs
    if (note) { note.style.color = ''; note.textContent = 'Activating…'; }
    // claim:true — this explicit activation binds the key to THIS device (and
    // takes it over from any other device it was active on).
    const lic = await new Promise(res => {
      try { chrome.runtime.sendMessage({ type: 'GET_LICENSE', force: true, claim: true }, r => { void chrome.runtime.lastError; res(r || {}); }); }
      catch { res({}); }
    });
    if (!note) return;
    if (lic.active) {
      note.style.color = '#34d399';
      note.textContent = lic.expires_at
        ? `✓ Activated on this device — valid until ${new Date(lic.expires_at).toLocaleDateString()}`
        : '✓ Activated on this device — you can Start the agent now';
    } else {
      note.style.color = '#f87171';
      note.textContent =
        lic.reason === 'device'  ? 'This key is active on another device — activating here has logged that one out'
      : lic.reason === 'expired' ? 'This key has expired — ask the admin for a new one'
      : lic.reason === 'bad-key' ? 'Invalid or revoked key — check it and try again'
      : lic.reason === 'no-key'  ? 'Enter a license key above (or an email/password in Advanced)'
      : lic.reason === 'offline' ? 'Could not reach the server — check your connection'
      : 'Could not activate — check your key or account';
    }
  });

  // Live license-key check: paste a key → tells you if it's valid + expiry.
  const licNote = document.getElementById('p-license-note');
  let licTimer = null;
  document.getElementById('p-license')?.addEventListener('input', e => {
    const key = e.target.value.trim().toUpperCase();
    clearTimeout(licTimer);
    if (!key) { if (licNote) licNote.textContent = ''; return; }
    if (licNote) { licNote.style.color = ''; licNote.textContent = 'Checking…'; }
    licTimer = setTimeout(async () => {
      const base = ((document.getElementById('p-crm-url').value || '').trim() || DEFAULT_CRM).replace(/\/+$/, '');
      try {
        const r = await fetch(`${base}/api/license-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        const d = await r.json().catch(() => ({}));
        if (!licNote) return;
        if (r.ok && d.valid && d.active) {
          licNote.style.color = '#34d399';
          licNote.textContent = d.expires_at ? `✓ Valid — active until ${new Date(d.expires_at).toLocaleDateString()}` : '✓ Valid';
        } else {
          licNote.style.color = '#f87171';
          licNote.textContent = d.error || (d.valid ? 'Key expired' : 'Invalid key');
        }
      } catch { if (licNote) { licNote.style.color = '#f87171'; licNote.textContent = 'Could not verify (offline?)'; } }
    }, 600);
  });

  // Show/hide toggles for password-type fields
  document.querySelectorAll('.pw-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.target);
      if (el) el.type = el.type === 'password' ? 'text' : 'password';
    });
  });

  function readForm() {
    const v = id => document.getElementById(id)?.value?.trim() || '';
    const c = id => document.getElementById(id)?.checked ?? false;
    return {
      personal: {
        name:     v('f-name'),
        email:    v('f-email'),
        phone:    v('f-phone'),
        location: v('f-location'),
        postalCode: v('f-zip'),
        gender:   v('f-gender'),
        dateOfBirth:   v('f-dob'),
        nationality:   v('f-nationality'),
        maritalStatus: v('f-marital'),
        linkedin:      v('f-linkedin'),
      },
      professional: {
        currentTitle:   v('f-title'),
        currentCompany: v('f-company'),
        experience:     v('f-exp') || '3',
        currency:       document.getElementById('f-currency')?.value ?? '₹',
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
        licenseKey:        v('p-license').toUpperCase(),
        crmUrl:            v('p-crm-url').replace(/\/+$/, ''),
        crmEmail:          v('p-crm-email'),
        crmPassword:       v('p-crm-pass'),
        geminiKey:         v('p-gemini'),
        aiEnabled:         c('p-ai'),
        humanPace:         c('p-humanpace'),
        paceDaily:         Math.max(0, Math.min(1000, parseInt(v('p-pace-daily'), 10) || 0)),
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
      bump('s-nk', (res.stats.naukri || 0) + (res.stats.naukrigulf || 0)); // Naukri + Naukri Gulf combined (tracked separately in the backend)
      bump('s-by', res.stats.bayt     || 0);
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
