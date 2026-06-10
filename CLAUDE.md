# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JobBot — a Chrome/Edge Manifest V3 browser extension that automates job applications on LinkedIn (Easy Apply), Indeed, and Naukri. The repo also doubles as a static site deployed to Vercel: `index.html` at the root is a landing page that serves `jobbot-extension.zip` (a packaged copy of `extension/`) for download.

There is no build system, package.json, linter, or test suite. All code is vanilla JS/HTML/CSS — edit files directly.

## Development workflow

- **Load the extension:** `chrome://extensions` → Developer mode → "Load unpacked" → select the `extension/` folder. After editing `content.js` or `background.js`, click the reload icon on the extension card and refresh the job-site tab.
- **Repackage the zip after changing anything in `extension/`:** from the repo root run `zip -rq jobbot-extension.zip extension`. The zip is committed and must stay in sync with the source, since the landing page serves it.
- **Deploy:** push to `main` — Vercel auto-deploys the repo root as a static site (no framework, no build command). `vercel.json` only sets a download header for the zip.

## Architecture

Three contexts communicate via `chrome.runtime.sendMessage` with `{ type: ... }` messages:

- **`extension/background.js`** (service worker) — owns the profile and application history in `chrome.storage.local` (keys `jobbot_profile`, `jobbot_history`), per-platform stats (in-memory, reset on worker eviction), and the badge counter. Message types: `GET_PROFILE`, `SAVE_PROFILE`, `GET_STATS`, `JOB_APPLIED`, `JOB_SKIPPED`, `GET_HISTORY`, `CLEAR_HISTORY`, `RESET_STATS`.
- **`extension/popup.js`** — the popup UI (tabs: profile, preferences, stats, history). Reads/saves the profile via background messages and controls the agent on the active tab via `START_AGENT` / `STOP_AGENT` / `GET_STATUS` / `PING` messages, injecting `content.js` with `chrome.scripting` if the content script isn't loaded yet.
- **`extension/content.js`** — everything that runs on job sites, in one IIFE (guarded by `window.__jobBotInstalled`). Key pieces:
  - `PLATFORM` is detected from hostname; one of three agent classes is instantiated per page: `LinkedInAgent`, `IndeedAgent`, `NaukriAgent`. Each implements the same loop: find job cards → open → click apply → step through the multi-page form (`handleStep`/`runApplication`/`handleForm`) → report `JOB_APPLIED` → paginate.
  - `Filler` is the shared form-filling engine: `labelFor()` resolves a question label for an input (label[for], aria, DOM-walking), `map()` regex-matches the question text to a profile answer, and `fillRadios/fillTexts/fillSelects/fillComboboxes` apply it.
  - `typeInto()` uses the native value setter + per-character `input` events so React-controlled inputs (LinkedIn/Indeed) register the value. Plain `el.value = x` will NOT work on these sites.
  - `SPOT` renders the on-page overlay (status bar + pulsing highlight box) so the user can watch the agent and stop it.
  - Indeed applications navigate to `apply.indeed.com`, which reloads the content script; the auto-resume block at the bottom of the file restarts an `IndeedAgent` mid-application when `jobbot_running` is set in storage.

## Conventions and gotchas

- Site selectors (job cards, apply buttons, modals) are the most fragile part — each agent keeps several fallback selectors per element because the sites change markup frequently. When fixing a broken flow, add to the selector lists rather than replacing them.
- All delays use `rand(lo, hi)` + `sleep()` to look human; keep that pattern for any new clicks/typing.
- `manifest.json` `host_permissions` and `content_scripts.matches` must both be updated if a platform's domain coverage changes.
- Popup ↔ content-script messaging fails silently when the content script isn't injected; `popup.js` wraps these in try/catch and falls back to injection — preserve that pattern.
