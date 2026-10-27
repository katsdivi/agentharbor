# Demo: AutomationExercise account lifecycle (recorded 2026-10-27)

| File | What it is |
|---|---|
| [`agentharbor-demo-presentation.mp4`](agentharbor-demo-presentation.mp4) | 63 s presentation cut, 1920×1080, H.264, no audio. Captions; one span slowed 4× (labeled); two cuts (each shown as a `[cut]` card); one held frame (labeled). |
| [`agentharbor-demo-full-chronological.mp4`](agentharbor-demo-full-chronological.mp4) | 71 s. Both workers in **real time, unedited except redactions**, between a title card, a worker-transition card and an end card. |
| [`account-created.png`](account-created.png), [`restored-session.png`](restored-session.png) | Screenshots taken by the plugin (`browser_screenshot`) during the same run. |

## What was recorded, and by what

- **Controller:** Claude (Claude Code session) calling AgentHarbor's MCP tools. No human typed or clicked in the browser. Claude chose the selectors, the synthetic profile and the order of calls.
- **Browser:** the plugin's own worker in execution mode `local`: a worker process with headless Chromium (Playwright) on this computer, with a fresh temporary profile. It is not the remote Apify worker the earlier [compatibility test](../evidence/signup-compat-2026-10-27/README.md) used.
- **Recorder:** Playwright's built-in `recordVideo` inside each worker, turned on with `RBA_LOCAL_RECORD_VIDEO_DIR` (added for this demo: see [Recording support](#recording-support)). It records the page viewport only, not Claude's tool calls, which are listed below.
- **Build:** `0.1.0+7b11081.dirty`, i.e. commit `7b11081` plus the uncommitted recording change, as reported by `config_check`.

## Setup and intervention

- **Initial setup (before the run):** the target was already in `RBA_AUTHORIZED_TARGETS`. Recording was enabled in the user config `.env`, and the user reconnected the MCP server (`/mcp`) so it loaded the new build and setting. Selectors were checked beforehand in a separate, unrecorded remote session; it submitted only step 1 of the signup form with an `example.com` placeholder, so no account was created.
- **During the run:** no human or operator intervention, no retries, no manual browser input. Every step succeeded on its first call.

## Run log (UTC, 2026-10-27)

| Time | Tool call (worker) | Result |
|---|---|---|
| 09:51:45 | `account_register {targetOrigin: "https://automationexercise.com", mode: "local", emailMode: "disposable", synthetic: true, keepSessionOpen: true, verification: {required: false}, …}` (worker 1) | Job `job_26e64955950d4193`, account `acct_f42cdf75f73f43e1`. Two-page form filled; newsletter and partner-offer boxes left unchecked. Submitted 09:51:48; "Account Created" observed 09:51:49. The site sends no verification email; a disposable inbox was created because `account_register` always creates one. |
| 09:51:5x | `browser_click` Continue; `browser_navigate /logout` (worker 1) | Logged out, login page shown. |
| 09:51:5x | `browser_fill {secret: "account_email"}`, `{secret: "account_password"}`, `browser_click` login (worker 1) | "Logged in as Alex Demo". |
| 09:52:09 | `session_save_state`, then `session_close` without logging out (worker 1) | 2 cookies saved (encrypted). Worker 1 process stopped. |
| 09:52:10 | `session_start {accountId, restoreState: true}` (worker 2) | New local worker process, `restoredBrowserState: true`. |
| 09:52:1x | `browser_navigate /` (worker 2), **zero fill calls** | "Logged in as Alex Demo". |
| 09:52:1x | `browser_click a[href="/delete_account"]` (worker 2) | "ACCOUNT DELETED!" |
| 09:52:2x | `browser_navigate /login`, `browser_fill` stored email and password, `browser_click` login (worker 2) | "Your email or password is incorrect!", so the site-side deletion is confirmed. |
| 09:52:3x | `session_close`; `account_delete {deleteInbox: true}` | Local record and MailSlurp inbox deleted. |
| 09:52:36 | `account_list`, `email_inbox_list`, `session_status` | All empty. |

Times written `09:51:5x` come from the order of tool calls, which return no timestamps of their own. Worker 2's video starts with about 7 s of blank page, from process start until the first navigation call.

## Privacy

- **Redacted:** the disposable inbox address, wherever it appeared in a form field (signup step 1, the disabled email field on signup page 2, the login form). The redaction is a solid box over generous time windows; every frame in and around those windows was checked at 10–20 fps.
- **Not redacted:** password fields are already masked by the site (`type="password"`). The identity is synthetic ("Alex Demo", "1 Example Street", "Testville", "00000", "5550100"). The address was deleted together with its inbox.
- **Never in the video or repo:** API keys, cookies, saved browser state, verification links (none were sent) and inbox contents.

## Recording support

`RBA_LOCAL_RECORD_VIDEO_DIR` (optional, off by default) makes **local-mode** workers record each page with Playwright `recordVideo` at 1920×1080 into that directory. Remote Apify workers never receive the setting and never record. While recording is on, the worker turns off Playwright's own SIGTERM/SIGINT handlers so that its shutdown can close the browser context, which finalizes the video, before the browser exits. Covered by `test/integration/local-mode.test.ts` ("records a 1920x1080 video…").

Limitations:

- Local mode only. There is no recording for remote workers, and no Apify live view.
- Viewport only: no browser chrome, no tool-call overlay. The captions in the presentation cut were added afterwards.
- One file per page. A worker that replaces its page would produce several files.
- The default viewport becomes 1920×1080 while recording, so pages lay out as on a large desktop.

## How the cuts were made

ffmpeg 8.0.1 on the raw `.webm` files: solid-box redaction, H.264 re-encode at 30 fps, then caption and title cards (PNG, rendered with Pillow) overlaid and joined. The presentation cut removes about 10 s of idle time on the confirmation page and about 7 s of blank page at the start of worker 2, shows the 2-second form fill slowed 4×, and holds the restored-session frame for 3 s. Each of these edits is labeled on screen. The raw `.webm` files are not in the repository.
