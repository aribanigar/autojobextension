// extension/reddit_scheduler.js
//
// ============================================================================
// INDEPENDENT FEATURE — "Reddit Bulk Post Scheduler"
// ============================================================================
// COMPLETELY self-contained. Does NOT import, call, read, or modify content.js,
// background.js, popup.js, linkedin_autoapply.js, internshala_autoapply.js, or
// any of their functions/state. Own singleton guard (__jobbotRedditSchedulerV1),
// own DOM namespace (`jbrs-`), own floating panel, own storage keys
// (`jbrs_*`). Uses ONLY chrome.storage.local (no runtime messaging) so it can
// never interfere with any existing feature. Runs only on reddit.com.
//
// What it does:
//   • You upload a CSV of posts (title, body, date, time).
//   • It opens the subreddit's submit page, types the title + body, opens the
//     "Schedule" dialog, sets the date + time, and clicks Save to schedule the
//     post — then moves to the next row automatically, with a random 10–15s
//     pause between posts, surviving the page reloads between each schedule.
//
// Reddit's composer is built from web components with OPEN shadow DOM + a Lexical
// rich-text editor, so all field access pierces shadow roots (deepQuery) and the
// body is filled via execCommand('insertText') which Lexical listens for.
// ============================================================================
(function () {
  if (window.__jobbotRedditSchedulerV1) return;      // singleton
  if (!/(^|\.)reddit\.com$/.test(location.hostname)) return;
  window.__jobbotRedditSchedulerV1 = true;

  const TAG = "[JobBot · Reddit Scheduler]";
  const K = {
    queue: "jbrs_queue",       // array of { title, body, date, time }
    index: "jbrs_index",       // number — next row to process
    running: "jbrs_running",   // boolean
    sub: "jbrs_sub",           // subreddit name (no r/)
  };

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

  // Pierce open shadow roots: return the first element matching `sel` anywhere in
  // the composed tree under `root`.
  function deepQuery(sel, root = document, _seen = new Set()) {
    if (!root || _seen.has(root)) return null;
    _seen.add(root);
    try { const hit = root.querySelector(sel); if (hit) return hit; } catch (_) {}
    const all = (root.querySelectorAll ? root.querySelectorAll("*") : []);
    for (const el of all) {
      if (el.shadowRoot) {
        const hit = deepQuery(sel, el.shadowRoot, _seen);
        if (hit) return hit;
      }
    }
    return null;
  }
  function deepQueryAll(sel, root = document, _seen = new Set(), out = []) {
    if (!root || _seen.has(root)) return out;
    _seen.add(root);
    try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (_) {}
    const all = (root.querySelectorAll ? root.querySelectorAll("*") : []);
    for (const el of all) if (el.shadowRoot) deepQueryAll(sel, el.shadowRoot, _seen, out);
    return out;
  }
  // Wait until deepQuery finds a *visible* match (or timeout).
  async function waitFor(sel, { timeout = 20000, needVisible = true } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = deepQuery(sel);
      if (el && (!needVisible || visible(el))) return el;
      await sleep(250);
    }
    return null;
  }

  // Set a native <input>/<textarea> value so React/faceplate registers it.
  function setNativeValue(el, value) {
    if (!el) return;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try { setter ? setter.call(el, value) : (el.value = value); } catch (_) { el.value = value; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Fill a Lexical/contenteditable box. Lexical listens for beforeinput/execCommand.
  async function setEditable(el, text) {
    if (!el) return;
    el.focus();
    await sleep(120);
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selc = window.getSelection();
      selc.removeAllRanges();
      selc.addRange(range);
    } catch (_) {}
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
    if (!ok) {
      // Fallback: beforeinput/input dispatch.
      try {
        el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } catch (_) {}
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
  }

  // ───────────────────────── CSV ─────────────────────────
  function csvEscape(v) {
    v = String(v == null ? "" : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function sampleCSV() {
    const rows = [
      ["title", "body", "date", "time"],
      [
        "I automated the boring part of my job search — here's the exact workflow",
        "Applying by hand was killing me: same details, same screening questions, 40 times a day. I set up one master profile, let an extension fill + submit each application, kept a tracker, and left captchas to myself. Went from ~10 to 70 applications a day. Happy to share the setup.",
        "2026-08-01",
        "09:30",
      ],
      [
        "More applications = more interviews. The bottleneck is the repetitive form-filling",
        "Nobody can hand-apply to 80 jobs a day for long. Automating the screening answers + the actual applying (not just autofill) removed the ceiling for me. Keep the search relevant so you don't spray garbage.",
        "2026-08-03",
        "18:00",
      ],
    ];
    return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  }
  // Minimal RFC-4180-ish parser (handles quotes, escaped quotes, commas, newlines).
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, inQ = false;
    text = String(text).replace(/^﻿/, ""); // strip BOM
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    const ti = col("title"), bi = col("body"), di = col("date"), tmi = col("time");
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || cells.every((x) => !String(x).trim())) continue;
      const title = ti >= 0 ? (cells[ti] || "").trim() : "";
      if (!title) continue;
      out.push({
        title,
        body: bi >= 0 ? (cells[bi] || "") : "",
        date: di >= 0 ? (cells[di] || "").trim() : "",
        time: tmi >= 0 ? (cells[tmi] || "").trim() : "",
      });
    }
    return out;
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (_) {} }, 1500);
  }

  // ───────────────────────── UI panel ─────────────────────────
  const CSS = `
  .jbrs-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#ff4500;color:#fff;border:none;border-radius:999px;
    padding:11px 16px;font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;gap:8px}
  .jbrs-btn:hover{background:#e23d00}
  .jbrs-panel{position:fixed;right:18px;bottom:70px;z-index:2147483000;width:340px;max-height:76vh;overflow:auto;background:#fff;color:#0f172a;
    border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 24px 60px rgba(2,6,23,.28);font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;display:none}
  .jbrs-panel.open{display:block}
  .jbrs-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #eef2f7}
  .jbrs-hd b{font-size:14px}
  .jbrs-x{border:none;background:#f1f5f9;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:15px;line-height:1}
  .jbrs-bd{padding:14px 16px;display:flex;flex-direction:column;gap:11px}
  .jbrs-bd label{font-weight:600;font-size:12px;color:#475569;display:block;margin-bottom:4px}
  .jbrs-bd input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px}
  .jbrs-row{display:flex;gap:8px}
  .jbrs-a{flex:1;text-align:center;border:1px solid #cbd5e1;background:#f8fafc;border-radius:9px;padding:9px;cursor:pointer;font-weight:600;color:#334155}
  .jbrs-a:hover{background:#eef2ff}
  .jbrs-start{background:#16a34a;border-color:#16a34a;color:#fff}
  .jbrs-start:hover{background:#12833c}
  .jbrs-stop{background:#dc2626;border-color:#dc2626;color:#fff}
  .jbrs-stop:hover{background:#b91c1c}
  .jbrs-note{font-size:11.5px;color:#64748b}
  .jbrs-log{background:#0b1220;color:#d1fae5;border-radius:10px;padding:9px 10px;font:11.5px/1.5 ui-monospace,Menlo,monospace;max-height:150px;overflow:auto;white-space:pre-wrap}
  .jbrs-count{font-weight:700;color:#0f172a}
  `;

  let panelEl, logEl, countEl, subEl, fileEl;
  function ensureUI() {
    if (document.getElementById("jbrs-style")) return;
    const st = document.createElement("style"); st.id = "jbrs-style"; st.textContent = CSS; document.documentElement.appendChild(st);

    const btn = document.createElement("button");
    btn.className = "jbrs-btn"; btn.type = "button";
    btn.innerHTML = "📅 <span>Reddit Scheduler</span>";
    btn.onclick = () => panelEl.classList.toggle("open");
    document.body.appendChild(btn);

    panelEl = document.createElement("div");
    panelEl.className = "jbrs-panel";
    panelEl.innerHTML = `
      <div class="jbrs-hd"><b>📅 Reddit Post Scheduler</b><button class="jbrs-x" type="button" title="Close">×</button></div>
      <div class="jbrs-bd">
        <div>
          <label>Subreddit (without r/)</label>
          <input type="text" class="jbrs-sub" placeholder="jobstogethired" />
        </div>
        <div class="jbrs-row">
          <div class="jbrs-a jbrs-sample">⬇ Sample CSV</div>
          <div class="jbrs-a jbrs-upload">⬆ Upload CSV</div>
        </div>
        <div class="jbrs-note">CSV columns: <b>title, body, date (YYYY-MM-DD), time (HH:MM, 24h)</b>. Leave date/time blank to schedule the very next day at 9:00, spaced a day apart.</div>
        <div>Loaded posts: <span class="jbrs-count">0</span></div>
        <div class="jbrs-row">
          <div class="jbrs-a jbrs-start">▶ Start scheduling</div>
          <div class="jbrs-a jbrs-stop">■ Stop</div>
        </div>
        <div class="jbrs-note">A random 10–15s pause runs between each post. Keep this tab focused while it works.</div>
        <div class="jbrs-log" aria-live="polite">Ready.</div>
      </div>`;
    document.body.appendChild(panelEl);

    logEl = panelEl.querySelector(".jbrs-log");
    countEl = panelEl.querySelector(".jbrs-count");
    subEl = panelEl.querySelector(".jbrs-sub");
    fileEl = document.createElement("input");
    fileEl.type = "file"; fileEl.accept = ".csv,text/csv"; fileEl.style.display = "none";
    document.body.appendChild(fileEl);

    // Prefill subreddit from the current URL if we're on one.
    const m = location.pathname.match(/\/r\/([^/]+)/i);
    if (m) subEl.value = m[1];

    panelEl.querySelector(".jbrs-x").onclick = () => panelEl.classList.remove("open");
    panelEl.querySelector(".jbrs-sample").onclick = () => download("reddit-posts-sample.csv", sampleCSV());
    panelEl.querySelector(".jbrs-upload").onclick = () => fileEl.click();
    panelEl.querySelector(".jbrs-start").onclick = start;
    panelEl.querySelector(".jbrs-stop").onclick = stop;

    fileEl.onchange = async () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) return;
      const text = await f.text();
      const rows = parseCSV(text);
      await gset({ [K.queue]: rows });
      countEl.textContent = String(rows.length);
      status(`Loaded ${rows.length} post(s) from ${f.name}.`);
      fileEl.value = "";
    };

    refreshCount();
  }

  function status(msg) {
    log(msg);
    if (logEl) { logEl.textContent = (msg + "\n" + logEl.textContent).slice(0, 4000); }
  }
  async function refreshCount() {
    const s = await gget([K.queue]);
    if (countEl) countEl.textContent = String((s[K.queue] || []).length);
  }

  // Compute a fallback date/time when a row leaves them blank.
  function fallbackSchedule(idx) {
    const d = new Date();
    d.setDate(d.getDate() + 1 + idx); // start tomorrow, one day apart
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { date: `${yyyy}-${mm}-${dd}`, time: "09:00" };
  }

  // ───────────────────────── run control ─────────────────────────
  async function start() {
    const s = await gget([K.queue]);
    const q = s[K.queue] || [];
    if (!q.length) { status("No posts loaded. Upload a CSV first."); return; }
    const sub = (subEl.value || "").trim().replace(/^r\//i, "");
    if (!sub) { status("Enter the subreddit name first."); return; }
    await gset({ [K.sub]: sub, [K.index]: 0, [K.running]: true });
    status(`Starting: ${q.length} post(s) → r/${sub}.`);
    if (onSubmitPage(sub)) {
      // Already on the composer — begin typing right away (no navigation).
      processCurrent().catch((e) => log("run error", e));
    } else {
      status("Opening the submit page…");
      gotoSubmit(sub, 0);
    }
  }
  async function stop() {
    await gset({ [K.running]: false });
    status("Stopped. (Any post already scheduled stays scheduled.)");
  }
  // `jbrs` cache-buster forces a real navigation between posts (so the composer
  // fully re-renders); onSubmitPage ignores the query string.
  function submitUrl(sub, idx) { return `${location.origin}/r/${sub}/submit?jbrs=${idx == null ? 0 : idx}`; }
  function onSubmitPage(sub) {
    return new RegExp(`/r/${sub}/submit/?$`, "i").test(location.pathname);
  }
  function gotoSubmit(sub, idx) { location.href = submitUrl(sub, idx); }

  // Schedule ONE post on the current submit page.
  async function scheduleOne(post, idx, total) {
    status(`Post ${idx + 1}/${total}: "${(post.title || "").slice(0, 48)}…"`);

    // 1) Title
    const titleEl = await waitFor('textarea[name="title"]', { timeout: 25000 });
    if (!titleEl) throw new Error("Title field not found (composer didn't load).");
    titleEl.focus(); await sleep(150);
    setNativeValue(titleEl, post.title);
    await sleep(400);

    // 2) Body (optional). Lexical contenteditable — slotted in light DOM.
    if (post.body && String(post.body).trim()) {
      const bodyEl = deepQuery('div[name="body"][contenteditable="true"]')
                  || deepQuery('shreddit-composer [contenteditable="true"]')
                  || deepQuery('div[data-lexical-editor="true"]');
      if (bodyEl) { await setEditable(bodyEl, post.body); await sleep(300); }
      else status("  (body editor not found — posting title only)");
    }

    // 3) Open the Schedule dialog (clock button next to Post).
    const trigger = await waitFor("post-form-date-picker-trigger button", { timeout: 15000 });
    if (!trigger) throw new Error("Schedule button not found / still disabled.");
    trigger.click();
    await sleep(1200);

    // 4) Set date + time (native inputs inside the dialog's shadow roots).
    let dt = { date: post.date, time: post.time };
    if (!dt.date || !dt.time) { const fb = fallbackSchedule(idx); dt.date = dt.date || fb.date; dt.time = dt.time || fb.time; }

    const dateInput = await waitFor('input[type="date"]', { timeout: 12000 });
    if (!dateInput) throw new Error("Schedule dialog date field not found.");
    setNativeValue(dateInput, dt.date);
    await sleep(400);
    const timeInputs = deepQueryAll('input[type="time"]').filter(visible);
    const timeInput = timeInputs[0];
    if (!timeInput) throw new Error("Schedule dialog time field not found.");
    setNativeValue(timeInput, dt.time);
    await sleep(500);

    // 5) Save (schedules the post).
    let saveBtn = deepQueryAll('[data-testid="save-button"]').filter(visible)[0];
    if (!saveBtn) {
      // fallback: a visible button whose text is exactly "Save"
      saveBtn = deepQueryAll("button").filter((b) => visible(b) && /^\s*save\s*$/i.test(b.textContent || ""))[0];
    }
    if (!saveBtn) throw new Error("Save button not found in schedule dialog.");
    saveBtn.click();
    status(`  ✓ Scheduled for ${dt.date} ${dt.time}.`);
    await sleep(2500); // let the request go out
  }

  // Handle exactly ONE post on this page life, then navigate for the next row.
  // Runs on Start (current page) and on every submit-page load (auto-resume).
  let processing = false;
  async function processCurrent() {
    if (processing) return; processing = true;
    try {
      const s = await gget([K.running, K.queue, K.index, K.sub]);
      if (!s[K.running]) return;
      const sub = s[K.sub]; const q = s[K.queue] || []; let idx = s[K.index] || 0;
      if (!sub) return;
      if (!onSubmitPage(sub)) { gotoSubmit(sub, idx); return; }
      panelEl && panelEl.classList.add("open");
      if (idx >= q.length) {
        await gset({ [K.running]: false });
        status(`All done ✓ — ${q.length} post(s) scheduled in r/${sub}.`);
        return;
      }
      try {
        await scheduleOne(q[idx], idx, q.length);
      } catch (e) {
        await gset({ [K.running]: false });
        status(`⛔ Stopped on post ${idx + 1}: ${e.message}`);
        return;
      }
      idx += 1;
      await gset({ [K.index]: idx });
      let chk = await gget([K.running]);
      if (!chk[K.running]) { status("Stopped."); return; }
      if (idx >= q.length) {
        await gset({ [K.running]: false });
        status(`All done ✓ — ${q.length} post(s) scheduled in r/${sub}.`);
        return;
      }
      const wait = Math.round(rand(10000, 15000));
      status(`Waiting ${Math.round(wait / 1000)}s before the next post…`);
      await sleep(wait);
      chk = await gget([K.running]);
      if (!chk[K.running]) { status("Stopped."); return; }
      gotoSubmit(sub, idx); // full reload → next row resumes on load
    } finally {
      processing = false;
    }
  }

  // ───────────────────────── boot ─────────────────────────
  function boot() {
    try { ensureUI(); } catch (e) { log("UI error", e); }
    // Give Reddit's SPA a moment to render the composer, then auto-resume if a
    // run is in progress (this fires on each submit-page load between posts).
    setTimeout(() => { processCurrent().catch((e) => log("run error", e)); }, 1800);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
