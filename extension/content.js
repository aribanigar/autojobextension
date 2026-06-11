// content.js – JobBot Auto Apply Agent v2
// LinkedIn Easy Apply · Indeed Apply · Naukri Apply

(function () {
  'use strict';
  if (window.__jobBotInstalled) return;
  window.__jobBotInstalled = true;

  // ─── Platform ─────────────────────────────────────────────────────────────
  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes('linkedin.com')) return 'linkedin';
    if (h.includes('indeed.com') || h.includes('apply.indeed.com')) return 'indeed';
    if (h.includes('naukri.com')) return 'naukri';
    return null;
  })();
  if (!PLATFORM) return;

  // ─── Utilities ────────────────────────────────────────────────────────────
  const sleep    = ms => new Promise(r => setTimeout(r, ms));
  const rand     = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
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
  async function moveTo(x, y) {
    const steps = rand(5, 11);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // ease-in-out + slight wobble
      const ex = _mx + (x - _mx) * t + (Math.random() - 0.5) * 6;
      const ey = _my + (y - _my) * t + (Math.random() - 0.5) * 6;
      const tgt = document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, ex)),
        Math.max(0, Math.min(innerHeight - 1, ey))
      );
      (tgt || document.body)?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window, clientX: ex, clientY: ey,
      }));
      await sleep(rand(8, 22));
    }
    _mx = x; _my = y;
  }

  // Full pointer/mouse event sequence – React buttons (Indeed) often ignore bare .click()
  function realClick(el) {
    const r = el.getBoundingClientRect();
    // aim for a random point inside the element, not always the exact center
    const cx = r.left + r.width * (0.35 + Math.random() * 0.3);
    const cy = r.top + r.height * (0.35 + Math.random() * 0.3);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent('mousemove',  opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  async function humanClick(el, msg = '') {
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

      if (!document.getElementById('jb-style')) {
        const s = document.createElement('style');
        s.id = 'jb-style';
        s.textContent = `
          #jb-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;
            display:none;align-items:center;gap:10px;padding:10px 18px;
            font:600 13px/1 system-ui,-apple-system,sans-serif;
            box-shadow:0 3px 20px rgba(0,0,0,.4);transition:background .25s;}
          #jb-bar .jd{width:8px;height:8px;border-radius:50%;background:#fff;
            animation:jb-bl 1.1s ease-in-out infinite;}
          #jb-bar .jx{margin-left:auto;cursor:pointer;opacity:.7;font-size:17px;
            background:none;border:none;color:inherit;line-height:1;padding:0;}
          #jb-box{position:fixed;z-index:2147483646;pointer-events:none;
            border-radius:8px;display:none;
            transition:top .28s cubic-bezier(.4,0,.2,1),left .28s cubic-bezier(.4,0,.2,1),
              width .28s cubic-bezier(.4,0,.2,1),height .28s cubic-bezier(.4,0,.2,1);}
          @keyframes jb-bl{0%,100%{opacity:1}50%{opacity:.25}}
          @keyframes jb-glow{
            0%,100%{box-shadow:0 0 0 3px rgba(124,58,237,.45),0 0 14px rgba(124,58,237,.3)}
            50%{box-shadow:0 0 0 7px rgba(124,58,237,.65),0 0 32px rgba(124,58,237,.7)}}
          .jb-pulse{animation:jb-glow .75s ease-in-out 4!important;}
          @keyframes jb-spot{
            0%,100%{box-shadow:0 0 0 4px rgba(124,58,237,.55),0 0 18px rgba(124,58,237,.5),
              0 0 0 9999px rgba(10,5,25,.30)}
            50%{box-shadow:0 0 0 9px rgba(124,58,237,.85),0 0 40px rgba(167,139,250,.9),
              0 0 0 9999px rgba(10,5,25,.38)}}
          .jb-spot{animation:jb-spot .8s ease-in-out infinite!important;}
          .jb-tick{position:absolute;top:8px;right:42px;z-index:9999;width:22px;height:22px;
            border-radius:6px;border:2px solid #7c3aed;background:#fff;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            font:700 13px/1 system-ui;color:#c4b5fd;transition:all .15s;}
          .jb-tick:hover{transform:scale(1.15);}
          .jb-tick.on{background:#7c3aed;color:#fff;box-shadow:0 0 8px rgba(124,58,237,.6);}
          @keyframes jb-glow-act{
            0%,100%{box-shadow:0 0 0 3px rgba(217,119,6,.6),0 0 16px rgba(217,119,6,.5),
              0 0 0 9999px rgba(10,5,25,.35)}
            50%{box-shadow:0 0 0 9px rgba(217,119,6,.85),0 0 40px rgba(245,158,11,.9),
              0 0 0 9999px rgba(10,5,25,.45)}}
          .jb-act{animation:jb-glow-act .7s ease-in-out infinite!important;border-color:#f59e0b!important;}
          #jb-bar.jb-bar-act{animation:jb-bl 1s ease-in-out infinite;}
        `;
        document.head.appendChild(s);
      }

      bar = document.createElement('div');
      bar.id = 'jb-bar';
      bar.innerHTML = '<span class="jd"></span><span id="jb-msg">JobBot active</span>' +
                      '<button class="jx" title="Stop">✕</button>';
      bar.querySelector('.jx').onclick = stopAgent;
      document.body.appendChild(bar);

      box = document.createElement('div');
      box.id = 'jb-box';
      document.body.appendChild(box);
    }

    const CLR = {
      info:     ['#1d4ed8','#fff'],
      applying: ['#6d28d9','#fff'],
      success:  ['#065f46','#fff'],
      warning:  ['#92400e','#fff'],
      error:    ['#991b1b','#fff'],
    };

    return {
      status(msg, type = 'info') {
        init();
        const [bg, fg] = CLR[type] || CLR.info;
        bar.style.cssText += `;background:${bg};color:${fg};`;
        bar.style.display = 'flex';
        const el = document.getElementById('jb-msg');
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
        box.classList.remove('jb-act');
        box.classList.remove('jb-spot');
        void box.offsetWidth; // force reflow so the animation restarts
        box.classList.add('jb-spot');
        box._loop = setInterval(place, 150); // track the element while spotlit
        box._t = setTimeout(() => {
          clearInterval(box._loop);
          box.classList.remove('jb-spot');
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
        bar.classList.add('jb-bar-act');
        const m = document.getElementById('jb-msg');
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
          box.classList.add('jb-act');
        };
        box.classList.remove('jb-spot');
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
          box.classList.remove('jb-act'); box.classList.remove('jb-spot');
          box.style.display = 'none';
        }
        if (bar) bar.classList.remove('jb-bar-act');
      },
      hide() {
        if (bar) { bar.style.display = 'none'; bar.classList.remove('jb-bar-act'); }
        if (box) {
          clearInterval(box._loop);
          box.classList.remove('jb-act'); box.classList.remove('jb-spot');
          box.style.display = 'none';
        }
      },
    };
  })();

  // ─── Smart Form Filler ────────────────────────────────────────────────────
  class Filler {
    constructor(p) {
      this.p = p || {};
      this._aiCache = new Map();
    }

    // AI fallback (Gemini via the user's backend) for questions map() can't answer
    async aiAnswer(question, options = []) {
      const prefs = this.p.preferences || {};
      if (!prefs.aiEnabled || !prefs.crmUrl || !prefs.crmKey) return null;
      const q = String(question).trim();
      if (q.length < 3) return null;

      const cacheKey = q + '|' + options.join(',');
      if (this._aiCache.has(cacheKey)) return this._aiCache.get(cacheKey);

      try {
        SPOT.status(`AI answering: "${q.substring(0, 50)}…"`, 'applying');
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(`${prefs.crmUrl.replace(/\/+$/, '')}/api/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': prefs.crmKey },
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
      if (/\bname\b/i.test(t) && !/company|employer/i.test(t)) return per.name || '';
      if (/\bemail\b/i.test(t))                               return per.email || '';
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
        if (!ans) continue;
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
        if (!ans) continue;

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
      const btn = $('button[aria-label="View next page"], button[aria-label="Next"], ' +
                    '.jobs-search-pagination__button--next:not([disabled]), ' +
                    '.artdeco-pagination__button--next:not([disabled])');
      if (!btn || btn.disabled) return false;
      await humanClick(btn, 'Next page…');
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
            SPOT.status('All ticked jobs done – tick more jobs, or ✕ to stop', 'success');
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
      return $$('[data-testid="ia-continueButton"], [data-testid="ia-submitButton"], ' +
                '.ia-BasePage, [data-testid="ia-Questions-main"], .ia-Modal').some(isVis);
    }

    jobCards() {
      return $$('.job_seen_beacon, [data-testid="slider_item"], .resultContent, ' +
                '[data-testid="job-card"], li[class*="result"] [class*="cardOutline"], ' +
                'div[class*="jobCard"], li.eu4oa1w0').filter(isVis);
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
      // First: try a button already visible in the card or the open detail panel
      let btn = this.findApplyButton(card) || this.findApplyButton(document);

      if (!btn) {
        // Open the job's detail panel, then poll for the Apply button to render
        const title = $('h2 a[data-jk], a.jcs-JobTitle, h2 a, a[class*="JobTitle"], ' +
                        'a[id^="job_"], [class*="title"] a', card) || card;
        if (title) {
          SPOT.pulse(title, `Opening: ${(title.textContent || '').trim().substring(0, 55)}`);
          realClick(title);
          await sleep(rand(1000, 1800));
        }
        for (let i = 0; i < 10 && !btn; i++) {        // up to ~8s for the panel to load
          btn = this.findApplyButton(document);
          if (!btn) await sleep(800);
        }
      }

      if (!btn || !isVis(btn)) return 'none';
      if (/applied/i.test(btn.textContent)) return 'already';

      // Force same-tab so the apply flow stays in this tab and auto-resume works
      if (btn.tagName === 'A') btn.setAttribute('target', '_self');
      btn.removeAttribute && btn.removeAttribute('target');

      // Mark this navigation as an intended apply so, if the click triggers a
      // full page load, the watchdog/auto-resume immediately knows to continue.
      const beforeUrl = location.href;

      // Lock the spotlight on "Apply with Indeed" through the whole click +
      // retry sequence so it's obvious and reliably registers.
      SPOT.pulse(btn, '🟦 Clicking "Apply with Indeed"…');
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(350, 600));

      // Click the resolved element AND its nearest interactive ancestor, in case
      // the visible label is a span inside the real button.
      const targetsOf = b => [b, b.closest && b.closest('button, a, [role="button"]')]
        .filter((v, i, a) => v && a.indexOf(v) === i);

      // Success = a STATE CHANGE after our click: the URL changed, or the apply
      // UI appeared where there was none. Never judge by absolute state alone –
      // that returned 'clicked' without clicking when a stray match existed.
      const wasApplyState = this.isApplyPage();
      const opened = () =>
        location.href !== beforeUrl
        || (!wasApplyState && this.isApplyPage())
        || this.isDone()
        || this.isAlreadyApplied();

      // Up to ~16s: Indeed's React button often ignores the first click(s)
      // while it hydrates. Always click FIRST, then re-click every ~2.4s.
      for (let i = 0; i < 20; i++) {
        if (i % 3 === 0) {
          if (!btn.isConnected || !isVis(btn)) btn = this.findApplyButton(document) || btn;
          if (btn.isConnected && isVis(btn)) {
            const r = btn.getBoundingClientRect();
            await moveTo(r.left + r.width / 2, r.top + r.height / 2);
            await sleep(rand(80, 180));
            for (const t of targetsOf(btn)) { try { realClick(t); } catch {} }
            if (i > 0) SPOT.pulse(btn, '🟦 Retrying "Apply with Indeed"…');
          }
        }
        await sleep(800);
        if (opened()) return 'clicked';
      }
      return opened() ? 'clicked' : 'none';
    }

    async fillStep() {
      // Scope to main form area to avoid filling page header/footer
      const form = $('.ia-Questions-main, .ia-BasePage-main, [data-testid="ia-Questions-main"]') || document.body;
      await this.f.all(form);
      await sleep(rand(350, 600));
    }

    btnText(el) { return (el.textContent || el.value || '').trim(); }

    findStepButtons() {
      const els = $$('button, [role="button"], input[type="submit"], input[type="button"]');
      const cont =
        $('[data-testid="ia-continueButton"], [data-testid="continue-button"]') ||
        els.find(b => /^(continue|continue applying|next|save and continue)$/i.test(this.btnText(b))) ||
        els.find(b => /continue/i.test(this.btnText(b)) && !/skip|without/i.test(this.btnText(b)));
      const sub =
        $('[data-testid="ia-submitButton"], [data-testid="submit-button"]') ||
        els.find(b => /submit (my |your )?application|^submit$|apply now/i.test(this.btnText(b)));
      return { cont, sub };
    }

    // A reCAPTCHA the user must solve by hand. We never try to tick or solve it:
    // a scripted click can't satisfy reCAPTCHA and only raises bot suspicion.
    hasCaptcha() {
      return !!$('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], .g-recaptcha, ' +
                 '[data-testid*="captcha"], iframe[src*="hcaptcha"]');
    }

    // Pause and let the human tick the captcha; resume the moment Submit enables.
    async waitForCaptcha(sub) {
      SPOT.attention(this.hasCaptcha() ? ($('iframe[src*="recaptcha"]') || sub) : sub,
        '🔐 Please tick the "I\'m not a robot" box — I\'ll submit automatically');
      for (let i = 0; i < 600 && this.running; i++) { // wait up to ~10 min
        await sleep(1000);
        const { sub: s2 } = this.findStepButtons();
        if (this.isDone()) { SPOT.clearAttention(); return 'submitted'; }
        if (s2 && isVis(s2) && !s2.disabled) {       // captcha solved → button live
          SPOT.clearAttention();
          await sleep(rand(500, 1100));
          await humanClick(s2, '🎉 Submitting my application!');
          await sleep(rand(1500, 2500));
          return 'submitted';
        }
      }
      SPOT.clearAttention();
      return 'blocked';
    }

    async clickContinue() {
      const { cont, sub } = this.findStepButtons();

      if (cont && isVis(cont) && !cont.disabled) {
        await humanClick(cont, '✨ Clicking CONTINUE…');
        await sleep(rand(900, 1600));
        return 'continue';
      }

      if (sub && isVis(sub) && !sub.disabled) {
        await humanClick(sub, '🎉 Submitting my application!');
        await sleep(rand(1500, 2500));
        return 'submitted';
      }

      // Submit is present but disabled while a captcha is unsolved → hand to human
      if (sub && sub.disabled && this.hasCaptcha()) {
        return await this.waitForCaptcha(sub);
      }

      // Button exists but is disabled → required fields are still empty
      if ((cont && cont.disabled) || (sub && sub.disabled)) return 'blocked';
      return null;
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
      await this.returnToList();
    }

    // After submitting, get back to the search results so the run continues.
    // Prefer the explicit "Return to job search" button on the confirmation
    // page; fall back to history.back (twice if we're still on the apply flow).
    async returnToList() {
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

        // Process jobs one by one, re-querying the list after each so the
        // sequence survives panel re-renders. Clicking Apply usually
        // navigates away; auto-resume brings the run back here afterwards.
        let progressed = true;
        while (progressed && this.running) {
          progressed = false;
          for (const card of this.jobCards()) {
            const jk = this.cardId(card);
            if (jk && (appliedSet.has(jk) || attemptedSet.has(jk))) continue;
            if (jk) attemptedSet.add(jk); // session-only; permanent mark happens on confirmed apply

            card.scrollIntoView({ block: 'center' });
            await sleep(rand(300, 600));
            const res = await this.clickApply(card);
            if (res === 'clicked') await this.runApplication();
            else {
              if (res === 'already' && jk) appliedSet.add(jk); // Indeed says applied → permanent
              this.skipped++; reportSkip();
            }

            await sleep(rand(900, 1700));
            progressed = true;
            break; // re-query the list for the next job
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
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    jobCards() {
      return $$(
        '.srp-jobtuple-wrapper, [class*="jobTuple"], .cust-job-tuple, ' +
        'article[class*="jobTuple"], div[data-job-id]'
      ).filter(isVis);
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
      if (link.tagName === 'A') link.setAttribute('target', '_self'); // same tab so the run can resume
      await sleep(rand(300, 700));
      realClick(link);
      await sleep(rand(2800, 4200));
      return true;
    }

    // Naukri has two buttons: "Apply" (on-platform, automatable) and
    // "Apply on company site" (external tab – we can't fill that, so skip).
    findApplyButton() {
      const company = $('#company-site-button, [class*="company-site"]');
      const apply = $('#apply-button, button[class*="apply-button"], a[class*="apply-button"]')
        || $$('button, a[role="button"]').find(b =>
            isVis(b) && /^apply\b/i.test(b.textContent.trim()) && !/company\s*site/i.test(b.textContent));
      if (apply && isVis(apply) && !/applied/i.test(apply.textContent)) return { btn: apply, external: false };
      if (apply && /applied/i.test(apply.textContent)) return { btn: null, external: false, already: true };
      if (company && isVis(company) && !apply) return { btn: null, external: true };
      return { btn: null, external: false };
    }

    async clickApply() {
      const { btn, external, already } = this.findApplyButton();
      if (already) return 'already';
      if (external) return 'external';
      if (!btn) return false;
      await humanClick(btn, 'Applying on Naukri…');
      await sleep(rand(1200, 2000));
      return true;
    }

    // The apply chatbot drawer that pops in after clicking Apply
    chatbot() {
      return $('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], div._chatBotContainer, ' +
               '.chatbot_MessageContainer, [class*="apply-popup"]');
    }

    isApplied() {
      // Green success toast / message Naukri shows on a successful apply
      if ($$('[class*="apply"], [class*="success"], [class*="toast"]')
            .some(el => isVis(el) && /successfully applied|application sent|you have applied/i.test(el.textContent))) {
        return true;
      }
      // The Apply button flips to "Applied"
      const b = $('#apply-button');
      return !!b && /applied/i.test(b.textContent) && !/apply\b(?!ied)/i.test(b.textContent.trim());
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
    async answerChat(drawer) {
      const question = this.chatQuestion(drawer);

      // Resolve which option the profile/AI would pick from a list of labels
      const choose = async (labels) => {
        let pick = this.f.bestOption(question, labels);
        if (!pick) {
          const ai = await this.f.aiAnswer(question, labels);
          if (ai) pick = labels.find(o => o.toLowerCase() === ai.toLowerCase())
                      || labels.find(o => o.toLowerCase().includes(ai.toLowerCase())
                                       || ai.toLowerCase().includes(o.toLowerCase()));
        }
        return pick ? labels.findIndex(o => o === pick) : 0;
      };

      // 1) Radio buttons – click the <input> itself, NOT the wrapper
      //    (clicking the container lands in padding and never registers)
      const radioWraps = $$('div.ssrc__radio-btn-container, [class*="ssrc__radio"]', drawer)
        .map(w => ({ input: $('input[type="radio"], input.ssrc__radio', w) || (w.matches('input') ? w : null),
                     label: ($('.ssrc__label', w) || w).textContent.trim() }))
        .filter(r => r.input && r.label);
      if (radioWraps.length) {
        const idx = await choose(radioWraps.map(r => r.label));
        const r = radioWraps[idx] || radioWraps[0];
        SPOT.pulse(r.input, `Selecting: "${r.label.slice(0, 40)}"`);
        await sleep(rand(300, 700));
        realClick(r.input);
        r.input.dispatchEvent(new Event('change', { bubbles: true }));
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
          const el = optEls[await choose(opts)] || optEls[0];
          SPOT.pulse(el, `Selecting: "${el.textContent.trim().slice(0, 40)}"`);
          await sleep(rand(300, 700));
          realClick(el);
          await sleep(rand(300, 600));
        } else {
          // 4) Free text – Naukri uses a contenteditable <div class="textArea">,
          //    not a real input, so set textContent + input event
          const input = $('div.textArea[contenteditable="true"], [contenteditable="true"], ' +
                          'textarea, input[type="text"], input:not([type])', drawer);
          if (input && isVis(input)) {
            let ans = this.f.map(question) || await this.f.aiAnswer(question);
            if (!ans) ans = this.f.p.professional?.coverLetter || 'Yes';
            SPOT.pulse(input, `Answering: "${question.slice(0, 40)}"`);
            if (input.isContentEditable) {
              input.focus();
              await sleep(rand(150, 350));
              input.textContent = ans;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              await typeInto(input, ans);
            }
            await sleep(rand(300, 600));
          }
        }
      }

      // 5) Click Save/Send – it's a <div class="sendMsg">, not a <button>
      const send =
        $('div.sendMsg, [class*="sendMsgbtn"] div.sendMsg, [id^="sendMsgbtn_container"] div, ' +
          '[class*="sendMsg"], [class*="send-btn"], [class*="saveBtn"]', drawer) ||
        $$('button, div[role="button"], div', drawer).find(b =>
          isVis(b) && /^(save|send|submit|next|continue)$/i.test(b.textContent.trim()));
      if (send && isVis(send)) { await humanClick(send, 'Sending answer…'); await sleep(rand(800, 1500)); return true; }
      return false;
    }

    async handleForm() {
      if (this.isApplied()) return 'done';

      const drawer = this.chatbot();
      if (drawer) {
        this._sawDrawer = true;
        await this.answerChat(drawer);
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
      const r = await this.clickApply();
      if (r === 'external') { SPOT.status('Apply on company site – skipping', 'warning'); return 'skip'; }
      if (r === 'already')  { SPOT.status('Already applied – skipping', 'info');        return 'skip'; }
      if (!r)               return 'skip';

      let steps = 0, misses = 0;
      while (steps < 25 && this.running) {
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
      const btn =
        $('a[class*="pagination"][title="Next"], a.styles_btn-secondary__next, ' +
          '[class*="pagination"] a[class*="next"], a[title="Next"]') ||
        $$('a, button').find(a => isVis(a) && /^next( page)?$/i.test(a.textContent.trim()));
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2800, 4200));
      return true;
    }

    async run() {
      this.running = true;

      // Resumed on a job detail page after same-tab navigation – apply here,
      // then go back; auto-resume continues the run on the job list.
      if (/\/job-listings-/i.test(location.pathname) && !this.jobCards().length) {
        attemptedSet.add(normalizeJobId(location.href)); // no loops this session
        const out = await this.applyHere();
        if (out === 'done') {
          appliedSet.add(normalizeJobId(location.href)); // confirmed → permanent
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
          SPOT.status(`✓ Applied on Naukri! (${this.applied} total)`, 'success');
          await sleep(rand(1500, 2500));
        } else { this.skipped++; reportSkip(); }
        history.back();
        await sleep(rand(2500, 3500));
        this.running = false;
        return 'nav';
      }

      SPOT.status('Naukri – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) break;

        // One job at a time, re-querying after each so the sequence survives
        // re-renders. Opening a job navigates; auto-resume returns us here.
        let progressed = true;
        while (progressed && this.running) {
          progressed = false;
          for (const card of this.jobCards()) {
            const jid = this.cardId(card);
            if (jid && (appliedSet.has(jid) || attemptedSet.has(jid))) continue;
            if (jid) attemptedSet.add(jid); // permanent mark happens on confirmed apply

            card.scrollIntoView({ block: 'center' });
            await sleep(rand(500, 1000));
            if (!await this.openJob(card)) { this.skipped++; reportSkip(); progressed = true; break; }

            const out = await this.applyHere();
            if (out === 'done') {
              this.applied++;
              if (jid) appliedSet.add(jid); // confirmed → permanent memory
              appliedSet.add(normalizeJobId(location.href));
              report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
              SPOT.status(`✓ Applied on Naukri! (${this.applied} total)`, 'success');
            } else { this.skipped++; reportSkip(); }

            await sleep(rand(1500, 2500));
            history.back();
            await sleep(rand(2800, 3800));
            progressed = true;
            break; // re-query the refreshed list
          }
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
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
  const attemptedSet = (() => {
    let s = new Set();
    try { s = new Set(JSON.parse(sessionStorage.getItem('jobbot_attempted') || '[]')); } catch {}
    const persist = () => {
      try { sessionStorage.setItem('jobbot_attempted', JSON.stringify([...s].slice(-2000))); } catch {}
    };
    return {
      has: id => s.has(id),
      add: id => { if (!id) return; s.add(id); persist(); },
      // An explicit user Start = a fresh run: forget mere attempts so the list
      // is re-scanned (permanent appliedSet still prevents re-applying).
      clear: () => { s = new Set(); persist(); },
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

  // Ticked jobs: the user queues specific jobs with the ✓ boxes injected on
  // LinkedIn cards; Start then applies ONLY those, in list order. No ticks =
  // apply everything (default). Per-tab, survives in-tab navigation.
  const selectedSet = (() => {
    let s = new Set();
    try { s = new Set(JSON.parse(sessionStorage.getItem('jobbot_selected') || '[]')); } catch {}
    const persist = () => { try { sessionStorage.setItem('jobbot_selected', JSON.stringify([...s])); } catch {} };
    return {
      size: () => s.size,
      has: id => s.has(id),
      toggle(id) { s.has(id) ? s.delete(id) : s.add(id); persist(); return s.has(id); },
      remove(id) { s.delete(id); persist(); },
    };
  })();
  const selectionMode = () => { try { return sessionStorage.getItem('jobbot_selmode') === '1'; } catch { return false; } };

  let agent = null;
  let lastDoneAt = 0; // when a full pass finished; throttles monitor-mode re-scans
  const IS_TOP = window === window.top;

  async function startAgent(profile) {
    if (agent?.running) return;
    const f = new Filler(profile);
    if      (PLATFORM === 'linkedin') agent = new LinkedInAgent(f);
    else if (PLATFORM === 'indeed')   agent = new IndeedAgent(f);
    else if (PLATFORM === 'naukri')   agent = new NaukriAgent(f);
    else { SPOT.status('Not a supported job site', 'error'); return; }

    // Only the top frame owns the running flag; 'nav' means the page is about
    // to navigate mid-run (apply flow / back / next page) and the run resumes
    // on the next page load – so the flag must survive.
    // Wait for the durable seen-jobs memory before scanning, so a job applied
    // just before this navigation is never picked again.
    try { await appliedSet.ready; } catch {}

    // setStore: chrome.* throws once the extension is reloaded ("context
    // invalidated") – never let that kill the page or the run loop.
    const setStore = obj => { try { chrome.storage.local.set(obj); } catch {} };

    if (IS_TOP) setStore({ jobbot_running: true });
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
        SPOT.status('All visible jobs processed – monitoring for new ones… (✕ to stop)', 'info');
      }
      agent = null;
    }
  }

  function stopAgent() {
    if (agent) { agent.stop(); agent = null; }
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
        // Ticked jobs present → this run applies only those, in sequence
        try { sessionStorage.setItem('jobbot_selmode', selectedSet.size() > 0 ? '1' : '0'); } catch {}
        startAgent(msg.profile || {});
        reply({ ok: true });
        break;
      case 'STOP_AGENT':
        stopAgent();
        reply({ ok: true });
        break;
      case 'GET_STATUS':
        reply({ running: !!agent?.running, platform: PLATFORM,
                applied: agent?.applied || 0, skipped: agent?.skipped || 0 });
        break;
    }
    return true;
  });

  // Auto-resume: Indeed/Naukri apply flows and pagination are full page
  // navigations that destroy the running agent. If a run is in progress,
  // restart the right agent on every page load so the run continues
  // seamlessly: job → apply → back to list → next job → next page.
  chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], data => {
    if (!data.jobbot_running || !data.jobbot_profile) return;

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

  // ─── Tick boxes on LinkedIn job cards ───────────────────────────────────────
  // Lets the user queue specific jobs: tick ✓ on cards, press Start, and the
  // agent applies exactly those in sequence. LinkedIn only (Indeed is locked).
  if (IS_TOP && PLATFORM === 'linkedin') {
    const probe = new LinkedInAgent(new Filler({}));
    const tickTimer = setInterval(() => {
      if (!contextAlive()) { clearInterval(tickTimer); return; }
      let cards;
      try { cards = probe.jobCards(); } catch { return; }
      for (const card of cards) {
        if (card.querySelector('.jb-tick')) continue;
        const id = probe.cardId(card);
        if (!id) continue;
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        const t = document.createElement('div');
        t.className = 'jb-tick' + (selectedSet.has(id) ? ' on' : '');
        t.textContent = '✓';
        t.title = 'JobBot: tick to queue this job, then press Start';
        t.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          const on = selectedSet.toggle(id);
          t.classList.toggle('on', on);
          SPOT.status(selectedSet.size()
            ? `${selectedSet.size()} job(s) ticked – press Start to apply them in sequence`
            : 'No jobs ticked – Start applies all jobs', 'info');
        }, true);
        card.appendChild(t);
      }
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
        SPOT.hide();
        return;
      }
      if (agent && agent.running) return;
      // Monitor mode: after a full pass, re-scan every ~60s for new postings
      // instead of hammering an exhausted list.
      if (lastDoneAt && Date.now() - lastDoneAt < 60000) return;
      try {
        chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], d => {
          if (chrome.runtime.lastError) return;
          if (d.jobbot_running && d.jobbot_profile && !(agent && agent.running)) {
            startAgent(d.jobbot_profile);
          }
        });
      } catch { clearInterval(watchdog); }
    }, 5000);
  }

})();
