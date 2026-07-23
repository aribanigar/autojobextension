// content.js – JobBot Auto Apply Agent v2
// LinkedIn Easy Apply · Indeed Apply · Naukri Apply

(function () {
  'use strict';
  if (window.__jobBotAutoApplyInstalled_v2) return;
  window.__jobBotAutoApplyInstalled_v2 = true;

  // ─── Platform ─────────────────────────────────────────────────────────────
  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes('linkedin.com')) return 'linkedin';
    if (h.includes('indeed.com') || h.includes('apply.indeed.com')) return 'indeed';
    // Naukri Gulf is its OWN platform — kept SEPARATE from naukri.com. It reuses
    // the NaukriAgent engine, but all naukrigulf behaviour is hostname-gated, so
    // naukri.com is completely unaffected. Checked before naukri.com because
    // 'naukrigulf.com' does not contain the substring 'naukri.com'.
    if (h.includes('naukrigulf.com')) return 'naukrigulf';
    if (h.includes('naukri.com')) return 'naukri';
    if (h.includes('bayt.com'))   return 'bayt';
    return null;
  })();
  if (!PLATFORM) return;

  // ─── Utilities ────────────────────────────────────────────────────────────
  const sleep    = ms => new Promise(r => setTimeout(r, ms));
  const rand     = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

  // ── Telemetry (anonymous field-health beacons) ──────────────────────────────
  // Fire-and-forget reports of selector misses / agent errors / captchas so the
  // owner can SEE when a job site changes its DOM or an integration breaks. It
  // NEVER blocks, NEVER throws, and dedupes to ≤1 per key per minute. Sent via the
  // background worker (a content script can't cross-origin POST). No PII: an
  // anonymous per-install id, version, platform, an event type + short detail, and
  // the page hostname. If anything at all fails it's a silent no-op — it can't
  // affect the agent or any integration.
  const Telemetry = (() => {
    let anon = '';
    try {
      chrome.storage.local.get('jobbot_anon', d => {
        void chrome.runtime.lastError;
        anon = (d && d.jobbot_anon) || '';
        if (!anon) {
          try { anon = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36); } catch { anon = 'a' + Date.now(); }
          try { chrome.storage.local.set({ jobbot_anon: anon }); } catch {}
        }
      });
    } catch {}
    const seen = new Map();
    return {
      send(type, detail) {
        try {
          const key = type + '|' + (detail || '');
          const now = Date.now();
          if (seen.get(key) && now - seen.get(key) < 60000) return;   // ≤1/min per key
          seen.set(key, now);
          let ver = ''; try { ver = chrome.runtime.getManifest().version; } catch {}
          chrome.runtime.sendMessage({
            type: 'TELEMETRY',
            event: {
              anon_id: anon, version: ver, platform: PLATFORM || null,
              type: String(type).slice(0, 40),
              detail: detail ? String(detail).slice(0, 200) : null,
              host: location.hostname,
            },
          }, () => void chrome.runtime.lastError);
        } catch {}
      },
    };
  })();

  // Report uncaught errors that originate from OUR content script (never the host
  // page's own JS). Passive — cannot affect page behaviour.
  try {
    window.addEventListener('error', e => {
      try {
        const f = e.filename || '';
        if (!/content\.js|chrome-extension:/i.test(f)) return;
        Telemetry.send('js_error', (e.message || 'error') + ' @' + f.split('/').pop() + ':' + (e.lineno || 0));
      } catch {}
    }, true);
    window.addEventListener('unhandledrejection', e => {
      try {
        const r = e && e.reason;
        const stack = r && r.stack || '';
        if (!/content\.js|chrome-extension:/i.test(stack)) return;   // only ours
        Telemetry.send('js_error', 'promise: ' + ((r && (r.message || r)) || '').toString().slice(0, 160));
      } catch {}
    }, true);
  } catch {}

  // Compute age (whole years) from a date-of-birth string in common formats:
  // "1998-05-20", "20/05/1998", "20-05-1998", "May 20 1998", "20 May 1998".
  // Returns null if it can't be parsed sensibly.
  function ageFromDob(dob) {
    if (!dob) return null;
    const s = String(dob).trim();
    let d = null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);         // YYYY-MM-DD
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (!d) { m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);    // DD-MM-YYYY
      if (m) d = new Date(+m[3], +m[2] - 1, +m[1]); }
    if (!d) { const p = Date.parse(s); if (!isNaN(p)) d = new Date(p); } // fallback (named months)
    if (!d || isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const md = now.getMonth() - d.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < d.getDate())) age--;
    return (age > 0 && age < 100) ? age : null;
  }
  const $        = (sel, root = document) => root ? root.querySelector(sel) : null;
  const $$       = (sel, root = document) => root ? [...root.querySelectorAll(sel)] : [];
  const isVis    = el => !!el && !el.disabled && el.offsetWidth > 0 && el.offsetHeight > 0
                         && getComputedStyle(el).visibility !== 'hidden'
                         && getComputedStyle(el).display !== 'none';

  function waitFor(sel, root = document, ms = 8000) {
    return new Promise((res, rej) => {
      const found = $(sel, root);
      if (found) return res(found);
      const obs = new MutationObserver(() => {
        const el = $(sel, root);
        if (el) { obs.disconnect(); res(el); }
      });
      const tgt = root instanceof Document ? root.body : root;
      if (tgt) obs.observe(tgt, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); rej(new Error('waitFor timeout: ' + sel)); }, ms);
    });
  }

  // React-compatible input setter
  async function typeInto(el, text) {
    if (!el || text == null || text === '') return;
    el.focus();
    await sleep(rand(40, 100));
    // Use native setter to trigger React synthetic events
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.value = '';
    }
    await sleep(rand(30, 80));
    for (const ch of String(text)) {
      if (setter) setter.call(el, el.value + ch);
      else el.value += ch;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // Human rhythm: mostly quick keystrokes, with the occasional brief pause
      // like a person thinking mid-answer — smoother than a constant machine rate.
      await sleep(Math.random() < 0.08 ? rand(180, 420) : rand(22, 70));
    }
    await sleep(rand(150, 350)); // brief settle/read before committing the answer
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  // Glide the (synthetic) cursor toward an element so movement isn't teleport-like.
  // Indeed/reCAPTCHA score mouse activity; a few mousemove events before a click
  // read more like a person than an instant click at dead-center.
  let _mx = Math.random() * window.innerWidth, _my = Math.random() * window.innerHeight;
  let _moving = false; // true while a moveTo glide is running (ambient drift yields to it)
  const _clampX = v => Math.max(0, Math.min(innerWidth - 1, v));
  const _clampY = v => Math.max(0, Math.min(innerHeight - 1, v));

  // ── Post-captcha trust-rebuild cool-down (Indeed anti-detection) ───────────
  // Cloudflare Turnstile scores the WHOLE session. After a challenge is solved,
  // trust is low — resuming at full speed re-triggers it right away, which is the
  // "captcha again and again" loop the user hit at the submit step. So after every
  // captcha CLEAR we enter a cool-down: clicks slow down and add extra lifelike
  // activity, and repeated challenges ESCALATE the back-off (longer + more motion)
  // until Indeed stops challenging. Purely additive dwell/motion — it never changes
  // WHAT is clicked or the flow, so the locked Indeed logic is unaffected.
  let _captchaCooldownUntil = 0;   // Date.now() until which we're in slow mode
  let _captchaHits = 0;            // consecutive challenges → escalate the back-off
  let _lastCaptchaClearedAt = 0;
  const inCaptchaCooldown = () => Date.now() < _captchaCooldownUntil;
  const captchaBackoffMs = () => 22000 + Math.min(_captchaHits, 6) * 14000; // ~22s → ~106s
  const noteCaptchaCleared = () => {
    _captchaHits = Math.min(_captchaHits + 1, 6);
    _lastCaptchaClearedAt = Date.now();
    _captchaCooldownUntil = Date.now() + captchaBackoffMs();
  };
  // Decay the escalation once a long quiet stretch passes with no new challenge,
  // so a clean later session isn't stuck crawling.
  const decayCaptchaBackoff = () => {
    if (_captchaHits > 0 && !inCaptchaCooldown() && Date.now() - _lastCaptchaClearedAt > 240000) _captchaHits = 0;
  };
  const _emitMove = (ex, ey) => {
    const tgt = document.elementFromPoint(_clampX(ex), _clampY(ey));
    (tgt || document.body)?.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view: window, clientX: ex, clientY: ey,
    }));
  };
  // Indeed: richer emit — pointermove + mousemove with movementX/Y deltas, which
  // is closer to what a real device produces and what behavioural scorers read.
  const _emitRich = (ex, ey) => {
    const cx = _clampX(ex), cy = _clampY(ey);
    const dx = cx - _mx, dy = cy - _my;
    const tgt = document.elementFromPoint(cx, cy) || document.body;
    const o = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy,
                screenX: cx, screenY: cy, movementX: dx, movementY: dy };
    try { tgt.dispatchEvent(new PointerEvent('pointermove', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0 })); } catch {}
    tgt.dispatchEvent(new MouseEvent('mousemove', o));
    _mx = cx; _my = cy;
  };
  // smootherstep — natural acceleration then deceleration (Ken Perlin)
  const _smoother = t => t * t * t * (t * (t * 6 - 15) + 10);

  async function moveTo(x, y) {
    // LinkedIn / Naukri / Bayt: ORIGINAL behaviour, unchanged.
    if (PLATFORM !== 'indeed') {
      const steps = rand(5, 11);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ex = _mx + (x - _mx) * t + (Math.random() - 0.5) * 6;
        const ey = _my + (y - _my) * t + (Math.random() - 0.5) * 6;
        _emitMove(ex, ey);
        await sleep(rand(8, 22));
      }
      _mx = x; _my = y;
      return;
    }

    // ── INDEED ONLY — professional human-motion model ────────────────────────
    // Cloudflare Turnstile scores mouse dynamics, so we mimic a real hand:
    //   • cubic Bézier path (two control points → gentle S-curve, never straight)
    //   • smootherstep velocity (accelerate out, decelerate in)
    //   • low-frequency tremor (two sine waves + tiny random walk, NOT white noise)
    //   • occasional mid-flight hesitation pause
    //   • overshoot then settle onto the target
    //   • pointermove + mousemove with real movement deltas
    // No apply logic touched — this only changes how the cursor travels.
    _moving = true;
    try {
      const sx = _mx, sy = _my;
      const dist = Math.hypot(x - sx, y - sy) || 1;
      const steps = Math.max(18, Math.min(55, Math.round(dist / rand(7, 12))));
      // two control points, offset perpendicular-ish for a natural arc
      const nx = -(y - sy) / dist, ny = (x - sx) / dist; // unit normal
      const bow1 = (Math.random() - 0.5) * Math.min(160, dist * 0.5 + 40);
      const bow2 = (Math.random() - 0.5) * Math.min(120, dist * 0.35 + 30);
      const c1x = sx + (x - sx) * 0.32 + nx * bow1, c1y = sy + (y - sy) * 0.32 + ny * bow1;
      const c2x = sx + (x - sx) * 0.68 + nx * bow2, c2y = sy + (y - sy) * 0.68 + ny * bow2;
      // tremor params (per-move so it varies)
      const trAmp = 0.6 + Math.random() * 1.6, trF1 = 3 + Math.random() * 5, trF2 = 7 + Math.random() * 9;
      const trP1 = Math.random() * 6.28, trP2 = Math.random() * 6.28;
      let walkX = 0, walkY = 0;
      const hesitateAt = Math.random() < 0.22 ? Math.floor(steps * (0.3 + Math.random() * 0.4)) : -1;
      for (let i = 1; i <= steps; i++) {
        const t = _smoother(i / steps);
        const u = 1 - t;
        // cubic Bézier
        let ex = u*u*u*sx + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*x;
        let ey = u*u*u*sy + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*y;
        // hand tremor (fades near the target so we land cleanly)
        const fade = Math.sin(Math.PI * (i / steps));
        walkX += (Math.random() - 0.5) * 0.7; walkX *= 0.85;
        walkY += (Math.random() - 0.5) * 0.7; walkY *= 0.85;
        ex += (Math.sin(t * trF1 * 6.28 + trP1) * trAmp + walkX) * fade;
        ey += (Math.sin(t * trF2 * 6.28 + trP2) * trAmp + walkY) * fade;
        _emitRich(ex, ey);
        // velocity: fast in the middle, slow at the ends
        let dwell = rand(7, 20) * (0.5 + Math.abs(0.5 - (i / steps)) * 1.3);
        if (i === hesitateAt) dwell += rand(80, 220); // brief human hesitation
        await sleep(dwell);
      }
      // overshoot then settle (humans rarely stop dead on target)
      if (Math.random() < 0.6) {
        const os = 4 + Math.random() * 10, ang = Math.random() * 6.28;
        _emitRich(x + Math.cos(ang) * os, y + Math.sin(ang) * os);
        await sleep(rand(30, 90));
        _emitRich(x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3);
        await sleep(rand(20, 60));
      }
      _emitRich(x, y);
      _mx = x; _my = y;
    } finally { _moving = false; }
  }

  // Full pointer/mouse event sequence – React buttons (Indeed) often ignore bare .click()
  // Sequence: establish hover state first, then press/release, then a coordinate-bearing
  // click event. el.click() fires with clientX=0/clientY=0 which Indeed's anti-bot checks
  // can detect; dispatchEvent(new MouseEvent('click', …)) carries real coordinates.
  function realClick(el) {
    // A detached node can't receive a real click (the event never reaches the
    // page's delegated React handlers), and dispatching one on a submit button
    // whose form has detached just logs "Form submission canceled because the
    // form is not connected". Bail — callers' retry loops re-find the live node.
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width * (0.35 + Math.random() * 0.3);
    const cy = r.top + r.height * (0.35 + Math.random() * 0.3);
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    const ptr  = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    // Establish hover state before the click sequence
    el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover',  base));
    el.dispatchEvent(new MouseEvent('mousemove',  base));
    el.dispatchEvent(new PointerEvent('pointerdown', ptr));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup',   ptr));
    el.dispatchEvent(new MouseEvent('mouseup',   base));
    // Coordinate-bearing click so React / anti-bot checks see non-zero clientX/Y.
    // The press/release can trigger a re-render that detaches the element; only
    // click if it's still connected (avoids the "form is not connected" warning).
    if (el.isConnected) el.dispatchEvent(new MouseEvent('click', base));
  }

  // ── Human pace (ToS-safe anti-captcha rate limiter) ─────────────────────────
  // Volume/burst is the #1 trigger for reCAPTCHA Enterprise & other bot checks.
  // When the user turns on "Human pace", we SPACE APPLICATIONS OUT: a randomized
  // wait before each new application starts, an occasional longer break, and an
  // optional daily cap. State lives in chrome.storage so pacing survives the page
  // navigations between jobs. DISABLED by default → behaviour is byte-identical
  // until the user opts in. It never solves or touches a captcha — it only makes
  // the agent apply at a human rhythm so the grid rarely appears.
  const Pacer = {
    on: false, gapLo: 20000, gapHi: 45000, breakEvery: 8, breakLo: 90000, breakHi: 180000, daily: 0,
    configure(prefs) {
      const p = prefs || {};
      this.on = !!p.humanPace;
      this.daily = Math.max(0, Math.min(1000, parseInt(p.paceDaily, 10) || 0));
    },
    enabled() { return this.on; },
    _get(keys) { return new Promise(res => { try { chrome.storage.local.get(keys, d => { void chrome.runtime.lastError; res(d || {}); }); } catch { res({}); } }); },
    _set(obj) { try { chrome.storage.local.set(obj, () => void chrome.runtime.lastError); } catch {} },
    async _wait(ms, note) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (agent && agent.running === false) return;  // Stop pressed → bail immediately
        if (note) SPOT.status(`${note} ${Math.ceil((end - Date.now()) / 1000)}s… (✕ to stop)`, 'info');
        await sleep(Math.min(1000, end - Date.now()));
      }
    },
    // Called once per application START. Returns false if the daily cap stopped the run.
    async gate() {
      if (!this.on) return true;
      const st = await this._get(['jobbot_pace_last', 'jobbot_pace_since', 'jobbot_pace_day']);
      // Daily cap → stop the run for the day.
      if (this.daily > 0) {
        const today = new Date().toISOString().slice(0, 10);
        let day = st.jobbot_pace_day;
        if (!day || day.d !== today) day = { d: today, n: 0 };
        if (day.n >= this.daily) {
          SPOT.status(`🛑 Daily limit of ${this.daily} reached — pausing until tomorrow (✕ to stop).`, 'info');
          try { if (agent) agent.running = false; } catch {}
          this._set({ jobbot_running: false });
          return false;
        }
        this._set({ jobbot_pace_day: { d: today, n: day.n + 1 } });
      }
      // Inter-application wait since the previous application started.
      const gap = rand(this.gapLo, this.gapHi);
      const waitMs = (st.jobbot_pace_last || 0) + gap - Date.now();
      if (waitMs > 0) await this._wait(waitMs, '⏳ Human pace — next application in');
      if (agent && agent.running === false) return false;
      this._set({ jobbot_pace_last: Date.now() });
      // Occasional longer break.
      let since = (st.jobbot_pace_since || 0) + 1;
      if (this.breakEvery > 0 && since >= this.breakEvery) { since = 0; await this._wait(rand(this.breakLo, this.breakHi), '☕ Short break to stay human —'); }
      this._set({ jobbot_pace_since: since });
      return !(agent && agent.running === false);
    },
  };

  // Is this the button that STARTS a new application (not a mid-flow Continue/
  // Submit)? Used to place the pace wait before a fresh application begins.
  function isApplyStartBtn(el) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 24) return false;
    if (/continue|submit|next|review|save|sign\s*in|log\s*in|company|external/i.test(t)) return false;
    return /^easy\s*apply$|^apply$|^apply now$|apply with indeed|^easily apply$/i.test(t);
  }

  async function humanClick(el, msg = '') {
    if (!isVis(el)) return false;
    await yieldToLeadsLoft(); // don't fight if LeadsLoft is mid-action
    if (!isVis(el)) return false;
    // Human pace: space out APPLICATION STARTS. Gated to Indeed/LinkedIn here
    // (they have no per-job timer, so a pause can't trip a skip); Naukri/Bayt are
    // paced in their own run loops before their job timer arms. No-op when the
    // toggle is off, so every other click is unchanged.
    if (Pacer.enabled() && (PLATFORM === 'indeed' || PLATFORM === 'linkedin') && isApplyStartBtn(el)) {
      const ok = await Pacer.gate();
      if (!ok) return false;   // daily cap stopped the run → don't click
      if (!isVis(el)) return false;
    }
    if (msg) SPOT.pulse(el, msg);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(250, 500));
    // Post-captcha trust-rebuild (Indeed only): before touching the next
    // protected control, move slower and drift the cursor so the behavioural
    // score recovers. No-op unless we're inside a cool-down, so every other
    // click on every platform is byte-for-byte the same as before.
    const cooling = PLATFORM === 'indeed' && inCaptchaCooldown();
    if (cooling) {
      await sleep(rand(600, 1500));
      try {
        await moveTo(_clampX(_mx + (Math.random() - 0.5) * rand(140, 380)),
                     _clampY(_my + (Math.random() - 0.5) * rand(100, 280)));
        await sleep(rand(300, 800));
      } catch {}
    }
    const r = el.getBoundingClientRect();
    await moveTo(r.left + r.width / 2, r.top + r.height / 2);
    await sleep(rand(80, 200) + (cooling ? rand(400, 900) : 0));
    realClick(el);
    await sleep(rand(350, 700) + (cooling ? rand(500, 1100) : 0));
    return true;
  }

  // Pre-submit "human review" (INDEED ONLY). Cloudflare Turnstile almost always
  // fires at the FINAL submit, where it scores the interaction that led up to
  // that protected action. Before clicking Submit we spend a human-variable
  // moment: drift the cursor around the form and do a small read-scroll, so the
  // behavioural score reads like a person reviewing their application rather
  // than an instant, low-activity bot submit. Purely additive — it does NOT
  // change which button is clicked or how; it only adds lifelike activity and
  // dwell right before the existing submit click. No-op on other platforms.
  async function indeedPreSubmit() {
    if (PLATFORM !== 'indeed') return;
    try {
      const wander = async () => {
        const tx = _clampX(_mx + (Math.random() - 0.5) * rand(140, 460));
        const ty = _clampY(_my + (Math.random() - 0.5) * rand(100, 340));
        await moveTo(tx, ty);
      };
      // A person reviewing their application before submitting: read-scroll,
      // pause, drift, and hover over the actual form controls (Turnstile scores
      // continuous, near-content pointer activity + dwell time, not just empty
      // space). Longer, more varied dwell than a bot's instant submit.
      await sleep(rand(600, 1400));
      await wander();
      await sleep(rand(400, 1000));
      try { window.scrollBy(0, rand(80, 220)); } catch {}   // glance down the summary
      await sleep(rand(700, 1600));                          // reading pause
      await wander();
      try { window.scrollBy(0, -rand(50, 160)); } catch {}  // back up toward Submit
      await sleep(rand(500, 1300));
      // Hover a real form control so there's lifelike pointer activity over the
      // application (moveTo only emits mousemove — it never clicks anything).
      try {
        const fields = $$('input:not([type="hidden"]), textarea, select, button, [role="button"]')
          .filter(el => isVis(el)).slice(0, 10);
        if (fields.length) {
          const f = fields[rand(0, fields.length)];
          const r = f.getBoundingClientRect();
          if (r.width && r.height) {
            await moveTo(r.left + r.width * (0.3 + Math.random() * 0.4), r.top + r.height / 2);
            await sleep(rand(300, 900));
          }
        }
      } catch {}
      if (Math.random() < 0.8) { await wander(); await sleep(rand(400, 1200)); }
      // Recently challenged → spend noticeably longer reviewing before this
      // protected submit. A rushed submit right after a captcha is the classic
      // re-challenge trigger, so linger, read-scroll and interact more.
      if (inCaptchaCooldown()) {
        for (let k = 0, n = rand(2, 4); k < n; k++) { await wander(); await sleep(rand(500, 1400)); }
        try { window.scrollBy(0, rand(60, 180)); } catch {}
        await sleep(rand(700, 1600));
        try { window.scrollBy(0, -rand(40, 120)); } catch {}
        await sleep(rand(600, 1500));
      }
      await sleep(rand(500, 1400)); // final settle before the submit click
    } catch {}
  }

  // ─── LeadsLoft / other-extension coexistence ─────────────────────────────
  // Both extensions inject into the same pages. The two risks:
  //   1) LeadsLoft locks the pointer on the same element JobBot is about to
  //      click → one of them wins, the other retries anyway so no harm done.
  //   2) LeadsLoft deletes our overlay nodes → we just rebuild them next tick.
  // We guard against (2) by detecting when our bar/box nodes are gone and
  // re-injecting. There is nothing we can do about (1) except use human-like
  // delays so the two bots rarely collide. We expose a window flag so
  // LeadsLoft can check if JobBot is mid-run and yield accordingly (the
  // mirror flag LL_ACTIVE lets us yield to LeadsLoft).
  Object.defineProperty(window, '__jobbotRunning', {
    get: () => !!(typeof agent !== 'undefined' && agent?.running),
    configurable: true,
  });

  // If LeadsLoft is doing something right now, yield for up to 10 s
  async function yieldToLeadsLoft() {
    for (let i = 0; i < 20; i++) {
      const llBusy = window.__ll_active || window.__leadsLoftRunning
                  || window.__llRunning  || window.LeadsLoftActive;
      if (!llBusy) return;
      await sleep(500);
    }
  }


  // Safe messaging – never let a dead service worker / reloaded extension kill the run loop
  function report(payload) {
    try {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    } catch { /* extension context invalidated – keep the agent running */ }
  }
  function reportSkip() {
    report({ type: 'JOB_SKIPPED', platform: PLATFORM, title: document.title, url: location.href });
  }

  // Job lists render late on slow pages – retry before declaring the page empty
  async function waitForCards(fn, tries = 6, delay = 1500) {
    for (let i = 0; i < tries; i++) {
      const cards = fn();
      if (cards.length) return cards;
      await sleep(delay);
    }
    return [];
  }

  // ─── Spotlight ────────────────────────────────────────────────────────────
  const SPOT = (() => {
    let bar = null, box = null;

    function init() {
      if (bar || !document.body) return;

      if (!document.getElementById('jobbotx-style')) {
        const s = document.createElement('style');
        s.id = 'jobbotx-style';
        s.textContent = `
          #jobbotx-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;
            display:none;align-items:center;gap:10px;padding:10px 18px;
            font:600 13px/1 system-ui,-apple-system,sans-serif;
            box-shadow:0 3px 20px rgba(0,0,0,.4);transition:background .25s;}
          #jobbotx-bar .jd{width:8px;height:8px;border-radius:50%;background:#fff;
            animation:jobbotx-bl 1.1s ease-in-out infinite;}
          #jobbotx-bar .jx{margin-left:auto;cursor:pointer;opacity:.7;font-size:17px;
            background:none;border:none;color:inherit;line-height:1;padding:0;}
          #jobbotx-box{position:fixed;z-index:2147483646;pointer-events:none;
            border-radius:8px;display:none;
            transition:top .28s cubic-bezier(.4,0,.2,1),left .28s cubic-bezier(.4,0,.2,1),
              width .28s cubic-bezier(.4,0,.2,1),height .28s cubic-bezier(.4,0,.2,1);}
          @keyframes jobbotx-bl{0%,100%{opacity:1}50%{opacity:.25}}
          @keyframes jobbotx-glow{
            0%,100%{box-shadow:0 0 0 3px rgba(124,58,237,.45),0 0 14px rgba(124,58,237,.3)}
            50%{box-shadow:0 0 0 7px rgba(124,58,237,.65),0 0 32px rgba(124,58,237,.7)}}
          .jobbotx-pulse{animation:jobbotx-glow .75s ease-in-out 4!important;}
          @keyframes jobbotx-spot{
            0%,100%{box-shadow:0 0 0 4px rgba(124,58,237,.55),0 0 18px rgba(124,58,237,.5),
              0 0 0 9999px rgba(10,5,25,.30)}
            50%{box-shadow:0 0 0 9px rgba(124,58,237,.85),0 0 40px rgba(167,139,250,.9),
              0 0 0 9999px rgba(10,5,25,.38)}}
          .jobbotx-spot{animation:jobbotx-spot .8s ease-in-out infinite!important;}
          #jobbotx-applyall{position:fixed;bottom:26px;right:26px;z-index:2147483647;display:none;
            padding:13px 22px;border:none;border-radius:999px;cursor:pointer;
            font:700 14px/1 system-ui,-apple-system,sans-serif;color:#fff;
            background:linear-gradient(135deg,#059669,#047857);
            box-shadow:0 8px 28px rgba(5,150,105,.45);}
          #jobbotx-applyall:hover{transform:translateY(-2px);box-shadow:0 12px 34px rgba(5,150,105,.6);}
          #jobbotx-selall{position:fixed;bottom:78px;right:26px;z-index:2147483647;display:none;
            padding:10px 18px;border-radius:999px;cursor:pointer;
            font:600 13px/1 system-ui,-apple-system,sans-serif;color:#c4b5fd;
            background:#1a1230;border:2px solid #7c3aed;
            box-shadow:0 6px 20px rgba(124,58,237,.35);}
          #jobbotx-selall:hover{color:#fff;background:#241740;}
          .jobbotx-tick{position:absolute;bottom:8px;left:8px;z-index:9999;width:22px;height:22px;
            border-radius:6px;border:2px solid #7c3aed;background:#fff;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            font:700 13px/1 system-ui;color:#c4b5fd;transition:all .15s;
            pointer-events:auto;}
          .jobbotx-tick:hover{transform:scale(1.15);}
          .jobbotx-tick.on{background:#7c3aed;color:#fff;box-shadow:0 0 8px rgba(124,58,237,.6);}
          @keyframes jobbotx-glow-act{
            0%,100%{box-shadow:0 0 0 3px rgba(217,119,6,.6),0 0 16px rgba(217,119,6,.5),
              0 0 0 9999px rgba(10,5,25,.35)}
            50%{box-shadow:0 0 0 9px rgba(217,119,6,.85),0 0 40px rgba(245,158,11,.9),
              0 0 0 9999px rgba(10,5,25,.45)}}
          .jobbotx-act{animation:jobbotx-glow-act .7s ease-in-out infinite!important;border-color:#f59e0b!important;}
          #jobbotx-bar.jobbotx-bar-act{animation:jobbotx-bl 1s ease-in-out infinite;}
        `;
        document.head.appendChild(s);
      }

      bar = document.createElement('div');
      bar.id = 'jobbotx-bar';
      bar.innerHTML = '<span class="jd"></span><span id="jobbotx-msg">JobBot active</span>' +
                      '<button class="jx" title="Stop">✕</button>';
      bar.querySelector('.jx').onclick = stopAgent;
      document.body.appendChild(bar);

      box = document.createElement('div');
      box.id = 'jobbotx-box';
      document.body.appendChild(box);

      // If another extension (e.g. LeadsLoft) removes our overlay nodes,
      // rebuild them on the next MutationObserver tick so the agent keeps
      // its status bar and spotlight without any manual intervention.
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(() => {
          if (bar && !document.body.contains(bar)) {
            bar = null; box = null;
            if (window.__jobbotRunning) init();
          }
        }).observe(document.body, { childList: true, subtree: false });
      }
    }

    const CLR = {
      info:     ['#1d4ed8','#fff'],
      applying: ['#6d28d9','#fff'],
      success:  ['#065f46','#fff'],
      warning:  ['#92400e','#fff'],
      error:    ['#991b1b','#fff'],
    };

    return {
      // Inject the overlay stylesheet/nodes without showing anything – needed
      // by the tick boxes and ▶ button, which render before any run starts.
      ensure() { init(); },
      status(msg, type = 'info') {
        // Passive telemetry: report genuine failures the agents surface here (all
        // agents call this, so the locked LinkedIn/Indeed ones are covered without
        // touching them). Wrapped so it can NEVER affect the status display.
        try {
          if (type === 'error') Telemetry.send('agent_error', msg);
          else if (type === 'warning' && /not found|no apply|no easy apply|no cards|no new jobs|can'?t|couldn'?t|stuck|fail|won'?t accept|company site|external/i.test(msg || '')) {
            Telemetry.send('agent_warning', msg);
          }
        } catch {}
        init();
        const [bg, fg] = CLR[type] || CLR.info;
        bar.style.cssText += `;background:${bg};color:${fg};`;
        bar.style.display = 'flex';
        const el = document.getElementById('jobbotx-msg');
        if (el) el.textContent = `JobBot: ${msg}`;
      },
      pulse(el, msg = '') {
        init();
        if (msg) this.status(msg, 'applying');
        if (!el) return;

        // Proper spotlight: lock onto the element, FOLLOW it (scroll/re-render),
        // pulse continuously, and dim the rest of the page around it.
        clearInterval(box._loop);
        clearTimeout(box._t);
        const place = () => {
          if (!el.isConnected) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          Object.assign(box.style, {
            display: 'block',
            top:    `${Math.max(0, r.top  - 5)}px`,
            left:   `${Math.max(0, r.left - 5)}px`,
            width:  `${r.width  + 10}px`,
            height: `${r.height + 10}px`,
            border: '3px solid #7c3aed',
          });
        };
        place();
        box.classList.remove('jobbotx-act');
        box.classList.remove('jobbotx-spot');
        void box.offsetWidth; // force reflow so the animation restarts
        box.classList.add('jobbotx-spot');
        box._loop = setInterval(place, 150); // track the element while spotlit
        box._t = setTimeout(() => {
          clearInterval(box._loop);
          box.classList.remove('jobbotx-spot');
          box.style.display = 'none';
        }, 3500);
      },
      // Persistent attention spotlight for human-in-the-loop steps (e.g. captcha).
      // Stays locked on the element and keeps the status bar pulsing until cleared.
      attention(el, msg) {
        init();
        const [bg, fg] = ['#b45309', '#fff'];
        bar.style.cssText += `;background:${bg};color:${fg};`;
        bar.style.display = 'flex';
        bar.classList.add('jobbotx-bar-act');
        const m = document.getElementById('jobbotx-msg');
        if (m) m.textContent = `JobBot: ${msg}`;
        clearInterval(box._loop);
        clearTimeout(box._t);
        const lock = () => {
          if (!el || !el.isConnected) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          Object.assign(box.style, {
            display: 'block',
            top: `${Math.max(0, r.top - 6)}px`, left: `${Math.max(0, r.left - 6)}px`,
            width: `${r.width + 12}px`, height: `${r.height + 12}px`,
          });
          box.classList.add('jobbotx-act');
        };
        box.classList.remove('jobbotx-spot');
        lock();
        box._loop = setInterval(lock, 300); // follow the element if the page scrolls
        try { // gentle audio nudge so the user notices even on another tab
          // Only when the page has had a user gesture and the audio context is
          // actually running — otherwise Chrome's autoplay policy just logs a
          // warning and no sound plays anyway. Reuse one context (never leak a
          // new one per call). The desktop notification still fires regardless.
          const gestured = !('userActivation' in navigator) || navigator.userActivation.hasBeenActive;
          const AC = window.AudioContext || window.webkitAudioContext;
          if (gestured && AC) {
            const ac = box._ac || (box._ac = new AC());
            if (ac.state === 'running') {
              const o = ac.createOscillator(), g = ac.createGain();
              o.connect(g); g.connect(ac.destination); o.frequency.value = 880;
              g.gain.value = 0.05; o.start(); o.stop(ac.currentTime + 0.18);
            }
          }
        } catch {}
      },
      clearAttention() {
        if (box) {
          clearInterval(box._loop);
          box.classList.remove('jobbotx-act'); box.classList.remove('jobbotx-spot');
          box.style.display = 'none';
        }
        if (bar) bar.classList.remove('jobbotx-bar-act');
      },
      hide() {
        if (bar) { bar.style.display = 'none'; bar.classList.remove('jobbotx-bar-act'); }
        if (box) {
          clearInterval(box._loop);
          box.classList.remove('jobbotx-act'); box.classList.remove('jobbotx-spot');
          box.style.display = 'none';
        }
      },
    };
  })();

  // ─── Captcha detection & human hand-off ─────────────────────────────────────
  // We NEVER auto-solve captchas: Cloudflare Turnstile/reCAPTCHA/Arkose are
  // built to be unsolvable by scripts (Turnstile even scores mouse movement),
  // and faking it only raises bot suspicion and risks account bans. Instead we
  // reliably DETECT every common captcha across LinkedIn/Indeed/Naukri, alert
  // the user loudly (spotlight + sound + a browser notification so they notice
  // even on another tab), then resume automatically the moment it's cleared.
  const CAPTCHA = {
    // Widget/iframe selectors covering the major providers + Indeed's current
    // Cloudflare Turnstile and "press & hold" challenge, and CF interstitials.
    SEL: 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], .g-recaptcha, ' +
         'iframe[src*="hcaptcha"], iframe[title*="hCaptcha"], ' +
         'iframe[src*="challenges.cloudflare.com"], iframe[title*="Cloudflare"], ' +
         '.cf-turnstile, #cf-challenge-running, #challenge-stage, #challenge-form, ' +
         'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[id*="arkose"], ' +
         '[data-testid*="captcha"], [class*="captcha" i], [id*="captcha" i], ' +
         'div[aria-label*="captcha" i], [class*="press-and-hold" i]',

    // The element to spotlight (the captcha widget if we can find it).
    el() { return $(this.SEL) || document.body; },

    present() {
      const w = $(this.SEL);
      if (w && isVis(w)) return true;
      // Full-page "verify you are human" interstitial: verification wording on a
      // page that has no real job form (avoids false positives on job pages).
      const txt = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
      const verifyPhrase = /verify (you are|you'?re) (a )?human|are you (a )?human|additional verification required|press ?& ?hold|press and hold|complete the (security|captcha) check|confirm you are human|unusual traffic from your|checking your browser before/;
      if (verifyPhrase.test(txt)) {
        const hasForm = $('input[type="text"]:not([readonly]), textarea, select, [role="combobox"]');
        if (!hasForm) return true; // sparse verification page → treat as captcha
      }
      return false;
    },
  };

  // Fire a desktop notification via the background worker (works across tabs).
  let _lastNotify = 0;
  function notifyUser(title, message) {
    if (Date.now() - _lastNotify < 20000) return; // throttle
    _lastNotify = Date.now();
    try { chrome.runtime.sendMessage({ type: 'NOTIFY', title, message }, () => void chrome.runtime.lastError); } catch {}
  }

  // ─── Learned answers ───────────────────────────────────────────────────────
  // Questions the agent couldn't answer itself, that the USER filled in
  // manually, are remembered here (durable in chrome.storage.local, so they
  // survive cross-site navigation and browser restarts). Next time the same
  // question appears — on any site — the agent auto-fills the saved answer, so
  // the user never has to answer it twice.
  const learnedAnswers = (() => {
    let store = {};
    let resolveReady; const ready = new Promise(r => (resolveReady = r));

    // Canonicalize common wording variants so re-phrasings collapse to one key.
    const SYN = { yrs:'year', yr:'year', years:'year', exp:'experience', experiences:'experience',
                  mob:'mobile', mos:'month', months:'month', ctc:'salary', lpa:'salary',
                  dob:'birth', no:'number', num:'number', nums:'number', addr:'address', ph:'phone' };
    // Normalize a question label → a stable key: lowercase, drop leading
    // numbering ("1.", "Q2)", "question 3 -"), strip punctuation, collapse space.
    const norm = q => String(q || '').toLowerCase()
      .replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):\-]\s*/i, ' ')
      .replace(/[*:?()\[\]{}.,<>/\\!"'’“”_#+=—–\-]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 160);

    // Significant tokens for fuzzy matching (drop filler words, stem plurals).
    const STOP = new Set(('a an the is are am was were be been being do does did done have has had ' +
      'you your yours yourself to of in on at for and or with from as by please enter provide give ' +
      'select choose specify what which who whom how this that these those it its we our they them ' +
      'i me my mine any all if then else about into per will would can could should may might here ' +
      'there field question answer also just only more most very kindly currently').split(/\s+/));
    const stem = w => (w.length > 4 && w.endsWith('s')) ? w.slice(0, -1) : w;
    const toks = q => {
      const out = new Set();
      norm(q).split(' ').forEach(w => { if (!w) return; w = SYN[w] || w; if (w.length >= 2 && !STOP.has(w)) out.add(stem(w)); });
      return out;
    };

    try {
      chrome.storage.local.get('jobbot_learned', d => { if (d.jobbot_learned) store = d.jobbot_learned; resolveReady(); });
    } catch { resolveReady(); }
    const persist = () => {
      try {
        const keys = Object.keys(store);
        if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(k => delete store[k]);
        chrome.storage.local.set({ jobbot_learned: store });
      } catch {}
    };
    return {
      ready,
      get: q => {
        const k = norm(q);
        if (!k || k.length < 4) return null;
        if (store[k]) return store[k];                     // 1) exact wording
        const qt = toks(q);
        if (qt.size < 2) return null;                      // too little signal to match safely
        // 2) fuzzy: closest previously-answered question. Requires at least two
        //    shared significant tokens AND either strong overlap (re-worded) or
        //    full containment (added/removed words) — so a genuinely different
        //    question (e.g. "expected" vs "current" salary) is never answered.
        let best = null, bestScore = 0;
        for (const sk of Object.keys(store)) {
          const st = toks(sk); if (st.size < 2) continue;
          let inter = 0; qt.forEach(w => { if (st.has(w)) inter++; });
          if (inter < 2) continue;
          const jaccard = inter / (qt.size + st.size - inter);
          const contain = inter / Math.min(qt.size, st.size);
          const score = (jaccard >= 0.6 || contain >= 0.85) ? Math.max(jaccard, contain) : 0;
          if (score > bestScore) { bestScore = score; best = sk; }
        }
        return best ? store[best] : null;
      },
      set: (q, a) => {
        const k = norm(q); const v = String(a == null ? '' : a).trim();
        if (!k || k.length < 4 || !v || v.length > 600) return;
        if (store[k] === v) return;
        store[k] = v; persist();
      },
    };
  })();

  // Capture the user's manual answer to a field the agent couldn't fill, keyed
  // by its question label, so it's remembered for next time.
  function learnFromField(el, question) {
    if (!el || !question || el._jbLearn) return;
    el._jbLearn = true;
    const grab = () => {
      let val = '';
      try {
        if (el.matches && el.matches('input[type="radio"],input[type="checkbox"]')) {
          if (el.checked) val = (el.closest('label')?.textContent || el.value || '').trim();
        } else if (el.isContentEditable) {
          val = (el.textContent || '').trim();
        } else {
          val = (el.value || '').trim();
        }
      } catch {}
      if (val) learnedAnswers.set(question, val);
    };
    el.addEventListener('change', grab);
    el.addEventListener('blur', grab);
  }

  // ─── Smart Form Filler ────────────────────────────────────────────────────
  class Filler {
    constructor(p) {
      this.p = p || {};
      this._aiCache = new Map();
    }

    // AI fallback for questions map() can't answer. Each user brings their OWN
    // Gemini key (preferences.geminiKey): the call runs from the background
    // worker straight to Google with that key, so it's billed to them and the
    // key never touches the app's server. If no personal key is set, fall back
    // to the shared backend (/api/ai) for backward compatibility.
    async aiAnswer(question, options = []) {
      const prefs = this.p.preferences || {};
      if (!prefs.aiEnabled) return null;
      const q = String(question).trim();
      if (q.length < 3) return null;

      const cacheKey = q + '|' + options.join(',');
      if (this._aiCache.has(cacheKey)) return this._aiCache.get(cacheKey);

      // ── Path A: user's own Gemini key (preferred, independent per account) ──
      if (prefs.geminiKey) {
        try {
          SPOT.status(`AI answering: "${q.substring(0, 50)}…"`, 'applying');
          const ans = await new Promise(res => {
            try {
              chrome.runtime.sendMessage(
                { type: 'GEMINI_ANSWER', apiKey: prefs.geminiKey, question: q, options, profile: this.p },
                r => { void chrome.runtime.lastError; res(r?.answer || null); }
              );
            } catch { res(null); }
          });
          const clean = (ans || '').trim() || null;
          this._aiCache.set(cacheKey, clean);
          return clean;
        } catch { this._aiCache.set(cacheKey, null); return null; }
      }

      // ── Path B: shared backend (only if no personal key is configured) ──────
      if (!prefs.crmUrl) return null;
      const auth = {};
      if (prefs.crmEmail && prefs.crmPassword) {
        const token = await new Promise(res => {
          try {
            chrome.runtime.sendMessage({ type: 'GET_CRM_TOKEN' }, r => {
              void chrome.runtime.lastError;
              res(r?.token || null);
            });
          } catch { res(null); }
        });
        if (token) auth.Authorization = `Bearer ${token}`;
      }
      if (!auth.Authorization && prefs.crmKey) auth['x-api-key'] = prefs.crmKey;
      if (!auth.Authorization && !auth['x-api-key']) return null;

      try {
        SPOT.status(`AI answering: "${q.substring(0, 50)}…"`, 'applying');
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(`${prefs.crmUrl.replace(/\/+$/, '')}/api/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({ kind: 'answer', question: q, options, profile: this.p }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) { this._aiCache.set(cacheKey, null); return null; }
        const data = await r.json();
        const ans = (data.answer || '').trim() || null;
        this._aiCache.set(cacheKey, ans);
        return ans;
      } catch { return null; }
    }

    map(q) {
      // A previously-learned manual answer wins — the user already told us how
      // to answer this exact question, so never re-ask or re-guess it.
      const learned = learnedAnswers.get(q);
      if (learned) return learned;

      const t = String(q).toLowerCase().replace(/[*?()\[\]]/g, '').trim();
      const p = this.p;
      const pro = p.professional || {};
      const per = p.personal     || {};
      const prf = p.preferences  || {};

      if (/\byear[s]?\b.*(experience|exp)\b/i.test(t))        return pro.experience || '3';
      if (/\bcurrent.*(salary|ctc|compensation)\b/i.test(t))  return pro.currentSalary || '';
      if (/\bexpected.*(salary|ctc)|salary.expectation\b/i.test(t)) return pro.expectedSalary || '';
      if (/\bnotice.period|available.to.join|joining.date\b/i.test(t)) return pro.noticePeriod || '30 days';
      if (/\b(mobile|phone|contact.*(no|number|detail))\b/i.test(t)) return per.phone || '';
      if (/\b(postal|zip|pin)\s*.?code\b|pincode/i.test(t))   return per.postalCode || '';
      if (/\b(city|location|based.in|current.location)\b/i.test(t))  return per.location || '';
      if (/\bwilling.*(relocat|move)\b/i.test(t))             return prf.willingToRelocate ? 'Yes' : 'No';
      // Visa sponsorship must be checked BEFORE the work-authorization rule below
      // (which matches "visa"): an authorised applicant does NOT need sponsorship.
      if (/\b(require|need|requiring|needing|request|seeking?)\b.*\b(sponsor|sponsorship|visa\s+support)\b|\bsponsorship\b.*\b(require|need)\b/i.test(t))
        return prf.workAuth !== false ? 'No' : 'Yes';
      if (/\b(authoriz|authoris|eligible.to.work|work.permit|visa|right.to.work)\b/i.test(t)) return 'Yes';
      if (/\btravel\b/i.test(t))                              return prf.travelPercentage || '25';
      if (/\blanguage\b/i.test(t))                            return pro.languages || 'English, Hindi';
      if (/\b(qualification|education|degree|highest)\b/i.test(t)) return pro.education || "Bachelor's Degree";
      if (/\b(cover.letter|why.do.you.want|why.interested|tell.us.about)\b/i.test(t)) {
        return pro.coverLetter ||
          `I am enthusiastic about this opportunity. With ${pro.experience || '3'} years of hands-on experience, I am confident in my ability to contribute significantly to your team.`;
      }
      if (/\b(remote|work.from.home|wfh)\b/i.test(t))        return prf.workMode === 'remote' ? 'Yes' : 'Open to hybrid';
      if (/\bgender\b/i.test(t))                              return per.gender || '';
      if (/\bcurrent.*(company|employer|organisation)\b/i.test(t)) return pro.currentCompany || '';
      if (/\b(designation|current.role|current.title|current.position)\b/i.test(t)) return pro.currentTitle || '';
      if (/\bskill\b/i.test(t))                               return pro.skills || '';
      if (/\bfresher\b/i.test(t))                             return parseInt(pro.experience || '0') === 0 ? 'Yes' : 'No';
      // First / middle / last name split from the full name (checked before the
      // generic name rule so "First name" doesn't get the whole name).
      if (/\b(first|given)\s*name\b/i.test(t)) { const n = (per.name || '').trim().split(/\s+/); return n[0] || per.name || ''; }
      if (/\b(last|sur)\s*name|surname|family\s*name\b/i.test(t)) { const n = (per.name || '').trim().split(/\s+/); return n.length > 1 ? n[n.length - 1] : ''; }
      if (/\bmiddle\s*name\b/i.test(t)) { const n = (per.name || '').trim().split(/\s+/); return n.length > 2 ? n.slice(1, -1).join(' ') : ''; }
      if (/\bname\b/i.test(t) && !/company|employer/i.test(t)) return per.name || '';
      if (/\bemail\b/i.test(t))                               return per.email || '';
      // Naukri chatbot phrasings (additive – evaluated after all the above)
      if (/\b(are you )?(comfortable|okay|open|fine)\b.*\b(with|to|for)\b/i.test(t)) return 'Yes';
      if (/\bimmediate(ly)?\s*(joiner|join)/i.test(t)) {
        const days = parseInt((pro.noticePeriod || '30').match(/\d+/)?.[0] || '30', 10);
        return days <= 15 ? 'Yes' : 'No';
      }
      if (/\b(total|overall|relevant)\b.*\bexperience\b/i.test(t)) return pro.experience || '3';

      // Age / eligibility confirmations
      // "Are you between the ages of 18 and 45?" / "Are you above 18?" / "at least 18 years old?"
      if (/\bage[sd]?\b.*\b(between|above|below|over|under|at\s+least|minimum|eligib)\b|\b(between|above|below|over|under|at\s+least|minimum)\b.*\bage[sd]?\b/i.test(t)) return 'Yes';
      if (/\b(meet|satisfy)\b.*\b(age|requirement|criterion|criteria)\b|\bage\b.*\b(requirement|criterion|criteria|eligib)\b/i.test(t)) return 'Yes';

      // Employment status
      if (/currently\s+(employed|working)|employed\s+currently/i.test(t)) return pro.currentCompany ? 'Yes' : 'No';

      // "Are you a graduate?" / "Are you a degree holder?"
      if (/\b(graduate|degree\s+holder)\b/i.test(t) && !/post.?graduate/i.test(t)) return 'Yes';

      // Generic legal / background consent ("Have you ever been convicted…?")
      if (/\b(convicted|criminal\s+record|felony|background\s+check)\b/i.test(t)) return 'No';

      // Disability / veteran self-identification (common US/IN EEOC questions)
      if (/\b(disability|disabled|veteran|differently.?abled)\b/i.test(t)) return 'No';

      // ── Extended self-answering (all additive; only fire for questions none of
      //    the rules above already answered) ─────────────────────────────────────

      // Nationality / citizenship
      if (/\b(nationality|citizenship|citizen\s+of|country\s+of\s+(origin|citizenship))\b/i.test(t))
        return per.nationality || '';

      // Date of birth (a plain DOB field)
      if (/\b(date\s*of\s*birth|d\.?o\.?b\.?|birth\s*date|born\s+on)\b/i.test(t))
        return per.dateOfBirth || '';

      // Numeric age — computed from DOB when possible (eligibility yes/no is
      // already handled above, so this only catches a plain "Age" field).
      if (/\bage\b/i.test(t) && !/(manage|package|average|usage|language|agency|agenda)/i.test(t)) {
        const a = ageFromDob(per.dateOfBirth);
        return a ? String(a) : '';
      }

      // Marital status
      if (/\bmarital\s*status\b|\bmarried\b/i.test(t)) return per.maritalStatus || '';

      // LinkedIn / profile URL
      if (/\blinked\s*in\b|\blinkedin\s*(profile|url|link)\b/i.test(t)) return per.linkedin || '';

      // Work authorization ("Are you authorized/eligible to work?") — the existing
      // rule above only catches "visa"/"work permit"/"right to work"; add the
      // authorised/eligible phrasings here (sponsorship is handled earlier).
      if (/\b(authoriz|authoris|eligible|permitted|entitled|legally)\w*\b.*\bwork\b|\bwork\s+authoriz|\bright\s+to\s+work\b/i.test(t))
        return 'Yes';

      // Start date / earliest availability → immediate or the notice period.
      if (/\b(start\s*date|when.*(start|join|begin)|earliest.*(start|join|availab)|how\s+soon.*join|availab.*(to|start|join))\b/i.test(t)) {
        const days = parseInt((pro.noticePeriod || '30').match(/\d+/)?.[0] || '30', 10);
        return days <= 3 ? 'Immediately' : (pro.noticePeriod || '30 days');
      }

      // Preferred / desired job location, hometown, current address → their city.
      if (/\b(preferred|desired|current)\s*(job\s*)?(location|city|address)\b|\b(home\s*town|hometown|native\s*place|permanent\s*address|mailing\s*address|residential\s*address)\b/i.test(t))
        return per.location || '';

      // References available
      if (/\breference[s]?\b.*(available|provide|on\s+request|willing)|(can\s+you|will\s+you).*\breference[s]?\b/i.test(t))
        return 'Available on request';

      // "How did you hear about us / this role / this job"
      if (/\bhow\s+did\s+you\s+(hear|find|learn|come\s+to\s+know)\b|\b(source|referral\s+source|where\s+did\s+you\s+(hear|find))\b/i.test(t))
        return 'LinkedIn';

      // Willingness to work weekends / nights / shifts / overtime / holidays / rotational
      if (/\b(willing|able|comfortable|open|okay|ok|prepared)\b.*\b(weekend|night\s*shift|rotational|rotating|shift|overtime|holiday|extra\s*hours|flexible\s*hours|on\s*call)\b/i.test(t))
        return 'Yes';
      if (/\b(weekend|night\s*shift|rotational|rotating\s*shift|shift\s*work|overtime|extra\s*hours)\b.*\b(work|available|okay|fine|comfortable)\b/i.test(t))
        return 'Yes';

      // Generic "do you have experience / knowledge / familiarity with …" → Yes.
      if (/\bdo\s+you\s+have\b.*\b(experience|knowledge|hands.?on|familiar|expertise|exposure|proficien)\b/i.test(t))
        return 'Yes';
      if (/\b(are|do)\s+you\b.*\b(familiar|proficient|experienced|skilled)\b.*\bwith\b/i.test(t))
        return 'Yes';

      // Consent / agree / acknowledge / terms
      if (/\b(agree|consent|acknowledge|accept)\b.*\b(terms|conditions|policy|privacy|process|share|data)\b|\bi\s+(agree|consent|confirm|certify|acknowledge)\b/i.test(t))
        return 'Yes';
      if (/\b(certify|confirm)\b.*\b(true|accurate|correct|information)\b/i.test(t)) return 'Yes';

      // Have you applied to / worked here before → No
      if (/\b(have|did)\s+you\s+(ever\s+)?(applied|worked|been\s+employed)\b.*(before|previously|with\s+us|here|this\s+(company|organi))\b/i.test(t))
        return 'No';

      // Are you a fresher/experienced already covered; generic "willing to" → Yes.
      if (/\b(are\s+you\s+)?willing\s+to\b/i.test(t)) return 'Yes';
      if (/\bcan\s+you\s+(join|start|work|commit|attend)\b/i.test(t)) return 'Yes';

      // Reason for change / leaving → a neutral, professional line.
      if (/\breason\b.*\b(change|leaving|switch|looking|move|job\s*change)\b|\bwhy\b.*\b(leav|chang|switch)\b/i.test(t))
        return 'Seeking new challenges and growth opportunities that align with my career goals.';

      // Highest / total experience phrasings not caught above.
      if (/\b(experience|exp)\b/i.test(t) && /\b(how\s+many|years?|yrs?|duration|total|overall)\b/i.test(t))
        return pro.experience || '3';

      return null;
    }

    bestOption(question, opts) {
      const ans = this.map(question);
      if (!ans) return null;
      const a = String(ans).toLowerCase();

      // exact match
      for (const o of opts) if (o.toLowerCase() === a) return o;

      // yes/no
      if (/^yes/.test(a)) { const m = opts.find(o => /^yes/i.test(o)); if (m) return m; }
      if (/^no/.test(a))  { const m = opts.find(o => /^no/i.test(o));  if (m) return m; }

      // travel % – pick closest
      if (/travel/i.test(question)) {
        const pref = parseInt(this.p.preferences?.travelPercentage || '25');
        let best = null, diff = Infinity;
        for (const o of opts) {
          const m = o.match(/(\d+)/);
          if (m) { const d = Math.abs(parseInt(m[1]) - pref); if (d < diff) { diff = d; best = o; } }
        }
        if (best) return best;
      }
      return null;
    }

    labelFor(el) {
      // 1. <label for="id">
      if (el.id) {
        const lbl = $(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent.trim();
      }
      // 2. aria-label / aria-labelledby
      const al = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (al) {
        const ref = document.getElementById(al);
        return (ref ? ref.textContent : al).trim();
      }
      // 3. wrapping <label>
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent.trim();
      // 4. walk up DOM – look for sibling/ancestor text nodes
      let node = el.parentElement;
      for (let i = 0; i < 7 && node; i++) {
        const ariaLabel = node.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.length > 2) return ariaLabel.trim();
        const lblId = node.getAttribute('aria-labelledby');
        if (lblId) { const r = document.getElementById(lblId); if (r) return r.textContent.trim(); }
        const prev = node.previousElementSibling;
        if (prev && !prev.querySelector('input,textarea,select,button')
            && prev.textContent.trim().length > 2) return prev.textContent.trim();
        const lbl = $('label,legend,p[class*="label"],span[class*="label"],div[class*="label"],h3,h4', node);
        if (lbl && lbl !== el && lbl.textContent.trim().length > 2) return lbl.textContent.trim();
        node = node.parentElement;
      }
      return el.placeholder || el.name || '';
    }

    async fillRadios(root) {
      const groups = new Map();
      $$('input[type="radio"]', root).forEach(r => {
        const key = r.name || r.closest('fieldset')?.id || r.closest('[role="group"]')?.id || String(Math.random());
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });

      for (const [, radios] of groups) {
        if (radios.some(r => r.checked)) continue;

        let question = '';
        const fs = radios[0].closest('fieldset, [role="group"]');
        if (fs) { const leg = $('legend, [role="heading"]', fs); if (leg) question = leg.textContent.trim(); }
        if (!question) question = this.labelFor(radios[0]);

        const opts = radios.map(r => {
          const id = r.id ? CSS.escape(r.id) : null;
          const lbl = id ? $(`label[for="${id}"]`) : r.closest('label');
          return (lbl ? lbl.textContent : r.value || r.getAttribute('data-value') || '').trim();
        });

        let chosen = this.bestOption(question, opts);
        if (!chosen && question) {
          // Profile can't answer – ask the AI to pick from the actual options
          const ai = await this.aiAnswer(question, opts);
          if (ai) chosen = opts.find(o => o.toLowerCase() === ai.toLowerCase())
                        || opts.find(o => o.toLowerCase().includes(ai.toLowerCase())
                                       || ai.toLowerCase().includes(o.toLowerCase()));
        }
        const idx    = chosen ? opts.findIndex(o => o === chosen) : 0;
        const target = radios[idx] || radios[0];

        if (target && !target.checked) {
          SPOT.pulse(target, `Selecting: "${opts[idx] || target.value}"`);
          await sleep(rand(120, 280));
          target.click();
          target.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(rand(80, 180));
        }

        // Agent was unsure (no confident match) → attach learners AFTER its own
        // guess so that if the user corrects the choice, we remember it.
        if (!chosen && question) radios.forEach(r => learnFromField(r, question));
      }
    }

    async fillTexts(root) {
      const inputs = $$('input[type="text"],input[type="number"],input[type="tel"],input[type="email"],textarea', root)
        .filter(el => isVis(el) && !el.readOnly && el.getAttribute('aria-hidden') !== 'true');

      for (const inp of inputs) {
        if (inp.value?.trim()) continue;
        const label = this.labelFor(inp);
        let ans     = this.map(label);
        if (!ans) ans = await this.aiAnswer(label);   // AI fallback for unknown questions
        if (ans) {
          SPOT.pulse(inp, `Filling: "${label.substring(0, 48)}"`);
          await typeInto(inp, ans);
          await sleep(rand(100, 250));
        } else if (label) {
          // Couldn't answer — remember whatever the user types here for next time.
          learnFromField(inp, label);
        }
      }
    }

    async fillSelects(root) {
      for (const sel of $$('select', root).filter(isVis)) {
        if (sel.value && sel.value !== '' && sel.value !== '0' && sel.value !== '-1') continue;
        const label = this.labelFor(sel);
        let ans     = this.map(label);
        if (!ans) {
          const optTexts = $$('option', sel).map(o => o.textContent.trim()).filter(t => t && !/^select/i.test(t));
          ans = await this.aiAnswer(label, optTexts);  // AI picks from the real options
        }
        if (!ans) { if (label) learnFromField(sel, label); continue; }
        const opt = $$('option', sel).find(o => o.textContent.toLowerCase().includes(ans.toLowerCase()));
        if (opt) {
          SPOT.pulse(sel, `Dropdown: "${opt.textContent.trim()}"`);
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(rand(120, 250));
        }
      }
    }

    async fillComboboxes(root) {
      const cbs = $$('[role="combobox"]', root).filter(isVis);
      for (const cb of cbs) {
        const label = this.labelFor(cb);
        const ans   = this.map(label);
        if (!ans) { if (label) learnFromField(cb, label); continue; }

        cb.click();
        await sleep(rand(400, 700)); // FIX: wait for options to render

        const opts = $$('[role="option"]', document).filter(isVis);
        if (!opts.length) { cb.blur(); continue; }

        const match = opts.find(o => o.textContent.toLowerCase().includes(ans.toLowerCase()));
        if (match) {
          SPOT.pulse(match, `Option: "${match.textContent.trim()}"`);
          match.click();
        } else {
          opts[0].click(); // pick first as fallback
        }
        await sleep(rand(150, 300));
      }
    }

    async all(root = document.body) {
      await this.fillRadios(root);
      await this.fillTexts(root);
      await this.fillSelects(root);
      await this.fillComboboxes(root);
    }
  }

  // ─── LinkedIn Agent ────────────────────────────────────────────────────────
  // ═══ LinkedIn Agent — LOCKED ═════════════════════════════════════════════
  // Handles all three A/B-served search layouts (legacy li cards, 2024
  // data-view-name cards, and the "AI-powered search" SDUI with anonymous
  // role=button cards), tick-queue, Easy Apply modal flow, and blocking-modal
  // cleanup. Do NOT modify without the owner's explicit approval — see
  // CLAUDE.md "Locked integrations".
  class LinkedInAgent {
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    // LinkedIn A/B-serves three search layouts (verified against the
    // first2apply v1-v6 parsers and other 2025 bots):
    //   A legacy Ember:  li[data-occludable-job-id]
    //   B 2024 redesign: div[data-view-name="job-card"]
    //   C "AI-powered search" SDUI: no <li>, no ids, no anchors - cards are
    //     div[role="button"][componentkey] under SearchResultsMainContent,
    //     classes are randomized hashes. NEVER match by class there.
    jobCards() {
      // Layout A
      let cards = $$('li[data-occludable-job-id], li.jobs-search-results__list-item, ' +
                     'li.scaffold-layout__list-item, li[data-job-id]').filter(isVis);
      if (cards.length) return cards;

      // Layout B
      cards = $$('div[data-view-name="job-card"], .job-card-job-posting-card-wrapper, ' +
                 '.job-card-container--clickable, div[data-job-id]').filter(isVis);
      if (cards.length) return cards;

      // Layout C (AI-powered search beta)
      const main = $('div[componentkey="SearchResultsMainContent"], [componentkey*="SearchResults"]');
      if (main) {
        cards = $$('div[role="button"][componentkey]', main)
          .filter(c => isVis(c) && c.textContent.trim().length > 60);
        if (cards.length) return cards;
      }

      // Structural last resort: a job card contains a /jobs/view/ anchor
      const seen = new Set();
      return $$('a[href*="/jobs/view/"]')
        .map(a => a.closest('li') || a.closest('[data-job-id]') || a.closest('div[class*="job-card"]'))
        .filter(el => {
          if (!el || !isVis(el) || seen.has(el)) return false;
          seen.add(el);
          return true;
        });
    }

    cardId(card) {
      // Layout C: componentkey="job-card-component-ref-<jobId>" (or opaque UUID)
      const ck = card.getAttribute('componentkey');
      if (ck) {
        const m = ck.match(/job-card-component-ref-(\d+)/);
        return m ? 'li:' + m[1] : 'ck:' + ck;
      }
      // Layout B: card link carries currentJobId=<id>
      const cur = $('a[href*="currentJobId="]', card)?.href.match(/currentJobId=(\d+)/);
      if (cur) return 'li:' + cur[1];
      return card.getAttribute('data-occludable-job-id')
          || card.getAttribute('data-job-id')
          || $('[data-job-id]', card)?.getAttribute('data-job-id')
          || $('a[href*="/jobs/view/"]', card)?.href
          || card.textContent.trim().slice(0, 80);
    }

    async openCard(card) {
      const link = $('a.job-card-list__title--link, a.job-card-list__title, ' +
                     'a.job-card-container__link, a[class*="job-card-list__title"], ' +
                     'a.job-card-job-posting-card-wrapper__card-link, a[href*="/jobs/view/"], ' +
                     'a[href*="currentJobId="]', card);
      // Layout C has no anchors at all – the card div itself is role="button";
      // real mouse events on it open the right-side detail pane.
      const target = link || card;
      const label = (link?.textContent || $('p, strong', card)?.textContent || card.textContent || '')
        .trim().substring(0, 60);
      SPOT.pulse(target, `Opening: ${label}`);
      realClick(target);
      await sleep(rand(1800, 3000));
      return true;
    }

    async findEasyApply() {
      try {
        const btn = await waitFor(
          '.jobs-apply-button--top-card button, .jobs-s-apply button, ' +
          'button.jobs-apply-button, [data-live-test-job-apply-button], ' +
          '#jobs-apply-button-id, button[aria-label^="Easy Apply"], ' +
          'button[aria-label*="Easy Apply"], button[data-job-id][class*="apply"]',
          document, 6000
        );
        const txt = btn.textContent.trim() + ' ' + (btn.getAttribute('aria-label') || '');
        if (/applied|saved/i.test(txt) || !/apply/i.test(txt)) return null;
        // External apply masquerades with the same data attribute but is a
        // role="link" / "on company website" – never leave the site for it.
        if (btn.getAttribute('role') === 'link' || /company website|company site/i.test(txt)) return null;
        return btn;
      } catch { return null; }
    }

    // Post-submit "Application sent" state – also shown as a modal that MUST be
    // closed before the next job, or it blocks every following card click.
    isDone() {
      if ($('.artdeco-inline-feedback--success, .jobs-post-apply-nirvanaBanner, [class*="post-apply"]')) return true;
      return $$('h2, h3, [role="heading"]').some(el =>
        isVis(el) && /application sent|your application was sent/i.test(el.textContent));
    }

    async closeSuccessModal() {
      for (let i = 0; i < 3; i++) {
        const done = $$('button').find(b => isVis(b) &&
          /^(done|dismiss|not now|no thanks)$/i.test(b.textContent.trim()
            || b.getAttribute('aria-label') || ''));
        const x = done || $('.artdeco-modal button[aria-label="Dismiss"]');
        if (!x) return;
        realClick(x);
        await sleep(rand(600, 1100));
      }
    }

    async handleStep() {
      const modal = $('.jobs-easy-apply-modal, div[data-test-modal-id="easy-apply-modal"], ' +
                      '.jobs-easy-apply-content, [data-test-modal]')
                 || $$('div[role="dialog"]').find(d => isVis(d) && $('button, input, select', d));
      if (this.isDone()) return 'done';
      if (!modal) return 'no-modal';

      await this.f.all(modal);
      await sleep(rand(350, 600));

      const submit = $('button[aria-label="Submit application"]', modal)
                   || $$('button', modal).find(b => isVis(b) && /submit application/i.test(b.getAttribute('aria-label') || ''))
                   || $$('button', modal).find(b => isVis(b) && /^submit application$/i.test(b.textContent.trim()));
      if (submit && isVis(submit)) {
        SPOT.pulse(submit, '🎉 Clicking SUBMIT APPLICATION…');
        await sleep(rand(700, 1100)); // hold the spotlight so the click is visible
        await humanClick(submit, '🎉 Submitting application!');
        await sleep(rand(2500, 3500));
        return 'done';
      }

      const review = $('button[aria-label="Review your application"]', modal)
                   || $$('button', modal).find(b => isVis(b) && /review/i.test(b.getAttribute('aria-label') || ''))
                   || $$('button', modal).find(b => isVis(b) && /^review$/i.test(b.textContent.trim()));
      if (review && isVis(review)) {
        SPOT.pulse(review, '📋 Clicking REVIEW…');
        await sleep(rand(600, 900));
        await humanClick(review, '📋 Reviewing application…');
        return 'continue';
      }

      const next = $('button[aria-label="Continue to next step"]', modal)
                 || $('[data-easy-apply-next-button]', modal)
                 || $$('button', modal).find(b => isVis(b) && /^(continue|next)$/i.test(b.textContent.trim()));
      if (next && isVis(next)) {
        SPOT.pulse(next, '➡️ Clicking NEXT…');
        await sleep(rand(600, 900));
        await humanClick(next, '➡️ Next step…');
        return 'continue';
      }

      return 'stuck';
    }

    async dismissModal() {
      const btn = $('[data-test-modal-close-btn], button[aria-label="Dismiss"], button[aria-label="Discard"]');
      if (btn) { realClick(btn); await sleep(rand(700, 1100)); }
      // LinkedIn then asks "Discard application?" – answer it, or the
      // confirmation dialog blocks every following job.
      const discard =
        $('[data-control-name="discard_application_confirm_btn"]') ||
        $$('.artdeco-modal button, [role="alertdialog"] button, [data-test-dialog] button')
          .find(b => isVis(b) && /^discard$/i.test(b.textContent.trim()));
      if (discard) { realClick(discard); await sleep(rand(600, 1000)); }
    }

    async applyCard(card, id) {
      if (!await this.openCard(card)) { this.skipped++; reportSkip(); return; }

      const btn = await this.findEasyApply();
      if (!btn) { SPOT.status('No Easy Apply – skipping', 'warning'); this.skipped++; reportSkip(); return; }

      SPOT.pulse(btn, '🟦 Clicking EASY APPLY…');
      await sleep(rand(600, 1000));
      await humanClick(btn, '🟦 Opening Easy Apply…');
      await sleep(rand(700, 1200));
      SPOT.status('Filling application…', 'applying');

      let i = 0;
      while (i < 30 && this.running) {
        const r = await this.handleStep();
        if (r === 'done') {
          this.applied++;
          if (id) appliedSet.add(id); // confirmed → permanent memory
          report({ type: 'JOB_APPLIED', platform: 'linkedin', title: document.title, url: location.href });
          SPOT.status(`✓ Applied! (${this.applied} total)`, 'success');
          await sleep(rand(1200, 2000));
          await this.closeSuccessModal(); // unblock the page for the next job
          return;
        }
        if (r === 'stuck' || r === 'no-modal') {
          SPOT.status('Stuck – skipping job', 'warning');
          await this.dismissModal();
          this.skipped++; reportSkip();
          return;
        }
        i++;
        await sleep(rand(700, 1400));
      }
      await this.dismissModal();
      this.skipped++; reportSkip();
    }

    async nextPage() {
      let btn = $('button[aria-label="View next page"], button[aria-label="Next"], ' +
                  '.jobs-search-pagination__button--next:not([disabled]), ' +
                  '.artdeco-pagination__button--next:not([disabled])');

      // Numbered pagination (newer layout): click the page after the current one
      if (!btn) {
        const pages = $$('button[aria-label^="Page "]').filter(isVis);
        const cur = pages.findIndex(b =>
          b.getAttribute('aria-current') === 'true'
          || b.closest('li')?.className.match(/active|selected|current/i));
        if (cur >= 0 && pages[cur + 1]) btn = pages[cur + 1];
      }

      if (!btn || btn.disabled) return false;
      SPOT.status('Page finished – moving to the next page…', 'info');
      await humanClick(btn, '➡️ Next page…');
      await sleep(rand(3000, 4500));
      return true;
    }

    async run() {
      this.running = true;
      SPOT.status('LinkedIn – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) {
          SPOT.status('No job cards found – open a LinkedIn Jobs search page', 'warning');
          break;
        }

        // LinkedIn virtualizes the list – cards detach from the DOM as you
        // scroll and more render in as you scroll down. Re-query after every
        // application; when a pass finds nothing new, scroll the list to load
        // more cards before moving to the next page.
        let scrollTries = 0;
        while (this.running) {
          let progressed = false;
          const selMode = selectionMode();
          if (selMode && !selectedSet.size()) {
            SPOT.status('All selected jobs done – tick more to continue, or ✕ to stop', 'success');
            this.running = false;
            return 'nav'; // stay alive in monitor mode awaiting more ticks
          }
          for (const card of this.jobCards()) {
            const id = this.cardId(card);
            // Tick mode: only the jobs the user queued, in list order
            if (selMode && (!id || !selectedSet.has(id))) continue;
            if (id && (appliedSet.has(id) || attemptedSet.has(id))) {
              if (id) selectedSet.remove(id);
              continue;
            }
            if (id) attemptedSet.add(id);

            card.scrollIntoView({ block: 'center' });
            await sleep(rand(400, 800));
            await this.applyCard(card, id);
            if (id) selectedSet.remove(id); // tick consumed
            await sleep(rand(1500, 2800));
            progressed = true;
            break; // re-query the (possibly re-rendered) list
          }

          if (progressed) { scrollTries = 0; continue; }
          if (scrollTries >= 4) break; // genuinely nothing new on this page

          // Nudge the virtualized list to render the next batch of cards
          scrollTries++;
          const lastCard = this.jobCards().pop();
          const scroller = lastCard?.closest('ul')?.parentElement || document.scrollingElement;
          SPOT.status('Loading more jobs…', 'info');
          if (lastCard) lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
          await sleep(rand(1500, 2500));
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ═══ End of LinkedIn Agent (LOCKED) ═══════════════════════════════════════

  // ═══ Indeed Agent — LOCKED ═══════════════════════════════════════════════
  // Verified working end-to-end (apply click, multi-step forms, captcha
  // hand-off, sequencing, dedupe). Do NOT modify this section without the
  // owner's explicit approval — see CLAUDE.md "Locked integrations".
  class IndeedAgent {
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    isApplyPage() {
      if (/\/apply\b|apply\.indeed\.com|smartapply\.indeed\.com/i.test(location.href)) return true;
      // The form UI must be VISIBLE – Indeed preloads a hidden apply iframe on
      // its home/search pages, which previously faked an in-progress application.
      if (this.applyFrame()) return true;
      // Pre-qualification "Apply anyway" modal counts as an apply page so the
      // clickApply retry loop exits and runApplication handles it.
      if ($$('button, [role="button"]').some(b =>
            isVis(b) && /^apply any ?ways?$/i.test((b.textContent || '').trim()))) return true;
      return $$('[data-testid="ia-continueButton"], [data-testid="ia-submitButton"], ' +
                '.ia-BasePage, [data-testid="ia-Questions-main"], .ia-Modal').some(isVis);
    }

    jobCards() {
      const raw = $$('.job_seen_beacon, [data-testid="slider_item"], .resultContent, ' +
                    '[data-testid="job-card"], li[class*="result"] [class*="cardOutline"], ' +
                    'div[class*="jobCard"], li.eu4oa1w0').filter(isVis);
      // Broad class-name selectors above can match footer nav, "People also searched"
      // pills, promo widgets and subscription forms on newer Indeed layouts.
      // Require at least one genuine job-link/id signal so only actual job cards
      // are returned — this fix propagates to run(), visibleIds(), and the tick timer.
      return raw.filter(c =>
        c.matches?.('[data-jk], [data-job-id], [data-occludable-job-id]') ||
        !!$('a[data-jk], [data-jk], a[href*="viewjob?jk="], a[href*="vjk="], ' +
             'a[href*="/rc/clk"], h2 a[href*="viewjob"]', c)
      );
    }

    // Resolve to the ACTUAL clickable "Apply with Indeed" element. Returns the
    // real <button>/<a>, never a wrapper, and skips "Apply on company site"
    // (external) and already-applied buttons.
    findApplyButton(scope = document) {
      const wanted = el =>
        isVis(el)
        && /apply now|apply with indeed|easily apply|^apply$/i.test((el.textContent || '').trim())
        && !/applied|company site|on company|external/i.test(el.textContent);

      // 1) Known ids / test-ids → resolve to the inner interactive element
      const idSel = '#indeedApplyButton, [data-testid="indeedApplyButton"], ' +
        'button[id*="applyButton"]:not([disabled]), [data-testid="applyButton"], ' +
        '.jobsearch-IndeedApplyButton-newDesign, .ia-IndeedApplyButton, ' +
        '.indeed-apply-button, .indeedApplyButton';
      for (const host of $$(idSel, scope)) {
        if (!isVis(host)) continue;
        if (/applied|company site/i.test(host.textContent)) continue;
        const click = host.matches('button,a,[role="button"]')
          ? host : ($('button, a[role="button"], [role="button"]', host) || host);
        return click;
      }

      // 2) Text match across buttons/links in the light DOM
      const txt = $$('button, a[role="button"], [role="button"], ' +
                     'a[href*="smartapply"], a[href*="indeedapply"]', scope).find(wanted);
      if (txt) return txt;

      // 3) Shadow DOM fallback – the apply widget is sometimes a web component
      const pane = $('.jobsearch-RightPane, #jobsearch-ViewjobPaneWrapper, ' +
                     '[data-testid="job-detail"], .fastviewjob', scope) || scope;
      const hosts = [pane, ...$$('*', pane)].filter(e => e.shadowRoot);
      for (const h of hosts) {
        const b = $$('button, a[role="button"], [role="button"]', h.shadowRoot).find(wanted);
        if (b) return b;
      }
      return null;
    }

    async clickApply(card) {
      // Always click the card title to load THIS card's detail panel first.
      // Never shortcut to the apply button without this step — the panel still
      // shows the previous job until the SPA navigates.

      // Prefer the jk from the card element itself; child a[data-jk] is a fallback
      // because the first matching child might be a hidden/SEO anchor, not the title.
      const rawJk = card.getAttribute?.('data-jk')
                 || card.getAttribute?.('data-job-id')
                 || ($('[data-jk]', card) || card).getAttribute?.('data-jk') || '';

      // An element is only a valid click target if it is:
      //   • in the LEFT panel (x < 60 % of viewport — never the detail panel)
      //   • has non-zero dimensions (rules out hidden/collapsed SEO anchors)
      //   • has visible text (rules out empty aria / tracking anchors whose
      //     getBoundingClientRect falls at the Save / bookmark button position)
      const isValidTitle = el => {
        try {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0
              && r.left < window.innerWidth * 0.6
              && (el.textContent || '').trim().length > 0;
        } catch { return false; }
      };

      // 1st choice: exact jk match (only this card's link)
      let title = null;
      if (rawJk) {
        try { title = $$(`a[data-jk="${rawJk}"]`, card).find(isValidTitle); } catch {}
      }
      // 2nd choice: known Indeed title-link class
      if (!title) title = $$('a.jcs-JobTitle', card).find(isValidTitle);
      // 3rd choice: any visible h2 link in the card
      if (!title) title = $$('h2 a', card).find(isValidTitle);
      // Last resort: click the card container itself (always in the left panel)
      if (!title) title = card;

      await humanClick(title, `Opening: ${(title.textContent || '').trim().substring(0, 55)}`);

      // Wait for the SPA to navigate to this job (URL includes its jk).
      for (let w = 0; w < 10 && rawJk; w++) {
        if (location.href.toLowerCase().includes(rawJk.toLowerCase())) break;
        await sleep(rand(400, 700));
      }
      await sleep(rand(500, 900)); // let the detail panel begin rendering

      // Wait up to 10 s for "Apply with Indeed" to appear — gives React time
      // to hydrate and lazy-loaded job panels to fully render.
      SPOT.status('⏳ Looking for Apply with Indeed button…', 'info');
      let btn = null;
      for (let i = 0; i < 20 && !btn; i++) {  // 20 × 500 ms = 10 s max
        btn = this.findApplyButton(document);
        if (!btn) await sleep(500);
      }

      if (!btn || !isVis(btn)) {
        SPOT.status('⏭ "Apply with Indeed" not found – moving to next job…', 'info');
        return 'none';
      }
      if (/applied/i.test(btn.textContent)) return 'already';

      // Force same-tab so the apply flow stays here and auto-resume works.
      if (btn.tagName === 'A') btn.setAttribute('target', '_self');

      const beforeUrl = location.href;
      // Snapshot visible ia-* form element count BEFORE clicking so we can
      // detect in-page form opening even when wasApplyState is already true
      // (Indeed preloads hidden apply UI in the detail panel — isApplyPage()
      // can return true before and after the click, making the old
      // !wasApplyState guard useless for in-page forms).
      const iaSel = '[data-testid="ia-continueButton"], [data-testid="ia-submitButton"], ' +
                    '.ia-Modal, [data-testid="ia-Questions-main"], .ia-BasePage';
      const iaCountBefore = $$(iaSel).filter(isVis).length;
      const opened = () => {
        if (location.href !== beforeUrl) return true;
        if (this.isDone() || this.isAlreadyApplied()) return true;
        if (this.isApplyPage() && $$(iaSel).filter(isVis).length > iaCountBefore) return true;
        return false;
      };

      const targetsOf = b => [b, b.closest && b.closest('button, a, [role="button"]')]
        .filter((v, i, a) => v && a.indexOf(v) === i);

      // Smooth first click: humanClick scrolls + curves cursor + fires realClick.
      await humanClick(btn, '🟦 Clicking "Apply with Indeed"…');

      // Give the React form time to hydrate (typically 1.8-2.8s) before any retry.
      await sleep(rand(1800, 2800));
      // Check the in-tab form FIRST: an iframe/embedded apply opened right here
      // (works even while this tab is hidden, i.e. you're on another tab). Only
      // treat "tab hidden with no in-tab form" as a genuine new-tab popup — this
      // is what lets Indeed keep applying in the background.
      if (opened()) return 'clicked';
      if (document.hidden) return 'popup';

      // Retry loop (up to ~8s more). Always check BEFORE re-clicking — never
      // fire into an already-open form. If the Apply button has vanished the
      // form captured the click; treat as success immediately.
      for (let i = 0; i < 5; i++) {
        // Button gone → form captured the click
        if (!btn.isConnected || !isVis(btn)) return 'clicked';
        const r = btn.getBoundingClientRect();
        await moveTo(r.left + r.width / 2 + (Math.random() - 0.5) * 14,
                     r.top  + r.height / 2 + (Math.random() - 0.5) * 8);
        await sleep(rand(60, 160));
        for (const t of targetsOf(btn)) { try { realClick(t); } catch {} }
        SPOT.pulse(btn, '🟦 Apply with Indeed – opening form…');
        await sleep(rand(1000, 1600));
        if (opened()) return 'clicked';       // in-tab form (works while hidden)
        if (document.hidden) return 'popup';
        // Re-check button existence after waiting
        if (!btn.isConnected || !isVis(btn)) return 'clicked';
        btn = this.findApplyButton(document) || btn;
      }
      return opened() ? 'clicked' : (document.hidden ? 'popup' : 'none');
    }

    async fillStep() {
      // Use document.body — Filler.all() already guards every fill with isVis()
      // and skips inputs that already have values, so wider scope is safe and
      // avoids the "container not found" miss that leaves fields empty.
      await this.f.all(document.body);
      await sleep(rand(350, 600));
    }

    btnText(el) { return (el.textContent || el.value || '').trim(); }

    findStepButtons() {
      // Search the entire document — scoping to Indeed-specific containers was
      // too brittle because the apply form uses different class names across
      // job types and A/B tests. isVis() guards every lookup so hidden
      // preloaded buttons never shadow the visible ones.
      const all = $$('button, [role="button"], input[type="submit"], input[type="button"]');

      const cont =
        // testid — must be visible (hidden preloads exist on some layouts)
        all.find(b => isVis(b) && /^ia-continueButton$|^continue-button$/.test(b.getAttribute('data-testid') || '')) ||
        // exact text match
        all.find(b => isVis(b) && /^(continue|continue applying|next|save and continue|review(?: your application)?)$/i.test(this.btnText(b))) ||
        // pre-qualification / "apply anyway" modal
        all.find(b => isVis(b) && /^(apply any ?ways?|continue any ?ways?|yes,?\s*(continue|apply( any ?ways?)?))$/i.test(this.btnText(b))) ||
        // starts-with-continue fallback (e.g. "Continue to next step")
        all.find(b => isVis(b) && /^continue\b/i.test(this.btnText(b)) && !/skip|without|reading|to site/i.test(this.btnText(b)));

      const sub =
        // testid visible first; disabled submit is caught by the wait-loop in clickContinue
        all.find(b => /^ia-submitButton$|^submit-button$/.test(b.getAttribute('data-testid') || '')) ||
        all.find(b => /submit (my |your )?application|^submit$|apply now/i.test(this.btnText(b))
                   && !b.closest('[aria-hidden="true"]'));

      return { cont, sub };
    }

    // A captcha the user must solve by hand. We never try to tick or solve it:
    // a scripted click can't satisfy it and only raises bot suspicion. Uses the
    // shared broad detector so Indeed's Cloudflare Turnstile / press-and-hold
    // challenge is recognised (not just reCAPTCHA), which is what used to make
    // the agent silently stall.
    hasCaptcha() { return CAPTCHA.present(); }

    // Pause and let the human solve the captcha; resume the moment it clears.
    async waitForCaptcha(sub) {
      SPOT.attention(CAPTCHA.el() || sub,
        '🔐 Please solve the "verify you\'re human" check — I\'ll submit automatically');
      notifyUser('JobBot needs you', 'Solve the captcha on Indeed — the agent will submit automatically once done.');
      const isOk = el => el && isVis(el) && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
      for (let i = 0; i < 600 && this.running; i++) { // wait up to ~10 min
        await sleep(1000);
        if (this.isDone()) { SPOT.clearAttention(); return 'submitted'; }

        // The RELIABLE "captcha solved" signal is the Submit/Continue button
        // going live again — Cloudflare Turnstile enables it once the token is
        // issued. The widget iframe often LINGERS in the DOM after solving, so
        // we must NOT wait for it to disappear; we watch the buttons instead.
        const { cont: c2, sub: s2 } = this.findStepButtons();
        if (isOk(s2)) {                    // Submit your application is now clickable
          SPOT.clearAttention();
          await sleep(rand(500, 1100));
          await humanClick(s2, '🎉 Submitting my application!');
          await sleep(rand(1500, 2500));
          // Confirm it went through; if the button is still there, click once more.
          if (!this.isDone()) {
            const { sub: s3 } = this.findStepButtons();
            if (isOk(s3)) { await humanClick(s3, '🎉 Submitting my application!'); await sleep(rand(1500, 2500)); }
          }
          return 'submitted';
        }
        if (isOk(c2)) {                    // a Continue/Review step appeared after the captcha
          SPOT.clearAttention();
          await humanClick(c2, '✨ Continuing after captcha…');
          await sleep(rand(1200, 2000));
          return 'continue';
        }
        // Captcha widget truly gone and no button live yet → hand back to the
        // main loop, which waits for Submit to enable and clicks it.
        if (!CAPTCHA.present()) { SPOT.clearAttention(); return 'continue'; }

        // Still waiting — re-alert every ~45s in case they missed it.
        if (i > 0 && i % 45 === 0) notifyUser('JobBot still waiting', 'A captcha is still open on Indeed — please solve it to continue.');
      }
      SPOT.clearAttention();
      return 'blocked';
    }

    async clickContinue() {
      const isOk = el => isVis(el) && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;
      const { cont, sub } = this.findStepButtons();

      if (cont && isOk(cont)) {
        const isAnyway = /apply any ?ways?|continue any ?ways?/i.test(this.btnText(cont));
        const isReview = /^review\b/i.test(this.btnText(cont));
        const msg = isAnyway ? '✅ Clicking APPLY ANYWAY…'
                  : isReview ? '📋 Clicking REVIEW…'
                  : '✨ Clicking CONTINUE…';
        try { cont.focus(); } catch {}
        await humanClick(cont, msg);
        await sleep(rand(1200, 2000));
        return 'continue';
      }

      if (sub && isOk(sub)) {
        try { sub.focus(); } catch {}
        await indeedPreSubmit(); // human review dwell before the protected submit
        await humanClick(sub, '🎉 Submitting my application!');
        await sleep(rand(1500, 2500));
        return 'submitted';
      }

      if (sub && this.hasCaptcha()) return await this.waitForCaptcha(sub);

      // Submit found but temporarily disabled — wait up to 8s for page to enable it
      if (sub) {
        SPOT.status('⏳ Waiting for Submit to activate…', 'info');
        for (let w = 0; w < 16 && this.running; w++) {
          await sleep(500);
          const { sub: s2 } = this.findStepButtons();
          if (s2 && isOk(s2)) {
            try { s2.focus(); } catch {}
            await indeedPreSubmit(); // human review dwell before the protected submit
            await humanClick(s2, '🎉 Submitting my application!');
            await sleep(rand(1500, 2500));
            return 'submitted';
          }
        }
        return 'blocked';
      }

      if (cont) return 'blocked'; // found but disabled — required fields still empty

      return null; // nothing found yet — runApplication loop will retry
    }

    isDone() {
      if ($('[data-testid="ia-ThankYou"], [data-testid="ia-congrats"], .ia-ThankYou, ' +
            '[class*="ThankYou"], [class*="thank-you"], h1[data-testid*="thank"]')) return true;
      // The post-apply confirmation screen ("Your application has been submitted!")
      return $$('h1, h2, [role="heading"], [class*="title"]').some(el =>
        isVis(el) && /your application has been submitted|application (has been |was )?submitted|successfully applied/i.test(el.textContent));
    }

    // Indeed's interstitial "You have already applied to this job" page – the
    // job slipped past the seen-memory (e.g. applied before JobBot tracked it).
    isAlreadyApplied() {
      return $$('h1, h2, h3, [role="heading"], [class*="title"], [class*="heading"]').some(el =>
        isVis(el) && /already applied to this job|you('ve| have) already applied/i.test(el.textContent));
    }

    // Only a VISIBLE apply iframe counts – Indeed preloads a hidden one
    applyFrame() {
      const f = $('iframe[src*="indeedapply"], iframe[src*="smartapply"], iframe[src*="apply.indeed"]');
      return f && isVis(f) ? f : null;
    }

    async reportApplied() {
      this.applied++;
      // Mark the job as done from the apply-page URL too (jk= job key), so it
      // is remembered even if the list-side card id differed.
      appliedSet.add(normalizeJobId(location.href));
      report({ type: 'JOB_APPLIED', platform: 'indeed', title: document.title, url: location.href });
      SPOT.status(`✓ Applied on Indeed! (${this.applied} total) – returning to job list…`, 'success');
      await sleep(rand(1500, 2500));
      // Stamp the time so startAgent knows to pause before the next job (navigation case)
      try { chrome.storage.local.set({ jobbot_applied_at: Date.now() }); } catch {}
      await this.returnToList();
    }

    // After submitting, get back to the search results so the run continues.
    // Prefer the explicit "Return to job search" button on the confirmation
    // page; fall back to history.back (twice if we're still on the apply flow).
    async returnToList() {
      // Owner-approved: jump straight back to the saved search-results URL
      // (original query, filters, page) so the run resumes exactly where it
      // left off; the button/history paths below are fallbacks.
      const saved = await new Promise(res => {
        try { chrome.storage.local.get('jobbot_return_url', d => { void chrome.runtime.lastError; res(d?.jobbot_return_url || null); }); }
        catch { res(null); }
      });
      if (saved && saved !== location.href) {
        SPOT.status('Returning to your job search…', 'info');
        await sleep(rand(800, 1400));
        location.href = saved; // navigation hands over to auto-resume
        await sleep(6000);
        return;
      }

      const back = $$('a, button').find(b =>
        isVis(b) && /return to job search|back to (job )?results|see more jobs|view more jobs/i.test(b.textContent));
      if (back) {
        await humanClick(back, 'Returning to job list…');
        await sleep(rand(1600, 2600));
        return;
      }
      history.back();
      await sleep(rand(1800, 2600));
      if (/\/apply\b|apply\.indeed\.com|smartapply\.indeed\.com|post-apply/i.test(location.href)) {
        history.back();
        await sleep(rand(1500, 2300));
      }
    }

    async runApplication() {
      SPOT.status('Processing Indeed application…', 'applying');
      let steps = 0, misses = 0;

      while (steps < 60 && this.running) {
        if (this.isDone()) { await this.reportApplied(); return true; }

        // "You have already applied to this job" – remember it permanently and
        // move straight on to the next job instead of waiting for a form.
        if (this.isAlreadyApplied()) {
          appliedSet.add(normalizeJobId(location.href));
          SPOT.status('Already applied – moving to next job…', 'info');
          await sleep(rand(700, 1200));
          await this.returnToList();
          return false;
        }

        // Apply form rendered inside Indeed's embedded iframe: our content
        // script injected in that frame runs its own agent (auto-resume).
        // The top-page agent must wait for it, not skip the job.
        if (this.applyFrame()) {
          SPOT.status('Apply form open – agent working inside it…', 'applying');
          for (let w = 0; w < 90 && this.running; w++) {       // up to ~3 min
            await sleep(2000);
            if (!this.applyFrame() || this.isDone()) break;
          }
          await sleep(1500);
          if (this.isDone()) { await this.reportApplied(); return true; }
          // The frame agent reported the application itself – just return to list
          await this.returnToList();
          return true;
        }

        await this.fillStep();
        const res = await this.clickContinue();

        if (res === 'continue') {
          misses = 0;
          steps++;
          await sleep(rand(900, 1600));
          continue; // next screen → fill and click Continue again, in sequence
        }

        if (res === 'submitted') {
          await sleep(1500);
          if (!this.isDone()) { steps++; continue; } // form might have more steps
          await this.reportApplied();
          return true;
        }

        if (res === 'blocked') {
          // Continue is visible but disabled – a required field is still empty.
          // Refill (AI fallback included) and try again before giving up.
          misses++;
          if (misses < 4) {
            SPOT.status('Required fields pending – refilling…', 'warning');
            await sleep(2000);
            continue;
          }
        } else {
          // Nothing found – the next step may simply still be loading
          misses++;
          if (this.isDone()) continue;
          if (misses < 4) {
            SPOT.status('Waiting for next step…', 'applying');
            await sleep(2500);
            continue;
          }
        }

        SPOT.status('Stuck on this form – returning to job list', 'warning');
        this.skipped++; reportSkip();
        await this.returnToList();
        return false;
      }

      await this.returnToList();
      return false;
    }

    async nextPage() {
      const btn =
        $('[data-testid="pagination-page-next"]:not([disabled]), a[aria-label="Next Page"]') ||
        $$('a[data-testid*="pagination"]').find(a => /next/i.test(a.textContent));
      if (!btn) return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2500, 4000));
      return true;
    }

    cardId(card) {
      const jk = $('a[data-jk]', card)?.getAttribute('data-jk')
              || $('[data-jk]', card)?.getAttribute('data-jk')
              || card.getAttribute('data-jk')
              || card.closest('[data-jk]')?.getAttribute('data-jk');
      if (jk) return 'jk:' + jk.toLowerCase();
      const href = $('h2 a', card)?.href || $('a[href*="viewjob"], a[href*="/rc/clk"]', card)?.href;
      if (href) return normalizeJobId(href);
      return card.textContent.trim().slice(0, 80);
    }

    // Are we on a Indeed search-results page (vs. a single job / transitional page)?
    onResultsPage() {
      return /[?&]q=|[?&]vjk=|\/jobs\b/i.test(location.href)
          || !!$('#mosaic-provider-jobcards, .jobsearch-ResultsList, [data-testid="job-card"]')
          || this.jobCards().length > 0;
    }

    async run() {
      this.running = true;

      if (this.isApplyPage()) {
        // Resumed mid-application after navigation – the run continues on the
        // job list after returnToList(), so keep the running flag alive.
        await this.runApplication();
        this.running = false;
        return 'nav';
      }

      // Landed on a single job-detail / transitional page with no list (e.g. after
      // an apply). Recover to the results instead of declaring the run finished.
      if (!this.onResultsPage()) {
        SPOT.status('Returning to job results…', 'info');
        await this.returnToList();
        this.running = false;
        return 'nav'; // keep the run alive; auto-resume continues on the results page
      }

      SPOT.status('Indeed – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards(), 8, 1500);
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) break;

        // On every page (including after pagination), auto-add all unapplied
        // cards to selectedSet so the engine continues without manual re-ticking.
        // Already-applied / already-attempted cards are excluded.
        if (selectionMode()) {
          for (const card of cards) {
            const jk = this.cardId(card);
            if (jk && !appliedSet.has(jk) && !attemptedSet.has(jk))
              selectedSet.add(jk);
          }
        }

        // Process jobs one by one, re-querying the list after each so the
        // sequence survives panel re-renders. Clicking Apply usually
        // navigates away; auto-resume brings the run back here afterwards.
        let processedThisPage = false;
        let progressed = true;
        while (progressed && this.running) {
          progressed = false;
          const selMode = selectionMode();
          // If nothing queued on this page, exit inner loop and paginate.
          if (selMode && !selectedSet.size()) break;
          for (const card of this.jobCards()) {
            const jk = this.cardId(card);
            if (selMode && (!jk || !selectedSet.has(jk))) continue;
            if (jk && (appliedSet.has(jk) || attemptedSet.has(jk))) {
              if (jk) selectedSet.remove(jk);
              continue;
            }
            if (jk) attemptedSet.add(jk); // session-only; permanent mark happens on confirmed apply

            // Smooth scroll into view — visible, human-like movement.
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(rand(500, 900));
            processedThisPage = true;
            pageChurn.set(0); // real work happened – reset the empty-page streak
            const res = await this.clickApply(card);
            if (res === 'clicked') {
              await this.runApplication();
              await sleep(rand(3500, 5000)); // natural 4s pause before next job
            } else if (res === 'popup') {
              // The application runs in the tab Indeed opened; that tab's
              // agent fills it and closes itself. Wait here until focus
              // returns, then continue with the next job on THIS page.
              SPOT.status('Applying in the opened tab – waiting for it to finish…', 'applying');
              // Continue when focus returns OR when the apply tab actually closes
              // (background stamps jobbot_apply_closed on CLOSE_TAB). The second
              // signal is what lets this keep going while you're on another tab —
              // it no longer depends on the search tab regaining focus.
              const waitStart = Date.now();
              for (let w = 0; w < 100 && this.running; w++) { // up to ~5 min
                await sleep(3000);
                if (!document.hidden) break;
                const closedAt = await new Promise(res => {
                  try { chrome.storage.local.get('jobbot_apply_closed', d => { void chrome.runtime.lastError; res(d?.jobbot_apply_closed || 0); }); }
                  catch { res(0); }
                });
                if (closedAt > waitStart) break; // the apply tab finished + closed
              }
              await sleep(rand(3500, 5000)); // natural 4s pause before next job
            } else if (res === 'none') {
              // No "Apply with Indeed" button — external-only job; skip immediately
              // and let the loop pick the next card without a long pause.
              this.skipped++; reportSkip();
              await sleep(rand(600, 1000));
            } else {
              if (res === 'already' && jk) appliedSet.add(jk); // Indeed says applied → permanent
              this.skipped++; reportSkip();
              await sleep(rand(900, 1700));
            }
            progressed = true;
            break; // re-query the list for the next job
          }
        }

        // Stability (owner-approved): an "empty" page (nothing new to apply)
        // must not flash past. Dwell like a human, and after 5 empty pages in
        // a row stop flipping and hold in monitor mode. The counter lives in
        // sessionStorage because each pagination is a full navigation.
        if (!processedThisPage) {
          const churn = pageChurn.get() + 1;
          pageChurn.set(churn);
          SPOT.status(`Nothing new on this page (${churn}/5) – looking further…`, 'info');
          await sleep(rand(2500, 4000));
          if (churn >= 5) {
            SPOT.status('No new jobs in the last 5 pages – monitoring here… (✕ to stop)', 'info');
            this.running = false;
            return 'nav';
          }
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ═══ End of Indeed Agent (LOCKED) ══════════════════════════════════════════

  // ─── Naukri Agent ─────────────────────────────────────────────────────────
  class NaukriAgent {
    constructor(f) {
      this.f = f; this.applied = 0; this.skipped = 0; this.running = false;
      this._skipNow = false; this._jobTimer = null;
    }
    _armJobTimer(ms = 90000) {
      clearTimeout(this._jobTimer);
      this._skipNow = false;
      this._jobTimer = setTimeout(() => {
        this._skipNow = true;
        SPOT.status('⏱ Job taking too long (90s) – skipping…', 'warning');
      }, ms);
    }
    _disarmJobTimer() { clearTimeout(this._jobTimer); this._skipNow = false; }

    jobCards() {
      // ── Naukri Gulf list cards ──────────────────────────────────────────────
      // Different DOM from naukri.com. Best-effort structural detection: each
      // result card is the container of a job-title link that sits next to an
      // "Easy Apply" indicator. (Refined once the exact card markup is known.)
      if (location.hostname.includes('naukrigulf')) {
        const seen = new Set(); const out = [];
        $$('a[href]').forEach(a => {
          if (!isVis(a)) return;
          // NEVER treat a header/nav link as a job — this is where the عربي/
          // English language toggle lives, and its href can contain "jobs-in"
          // (the Arabic variant of the current search URL). Selecting it made
          // openJob navigate the tab into the Arabic site, after which every
          // English-text selector failed. Exclude header/nav + lang URLs here.
          if (a.closest('header, nav, [class*="header" i], [class*="nav" i]')) return;
          const href = a.href || '';
          if (!/naukrigulf\.com/i.test(href)) return;
          if (/[?&]lang=|\/ar(\/|$|\?)|\/arabic/i.test(href)) return;        // language toggle
          if (!/jobs?-in|job-listings|-jid-|\/job\//i.test(href)) return;   // looks like a job link
          const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (title.length < 3) return;
          if (/^(عربي|arabic|english)$/i.test(title)) return;                // language toggle text
          // The card = nearest ancestor that also contains an "Easy Apply" tag.
          let card = a.closest('article, li, [class*="card" i], [class*="tuple" i], [class*="job" i]') || a.parentElement;
          for (let d = 0; d < 5 && card && card !== document.body; d++) {
            if (/easy\s*apply/i.test(card.textContent || '')) break;
            card = card.parentElement;
          }
          if (!card || card === document.body) return;
          if (card.closest('header, nav, aside, [class*="similar" i], [class*="sidebar" i], [class*="right-section" i]')) return;
          const key = href;
          if (seen.has(key)) return; seen.add(key);
          out.push(card);
        });
        return out.filter(c => isVis(c));
      }
      return $$(
        '.srp-jobtuple-wrapper, [class*="jobTuple"], .cust-job-tuple, ' +
        'article[class*="jobTuple"], div[data-job-id]'
      ).filter(c => isVis(c)
        // Job-description pages render "Jobs you might be interested in" /
        // "Similar jobs" tiles that match the card selectors; they are not
        // part of the run and must never make a detail page look like a list.
        && !c.closest('aside, [class*="similar"], [class*="interested"], ' +
                      '[class*="sidebar"], [class*="right-section"], [class*="rightSection"]'));
    }

    // ── Naukri Gulf: the PRIMARY "Easy Apply" button ──────────────────────────
    // The blue CTA on a job-detail page. Robust against how naukrigulf renders it:
    //   • text is "Easy Apply" whether it's plain text or text beside an icon
    //     (the icon adds no text, but we still allow a little slack in length),
    //   • matched on <button>, <a> AND <div/span role="button">,
    //   • NEVER the "Easy Apply (213)" search-filter chip (it carries a count),
    //   • NEVER an "Already Applied" state,
    //   • PRIMARY only — the CTA that is NOT inside a job/"Similar Jobs" card, so
    //     on the LIST (every Easy Apply lives inside a card) this returns null and
    //     on a DETAIL page it returns the standalone button. This single helper is
    //     the source of truth for both detail-page detection and the apply click.
    _gulfEasyApply() {
      if (!location.hostname.includes('naukrigulf')) return null;
      const norm = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const cards = this.jobCards();
      return $$('button, a, [role="button"]').find(el => {
        if (!isVis(el)) return false;
        const t = norm(el);
        // "Easy Apply" is short; CONTAINS-match (not anchored) so a leading logo
        // glyph before the text can't defeat it. Length cap keeps out breadcrumbs
        // like "Easy Apply Jobs in Dubai".
        if (!t || t.length > 16) return false;
        if (/\balready applied\b|^applied$/i.test(t)) return false;
        if (/\(\s*\d/.test(t)) return false;                   // "Easy Apply (213)" filter chip
        if (!/easy\s*apply/i.test(t)) return false;
        return !cards.some(c => c.contains(el));               // standalone CTA, not a card's button
      }) || null;
    }

    // A job-description page is where the Apply action lives. Detect it by
    // URL or by the apply bar itself — NOT by the absence of job cards
    // (sidebar recommendation tiles used to defeat that check).
    onDetailPage() {
      if (/\/job-listings-/i.test(location.pathname)) return true;
      // Naukri Gulf: a detail page is exactly where a PRIMARY (standalone) Easy
      // Apply button exists — see _gulfEasyApply(). On the list every Easy Apply
      // is inside a card, so this is null there; on a detail page it's the CTA.
      // Never key off the URL — naukrigulf detail urls also contain the "jobs-in"
      // SEO slug, which made the old regex mark every detail page as a list.
      if (location.hostname.includes('naukrigulf')) {
        // Positive LIST signal first: the search-results page carries the
        // "Showing N Jobs" header + the Refine/Sort sidebar. If those are
        // present it is the list, never a detail page — this guarantees the
        // per-card selection ticks keep rendering there even if card detection
        // momentarily misses a card.
        const listMarker = $$('h1, h2, h3, [class*="refine" i], [class*="sort" i]')
          .some(el => isVis(el) && /refine search|showing\s+[\d,]+\s+jobs?|^\s*sort by\s*$/i.test((el.textContent || '').trim()));
        if (listMarker) return false;
        return !!this._gulfEasyApply();
      }
      const bar = $('#apply-button, #company-site-button, #already-applied, ' +
                    'button[class*="apply-button"], [class*="jd-header"]');
      return !!bar && !$('.srp-jobtuple-wrapper');
    }

    // Naukri's post-apply success page. After a successful apply the tab lands on
    //   /myapply/saveApply?strJobsarr=[<jobId>]&applytype=single&resId=…
    // ("Applied to <role>" + interview-360 + recommendations). This is NEITHER a
    // /job-listings- detail page NOR the search list, so it must be handled on
    // its own — otherwise the run strands here ("Page complete – rescanning…").
    isAppliedConfirmationPage() {
      if (/\/myapply\/(saveApply|applyRedirect|apply)/i.test(location.pathname)) return true;
      // Naukri Gulf success page: "You have successfully applied to 'X'" + Similar Jobs.
      if (this._isGulf() && $$('h1, h2, h3, [role="heading"], p, div, span')
            .some(el => isVis(el) && /you have successfully applied to/i.test(el.textContent || ''))) return true;
      const acp = $('.acp-container, .applied-job-content, #interview-360[data-section-name="interview-360"]');
      return !!acp && $$('h1, h2, [role="heading"], [class*="title"]')
        .some(el => isVis(el) && /^\s*applied to\b/i.test(el.textContent));
    }

    // ─────────────── Naukri Gulf (naukrigulf.com) support ──────────────────
    // Gulf reuses this whole agent, but its apply is a DIRECT FORM modal
    // ("Submit & Apply") — not the naukri.com chatbot. Every helper below is
    // gated to the naukrigulf hostname, so naukri.com is completely unaffected.
    _isGulf() { return location.hostname.includes('naukrigulf'); }

    // The Easy-Apply form modal: a visible container with a "Submit & Apply" btn.
    _gulfModal() {
      if (!this._isGulf()) return null;
      const submit = $$('button, [role="button"], input[type="submit"], a')
        .find(b => isVis(b) && /submit\s*&?\s*apply|submit\s+application/i.test((b.textContent || b.value || '').replace(/\s+/g, ' ').trim()));
      if (!submit) return null;
      return submit.closest('[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="drawer" i]') || document.body;
    }

    // The question label for a form field: climb to the field's own wrapper (the
    // closest ancestor holding ONLY this field) and read its "…?" text.
    _gulfQuestionFor(input) {
      let node = input.parentElement;
      for (let d = 0; d < 6 && node && node !== document.body; d++) {
        const areas = node.querySelectorAll('textarea, input[type="text"], input[type="number"], input:not([type])');
        if (areas.length === 1) {
          const m = (node.textContent || '').replace(/\s+/g, ' ').trim().match(/([A-Z][^?]{2,120}\?)/);
          if (m) return m[1].trim();
        } else if (areas.length > 1) break;
        node = node.parentElement;
      }
      return (input.getAttribute('aria-label') || input.name || '').trim();
    }

    // Fill every question in the Gulf modal from the saved profile answers, then
    // click "Submit & Apply". Returns 'done' | 'continue' | 'stuck' | null(no modal).
    async _handleGulfForm() {
      const modal = this._gulfModal();
      if (!modal) return null;

      // ── Radios / dropdowns / comboboxes ──────────────────────────────────
      // Handled by the SHARED Filler engine, which answers from the profile +
      // LEARNED answers, falls back to the user's own AI, and registers
      // learnFromField() on anything it can't answer so the human's pick is
      // remembered and auto-applied next time. Only run when we found a real
      // modal container (never document.body) so page-level controls behind the
      // modal — search filters, etc. — are never touched.
      const scoped = modal !== document.body ? modal : null;
      if (scoped) {
        try { await this.f.fillRadios(scoped); }     catch {}
        try { await this.f.fillSelects(scoped); }    catch {}
        try { await this.f.fillComboboxes(scoped); } catch {}
      }

      // ── Free-text / number fields ─────────────────────────────────────────
      // Read the gulf-specific question label, answer from profile+LEARNED (map,
      // which consults learnedAnswers first) then AI. For anything we can't
      // answer, START LEARNING immediately — learnFromField() attaches listeners
      // so whatever the human types is saved and auto-filled on the next job.
      const textFields = () => $$('textarea, input[type="text"], input[type="number"], input:not([type])', this._gulfModal() || modal)
        .filter(el => isVis(el) && !el.disabled && !el.readOnly);
      for (const inp of textFields()) {
        if ((inp.value || '').trim()) continue;
        const q = this._gulfQuestionFor(inp);
        let ans = q ? this.f.map(q) : null;
        if (!ans && q) ans = await this.f.aiAnswer(q);
        if (!ans && /notice/i.test(q)) ans = this.f.p.professional?.noticePeriod || '30 days';
        if (!ans) {
          if (q) learnFromField(inp, q);   // remember the human's answer for next time
          SPOT.pulse(inp, `❓ ${(q || 'question').slice(0, 40)}`);
          continue;
        }
        SPOT.pulse(inp, `⌨️ ${q.slice(0, 40)}`);
        await typeInto(inp, ans);
        await sleep(rand(250, 550));
      }

      // Completion signal: a still-blank text field, or a "Submit & Apply" that
      // is explicitly disabled (naukrigulf keeps it disabled until every required
      // question — including radios/dropdowns — is answered).
      const findSubmit = () => $$('button, [role="button"], input[type="submit"], a', this._gulfModal() || modal)
        .find(b => isVis(b) && /submit\s*&?\s*apply|submit\s+application/i.test((b.textContent || b.value || '').replace(/\s+/g, ' ').trim()));
      const hardDisabled = el => !!el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(el.className || ''));
      const blanks = () => textFields().filter(el => !(el.value || '').trim());

      if (blanks().length || hardDisabled(findSubmit())) {
        // Buzz the human for whatever's left; the learnFromField listeners above
        // capture their answers (text, radio, or dropdown) for next time.
        SPOT.attention(modal, '❓ Please answer the remaining question(s) — I\'ll submit once done and remember them next time');
        notifyUser('JobBot needs you', 'A Naukrigulf question needs your answer — fill it and I\'ll remember it for next time.');
        for (let i = 0; i < 300 && this.running; i++) {
          await sleep(1000);
          if (this.isApplied()) { SPOT.clearAttention(); return 'done'; }
          if (!this._gulfModal()) { SPOT.clearAttention(); return 'continue'; }
          if (!blanks().length && !hardDisabled(findSubmit())) break; // all set → submit
        }
        SPOT.clearAttention();
      }

      const submit = findSubmit();
      if (submit) {
        await sleep(rand(500, 1000));
        await humanClick(submit, '🎉 Submit & Apply');
        await sleep(rand(1800, 2800));
        return 'done';
      }
      return 'stuck';
    }

    cardLink(card) {
      // Naukri Gulf: the title links to the job detail (unique per job) — used
      // both to open the job and to derive a UNIQUE card id.
      if (location.hostname.includes('naukrigulf')) {
        // HARD-EXCLUDE the header/nav, the عربي/English language toggle, any
        // lang= or /ar URL, the Apply/Save/Share controls, and the company-logo
        // link (an <a> wrapping an <img>). Returning the language link here was
        // the root cause of the tab flipping to Arabic. Prefer a real job-detail
        // anchor inside THIS card; fall back to any other safe anchor.
        const bad = a =>
          a.closest('header, nav, [class*="header" i], [class*="nav" i]')
          || /[?&]lang=|\/ar(\/|$|\?)|\/arabic/i.test(a.getAttribute('href') || '')
          || /^(عربي|arabic|english|easy\s*apply|apply|save|saved|share|view details)$/i
               .test((a.textContent || '').trim())
          || !!a.querySelector('img');
        const jobA = $$('a[href*="job-listings"], a[href*="-jid-"], a[href*="jobs-in"], ' +
                        'a[href*="/job/"], a[href*="/jobseeker/"]', card)
          .find(a => isVis(a) && !bad(a));
        if (jobA) return jobA;
        return $$('a[href]', card)
          .find(a => isVis(a) && !bad(a) && (a.textContent || '').trim().length >= 3) || null;
      }
      // Recommended-jobs tiles render the title as <p class="title">, not an anchor
      return $('a.title, a[class*="title"], a[class*="jobTitle"], a[href*="/job-listings-"], h2 a', card)
          || $('p.title, .title', card);
    }

    cardId(card) {
      const id = card.getAttribute('data-job-id');
      if (id) return 'nk:' + id;
      // Naukri Gulf has no data-job-id → derive a UNIQUE id from the job link
      // href (falling back to the title text, NOT the whole card text, which
      // collides across cards and caused "16 selected" but "Apply 2").
      if (location.hostname.includes('naukrigulf')) {
        const href = this.cardLink(card)?.href;
        if (href) return 'ng:' + normalizeJobId(href);
        const t = $('a, h2, h3, [class*="title" i]', card);
        return 'ng:' + ((t ? t.textContent : card.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      }
      const href = this.cardLink(card)?.href;
      if (href) return normalizeJobId(href);
      return card.textContent.trim().slice(0, 80);
    }

    // ── Naukri Gulf: apply each job in its OWN tab, one at a time ────────────
    // Keep the search list intact: open the job in a new tab (via the extension,
    // so it isn't popup-blocked), let THAT tab apply + close itself, and only
    // then return so the list moves on to the next selected job. This is the
    // "open → apply → close tab → back to list → next" flow. Sets _ngTabHandled
    // to the outcome so applyHere() reports it without re-applying on the list.
    async _openGulfJobTab(card) {
      const link = this.cardLink(card);
      const href = link && link.tagName === 'A' ? (link.href || link.getAttribute('href') || '') : '';
      if (!href || /^javascript:/i.test(href)) { this._ngTabHandled = 'skip'; return true; }
      SPOT.pulse(link || card, `Opening: ${(link?.textContent || 'job').trim().slice(0, 50)} — in a new tab`);
      await sleep(rand(400, 800));
      // Handshake: the spawned job tab clears jobbot_ng_job and sets
      // jobbot_ng_done when it finishes, so we know when to open the next.
      await new Promise(r => { try { chrome.storage.local.set({ jobbot_ng_job: '1', jobbot_ng_done: '' }, () => { void chrome.runtime.lastError; r(); }); } catch { r(); } });
      const tabId = await new Promise(res => {
        try { chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: href, active: true }, resp => { void chrome.runtime.lastError; res(resp?.tabId ?? null); }); }
        catch { res(null); }
      });
      if (!tabId) {
        // Popup/extension open failed → fall back to same-tab navigation; the
        // detail page's own run() then applies. _ngTabHandled=null skips the
        // short-circuit so applyHere runs normally there.
        try { link.setAttribute('target', '_self'); } catch {}
        try { location.assign(href); } catch { realClick(link); }
        this._ngTabHandled = null;
        this._ngTabDidReport = false;   // same-tab: the list tab reports as usual
        await sleep(rand(2000, 3000));
        return true;
      }
      // A real job tab handled the apply AND its own JOB_APPLIED report, so the
      // list tab must not report again (would double-count).
      this._ngTabDidReport = true;
      SPOT.status('⏳ Applying in the job tab — I\'ll continue here when it\'s done…', 'applying');
      let done = 'skip';
      for (let i = 0; i < 150 && this.running; i++) {   // wait up to ~2.5 min
        await sleep(1000);
        const st = await new Promise(res => { try { chrome.storage.local.get(['jobbot_ng_job', 'jobbot_ng_done'], d => { void chrome.runtime.lastError; res(d || {}); }); } catch { res({}); } });
        if (!st.jobbot_ng_job) { done = st.jobbot_ng_done === 'done' ? 'done' : 'skip'; break; }
      }
      try { chrome.storage.local.remove(['jobbot_ng_job', 'jobbot_ng_done']); } catch {}
      this._ngTabHandled = done;
      return true;
    }

    async openJob(card) {
      // Naukri Gulf runs the tab-per-job flow above; naukri.com stays same-tab.
      if (this._isGulf()) return await this._openGulfJobTab(card);

      const link = this.cardLink(card);
      if (!link) return false;
      SPOT.pulse(link, `Opening: ${link.textContent.trim().substring(0, 60)}`);
      await sleep(rand(300, 700));
      const before = location.href;
      // Drive the CURRENT tab straight to the job URL. Naukri job anchors open in
      // a NEW tab (target=_blank / an onclick that calls window.open) — CLICKING
      // them spawns extra tabs the run can't follow. Navigating via location.assign
      // reads the href WITHOUT clicking, so the onclick never fires: the apply →
      // back-to-list → next-job sequence stays in ONE tab. Falls back to a click
      // for tiles with no real href.
      const href = link.tagName === 'A' ? (link.href || link.getAttribute('href') || '') : '';
      if (href && !/^javascript:/i.test(href)) {
        try { link.setAttribute('target', '_self'); } catch {}
        try { location.assign(href); } catch { realClick(link); }
        await sleep(rand(2000, 3000));
        return true;
      }
      // Recommended-job tiles put the click handler on the card, not the
      // <p class="title"> – if nothing happened, click the card itself.
      realClick(link);
      await sleep(rand(2000, 3000));
      if (location.href === before) {
        realClick(card);
        await sleep(rand(1800, 2600));
      }
      return true;
    }

    // Naukri has two buttons: "Apply" (on-platform, automatable) and
    // "Apply on company site" (external tab – we can't fill that, so skip).
    findApplyButton() {
      // ── Naukri Gulf (naukrigulf.com) — SEPARATE from naukri.com. It uses ONLY
      //    the "Easy Apply" button and NEVER naukri.com's "Apply"/#apply-button
      //    logic below. This block is self-contained and always returns for
      //    naukrigulf, so the two platforms never mix. ────────────────────────
      if (location.hostname.includes('naukrigulf')) {
        const already = $$('button, a, [class*="apply" i]')
          .find(b => isVis(b) && /\balready applied\b|^applied$/i.test((b.textContent || '').trim()));
        if (already) return { btn: null, external: false, already: true };
        // The robust primary "Easy Apply" finder (handles icon+text, role=button,
        // excludes the filter chip). Class/id selectors are a secondary fallback.
        const ea =
          this._gulfEasyApply() ||
          $('button[class*="easy-apply" i], button[class*="easyApply" i], [id*="easyApply" i]');
        if (ea && isVis(ea)) return { btn: ea, external: false };
        // "Apply on company site" → external, skip. Never fall through to naukri.
        const company = $$('button, a')
          .find(b => isVis(b) && /apply on company|company\s*site|external/i.test(b.textContent || ''));
        if (company) return { btn: null, external: true };
        return { btn: null, external: false }; // Easy Apply not hydrated yet → retry
      }

      // Company-site button – must detect first so we can skip those jobs
      const company = $$(
        '#company-site-button, [class*="company-site"], [class*="companySite"], ' +
        'a[class*="apply"][href*="://"][href*="apply"], button[id*="company"]'
      ).find(isVis);

      // "Already Applied" state – button text flips
      const alreadyEl = $$('#apply-button, button, [class*="apply"]')
        .find(b => isVis(b) && /\balready applied\b|^applied$/i.test(b.textContent.trim()));
      if (alreadyEl) return { btn: null, external: false, already: true };

      // Primary Naukri Apply button – wide net of selectors
      const apply =
        $('#apply-button') ||
        $('[class*="apply-button"]:not([class*="company"]):not([class*="similar"])') ||
        $('a[id*="apply"]:not([id*="company"]), button[id*="apply"]:not([id*="company"])') ||
        $$('button, a').find(b =>
          isVis(b)
          && /^apply$/i.test(b.textContent.trim())
          && !/company\s*site|external/i.test(b.textContent)
          && !b.closest('aside, [class*="sidebar"], [class*="similar"], [class*="interested"]')
        );

      if (apply && isVis(apply) && !/\balready applied\b|^applied$/i.test(apply.textContent)) {
        return { btn: apply, external: false };
      }
      if (apply && /\balready applied\b|^applied$/i.test(apply.textContent)) {
        return { btn: null, external: false, already: true };
      }
      if (company && !apply) return { btn: null, external: true };
      return { btn: null, external: false };
    }

    async clickApply() {
      // Wait up to 10s for the Apply button to hydrate after page load
      SPOT.status('⏳ Looking for Apply button…', 'info');
      let { btn, external, already } = this.findApplyButton();
      if (!btn && !external && !already) {
        for (let w = 0; w < 20; w++) {
          await sleep(500);
          ({ btn, external, already } = this.findApplyButton());
          if (btn || external || already) break;
        }
      }
      if (already) return 'already';
      if (external) return 'external';
      if (!btn) return false;

      // Smooth scroll + cursor glide + spotlight before clicking. On naukrigulf
      // give the Easy Apply CTA a clear, held spotlight so it's obvious the agent
      // located it before clicking (the user asked for a clean, visible target).
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(600, 900));
      if (this._isGulf()) {
        SPOT.pulse(btn, '🎯 Easy Apply — clicking…');
        await sleep(rand(500, 900));
        await humanClick(btn, '🎯 Easy Apply — clicking…');
      } else {
        await humanClick(btn, '🎯 Clicking APPLY…');
      }
      // Native-click fallback: some Naukri / Naukri Gulf React buttons ignore a
      // synthetic click. Only fire it if neither the chatbot NOR the Gulf apply
      // form modal has opened, so a working click is never double-fired. Also
      // nudge the inner text span some builds bind the handler to.
      await sleep(rand(150, 350));
      if (!this.chatbot() && !this._gulfModal() && !this.isApplied()) {
        try { btn.click(); } catch {}
        try { const inner = btn.querySelector('span, div'); if (inner) inner.click(); } catch {}
      }

      // Success = the question drawer opens OR the Gulf "Submit & Apply" form
      // modal opens OR an instant-apply toast fires. Naukri's button can swallow
      // early clicks while JS hydrates – retry twice.
      for (let i = 0; i < 14; i++) {
        await sleep(700);
        if (this.chatbot() || this._gulfModal() || this.isApplied()) return true;
        // Retry at 3s and 7s if the button is still there — synthetic + native.
        if ((i === 4 || i === 9) && btn.isConnected && isVis(btn)
            && !/already applied|applied/i.test(btn.textContent)) {
          SPOT.pulse(btn, '🎯 Re-clicking APPLY…');
          await humanClick(btn, '🎯 Re-clicking APPLY…');
          try { btn.click(); } catch {} // native fallback for React buttons
        }
      }
      return !!(this.chatbot() || this._gulfModal() || this.isApplied());
    }

    // The apply chatbot drawer that pops in after clicking Apply
    chatbot() {
      return $(
        '.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], ' +
        'div._chatBotContainer, .chatbot_MessageContainer, ' +
        '[class*="chatBotContainer"], [class*="chatbot-container"], ' +
        '[class*="applyDrawer"], [class*="apply-drawer"], ' +
        '[class*="apply-popup"], [id*="chatbot"], [id*="applyChat"]'
      );
    }

    isApplied() {
      // Naukri Gulf success: "You have successfully applied to 'X'".
      if (location.hostname.includes('naukrigulf') && $$('h1, h2, h3, [role="heading"], p')
            .some(el => isVis(el) && /you have successfully applied to|successfully applied/i.test(el.textContent || ''))) {
        return true;
      }
      // Green success toast / confirmation message
      if ($$('[class*="apply"], [class*="success"], [class*="toast"], ' +
              '[class*="confirmation"], [class*="submitted"]')
            .some(el => isVis(el) && /successfully applied|application sent|you have applied|application submitted|applied successfully/i.test(el.textContent))) {
        return true;
      }
      // Apply button text flips to "Applied" or "Already Applied"
      const btns = $$('#apply-button, [class*="apply-button"], button, a')
        .filter(b => isVis(b) && /^(already applied|applied)$/i.test(b.textContent.trim()));
      return btns.length > 0;
    }

    // Read the CURRENT question = the last REAL bot message. Works on both the
    // old drawer (li.botItem / .botMsg) and the 2026 SDUI drawer
    // (chatbot_MessageContainer > ul.list#chatList > li). Skips the "typing…"
    // dots indicator and the user's own answer bubbles, so the answer engine
    // always maps the actual question text (not dots / greeting / an old answer).
    chatQuestion(drawer) {
      const clean = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
      // A typing indicator or timestamp is not a question.
      const isNoise = t => !t || t.length < 3 || /^[.•·…•·●\s]+$/.test(t)
                        || /^\d+\s*(sec|min|hour|day)/i.test(t);
      const isUser = el => /\b(usr|user|self|right|my-?msg|userItem|sent|reply|answer)\b/i
                             .test(el.getAttribute('class') || '');

      const box = $('[class*="MessageContainer"], ul[id*="chatList"], ul[id*="Messages"]', drawer) || drawer;

      // 1) Explicit bot bubbles first (old + new class names).
      let bubbles = $$('li.botItem, li[class*="botItem"], [class*="botMsg"]', box).filter(isVis);
      // 2) Otherwise every message row that isn't the user's own answer.
      if (!bubbles.length) bubbles = $$('li', box).filter(el => isVis(el) && !isUser(el));
      // 3) Last resort: any message-ish node.
      if (!bubbles.length) bubbles = $$('[class*="botMsg"], [class*="Msg"], [class*="message"], [class*="bubble"], p', box)
        .filter(el => isVis(el) && !isUser(el));

      const texts = bubbles.map(clean).filter(t => !isNoise(t));
      return texts.length ? texts[texts.length - 1] : '';
    }

    // Answer one chatbot question: chips, radios, checkboxes, or free text.
    // `attempt` rises when the same question survives a Save – later attempts
    // switch strategy (AI first, alternate option) instead of repeating a miss.
    async answerChat(drawer, attempt = 1) {
      const question = this.chatQuestion(drawer);

      // Consent / agreement / declaration questions → always answer Yes / agree
      // / tick and continue (per the user's request).
      const isConsent = /\b(agree|consent|accept|acknowledg|declare|authori[sz]e|abide|comply|terms|conditions|privacy|hereby|declaration|willing to (proceed|share|provide|comply))\b/i.test(question);

      // Notice-period buckets: profile stores free text ("30 days") but Naukri
      // offers ranges - parse the days and pick the right bucket directly.
      const noticeIdx = (labels) => {
        if (!/notice/i.test(question)) return -1;
        const days = parseInt((this.f.p.professional?.noticePeriod || '30').match(/\d+/)?.[0] || '30', 10);
        const want = days <= 15 ? /15 days|immediate/i
                   : days <= 31 ? /^1 month/i
                   : days <= 62 ? /^2 month/i
                   : days <= 93 ? /^3 month/i
                   : /more than 3/i;
        return labels.findIndex(l => want.test(l.trim()));
      };

      // Resolve which option to pick: deterministic mapping → profile → AI →
      // "Skip this question" (never silently submit a wrong guess).
      const choose = async (labels) => {
        // Consent → pick the affirmative option (Yes / Agree / Accept …).
        if (isConsent) {
          const yi = labels.findIndex(l => /\b(yes|agree|i agree|accept|i accept|ok(ay)?|sure|proceed|confirm|allow)\b/i.test(l));
          return yi >= 0 ? yi : 0;
        }
        let idx = noticeIdx(labels);
        if (idx >= 0) return idx;
        let pick = this.f.bestOption(question, labels);
        if (!pick) {
          const ai = await this.f.aiAnswer(question, labels);
          if (ai) pick = labels.find(o => o.toLowerCase() === ai.toLowerCase())
                      || labels.find(o => o.toLowerCase().includes(ai.toLowerCase())
                                       || ai.toLowerCase().includes(o.toLowerCase()));
        }
        if (pick) return labels.findIndex(o => o === pick);
        const skip = labels.findIndex(l => /skip this question/i.test(l));
        if (skip >= 0) return skip;
        // No confident answer and no "skip" option → signal the caller to hand
        // this question to the human (-1) instead of guessing wrong.
        return -1;
      };

      // Naukri's chat textbox often validates numbers-only (CTC in lakhs,
      // years of experience). Feeding it "12 LPA" silently fails – coerce.
      const fitAnswer = (input, ans) => {
        if (ans == null) return ans;
        ans = String(ans);
        const numericQ = /\b(in (years?|yrs|lakhs?|lpa|months?)|how many|number of|years? of|ctc|salary|percentage|%)\b/i.test(question);
        const numericInput = input && (input.inputMode === 'numeric' || input.type === 'number'
          || input.getAttribute?.('inputmode') === 'numeric');
        if (numericQ || numericInput) {
          const m = ans.match(/\d+(\.\d+)?/);
          if (m) return m[0];
        }
        return ans;
      };

      // Free-text into Naukri's contenteditable <div class="textArea">:
      // Type character-by-character via execCommand so the chatbot's input
      // handler fires on every keystroke (enabling Save as text accumulates).
      // A single bulk insertText often leaves Save disabled; direct textContent
      // assignment bypasses Vue's reactivity entirely.
      const typeChat = async (input, ans) => {
        if (!ans) return;
        const str = String(ans).trim();
        if (!str) return;
        input.focus();
        await sleep(rand(100, 200));
        if (input.isContentEditable) {
          // Clear any existing text first
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(input);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete', false, null);
          } catch {}
          await sleep(rand(40, 80));
          // Type char-by-char: each insertText fires the chatbot's input handler
          let typed = 0;
          for (const ch of str) {
            try {
              if (document.execCommand('insertText', false, ch)) typed++;
              else break;
            } catch { break; }
            await sleep(rand(18, 45));
          }
          // Fallback when execCommand unavailable (very old/locked environments)
          if (typed < str.length) {
            input.textContent = str;
            try {
              const sel = window.getSelection();
              const r = document.createRange();
              r.selectNodeContents(input); r.collapse(false);
              sel.removeAllRanges(); sel.addRange(r);
            } catch {}
          }
          // Fire events so Vue/React detects the final value
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, composed: true,
            inputType: 'insertText', data: str,
          }));
          await sleep(rand(50, 100));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true, cancelable: true, key: str.slice(-1) || 'a',
          }));
        } else {
          await typeInto(input, ans);
        }
      };

      // 1) Radio buttons – click the <input> itself, NOT the wrapper
      //    (clicking the container lands in padding and never registers)
      let radioWraps = $$('div.ssrc__radio-btn-container, [class*="ssrc__radio"]', drawer)
        .map(w => ({ input: $('input[type="radio"], input.ssrc__radio', w) || (w.matches('input') ? w : null),
                     label: ($('.ssrc__label', w) || w).textContent.trim() }))
        .filter(r => r.input && r.label);
      if (!radioWraps.length) {
        // Generic fallback for restyled drawers (e.g. the pill-row layout)
        radioWraps = $$('input[type="radio"]', drawer)
          .map(input => ({ input, label: (input.closest('label') || input.parentElement)?.textContent.trim() || '' }))
          .filter(r => r.label);
      }
      if (radioWraps.length) {
        const idx = await choose(radioWraps.map(r => r.label));
        if (idx < 0) return 'needhuman';               // can't answer → buzz the user
        const r = radioWraps[idx] || radioWraps[0];
        await humanClick(r.input.closest('label') || r.input, `🔘 Selecting: "${r.label.slice(0, 40)}"`);
        realClick(r.input); // the input itself must register, not just the label
        if (!r.input.checked) {
          r.input.checked = true;
          r.input.dispatchEvent(new Event('change', { bubbles: true }));
          r.input.dispatchEvent(new Event('input',  { bubbles: true }));
        }
        await sleep(rand(300, 600));
      } else {
        // 2) Chips (single & multi-select share the same class)
        const chips = $$('div.chatbot_Chip, [class*="chipItem"], [class*="chatbot_Chip"]', drawer)
          .filter(c => isVis(c) && c.textContent.trim());
        // 3) Multi-select checkboxes
        const checks = $$('.multicheckboxes-container .mcc__checkbox, [class*="mcc__"] label', drawer)
          .filter(c => isVis(c) && c.textContent.trim());
        const optEls = chips.length ? chips : checks;

        if (optEls.length) {
          const opts = optEls.map(c => c.textContent.trim());
          const idx = await choose(opts);
          if (idx < 0) return 'needhuman';             // can't answer → buzz the user
          const el = optEls[idx] || optEls[0];
          await humanClick(el, `🔘 Selecting: "${el.textContent.trim().slice(0, 40)}"`);
          await sleep(rand(300, 600));
        } else {
          // 4) Free text. Old drawer: contenteditable <div class="textArea">.
          //    2026 SDUI: the field lives in chatbot_InputContainer /
          //    chatbot_SendMessageContainer (inside the footer). Search the whole
          //    chatbot root so the field is found wherever it renders.
          const inputRoot = drawer.closest('[class*="chatbot_right"]') || drawer.parentElement || drawer;
          const input =
            $('[class*="InputContainer"] [contenteditable="true"], [class*="SendMessageContainer"] [contenteditable="true"], ' +
              '[class*="InputContainer"] textarea, [class*="InputContainer"] input, ' +
              '[class*="InputContainer"] [role="textbox"]', inputRoot)
            || $('div.textArea[contenteditable="true"], [class*="textArea"][contenteditable="true"], ' +
              '[contenteditable="true"], [role="textbox"], textarea, ' +
              'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], ' +
              'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])',
              inputRoot);
          if (input && isVis(input)) {
            // Consent → "Yes". Otherwise map → AI (AI first on a retry). If we
            // still have no answer, hand it to the human instead of guessing.
            let ans = isConsent ? 'Yes'
              : (attempt > 1
                  ? (await this.f.aiAnswer(question) || this.f.map(question))
                  : (this.f.map(question) || await this.f.aiAnswer(question)));
            if (!ans && !isConsent) return 'needhuman'; // can't answer → buzz the user
            if (!ans) ans = 'Yes';
            ans = fitAnswer(input, ans);
            SPOT.pulse(input, `⌨️ Answering: "${question.slice(0, 40)}"`);
            await typeChat(input, ans);
            await sleep(rand(300, 600));
          }
        }
      }

      // 5) Click the chatbot's Save. STRICT: the Naukri chatbot Save is a
      //    <div class="sendMsg">Save</div> inside a sendMsgbtn_container / .send
      //    (a SIBLING of the message drawer). It is NOT a <button>. The job page
      //    has its OWN "Save job" bookmark <button class="…save-job-button…">Save
      //    </button> right next to Apply — clicking THAT is the bug in the report.
      //    So we ONLY ever match the chatbot's div.sendMsg and explicitly exclude
      //    anything inside a <button> or a save-job/bookmark node. Never a generic
      //    button/div with the text "Save".
      const saveOk = el =>
        isVis(el)
        && /^(save|send|submit)$/i.test((el.textContent || '').trim())
        && !el.closest('button, [class*="save-job" i], [class*="saveJob" i], [class*="bookmark" i], [id*="save-job" i]');
      const findSave = () => [
        ...$$('div.sendMsg'),
        ...$$('[id^="sendMsgbtn_container"] .sendMsg, [id^="sendMsgbtn_container"] div[tabindex], [class*="sendMsgbtn"] .sendMsg'),
        ...$$('[id^="sendMsg__"], [class*="sendMsgbtn"] .send'),
      ].filter(saveOk).find(el => el) || null;
      const looksDisabled = el =>
        el.disabled || el.getAttribute('aria-disabled') === 'true'
        || /\bdisabled\b/i.test(el.className)
        || parseFloat(getComputedStyle(el).opacity) < 0.55;

      // Wait up to ~6 s for Save to enable, polling every 600 ms.
      // On the last two tries click it even if it still looks disabled
      // (Naukri sometimes keeps the class but removes the actual guard).
      for (let i = 0; i < 10; i++) {
        const send = findSave();
        const forceClick = i >= 8;
        if (send && isVis(send) && (!looksDisabled(send) || forceClick)) {
          SPOT.pulse(send, '💾 Clicking SAVE…');
          await sleep(rand(300, 500));
          await humanClick(send, '💾 Saving answer…');
          await sleep(rand(900, 1600));
          return true;
        }
        // Show waiting status on first poll so the user can see activity
        if (i === 0) SPOT.status('⏳ Waiting for Save to enable…', 'applying');
        await sleep(600);
      }

      // Save never enabled – try Enter in the textbox (Naukri accepts it)
      const box = $('div.textArea[contenteditable="true"], [contenteditable="true"], textarea, input', drawer);
      if (box && isVis(box) && (box.textContent?.trim() || box.value?.trim())) {
        SPOT.pulse(box, '↵ Sending with Enter…');
        box.focus();
        const k = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        box.dispatchEvent(new KeyboardEvent('keydown',  k));
        box.dispatchEvent(new KeyboardEvent('keypress', k));
        box.dispatchEvent(new KeyboardEvent('keyup',    k));
        await sleep(rand(900, 1600));
        return true;
      }
      return false;
    }

    // A question we can't answer confidently → hand it to the human. Spotlight
    // the drawer + fire a desktop buzz, and resume automatically the moment the
    // user answers (the question changes), the drawer closes, or the apply
    // succeeds. The 90s auto-skip timer is disarmed so the user isn't rushed;
    // only a ~10-min no-response window falls through to a skip.
    // The human's most recent answer bubble in the chatbot (their chip pick,
    // radio label, or typed text all become a user message). Used to LEARN what
    // the user answered so the same question is auto-filled next time.
    _lastUserAnswer(drawer) {
      const box = $('[class*="MessageContainer"], ul[id*="chatList"], ul[id*="Messages"]', drawer) || drawer;
      const isUser = el => /\b(usr|user|self|right|my-?msg|userItem|sent|reply|answer)\b/i.test(el.getAttribute('class') || '');
      const users = $$('li', box).filter(el => isVis(el) && isUser(el));
      const last = users[users.length - 1];
      const t = last ? (last.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return (t && t.length <= 300) ? t : '';
    }

    async waitForHumanAnswer(question) {
      this._disarmJobTimer();
      const drawer = this.chatbot();
      SPOT.attention(drawer || document.body,
        `❓ Please answer this question — I'll continue automatically once you do:  "${(question || '').slice(0, 70)}"`);
      notifyUser('JobBot needs you', `A Naukri question needs your answer: "${(question || '').slice(0, 90)}". Type it and I'll continue.`);
      // Remember the human's answer for next time so we never re-ask this question.
      const learnIt = (d) => { try { const a = this._lastUserAnswer(d); if (a && question) learnedAnswers.set(question, a); } catch {} };
      for (let i = 0; i < 600 && this.running; i++) { // wait up to ~10 min
        await sleep(1000);
        if (this.isApplied()) { learnIt(this.chatbot() || drawer); SPOT.clearAttention(); return 'done'; }
        const d2 = this.chatbot();
        if (!d2) { learnIt(drawer); SPOT.clearAttention(); return 'continue'; }                     // drawer closed → moved on
        if (this.chatQuestion(d2) !== question) { learnIt(d2); SPOT.clearAttention(); return 'continue'; } // answered → next question
        if (i > 0 && i % 45 === 0) notifyUser('JobBot still waiting', 'A Naukri question is still open — please answer it and I\'ll continue.');
      }
      SPOT.clearAttention();
      return 'stuck';
    }

    async handleForm() {
      if (this.isApplied()) return 'done';

      // Naukri Gulf: the Easy-Apply modal is a DIRECT FORM ("Submit & Apply"),
      // not the chatbot. Handle it first; returns null if no gulf modal is open
      // (so naukri.com falls straight through to the chatbot path below).
      if (this._isGulf()) {
        const g = await this._handleGulfForm();
        if (g) return g;
      }

      const drawer = this.chatbot();
      if (drawer) {
        this._sawDrawer = true;

        // Track per-question attempts so the loop answers EVERY question in
        // sequence instead of hammering one that didn't register – and walks
        // away after 3 failed tries rather than looping forever.
        const sig = this.chatQuestion(drawer);

        // The chatbot opens with a greeting/instruction and a "typing…" dots
        // indicator BEFORE the first real question loads. Don't answer or Save
        // that greeting (that's when the wrong button used to get clicked) —
        // wait for the actual question to appear, then handle it.
        if (!sig || /thank you for showing interest|answer all (of )?the recruiter'?s? questions|kindly answer all/i.test(sig)) {
          await sleep(rand(900, 1600));
          return 'continue';
        }

        this._qTries = this._qTries || new Map();
        const attempt = (this._qTries.get(sig) || 0) + 1;
        this._qTries.set(sig, attempt);
        if (attempt > 3) {
          SPOT.status('Question won\'t accept an answer – skipping this job', 'warning');
          return 'stuck';
        }
        if (attempt === 1 && sig) SPOT.status(`❓ Q${this._qTries.size}: ${sig.slice(0, 60)}`, 'applying');

        const ansRes = await this.answerChat(drawer, attempt);
        // Couldn't answer confidently → buzz the user and wait for their answer.
        if (ansRes === 'needhuman') {
          const hr = await this.waitForHumanAnswer(sig);
          if (hr === 'done')  return 'done';
          if (hr === 'stuck') return 'stuck';
          this._armJobTimer(); // human answered → resume normal per-job timeout
          return 'continue';
        }

        // Wait for progression: next question appears, drawer closes, or the
        // success toast fires. This is what carries multi-question flows.
        for (let i = 0; i < 10; i++) {
          await sleep(800);
          if (this.isApplied()) return 'done';
          const d2 = this.chatbot();
          if (!d2 || this.chatQuestion(d2) !== sig) break;
        }
        return 'continue';
      }

      // Drawer was open and is now gone → the question flow completed
      if (this._sawDrawer) {
        await sleep(rand(800, 1400));
        return this.isApplied() || !this.chatbot() ? 'done' : 'continue';
      }

      // No chatbot and no success yet – clicking Apply may apply instantly.
      // Give Naukri a moment to show the toast before deciding.
      await sleep(rand(800, 1400));
      if (this.isApplied()) return 'done';
      return 'stuck';
    }

    // Run the full apply sequence on a job detail page
    async applyHere() {
      // Naukri Gulf tab-per-job: _openGulfJobTab already applied the job in its
      // own tab and recorded the outcome. Report it directly instead of trying to
      // apply again on the list tab. (_ngTabHandled is null when we fell back to
      // same-tab navigation, so the normal flow runs on the detail page.)
      if (this._isGulf() && this._ngTabHandled) {
        const r = this._ngTabHandled; this._ngTabHandled = null;
        return r === 'done' ? 'done' : 'skip';
      }

      this._sawDrawer = false;
      this._qTries = new Map(); // fresh question memory per job
      const r = await this.clickApply();
      if (r === 'external') { SPOT.status('Apply on company site – skipping', 'warning'); return 'skip'; }
      if (r === 'already')  { SPOT.status('Already applied – skipping', 'info');        return 'skip'; }
      if (!r)               return 'skip';

      let steps = 0, misses = 0;
      while (steps < 25 && this.running && !this._skipNow) {
        const res = await this.handleForm();
        if (res === 'done') return 'done';
        if (res === 'stuck') { if (++misses >= 3) return 'skip'; }
        else misses = 0;
        steps++;
        await sleep(rand(700, 1500));
      }
      return 'skip';
    }

    async nextPage() {
      let btn =
        $('a[class*="pagination"][title="Next"], a.styles_btn-secondary__next, ' +
          '[class*="pagination"] a[class*="next"], a[title="Next"]') ||
        $$('a, button').find(a => isVis(a) && /^next( page)?\s*$|^>$/i.test(a.textContent.trim()));

      // Numbered pagination fallback: the link after the selected page number
      if (!btn) {
        const pages = $$('[class*="pagination"] a, [class*="pagination"] span').filter(el => isVis(el) && /^\d+$/.test(el.textContent.trim()));
        const cur = pages.findIndex(el =>
          el.tagName !== 'A' || el.className.match(/active|selected|current/i));
        if (cur >= 0 && pages[cur + 1] && pages[cur + 1].tagName === 'A') btn = pages[cur + 1];
      }

      if (!btn || btn.getAttribute('aria-disabled') === 'true') return false;
      SPOT.status('Page finished – moving to the next page…', 'info');
      await humanClick(btn, '➡️ Next page…');
      await sleep(rand(2800, 4200));
      return true;
    }

    async run() {
      this.running = true;

      // ── Post-apply confirmation page (Naukri /myapply/saveApply) ───────────
      // A job just got applied. Record it (its id is in strJobsarr=[…]) and
      // navigate STRAIGHT back to the saved search-results list to apply the
      // next job. This is the step that was stranding the run on the "Applied
      // to …" page. We never self-stop: only the user's Stop clears the flag,
      // and every exit here returns 'nav' so the watchdog keeps the run alive.
      if (this.isAppliedConfirmationPage()) {
        let jid = null;
        try { const m = decodeURIComponent(location.href).match(/strJobsarr=\D*(\d+)/); if (m) jid = 'nk:' + m[1]; } catch {}
        if (!jid || !appliedSet.has(jid)) {              // guard against a double count on refresh
          if (jid) appliedSet.add(jid);
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: (location.hostname.includes('naukrigulf') ? 'naukrigulf' : 'naukri'), title: document.title, url: location.href });
        }
        SPOT.status(`✓ Applied on Naukri! (${this.applied} total) – returning to job list…`, 'success');
        await sleep(rand(1200, 2200));
        const listUrl = await new Promise(res => {
          try { chrome.storage.local.get('jobbot_naukri_list', d => { void chrome.runtime.lastError; res(d?.jobbot_naukri_list || ''); }); }
          catch { res(''); }
        });
        if (listUrl && !/\/myapply\//i.test(listUrl)) { try { location.assign(listUrl); } catch { history.back(); } }
        else history.back();
        await sleep(rand(2500, 3500));
        return 'nav'; // keep the run flag alive → watchdog continues the run
      }

      // ── Detail page (resumed via full-page navigation mid-run) ─────────────
      // Apply, go back, return 'nav' → watchdog restarts us on the list page.
      if (this.onDetailPage()) {
        SPOT.status('⏳ Preparing to apply…', 'info');
        // Wait for full page load + React hydration before trying to apply
        for (let w = 0; w < 16 && document.readyState !== 'complete'; w++) {
          await sleep(500);
        }
        await sleep(rand(800, 1500));
        attemptedSet.add(normalizeJobId(location.href));
        this._armJobTimer();
        const out = await this.applyHere();
        this._disarmJobTimer();
        if (out === 'done') {
          appliedSet.add(normalizeJobId(location.href));
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: (location.hostname.includes('naukrigulf') ? 'naukrigulf' : 'naukri'), title: document.title, url: location.href });
          SPOT.status(`✓ Applied on Naukri! (${this.applied} total) – returning to list…`, 'success');
          await sleep(rand(1500, 2500));
        } else {
          this.skipped++;
          reportSkip();
          SPOT.status('Skipping – returning to job list…', 'warning');
          await sleep(rand(800, 1400));
        }
        // Return to the ORIGINAL search-results list. After a Naukri apply the
        // page sits on an "Applied to …" confirmation / recommendations screen
        // where history.back() is unreliable, so navigate straight to the saved
        // list URL when we have it — this is what makes the run leave the apply
        // page and continue with the next job in sequence.
        const listUrl = await new Promise(res => {
          try { chrome.storage.local.get('jobbot_naukri_list', d => { void chrome.runtime.lastError; res(d?.jobbot_naukri_list || ''); }); }
          catch { res(''); }
        });
        if (listUrl && listUrl !== location.href) { try { location.assign(listUrl); } catch { history.back(); } }
        else { history.back(); }
        await sleep(rand(2500, 3500));
        return 'nav'; // keep the run flag alive
      }

      SPOT.status('Naukri – scanning jobs…', 'info');

      // ── Search-results loop ───────────────────────────────────────────────
      // Labeled so inner code can `continue outer` to re-run waitForCards
      // (critical after history.back() — the SPA may still be rendering the
      // card list when execution returns from navigation).
      outer: while (this.running) {
        const cards = await waitForCards(() => this.jobCards(), 8, 1500);
        SPOT.status(`${cards.length} jobs on page`, 'info');

        // Remember THIS search-results URL. After an apply, Naukri lands on an
        // "Applied to …" confirmation / recommendations page, and history.back()
        // from there is unreliable — so the detail flow navigates straight back
        // to this saved list URL to continue with the next job in sequence.
        if (cards.length) { try { chrome.storage.local.set({ jobbot_naukri_list: location.href }); } catch {} }

        if (!cards.length) {
          const churn = pageChurn.get() + 1;
          pageChurn.set(churn);
          SPOT.status(`Nothing new on this page (${churn}/5) – looking further…`, 'info');
          await sleep(rand(2500, 4000));
          if (churn >= 5) {
            SPOT.status('No new jobs in the last 5 pages – monitoring… (✕ to stop)', 'info');
            this.running = false;
            return 'nav';
          }
          if (!await this.nextPage()) break;
          continue;
        }

        // Auto-add all unapplied visible cards to selectedSet in tick mode
        if (selectionMode()) {
          for (const card of cards) {
            const jid = this.cardId(card);
            if (jid && !appliedSet.has(jid) && !attemptedSet.has(jid))
              selectedSet.add(jid);
          }
        }

        // Find the next unprocessed card and apply it.
        // After each card we `continue outer` so waitForCards re-runs and the
        // full list is re-queried fresh (handles SPA re-renders + history.back).
        let processedThisPage = false;
        for (const card of this.jobCards()) {
          if (!this.running) break;
          const jid = this.cardId(card);
          const selMode = selectionMode();

          // Exit tick-mode when the queue is drained
          if (selMode && !selectedSet.size()) {
            _setSelMode(false);
            try { chrome.storage.local.remove('jobbot_selmode'); } catch {}
            SPOT.status('Ticked jobs done – continuing with all remaining jobs…', 'info');
          }

          if (selectionMode() && (!jid || !selectedSet.has(jid))) continue;
          if (jid && (appliedSet.has(jid) || attemptedSet.has(jid))) {
            if (jid) selectedSet.remove(jid);
            continue;
          }

          // ── Found an unprocessed card ─────────────────────────────────────
          // Human pace: wait BEFORE opening the job (before the per-job timer
          // arms), so a pause can never trip the 90s skip. No-op unless enabled.
          if (Pacer.enabled() && !(await Pacer.gate())) break; // daily cap → stop
          if (!this.running) break;
          if (jid) attemptedSet.add(jid);
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(rand(600, 1100));
          pageChurn.set(0);

          if (!await this.openJob(card)) {
            this.skipped++;
            reportSkip();
            processedThisPage = true;
            continue outer; // re-query the list fresh after failed open
          }

          this._armJobTimer();
          const out = await this.applyHere();
          this._disarmJobTimer();

          if (out === 'done') {
            this.applied++;
            if (jid) appliedSet.add(jid);
            appliedSet.add(normalizeJobId(location.href));
            // Naukri Gulf tab-per-job: the JOB tab already reported JOB_APPLIED
            // (in-place or on its confirmation page). Don't report again from the
            // list tab or the applied count would double. Same-tab platforms and
            // the same-tab Gulf fallback report here as usual.
            if (!(this._isGulf() && this._ngTabDidReport)) {
              report({ type: 'JOB_APPLIED', platform: (location.hostname.includes('naukrigulf') ? 'naukrigulf' : 'naukri'), title: document.title, url: location.href });
            }
            this._ngTabDidReport = false;
            SPOT.status(`✓ Applied! (${this.applied} total) – next job…`, 'success');
          } else {
            this.skipped++;
            reportSkip();
          }

          // If we ended up on a detail page (full navigation), go back to list.
          // Brief pause then continue outer — waitForCards handles the rest.
          if (this.onDetailPage()) {
            await sleep(rand(1000, 1800));
            history.back();
            await sleep(rand(600, 1000));
          } else {
            await sleep(rand(1200, 2000));
          }

          processedThisPage = true;
          continue outer; // always re-query via waitForCards after each card
        }

        // All cards on this page were skipped (already applied/attempted)
        if (!processedThisPage) {
          const churn = pageChurn.get() + 1;
          pageChurn.set(churn);
          SPOT.status(`Nothing new on this page (${churn}/5) – looking further…`, 'info');
          await sleep(rand(2500, 4000));
          if (churn >= 5) {
            SPOT.status('No new jobs in the last 5 pages – monitoring… (✕ to stop)', 'info');
            this.running = false;
            return 'nav';
          }
        } else {
          pageChurn.set(0);
        }
        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ─── Bayt Agent ───────────────────────────────────────────────────────────
  class BaytAgent {
    constructor(f) {
      this.f = f; this.applied = 0; this.skipped = 0; this.running = false;
      this._skipNow = false; this._jobTimer = null;
    }
    _armJobTimer(ms = rand(60000, 90000)) {
      clearTimeout(this._jobTimer);
      this._skipNow = false;
      const secs = Math.round(ms / 1000);
      this._jobTimer = setTimeout(() => {
        this._skipNow = true;
        SPOT.status(`⏱ Job taking too long (${secs}s) – skipping…`, 'warning');
      }, ms);
    }
    _disarmJobTimer() { clearTimeout(this._jobTimer); this._skipNow = false; }

    // Bayt keeps a "pending" job id in sessionStorage across the same-origin
    // hop list → apply page → confirmation page, so the confirmation page can
    // report exactly one JOB_APPLIED for the job whose Easy Apply we clicked.
    _setPending(id) { try { sessionStorage.setItem('jobbot_bt_pending', id || ''); } catch {} }
    _getPending()   { try { return sessionStorage.getItem('jobbot_bt_pending') || ''; } catch { return ''; } }
    _clearPending() { try { sessionStorage.removeItem('jobbot_bt_pending'); } catch {} }

    // ── The Bayt search-results list ──────────────────────────────────────
    // #jsMainListingContainer → .sticky-sidebar → #results_inner_card →
    //   <ul class="media-list in-card"> → <li data-js-job data-job-id="…">.
    // The lone <li id="mobile-job-alert"> is an ad slot, not a job.
    jobCards() {
      let cards = $$(
        '#results_inner_card ul.media-list li[data-job-id], ' +
        'ul.media-list.in-card li[data-job-id], ' +
        'li[data-js-job][data-job-id]'
      );
      if (!cards.length) cards = $$('li[data-job-id]');
      return cards.filter(c => isVis(c)
        && c.id !== 'mobile-job-alert'
        && c.getAttribute('data-job-id')
        && !c.closest('aside, [class*="similar"], [class*="related"], [class*="recommended"]'));
    }

    cardId(card) {
      const id = card.getAttribute('data-job-id');
      if (id) return 'bt:' + id;
      const a = $('h2 a[data-js-aid="jobID"], a[href*="/en/job/"]', card);
      if (a?.href) return normalizeJobId(a.href);
      return card.textContent.trim().slice(0, 80);
    }

    cardTitle(card) {
      const a = $('h2 a[data-js-aid="jobID"], h2 a, a[href*="/en/job/"]', card);
      return (a?.textContent || '').trim().slice(0, 60);
    }

    // The Easy-Apply button that lives on the card:
    //   <div class="jb-easy-apply"><a … href="/en/job/apply/index/XXXXX/?…">Easy Apply</a></div>
    // An applied card has an EMPTY .jb-easy-apply (no link) + a .t-success note.
    easyApplyLink(card) {
      // 1) The explicit Easy-Apply slot with an apply href / onclick handler.
      let a = $('.jb-easy-apply a[href*="/job/apply/"], .jb-easy-apply a[href*="apply/index"], ' +
               '.jb-easy-apply a[onclick], .jb-easy-apply a.btn', card);
      if (a && isVis(a)) return a;
      // 2) Any apply-index / apply anchor anywhere in the card.
      a = $('a[href*="/job/apply/index/"], a[href*="/en/job/apply/"], a[href*="/job/apply/"]', card);
      if (a && isVis(a)) return a;
      // 3) Match by the visible "Easy Apply" label (anchor or button).
      a = $$('a, button', card).find(el => isVis(el)
        && /easy\s*apply/i.test((el.textContent || el.getAttribute('title') || '').trim())
        && !/applied/i.test(el.textContent || ''));
      if (a) return a;
      // 4) Any clickable child inside a populated easy-apply slot.
      const slot = $('.jb-easy-apply', card);
      if (slot) { const c = $('a[href], button, [onclick]', slot); if (c && isVis(c)) return c; }
      return null;
    }

    // Already-applied card → skip. Bayt shows a green ".t-success" note
    // ("Applied on <date>") and empties the easy-apply slot.
    cardApplied(card) {
      const succ = $('.t-success, [class*="t-success"]', card);
      if (succ && isVis(succ) && /applied/i.test(succ.textContent)) return true;
      return false;
    }

    // ── Apply page (/en/job/apply/index/XXXXX/) ───────────────────────────
    applyNowBtn() {
      return $(
        'footer.form-footer button[type="submit"][name="submit"], ' +
        'button[type="submit"][name="submit"][value="submit"], ' +
        '.form-footer button[type="submit"]'
      ) || $$('button[type="submit"], input[type="submit"]').find(b =>
        isVis(b) && /apply now/i.test((b.textContent || b.value || '')));
    }

    isApplyPage() {
      return /\/job\/apply\//i.test(location.pathname) && !!this.applyNowBtn();
    }

    // The confirmation page after a successful apply carries a
    //   <a class="btn-primary" href="…?jobId=…">Return to job search</a>
    returnLink() {
      return $$('a.btn-primary, a[href*="jobId="], a[href*="/jobs/"], a[href*="/en/jobs"]').find(a =>
        isVis(a) && /return to (the )?job search|back to (the )?(job )?search|return to search|continue (job )?search/i.test(a.textContent));
    }

    isConfirmationPage() {
      if (this.returnLink()) return true;
      return $$('h1, h2, h3, p, [class*="success"], [class*="t-success"], [role="heading"]').some(el =>
        isVis(el) && /application (has been |was )?(sent|submitted)|successfully applied|thank you for applying|your application (has been|was)/i.test(el.textContent));
    }

    isApplied() { return this.isConfirmationPage(); }

    _reportApplied() {
      const pend = this._getPending();
      const fromUrl = (location.pathname.match(/\/job\/apply\/index\/(\d+)/i) || [])[1];
      const id = pend || (fromUrl ? 'bt:' + fromUrl : normalizeJobId(location.href));
      if (id && appliedSet.has(id)) { this._clearPending(); return; } // already counted
      this.applied++;
      if (id) appliedSet.add(id);
      report({ type: 'JOB_APPLIED', platform: 'bayt', title: document.title, url: location.href });
      SPOT.status(`✓ Applied on Bayt! (${this.applied} total)`, 'success');
      this._clearPending();
    }

    // Remember every answered question on this form (keyed by its label) so the
    // same question is auto-filled on future Bayt applications.
    _captureAnswers(scope) {
      try {
        for (const el of $$('input, textarea, select', scope)) {
          if (!isVis(el)) continue;
          const t = (el.type || '').toLowerCase();
          if (/^(hidden|submit|button|image|file|password)$/.test(t)) continue;
          let q = ''; try { q = this.f.labelFor(el); } catch {}
          if (!q) continue;
          let val = '';
          if (t === 'radio' || t === 'checkbox') {
            if (el.checked) val = (el.closest('label')?.textContent || el.value || '').trim();
          } else val = (el.value || '').trim();
          if (val) { try { learnedAnswers.set(q, val); } catch {} }
        }
      } catch {}
    }

    // Fill the Bayt "Additional questions" from your profile + remembered
    // answers, pause for you to complete anything still blank (buzzing you and
    // pausing the auto-skip so you aren't cut off), and LEARN every answer for
    // next time — then the caller submits.
    async _answerAndLearn(form) {
      const scope = (form && form !== document.body) ? form : ($('form') || document.body);

      // Shared engine: answers from profile + LEARNED answers, and attaches
      // learnFromField() to whatever it cannot fill.
      try { await this.f.all(scope); } catch {}

      const textFields = () => $$(
        'textarea, input[type="text"], input[type="number"], input[type="url"], ' +
        'input[type="email"], input[type="tel"], input:not([type])', scope
      ).filter(el => isVis(el) && !el.disabled && !el.readOnly);

      // Answer each blank question from profile+LEARNED (map consults learned
      // first), then AI; start learning anything still unanswered.
      for (const inp of textFields()) {
        if ((inp.value || '').trim()) continue;
        let q = ''; try { q = this.f.labelFor(inp); } catch {}
        let ans = q ? this.f.map(q) : null;
        if (!ans && q) { try { ans = await this.f.aiAnswer(q); } catch {} }
        if (!ans) { if (q) learnFromField(inp, q); SPOT.pulse(inp, `❓ ${(q || 'question').slice(0, 40)}`); continue; }
        SPOT.pulse(inp, `⌨️ ${q.slice(0, 40)}`);
        try { await typeInto(inp, ans); } catch {}
        await sleep(rand(250, 550));
      }

      // Remember whatever is filled so far.
      this._captureAnswers(scope);

      // Anything still blank → hand off to you. Pause the 60-90s skip timer so it
      // can't cut you off mid-typing, learn your answers as you go, then resume.
      const blanks = () => textFields().filter(el => !(el.value || '').trim());
      if (blanks().length) {
        blanks().forEach(el => { let q = ''; try { q = this.f.labelFor(el); } catch {} if (q) learnFromField(el, q); });
        this._disarmJobTimer();
        SPOT.attention(scope, '❓ Please answer the remaining question(s) — I\'ll remember your answers for next time, then submit.');
        notifyUser('JobBot needs you', 'A Bayt question needs your answer — fill it and I\'ll remember it for next time.');
        for (let i = 0; i < 240 && this.running; i++) {
          await sleep(1000);
          if (this.isConfirmationPage()) break;
          this._captureAnswers(scope);        // learn continuously as you type
          if (!blanks().length) break;        // all answered → submit
          if (i > 0 && i % 45 === 0) notifyUser('JobBot still waiting', 'A Bayt question is still open — answer it and I\'ll remember it and continue.');
        }
        SPOT.clearAttention();
        this._armJobTimer();
      }

      // Final capture just before the caller submits.
      this._captureAnswers(scope);
    }

    // Fill any prefilled/screening questions, then click "Apply now".
    async runApplication() {
      SPOT.status('Filling Bayt application…', 'applying');
      const form = $('form, .apply-form, [class*="apply-form"], [class*="application-form"]') || document.body;
      try { await this._answerAndLearn(form); } catch {}
      await sleep(rand(400, 800));

      let btn = this.applyNowBtn();
      if (!btn) {
        // Hydration lag — wait briefly for the footer button to appear.
        for (let w = 0; w < 8 && !btn && this.running && !this._skipNow; w++) {
          await sleep(500);
          btn = this.applyNowBtn();
        }
      }
      if (!btn) {
        if (this.isConfirmationPage()) { this._reportApplied(); return true; }
        SPOT.status('No "Apply now" button on Bayt form – skipping', 'warning');
        this.skipped++; reportSkip();
        await this.goBackToList();
        return false;
      }

      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(500, 900));
      SPOT.pulse(btn, '🎉 Clicking "Apply now" on Bayt…');
      await sleep(rand(400, 700));

      const before = location.href;
      realClick(btn);
      await sleep(rand(2000, 3200));

      // Submit usually navigates to a confirmation page (handled on next load).
      // If it stayed inline, detect success here.
      if (this.isConfirmationPage() || location.href !== before) {
        this._reportApplied();
        await sleep(rand(800, 1400));
        if (!(/\/job\/apply\//i.test(location.pathname))) await this.goBackToList();
        return true;
      }

      // Re-try the click once more, then assume it went through.
      if (this.applyNowBtn()) { realClick(btn); await sleep(rand(1500, 2500)); }
      this._reportApplied();
      await this.goBackToList();
      return true;
    }

    // Return to the results list. Prefer the on-page "Return to job search"
    // link; fall back to history.back().
    async goBackToList() {
      const rl = this.returnLink();
      if (rl) {
        rl.setAttribute('target', '_self');
        SPOT.pulse(rl, '↩ Returning to job search…');
        await sleep(rand(400, 700));
        const before = location.href;
        realClick(rl);
        await sleep(rand(2000, 3200));
        if (location.href === before) {
          try { location.assign(rl.href); } catch { try { location.href = rl.href; } catch {} }
          await sleep(rand(1800, 2800));
        }
        return true;
      }
      history.back();
      await sleep(rand(1800, 2800));
      return true;
    }

    // Reveal more results on the same page (#showMore "More Results" button).
    async loadMore() {
      const more = $('#showMore, a#showMore, button#showMore, a.jsShowMore, .show-more a, [id*="showMore"]');
      if (more && isVis(more) && !more.disabled && more.getAttribute('aria-disabled') !== 'true') {
        const before = this.jobCards().length;
        SPOT.status('Loading more Bayt results…', 'info');
        await humanClick(more, '➕ More results…');
        await sleep(rand(2200, 3600));
        return this.jobCards().length > before;
      }
      return false;
    }

    // Go to the next results page (#pagination li.pagination-next a — an
    // empty-text jsAjaxLoad link that loads page=N, in place).
    async nextPage() {
      const nextLi = $('#pagination li.pagination-next, .pagination li.pagination-next, li.pagination-next');
      if (nextLi && /disabled/i.test(nextLi.className)) return false;
      const btn =
        $('#pagination li.pagination-next a, .pagination li.pagination-next a, li.pagination-next a') ||
        $$('#pagination a.jsAjaxLoad, .pagination a.jsAjaxLoad').find(a =>
          isVis(a) && /[?&]page=\d+/i.test(a.getAttribute('href') || '') && !a.closest('li.disabled, li.pagination-prev'));
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return false;
      const li = btn.closest('li');
      if (li && /disabled/i.test(li.className)) return false;

      SPOT.status('Page finished – moving to the next page…', 'info');
      const before = location.href;
      await humanClick(btn, '➡️ Next page…');
      await sleep(rand(2800, 4200));
      // jsAjaxLoad loads in place (URL may not change) — either way, new cards
      // arrive; the run loop rescans on the next iteration.
      void before;
      return true;
    }

    async run() {
      this.running = true;

      // (1) Confirmation page after a successful apply → count it and go back.
      if (this.isConfirmationPage() && !this.isApplyPage()) {
        this._reportApplied();
        await sleep(rand(1000, 1800));
        await this.goBackToList();
        this.running = false;
        return 'nav';
      }

      // (2) Apply page (an Easy-Apply click navigated us here) → fill + submit.
      if (this.isApplyPage()) {
        attemptedSet.add(normalizeJobId(location.href));
        this._armJobTimer();
        try { await this.runApplication(); } catch {}
        this._disarmJobTimer();
        this.running = false;
        return 'nav';
      }

      // (3) The search-results list → find the next unapplied Easy-Apply card.
      SPOT.status('Bayt – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        if (!cards.length) {
          SPOT.status('No Bayt job cards found – open a Bayt Jobs search page', 'warning');
          break;
        }
        SPOT.status(`${cards.length} jobs on page`, 'info');

        const selMode = selectionMode();
        if (selMode && !selectedSet.size()) {
          SPOT.status('All selected jobs done – tick more or ✕ to stop', 'success');
          this.running = false;
          return 'nav';
        }

        let clicked = false;
        for (const card of this.jobCards()) {
          if (!this.running) break;
          const jid = this.cardId(card);
          if (selMode && (!jid || !selectedSet.has(jid))) continue;
          if (jid && (appliedSet.has(jid) || attemptedSet.has(jid))) { if (jid) selectedSet.remove(jid); continue; }
          if (this.cardApplied(card)) { if (jid) { appliedSet.add(jid); selectedSet.remove(jid); } continue; }

          let link = this.easyApplyLink(card);
          if (!link && $('.jb-easy-apply', card)) {
            // The Easy-Apply link often hydrates a beat after the card renders.
            // Wait once and re-check before giving up on this card — do NOT mark
            // it attempted, or a late link would be skipped for the whole run.
            await sleep(rand(700, 1100));
            link = this.easyApplyLink(card);
          }
          if (!link) continue; // genuinely no Easy Apply (external/company apply) → skip

          // Human pace: wait before starting a new application (the list page has
          // no job timer armed yet, so a pause can't trip a skip). No-op if off.
          if (Pacer.enabled() && !(await Pacer.gate())) break; // daily cap → stop
          if (!this.running) break;

          if (jid) { attemptedSet.add(jid); this._setPending(jid); }
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(rand(500, 900));
          SPOT.pulse(link, `Easy Apply: ${this.cardTitle(card)}`);
          await sleep(rand(400, 700));

          if (link.setAttribute) link.setAttribute('target', '_self');
          const before = location.href;
          realClick(link); // onclick="checkOnclickType(this);return false;" — JS-driven nav
          await sleep(rand(1800, 2800));
          // The onclick returns false (blocks the default), so if nothing moved and
          // it is a real link, navigate straight to its apply href ourselves.
          if (location.href === before && !this.isApplyPage()) {
            const href = link.getAttribute && link.getAttribute('href');
            if (href && /apply/i.test(href)) {
              try { location.assign(href); } catch { try { location.href = href; } catch {} }
              await sleep(rand(1800, 2800));
            }
          }
          clicked = true;
          break; // page is navigating; run() resumes on the apply page
        }

        if (clicked) { this.running = false; return 'nav'; }

        // Cards are present but none gave us an Easy-Apply link this pass. The
        // buttons can load late, so wait once and re-scan before paginating away
        // — this stops the agent from clicking through page after page without
        // ever applying.
        if (this.jobCards().length && !this._rescanned) {
          this._rescanned = true;
          SPOT.status('Waiting for Easy Apply buttons to load…', 'info');
          await sleep(rand(1600, 2600));
          continue;
        }
        this._rescanned = false;

        // No unapplied card left on this page → reveal more / go to next page.
        if (await this.loadMore()) continue;
        if (await this.nextPage()) continue;
        break;
      }

      SPOT.status(`Bayt – all visible jobs processed ✓ ${this.applied} applied`, 'info');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ─── Controller ───────────────────────────────────────────────────────────
  // Memory of already-handled jobs. Durable: chrome.storage.local survives the
  // cross-origin hops of the Indeed apply flow (www → smartapply), tab
  // navigations, and browser restarts, so a job is never applied to twice.
  // sessionStorage is kept as a synchronous fast path within the tab.
  // Key is versioned (v2): the previous build wrongly stored mere ATTEMPTS in
  // permanent memory, blocking re-tries forever. v2 holds confirmed
  // applications only; the polluted v1 data is simply ignored.
  const appliedSet = (() => {
    let s = new Set();
    try { s = new Set(JSON.parse(sessionStorage.getItem('jobbot_applied') || '[]')); } catch {}
    let resolveReady;
    const ready = new Promise(r => (resolveReady = r));
    try {
      chrome.storage.local.get('jobbot_applied_v2', d => {
        (Array.isArray(d.jobbot_applied_v2) ? d.jobbot_applied_v2 : []).forEach(id => s.add(id));
        resolveReady();
      });
    } catch { resolveReady(); }
    const persist = () => {
      const arr = [...s].slice(-3000);
      try { sessionStorage.setItem('jobbot_applied', JSON.stringify(arr)); } catch {}
      try { chrome.storage.local.set({ jobbot_applied_v2: arr }); } catch {}
    };
    return {
      ready,
      has: id => s.has(id),
      add: id => { if (!id) return; s.add(id); persist(); },
    };
  })();

  // Session-only memory of ATTEMPTED jobs (per tab). Prevents loops within a
  // run, but unlike appliedSet it does not survive the session – a job whose
  // apply failed today can be retried tomorrow. Only confirmed applications
  // go into the permanent appliedSet.
  //
  // IMPORTANT: sessionStorage is wiped on every cross-origin navigation (e.g.
  // indeed.com → apply.indeed.com). We back this up into chrome.storage.local
  // under a run-scoped key so it survives the hop and the agent never replays
  // a job it already attempted in the current run.
  const attemptedSet = (() => {
    let s = new Set();
    // Seed from both stores; chrome.storage.local read is async so we do a
    // best-effort sync seed from sessionStorage first, then merge async.
    try { s = new Set(JSON.parse(sessionStorage.getItem('jobbot_attempted') || '[]')); } catch {}
    const CKEY = 'jobbot_attempted_run';
    try {
      chrome.storage.local.get(CKEY, d => {
        (Array.isArray(d[CKEY]) ? d[CKEY] : []).forEach(id => s.add(id));
      });
    } catch {}
    const persist = () => {
      const arr = [...s].slice(-2000);
      try { sessionStorage.setItem('jobbot_attempted', JSON.stringify(arr)); } catch {}
      try { chrome.storage.local.set({ [CKEY]: arr }); } catch {}
    };
    return {
      has: id => s.has(id),
      add: id => { if (!id) return; s.add(id); persist(); },
      // An explicit user Start = a fresh run: forget mere attempts so the list
      // is re-scanned (permanent appliedSet still prevents re-applying).
      clear: () => {
        s = new Set();
        try { sessionStorage.removeItem('jobbot_attempted'); } catch {}
        try { chrome.storage.local.remove(CKEY); } catch {}
      },
    };
  })();

  // Stable job identity from a URL: prefer the jk/vjk job key (Indeed), else
  // origin+pathname – never the raw href, whose tracking params change between
  // visits and previously made the same job look "new" every time.
  function normalizeJobId(raw) {
    if (!raw) return '';
    const m = String(raw).match(/[?&](?:jk|vjk)=([a-f0-9]+)/i);
    if (m) return 'jk:' + m[1].toLowerCase();
    try { const u = new URL(raw, location.href); return u.origin + u.pathname; }
    catch { return String(raw); }
  }

  // Ticked jobs: the user queues specific jobs with the ✓ boxes; Start then
  // applies ONLY those in list order. No ticks = apply everything.
  //
  // Backed by chrome.storage.local so ticked jobs survive the cross-origin
  // indeed.com → apply.indeed.com hop that wipes sessionStorage. The in-memory
  // Set is the fast-path; chrome.storage is the durable source-of-truth.
  //
  // IMPORTANT: chrome.storage is ONLY restored when a run is active. If there
  // is no active run on page load we wipe both stores immediately so the user
  // never sees phantom checkmarks from a previous session.
  const selectedSet = (() => {
    let s = new Set();
    // Sync seed from sessionStorage first (instant, within same origin/tab)
    try { s = new Set(JSON.parse(sessionStorage.getItem('jobbot_selected') || '[]')); } catch {}
    const CKEY = 'jobbot_selected_run';
    try {
      // Combine the run-state check and the tick/selmode restore in ONE read so
      // there is no race between clearing stale data and re-seeding it.
      chrome.storage.local.get(['jobbot_running', CKEY, 'jobbot_selmode'], d => {
        if (d.jobbot_running) {
          // Active run (cross-origin hop): restore ticks + selection mode flag
          (Array.isArray(d[CKEY]) ? d[CKEY] : []).forEach(id => s.add(id));
          if (d.jobbot_selmode === '1') {
            try { sessionStorage.setItem('jobbot_selmode', '1'); } catch {}
          }
        } else {
          // No active run: delete every trace of stale selections so the user
          // always starts with a clean slate — no phantom checkmarks.
          s = new Set();
          try { sessionStorage.removeItem('jobbot_selected'); } catch {}
          try { sessionStorage.setItem('jobbot_selmode', '0'); } catch {}
          chrome.storage.local.remove([CKEY, 'jobbot_selmode']);
        }
      });
    } catch {}
    const persist = () => {
      const arr = [...s];
      try { sessionStorage.setItem('jobbot_selected', JSON.stringify(arr)); } catch {}
      try { chrome.storage.local.set({ [CKEY]: arr }); } catch {}
    };
    return {
      size: () => s.size,
      has: id => s.has(id),
      toggle(id) { s.has(id) ? s.delete(id) : s.add(id); persist(); return s.has(id); },
      add(id) { if (id) { s.add(id); persist(); } },
      remove(id) { s.delete(id); persist(); },
      // Wipe all selections (called when the user explicitly clears or stops)
      clear() {
        s = new Set();
        try { sessionStorage.removeItem('jobbot_selected'); } catch {}
        try { sessionStorage.setItem('jobbot_selmode', '0'); } catch {}
        chrome.storage.local.remove([CKEY, 'jobbot_selmode']);
      },
    };
  })();

  // selectionMode: also backed by chrome.storage.local so the flag survives
  // cross-origin hops — reading from both stores, writing to both.
  const selectionMode = () => {
    try { return sessionStorage.getItem('jobbot_selmode') === '1'; } catch { return false; }
  };
  // Keep chrome.storage in sync with the sessionStorage flag on every write
  const _setSelMode = (on) => {
    try { sessionStorage.setItem('jobbot_selmode', on ? '1' : '0'); } catch {}
    try { chrome.storage.local.set({ jobbot_selmode: on ? '1' : '0' }); } catch {}
  };
  // NOTE: selmode re-seed from chrome.storage is handled inside the selectedSet
  // IIFE above (combined with the run-state check) so there is no separate read.

  // Consecutive result-pages with nothing new to apply to. Persisted in
  // chrome.storage.local (survives cross-origin hops that wipe sessionStorage).
  const pageChurn = {
    get: () => { try { return parseInt(sessionStorage.getItem('jobbot_churn'), 10) || 0; } catch { return 0; } },
    set: n => {
      try { sessionStorage.setItem('jobbot_churn', String(n)); } catch {}
      try { chrome.storage.local.set({ jobbot_churn: n }); } catch {}
    },
  };
  // Re-seed pageChurn from chrome.storage on cross-origin reload
  try {
    chrome.storage.local.get('jobbot_churn', d => {
      if (d.jobbot_churn != null) {
        try { sessionStorage.setItem('jobbot_churn', String(d.jobbot_churn)); } catch {}
      }
    });
  } catch {}

  let agent = null;
  let lastDoneAt = 0; // when a full pass finished; throttles monitor-mode re-scans
  const IS_TOP = window === window.top;

  // A run is bound to the ONE tab where the user pressed Start: the running
  // flag stores that tab's id. Other tabs / freshly opened pages never
  // auto-start; the running tab still resumes across its own navigations.
  let MY_TAB = null;
  const tabReady = new Promise(res => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, r => {
        void chrome.runtime.lastError;
        MY_TAB = r?.tabId ?? null;
        res();
      });
    } catch { res(); }
  });
  // true/legacy boolean flags match any tab; numeric flags must match ours
  const flagMatchesThisTab = flag =>
    !!flag && (flag === true || MY_TAB === null || flag === MY_TAB);

  // ─── Background keep-alive ──────────────────────────────────────────────────
  // When the user switches to another tab, Chrome throttles this tab's timers
  // (after ~5 min it clamps setTimeout/setInterval to roughly once per minute),
  // which stalls the agent's human-like sleep() loops so it appears to stop.
  // A tab that is "playing audio" is exempt from this intensive throttling, so
  // while a run is active we keep a permanently-inaudible Web-Audio tone going.
  // It produces no perceptible sound (gain ~0.0001, sub-audible frequency) and
  // is fully torn down on Stop. Everything is wrapped so a blocked AudioContext
  // (autoplay policy) can NEVER affect the run itself. Top frame only.
  const KeepAlive = (() => {
    let ctx = null, osc = null, gain = null, resumer = null, watch = null, on = false;
    // Only touch Web-Audio once the page has actually had a user gesture.
    // Creating/resuming an AudioContext without one just gets suspended by
    // Chrome's autoplay policy (so it can't keep the tab alive anyway) AND logs
    // a console warning — so we defer until a gesture and avoid both.
    const gestured = () => !('userActivation' in navigator) || navigator.userActivation.hasBeenActive;
    const kick = () => { try { if (ctx && ctx.state === 'suspended' && gestured()) ctx.resume(); } catch {} };
    function build() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      gain = ctx.createGain();
      // Low frequency + tiny gain: inaudible on normal speakers (which roll off
      // far above 30 Hz), but it is REAL audio output — enough for Chrome's audio
      // service to mark the tab "audible", which exempts it from background
      // timer throttling so the agent keeps running while you're on another tab.
      gain.gain.value = 0.006;
      osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 30;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
    }
    // Build once (after a gesture), else just resume if suspended.
    const ensure = () => { try { if (!ctx) { if (gestured()) { build(); kick(); } } else kick(); } catch {} };
    function start() {
      if (on || !IS_TOP) return;
      on = true;
      try {
        ensure();
        // Autoplay policy can leave the context suspended until a gesture / focus
        // change — build/resume on any of these, and via a watchdog below.
        resumer = () => ensure();
        document.addEventListener('visibilitychange', resumer, true);
        document.addEventListener('pointerdown', resumer, true);
        document.addEventListener('keydown', resumer, true);
        // Keep it alive: build once a gesture lands, resume if suspended.
        watch = setInterval(ensure, 4000);
      } catch {}
    }
    function stop() {
      on = false;
      try { clearInterval(watch); } catch {} watch = null;
      try { document.removeEventListener('visibilitychange', resumer, true); } catch {}
      try { document.removeEventListener('pointerdown', resumer, true); } catch {}
      try { document.removeEventListener('keydown', resumer, true); } catch {}
      resumer = null;
      try { if (osc) osc.stop(); } catch {}
      try { if (ctx) ctx.close(); } catch {}
      osc = gain = ctx = null;
    }
    return { start, stop };
  })();

  async function startAgent(profile) {
    if (agent?.running) return;
    if (!['linkedin', 'indeed', 'naukri', 'naukrigulf', 'bayt'].includes(PLATFORM)) {
      SPOT.status('Not a supported job site', 'error'); return;
    }

    // Paywall: the agent runs only for an account with an active paid licence.
    // Ask the background worker (it holds the CRM token + a cached result).
    const lic = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_LICENSE' }, r => { void chrome.runtime.lastError; res(r || {}); });
      } catch { res({}); }
    });
    if (!lic.active) {
      const msg = lic.reason === 'no-key'  ? '🔑 Enter your license key in Prefs, then press Start'
                : lic.reason === 'bad-key' ? '🔑 Invalid or revoked license key — check it in Prefs'
                : lic.reason === 'expired' ? '⌛ Your license key has expired — get a new one from the admin'
                : lic.reason === 'device'  ? '🔒 This key is now active on another device. Open Prefs and press Save & Activate to use it here.'
                : lic.reason === 'offline' ? '🔒 Could not verify your key (offline). Check your connection.'
                : '🔑 Enter a valid license key in Prefs to start';
      SPOT.status(msg, 'error');
      try { chrome.storage.local.set({ jobbot_running: false }); } catch {} // stop watchdog retries
      agent = null;
      return;
    }

    // Run is going ahead — keep the tab un-throttled while it works in the
    // background (idempotent; safe to call on every watchdog/resume restart).
    KeepAlive.start();

    try { Telemetry.send('run_start', PLATFORM); } catch {} // denominator for error-rate

    const f = new Filler(profile);
    Pacer.configure(profile?.preferences);   // human-pace rate limiter (off unless enabled)
    if      (PLATFORM === 'linkedin') agent = new LinkedInAgent(f);
    else if (PLATFORM === 'indeed')   agent = new IndeedAgent(f);
    else if (PLATFORM === 'naukri')   agent = new NaukriAgent(f);
    else if (PLATFORM === 'naukrigulf') agent = new NaukriAgent(f); // separate platform, reuses the Naukri engine (hostname-gated)
    else if (PLATFORM === 'bayt')     agent = new BaytAgent(f);
    else { SPOT.status('Not a supported job site', 'error'); return; }

    // Only the top frame owns the running flag; 'nav' means the page is about
    // to navigate mid-run (apply flow / back / next page) and the run resumes
    // on the next page load – so the flag must survive.
    // Wait for the durable seen-jobs memory before scanning, so a job applied
    // just before this navigation is never picked again.
    try { await appliedSet.ready; } catch {}
    try { await learnedAnswers.ready; } catch {} // learned manual answers ready before filling

    // setStore: chrome.* throws once the extension is reloaded ("context
    // invalidated") – never let that kill the page or the run loop.
    const setStore = obj => { try { chrome.storage.local.set(obj); } catch {} };

    try { await tabReady; } catch {}
    if (IS_TOP) setStore({ jobbot_running: MY_TAB ?? true });
    // Remember the exact search-results page (query + filters + page number)
    // so the apply flow can return to it and continue with the next job.
    // Strip vjk= (the "highlighted job" param) so we always land at the
    // top of the clean list rather than scrolled to the last-applied card.
    if (IS_TOP && PLATFORM === 'indeed' && agent.onResultsPage?.()) {
      try {
        const u = new URL(location.href);
        u.searchParams.delete('vjk');
        setStore({ jobbot_return_url: u.toString() });
      } catch {
        setStore({ jobbot_return_url: location.href });
      }
    }
    // After a completed application, pause ~4s on the list page before scanning the
    // next job — covers the navigation case where run() never gets its own sleep.
    if (IS_TOP && PLATFORM === 'indeed' && agent.onResultsPage?.()) {
      const prev = await new Promise(res =>
        chrome.storage.local.get('jobbot_applied_at', d => { void chrome.runtime.lastError; res(d?.jobbot_applied_at || 0); })
      );
      if (prev && Date.now() - prev < 60000) {
        SPOT.status('⏳ Pausing before next job…', 'info');
        await sleep(rand(3500, 5000));
        try { chrome.storage.local.remove('jobbot_applied_at'); } catch {}
      }
    }
    let outcome = 'done';
    try { outcome = await agent.run(); }
    catch (e) {
      // An unexpected error must not end the run – keep the flag alive and let
      // the keep-alive watchdog restart the agent in a few seconds.
      SPOT.status(`Error: ${e.message} – retrying shortly…`, 'error');
      outcome = 'nav';
    }
    finally {
      // The run NEVER ends itself – only an explicit user Stop clears the
      // flag. When all visible jobs are processed ('done'), go into monitor
      // mode: the watchdog re-scans after a cooldown and picks up any new
      // postings, pagination, or a search the user tweaks.
      if (IS_TOP && outcome !== 'nav') {
        lastDoneAt = Date.now();
        // Engine is continuous: agent will restart automatically in ~12 s
        SPOT.status('Page complete – rescanning shortly… (✕ to stop)', 'info');
      }
      agent = null;
    }
  }

  function stopAgent() {
    if (agent) { agent.stop(); agent = null; }
    KeepAlive.stop();
    try { chrome.storage.local.set({ jobbot_running: false }); } catch {}
    SPOT.clearAttention();
    SPOT.status('Agent stopped', 'warning');
    setTimeout(() => SPOT.hide(), 5000);
  }

  // ─── Messages ─────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    switch (msg.type) {
      case 'PING':
        reply({ ok: true, platform: PLATFORM });
        break;
      case 'START_AGENT':
        attemptedSet.clear(); // explicit user start = fresh scan of the list
        lastDoneAt = 0;       // and no monitor-mode cooldown
        pageChurn.set(0);     // fresh empty-page streak
        // Ticked jobs present → this run applies only those, in sequence
        _setSelMode(selectedSet.size() > 0);
        startAgent(msg.profile || {});
        reply({ ok: true });
        break;
      case 'STOP_AGENT':
        stopAgent();
        reply({ ok: true });
        break;
      case 'GET_STATUS': {
        // "Running" means the RUN is alive (persisted flag), not merely that an
        // agent object exists this instant – between watchdog scans / in
        // monitor mode there is no agent, but the run has NOT stopped.
        const base = { platform: PLATFORM, applied: agent?.applied || 0, skipped: agent?.skipped || 0 };
        if (agent?.running) { reply({ running: true, ...base }); break; }
        try {
          chrome.storage.local.get('jobbot_running', d => {
            void chrome.runtime.lastError;
            reply({ running: flagMatchesThisTab(d?.jobbot_running), ...base });
          });
        } catch { reply({ running: false, ...base }); }
        break;
      }
    }
    return true;
  });

  // Auto-resume: Indeed/Naukri apply flows and pagination are full page
  // navigations that destroy the running agent. If a run is in progress,
  // restart the right agent on every page load so the run continues
  // seamlessly: job → apply → back to list → next job → next page.
  chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], async data => {
    if (!data.jobbot_running || !data.jobbot_profile) return;
    try { await tabReady; } catch {} // know our tab id before deciding
    if (!flagMatchesThisTab(data.jobbot_running)) {
      // The run lives in ANOTHER tab. If a job site opened the apply flow in this
      // new tab (it uses noopener, so window.opener is unreliable), fill it
      // here, then CLOSE this tab – the original search tab carries on.
      if (IS_TOP && PLATFORM === 'indeed') {
        const a = new IndeedAgent(new Filler(data.jobbot_profile));
        if (a.isApplyPage()) {
          a.returnToList = async () => {
            SPOT.status('Application finished – closing this tab…', 'success');
            await sleep(rand(1200, 1800));
            try { chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }); } catch {}
          };
          a.running = true;
          agent = a;
          a.runApplication().catch(() => {}).finally(() => { agent = null; });
        }
      }
      // Bayt sometimes opens the apply page in a new tab
      if (IS_TOP && PLATFORM === 'bayt') {
        const a = new BaytAgent(new Filler(data.jobbot_profile));
        if (a.isApplyPage()) {
          const origRun = a.runApplication.bind(a);
          a.runApplication = async () => {
            const ok = await origRun();
            SPOT.status('Application finished – closing this tab…', 'success');
            await sleep(rand(1200, 1800));
            try { chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }); } catch {}
            return ok;
          };
          a.running = true;
          agent = a;
          a.runApplication().catch(() => {}).finally(() => { agent = null; });
        }
      }
      // Naukri may open a job / apply flow in a NEW tab (the run flag lives in
      // the original list tab). Apply here, then CLOSE this tab — the list tab
      // carries on with the next job. Normal Naukri runs are same-tab, so this
      // only fires for a genuine spawned tab and never touches the main flow.
      if (IS_TOP && (PLATFORM === 'naukri' || PLATFORM === 'naukrigulf')) {
        const a = new NaukriAgent(new Filler(data.jobbot_profile));
        const isGulf = location.hostname.includes('naukrigulf');
        // Naukri Gulf: tell the LIST tab this job is finished (it's polling
        // jobbot_ng_job) so it opens the next selected job, then close THIS tab.
        const signalGulfDone = (res) => {
          if (!isGulf) return;
          try { chrome.storage.local.set({ jobbot_ng_done: res === 'done' ? 'done' : 'skip', jobbot_ng_job: '' }); } catch {}
        };
        const closeThisTab = async (m) => {
          SPOT.status(m || 'Application finished – closing this tab…', 'success');
          await sleep(rand(1000, 1800));
          try { chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }); } catch {}
        };
        if (a.isAppliedConfirmationPage()) {
          // The apply already completed in this tab → record it and close.
          try { const m = decodeURIComponent(location.href).match(/strJobsarr=\D*(\d+)/); if (m) appliedSet.add('nk:' + m[1]); } catch {}
          try { report({ type: 'JOB_APPLIED', platform: (isGulf ? 'naukrigulf' : 'naukri'), title: document.title, url: location.href }); } catch {}
          signalGulfDone('done');
          closeThisTab('✓ Applied – closing this tab…');
        } else if (isGulf) {
          // Spawned Gulf job tab: WAIT for the detail page (Easy Apply) to hydrate
          // — the SPA often isn't ready the instant the content script loads, so a
          // naive onDetailPage() check here would close the tab before it could
          // apply. Then apply, signal the list tab, and close.
          a.running = true;
          agent = a;
          (async () => {
            let ready = a.onDetailPage();
            for (let w = 0; w < 24 && !ready && !a.isAppliedConfirmationPage(); w++) { await sleep(700); ready = a.onDetailPage(); }
            if (a.isAppliedConfirmationPage()) { signalGulfDone('done'); await closeThisTab('✓ Applied – closing this tab…'); return; }
            if (!ready) { signalGulfDone('skip'); await closeThisTab('Couldn\'t find Easy Apply – closing this tab…'); return; }
            let out = 'skip';
            try { a._armJobTimer(); out = await a.applyHere(); a._disarmJobTimer(); } catch {}
            // Report the apply from THIS job tab (the list tab is told not to, to
            // avoid a double count). If it navigated to a confirmation page the
            // reloaded tab reports via the branch above instead.
            if (out === 'done' && !a.isAppliedConfirmationPage()) {
              try { report({ type: 'JOB_APPLIED', platform: 'naukrigulf', title: document.title, url: location.href }); } catch {}
            }
            signalGulfDone(out === 'done' || a.isAppliedConfirmationPage() ? 'done' : 'skip');
            if (!a.isAppliedConfirmationPage()) await closeThisTab();
          })().catch(() => { signalGulfDone('skip'); }).finally(() => { agent = null; });
        } else if (a.onDetailPage()) {
          a.running = true;
          agent = a;
          (async () => {
            try { a._armJobTimer(); await a.applyHere(); a._disarmJobTimer(); } catch {}
            // Instant apply with no navigation → close now. If it navigated to
            // /myapply/saveApply, the reloaded tab closes via the branch above.
            if (!a.isAppliedConfirmationPage()) await closeThisTab();
          })().catch(() => {}).finally(() => { agent = null; });
        }
      }
      return;
    }

    if (IS_TOP) {
      startAgent(data.jobbot_profile);
      return;
    }

    // Inside Indeed's embedded apply iframe: run the form-filler only.
    // The top-frame agent is waiting on this frame and owns the run state.
    if (PLATFORM === 'indeed') {
      const a = new IndeedAgent(new Filler(data.jobbot_profile));
      if (a.isApplyPage()) {
        a.running = true;
        agent = a; // so STOP_AGENT reaches this frame's agent too
        a.runApplication().catch(() => {}).finally(() => { agent = null; });
      }
    }
  });

  // ─── Tick boxes on job cards (all platforms) ────────────────────────────────
  // Lets the user queue specific jobs: tick ✓ on cards, then press the floating
  // "Apply N ticked jobs" button (or popup Start) and the agent applies exactly
  // those in sequence. (Indeed inclusion explicitly approved by the owner.)
  if (IS_TOP && PLATFORM) {
    const probe = PLATFORM === 'linkedin' ? new LinkedInAgent(new Filler({}))
                : PLATFORM === 'naukri'   ? new NaukriAgent(new Filler({}))
                : PLATFORM === 'naukrigulf' ? new NaukriAgent(new Filler({}))
                : PLATFORM === 'bayt'     ? new BaytAgent(new Filler({}))
                : new IndeedAgent(new Filler({}));

    // "Apply All" button — the single action button. If jobs are ticked it applies
    // only those in order (selection mode); otherwise applies every visible job.
    let applyAllBtn = null;
    function syncApplyAllBtn() {
      const running = !!(agent && agent.running);
      const show = !running;
      if (show && !applyAllBtn && document.body) {
        applyAllBtn = document.createElement('button');
        applyAllBtn.id = 'jobbotx-applyall';
        applyAllBtn.addEventListener('click', () => {
          applyAllBtn.style.display = 'none';
          attemptedSet.clear();
          lastDoneAt = 0;
          pageChurn.set(0);
          const n = selectedSet.size();
          if (n > 0) {
            _setSelMode(true); // apply only ticked jobs in sequence
          } else {
            selectedSet.clear();
            _setSelMode(false); // apply every visible job
          }
          try {
            chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, r => {
              void chrome.runtime.lastError;
              startAgent(r?.profile || {});
            });
          } catch {}
        });
        document.body.appendChild(applyAllBtn);
      }
      if (applyAllBtn) {
        const n = selectedSet.size();
        applyAllBtn.textContent = n > 0 ? `▶ Apply ${n} selected` : '▶ Apply All';
        applyAllBtn.style.display = show ? 'block' : 'none';
      }
    }

    // A job is "already applied" if it's in our permanent memory (jobbot_applied_v2,
    // so it survives re-scans and reloads), OR the agent's own per-card detector
    // says so (Bayt.cardApplied), OR the card shows a plain "Applied" badge. Used
    // to keep applied jobs out of "Select all" and off the tick overlay.
    function isCardAlreadyApplied(card, id) {
      try {
        if (id && appliedSet.has(id)) return true;
        if (typeof probe.cardApplied === 'function' && probe.cardApplied(card)) return true;
        // Generic site badge: a leaf element whose exact text is "Applied" /
        // "Already applied" (never "12 applied" — that requires the whole label
        // to be just the word). Bounded to badge-ish nodes so it stays cheap.
        if ($$('span, small, p, div, [class*="applied" i], [class*="status" i], [class*="tag" i], [class*="badge" i]', card)
              .some(el => el.childElementCount === 0 && isVis(el)
                       && /^(applied|already applied)$/i.test((el.textContent || '').trim()))) return true;
      } catch {}
      return false;
    }

    // "Select all" pill: one click ticks every visible job card; flips to
    // "Clear all" when everything visible is already ticked.
    let selAllBtn = null;
    function visibleIds() {
      try {
        let cards = probe.jobCards();
        // Count EXACTLY what the tick overlay renders, on every platform
        // (naukri.com / Naukri Gulf / Indeed): real job cards only (same
        // isJobCard filter the ticks use), outermost element only, and UNIQUE
        // per job id. Without the isJobCard filter + id de-dupe, a card that
        // exposes several job links (naukrigulf) or a nested match inflated
        // "Select all (N)" / "Apply All" past the actual jobs on the page.
        cards = cards.filter(isJobCard);
        cards = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));
        // Never surface an ALREADY-APPLIED job — so "Select all" can't queue it
        // and the count reflects only jobs that still need applying.
        const ids = [];
        for (const c of cards) {
          const id = probe.cardId(c);
          if (id && !isCardAlreadyApplied(c, id)) ids.push(id);
        }
        return [...new Set(ids)];
      } catch { return []; }
    }
    function paintTicks() {
      $$('.jobbotx-tick').forEach(t => {
        const card = t.closest('[data-jobbotx-tick]');
        if (!card) return;
        const id = probe.cardId(card);
        t.classList.toggle('on', !!id && selectedSet.has(id));
      });
    }
    function syncSelAllBtn() {
      const ids = visibleIds();
      // Always show the Select All button whenever job cards are visible —
      // the user should be able to bulk-select at any time, even mid-run.
      const show = ids.length > 0;
      if (show && !selAllBtn && document.body) {
        selAllBtn = document.createElement('button');
        selAllBtn.id = 'jobbotx-selall';
        selAllBtn.addEventListener('click', () => {
          const cur = visibleIds();
          const allOn = cur.length && cur.every(id => selectedSet.has(id));
          cur.forEach(id => allOn ? selectedSet.remove(id) : selectedSet.add(id));
          paintTicks();
          const n = selectedSet.size();
          SPOT.status(n
            ? `${n} job(s) selected – click ▶ Apply All to start`
            : 'Selection cleared', 'info');
          syncApplyAllBtn(); syncSelAllBtn();
        });
        document.body.appendChild(selAllBtn);
      }
      if (selAllBtn) {
        const allOn = ids.length && ids.every(id => selectedSet.has(id));
        const n = selectedSet.size();
        selAllBtn.textContent = allOn ? `✗ Deselect all (${ids.length})` : `☑ Select all (${ids.length})`;
        // Bold badge shows how many are currently selected
        selAllBtn.title = n > 0 ? `${n} job(s) selected` : 'Click to select all visible jobs';
        selAllBtn.style.display = show ? 'block' : 'none';
      }
    }
    // A genuine job card must contain a JOB link/id – not just any link.
    // (Generic utility-class selectors can match header nav, icons, etc.)
    const isJobCard = card =>
      !!$('a[data-jk], [data-jk], [data-job-id], [data-occludable-job-id], ' +
          'a[href*="viewjob"], a[href*="/jobs/view/"], a[href*="/rc/clk"], ' +
          'a[href*="job-listings"], a[href*="bayt.com"][href*="/jobs/"], ' +
          // Naukri Gulf job links — without these, naukrigulf cards were not
          // recognised as job cards, so the per-card selection checkboxes never
          // rendered (the "check box system is missing" report).
          'a[href*="-jid-"], a[href*="jobs-in"], a[href*="/job/"], a[href*="/jobseeker/"]', card)
      || (card.matches && card.matches('[data-jk], [data-job-id], [data-occludable-job-id]'));

    const tickTimer = setInterval(() => {
      if (!contextAlive()) { clearInterval(tickTimer); return; }
      SPOT.ensure(); // styles must exist before any run starts, or ticks render invisible

      // No ticks on apply/transitional pages – only on job lists
      if (PLATFORM === 'indeed'  && probe.isApplyPage())  return;
      if (PLATFORM === 'bayt'    && probe.isApplyPage())  return;
      if (PLATFORM === 'naukri'  && probe.onDetailPage()) return;
      if (PLATFORM === 'naukrigulf' && probe.onDetailPage()) return;

      let cards;
      try { cards = probe.jobCards(); } catch { return; }

      // ONE tick per job: selectors can match nested elements of the same
      // card – keep only the outermost match, and only real job cards.
      cards = cards.filter(isJobCard);
      cards = cards.filter(c => !cards.some(o => o !== c && o.contains(c)));

      // Cleanup: remove duplicated nested ticks and ticks whose host turned
      // out not to be a job card (nav items, icons, dropdowns).
      $$('.jobbotx-tick').forEach(t => {
        const wrap = t.parentElement;
        const host = wrap?.parentElement;
        if (!host) { t.remove(); return; }
        // A card that has since become applied loses its tick and its selection —
        // so an applied job can never stay queued.
        const hid = probe.cardId(host);
        const applied = hid && isCardAlreadyApplied(host, hid);
        if (applied || !isJobCard(host) || host.parentElement?.closest('[data-jobbotx-tick]')) {
          if (applied && hid) selectedSet.remove(hid);
          t.remove();
          if (wrap?.classList.contains('jobbotx-wrap') && !wrap.querySelector('.jobbotx-tick')) wrap.remove();
          if (host.dataset.jobbotxWasStatic) { host.style.position = ''; delete host.dataset.jobbotxWasStatic; }
          host.removeAttribute('data-jobbotx-tick');
        }
      });

      for (const card of cards) {
        if (card.querySelector(':scope > .jobbotx-wrap .jobbotx-tick, :scope > .jobbotx-tick')) { card.setAttribute('data-jobbotx-tick', '1'); continue; }
        if (card.closest('[data-jobbotx-tick]') !== null && card.closest('[data-jobbotx-tick]') !== card) continue;
        const id = probe.cardId(card);
        if (!id) continue;
        // Never render a tick on an already-applied job — it can't be re-applied.
        if (isCardAlreadyApplied(card, id)) { card.setAttribute('data-jobbotx-tick', '1'); continue; }
        card.setAttribute('data-jobbotx-tick', '1');

        // Use a position:relative wrapper injected INSIDE the card so we never
        // mutate the card's own CSS (other extensions depend on card layout).
        // The tick sits at bottom-left – away from the top-right corner where
        // lead-capture tools (LeadsLoft, etc.) put their action buttons.
        let wrap = card.querySelector(':scope > .jobbotx-wrap');
        if (!wrap) {
          wrap = document.createElement('span');
          wrap.className = 'jobbotx-wrap';
          wrap.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9998;';
          card.style.position = card.style.position || '';
          // Only set relative if the card truly has no positioning context
          if (getComputedStyle(card).position === 'static') {
            card.dataset.jobbotxWasStatic = '1';
            card.style.position = 'relative';
          }
          card.appendChild(wrap);
        }

        const t = document.createElement('div');
        t.className = 'jobbotx-tick' + (selectedSet.has(id) ? ' on' : '');
        t.textContent = '✓';
        t.title = 'JobBot: tick to queue this job, then press ▶ Start';
        // Bubble-phase listener only – never intercept events for other extensions.
        // preventDefault stops the card link from navigating; we do NOT call
        // stopPropagation so LeadsLoft / other handlers still see the click.
        t.addEventListener('click', e => {
          e.preventDefault();
          e.stopImmediatePropagation(); // stop other listeners on THIS element only
          const on = selectedSet.toggle(id);
          t.classList.toggle('on', on);
          SPOT.status(selectedSet.size()
            ? `${selectedSet.size()} job(s) selected – click ▶ Apply All to start`
            : 'Selection cleared – click ▶ Apply All to apply all visible jobs', 'info');
          syncApplyAllBtn(); syncSelAllBtn();
        });
        wrap.appendChild(t);
      }
      syncApplyAllBtn();
      syncSelAllBtn();
    }, 1500);
  }

  // ─── Keep-alive watchdog ────────────────────────────────────────────────────
  // The single guarantee that the agent "never stops" once started: while a run
  // is active (jobbot_running true) but no agent is running on this top page,
  // (re)start it. Covers any case where a run exits on a transitional page,
  // a slow load, or an unhandled hiccup. A deliberate Stop clears the flag, so
  // this never fights the user.
  //
  // When the extension is reloaded/updated, this old content script keeps
  // running but its chrome.* APIs are dead ("Extension context invalidated").
  // contextAlive() detects that and shuts the watchdog down silently — the
  // freshly injected script takes over.
  function contextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  if (IS_TOP) {
    const watchdog = setInterval(() => {
      if (!contextAlive()) {
        clearInterval(watchdog);
        if (agent) agent.stop();
        KeepAlive.stop();
        SPOT.hide();
        return;
      }
      if (agent && agent.running) return;
      // Continuous engine: re-scan after a short cooldown so the agent never
      // idles for long. Once the user presses Start the run never stops until
      // they explicitly press Stop (or click ✕ on the bar).
      if (lastDoneAt && Date.now() - lastDoneAt < 12000) return;
      try {
        chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], d => {
          if (chrome.runtime.lastError) return;
          if (d.jobbot_running && flagMatchesThisTab(d.jobbot_running)
              && d.jobbot_profile && !(agent && agent.running)) {
            startAgent(d.jobbot_profile);
          }
        });
      } catch { clearInterval(watchdog); }
    }, 5000);

    // ── Global captcha watcher (all sites) ──────────────────────────────────
    // Independent of any agent: whenever a captcha appears during a run, spotlight
    // it + fire a desktop notification so the user solves it, and clear the alert
    // the moment it's gone. This covers LinkedIn/Naukri too, and catches captchas
    // that pop up outside an agent's own submit step — the old cause of silent stalls.
    let _captchaShown = false;
    const captchaWatch = setInterval(() => {
      if (!contextAlive()) { clearInterval(captchaWatch); return; }
      let running = false;
      try {
        chrome.storage.local.get('jobbot_running', d => {
          if (chrome.runtime.lastError) return;
          running = !!(d.jobbot_running && flagMatchesThisTab(d.jobbot_running));
          const here = CAPTCHA.present();
          if (running && here && !_captchaShown) {
            _captchaShown = true;
            try { Telemetry.send('captcha', location.hostname); } catch {}
            SPOT.attention(CAPTCHA.el(), '🔐 Human check — please solve the "verify you\'re human" box; I\'ll continue automatically');
            notifyUser('JobBot needs you', 'A captcha appeared — solve it and the agent keeps going automatically.');
          } else if (_captchaShown && !here) {
            _captchaShown = false;
            noteCaptchaCleared();   // enter the trust-rebuild cool-down (escalates on repeats)
            SPOT.clearAttention();
            SPOT.status('✓ Captcha cleared — easing back in to avoid another…', 'success');
          } else {
            decayCaptchaBackoff();  // long quiet stretch → drop back to full speed
          }
        });
      } catch { clearInterval(captchaWatch); }
    }, 2500);

    // ── Ambient human hand-movement (INDEED ONLY) ───────────────────────────
    // Between the agent's clicks, a real person's cursor is never perfectly
    // still — it drifts, twitches, and rests. Cloudflare Turnstile scores that
    // continuous micro-activity. During an active Indeed run (and only then),
    // emit gentle, low-amplitude drift movements so there's lifelike mouse
    // activity even while the agent is reading/waiting. Yields to real glides
    // (_moving) and never clicks anything — pure mousemove, zero apply impact.
    // Gated to Indeed: LinkedIn/Naukri/Bayt are completely unaffected.
    if (PLATFORM === 'indeed') {
      let _ambientRunning = false;
      const ambientTick = async () => {
        if (_ambientRunning || _moving) return;
        let active = false;
        try {
          active = await new Promise(res => {
            chrome.storage.local.get('jobbot_running', d => {
              if (chrome.runtime.lastError) return res(false);
              res(!!(d.jobbot_running && flagMatchesThisTab(d.jobbot_running)) && !CAPTCHA.present());
            });
          });
        } catch { return; }
        if (!active || _moving) return;
        _ambientRunning = true;
        try {
          // small settle-drift near the current position: a short curved wander
          const tx = _clampX(_mx + (Math.random() - 0.5) * rand(20, 90));
          const ty = _clampY(_my + (Math.random() - 0.5) * rand(16, 70));
          const sx = _mx, sy = _my, n = rand(4, 9);
          const cxp = sx + (tx - sx) * 0.5 + (Math.random() - 0.5) * 30;
          const cyp = sy + (ty - sy) * 0.5 + (Math.random() - 0.5) * 24;
          for (let i = 1; i <= n && !_moving; i++) {
            const t = _smoother(i / n), u = 1 - t;
            const ex = u * u * sx + 2 * u * t * cxp + t * t * tx;
            const ey = u * u * sy + 2 * u * t * cyp + t * t * ty;
            _emitRich(ex, ey);
            await sleep(rand(18, 45));
          }
        } catch {} finally { _ambientRunning = false; }
      };
      // Irregular cadence (humans aren't metronomic): re-arm with a random gap.
      // Right after a captcha, tighten the cadence so the behavioural score sees
      // more continuous, lifelike motion while trust is being rebuilt.
      const scheduleAmbient = () => {
        if (!contextAlive()) return;
        const gap = inCaptchaCooldown() ? rand(350, 1000) : rand(900, 2600);
        setTimeout(async () => { try { await ambientTick(); } catch {} scheduleAmbient(); }, gap);
      };
      scheduleAmbient();
    }
  }

  // ── Ambient hand-movement INSIDE the Indeed apply iframe ────────────────────
  // The apply form AND Cloudflare Turnstile live in a cross-origin iframe
  // (apply.indeed.com / indeedapply / smartapply). The top-frame ambient loop
  // above never reaches that document, so Turnstile there would otherwise read a
  // dead cursor between our discrete pre-click glides — a strong automation tell
  // exactly at the submit step, which is where captchas fire. Mirror the same
  // gentle drift here so the iframe's Turnstile sees continuous, human-like
  // micro-activity. Indeed-only, drift-only (never clicks), yields to real
  // glides (_moving) and pauses while a captcha is present.
  if (!IS_TOP && PLATFORM === 'indeed') {
    let _iAmb = false;
    const iframeAmbientTick = async () => {
      if (_iAmb || _moving) return;
      let active = false;
      try {
        active = await new Promise(res => {
          chrome.storage.local.get('jobbot_running', d => {
            if (chrome.runtime.lastError) return res(false);
            res(!!(d.jobbot_running && flagMatchesThisTab(d.jobbot_running)) && !CAPTCHA.present());
          });
        });
      } catch { return; }
      if (!active || _moving) return;
      _iAmb = true;
      try {
        const tx = _clampX(_mx + (Math.random() - 0.5) * rand(20, 90));
        const ty = _clampY(_my + (Math.random() - 0.5) * rand(16, 70));
        const sx = _mx, sy = _my, n = rand(4, 9);
        const cxp = sx + (tx - sx) * 0.5 + (Math.random() - 0.5) * 30;
        const cyp = sy + (ty - sy) * 0.5 + (Math.random() - 0.5) * 24;
        for (let i = 1; i <= n && !_moving; i++) {
          const t = _smoother(i / n), u = 1 - t;
          const ex = u * u * sx + 2 * u * t * cxp + t * t * tx;
          const ey = u * u * sy + 2 * u * t * cyp + t * t * ty;
          _emitRich(ex, ey);
          await sleep(rand(18, 45));
        }
      } catch {} finally { _iAmb = false; }
    };
    const scheduleIframeAmbient = () => {
      if (!contextAlive()) return;
      setTimeout(async () => { try { await iframeAmbientTick(); } catch {} scheduleIframeAmbient(); }, rand(900, 2600));
    };
    scheduleIframeAmbient();
  }

})();
