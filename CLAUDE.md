# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome/Edge Manifest V3 browser extension ("JobBot" internally, branded **AutoApplier** on the site) that automates job applications on **LinkedIn (Easy Apply), Indeed, Naukri, and Bayt**. The repo also deploys to Vercel as a static site + zero-dependency serverless backend, with a **license-key based access model** on top.

There is no build system, package.json, linter, or test suite. All code is vanilla JS/HTML/CSS and dependency-free serverless functions — edit files directly.

## Commands

- **Load the extension:** `chrome://extensions` (or `edge://extensions`) → Developer mode → "Load unpacked" → select the `extension/` folder. It's an *unpacked* extension — clicking reload on the card only re-reads the local folder, so to test repo changes you must copy the new files in (or re-extract the zip) first.
- **Repackage the zip after ANY change under `extension/`:** from the repo root run `zip -rq jobbot-extension.zip extension`. The committed zip is what the landing page serves for download; it must stay in sync with the source.
- **Bump the version** in `extension/manifest.json` when shipping an extension change so users can confirm they loaded the new build (the version shows on the extension card).
- **Syntax-check before committing** (there are no tests): `node -e "new Function(require('fs').readFileSync('extension/content.js','utf8'))"` for the IIFE content script, `node --check extension/background.js extension/popup.js`, and `node --input-type=module --check < api/<file>.js` for the ESM serverless functions.
- **Deploy:** push to `main` — Vercel auto-deploys the repo root as a static site (no framework/build command). `vercel.json` sets `cleanUrls: true`, redirects (`/login`→`/`, `/plans`→`/checkout`, …), and a download header for the zip.
- The live backend is `https://jobs.qckserve.in`. Verify deploys by curling endpoints (e.g. `curl -s https://jobs.qckserve.in/api/plans`) — no local dev server exists.

## Backend (Vercel serverless, `api/`)

Backed by Supabase Postgres over the REST API (schema in `schema.sql`; tables: `jobs`, `users`, `plans`, `purchases`, `license_keys`, `coupons`). `api/_lib.js` holds shared helpers (`sb`, `cors`, `getUserByToken`, `activeLicense`, `rzp`, `verifyHmac`, `readRawBody`, `newKeyString`, `issueKeyForEmail`, `syncPurchaseKey`, `validateCoupon`, `applyReferral`, `creditReferrerDays`) — the `_` prefix keeps Vercel from routing it as an endpoint.

- `api/auth.js` — email/password accounts (scrypt). Actions: `signup`, `login` (returns bearer token + `is_admin`; overwriting `users.token` on login enforces **one active session**), `change`, `forgot` (emails a reset link via Resend), `reset`.
- `api/license-key.js` — **the primary access mechanism.** `POST { key }` validates an admin-issued key (`AA-XXXX-XXXX-XXXX`), activating it on first use (`expires_at = now + validity_days`, or `lifetime`). Used by both the extension and the CRM.
- `api/my-key.js` — `GET` (bearer) → the logged-in account's own key (from a purchase or admin grant), so the dashboard can auto-show it.
- `api/license.js` — `GET` (bearer) → `{ active, is_admin, … }` for the account/plan path.
- `api/jobs.js` — CRM CRUD. Auth by `x-license-key` header (rows scoped by key), or bearer token (scoped by `user_email`, requires an active licence → `402` otherwise), or legacy `x-api-key`.
- `api/ai.js` — Gemini (`gemini-2.0-flash`) `answer`/`fit`/`cover`. Returns `402` for logged-in-but-unlicensed. Mostly superseded by per-user client-side Gemini (see extension).
- **Payments/licensing (Razorpay):** `api/plans.js` (public list), `api/checkout.js` (`POST {plan_id, code}` creates a Razorpay order/subscription + `purchases` row; `?verify=1` verifies the signature, activates the licence, and **auto-generates a license key for the buyer** via `syncPurchaseKey`), `api/razorpay-webhook.js` (raw-body signature check, source of truth for renewals/cancels — also syncs the key). `api/referral.js` (each user's auto-generated referral code + link).
- `api/admin.js` — admin console API. Auth is a hardcoded credential check: `POST {action:'login', email, password}` against `ADMIN_EMAIL`/`ADMIN_PASSWORD` env → deterministic SHA-256 admin token (NOT a `users` row). Actions cover users, licences, plans, referral codes, and license keys (`issue_key` = grant a key for an email with lifetime/limited validity + optional starter password; `create_keys` = blank batch).

### Access model (important)
The extension AND the CRM require access, granted by **either** an active **license key** (admin-issued, or auto-generated on purchase) **or** an active account plan. Keys tie to an email; a purchase auto-issues a key whose validity = the plan's (`duration_days`, or lifetime). Admin can hand out free lifetime/limited keys per email. The `ADMIN_EMAIL` account (or `users.is_admin`) always has access. `extension/background.js` `getLicense()` gates `startAgent()`; it checks the license key first, then falls back to an email/password account.

### Frontend pages (static, served by Vercel)
`index.html` (AutoApplier SPA: email login → dashboard with activation-key card, download, referral, change-password; embedded admin panel for admin logins), `crm.html` (job tracker; login by license key OR email/password), `checkout.html` (plans + Razorpay + one-step account creation; reads `?ref=CODE`), `admin.html` (full console: License Keys, Plans, Users & Access, Referral Codes, Purchases), `reset.html` (password reset link target).

### Env vars (Vercel)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY` (fallback only), `CRM_API_KEY` (legacy), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY`/`RESEND_FROM` (forgot-password email). Schema/env changes need a manual Supabase SQL run + Vercel redeploy — the code can't do DDL or set env vars.

## Extension architecture

Three contexts communicate via `chrome.runtime.sendMessage({ type: ... })`:

- **`extension/background.js`** (service worker) — owns profile/history/stats in `chrome.storage.local` (`jobbot_profile`, `jobbot_history`, `jobbot_stats`), the badge, and the license/CRM session. Key messages: `GET_PROFILE`, `SAVE_PROFILE`, `GET_STATS`, `JOB_APPLIED`, `JOB_SKIPPED`, `GET_HISTORY`, `CLEAR_HISTORY`, `RESET_STATS`, `GET_TAB_ID`, `CLOSE_TAB`, `GET_CRM_TOKEN`, `GET_LICENSE` (key-first, 24h offline grace), `GEMINI_ANSWER` (runs the user's OWN Gemini key client-side — billed to them, never touches the server), `NOTIFY` (desktop notification). `syncToCRM()` POSTs applied/skipped jobs to `{crmUrl||default}/api/jobs` using `x-license-key` (or bearer). Default backend URL is `https://jobs.qckserve.in`.
- **`extension/popup.js` / `popup.html`** — tabs: profile, prefs, history. Prefs holds the **License Key** field + **Save & Activate** button (validates via `GET_LICENSE`), per-user **Gemini API key**, and an Advanced section (backend URL, email/password). Controls the agent via `START_AGENT`/`STOP_AGENT`/`GET_STATUS`, injecting `content.js` with `chrome.scripting` if not yet loaded.
- **`extension/content.js`** — one IIFE (guarded by `window.__jobBotAutoApplyInstalled_v2`), everything that runs on job sites. `PLATFORM` is detected from hostname → one of `LinkedInAgent` / `IndeedAgent` / `NaukriAgent` / `BaytAgent`. Each: find cards → open → apply → step the multi-page form → report `JOB_APPLIED` → paginate. Notable shared pieces:
  - `Filler` — the form engine: `labelFor()` resolves a question, `map()` regex-maps it to a profile answer (**checks `learnedAnswers` first**), `bestOption()`/`fillRadios/fillTexts/fillSelects/fillComboboxes` apply it; `aiAnswer()` falls back to the user's Gemini key (via background) then the backend.
  - `learnedAnswers` — durable memory (`chrome.storage.local` `jobbot_learned`): questions the agent couldn't answer that the user filled manually are saved (`learnFromField`) and auto-filled next time, keyed by a normalized question label.
  - `CAPTCHA` — broad cross-site detector (reCAPTCHA, hCaptcha, **Cloudflare Turnstile / press-and-hold**, Arkose, interstitials). We NEVER auto-solve; a global watcher spotlights it + sends a `NOTIFY` desktop alert and resumes when cleared.
  - `typeInto()` — native value setter + per-char `input` events so React inputs register (`el.value = x` does NOT work on these sites).
  - `SPOT` — on-page overlay (status bar + pulsing highlight + persistent `attention()` for human-in-the-loop). All overlay DOM uses the unique `jobbotx-` prefix so it can't collide with other extensions (e.g. LeadsLoft).
  - Durable run state in `chrome.storage.local` so it survives Indeed's cross-origin hop to `apply.indeed.com` (which `sessionStorage` does not): `appliedSet` (`jobbot_applied_v2`, permanent), `attemptedSet` (`jobbot_attempted_run`, per-run), `selectedSet` (`jobbot_selected_run`, ticked jobs), `jobbot_selmode`, `jobbot_churn`. The auto-resume block + keep-alive watchdog (top frame) restart the run after navigations so it never stops until the user presses Stop.

## Locked integrations

- **LinkedIn is LOCKED** — the `LinkedInAgent` class (`═══ LinkedIn Agent — LOCKED ═══` banners) handles all three A/B search layouts, the tick-queue, the Easy Apply modal flow, and modal cleanup. Do not modify inside the banners unless the user explicitly asks for a LinkedIn change.
- **Indeed is LOCKED** — the `IndeedAgent` class (`═══ Indeed Agent — LOCKED ═══` banners) is verified end-to-end: Apply-with-Indeed, multi-step Continue/Submit, captcha hand-off, sequencing, two-tier dedupe. Do not touch selectors/timings/logic inside the banners unless explicitly asked. `NaukriAgent` and `BaytAgent` are not locked.
- Shared helpers the locked agents depend on (`realClick`, `moveTo`, `humanClick`, `SPOT`, `Filler`, `CAPTCHA`, `appliedSet`/`attemptedSet`, `waitForCards`, auto-resume, watchdog) must stay backward-compatible; if you change one, verify the Indeed/LinkedIn flows still work.

## Conventions and gotchas

- Site selectors (job cards, apply buttons, modals, captchas) are the most fragile part — each agent keeps several fallback selectors per element. When fixing a broken flow, **add** to the selector lists rather than replacing them.
- All clicks/typing use `rand(lo,hi)` + `sleep()` to look human — keep that pattern.
- `manifest.json` `host_permissions` and `content_scripts.matches` must both change together if platform domains change.
- Popup ↔ content-script messaging fails silently when the content script isn't injected; `popup.js` wraps calls in try/catch + injection fallback — preserve it.
- Temporal-dead-zone bugs are easy here (one big IIFE / async popup handler): declare top-level `const`s before any function that uses them runs. A past bug: `DEFAULT_CRM` declared after the code that used it → `ReferenceError` that silently broke the buy button.
- The extension is on a designated dev branch; commits go there and then to `main` for the Vercel deploy. Rebuild the zip in the same commit as any `extension/` change.
