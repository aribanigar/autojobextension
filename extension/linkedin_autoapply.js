// extension/linkedin_autoapply.js
//
// ============================================================================
// INDEPENDENT FEATURE — "LinkedIn Bulk Auto Apply" (mirrors the proven engine)
// ============================================================================
// COMPLETELY self-contained. Does NOT import, call, read, or modify content.js,
// background.js, popup.js, or any of their functions/state. Own singleton guard
// (__jobbotLinkedInAutoApplyV2), own DOM namespace (`jbla-`), own floating
// button, own end-to-end apply flow. Cannot break any existing feature.
//
// This is a faithful port of a working LinkedIn Easy Apply engine. The only
// changes vs. that engine: namespace/branding, and answers are pulled from the
// user's saved profile (jobbot_profile, read-only) merged over sensible
// defaults. The apply logic, selectors, click escalation, stray-modal handling,
// and timing are kept as-is because they are proven to work on the 2026
// LinkedIn SDUI.
//
// Anti-bot: read-only DOM, no LinkedIn internal APIs, human pointer-sequence
// clicks, aborts on captcha/checkpoint, never clicks a card's Dismiss control.
// ============================================================================
(function () {
  if (window.__jobbotLinkedInAutoApplyV2) return;   // singleton
  window.__jobbotLinkedInAutoApplyV2 = true;

  const TAG = "[JobBot · LinkedIn AutoApply]";

  // ───────────────────────── helpers ─────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return min + Math.random() * (max - min); }

  function onJobsResultsPage() {
    return /^\/jobs\/(search-results|collections|search)\//.test(location.pathname)
        || /^\/jobs\/view\/\d+/.test(location.pathname);
  }
  function isCheckpoint() {
    return /\/checkpoint\//.test(location.pathname)
        || /\/uas\/captcha-submit/.test(location.pathname);
  }
  function visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function textOf(el) { return (el && (el.textContent || "")).replace(/\s+/g, " ").trim(); }
  function esc(s) { return (window.CSS && CSS.escape ? CSS.escape(s) : s); }

  // ──────────────────── humanised clicking ───────────────────
  function spotlight(el, holdMs) {
    if (!el) return;
    try {
      el.style.setProperty("outline", "3px solid #7c3aed", "important");
      el.style.setProperty("outline-offset", "3px", "important");
      el.style.setProperty("box-shadow", "0 0 0 6px rgba(124,58,237,0.25), 0 0 24px rgba(124,58,237,0.55)", "important");
      el.style.setProperty("animation", "jbla-pulse-ring 0.9s ease-in-out infinite", "important");
      el.setAttribute("data-jbla-spotlight", "true");
      setTimeout(() => {
        try {
          el.style.removeProperty("outline"); el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow"); el.style.removeProperty("animation");
          el.removeAttribute("data-jbla-spotlight");
        } catch (_) {}
      }, holdMs || 1500);
    } catch (_) {}
  }

  function humanClick(el) {
    if (!el) return false;
    try {
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + (Math.random() * 6 - 3);
      const cy = r.top + r.height / 2 + (Math.random() * 4 - 2);
      const down = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy,
                     button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true,
                     width: 1, height: 1, pressure: 0.5 };
      const up = Object.assign({}, down, { buttons: 0, pressure: 0 });
      el.dispatchEvent(new PointerEvent("pointerover", down));
      el.dispatchEvent(new PointerEvent("pointerenter", down));
      el.dispatchEvent(new PointerEvent("pointerdown", down));
      el.dispatchEvent(new MouseEvent("mousedown", down));
      el.dispatchEvent(new PointerEvent("pointerup", up));
      el.dispatchEvent(new MouseEvent("mouseup", up));
      el.dispatchEvent(new MouseEvent("click", up));
    } catch (_) {}
    return true;
  }

  function forceClick(btn) {
    if (!btn) return false;
    try { btn.click(); } catch (_) {}
    try { humanClick(btn); } catch (_) {}
    try { const inner = btn.querySelector(".artdeco-button__text") || btn.firstElementChild; if (inner) humanClick(inner); } catch (_) {}
    return true;
  }

  function setNativeValue(el, value) {
    try {
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype
                  : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  // ─────────────────── job-card detection ────────────────────
  function collectJobCards() {
    const seen = new Set(); const cards = [];
    document.querySelectorAll('button[aria-label^="Dismiss "][aria-label$=" job"]').forEach(btn => {
      const card = btn.closest('div[role="button"][componentkey]') || btn.closest('div[role="button"]');
      if (!card) return;
      const key = card.getAttribute("componentkey") || (btn.getAttribute("aria-label") || "");
      if (!key || seen.has(key)) return;
      seen.add(key);
      cards.push({ key, el: card, title: (btn.getAttribute("aria-label") || "").replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim() });
    });
    return cards;
  }
  function cardElForKey(key) {
    try { return document.querySelector('div[role="button"][componentkey="' + esc(key) + '"]'); } catch (_) { return null; }
  }
  function listScroller() {
    const btn = document.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]');
    let el = btn ? btn.closest('div[role="button"]') : null;
    while (el && el !== document.body) {
      try { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 24) return el; } catch (_) {}
      el = el.parentElement;
    }
    return null;
  }
  function listScrollTop() { const s = listScroller(); return s ? Math.round(s.scrollTop) : Math.round(window.scrollY); }
  function scrollListDown() { const s = listScroller(); if (s) { s.scrollBy(0, Math.round(s.clientHeight * 0.8)); return true; } return false; }

  // ─────────────── in-app Easy Apply control ─────────────────
  function findInAppApply() {
    const root = document.querySelector(
      ".jobs-search__job-details, .jobs-search__job-details--container, .jobs-search__job-details--wrapper, " +
      ".scaffold-layout__detail, .jobs-details, .job-view-layout, .jobs-details__main-content, " +
      ".job-details-jobs-unified-top-card__container--two-pane"
    ) || document.querySelector("main") || document;

    const inForbiddenSubtree = (el) =>
         !!el.closest("footer, [role='contentinfo']")
      || !!el.closest(".jobs-search-results-list, .jobs-search-results, .scaffold-layout__list, ul[role='list']")
      || !!el.closest(".global-footer, .footer, [class*='global-footer'], [class*='page-footer']")
      || !!el.closest("[data-test-modal-id='collection-banner-modal'], .artdeco-toast-item")
      || !!el.closest(".jbla-job-apply-row");

    const isExternal = (el) => {
      const t = textOf(el).toLowerCase();
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      if (a.includes("company website") || /apply on company website/i.test(t)) return true;
      if (el.querySelector("svg#link-external-medium, svg[id='link-external-medium']")) return true;
      const href = (el.getAttribute("href") || "").toLowerCase();
      if (href && /\/safety\/go\?|linkedin\.com\/safety\/go/.test(href)) return true;
      return false;
    };
    const isInAppApply = (el) => {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const href = (el.getAttribute("href") || "").toLowerCase();
      if (/easy apply|linkedin apply/i.test(aria)) return true;
      if (el.classList && el.classList.contains("jobs-apply-button")) return true;
      if (el.closest && el.closest(".jobs-apply-button__container, [class*='jobs-apply-button']")) return true;
      if (/(^|linkedin\.com)\/jobs\/view\/\d+\/apply/i.test(href)) return true;
      if (el.querySelector && el.querySelector("svg#linkedin-bug-medium, svg[id^='linkedin-bug']")) return true;
      return false;
    };

    for (const el of Array.from(root.querySelectorAll("button, a"))) {
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (inForbiddenSubtree(el)) continue;
      if (isExternal(el)) continue;
      if (!isInAppApply(el)) continue;
      return el;
    }
    return null;
  }

  // ─────────────────── easy-apply modal ──────────────────────
  function isEasyApplyDialog(d) {
    if (!d) return false;
    if (d.getAttribute("aria-labelledby") === "jobs-apply-header") return true;
    if (d.getAttribute("data-test-modal-id") === "easy-apply-modal") return true;
    if (d.querySelector(
      "button[data-easy-apply-next-button],button[data-live-test-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-submit-button],button[data-live-test-easy-apply-review-button]," +
      ".jobs-easy-apply-content,.jobs-easy-apply-form,.jobs-easy-apply-modal__content," +
      "[aria-label*='job application progress' i][role='region']"
    )) return true;
    const header = d.querySelector("h2, h3, [role='heading']");
    if (header && /^apply to /i.test((header.textContent || "").trim())) return true;
    return false;
  }
  function applyFormPresent() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'));
    for (const d of dialogs) if (visible(d) && isEasyApplyDialog(d)) return true;
    return !!(
      document.querySelector('[aria-label*="job application progress" i][role="region"]') ||
      document.querySelector(
        "button[data-easy-apply-next-button],button[data-live-test-easy-apply-next-button]," +
        'button[aria-label="Continue to next step"],button[data-live-test-easy-apply-submit-button],' +
        'button[aria-label="Submit application"],button[data-live-test-easy-apply-review-button],' +
        'button[aria-label="Review your application"]'
      )
    );
  }
  function applyFormScope() {
    const modal = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      ".jobs-easy-apply-modal,.jobs-easy-apply-modal__content,.jobs-easy-apply-content"
    );
    if (modal && visible(modal)) return modal;
    const region = document.querySelector('[aria-label*="job application progress" i][role="region"]');
    if (region) { const c = region.closest("form, .artdeco-modal, div[role='dialog'], .jobs-easy-apply-modal"); if (c && visible(c)) return c; }
    const btn = document.querySelector(
      "button[data-easy-apply-next-button],button[data-live-test-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-submit-button],button[data-live-test-easy-apply-review-button]," +
      'button[aria-label="Continue to next step"],button[aria-label="Submit application"],button[aria-label="Review your application"]'
    );
    if (btn) { const c = btn.closest("form, .artdeco-modal, div[role='dialog'], .jobs-easy-apply-modal"); if (c && visible(c)) return c; }
    return null;
  }
  function qDoc(sels) { for (const s of sels) { const e = document.querySelector(s); if (e && visible(e) && !e.disabled) return e; } return null; }
  function easyApplyDialogEl() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'));
    for (const d of dialogs) if (visible(d) && isEasyApplyDialog(d)) return d;
    return document;
  }
  function findActionByText(re) {
    const scope = easyApplyDialogEl();
    for (const b of Array.from(scope.querySelectorAll("button, [role='button']"))) {
      if (!visible(b) || b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (re.test(t) || re.test(a)) return b;
    }
    return null;
  }
  function nextButton() { return qDoc(["button[data-easy-apply-next-button]","button[data-live-test-easy-apply-next-button]",'button[aria-label="Continue to next step"]','button[aria-label*="Continue to next" i]']) || findActionByText(/^(next|continue to next step|continue|next step)$/i); }
  function reviewButton() { return qDoc(["button[data-live-test-easy-apply-review-button]",'button[aria-label="Review your application"]','button[aria-label*="Review your" i]']) || findActionByText(/^(review|review your application|review application)$/i); }
  function submitButton() { return qDoc(["button[data-live-test-easy-apply-submit-button]",'button[aria-label="Submit application"]','button[aria-label*="Submit application" i]']) || findActionByText(/^(submit|submit application|send|send application)$/i); }

  function escalateClick(btn) {
    if (!btn) return;
    try { btn.click(); } catch (_) {}
    try { const inner = btn.querySelector(".artdeco-button__text") || btn.querySelector("span") || btn.firstElementChild; if (inner && inner !== btn) { try { inner.click(); } catch (_) {} humanClick(inner); } } catch (_) {}
    try { const k = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }; btn.dispatchEvent(new KeyboardEvent("keydown", k)); btn.dispatchEvent(new KeyboardEvent("keyup", k)); } catch (_) {}
    try {
      const fKey = Object.keys(btn).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (fKey) {
        let fiber = btn[fKey];
        for (let depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
          const onClick = (fiber.memoizedProps && fiber.memoizedProps.onClick) || (fiber.pendingProps && fiber.pendingProps.onClick);
          if (typeof onClick === "function") { onClick({ type: "click", bubbles: true, cancelable: true, isTrusted: true, target: btn, currentTarget: btn, preventDefault: () => {}, stopPropagation: () => {}, nativeEvent: { isTrusted: true } }); break; }
        }
      }
    } catch (_) {}
  }
  function modalText() {
    const m = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      ".jobs-easy-apply-modal,.jobs-easy-apply-content,.jobs-easy-apply-form,[class*='easy-apply-content'],.artdeco-modal__content"
    );
    return ((m || document).innerText || "").trim();
  }

  // ─────────────── apply profile (user data + defaults) ──────
  let APPLY_PROFILE = {
    years_of_experience: "3", notice_period_days: "30 days",
    expected_salary: "", current_salary: "",
    willing_to_relocate: "Yes", authorized_to_work: "Yes", require_sponsorship: "No",
    gender: "Prefer not to say", full_name: "", first_name: "", last_name: "",
    email: "", phone: "", location: "", postal_code: "",
    current_company: "", current_title: "", education: "Bachelor's Degree",
    skills: "", languages: "English", cover_letter: "",
  };
  function loadApplyProfile() {
    try {
      chrome.storage.local.get(["jobbot_profile"], (res) => {
        const p = res && res.jobbot_profile; if (!p) return;
        const per = p.personal || {}, pro = p.professional || {}, prf = p.preferences || {};
        APPLY_PROFILE = Object.assign({}, APPLY_PROFILE, {
          years_of_experience: String(pro.experience || "3"),
          notice_period_days: pro.noticePeriod || "30 days",
          expected_salary: pro.expectedSalary || "",
          current_salary: pro.currentSalary || "",
          willing_to_relocate: prf.willingToRelocate ? "Yes" : "No",
          authorized_to_work: prf.workAuth !== false ? "Yes" : "No",
          gender: per.gender || "Prefer not to say",
          full_name: per.name || "", first_name: (per.name || "").split(" ")[0] || "",
          last_name: (per.name || "").split(" ").slice(1).join(" ") || "",
          email: per.email || "", phone: per.phone || "", location: per.location || "",
          postal_code: per.postalCode || "",
          current_company: pro.currentCompany || "", current_title: pro.currentTitle || "",
          education: pro.education || "Bachelor's Degree",
          skills: pro.skills || "", languages: pro.languages || "English",
          cover_letter: pro.coverLetter || "",
        });
      });
    } catch (_) {}
  }
  loadApplyProfile();

  function answerForLabel(rawLabel) {
    const l = (rawLabel || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!l) return null;
    const A = APPLY_PROFILE;
    if (/years.*experience|how many years|total experience|relevant experience|years of work/.test(l)) return A.years_of_experience;
    if (/notice period|available to (join|start)|when can you (join|start)/.test(l)) return A.notice_period_days;
    if (/expected (salary|ctc|compensation)|salary expectation|desired salary/.test(l)) return A.expected_salary;
    if (/current (salary|ctc|compensation)|present salary/.test(l)) return A.current_salary;
    if (/willing to relocate|open to relocat|relocation/.test(l)) return A.willing_to_relocate;
    if (/authori[sz]ed to work|right to work|work authori|legally authorized/.test(l)) return A.authorized_to_work;
    if (/sponsorship|require .* visa|visa sponsor|need sponsorship/.test(l)) return A.require_sponsorship;
    if (/current (company|employer|organi[sz]ation)/.test(l)) return A.current_company;
    if (/current (title|role|designation|position)/.test(l)) return A.current_title;
    if (/(mobile|phone|contact).*(number|no)|^phone/.test(l)) return A.phone;
    if (/email/.test(l)) return A.email;
    if (/(city|location|based)/.test(l)) return A.location;
    if (/(postal|zip|pin).?code|pincode/.test(l)) return A.postal_code;
    if (/first name/.test(l)) return A.first_name;
    if (/last name|surname/.test(l)) return A.last_name;
    if (/full name|your name/.test(l)) return A.full_name;
    if (/gender/.test(l)) return A.gender;
    if (/highest (qualification|education|degree)|education level/.test(l)) return A.education;
    if (/skills?/.test(l)) return A.skills;
    if (/languages?/.test(l)) return A.languages;
    if (/cover letter|why (do you want|are you interested)/.test(l)) return A.cover_letter || ("I bring " + A.years_of_experience + " years of experience and am excited to contribute.");
    return null;
  }
  function looksLikeExperience(str) { return /experien|years|how many|number of|notice period|salary|ctc|expected/i.test(str || ""); }

  // ─────────────────── form autofill ─────────────────────────
  function labelForField(scope, el) {
    let label = "";
    if (el.id) { const l = scope.querySelector('label[for="' + esc(el.id) + '"]'); if (l) label = textOf(l); }
    return label || el.getAttribute("aria-label") || el.name || "";
  }
  function untickFollowCompany(scope) {
    const cb = (scope || document).querySelector("#follow-company-checkbox");
    if (cb && cb.checked) { const lab = (scope || document).querySelector('label[for="follow-company-checkbox"]'); humanClick(lab || cb); }
  }
  function fillSelects(scope) {
    scope.querySelectorAll("select").forEach(sel => {
      const cur = (sel.value || "").trim();
      if (cur && cur !== "Select an option") return;
      const opts = Array.from(sel.options).filter(o => { const v = (o.value || "").trim(); return v && v !== "Select an option"; });
      if (!opts.length) return;
      const profileAns = (answerForLabel(labelForField(scope, sel)) || "").toString().toLowerCase();
      const byText = t => opts.find(o => (o.textContent || "").trim().toLowerCase() === t);
      const byContains = t => opts.find(o => (o.textContent || "").trim().toLowerCase().includes(t));
      const pick = opts.find(o => /@/.test(o.value || o.textContent))
        || opts.find(o => /India \(\+91\)/i.test(o.value || o.textContent))
        || (profileAns && (byText(profileAns) || byContains(profileAns)))
        || byText("yes") || opts[0];
      if (pick) setNativeValue(sel, pick.value);
    });
  }
  function fillTextInputs(scope) {
    scope.querySelectorAll("input, textarea").forEach(el => {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "file", "checkbox", "radio", "submit", "button"].includes(type)) return;
      if (el.value && el.value.trim()) return;
      const required = el.required || el.getAttribute("aria-required") === "true";
      const label = labelForField(scope, el);
      const fromProfile = answerForLabel(label);
      if (fromProfile != null && fromProfile !== "") { setNativeValue(el, fromProfile); return; }
      if (!required) return;
      setNativeValue(el, type === "number" || looksLikeExperience(label) ? APPLY_PROFILE.years_of_experience : APPLY_PROFILE.years_of_experience);
    });
  }
  // Resume step — LinkedIn's "Be sure to include an updated resume" cards use
  // unnamed radios (id="jobsDocumentCardToggle-*"), so the generic radio filler
  // can't group/select them and the step stalls. Explicitly select a resume:
  // keep whatever is already chosen, else pick the first card by clicking its
  // toggle label (the reliable control), then confirm the radio fires.
  function selectResume(scope) {
    const root = scope || document;
    const radios = Array.from(root.querySelectorAll('input[type="radio"][id^="jobsDocumentCardToggle-"]'));
    const cards  = Array.from(root.querySelectorAll('.jobs-document-upload-redesign-card__container, .ui-attachment--pdf'));
    if (!radios.length && !cards.length) return;          // not the resume step
    if (radios.some(r => r.checked)) return;              // already selected → keep it

    const firstCard = cards.find(c => visible(c)) || cards[0];
    let target = null, radio = null;
    if (firstCard) {
      radio  = firstCard.querySelector('input[type="radio"]');
      target = firstCard.querySelector('label.jobs-document-upload-redesign-card__toggle-label')
            || (radio && radio.id && root.querySelector('label[for="' + esc(radio.id) + '"]'))
            || radio || firstCard;
    } else if (radios[0]) {
      radio  = radios[0];
      target = (radio.id && root.querySelector('label[for="' + esc(radio.id) + '"]')) || radio;
    }
    if (target) {
      humanClick(target);
      if (radio && !radio.checked) {
        try { radio.checked = true; radio.dispatchEvent(new Event("input", { bubbles: true })); radio.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
      }
    }
  }

  function fillRadios(scope) {
    const groups = {};
    scope.querySelectorAll('input[type="radio"]').forEach(r => {
      if (r.id && /^jobsDocumentCardToggle-/.test(r.id)) return;   // resume radios handled by selectResume
      (groups[r.name] = groups[r.name] || []).push(r);
    });
    Object.values(groups).forEach(group => {
      if (group.some(r => r.checked)) return;
      let pick = group.find(r => { const l = r.id && scope.querySelector('label[for="' + esc(r.id) + '"]'); return l && /^\s*yes\s*$/i.test(textOf(l)); }) || group[0];
      if (pick) { const l = pick.id && scope.querySelector('label[for="' + esc(pick.id) + '"]'); humanClick(l || pick); }
    });
  }
  function checkRequiredBoxes(scope) {
    scope.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.id === "follow-company-checkbox") return;
      const required = cb.required || cb.getAttribute("aria-required") === "true";
      if (required && !cb.checked) { const l = cb.id && scope.querySelector('label[for="' + esc(cb.id) + '"]'); humanClick(l || cb); }
    });
  }
  function autofill(scope) {
    if (!scope || scope === document || scope === document.body) return;
    try { selectResume(scope); } catch (_) {}   // resume step — pick a resume so it can advance
    try { fillSelects(scope); } catch (_) {}
    try { fillTextInputs(scope); } catch (_) {}
    try { fillRadios(scope); } catch (_) {}
    try { checkRequiredBoxes(scope); } catch (_) {}
    try { untickFollowCompany(scope); } catch (_) {}
  }
  function detailPaneIsClosedJob() {
    const root = document.querySelector(".jobs-search__job-details, .scaffold-layout__detail, .jobs-details, .job-view-layout") || document;
    return /no longer accepting applications|this job is no longer|applications are closed/i.test((root.innerText || "").toLowerCase());
  }

  // ─────────────── stray-modal handling ──────────────────────
  function closeStrayModals() {
    let closed = 0;
    for (const d of Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'))) {
      if (!visible(d) || isEasyApplyDialog(d)) continue;
      if (d.querySelector("[aria-labelledby='jobs-apply-header'],[data-test-modal-id='easy-apply-modal'],button[data-easy-apply-next-button],button[data-live-test-easy-apply-submit-button]")) continue;
      const x = d.querySelector('button[aria-label="Dismiss"][data-test-modal-close-btn],button[aria-label="Dismiss"],button[aria-label="Close"],.artdeco-modal__dismiss');
      if (x) { forceClick(x); closed++; }
    }
    return closed;
  }
  let _strayTimer = null;
  function startStrayWatcher() { if (!_strayTimer) _strayTimer = setInterval(() => { try { closeStrayModals(); } catch (_) {} }, 250); }
  function stopStrayWatcher() { if (_strayTimer) { clearInterval(_strayTimer); _strayTimer = null; } }

  function dismissModal() {
    const x = document.querySelector('button[aria-label="Dismiss"][data-test-modal-close-btn],button[aria-label="Dismiss"]');
    if (x) forceClick(x);
  }
  async function confirmDiscard() {
    await sleep(rand(500, 900));
    const btn = document.querySelector('button[data-control-name="discard_application_confirm_btn"]')
      || Array.from(document.querySelectorAll(".artdeco-modal button, div[role='dialog'] button")).find(b => /^\s*discard\s*$/i.test(textOf(b)));
    if (btn) forceClick(btn);
  }
  async function discardAndClose() { dismissModal(); await confirmDiscard(); await sleep(rand(700, 1200)); }
  async function closePostSubmit() {
    await sleep(rand(1200, 2200));
    const safe = ["done", "not now", "no thanks", "no, thanks", "skip", "got it", "close"];
    const danger = /get started|add|upgrade|follow|try premium|reactivate|premium/i;
    const x = document.querySelector('button[aria-label="Dismiss"]');
    const buttons = Array.from(document.querySelectorAll('.artdeco-modal button, div[role="dialog"] button, button[aria-label="Dismiss"]'));
    let pick = buttons.find(b => safe.includes(textOf(b).toLowerCase()) && !danger.test(textOf(b)));
    if (!pick && x) pick = x;
    if (pick) { forceClick(pick); await sleep(rand(600, 1100)); }
  }
  async function waitAdvanced(before, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(220);
      if (!applyFormPresent()) return true;
      if (modalText() !== before) return true;
    }
    return false;
  }

  async function runApplyModal() {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) { if (applyFormPresent()) break; try { closeStrayModals(); } catch (_) {} await sleep(300); }
    if (!applyFormPresent()) return "skipped";
    await sleep(700 + Math.random() * 300);

    let stuck = 0;
    for (let step = 0; step < 16; step++) {
      if (state.cancel) { await discardAndClose(); return "skipped"; }
      if (isCheckpoint()) return "skipped";
      if (!applyFormPresent()) return "skipped";
      const scope = applyFormScope();
      if (!scope) { await discardAndClose(); return "skipped"; }
      autofill(scope);
      await sleep(rand(500, 900));
      try { closeStrayModals(); } catch (_) {}

      const submit = submitButton();
      if (submit) {
        const beforeSubmit = modalText();
        spotlight(submit, 2000); await sleep(rand(220, 380)); humanClick(submit);
        let done = await waitAdvanced(beforeSubmit, 5000);
        if (!done) { escalateClick(submitButton() || submit); done = await waitAdvanced(beforeSubmit, 4000); }
        await closePostSubmit();
        return "applied";
      }
      let advance = reviewButton() || nextButton();
      if (!advance) {
        try { const sc = scope.querySelector(".artdeco-modal__content, .jobs-easy-apply-content") || scope; sc.scrollTop = sc.scrollHeight; } catch (_) {}
        await sleep(500);
        advance = reviewButton() || nextButton() || submitButton();
        if (!advance) { await discardAndClose(); return "skipped"; }
      }
      const before = modalText();
      spotlight(advance, 2000); await sleep(rand(220, 380)); humanClick(advance);
      let advanced = await waitAdvanced(before, 4000);
      if (!advanced) {
        try { closeStrayModals(); } catch (_) {}
        const fresh = reviewButton() || nextButton() || submitButton();
        if (fresh) { spotlight(fresh, 1800); escalateClick(fresh); advanced = await waitAdvanced(before, 4000); }
      }
      if (!advanced) { stuck++; if (stuck >= 2) { await discardAndClose(); return "skipped"; } } else stuck = 0;
    }
    await discardAndClose();
    return "skipped";
  }

  async function applyToCard(card) {
    if (isCheckpoint()) return "challenge";
    const el = (card.el && document.contains(card.el)) ? card.el : cardElForKey(card.key);
    if (!el) return "skipped";
    try { closeStrayModals(); } catch (_) {}
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(900, 1600));
    humanClick(el);
    await sleep(rand(1800, 3000));
    if (detailPaneIsClosedJob()) return "skipped";

    let apply = findInAppApply();
    if (!apply) {
      for (let t = 0; t < 12; t++) { if (state.cancel) return "skipped"; try { closeStrayModals(); } catch (_) {} await sleep(500); apply = findInAppApply(); if (apply) break; }
    }
    if (!apply) return "skipped";
    apply.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(400, 700));
    spotlight(apply, 2000); await sleep(rand(220, 380)); humanClick(apply);
    let mounted = false;
    for (let t = 0; t < 12; t++) { await sleep(280); if (applyFormPresent()) { mounted = true; break; } }
    if (!mounted) escalateClick(findInAppApply() || apply);
    return await runApplyModal();
  }

  // ─────────────── main loop ─────────────────────────────────
  const state = { running: false, cancel: false, applied: 0, skipped: 0 };

  async function run() {
    if (state.running) return;
    loadApplyProfile();
    state.running = true; state.cancel = false; state.applied = state.skipped = 0;
    setLabel("Scanning jobs…");
    try { startStrayWatcher(); } catch (_) {}

    const processed = new Set(); let idle = 0;
    try {
      while (!state.cancel) {
        if (isCheckpoint()) { banner("LinkedIn security check — solve it, then click Auto Apply again."); break; }
        const fresh = collectJobCards().filter(c => !processed.has(c.key));
        if (!fresh.length) {
          const before = listScrollTop();
          scrollListDown();
          await sleep(rand(900, 1500));
          if (listScrollTop() === before) {
            const nextPage = document.querySelector('button[data-testid="pagination-controls-next-button-visible"], button[aria-label="View next page"]');
            if (nextPage && !nextPage.disabled && visible(nextPage)) { setLabel("Loading next page…"); humanClick(nextPage); await sleep(rand(2600, 4200)); processed.clear(); idle = 0; continue; }
            break;
          }
          if (++idle > 60) break;
          continue;
        }
        idle = 0;
        const card = fresh[0]; processed.add(card.key);
        setLabel("Applying #" + processed.size + " · " + state.applied + " applied");
        let result = "skipped";
        try { result = await applyToCard(card); } catch (e) { console.warn(TAG, "job error:", e); result = "skipped"; }
        if (result === "applied") state.applied++;
        else if (result === "challenge") { banner("Security check — stopping."); break; }
        else state.skipped++;
        if (applyFormPresent()) { try { await discardAndClose(); } catch (_) {} }
        try { closeStrayModals(); } catch (_) {}
        await sleep(rand(1200, 2600)); // brief human gap between jobs
        try { closeStrayModals(); } catch (_) {}
        setLabel("Next job · " + state.applied + " applied");
      }
    } finally {
      try { stopStrayWatcher(); } catch (_) {}
      setLabel("Done · " + state.applied + " applied, " + state.skipped + " skipped");
      state.running = false; state.cancel = false;
      setTimeout(resetLabel, 9000);
    }
  }
  function cancel() { if (state.running) { state.cancel = true; setLabel("Stopping…"); } }

  // ─────────────── floating button UI ────────────────────────
  let btnEl = null;
  const BTN_ID = "jbla-autoapply-button";
  function setLabel(text) { if (!btnEl) return; const lab = btnEl.querySelector(".jbla-text"); if (lab) lab.textContent = text; btnEl.classList.toggle("jbla-running", state.running); }
  function resetLabel() { setLabel("⚡ Auto Apply LinkedIn"); }
  function mountButton() {
    if (btnEl || !document.body) return;
    btnEl = document.createElement("button");
    btnEl.id = BTN_ID; btnEl.type = "button";
    btnEl.style.cssText = [
      "position:fixed", "right:26px", "bottom:150px", "z-index:2147483645",
      "background:linear-gradient(135deg,#7c3aed 0%,#6d28d9 100%)", "color:#fff", "border:none",
      "border-radius:999px", "padding:11px 20px 11px 16px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif",
      "font-size:13px", "font-weight:700", "letter-spacing:.01em",
      "box-shadow:0 8px 22px rgba(124,58,237,.4)", "cursor:pointer", "user-select:none",
      "display:inline-flex", "align-items:center", "gap:8px",
    ].join(";");
    btnEl.innerHTML = '<span class="jbla-dot" style="width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block;flex-shrink:0"></span><span class="jbla-text">⚡ Auto Apply LinkedIn</span>';
    btnEl.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (state.running) cancel(); else run(); });
    document.body.appendChild(btnEl);
    const style = document.createElement("style");
    style.id = "jbla-style";
    style.textContent =
      "#" + BTN_ID + ".jbla-running .jbla-dot{animation:jbla-pulse 1.2s infinite}" +
      "@keyframes jbla-pulse{0%,100%{opacity:1}50%{opacity:.35}}" +
      "@keyframes jbla-pulse-ring{0%,100%{box-shadow:0 0 0 6px rgba(124,58,237,.25),0 0 24px rgba(124,58,237,.55)}50%{box-shadow:0 0 0 12px rgba(124,58,237,.1),0 0 32px rgba(124,58,237,.75)}}";
    document.head.appendChild(style);
  }
  function unmountButton() { if (btnEl) { btnEl.remove(); btnEl = null; } const s = document.getElementById("jbla-style"); if (s) s.remove(); }
  function banner(msg) {
    let b = document.getElementById("jbla-banner");
    if (!b) {
      b = document.createElement("div"); b.id = "jbla-banner";
      b.style.cssText = ["position:fixed","top:60px","left:50%","transform:translateX(-50%)","background:#6d28d9","color:#fff","padding:10px 18px","border-radius:8px","font:600 13px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif","z-index:2147483647","box-shadow:0 8px 22px rgba(0,0,0,.28)"].join(";");
      document.body.appendChild(b);
    }
    b.textContent = msg;
    setTimeout(() => { if (b && b.parentNode) b.remove(); }, 7000);
  }

  function maybeMount() { if (onJobsResultsPage()) mountButton(); else unmountButton(); }
  setInterval(maybeMount, 1500); maybeMount();
  setInterval(() => { try { if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) unmountButton(); } catch (_) { unmountButton(); } }, 2500);

  console.log(TAG, "loaded");
})();
