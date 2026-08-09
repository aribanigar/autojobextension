// extension/internshala_autoapply.js
//
// ============================================================================
// INDEPENDENT FEATURE — "Internshala Bulk Auto Apply"
// ============================================================================
// COMPLETELY self-contained. Does NOT import, call, read, or modify content.js,
// background.js, popup.js, linkedin_autoapply.js, or any of their functions or
// state. Own singleton guard (__jobbotInternshalaAutoApplyV1), own DOM namespace
// (`jbia-`), own floating button, own end-to-end apply flow. It only READS the
// saved profile (jobbot_profile) and the license (via GET_LICENSE) — never
// writes to any shared state. Cannot break any existing feature.
//
// Flow (per the Internshala easy-apply job list):
//   1. Find easy-apply job cards (.individual_internship.easy_apply) in
//      #internship_list_container and click one to open the apply dialog.
//   2. In the dialog (#application-form-container): confirm availability =
//      "available to join immediately", answer boolean questions "Yes", and
//      fill any text questions with a professional answer.
//   3. Click Submit (#submit); close any follow-up dialog (#easy_apply_modal_close).
//   4. Move to the next card, scrolling to load more, until stopped.
//
// Anti-bot: read-only DOM, human pointer-sequence clicks, per-card dedupe,
// stops on demand. Never clicks external "view detail" (appcast) cards.
// ============================================================================
(function () {
  if (window.__jobbotInternshalaAutoApplyV1) return;   // singleton
  window.__jobbotInternshalaAutoApplyV1 = true;

  const TAG = "[JobBot · Internshala AutoApply]";
  const APPLIED_KEY = "jobbot_internshala_applied";

  // ───────────────────────── helpers ─────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return min + Math.random() * (max - min); }
  function visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function textOf(el) { return ((el && el.textContent) || "").replace(/\s+/g, " ").trim(); }

  // ─────────────────── learned answers (own memory) ───────────────────
  // Any custom text question this engine answers with the generic default
  // gets remembered here (own storage key jbia_learned, isolated from
  // content.js's core memory and every other add-on's memory) — keyed by a
  // normalized version of the question. If the human edits the answer before
  // submitting, that correction is captured too. Next time the same (or a
  // reworded) question appears, it's answered from memory instead of the
  // generic default.
  const learnedAnswers = (() => {
    let store = {};
    const SYN = { yrs: "year", yr: "year", years: "year", exp: "experience", experiences: "experience",
                  mob: "mobile", mos: "month", months: "month", ctc: "salary", lpa: "salary" };
    const norm = q => String(q || "").toLowerCase()
      .replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):\-]\s*/i, " ")
      .replace(/[*:?()\[\]{}.,<>/\\!"'’“”_#+=—–\-]+/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 160);
    const STOP = new Set(("a an the is are am was were be been being do does did done have has had " +
      "you your yours yourself to of in on at for and or with from as by please enter provide give " +
      "select choose specify what which who whom how this that these those it its we our they them " +
      "i me my mine any all if then else about into per will would can could should may might here " +
      "there field question answer also just only more most very kindly currently").split(/\s+/));
    const stem = w => (w.length > 4 && w.endsWith("s")) ? w.slice(0, -1) : w;
    const toks = q => {
      const out = new Set();
      norm(q).split(" ").forEach(w => { if (!w) return; w = SYN[w] || w; if (w.length >= 2 && !STOP.has(w)) out.add(stem(w)); });
      return out;
    };
    try { chrome.storage.local.get("jbia_learned", d => { void chrome.runtime.lastError; if (d && d.jbia_learned) store = d.jbia_learned; }); } catch (_) {}
    const persist = () => {
      try {
        const keys = Object.keys(store);
        if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(k => delete store[k]);
        chrome.storage.local.set({ jbia_learned: store });
      } catch (_) {}
    };
    return {
      get: q => {
        const k = norm(q);
        if (!k || k.length < 4) return null;
        if (store[k]) return store[k];
        const qt = toks(q);
        if (qt.size < 2) return null;
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
        const k = norm(q); const v = String(a == null ? "" : a).trim();
        if (!k || k.length < 4 || !v || v.length > 600) return;
        if (store[k] === v) return;
        store[k] = v; persist();
      },
    };
  })();

  // Default professional answers for open-ended text questions.
  let PROFILE = {};
  const DEFAULT_ANSWER =
    "When working under tight deadlines or high-pressure situations, I stay calm and organized. " +
    "I prioritize tasks by their impact, break the work into clear steps, and communicate proactively " +
    "with my team and stakeholders. For example, when a key project deadline was moved up, I re-planned " +
    "the schedule, focused on the highest-priority deliverables first, coordinated closely with everyone " +
    "involved, and we delivered on time without compromising quality.";

  function loadProfile() {
    try {
      chrome.storage.local.get(["jobbot_profile"], (res) => {
        void chrome.runtime.lastError;
        if (res && res.jobbot_profile) PROFILE = res.jobbot_profile;
      });
    } catch (_) {}
  }

  // Pick an answer for a text question. Cover-letter / "why" questions use the
  // saved cover letter when present; everything else gets the situational default.
  function answerForQuestion(qText) {
    // A previously-learned answer (from an earlier default we gave, later
    // corrected, or a fresh answer typed by the human) wins outright.
    const learned = learnedAnswers.get(qText);
    if (learned) return learned;
    const q = String(qText || "").toLowerCase();
    const pro = (PROFILE && PROFILE.professional) || {};
    if (/cover letter|why (do|are|should)|why you|tell us about yourself/.test(q) && pro.coverLetter) {
      return String(pro.coverLetter).replace(/<br\s*\/?>/gi, "\n").trim();
    }
    return DEFAULT_ANSWER;
  }

  // ──────────────────── humanised clicking ───────────────────
  async function humanClick(el) {
    if (!el || !el.isConnected) return false;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(rand(120, 300));
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      if (el.isConnected) el.dispatchEvent(new MouseEvent("click", opts));
      else return false;
    } catch (_) { try { el.click(); } catch (__) { return false; } }
    return true;
  }

  function setNativeValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
                  : el.tagName === "SELECT" ? HTMLSelectElement.prototype
                  : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("keyup", { bubbles: true }));
    } catch (_) {}
  }

  // ───────────────────── applied-dedupe store ─────────────────
  const applied = new Set();
  function loadApplied() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([APPLIED_KEY], (res) => {
          void chrome.runtime.lastError;
          const arr = (res && res[APPLIED_KEY]) || [];
          if (Array.isArray(arr)) arr.forEach(id => applied.add(String(id)));
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }
  function markApplied(id) {
    applied.add(String(id));
    try { chrome.storage.local.set({ [APPLIED_KEY]: Array.from(applied).slice(-2000) }); } catch (_) {}
  }

  // ───────────────────── job-card detection ──────────────────
  // Only the in-house easy-apply cards (class easy_apply). The external
  // "view_detail_button" cards (appcast links) are deliberately skipped.
  function collectEasyApplyCards() {
    return Array.from(document.querySelectorAll(".individual_internship.easy_apply"))
      .filter(c => {
        const id = c.getAttribute("internshipid");
        return id && !applied.has(String(id)) && visible(c);
      });
}

  // A safe, non-link region of the card to click so the easy-apply dialog opens
  // (never the job-title / company anchors, which target a new tab).
  function cardClickTarget(card) {
    return card.querySelector(".about_job")
        || card.querySelector(".individual_internship_details")
        || card.querySelector(".internship_meta")
        || card;
  }

  // ─────────────────────── apply dialog ───────────────────────
  function applyForm() {
    const f = document.querySelector("#application-form");
    return (f && visible(f)) ? f : null;
  }
  function applyContainer() {
    const c = document.querySelector("#application-form-container");
    return (c && visible(c)) ? c : null;
  }
  async function waitForForm(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (applyForm() || applyContainer()) return true;
      await sleep(250);
    }
    return false;
  }

  // Fill the dialog: availability + boolean questions + text questions.
  async function fillForm(scope) {
    // 1) Confirm availability → "available to join immediately" (value "yes").
    try {
      const avail = scope.querySelector('input[name="confirm_availability"][value="yes"]');
      if (avail && !avail.checked) {
        const lab = avail.id && scope.querySelector('label[for="' + avail.id + '"]');
        await humanClick(lab || avail);
      } else if (avail) {
        // ensure the change handler ran
        try { avail.checked = true; avail.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
      }
    } catch (_) {}

    // 2) Boolean / choice questions (radios) → prefer "Yes", else first option.
    try {
      const groups = {};
      scope.querySelectorAll('input.custom-question-answer[type="radio"]').forEach(r => {
        (groups[r.name] = groups[r.name] || []).push(r);
      });
      for (const name of Object.keys(groups)) {
        const group = groups[name];
        if (group.some(r => r.checked)) continue;
        const grp = group[0].closest(".additional_question");
        const qLbl = grp && grp.querySelector(".assessment_question label");
        const qText = qLbl ? textOf(qLbl) : "";
        const learned = qText ? learnedAnswers.get(qText) : null;
        let pick = null;
        if (learned) {
          const lc = learned.toLowerCase();
          pick = group.find(r => (r.value || "").trim().toLowerCase() === lc);
        }
        if (!pick) pick = group.find(r => /^\s*yes\s*$/i.test(r.value || "")) || group[0];
        if (pick) {
          const lab = pick.id && scope.querySelector('label[for="' + pick.id + '"]');
          await humanClick(lab || pick);
          if (qText && !group[0]._jbiaLearn) {
            group[0]._jbiaLearn = true;
            const grab = () => { const chosen = group.find(r => r.checked); if (chosen) learnedAnswers.set(qText, chosen.value || ""); };
            group.forEach(r => r.addEventListener("change", grab));
          }
          await sleep(rand(120, 260));
        }
      }
    } catch (_) {}

    // 3) Text questions → fill any empty answer.
    try {
      const textareas = scope.querySelectorAll('textarea.custom-question-answer');
      for (const ta of textareas) {
        if (ta.value && ta.value.trim()) continue;
        let q = "";
        try {
          const grp = ta.closest(".additional_question");
          const lbl = grp && grp.querySelector(".assessment_question label");
          q = lbl ? textOf(lbl) : "";
        } catch (_) {}
        setNativeValue(ta, answerForQuestion(q));
        // Watch for the human editing this before submit — their correction
        // becomes the remembered answer for this exact question next time.
        if (q && !ta._jbiaLearn) {
          ta._jbiaLearn = true;
          const grab = () => { const v = (ta.value || "").trim(); if (v) learnedAnswers.set(q, v); };
          ta.addEventListener("change", grab);
          ta.addEventListener("blur", grab);
        }
        await sleep(rand(150, 320));
      }
    } catch (_) {}
  }

  function submitButton(scope) {
    return (scope || document).querySelector('#submit, input[type="submit"][name="submit"]');
  }

  // Close any follow-up dialog after submit (success / sequential-apply modal).
  async function closeAnyDialog() {
    const closers = [
      "#easy_apply_modal_close",
      ".easy_apply_modal .close",
      ".modal .close",
      'button[aria-label="Close"]',
      "#close_popup",
    ];
    for (const sel of closers) {
      const btn = document.querySelector(sel);
      if (btn && visible(btn)) { await humanClick(btn); await sleep(rand(500, 900)); return true; }
    }
    return false;
  }

  // Apply to a single card. Returns 'applied' | 'skipped'.
  async function applyToCard(card) {
    const id = card.getAttribute("internshipid");
    setStatus("Opening job…");
    await humanClick(cardClickTarget(card));

    const ok = await waitForForm(9000);
    if (!ok) {
      // No dialog opened (or it navigated) — close any stray modal and skip.
      await closeAnyDialog();
      return "skipped";
    }
    const scope = applyForm() || applyContainer() || document;
    setStatus("Filling application…");
    await sleep(rand(500, 900));
    await fillForm(scope);
    await sleep(rand(400, 800));

    const submit = submitButton(scope);
    if (!submit || !visible(submit)) { await closeAnyDialog(); return "skipped"; }
    setStatus("Submitting…");
    await humanClick(submit);
    await sleep(rand(1600, 2600));

    // Close the confirmation / next-suggestion dialog if it appears.
    await closeAnyDialog();
    await closeAnyDialog();
    if (id) markApplied(id);
    return "applied";
  }

  // ─────────────────────── run controller ─────────────────────
  const state = { running: false, cancel: false, count: 0 };

  async function run() {
    if (state.running) return;
    // License gate — same key that unlocks the rest of the extension.
    setStatus("Checking your license…");
    const lic = await new Promise((res) => {
      try { chrome.runtime.sendMessage({ type: "GET_LICENSE" }, (r) => { void chrome.runtime.lastError; res(r || {}); }); }
      catch (_) { res({}); }
    });
    if (!lic || !lic.active) {
      setStatus(lic && lic.reason === "locked"
        ? "🔒 Key locked — contact admin"
        : "🔑 Enter your license key in the extension");
      setButton(false);
      return;
    }

    state.running = true; state.cancel = false; state.count = 0;
    setButton(true);
    await loadApplied();

    let emptyScans = 0;
    while (!state.cancel && emptyScans < 4) {
      const cards = collectEasyApplyCards();
      if (!cards.length) {
        // Nothing new visible → scroll to load more, then re-scan.
        emptyScans++;
        setStatus("Loading more jobs… (" + state.count + " applied)");
        window.scrollBy(0, Math.round(window.innerHeight * 0.9));
        await sleep(rand(1200, 1900));
        continue;
      }
      emptyScans = 0;
      for (const card of cards) {
        if (state.cancel) break;
        try {
          const outcome = await applyToCard(card);
          if (outcome === "applied") {
            state.count++;
            setStatus("✓ Applied to " + state.count + " job(s)");
          }
        } catch (e) {
          try { console.warn(TAG, "card error", e && e.message); } catch (_) {}
          await closeAnyDialog();
        }
        await sleep(rand(900, 1600));
      }
    }

    state.running = false;
    setButton(false);
    setStatus(state.cancel
      ? "Stopped — " + state.count + " applied"
      : "Done — " + state.count + " applied");
  }

  function stop() { state.cancel = true; }

  // ───────────────────────── floating UI ──────────────────────
  let elBtn, elStatus;
  function ensureUI() {
    if (document.getElementById("jbia-panel")) return;
    const style = document.createElement("style");
    style.textContent =
      "#jbia-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif}" +
      "#jbia-card{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:14px;box-shadow:0 14px 40px rgba(15,23,42,.18);padding:12px 14px;width:230px}" +
      "#jbia-title{font-size:12px;font-weight:800;letter-spacing:.02em;color:#1d4ed8;margin-bottom:8px;display:flex;align-items:center;gap:6px}" +
      "#jbia-btn{width:100%;border:none;border-radius:10px;padding:10px 12px;font-size:14px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(135deg,#2563eb,#1d4ed8);font-family:inherit}" +
      "#jbia-btn.stop{background:linear-gradient(135deg,#dc2626,#b91c1c)}" +
      "#jbia-status{font-size:12px;color:#56617a;margin-top:8px;line-height:1.4;min-height:16px}";
    document.documentElement.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "jbia-panel";
    panel.innerHTML =
      '<div id="jbia-card">' +
        '<div id="jbia-title">⚡ AutoApplier · Internshala</div>' +
        '<button id="jbia-btn">Start auto apply</button>' +
        '<div id="jbia-status">Ready. Open the Internshala jobs list and press Start.</div>' +
      '</div>';
    document.body.appendChild(panel);
    elBtn = panel.querySelector("#jbia-btn");
    elStatus = panel.querySelector("#jbia-status");
    elBtn.addEventListener("click", () => { if (state.running) stop(); else run(); });
  }
  function setButton(running) {
    if (!elBtn) return;
    elBtn.textContent = running ? "Stop" : "Start auto apply";
    elBtn.classList.toggle("stop", !!running);
  }
  function setStatus(msg) { if (elStatus) elStatus.textContent = msg; }

  // Only mount on Internshala pages that actually have a job list.
  function maybeMount() {
    const onJobs = /internshala\.com/.test(location.host) &&
      (document.getElementById("internship_list_container") ||
       document.querySelector(".individual_internship.easy_apply"));
    if (onJobs) ensureUI();
  }

  loadProfile();
  // Mount now and watch for SPA/infinite-scroll list changes.
  const boot = () => { try { maybeMount(); } catch (_) {} };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  let tries = 0;
  const mountTimer = setInterval(() => { boot(); if (document.getElementById("jbia-panel") || ++tries > 20) clearInterval(mountTimer); }, 800);
})();
