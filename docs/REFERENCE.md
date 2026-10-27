# Detailed reference

> This is the previous, long-form README, kept as the detailed reference for design, operations and limits. The short overview is the top-level [README](../README.md).


A Claude Code plugin that runs web tasks for Claude: browser sessions, scraping and bounded crawls, verification email through real MailSlurp inboxes, persistent website accounts, file cleaning and portal uploads. Each run returns evidence of what happened, where it ran and what is still uncertain. Credentials and browser state are stored encrypted, and each account can be leased by only one job at a time.

**Where requests come from.** You choose an execution mode, and the plugin never falls back between them (see [docs/MODES.md](MODES.md)):
- `remote_direct` (the default): a remote Apify container.
- `remote_proxy`: a remote container through the requested Apify proxy. It fails closed if the route can't be verified.
- `local`: a worker on this computer with a fresh temporary automation profile. It is used only when you ask for it, and it never touches your personal browser profile or cookies.

In the remote modes the local MCP server only calls the Apify and MailSlurp APIs. Target-site traffic stays in the container.

**Start here:** `/remote-browser-accounts:pipeline <your web task>` runs the whole task, using only the stages it needs. Natural phrasing such as "use the pipeline to…" usually routes there too, but the command is the reliable entry point. `pipeline_capabilities` shows what this installation can do.

## Setup

Full instructions are in **[docs/INSTALL.md](INSTALL.md)**: install paths, where the `.env` and data live, upgrades, backups and removal. Platform support is in [docs/PLATFORMS.md](PLATFORMS.md); only macOS arm64 has been tested.

Requirements: Node.js ≥ 22.13 (the plugin uses the built-in `node:sqlite`), npm ≥ 10 and git. You also need your own Apify and MailSlurp accounts (bring your own credentials; none ship with the plugin).

```bash
npm ci && npm --prefix actor ci   # install (exact versions from the lockfiles)
npm run build                     # compile server (dist/) and worker (actor/dist/)
npm run doctor                    # runtime, build, local-mode, config (names only), data dir, file tools
npm run init-env                  # creates .env from .env.example (never overwrites), mode 600,
                                  # generates RBA_ENCRYPTION_KEY and RBA_DASHBOARD_TOKEN without printing them
npm run check-config              # lists missing variable NAMES per capability
(cd actor && npx playwright install chromium)   # only for execution mode local and the worker tests
```

Fill these in `.env` yourself. Don't paste them into chat:

| Variable | Needed for |
|---|---|
| `APIFY_TOKEN` | remote browser (your Apify API token) |
| `APIFY_ACTOR_ID` | printed by `npm run deploy-actor` |
| `MAILSLURP_API_KEY` | receiving verification email |
| `RBA_AUTHORIZED_TARGETS` | origins where you are authorised to create or use accounts (`https://app.example.com\|https://auth.example.com`) |

Back up the `.env` and the `data/` folder together. The encryption key in `.env` is the only way to read stored accounts.

Then deploy the worker Actor to your Apify account (private Actor, built on Apify):

```bash
npm run deploy-actor   # prints APIFY_ACTOR_ID=<you>~remote-browser-worker; add it to .env
npm run live-check -- --browser            # one short direct session (uses Apify credit)
npm run live-check -- --proxy=residential  # verifies the proxied route (residential billed per GB)
npm run live-check -- --email              # creates and deletes one MailSlurp inbox
```

### Install the plugin in Claude Code

```bash
claude plugin validate .
claude plugin marketplace add "$(pwd)"
claude plugin install remote-browser-accounts@remote-browser-accounts-local
```

Or load it for one session only with `claude --plugin-dir "$(pwd)"`.

A local-path marketplace loads the plugin in place: `${CLAUDE_PLUGIN_ROOT}` is this folder, and the MCP server (started through `scripts/start-mcp.mjs`, which checks Node and the build first) uses `./.env` and `./data` here. Claude Code doesn't install or build anything for in-place plugins, so run `npm ci && npm --prefix actor ci && npm run build` yourself after each update. This was verified on 2026-10-09 with the earlier `.mcp.json`; `.env` lookup now also checks `${CLAUDE_PLUGIN_DATA}` first (see docs/INSTALL.md), and existing installs resolve unchanged.

For other machines, `npm run package` builds an allowlisted artifact (prebuilt, runtime-only lockfile, no `.env`, `data/` or `node_modules`), and `npm run smoke:install` tests a clean install of it. A GitHub-hosted catalog is prepared under `release/` but **not tested end-to-end**.

## Usage guide (installed plugin)

Run `claude` in any directory once the plugin is installed (see above), `npm run build` is done, and `.env` is filled. The tools appear as `mcp__plugin_remote-browser-accounts_remote-browser__<tool>`. Plain-language prompts work; the tool calls Claude should make are listed so you can check them.

### Origins: what each setting means (actual parser syntax)

```bash
# Sites where accounts may be created or used. Comma-separated; each entry is the
# target origin, optionally followed by |auth origins (login/verification hosts).
RBA_AUTHORIZED_TARGETS=https://automationexercise.com,https://app.example.com|https://auth.example.com

# Main-frame NAVIGATION for sessions without an account. Exact origins. Empty =
# no navigation; "*" = any public origin (only if you set it explicitly).
RBA_ALLOWED_ORIGINS=https://automationexercise.com,https://the-internet.herokuapp.com

# Extra RESOURCE origins (iframes, scripts, styles, images, fetch/XHR, WebSockets,
# workers, and redirect hops of those). Navigation origins are always included.
RBA_SUBRESOURCE_ORIGINS=https://cdn.example.com,https://*.gstatic.com

# Private/loopback test hosts (host or host:port). Leave empty normally.
RBA_ALLOW_PRIVATE_HOSTS=
```

- Bare hostnames become `https://` origins.
- `https://*.gstatic.com` matches subdomains such as `fonts.gstatic.com`, not `gstatic.com` itself.
- Scheme and port must match; `wss:` is matched as `https:`, and `ws:` as `http:`.
- An account session navigates only to its target and that target's auth origins. `RBA_ALLOWED_ORIGINS` doesn't apply to it.

Example with the values above, in an account session for Automation Exercise:
- Opening `https://automationexercise.com/products` is allowed.
- A redirect from there to `https://evil.example/` is refused **before the request is sent**.
- A font from `fonts.googleapis.com` is refused, and the page still works.
- An `<iframe src="https://cdn.example.com/x">` loads, but navigating the page itself to `https://cdn.example.com` is refused.

To find out what a site needs, ask: *"Show the network log for session <id>"* (`session_network_log`). Add only origins the site actually needs.

### 1. Create a session on a configured target

> Start a remote browser session, open https://automationexercise.com/products, extract each product's name and price, then close the session.

`session_start {}` → `browser_navigate {sessionId, url}` → `scrape_extract {sessionId, spec: {itemSelector: ".features_items .product-image-wrapper", fields: {name: {selector: ".productinfo p"}, price: {selector: ".productinfo h2"}}}, save: true}` → `session_close {sessionId}`

### 2. Use an existing account

> Add my existing account on https://app.example.com (email me@example.com), then start a session for it and log in.

`account_add {targetOrigin, email}` → **you** set the password in the local dashboard (`npm run dashboard -- --open`, Accounts page), never in chat → `session_start {accountId}` → `browser_navigate` to the login page → `browser_fill {selector, secret: "account_email"}` and `browser_fill {selector, secret: "account_password"}` → `browser_click {selector, waitForNavigation: true}` → `session_save_state {sessionId}`.

The target must be listed in `RBA_AUTHORIZED_TARGETS`.

### 3. Register one authorised account and verify its email

> On https://app.example.com (authorised for testing), inspect the signup page, then register one synthetic test account and complete the email verification.

1. `session_start {}` → `browser_navigate` to the signup page → `browser_inspect` to find selectors → `session_close`.
2. `account_register {targetOrigin, signupUrl, displayName, synthetic: true, fields: [...], submitSelector, successText, rejectionTexts, verification: {linkContains: "/verify", successText: "Email verified"}, idempotencyKey, waitSecs: 100}`. In `fields`:
   - `{selector, value}` fills a field; the value can be a secret reference such as `{secret: "email"}` or `{secret: "password"}`.
   - `{selector, select: [...]}` picks dropdown options.
   - `{selector, click: true, waitForNavigation}` clicks a radio, checkbox or an intermediate "Next" button of a multi-page form.
3. `job_status {jobId, waitSecs: 100}` until the job is terminal. The job creates its own MailSlurp inbox, submits once, waits for the email, opens the link remotely and saves its browser state. It marks the account `active`/verified only when the page shows `verification.successText`; without it the job ends `completed_unconfirmed` (opening a link or loading a page is not a confirmation).

If the site doesn't send verification email, pass `verification: {required: false}`; the post-submit `successText` is then the confirmation. Pass a unique `idempotencyKey` so a repeated call returns the same job instead of creating a second account.

#### Job states

| `status` | Meaning | What to do |
|---|---|---|
| `completed` | The requested result was observed (for signups and uploads: the confirmation you specified matched) | nothing |
| `completed_unconfirmed` | The form/file was sent, but no confirmation was observed | check the site; do not repeat blindly |
| `outcome_unknown` | Something may have been sent and the result is not known (timeout, lost connection, process ended after submit) | check the site; never repeated automatically; for signups re-run `account_register` with `accountId` (it never resubmits) |
| `interrupted` | The process ended before anything was sent | safe to start again |
| `failed` / `cancelled` / `blocked` | as named; `cancelled` can still have `sideEffectsPossible: true` | see `nextAction` |

`job_status` also returns `step` (the last durable step, e.g. `file_selected`, `form_submitted`, `confirmation_observed`), `outcome`, per-step evidence, `sideEffectsPossible`, `safeToRetry`, `nextAction` and `pendingCleanup`. It and `job_cancel` work for jobs left by an ended process: at startup the plugin claims such jobs, re-attaches a crawl whose run is still going, and settles the rest as `interrupted` or `outcome_unknown`.

### 4. Upload a file and retrieve results

> Upload data/uploads/report.pdf to the file field on https://site.example/upload, submit, and show what the page reports.

1. Put the file in `data/uploads/` (or a folder listed in `RBA_UPLOAD_ROOTS`).
2. `browser_navigate` to the upload page.
3. `browser_upload {sessionId, selector, filePath}`. The file's bytes are sent to the worker, and the worker returns their size and SHA-256 (`verified: true`).
4. `browser_click {selector, waitForNavigation: true}`. Add `dialog: {action: "accept", types: ["confirm"]}` only if a confirm box guards the submit.
5. `scrape_extract {..., save: true}`. Saved results go to `data/results/`.

For many pages: `crawl_start {startUrls, maxPages, extract}` → `job_status` → `job_results {jobId}`.

### 5. Restore saved login state

> Start a session for account <id> and check whether it is still logged in, without logging in again.

`session_start {accountId}` (the response shows `restoredBrowserState: true`) → `browser_navigate` to an account-only page → `browser_inspect`, and look for account-specific text.

If the login has expired, log in explicitly as in section 2; that is a fresh login, not a restore. Save with `session_save_state` or `session_close {sessionId, saveState: true}`.

### 6. Read usage and close everything that is active

> Show usage, then cancel every running job and close every active session.

`usage_report {}` → `job_status {}` (lists recent jobs) → `job_cancel {jobId}` for each one that is not terminal (`running`, `awaiting_email`, `verifying`, `created`) → `session_status {}` (lists active sessions) → `session_close {sessionId}` for each.

`session_close` aborts the Apify run. It keeps an account's lease until the run is confirmed stopped.

### Cleanup behaviour

- **Sessions:**
  - The worker exits after `RBA_IDLE_TIMEOUT_SECS` (180 s) without commands.
  - Apify ends the run at the session limit plus 1 minute.
  - When the MCP server exits, it closes the sessions it started.
  - At startup and every 60 s, the plugin cleans up runs that ended and leases that expired.
  - A run (Apify or local worker) whose stop cannot be confirmed, and an inbox whose deletion fails, go to a cleanup queue that is retried with backoff (30 s up to 1 h). They are shown as `pendingCleanup` in `job_status` and `account_delete`; the account lease is kept until the run is confirmed stopped.
- **Accounts:**
  - `account_delete {accountId, confirmAccountId, deleteInbox: true}` removes the **local record** (encrypted password and saved state) and, with `deleteInbox`, its MailSlurp inbox. The result says `localRecordDeleted: true`, `websiteAccount: "not_deleted"` and `inbox: deleted | kept | cleanup_pending`. It does **not** delete the account on the website; do that through the site.
- **Inboxes (email modes):** `account_register` takes `emailMode: "kept" | "disposable"` (default `kept`).
  - **Every inbox is bound to its site.** Only mail whose sender domain belongs to the target (or one of its auth origins in `RBA_AUTHORIZED_TARGETS`) is used or shown; `email_search` counts the rest as `ignoredOtherSenders`. If a site sends from another domain, add that domain as an auth origin.
  - **kept:** persists until you delete it. The newest 100 messages are kept. The AI can list (`email_search`) and show (`email_read`) messages from the bound site.
  - **disposable:** open 1 hour from creation; `email_inbox_extend` extends it once, to at most 24 hours after creation. Then it closes and its messages are deleted. `email_inbox_reopen` reopens it for another hour within 7 days of the first close (mail that arrived while closed is deleted first, never shown). After 7 days it is retired: the MailSlurp inbox is deleted.
  - `email_inbox_list` shows mode, status, bound sites and windows. `email_inbox_delete {accountId, confirmAccountId, forgetAddress?}` deletes the inbox completely (messages and provider inbox; retried if MailSlurp fails). The account record and website account stay; `forgetAddress` also removes the address from the record.
  - Retired and deleted addresses keep only a salted one-way hash (`inbox_tombstones`), so an address is never reused.
  - Closing, retiring and trimming run at startup and every 60 s, so they also happen after a restart.
  - Kept inboxes are permanent unless `RBA_INBOX_EXPIRES_HOURS` is set; disposable inboxes ignore that setting (they are retired by the plugin).
  - Limitation: the sender check reads the `From` address MailSlurp reports; it does not verify DKIM, so a spoofed `From` is not detected.
  - If a crash interrupts inbox creation, the next startup asks MailSlurp for the reserved inbox. It deletes the inbox if it exists, and frees the quota slot only if MailSlurp confirms it was never created.
- **Local files:** logs are kept for 30 days and screenshots/results for 14 days (`RBA_LOG_RETENTION_DAYS`, `RBA_ARTIFACT_RETENTION_DAYS`).
- **Test fixture:** fixture runs exit after their `lifetimeSecs`.

**Default limits** (in `.env.example` and code), for the Apify free plan ($5/month):

| Setting | Default |
|---|---|
| `RBA_MONTHLY_BUDGET_USD` | 1.00 (whole account) |
| Concurrent sessions | 1 |
| Session length | 10 minutes |
| Idle timeout | 180 s |
| Crawl pages | 50 |
| Residential reserve | 0.02 GB |
| `RBA_APIFY_CU_PRICE_USD` | 0.2 |
| Worker memory | 2048 MB |

### 7. Clean a file and upload it to a portal

See **docs/FILES.md** for the full tool reference, format/policy matrix, dependencies and limitations. In short: `file_import` (from `RBA_IMPORT_ROOTS` or the dashboard Files page) → `media_inspect` → `media_sanitize` → `media_verify` → `portal_upload` (first call without selectors returns the observed form controls; second call with `fileInputSelector`, `submitSelector`, `confirmation` and `requireSanitized: true`). Run `npm run doctor` once to check ffmpeg/ffprobe and Poppler.

### Dashboard

```bash
npm run dashboard -- --open
```

This serves on `127.0.0.1:4777` only. `--open` sends a single-use sign-in link straight to your browser without printing it. The link is passed as an argument to the `open` command; it's valid for 2 minutes and works once. You can also sign in at `/login` with `RBA_DASHBOARD_TOKEN`. The dashboard shows jobs, accounts, results downloads and usage. It's also where you type passwords for existing accounts, so they never pass through chat.

## Tests

The review report, with each finding and its status, is in [docs/REVIEW.md](REVIEW.md).


```bash
npm test                 # build + all fixture tests (on a laptop: caffeinate -dimsu npm test, so sleep can't stall them)
npm run test:unit        # fast unit tests
```

Fixture tests run the real `ApifyProvider`, `MailSlurpClient` and worker code against fake Apify and MailSlurp HTTP APIs and a local fixture website. The fake Apify API starts the real worker as a local process. That is engineering verification only, not evidence of compatibility with a third-party site or with the live platforms. Live checks are the separate `live-check` command above.

### Controlled live fixture (test-only)

`fixture-actor/` is a small test site deployed as a private Apify Actor (`npm run deploy-actor -- --fixture`). Each run serves, on its public run URL:
- signup with a real verification email, sent over SMTP straight to the recipient domain's MX, with no credentials
- verify, login and account pages
- an upload endpoint that echoes the received file's size and SHA-256

Its limits: it emails only to `allowedRecipientDomains` (at most `maxEmails`), keeps accounts only in memory, and exits after `lifetimeSecs`. To use it, start a run, then add its origin to `RBA_AUTHORIZED_TARGETS` / `RBA_ALLOWED_ORIGINS` **for the test process only**. It is not a third-party site, and results against it say nothing about other sites.

## Architecture

```
Claude ──MCP stdio──> local orchestrator (dist/src/mcp)          data/ (0700)
                        ├─ SQLite registry (node:sqlite, WAL)     registry.sqlite: accounts, leases,
                        ├─ AES-256-GCM vault (RBA_ENCRYPTION_KEY)   sessions, jobs, usage, logs
                        ├─ jobs: register / email_wait / crawl    artifacts/ results/ uploads/
                        ├─ budget + usage accounting
                        ├─ MailSlurp adapter ──HTTPS──> api.mailslurp.com
                        └─ ApifyProvider ──HTTPS──> api.apify.com (start/poll/abort runs, usage)
                                │
                                └─HTTPS + per-session bearer──> Actor run container URL
                                       remote worker (actor/): Playwright Chromium,
                                       network policy, proxy, egress check, crawl
dashboard (dist/src/dashboard) ── 127.0.0.1 only, token + CSRF + Host/Origin checks
```

- **One Actor run is one browser session.** The orchestrator starts a run of the private `remote-browser-worker` Actor and waits until the run's container answers `GET /health` (live Apify runs did not always report `isContainerServerReady`). `APIFY_ACTOR_BUILD` optionally pins a build. It then talks to the run's container URL. The worker gets only `sha256(token)` in its Actor input, and the token travels only in the `Authorization` header over TLS. Cookies and storage state also go over that channel and are never put in the Actor input.
- **Standby mode isn't used.** It load-balances requests across runs, which breaks a stateful browser session.
- **Accounts** hold references only: inbox, `cred:` (encrypted password), `state:` (encrypted cookies and localStorage), and a proxy profile with no secrets. Apify resolves proxy passwords inside the platform. Blobs are encrypted with the account id as AAD, so a blob copied to another account fails to decrypt instead of mixing sessions.
- **Leases** are exclusive, use `BEGIN IMMEDIATE` transactions, and are renewed by a heartbeat while their session lives. A lease left by a crashed process expires and can be reclaimed, and the caller is told. A startup sweep closes sessions whose runs ended and frees their leases.
- **Network policy runs inside the worker.** Two separate permissions:
  - **Navigation** (main frame): exact origins only. Account sessions: the target and its auth origins. Other sessions: `RBA_ALLOWED_ORIGINS`, empty by default (no navigation until configured; `*` only when set explicitly).
  - **Resources** (iframes, scripts, styles, images, media, fetch/XHR, beacons, EventSource, WebSockets, workers, and every redirect hop of those): navigation origins + `RBA_SUBRESOURCE_ORIGINS` (exact origins or `https://*.example.com`; `*` only explicitly) + the egress-check origin. Default: nothing beyond the navigation origins. `session_network_log` lists refused hosts so you can add only what a site needs.
  - Private, loopback, link-local and metadata addresses are refused for everything (unless listed in `RBA_ALLOW_PRIVATE_HOSTS`).
  - Enforcement, all before the request is sent:
    - Playwright `context.route` checks the first request of every chain against the right list.
    - A per-page CDP `Fetch` guard pauses every document hop, including redirect hops that `context.route` never sees (tested).
    - `routeWebSocket` checks WebSocket URLs.
    - Popups and new windows are refused before their first request.
    - All browser traffic goes through a policy proxy inside the worker. It checks the resource allowlist per host and port (CONNECT tunnels hide the scheme) and the address policy when the connection is made, so redirect hops of subresources, out-of-process frames, workers, preconnects and WebSocket tunnels are covered too. In direct mode it connects to the exact IP it just checked.
    - When the browser abandons a request, the proxy tears down the upstream request.
  - Proven with controlled fixtures: a disallowed origin receives **zero** requests from img, stylesheet, `@import`, script, iframe, audio, fetch, XHR, beacon, WebSocket, EventSource, worker fetch, and redirects of img, iframe and fetch. A configured resource origin receives them and is still not navigable. A bare `preconnect` can't be observed at the destination; only the proxy's refused-host record covers it. After the init-time IP check, the egress-check origin is no longer reachable by pages unless configured.
  - The worker and the orchestrator must be deployed together: older worker builds reject the `allowedSubresourceOrigins` input. `APIFY_ACTOR_BUILD` pins a build.
  - Unsupported or unverified paths:
    - DNS: the worker resolves hostnames itself for the address check, so lookups leave from the container's resolver.
    - Chromium's internal traffic, such as component updates, would also go through the proxy and be refused unless allowed; not separately tested.
    - Plugins, PDF viewer subrequests and `<a ping>` haven't been tested separately; they still pass the proxy.
    - Service workers are blocked entirely.
  - After each action the redirect chain and final URL are re-checked (defence in depth).
  - Command deadlines: every browser command runs under its own timeout + 20 s.
    - On overrun the worker closes the page (cancelling the pending call), waits for it to settle, swaps in a blank page in the same context (cookies kept), and only then releases the lock (`recovery: page_reset`). If the call can't be stopped, the worker shuts down (`terminated`).
    - If the orchestrator gets no answer, it aborts the run before releasing the account lease.
  - Navigation readiness: page readiness and task readiness are kept apart. A navigation succeeds when the document arrives and parses (DOMContentLoaded) within `timeoutMs` (default 30 s). The browser then waits toward `load` (or `networkidle`) for at most `settleMs` (default 10 s), and that wait never fails. Slow or hanging optional resources (images, ad and analytics scripts) show up as `readiness.load: "pending"` with `pendingRequests` (count and hosts). What a task needs is stated with `readyWhen` (`selector`, `textContains`, or `response: {urlContains, status?}`, plus `timeoutMs`, default 15 s). If the condition is not met in time, the call fails with `details.workerCode: "condition_not_met"` and says what was missing. Every navigation returns `readiness: {document, load, condition, pendingRequests, documentMs, loadMs, elapsedMs}`.
    - `waitUntil` is still accepted, but it now chooses what the bounded settle waits for. It is no longer a reason to fail. `domcontentloaded` skips the settle. A page that never finishes `load` used to fail at a fixed 30 s; it now returns after the settle with `load: "pending"`.
    - Tools use this internally. `scrape_extract` with an `itemSelector` waits up to 10 s for the first item, and if none appears it fails instead of returning an empty list (`waitForItems: false` turns this off). `portal_upload` waits up to 20 s for the named file input and up to 15 s for the confirmation selector or text after a successful submit. `account_register` waits for the first form field and for the success text. A click that waits for navigation needs DOMContentLoaded and then settles toward `load` for up to 10 s.
    - Crawl pages need the document within the page timeout, settle toward `load` for up to 5 s, and wait up to 2 s for `extract.itemSelector`.
    - Policy-blocked hosts are refused before any connection is opened (under 30 ms in live logs), so they do not delay a page.
    - Older worker builds don't advertise the `readiness` capability. With them, internal waits fall back to the earlier request shape, and an explicit `readyWhen` is refused with `config_missing` (redeploy the worker).
  - Crawls: each page has a deadline of (retries + 1) × page timeout + 20 s, and the whole crawl has one (session minutes − 1). Each URL gets a fresh page (same context). Cancel or deadline closes the crawl page, which stops in-flight navigation and evaluation and aborts the upstream request. The job ends `cancelled` or `completed` (partial, `stoppedBy: crawl_deadline`), and the session closes and releases the lease. An orchestrator watchdog cancels if the worker overruns.
  - Dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) are dismissed by default. `browser_click` and `browser_navigate` accept a `dialog` policy that applies only during that action (one dispatcher per page; each dialog handled within 5 s). Prompt text is never logged or echoed back.
  - Other rules: service workers are blocked, and account sessions may only navigate to the account's target and its auth origins. Secrets are only typed when the page origin and the element's frame origin are both allowed, and that check runs inside the worker in the same step as the fill.
- **Proxy routing:** `datacenter` and `residential` use Apify Proxy, configured in the worker. When a session starts, the worker compares the IP the browser shows to an IP echo endpoint (`api.apify.com/v2/browser-info`) with the container's direct IP. If they're the same or the check fails, the session is refused (fail closed, no direct fallback). This is enforced with Chromium's proxy setting plus that IP check, not at kernel level. Both are labelled that way in every `egress` report. WebRTC is restricted to proxied UDP. DNS rebinding between the worker's DNS check and Chromium's connection is a documented residual risk in direct mode.
- **Scraping** is declarative (`scrape_extract`: selectors and attributes) and never runs custom code. Crawls run inside the same remote context, so authenticated pages work and the same network policy applies. They are bounded by pages, depth, same-origin rules, globs, delay and retries. Crawlee isn't used inside the worker: its browser pool would launch a second browser outside the session's authenticated context and route guard. Playwright alone covers the bounded BFS.
- **Registration** is a job: `created → running → awaiting_email → verifying → completed`, plus `failed`, `cancelled` and `blocked`. The submit time is saved before the click, and the form is never submitted twice. If a submit times out, the account becomes `unknown` and the job checks the inbox instead. A verification email has to be addressed to the account's own inbox, arrive after the submit, come from the target or link to an allowed origin, and not have been used by an earlier job. Multi-page signup forms are supported: `fields` entries can fill, `select` options, or `click` (radio, checkbox, or an intermediate "next" button); only `submitSelector` counts as the account-creating submit. Block detection has three outcomes: an **integration** (a CAPTCHA vendor's script, hidden badge or invisible widget; reported in `page.integrations`, never a block), **challenge required** (a visible widget or challenge page, or "verify you are human" text on a short page), and **access denied** (HTTP 403/429; the status says nothing about which mechanism refused). Only the last two stop the job and quarantine the account. Google targets are refused, and a rejected email domain is never swapped for another.

## Provider choice (verified 2026-10-08)

| | Apify (chosen) | Steel (rejected as primary) |
|---|---|---|
| Free allowance | $5 usage credit **every month** (unused credit does not roll over); usage beyond it is blocked until the next cycle | **$30 one-time**, expires after 90 days |
| Proxies on free tier | datacenter (5 IPs) and residential ($8/GB) usable inside the platform | Steel proxies and CAPTCHA solving require a $10 paid deposit |
| Session length | bounded by run timeout (set from `RBA_MAX_SESSION_MINUTES`) | 15 min max on the free plan |
| Usage visibility | per-run `usageTotalUsd`, `usage`, `stats.computeUnits`; account `GET /v2/users/me/limits` | per-minute browser hours |
| Integration shape | custom Actor + container web server (our own worker, our own network policy) | managed CDP sessions, simpler but no in-browser policy layer we control |

Apify was chosen because the free allowance recurs, proxies work without a paid deposit, the account stops at its limit instead of upgrading to paid, and our own worker can enforce the network policy remotely. Costs: a run takes roughly 10–30 s to start, and the Actor must be deployed once. Steel's per-hour price is lower and its CDP sessions are simpler to integrate. But the free credit is one-time, sessions are capped at 15 minutes, and proxies need paid funds. Only the Apify adapter is implemented, behind `src/providers/types.ts`. MailSlurp's free plan, as of the verification date: 100 inbox creations a month (a fixed cap), 50 retained inboxes, 500 received emails a month, API access, and custom domains only on paid plans. The defaults (`RBA_MAILSLURP_MAX_*`) stay below these.

Prices and limits above came from the providers' pricing and docs pages on the date shown. Check them again before relying on them. `RBA_APIFY_CU_PRICE_USD` is only used for estimates; measured figures come from the Apify API.

## Usage accounting

**Budget scope.** `RBA_MONTHLY_BUDGET_USD` caps the **whole Apify account** for its current billing cycle (Apify's cycle, e.g. the 9th to the 8th), not only this plugin. Builds, the test fixture, other Actors and anything else on the account count through Apify's account figure. Before a session starts, the gate computes:

```
max(Apify account usage this cycle, this plugin's runs since the cycle start)
  + remaining planning estimate of every active plugin session
  + this session's planning estimate          must be <= RBA_MONTHLY_BUDGET_USD
```

The account figure already includes plugin runs once Apify has counted them. So taking the **max**, not the sum, avoids double counting, and the local records cover runs the account figure hasn't caught up with yet. The gate also stops at Apify's own account limit. It never upgrades a plan or falls back to a paid provider.

**Session planning estimate** at the defaults (2048 MB, `RBA_MAX_SESSION_MINUTES=10`, `RBA_APIFY_CU_PRICE_USD=0.2`):

| Component | Amount | Bounded? |
|---|---|---|
| Compute: 2 GB × (10 + 1 min run timeout) × $0.20/CU | **$0.073** | Yes. Apify's run timeout and the fixed memory bound it, assuming the $0.20/CU price. |
| Residential reserve: 0.02 GB × $8/GB (residential sessions only) | **$0.16** | **No.** It's a *reservation*. A 60 s sweep stops the session once Apify *reports* more traffic than that, and Apify's figure lags, so real traffic can exceed it. |
| External data transfer ($0.20/GB observed), internal transfer ($0.05/GB), key-value store operations ($0.000005 per read, $0.00005 per write) | usually < $0.001 | No (not capped) |

So a direct or datacenter session is planned at about **$0.073** and a residential one at about **$0.233**. These are planning estimates, not worst-case bounds. The $0.20/CU and $8/GB rates are what Apify billed this free-plan account (from each run's `usageUsd`, October 2026); check your own plan.

**Cost labels** (`usage_report`, dashboard):
- `provider_preliminary`: Apify's figure while the run is active or less than 10 min after it ended. It was observed to rise later (from $0.00005 to $0.00507).
- `provider_reconciled`: Apify's figure as last re-read at least 10 min after the run ended. `detail.reconciledAt` records when. Apify gives no "final" signal, so charges can still change:
  - `usage_report` re-reads every run of the current cycle whose last reconciliation is older than 6 h.
  - Earlier figures are kept in `detail.history`.
- `estimate`: runtime × memory × `RBA_APIFY_CU_PRICE_USD`. The budget counts a preliminary run as max(preliminary figure, estimate).
- `counted`: local counts of MailSlurp inboxes created and unique messages received. MailSlurp spend isn't available through this integration.

`usage_report` returns the billing window, this plugin's runs split into reconciled and preliminary (with `lastReconciledAt`), the account figure, `notPluginUsd` (account minus plugin runs: builds, fixtures, other Actors, lag), and the planning estimates.

## Safety boundaries (by design)

- No CAPTCHA solving or bypass, and no stealth or anti-detection features.
- No automatic replacement of accounts or proxies after a block. Blocked accounts are quarantined until you lift it.
- No Google account creation. Existing dedicated Google accounts can be added, and interactive challenges are reported as `interactive_login_challenge`.
- No fabricated identities for getting around a site's limits. `synthetic: true` is only for targets you authorised for testing.
- No anonymity claims: proxy routes are verified by IP comparison only, and sticky sessions don't guarantee the same IP.
- No arbitrary JavaScript or shell tools.

## Known limitations

- **Live-tested scope:** see `docs/LIVE-RESULTS.md`. Website-generated verification email was proven only against **our own controlled fixture** (`fixture-actor/`, a test site hosted as a private Apify Actor that delivers mail over SMTP to MailSlurp's MX on port 2525). No third-party site that sends verification email was tested. Passing tests are not evidence that arbitrary sites accept these signups or emails, that the browser is undetectable, or that no traffic can leak outside the policy.
- **Third-party signup compatibility (2026-10-27, build `0.1.0+7b11081`):** see [docs/evidence/signup-compat-2026-10-27/](evidence/signup-compat-2026-10-27/README.md). Only automationexercise.com completed the full lifecycle, including deletion, with no intervention. practice.expandtesting.com needed an operator to lift a falsely triggered quarantine. parabank.parasoft.com blocked the first submission (HTTP 403) and passed only after a user-approved retry through a residential proxy. Two test accounts remain on those sites, plus one of unknown status.
- `config_check` does not report the navigation allowlist (`RBA_ALLOWED_ORIGINS`), only the signup targets.
- `account_register` matches `rejectionTexts` against the whole page after submit, so a word in the page's own static text can mark a successful signup as rejected and quarantine the account.
- There is no credential reference for usernames: `browser_fill` secrets cover `account_email` and `account_password` only, so usernames are filled as plain values.
- Off-platform, the worker refuses Apify Proxy (the SDK returns a proxy URL with an `undefined` password). Proxy modes only work on Apify itself or with the test-only proxy override.
- A stale holder's remote browser is stopped once its lease lapses, at the next sweep (every 60 s) or the next start of that account. Until then a crashed orchestrator's browser keeps running for at most `RBA_IDLE_TIMEOUT_SECS`.
- Element targeting uses the main frame only.
- Saved read operations (optional, `RBA_OPERATIONS_ENABLED`) are private by default and never leave the install. An account operation is bound to its account, target origin and route, and its account-specific literals are stored only as encrypted references. A public operation that would hold a private-looking literal is refused. Spec export and cross-account reuse are disabled. Detection can miss short plain-word identifiers. See [docs/OPERATIONS.md](OPERATIONS.md).
- Proxy modes: the worker still resolves hostnames from the container for its policy checks, so DNS lookups of target hosts leave from Apify's resolver, not through the proxy. The egress check compares IPs; it is not a full leak test.
- Verification links on click-tracking domains (such as an email provider's redirector) are rejected unless that domain is added to the target's auth origins.
- If you open a session started by another Claude session, your process doesn't take ownership of it. It renews the lease on each call but doesn't close the session on exit.
- An account crawl that is re-attached after an orchestrator restart fails once its lease has lapsed. Results saved up to that point are kept.
- MailSlurp quota: the local caps count unique received messages (by message id, the provider's unit) and inbox creations, atomically. They are a lower bound of provider usage (mail never listed by the plugin isn't seen). MailSlurp's own limits are reported separately (`details.source: provider`).
- Verification codes of 4+ characters are added to the redaction list; a registered code can also hide an identical number elsewhere in later output of the same process.
- Cost figures are Apify's, re-read over time (`provider_preliminary`, then `provider_reconciled` with a timestamp). Neither is a final bill. The residential reserve isn't a hard cap, and data transfer and storage operations aren't capped.
- Cancelling a job while a worker command is in flight leaves that command to finish on the worker (bounded by its own deadline); the session and its lease stay held until the session closes.
