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

  // Full pointer/mouse event sequence – React buttons (Indeed) often ignore bare .click()
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
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
  function reportSkip() { report({ type: 'JOB_SKIPPED', platform: PLATFORM }); }

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
            border-radius:8px;display:none;}
          @keyframes jb-bl{0%,100%{opacity:1}50%{opacity:.25}}
          @keyframes jb-glow{
            0%,100%{box-shadow:0 0 0 3px rgba(124,58,237,.45),0 0 14px rgba(124,58,237,.3)}
            50%{box-shadow:0 0 0 7px rgba(124,58,237,.65),0 0 32px rgba(124,58,237,.7)}}
          .jb-pulse{animation:jb-glow .75s ease-in-out 3!important;}
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
        // FIX: position:fixed uses viewport coords — no scroll offset needed
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        Object.assign(box.style, {
          display: 'block',
          top:    `${Math.max(0, r.top  - 5)}px`,
          left:   `${Math.max(0, r.left - 5)}px`,
          width:  `${r.width  + 10}px`,
          height: `${r.height + 10}px`,
          border: '3px solid #7c3aed',
        });
        box.classList.remove('jb-pulse');
        void box.offsetWidth; // force reflow
        box.classList.add('jb-pulse');
        clearTimeout(box._t);
        box._t = setTimeout(() => { if (box) box.style.display = 'none'; }, 2200);
      },
      hide() {
        if (bar) bar.style.display = 'none';
        if (box) box.style.display = 'none';
      },
    };
  })();

  // ─── Smart Form Filler ────────────────────────────────────────────────────
  class Filler {
    constructor(p) { this.p = p || {}; }

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

        const chosen = this.bestOption(question, opts);
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
        const ans   = this.map(label);
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
        const ans   = this.map(label);
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
  class LinkedInAgent {
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    jobCards() {
      return $$(
        'li.jobs-search-results__list-item, li[data-occludable-job-id], ' +
        'li.scaffold-layout__list-item, .job-card-container--clickable, div[data-job-id]'
      ).filter(isVis);
    }

    cardId(card) {
      return card.getAttribute('data-occludable-job-id')
          || card.getAttribute('data-job-id')
          || $('[data-job-id]', card)?.getAttribute('data-job-id')
          || $('a[href*="/jobs/view/"]', card)?.href
          || '';
    }

    async openCard(card) {
      // Use specific title links, not generic <a> fallback
      const link = $('a.job-card-list__title--link, a.job-card-list__title, ' +
                     'a.job-card-container__link, a[class*="job-card-list__title"], a[href*="/jobs/view/"]', card);
      if (!link) return false;
      SPOT.pulse(link, `Opening: ${link.textContent.trim().substring(0, 60)}`);
      link.click();
      await sleep(rand(1800, 3000));
      return true;
    }

    async findEasyApply() {
      try {
        const btn = await waitFor(
          '.jobs-apply-button--top-card button, .jobs-s-apply button, button[aria-label*="Easy Apply"]',
          document, 6000
        );
        const txt = btn.textContent.trim();
        if (/applied|saved/i.test(txt) || !/apply/i.test(txt)) return null;
        return btn;
      } catch { return null; }
    }

    async handleStep() {
      const modal = $('.jobs-easy-apply-content, [data-test-modal]');
      if (!modal) return 'no-modal';

      if ($('.artdeco-inline-feedback--success, .jobs-post-apply-nirvanaBanner', document)) return 'done';

      await this.f.all(modal);
      await sleep(rand(350, 600));

      const submit = $('button[aria-label="Submit application"]', modal)
                   || $$('button', modal).find(b => isVis(b) && /submit application/i.test(b.getAttribute('aria-label') || ''));
      if (submit && isVis(submit)) {
        await humanClick(submit, '🎉 Submitting!');
        await sleep(rand(2500, 3500));
        return 'done';
      }

      const review = $('button[aria-label="Review your application"]', modal)
                   || $$('button', modal).find(b => isVis(b) && /review/i.test(b.getAttribute('aria-label') || ''));
      if (review) { await humanClick(review, 'Review…'); return 'continue'; }

      const next = $('button[aria-label="Continue to next step"]', modal)
                 || $('[data-easy-apply-next-button]', modal)
                 || $$('button', modal).find(b => isVis(b) && /^(continue|next)$/i.test(b.textContent.trim()));
      if (next) { await humanClick(next, 'Next step…'); return 'continue'; }

      return 'stuck';
    }

    async dismissModal() {
      const btn = $('[data-test-modal-close-btn], button[aria-label="Dismiss"], button[aria-label="Discard"]');
      if (btn) { btn.click(); await sleep(rand(600, 1000)); }
    }

    async applyCard(card) {
      if (!await this.openCard(card)) { this.skipped++; reportSkip(); return; }

      const btn = await this.findEasyApply();
      if (!btn) { SPOT.status('No Easy Apply – skipping', 'warning'); this.skipped++; reportSkip(); return; }

      await humanClick(btn, 'Easy Apply clicked…');
      await sleep(rand(700, 1200));
      SPOT.status('Filling application…', 'applying');

      let i = 0;
      while (i < 30 && this.running) {
        const r = await this.handleStep();
        if (r === 'done') {
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: 'linkedin', title: document.title, url: location.href });
          SPOT.status(`✓ Applied! (${this.applied} total)`, 'success');
          await sleep(rand(1500, 2500));
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
        if (!cards.length) break;

        // LinkedIn virtualizes the list – cards detach from the DOM as you scroll.
        // Re-query after every application and pick the first unseen card.
        let progressed = true;
        while (progressed && this.running) {
          progressed = false;
          for (const card of this.jobCards()) {
            const id = this.cardId(card);
            if (id && appliedSet.has(id)) continue;
            if (id) appliedSet.add(id);

            card.scrollIntoView({ block: 'center' });
            await sleep(rand(400, 800));
            await this.applyCard(card);
            await sleep(rand(2200, 4000));
            progressed = true;
            break; // re-query the (possibly re-rendered) list
          }
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ─── Indeed Agent ─────────────────────────────────────────────────────────
  class IndeedAgent {
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    isApplyPage() {
      return /\/apply\b|apply\.indeed\.com|smartapply\.indeed\.com/i.test(location.href)
          || !!$('[data-testid="ia-continueButton"], [data-testid="ia-submitButton"], ' +
                 '.ia-BasePage, [data-testid="ia-Questions-main"], .ia-Modal, iframe[src*="indeedapply"]');
    }

    jobCards() {
      return $$('.job_seen_beacon, [data-testid="slider_item"], .resultContent').filter(isVis);
    }

    findApplyButton(scope = document) {
      // Dedicated ids / test-ids first (most stable)
      const direct = $(
        '#indeedApplyButton, [data-testid="indeedApplyButton"], ' +
        'button[id*="applyButton"]:not([disabled]), [data-testid="applyButton"], ' +
        '.jobsearch-IndeedApplyButton-newDesign, .ia-IndeedApplyButton',
        scope
      );
      if (direct && isVis(direct)) return direct;

      // Fallback: text match – "Apply now", "Apply with Indeed", "Easily apply"
      return $$('button, a[role="button"], a[href*="smartapply"], a[href*="indeedapply"]', scope)
        .find(el => isVis(el)
          && /apply now|apply with indeed|easily apply/i.test(el.textContent)
          && !/applied/i.test(el.textContent)) || null;
    }

    async clickApply(card) {
      // First: try button already visible in card or panel
      let btn = this.findApplyButton(card);

      if (!btn) {
        // Click the job title to open detail panel
        const title = $('h2 a[data-jk], a.jcs-JobTitle, h2 a', card);
        if (title) {
          SPOT.pulse(title, `Opening: ${title.textContent.trim().substring(0, 55)}`);
          realClick(title);
          await sleep(rand(1200, 2200));
        }
        // Look in the right-side detail panel – give it a moment to render
        for (let i = 0; i < 4 && !btn; i++) {
          btn = this.findApplyButton(document);
          if (!btn) await sleep(800);
        }
      }

      if (!btn || !isVis(btn)) return 'none';
      if (/applied/i.test(btn.textContent)) return 'already';

      // If it's a link that opens a new tab, force same-tab so auto-resume works
      if (btn.tagName === 'A') btn.setAttribute('target', '_self');

      await humanClick(btn, 'Opening Indeed Apply…');

      // Wait for the apply flow to actually appear (navigation or in-page form);
      // retry the click once if nothing happened – Indeed's button ignores
      // the first click while its JS is still hydrating.
      for (let i = 0; i < 8; i++) {
        await sleep(800);
        if (this.isApplyPage()) return 'clicked';
        if (i === 3) { realClick(btn); SPOT.status('Retrying Apply click…', 'applying'); }
      }
      return this.isApplyPage() ? 'clicked' : 'none';
    }

    async fillStep() {
      // Scope to main form area to avoid filling page header/footer
      const form = $('.ia-Questions-main, .ia-BasePage-main, [data-testid="ia-Questions-main"]') || document.body;
      await this.f.all(form);
      await sleep(rand(350, 600));
    }

    async clickContinue() {
      // Try dedicated test IDs first (most reliable)
      const cont =
        $('[data-testid="ia-continueButton"]') ||
        $('[data-testid="continue-button"]')    ||
        $$('button[type="submit"]').find(b => isVis(b) && /^continue$/i.test(b.textContent.trim())) ||
        $$('button').find(b => isVis(b) && /continue/i.test(b.textContent) && !/skip/i.test(b.textContent));

      if (cont && isVis(cont)) {
        SPOT.pulse(cont, '✨ Clicking CONTINUE…');
        await sleep(rand(600, 1000)); // visible spotlight pause
        cont.click();
        await sleep(rand(1200, 2000));
        return 'continue';
      }

      const sub =
        $('[data-testid="ia-submitButton"]') ||
        $$('button[type="submit"]').find(b => isVis(b) && /submit|apply now/i.test(b.textContent));

      if (sub && isVis(sub)) {
        SPOT.pulse(sub, '🎉 Submitting!');
        await sleep(rand(600, 1000));
        sub.click();
        await sleep(rand(1500, 2500));
        return 'submitted';
      }

      return null;
    }

    isDone() {
      return !!$(
        '[data-testid="ia-ThankYou"], [data-testid="ia-congrats"], .ia-ThankYou, ' +
        '[class*="ThankYou"], [class*="thank-you"], h1[data-testid*="thank"]'
      );
    }

    async runApplication() {
      SPOT.status('Processing Indeed application…', 'applying');
      let steps = 0;

      while (steps < 40 && this.running) {
        if (this.isDone()) {
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: 'indeed', title: document.title, url: location.href });
          SPOT.status(`✓ Applied on Indeed! (${this.applied} total)`, 'success');
          await sleep(rand(1800, 2800));
          history.back();
          await sleep(rand(2500, 3500));
          return true;
        }

        await this.fillStep();
        const res = await this.clickContinue();

        if (!res) {
          // Check once more for thank-you page after a moment
          await sleep(1500);
          if (this.isDone()) continue;
          SPOT.status('No Continue/Submit found – skipping', 'warning');
          this.skipped++; reportSkip();
          history.back();
          await sleep(2000);
          return false;
        }

        if (res === 'submitted') {
          await sleep(1500);
          if (!this.isDone()) continue; // form might have more steps
          this.applied++;
          report({ type: 'JOB_APPLIED', platform: 'indeed', title: document.title, url: location.href });
          SPOT.status(`✓ Applied on Indeed! (${this.applied} total)`, 'success');
          await sleep(rand(1800, 2800));
          history.back();
          await sleep(rand(2500, 3500));
          return true;
        }

        steps++;
        await sleep(rand(700, 1400));
      }

      history.back();
      await sleep(2000);
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

    async run() {
      this.running = true;

      if (this.isApplyPage()) {
        await this.runApplication();
        return;
      }

      SPOT.status('Indeed – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) break;

        for (const card of cards) {
          if (!this.running) break;

          // Deduplicate by job key
          const jk = $('a[data-jk]', card)?.getAttribute('data-jk') || $('a', card)?.getAttribute('data-jk') || '';
          if (jk && appliedSet.has(jk)) continue;
          if (jk) appliedSet.add(jk);

          const res = await this.clickApply(card);
          if (res === 'clicked') await this.runApplication();
          else this.skipped++; reportSkip();

          await sleep(rand(2000, 4000));
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ─── Naukri Agent ─────────────────────────────────────────────────────────
  class NaukriAgent {
    constructor(f) { this.f = f; this.applied = 0; this.skipped = 0; this.running = false; }

    jobCards() {
      return $$(
        '.srp-jobtuple-wrapper, article.jobTupleHeader, .jobTuple, .cust-job-tuple, [data-job-id]'
      ).filter(isVis);
    }

    async openJob(card) {
      const link = $('a.title, a.jobTitle, a[title][href*="naukri.com/"]', card)
                || $('h2 a, a[class*="title"]', card);
      if (!link) return false;
      SPOT.pulse(link, `Opening: ${link.textContent.trim().substring(0, 60)}`);
      link.setAttribute('target', '_self');
      link.click();
      await sleep(rand(2800, 4200));
      return true;
    }

    async clickApply() {
      const btn =
        $('button#apply-button, button.apply-button, a.apply-button, [id*="applyBtn"]:not([disabled])') ||
        $$('button').find(b => isVis(b) && /^apply( now)?$/i.test(b.textContent.trim()));
      if (!btn) return false;
      await humanClick(btn, 'Applying on Naukri…');
      await sleep(rand(900, 1700));
      return true;
    }

    async handleForm() {
      // Look for apply popup/chatbot first, then fall back to page
      const popup = $('.apply-popup, .qapply-popup, [class*="apply-popup"], .chatbot_DrawerContent');

      // Check success ONLY within popup if it exists, else full document
      const successRoot = popup || document;
      if ($('[class*="thankYou"], [class*="success-message"], .success-container, [class*="successScreen"]', successRoot)) {
        return 'done';
      }

      const container = popup || document.body;
      await this.f.all(container);
      await sleep(rand(350, 600));

      // Submit button
      const sub =
        $('button[type="submit"], button#submit-apply, button.submit-btn', container) ||
        $$('button', container).find(b => isVis(b) && /^(submit|apply now|send application)$/i.test(b.textContent.trim()));
      if (sub && isVis(sub)) {
        await humanClick(sub, 'Submitting on Naukri…');
        await sleep(rand(1500, 2500));
        if ($('[class*="thankYou"], [class*="success"]', successRoot)) return 'done';
      }

      // Chatbot Next button
      const nxt =
        $('[class*="nextBtn"]:not([disabled]), [data-id="nextbtn"], .chatbot_NextButton') ||
        $$('button', container).find(b => isVis(b) && /^(next|continue|proceed)$/i.test(b.textContent.trim()));
      if (nxt && isVis(nxt)) {
        await humanClick(nxt, 'Next step…');
        return 'continue';
      }

      return 'stuck';
    }

    async nextPage() {
      const btn =
        $('a[title="Next"], .pagination a.next, .styles_paginationarrow__next__1O8ea') ||
        $$('a').find(a => isVis(a) && /^next page$/i.test(a.textContent.trim()));
      if (!btn) return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2500, 4000));
      return true;
    }

    async run() {
      this.running = true;
      SPOT.status('Naukri – scanning jobs…', 'info');

      while (this.running) {
        const cards = await waitForCards(() => this.jobCards());
        SPOT.status(`${cards.length} jobs on page`, 'info');
        if (!cards.length) break;

        for (const card of cards) {
          if (!this.running) break;

          const link = $('a.title, a.jobTitle, a[class*="title"]', card);
          const jid  = link?.href || '';
          if (jid && appliedSet.has(jid)) continue;
          if (jid) appliedSet.add(jid);

          if (!await this.openJob(card)) { this.skipped++; reportSkip(); continue; }
          if (!await this.clickApply())  { this.skipped++; reportSkip(); history.back(); await sleep(2000); continue; }

          let steps = 0;
          while (steps < 20 && this.running) {
            const r = await this.handleForm();
            if (r === 'done') {
              this.applied++;
              report({ type: 'JOB_APPLIED', platform: 'naukri', title: document.title, url: location.href });
              SPOT.status(`✓ Applied on Naukri! (${this.applied} total)`, 'success');
              await sleep(rand(1500, 2500));
              history.back();
              await sleep(rand(2800, 3800));
              break;
            }
            if (r === 'stuck') {
              this.skipped++; reportSkip();
              history.back();
              await sleep(2000);
              break;
            }
            steps++;
            await sleep(rand(700, 1500));
          }

          await sleep(rand(2000, 3500));
        }

        if (!await this.nextPage()) break;
      }

      SPOT.status(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  // ─── Controller ───────────────────────────────────────────────────────────
  const appliedSet = new Set();
  let agent = null;

  async function startAgent(profile) {
    if (agent?.running) return;
    const f = new Filler(profile);
    if      (PLATFORM === 'linkedin') agent = new LinkedInAgent(f);
    else if (PLATFORM === 'indeed')   agent = new IndeedAgent(f);
    else if (PLATFORM === 'naukri')   agent = new NaukriAgent(f);
    else { SPOT.status('Not a supported job site', 'error'); return; }

    chrome.storage.local.set({ jobbot_running: true });
    try { await agent.run(); }
    catch (e) { SPOT.status(`Error: ${e.message}`, 'error'); }
    finally   { chrome.storage.local.set({ jobbot_running: false }); agent = null; }
  }

  function stopAgent() {
    if (agent) { agent.stop(); agent = null; }
    chrome.storage.local.set({ jobbot_running: false });
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

  // Auto-resume for Indeed apply page navigation
  chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], data => {
    if (data.jobbot_running && data.jobbot_profile && PLATFORM === 'indeed') {
      const tmpAgent = new IndeedAgent(new Filler(data.jobbot_profile));
      if (tmpAgent.isApplyPage()) {
        agent = tmpAgent;
        agent.run().finally(() => {
          chrome.storage.local.set({ jobbot_running: false });
          agent = null;
        });
      }
    }
  });

})();
