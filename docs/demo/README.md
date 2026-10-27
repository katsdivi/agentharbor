# Demo: AutomationExercise account lifecycle (recorded 2026-10-27)

| File | What it is |
|---|---|
| [`agentharbor-product-film.mp4`](agentharbor-product-film.mp4) | **Product film**, 56 s, 1920×1080, H.264, 30 fps, with voice-over, music and sound effects (AAC stereo, −16 LUFS). An edited, art-directed cut of the same run (see [Product film](#product-film)). |
| [`agentharbor-product-film-poster.png`](agentharbor-product-film-poster.png) | Poster for the README. It links to the film. |
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

## Product film

`agentharbor-product-film.mp4` (56.0 s, 1680 frames) is an edited cut of the recorded run above, made for presentations. Its source is in [`video/`](../../video/README.md) (Remotion 4). It shows no other run and no other site. The chronological recording stays the evidence; the film is not a substitute for it.

**Structure**

| Time | Act | Footage used (worker, time in the raw recording) |
|---|---|---|
| 0–5.5 s | Opening: "Give agents a place to work." | Worker 1, raw 15.5 s onward: the login page, then signed in |
| 5.5–18 s | 01 Signup: "From signup to signed in." | Worker 1: the filled signup form (still), Create Account (still), the "Account Created!" page (video from raw 2.45 s) |
| 18–31 s | 02 Session: logout and log back in; save and close | Worker 1, raw 15.2–17.2 s at **0.5×**; logged-in nav (still); then an **illustrative diagram** |
| 31–44 s | Hero: "A new browser. The session continues." | Worker 1 last frame (still, dimmed, "closed"); Worker 2, 7.3–7.82 s at **0.5×**, then a **held frame** at 7.82 s with a slow push-in on "Logged in as Alex Demo" |
| 44–50 s | 03 Cleanup: "Complete the task. Clean up." | Worker 2 from 7.62 s (delete click, "Account Deleted!"), then 16.42 s onward (login refused), then a still |
| 50–56 s | End lockup | — |

**Edits, disclosed:**
- Cuts. Most idle time is removed: about 11 s on the confirmation page, about 7 s of blank page at the start of worker 2, and the waits between steps.
- Speed. Two spans run at 0.5×, each marked with a "0.5×" badge in the browser frame. No success state is sped up.
- Stills and held frames. The form close-ups, the logged-in nav, the hero hold and the final refused-login frame are stills taken from the redacted recording.
- Labels. A persistent "Edited demo" label and a "Demo: local mode · AutomationExercise" label are on screen throughout the footage.
- Illustration. The Agent → AgentHarbor → Browser diagram is an **illustration**, labeled as such, not captured telemetry. The events it shows (`session_save_state`, 2 cookies, encrypted; `session_close`) are the real calls and results from the run log.
- Tool names. Every tool name, argument and status in the film comes from the run log: `account_register` (mode `local`), `job_status` (`completed`, outcome `confirmed`), `browser_fill` (`secret: "account_password"`), `session_save_state`, `session_close`, `session_start` (`restoreState: true`), `account_delete` (`deleteInbox: true`) and `session_status`. "0 credential fills in worker 2" is the call count for the restore.
- Not shown, because there is no footage of it: the fields being typed. Signup page 2 was already filled in the first frame the film may use (see Privacy), so the film shows the filled fields and does not imply live typing.

**Privacy in the film.** The composition reads only *redacted masters*, never the raw recordings:
- The login email field is filled with its own background colour (`#EEEDE6`) on exactly the frames where the login page is visible. Those frames were detected from the page's orange "OR" badge: worker 1 frames 384–400, worker 2 frames 410–605.
- A small "email hidden" note marks the field in the film.
- Worker 1's first 40 frames (signup step 1 and the top of page 2, where the address appears in other fields) are dropped entirely.
- An automated check confirmed that the email field holds no text pixels on any login-page frame of either master. The scripts are in `video/scripts/`.
- No field contents were replaced with invented values; the field was emptied and is labeled.

**Reference treatment.** The art direction draws mainly on a public Pinterest motion piece (pin 961166745494526510, a SaaS UI explainer by CreativeHarshit), which was viewed for study only. The film borrows its alternating light and dark acts, focus-pull reveals, condensed sticker labels, a single teal light sweep at act breaks, and horizontal-blur whips. Two other pins (703756189701217, a floating product-UI render, and 873768765227982709, a CGI camera launch) informed the slow camera moves and the macro close-ups of real screens. No footage, branding or audio from the references is used. The AgentHarbor mark is original.

**Audio.** Voice-over, music and sound effects, all generated with ElevenLabs by the project author (voice: Eleven v4; music: Eleven Music v2.5, a 56 s instrumental; effects: text-to-sound v2). The sources are in [`video/public/audio/`](../../video/public/audio/) and the mix is defined in [`video/src/Soundtrack.tsx`](../../video/src/Soundtrack.tsx).
- **Voice-over script**, one line per act, each placed inside the act it describes:
  1. "Give agents a place to work."
  2. "Here, Claude uses AgentHarbor to create a test account with a synthetic profile. It fills the form, submits it, and checks the confirmation. No human typing or clicking."
  3. "Next, it logs out and back in using the stored credentials."
  4. "AgentHarbor saves the encrypted browser state. Then the first worker shuts down."
  5. "A fresh worker starts and restores the login without entering credentials again. New browser, same session, no password déjà vu."
  6. "Finally, it deletes the website account, verifies that login fails, and removes the local account record and inbox."
  7. "AgentHarbor: account workflows that agents can carry forward."
- Every factual claim in the script matches the run log above. Line 7's pause after "AgentHarbor" was shortened from 1.2 s to about 0.5 s so the line ends before the film does; no other line was edited or retimed.
- The music ducks by about 8 dB under each voice line. Effects: a whoosh on each act transition, a soft tick as each tool chip or check appears, a chime on "Account Created", "SIGNED IN" and the restored session, and a resolve on the end lockup. They are sound design, not recorded UI sounds; the recording itself has no audio.
- Mastered with two-pass `loudnorm` to −16 LUFS integrated, −1.5 dBTP (`video/scripts/master-audio.sh`). Picture is unchanged from the silent cut. The on-screen text still carries the story on mute.

**Limitations of the film**
- It is an edit of one local-mode run on one practice site. It does not show remote or Apify execution, email verification, CAPTCHA handling or other sites.
- Close-ups enlarge 1080p browser footage by up to about 2.5×, so small site text is legible but soft.
- Frame accuracy was checked on sampled frames (every transition at 10–30 fps, and the whole film at 2–5 fps) and by an independent frame review. The film was not watched in a video player.
- The soundtrack was checked by measurement, not by ear: a speech-to-text pass over the final mix recovers every voice-over line verbatim and at its planned time, loudness is −16.0 LUFS with −1.5 dBTP true peak, and no two voice lines overlap.
