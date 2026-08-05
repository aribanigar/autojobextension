// extension/naukrigulf_autoapply.js
//
// ============================================================================
// INDEPENDENT FEATURE — "Naukri Gulf Easy Apply Fix"
// ============================================================================
// COMPLETELY self-contained. Does NOT import, call, read, or modify content.js
// (including the existing NaukriAgent class), background.js, popup.js,
// linkedin_autoapply.js, internshala_autoapply.js, or reddit_scheduler.js —
// or any of their functions/state. Own singleton guard
// (__jobbotNaukriGulfAutoApplyV1), own DOM namespace (`jbng-`), own
// chrome.storage.local keys (`jbng_*`, `jobbot_naukrigulf_applied`). Controlled
// entirely by its own floating Start/Stop button — never touches the existing
// "Start Agent" popup flow. Runs only on naukrigulf.com.
//
// Flow (per the Naukri Gulf search-results + job-detail pages):
//   SRP page  — collect every `.ng-box.srp-tuple` card that has an
//               "Easy Apply" label in its `.foot`, dedupe against jobs already
//               applied this session/permanently, then click each job's title
//               link (it already opens in a new tab via target="_blank").
//               After opening one job it waits (via chrome.storage, which is
//               shared across tabs) for that job to be marked done before
//               opening the next — so it never floods the browser with tabs.
//   JD page   — (this same script also runs here, since it matches all of
//               naukrigulf.com) if the feature is running, it finds the
//               `.jd-action-panel` "Easy Apply" button, clicks it, marks the
//               job done, then closes its own tab shortly after.
// ============================================================================
(function () {
  if (window.__jobbotNaukriGulfAutoApplyV1) return; // singleton
  if (!/(^|\.)naukrigulf\.com$/.test(location.hostname)) return;
  window.__jobbotNaukriGulfAutoApplyV1 = true;

  const TAG = "[JobBot · Naukri Gulf Fix]";
  const K_RUNNING = "jbng_running";
  const K_APPLIED = "jobbot_naukrigulf_applied"; // { [jobKey]: { status: "applied"|"skipped", ts } }

  // ───────────────────────── tiny helpers ─────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };
  const gget = (keys) => new Promise((res) => { try { chrome.storage.local.get(keys, (r) => { void chrome.runtime.lastError; res(r || {}); }); } catch (_) { res({}); } });
  const gset = (obj) => new Promise((res) => { try { chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; res(); }); } catch (_) { res(); } });

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }
  function textOf(el) { return ((el && el.textContent) || "").replace(/\s+/g, " ").trim(); }
  // After the extension is reloaded, tabs left open from before have a
  // disconnected content script — chrome.storage/runtime calls fail silently.
  // Detect that so we can tell the user to refresh instead of doing nothing.
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  // Human-like click sequence (own copy — does not reuse the locked agents'
  // realClick/humanClick helpers in content.js).
  async function humanClick(el) {
    if (!el || !el.isConnected) return false;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {}
    await sleep(rand(120, 320));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      await sleep(rand(40, 110));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (_) {
      try { el.click(); } catch (_) {}
    }
    return true;
  }

  // Stable per-job key from a Naukri Gulf URL: the trailing "jid-..." segment
  // if present, else the full pathname (dedupe-safe either way).
  function jobKeyFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/jid-([a-z0-9]+)/i);
      return m ? ("jid-" + m[1].toLowerCase()) : u.pathname.toLowerCase();
    } catch (_) {
      return String(url || "").toLowerCase();
    }
  }

  // ───────────────────────── UI panel (SRP side) ─────────────────────────
  const CSS = `
  .jbng-btn{position:fixed;left:18px;bottom:18px;z-index:2147483000;background:#0b6e4f;color:#fff;border:none;border-radius:999px;
    padding:11px 16px;font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;gap:8px}
  .jbng-btn:hover{background:#095a3f}
  .jbng-panel{position:fixed;left:18px;bottom:70px;z-index:2147483000;width:320px;max-height:70vh;overflow:auto;background:#fff;color:#0f172a;
    border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 24px 60px rgba(2,6,23,.28);font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;display:none}
  .jbng-panel.open{display:block}
  .jbng-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #eef2f7}
  .jbng-hd b{font-size:14px}
  .jbng-x{border:none;background:#f1f5f9;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:15px;line-height:1}
  .jbng-bd{padding:14px 16px;display:flex;flex-direction:column;gap:11px}
  .jbng-row{display:flex;gap:8px}
  .jbng-a{flex:1;text-align:center;border:1px solid #cbd5e1;background:#f8fafc;border-radius:9px;padding:9px;cursor:pointer;font-weight:600;color:#334155}
  .jbng-a:hover{background:#eef2ff}
  .jbng-start{background:#16a34a;border-color:#16a34a;color:#fff}
  .jbng-start:hover{background:#12833c}
  .jbng-stop{background:#dc2626;border-color:#dc2626;color:#fff}
  .jbng-stop:hover{background:#b91c1c}
  .jbng-note{font-size:11.5px;color:#64748b}
  .jbng-log{background:#0b1220;color:#d1fae5;border-radius:10px;padding:9px 10px;font:11.5px/1.5 ui-monospace,Menlo,monospace;max-height:170px;overflow:auto;white-space:pre-wrap}
  `;

  let panelEl, logEl;
  function ensureUI() {
    if (document.getElementById("jbng-style")) return;
    const st = document.createElement("style"); st.id = "jbng-style"; st.textContent = CSS; document.documentElement.appendChild(st);

    const btn = document.createElement("button");
    btn.className = "jbng-btn"; btn.type = "button";
    btn.innerHTML = "🟢 <span>Naukri Gulf Easy Apply</span>";
    btn.onclick = () => panelEl.classList.toggle("open");
    document.body.appendChild(btn);

    panelEl = document.createElement("div");
    panelEl.className = "jbng-panel";
    panelEl.innerHTML = `
      <div class="jbng-hd"><b>🟢 Naukri Gulf Easy Apply</b><button class="jbng-x" type="button" title="Close">×</button></div>
      <div class="jbng-bd">
        <div class="jbng-note">Run your normal Naukri Gulf search, then press Start. It applies to every "Easy Apply" job on this results page, opening each one in a new tab and returning here before the next.</div>
        <div class="jbng-row">
          <div class="jbng-a jbng-start">▶ Start</div>
          <div class="jbng-a jbng-stop">■ Stop</div>
        </div>
        <div class="jbng-log" aria-live="polite">Ready.</div>
      </div>`;
    document.body.appendChild(panelEl);

    logEl = panelEl.querySelector(".jbng-log");
    panelEl.querySelector(".jbng-x").onclick = () => panelEl.classList.remove("open");
    panelEl.querySelector(".jbng-start").onclick = () => {
      if (!extensionAlive()) {
        status("⚠ This tab lost its connection to the extension (usually happens right after reloading the extension). Please refresh this Naukri Gulf tab, then press Start again.");
        return;
      }
      gset({ [K_RUNNING]: true }).then(() => {
        status("Started.");
        runSRP().catch((e) => { log("SRP error", e); status("⛔ Error: " + (e && e.message || e)); });
      });
    };
    panelEl.querySelector(".jbng-stop").onclick = () => gset({ [K_RUNNING]: false }).then(() => status("Stopped."));
  }
  function status(msg) {
    log(msg);
    if (logEl) logEl.textContent = (msg + "\n" + logEl.textContent).slice(0, 4000);
  }

  // ───────────────────────── SRP (search results) logic ─────────────────────────
  // Multiple selectors, additive (never replaced) — Naukri Gulf's card markup
  // varies slightly across layouts, so we widen the net rather than narrow it.
  function collectEasyApplyCards() {
    const seen = new Set();
    const out = [];
    document.querySelectorAll(".ng-box.srp-tuple, .srp-tuple, [class*='srp-tuple']").forEach((card) => {
      if (seen.has(card)) return;
      seen.add(card);
      const foot = card.querySelector(".foot");
      const hasEasy = foot
        ? /easy apply/i.test(textOf(foot.querySelector(".easy")) || textOf(foot))
        : /easy apply/i.test(textOf(card));
      if (hasEasy) out.push(card);
    });
    return out;
  }
  function cardLink(card) {
    return card.querySelector('a.info-position[href]') || card.querySelector('a[href][target="_blank"]');
  }

  let srpRunning = false;
  async function runSRP() {
    if (srpRunning) return;
    if (!extensionAlive()) { status("⚠ Extension connection lost — refresh this page and press Start again."); return; }
    srpRunning = true;
    try {
      if (!collectEasyApplyCards().length) {
        status("No Easy Apply jobs found on this page. Make sure you're on a Naukri Gulf search-results page (not the homepage or a single job page) and that results have finished loading.");
        return;
      }
      panelEl && panelEl.classList.add("open");
      const applied = (await gget([K_APPLIED]))[K_APPLIED] || {};
      const cards = collectEasyApplyCards();
      status(`Found ${cards.length} Easy Apply job(s) on this page.`);
      let done = 0;
      for (const card of cards) {
        const chk = await gget([K_RUNNING]);
        if (!chk[K_RUNNING]) { status("Stopped."); break; }

        const a = cardLink(card);
        if (!a || !a.href) continue;
        const key = jobKeyFromUrl(a.href);
        if (applied[key]) { continue; } // already handled previously

        const title = textOf(card.querySelector(".designation-title")) || "(job)";
        status(`Opening: ${title.slice(0, 60)}`);
        await humanClick(a); // target="_blank" on the link opens a new tab
        await sleep(rand(1500, 2500));

        // Wait for the job-detail tab (this same script, running there) to
        // mark the job done, sharing state via chrome.storage.local — polled
        // here since a fresh tab is a separate JS context.
        const waitStart = Date.now();
        let settled = false;
        while (Date.now() - waitStart < 45000) {
          const chk2 = await gget([K_RUNNING]);
          if (!chk2[K_RUNNING]) { settled = true; break; }
          const cur = (await gget([K_APPLIED]))[K_APPLIED] || {};
          if (cur[key]) { applied[key] = cur[key]; settled = true; done++; status(`  ✓ ${cur[key].status === "applied" ? "Applied" : "Skipped"}: ${title.slice(0, 50)}`); break; }
          await sleep(1200);
        }
        if (!settled) status(`  ⚠ Timed out waiting on: ${title.slice(0, 50)} (moving on)`);
        const chk3 = await gget([K_RUNNING]);
        if (!chk3[K_RUNNING]) { status("Stopped."); break; }
        await sleep(rand(2000, 3500)); // human pacing between jobs
      }
      status(`Done for this page — ${done} applied. Change filters or go to the next results page and press Start again to continue.`);
    } catch (e) {
      status("⛔ Error: " + (e && e.message || e));
    } finally {
      srpRunning = false;
    }
  }

  // ───────────────────────── JD (job detail) logic ─────────────────────────
  async function waitFor(sel, { timeout = 15000 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el && visible(el)) return el;
      await sleep(250);
    }
    return null;
  }

  async function runJD() {
    const panel = await waitFor(".jd-action-panel", { timeout: 12000 });
    if (!panel) return; // not a job-detail page (or it hasn't rendered)

    const chk = await gget([K_RUNNING]);
    if (!chk[K_RUNNING]) return; // feature not running — leave the page untouched

    const key = jobKeyFromUrl(location.href);
    const applied = (await gget([K_APPLIED]))[K_APPLIED] || {};
    if (applied[key]) { setTimeout(() => { try { window.close(); } catch (_) {} }, 800); return; }

    const btn = Array.from(panel.querySelectorAll("button")).find((b) => /easy apply/i.test(textOf(b)));
    if (!btn) {
      // No Easy Apply button — could already say "Applied"/"Application sent"
      // or the panel loaded without it. Mark skipped so the SRP tab moves on.
      applied[key] = { status: "skipped", ts: Date.now() };
      await gset({ [K_APPLIED]: applied });
      setTimeout(() => { try { window.close(); } catch (_) {} }, 800);
      return;
    }
    if (/applied|application sent/i.test(textOf(btn))) {
      applied[key] = { status: "applied", ts: Date.now() };
      await gset({ [K_APPLIED]: applied });
      setTimeout(() => { try { window.close(); } catch (_) {} }, 800);
      return;
    }

    await sleep(rand(600, 1400));
    await humanClick(btn);
    await sleep(rand(1500, 2600));
    applied[key] = { status: "applied", ts: Date.now() };
    await gset({ [K_APPLIED]: applied });
    await sleep(rand(1200, 1800));
    try { window.close(); } catch (_) {}
  }

  // ───────────────────────── boot ─────────────────────────
  function boot() {
    try { ensureUI(); } catch (e) { log("UI error", e); }
    // Decide which page kind this is and act accordingly. A tab can only be
    // one of these — the presence checks are mutually exclusive in practice.
    setTimeout(() => {
      if (document.querySelector(".jd-action-panel")) {
        runJD().catch((e) => log("JD error", e));
      } else if (collectEasyApplyCards().length) {
        gget([K_RUNNING]).then((s) => { if (s[K_RUNNING]) runSRP().catch((e) => log("SRP error", e)); });
      }
    }, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
