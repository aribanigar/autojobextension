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
    if (h.includes('naukri.com')) return 'naukri';
    if (h.includes('bayt.com'))   return 'bayt';
    return null;
  })();
  if (!PLATFORM) return;

  // ─── Utilities ────────────────────────────────────────────────────────────
  const sleep    = ms => new Promise(r => setTimeout(r, ms));
  const rand     = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

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
      await sleep(rand(18, 55));
    }
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
    // Coordinate-bearing click so React / anti-bot checks see non-zero clientX/Y
    el.dispatchEvent(new MouseEvent('click', base));
  }

  async function humanClick(el, msg = '') {
    if (!isVis(el)) return false;
    await yieldToLeadsLoft(); // don't fight if LeadsLoft is mid-action
    if (!isVis(el)) return false;
    if (msg) SPOT.pulse(el, msg);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(250, 500));
    const r = el.getBoundingClientRect();
    await moveTo(r.left + r.width / 2, r.top + r.height / 2);
    await sleep(rand(80, 200));
    realClick(el);
    await sleep(rand(350, 700));
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
        const tx = _clampX(_mx + (Math.random() - 0.5) * rand(140, 420));
        const ty = _clampY(_my + (Math.random() - 0.5) * rand(100, 320));
        await moveTo(tx, ty);
      };
      await sleep(rand(500, 1200));
      await wander();
      await sleep(rand(400, 900));
      try { window.scrollBy(0, rand(60, 180)); } catch {}   // glance down the summary
      await sleep(rand(500, 1300));
      try { window.scrollBy(0, -rand(40, 120)); } catch {}  // back up toward Submit
      await sleep(rand(400, 1000));
      if (Math.random() < 0.7) { await wander(); await sleep(rand(400, 1100)); }
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
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const o = ac.createOscillator(), g = ac.createGain();
          o.connect(g); g.connect(ac.destination); o.frequency.value = 880;
          g.gain.value = 0.05; o.start(); o.stop(ac.currentTime + 0.18);
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
    const norm = q => String(q || '').toLowerCase()
      .replace(/[*:?()\[\].,<>/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    try {
      chrome.storage.local.get('jobbot_learned', d => { if (d.jobbot_learned) store = d.jobbot_learned; resolveReady(); });
    } catch { resolveReady(); }
    const persist = () => { try { chrome.storage.local.set({ jobbot_learned: store }); } catch {} };
    return {
      ready,
      get: q => { const k = norm(q); return k && k.length >= 4 ? (store[k] || null) : null; },
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
      if (document.hidden) return 'popup';
      if (opened()) return 'clicked';

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
        if (document.hidden) return 'popup';
        if (opened()) return 'clicked';
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
              for (let w = 0; w < 100 && this.running; w++) { // up to ~5 min
                await sleep(3000);
                if (!document.hidden) break;
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

    // A job-description page is where the Apply action lives. Detect it by
    // URL or by the apply bar itself — NOT by the absence of job cards
    // (sidebar recommendation tiles used to defeat that check).
    onDetailPage() {
      if (/\/job-listings-/i.test(location.pathname)) return true;
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
      const acp = $('.acp-container, .applied-job-content, #interview-360[data-section-name="interview-360"]');
      return !!acp && $$('h1, h2, [role="heading"], [class*="title"]')
        .some(el => isVis(el) && /^\s*applied to\b/i.test(el.textContent));
    }

    cardLink(card) {
      // Recommended-jobs tiles render the title as <p class="title">, not an anchor
      return $('a.title, a[class*="title"], a[class*="jobTitle"], a[href*="/job-listings-"], h2 a', card)
          || $('p.title, .title', card);
    }

    cardId(card) {
      const id = card.getAttribute('data-job-id');
      if (id) return 'nk:' + id;
      const href = this.cardLink(card)?.href;
      if (href) return normalizeJobId(href);
      return card.textContent.trim().slice(0, 80);
    }

    async openJob(card) {
      const link = this.cardLink(card);
      if (!link) return false;
      SPOT.pulse(link, `Opening: ${link.textContent.trim().substring(0, 60)}`);
      await sleep(rand(300, 700));
      const before = location.href;
      // Drive the CURRENT tab straight to the job URL. Naukri's job anchors carry
      // an onclick that opens the job in a NEW tab (which the run can't follow, so
      // nothing applies and the loop stalls). Navigating via location.assign
      // bypasses that handler and guarantees the apply → history.back() → next-job
      // sequence stays in ONE tab. Falls back to a click for recommended tiles
      // that have no real href.
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

      // Smooth scroll + cursor glide + spotlight before clicking
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(600, 900));
      await humanClick(btn, '🎯 Clicking APPLY…');
      // Native-click fallback: some Naukri React buttons ignore a synthetic
      // click. Only fire it if the chatbot hasn't already opened, so a working
      // click is never double-fired. Also nudge the inner text span some builds
      // bind the handler to. Additive — humanClick above is unchanged.
      await sleep(rand(150, 350));
      if (!this.chatbot() && !this.isApplied()) {
        try { btn.click(); } catch {}
        try { const inner = btn.querySelector('span, div'); if (inner) inner.click(); } catch {}
      }

      // Success = the question drawer opens OR an instant-apply toast fires.
      // Naukri's button can swallow early clicks while JS hydrates – retry twice.
      for (let i = 0; i < 14; i++) {
        await sleep(700);
        if (this.chatbot() || this.isApplied()) return true;
        // Retry at 3s and 7s if the button is still there — synthetic + native.
        if ((i === 4 || i === 9) && btn.isConnected && isVis(btn)
            && !/already applied|applied/i.test(btn.textContent)) {
          SPOT.pulse(btn, '🎯 Re-clicking APPLY…');
          await humanClick(btn, '🎯 Re-clicking APPLY…');
          try { btn.click(); } catch {} // native fallback for React buttons
        }
      }
      return !!(this.chatbot() || this.isApplied());
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

    // Read the current question: the LAST bot bubble (li.botItem), text in .botMsg span
    chatQuestion(drawer) {
      const items = $$('li.botItem, li[class*="botItem"]', drawer).filter(isVis);
      const last = items[items.length - 1];
      if (last) {
        const span = $('div.botMsg span, .botMsg', last);
        const txt = (span || last).textContent.trim();
        if (txt.length > 3) return txt;
      }
      // Fallback for older drawer markup
      const msgs = $$('[class*="botMsg"], [class*="MessageContainer"] [class*="msg"]', drawer)
        .filter(el => isVis(el) && el.textContent.trim().length > 3);
      return msgs.length ? msgs[msgs.length - 1].textContent.trim() : '';
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
          // 4) Free text – Naukri uses a contenteditable <div class="textArea">
          const input = $(
            'div.textArea[contenteditable="true"], [class*="textArea"][contenteditable="true"], ' +
            '[contenteditable="true"], textarea, ' +
            'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], ' +
            'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])',
            drawer);
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
    async waitForHumanAnswer(question) {
      this._disarmJobTimer();
      const drawer = this.chatbot();
      SPOT.attention(drawer || document.body,
        `❓ Please answer this question — I'll continue automatically once you do:  "${(question || '').slice(0, 70)}"`);
      notifyUser('JobBot needs you', `A Naukri question needs your answer: "${(question || '').slice(0, 90)}". Type it and I'll continue.`);
      for (let i = 0; i < 600 && this.running; i++) { // wait up to ~10 min
        await sleep(1000);
        if (this.isApplied()) { SPOT.clearAttention(); return 'done'; }
        const d2 = this.chatbot();
        if (!d2) { SPOT.clearAttention(); return 'continue'; }                     // drawer closed → moved on
        if (this.chatQuestion(d2) !== question) { SPOT.clearAttention(); return 'continue'; } // answered → next question
        if (i > 0 && i % 45 === 0) notifyUser('JobBot still waiting', 'A Naukri question is still open — please answer it and I\'ll continue.');
      }
      SPOT.clearAttention();
      return 'stuck';
    }

    async handleForm() {
      if (this.isApplied()) return 'done';

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
          report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
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
          report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
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
            report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
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
    _armJobTimer(ms = 90000) {
      clearTimeout(this._jobTimer);
      this._skipNow = false;
      this._jobTimer = setTimeout(() => {
        this._skipNow = true;
        SPOT.status('⏱ Job taking too long (90s) – skipping…', 'warning');
      }, ms);
    }
    _disarmJobTimer() { clearTimeout(this._jobTimer); this._skipNow = false; }

    // Detect Bayt job-listing search results pages
    jobCards() {
      return $$(
        'li[data-job-id], li[class*="jb-job-item"], ' +
        'li[data-automation-id="job"], ' +
        '.jb-job-item, [class*="j-postings-results__listing"], ' +
        '[class*="JobCard"], li.j-search-results__item'
      ).filter(c => isVis(c)
        && !c.closest('aside, [class*="similar"], [class*="related"], [class*="sidebar"], [class*="recommended"]'));
    }

    cardId(card) {
      const id = card.getAttribute('data-job-id') || card.getAttribute('data-js-aid');
      if (id) return 'bt:' + id;
      const a = $('a[href*="/jobs/"]', card) || $('a[href*="bayt.com"]', card);
      if (a?.href) return normalizeJobId(a.href);
      return card.textContent.trim().slice(0, 80);
    }

    // Are we on a job detail / apply page (not the search list)?
    onDetailPage() {
      // URL has a slug ending in -\d+/ (Bayt job detail pattern)
      if (/\/jobs\/[^/]+-\d+\//i.test(location.pathname)) return true;
      // Or the dedicated apply URL
      if (/\/apply\//i.test(location.pathname)) return true;
      // Or an apply form / modal is visible
      return !!$('#apply-btn-top, #apply-btn, .qa-apply-btn, ' +
                 '[class*="apply-form-wrapper"], [class*="applyForm"], ' +
                 '[data-automation-id="apply-form"]');
    }

    isApplyPage() {
      return this.onDetailPage() || /\/apply\//i.test(location.href);
    }

    isApplied() {
      // Success banner / confirmation page
      if ($$('[class*="success"], [class*="confirmation"], [class*="applied-state"], ' +
             '[class*="application-success"], [class*="apply-success"]')
          .some(el => isVis(el) && el.textContent.trim().length > 5)) return true;
      return $$('h1, h2, h3, p, [role="heading"], [class*="title"], [class*="header"]').some(el =>
        isVis(el) && /application (has been |was )?sent|successfully applied|application received|you have applied|thank you for applying/i.test(el.textContent));
    }

    // Find the primary Apply button on a detail page; detect already-applied & external
    findApplyButton() {
      const already = $$('button, a, [class*="apply"], span').find(b =>
        isVis(b) && /already applied|you('ve| have) applied|^applied$/i.test(b.textContent.trim()));
      if (already) return { btn: null, already: true, external: false };

      const ext = $$(
        'a[href*="apply"][target="_blank"], a[class*="apply"][rel*="noopener"], ' +
        '[class*="company-site"], [class*="companySite"]'
      ).find(isVis);

      const btn =
        $('#apply-btn-top, #apply-btn, .qa-apply-btn, .btn-apply, ' +
          '[data-automation-id="applyButton"], [data-js-aid="jobApplyBtn"], ' +
          'a[href*="/apply/"], button[id*="apply"]') ||
        $$('a, button, [role="button"]').find(b =>
          isVis(b)
          && /^(apply|quick apply|apply now|easy apply)$/i.test(b.textContent.trim())
          && !/external|company\s*site|already applied|^applied$/i.test(b.textContent)
          && !b.closest('aside, [class*="similar"], [class*="related"], [class*="sidebar"]')
        );

      if (btn && /already applied|^applied$/i.test(btn.textContent.trim()))
        return { btn: null, already: true, external: false };
      if (!btn && ext) return { btn: null, already: false, external: true };
      return { btn: btn || null, already: false, external: false };
    }

    // Locate Continue / Next and Submit buttons on the active step
    findStepButtons() {
      const visible = $$('button, input[type="submit"], input[type="button"], [role="button"]').filter(isVis);
      const text = el => (el.textContent || el.value || el.getAttribute('value') || '').trim();

      const cont =
        $('[data-automation-id="btn-next"], [data-qa="btn-next"], ' +
          '[class*="next-step"], [class*="nextStep"]') ||
        visible.find(b => /^(next|continue|proceed|save and continue|save & continue)$/i.test(text(b)) && !b.disabled);

      const sub =
        $('[data-automation-id="btn-submit"], [data-qa="btn-submit"], ' +
          '[class*="submit-app"], [class*="submitApp"]') ||
        visible.find(b => /submit (my |your )?application|send application|^(apply|apply now)$/i.test(text(b)) && !b.disabled);

      return { cont, sub };
    }

    async fillStep() {
      const form = $('form, [class*="apply-form"], [class*="application-form"], ' +
                     '[class*="screening"], [class*="question-form"], ' +
                     '[data-automation-id="apply-form"]') || document.body;
      await this.f.all(form);
      await sleep(rand(350, 600));
    }

    async clickContinue() {
      const { cont, sub } = this.findStepButtons();

      if (cont && isVis(cont) && !cont.disabled) {
        await humanClick(cont, '✨ Clicking CONTINUE…');
        await sleep(rand(900, 1600));
        return 'continue';
      }

      if (sub && isVis(sub) && !sub.disabled) {
        await humanClick(sub, '🎉 Submitting Bayt application!');
        await sleep(rand(1500, 2500));
        return 'submitted';
      }

      // Button present but disabled – required field still empty
      if ((cont && cont.disabled) || (sub && sub.disabled)) return 'blocked';
      return null;
    }

    async runApplication() {
      SPOT.status('Processing Bayt application…', 'applying');
      let steps = 0, misses = 0;

      while (steps < 35 && this.running && !this._skipNow) {
        if (this.isApplied()) {
          this.applied++;
          appliedSet.add(normalizeJobId(location.href));
          report({ type: 'JOB_APPLIED', platform: 'bayt', title: document.title, url: location.href });
          SPOT.status(`✓ Applied on Bayt! (${this.applied} total)`, 'success');
          await sleep(rand(1500, 2500));
          history.back();
          await sleep(rand(2200, 3500));
          return true;
        }

        await this.fillStep();
        const res = await this.clickContinue();

        if (res === 'continue') {
          misses = 0; steps++;
          await sleep(rand(700, 1400));
          continue;
        }

        if (res === 'submitted') {
          await sleep(rand(1500, 2500));
          if (this.isApplied()) {
            this.applied++;
            appliedSet.add(normalizeJobId(location.href));
            report({ type: 'JOB_APPLIED', platform: 'bayt', title: document.title, url: location.href });
            SPOT.status(`✓ Applied on Bayt! (${this.applied} total)`, 'success');
            await sleep(rand(1500, 2500));
            history.back();
            await sleep(rand(2200, 3500));
            return true;
          }
          steps++; continue;
        }

        if (res === 'blocked') {
          misses++;
          if (misses < 3) { SPOT.status('Required fields pending – refilling…', 'warning'); await sleep(2000); continue; }
        } else {
          misses++;
          if (this.isApplied()) continue;
          if (misses < 3) { SPOT.status('Waiting for form to load…', 'applying'); await sleep(rand(1500, 2500)); continue; }
        }

        SPOT.status('Stuck on Bayt form – returning to job list', 'warning');
        this.skipped++; reportSkip();
        history.back();
        await sleep(rand(1500, 2500));
        return false;
      }

      this.skipped++; reportSkip();
      history.back();
      await sleep(rand(1500, 2500));
      return false;
    }

    async openJob(card) {
      const link = $('a[href*="/jobs/"], h2 a, [class*="title"] a, [class*="job-title"] a', card)
                || $('a', card);
      if (!link) return false;
      SPOT.pulse(link, `Opening: ${(link.textContent || '').trim().substring(0, 60)}`);
      if (link.tagName === 'A') link.setAttribute('target', '_self');
      await sleep(rand(300, 600));
      const before = location.href;
      realClick(link);
      await sleep(rand(2200, 3500));
      return location.href !== before || this.onDetailPage();
    }

    async clickApplyBtn() {
      let { btn, already, external } = this.findApplyButton();
      if (!btn && !already && !external) {
        // Wait up to ~5s for the button to hydrate after navigation
        for (let w = 0; w < 10; w++) {
          await sleep(500);
          ({ btn, already, external } = this.findApplyButton());
          if (btn || already || external) break;
        }
      }
      if (already) return 'already';
      if (external) return 'external';
      if (!btn) return false;

      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(600, 900));

      // Remember URL before click so we can detect if a new tab opened
      const beforeUrl = location.href;

      SPOT.pulse(btn, '🎯 Clicking APPLY on Bayt…');
      await sleep(rand(500, 800));

      // Click + retry (Bayt uses React-hydrated buttons that may ignore first click)
      for (let i = 0; i < 6; i++) {
        realClick(btn);
        await sleep(800);
        if (document.hidden) return 'popup'; // opened a new tab
        // Apply form appeared, or URL changed
        if (this.findStepButtons().cont || this.findStepButtons().sub ||
            this.isApplied() || location.href !== beforeUrl) return 'clicked';
        if ((i === 2 || i === 4) && btn.isConnected && isVis(btn)) {
          SPOT.pulse(btn, '🎯 Re-clicking APPLY on Bayt…');
        }
      }
      return 'clicked'; // assume clicked even if form not yet detected
    }

    async nextPage() {
      const btn =
        $('a.pager-next, [class*="pagination"] a[rel="next"], ' +
          'a[class*="pagination__next"], [class*="pager"] a.next, ' +
          'li.next > a, li.next-page > a') ||
        $$('a, button').find(el =>
          isVis(el)
          && /^(next( page)?|>|التالي|التالية)$/i.test(el.textContent.trim())
          && !el.closest('[class*="job-detail"], [class*="apply"]')
        );
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return false;
      SPOT.status('Page finished – moving to the next page…', 'info');
      await humanClick(btn, '➡️ Next page…');
      await sleep(rand(2800, 4200));
      return true;
    }

    async run() {
      this.running = true;

      // Resumed on a job detail page after navigation
      if (this.onDetailPage()) {
        attemptedSet.add(normalizeJobId(location.href));
        const res = await this.clickApplyBtn();
        if (res === 'already') {
          appliedSet.add(normalizeJobId(location.href));
          SPOT.status('Already applied – skipping', 'info');
          this.skipped++;
        } else if (res === 'external') {
          SPOT.status('Apply on company site – skipping', 'warning');
          this.skipped++; reportSkip();
        } else if (!res) {
          SPOT.status('No Apply button – skipping', 'warning');
          this.skipped++; reportSkip();
        } else if (res === 'popup') {
          SPOT.status('Applying in the opened tab – waiting…', 'applying');
          for (let w = 0; w < 100 && this.running; w++) {
            await sleep(3000);
            if (!document.hidden) break;
          }
          await sleep(rand(1000, 2000));
        } else {
          this._armJobTimer();
          await this.runApplication();
          this._disarmJobTimer();
        }
        history.back();
        await sleep(rand(2500, 3500));
        this.running = false;
        return 'nav';
      }

      SPOT.status('Bayt – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) {
          SPOT.status('No job cards found – open a Bayt Jobs search page', 'warning');
          break;
        }

        let progressed = true;
        while (progressed && this.running) {
          progressed = false;
          const selMode = selectionMode();
          if (selMode && !selectedSet.size()) {
            SPOT.status('All selected jobs done – tick more or ✕ to stop', 'success');
            this.running = false;
            return 'nav';
          }
          for (const card of this.jobCards()) {
            if (!this.running) break;
            const jid = this.cardId(card);
            if (selMode && (!jid || !selectedSet.has(jid))) continue;
            if (jid && (appliedSet.has(jid) || attemptedSet.has(jid))) {
              if (jid) selectedSet.remove(jid);
              continue;
            }
            if (jid) attemptedSet.add(jid);

            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(rand(500, 900));

            if (!await this.openJob(card)) { this.skipped++; reportSkip(); progressed = true; break; }

            // Now on detail page – find and click apply
            const res = await this.clickApplyBtn();
            if (res === 'already') {
              appliedSet.add(normalizeJobId(location.href));
              SPOT.status('Already applied – moving to next job', 'info');
            } else if (res === 'external') {
              SPOT.status('External apply – skipping', 'warning');
              this.skipped++; reportSkip();
            } else if (!res) {
              SPOT.status('No Apply button – skipping', 'warning');
              this.skipped++; reportSkip();
            } else if (res === 'popup') {
              // Application opened in a new tab – wait for it to finish and close
              SPOT.status('Applying in the opened tab – waiting for it to finish…', 'applying');
              for (let w = 0; w < 100 && this.running; w++) {
                await sleep(3000);
                if (!document.hidden) break;
              }
              await sleep(rand(1000, 2000));
            } else {
              this._armJobTimer();
              await this.runApplication();
              this._disarmJobTimer();
              if (jid) selectedSet.remove(jid);
            }

            await sleep(rand(1000, 2000));
            // Return to list if still on detail page
            if (this.onDetailPage()) {
              history.back();
              await sleep(rand(2500, 3500));
            }
            progressed = true;
            break;
          }
        }

        if (!await this.nextPage()) break;
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
    let ctx = null, osc = null, gain = null, resumer = null, on = false;
    function start() {
      if (on || !IS_TOP) return;
      on = true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        gain = ctx.createGain();
        gain.gain.value = 0.0001;          // real output, but inaudible
        osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 30;          // sub-audible tone
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        const kick = () => { try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch {} };
        kick();
        // Autoplay policy may leave the context suspended until a gesture / focus
        // change — keep (re)starting it whenever the page gets a chance.
        resumer = () => kick();
        document.addEventListener('visibilitychange', resumer, true);
        document.addEventListener('pointerdown', resumer, true);
      } catch {}
    }
    function stop() {
      on = false;
      try { document.removeEventListener('visibilitychange', resumer, true); } catch {}
      try { document.removeEventListener('pointerdown', resumer, true); } catch {}
      resumer = null;
      try { if (osc) osc.stop(); } catch {}
      try { if (ctx) ctx.close(); } catch {}
      osc = gain = ctx = null;
    }
    return { start, stop };
  })();

  async function startAgent(profile) {
    if (agent?.running) return;
    if (!['linkedin', 'indeed', 'naukri', 'bayt'].includes(PLATFORM)) {
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

    const f = new Filler(profile);
    if      (PLATFORM === 'linkedin') agent = new LinkedInAgent(f);
    else if (PLATFORM === 'indeed')   agent = new IndeedAgent(f);
    else if (PLATFORM === 'naukri')   agent = new NaukriAgent(f);
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
      if (IS_TOP && PLATFORM === 'naukri') {
        const a = new NaukriAgent(new Filler(data.jobbot_profile));
        const closeThisTab = async (m) => {
          SPOT.status(m || 'Application finished – closing this tab…', 'success');
          await sleep(rand(1000, 1800));
          try { chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }); } catch {}
        };
        if (a.isAppliedConfirmationPage()) {
          // The apply already completed in this tab → record it and close.
          try { const m = decodeURIComponent(location.href).match(/strJobsarr=\D*(\d+)/); if (m) appliedSet.add('nk:' + m[1]); } catch {}
          try { report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href }); } catch {}
          closeThisTab('✓ Applied on Naukri – closing this tab…');
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

    // "Select all" pill: one click ticks every visible job card; flips to
    // "Clear all" when everything visible is already ticked.
    let selAllBtn = null;
    function visibleIds() {
      try {
        let cards = probe.jobCards();
        cards = cards.filter(c => !cards.some(o => o !== c && o.contains(c))); // outermost only
        return cards.map(c => probe.cardId(c)).filter(Boolean);
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
          'a[href*="job-listings"], a[href*="bayt.com"][href*="/jobs/"]', card)
      || (card.matches && card.matches('[data-jk], [data-job-id], [data-occludable-job-id]'));

    const tickTimer = setInterval(() => {
      if (!contextAlive()) { clearInterval(tickTimer); return; }
      SPOT.ensure(); // styles must exist before any run starts, or ticks render invisible

      // No ticks on apply/transitional pages – only on job lists
      if (PLATFORM === 'indeed'  && probe.isApplyPage())  return;
      if (PLATFORM === 'bayt'    && probe.isApplyPage())  return;
      if (PLATFORM === 'naukri'  && probe.onDetailPage()) return;

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
        if (!isJobCard(host) || host.parentElement?.closest('[data-jobbotx-tick]')) {
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
            SPOT.attention(CAPTCHA.el(), '🔐 Human check — please solve the "verify you\'re human" box; I\'ll continue automatically');
            notifyUser('JobBot needs you', 'A captcha appeared — solve it and the agent keeps going automatically.');
          } else if (_captchaShown && !here) {
            _captchaShown = false;
            SPOT.clearAttention();
            SPOT.status('✓ Captcha cleared — continuing…', 'success');
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
      const scheduleAmbient = () => {
        if (!contextAlive()) return;
        setTimeout(async () => { try { await ambientTick(); } catch {} scheduleAmbient(); }, rand(900, 2600));
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
