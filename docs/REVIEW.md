# Critical review report

**Scope.** Commit `d137dd8`, the first complete implementation. A separate reviewer agent read the code without editing it. It ran the unit tests (30 passed) and worker tests (96 passed), and drove the built stdio MCP server, which listed 26 tools. It also ran `claude plugin validate .` (passed) and checked the Apify, MailSlurp and Claude Code docs. Fixes landed in commit `a7875fd`. After the fixes, the full fixture run is 157 passed: 30 unit, 97 worker, 30 integration.

**Status.** Fixed means the code changed and a test covers it. Documented means not fixed; the gap is listed in README "Known limitations".

| # | Sev. | Location | Defect | Status | Fix / coverage |
|---|---|---|---|---|---|
| 1 | High | `src/core/jobs.ts` | A cancel from another process (the dashboard, a second MCP server) only wrote `cancelled` to the database. The owning process kept running, could click submit, and kept crawls billing. | Fixed | The owner polls `cancel_requested` every second and aborts. `assertNotCancelled` runs right before the signup submit. A cancel only marks the job `cancelled` directly when the owning process is dead. Test: *a cancel requested by another process (DB flag only) stops the running job*. |
| 2 | Med-high | `src/core/signup.ts`, `accounts.ts` | A submit failure other than timeout left the account in `registering`, which couldn't be leased, so the account couldn't be recovered. | Fixed | Any failure after the submission marker sets `unknown` (never resubmitted). `registering` can now be leased so an attempt can resume. Test: *a failed submit click never leaves the account stuck…*. |
| 3 | Medium | `src/mcp/tools.ts` | `email_wait_for_verification` without `followInSessionId` marked the email consumed but threw the link away, so the verification was lost. | Fixed | The email is recorded as `unfollowedEmailId` and not consumed until its link is followed. The response explains how to follow it. |
| 4 | Medium | `redact.ts`, `actor/src/netpolicy.ts`, `errors.ts` | One-time tokens in URL **paths** (`/confirm/<token>`) leaked into responses, job records and worker logs. Playwright error text carried full URLs. | Fixed | `scrubPath` hides token-like path segments, and `scrubUrlsInText` cleans worker error messages. Tests: core `redaction` and worker `URL scrubbing for logs`. |
| 5 | Medium | `sessions.ts`, `usage.ts` | Race between the concurrency/budget check and the session insert: parallel starts could both pass. | Fixed | Gate, lease and insert run in one re-entrant `BEGIN IMMEDIATE` transaction. Test: *parallel starts cannot exceed the concurrency limit*. |
| 6 | Medium | `usage.ts` | Residential proxy cost wasn't reserved, and the compute worst case ignored the +60 s run timeout and startup time. | Fixed (enforcement may lag) | Worst case is now minutes + 2, plus `RBA_RESIDENTIAL_RESERVE_GB` × price for residential sessions. The 60 s sweep stops a session whose Apify-reported residential GB exceeds the reserve; Apify's figure may lag mid-run, so this is not a hard real-time cap. Unit test: budget controls. |
| 7 | Med-low | `tools.ts`, `config.ts` | A lowercase or invalid country code made every worker start fail, at a cost each time. | Fixed | Validated as two letters and upper-cased in tools, config and accounts. |
| 8 | Medium | `sessions.ts` | After an orchestrator crash, the lapsed lease was reclaimed while the old browser kept running, so two browsers could use one account. | Fixed | `reapOne` aborts runs whose lease lapsed. `start()` reaps stale holders of the account first. Test: *stops a stale holder (lapsed lease)…*. |
| 9 | Medium | `apify.ts`, `sessions.ts` | The run id was only saved after the run became ready, so a crash during startup orphaned a billable run. | Fixed | The `onRunCreated` callback saves the run id right after the API accepts the run. |
| 10 | Medium | `mcp/index.ts`, `sessions.ts` | An exiting MCP process closed sessions it had only looked at, which belonged to another conversation. | Fixed | An `owned` set: shutdown and heartbeat only touch sessions this process started. |
| 11 | Low-med | `sessions.ts` | Quarantine didn't stop an already-open session. | Fixed | Every command calls `assertUsable`, and a start with an existing `leaseId` is checked too. Test: *quarantine stops further commands…*. |
| 12 | Low | `tools.ts` | A verification code from one account's job could be typed into another account's session. | Fixed | The job's account must match the session's account. Same test as 11. |
| 13 | Low | `config.ts` | Worker memory wasn't checked to be a power of two, so a bad value failed every start. | Fixed | Validated in the config loader. |
| 14 | Low | `actor/src/browser.ts` | A page script that hangs `evaluate` holds the worker's command lock until the session ends. | Fixed (round 2) | Per-command deadline; page closed to cancel, lock released only after the op settles; worker terminates if it can't. Orchestrator aborts the run before releasing a lease on no answer. Tests: worker *a hung page…*, integration *a command with no answer…*. |
| 15 | Low | `actor/src/browser.ts`, README | A redirect to a disallowed *public* origin is fetched once before it's discarded. The README overstated per-hop coverage. | Fixed (round 2) | CDP `Fetch` per-hop document guard refuses the hop before it is sent; popups refused before their first request. Tests assert zero requests at the destination (1 and 2 allowed hops, click via redirect, popups). |
| 16a | Low | `mailslurp.ts` | `listEmails` only read the first 50 messages. | Fixed | The `since` cursor pages forward, with a guard against spinning on identical timestamps. |
| 16b | Low | `tools.ts` | MailSlurp email quota is only checked when a job starts. | Fixed (round 2) | Checked for every newly received email in both wait paths. Residual: `email_search` records but does not enforce the quota (read-only). |
| 16c | Low | `redact.ts` | Codes shorter than 6 digits aren't added to the redaction list. | Fixed (round 2) | Codes of 4+ chars are registered (also in `email_wait_for_verification`, which previously registered none). May over-redact an identical number later in the same process. |
| 16d | Low | `verification.ts` | Verification links on click-tracking domains are rejected. | **Documented (by design)** | Add the tracking domain to the target's auth origins if it's trusted. |

## Areas the reviewer found clean

- **Dashboard:** Host and Origin checks, CSRF, `SameSite=Strict` cookie, HTML escaping, path-safe downloads.
- **No local traffic to target sites:** there is no local browser and no direct fallback in proxy modes, and proxy egress fails closed.
- **`browser_upload`:** realpath plus root-prefix check, regular-file check, size limits on both sides, sha256 match, file-input target only.
- **Secret typing:** the origin check is bound to the element handle inside the worker command.
- **IPv4/IPv6 tricks:** handled. Teredo is the only small gap.
- **Polling and wait loops:** all bounded.
- **Provider APIs:** MailSlurp endpoints match its OpenAPI spec. Apify `/v2/actors/...` paths and run fields match the current docs.

## Found during implementation (before the review)

- **Redirect hops:** Playwright's `context.route` is not called for Chromium redirect hops (tested). This is why the worker routes all browser traffic through its in-process policy proxy.
- **Proxy off-platform:** the Apify SDK returns a proxy URL with the literal password `undefined`. The worker now treats that as `proxy_unavailable` (fail closed).
- **Test timeouts:** the long integration-test timeouts came from the host Mac sleeping (the `pmset` log shows sleep and dark-wake cycles), not from the code. Run tests under `caffeinate -dimsu`.

## Round 2 (2026-10-09): fixes before live account testing

| # | Sev. | Location | Defect | Status | Fix / coverage |
|---|---|---|---|---|---|
| R1 | Medium | `actor/src/blockdetect.ts` | Script presence alone (e.g. invisible reCAPTCHA) was reported as `captcha` and quarantined the account. Seen live on BrowserScan and, after the fix, confirmed on Automation Exercise's `/login` (hidden reCAPTCHA frame). | Fixed | Three outcomes: `integrations` (never a block), `challenge_required` (visible widget/challenge page/short-page phrase), `access_denied` (403/429, wording says nothing about mechanism). Tests: worker *integration, not a block*, integration *does not quarantine*. |
| R2 | Low | `src/core/sessions.ts` | `session_close` released the lease even if aborting the run failed. | Fixed | Lease kept until the run is confirmed stopped; reaper finishes later. |
| R3 | Low | `src/core/sessions.ts` | `session_save_state` returned `cookies: "[REDACTED]"` (a count hidden by key-name redaction). Found live. | Fixed | Renamed `cookieCount` / `originCount`. |
| R4 | Feature gap | `signup.ts`, `tools.ts` | Multi-page signup forms (Automation Exercise) could not be expressed. | Added | `fields` accept `select` and `click` steps; only `submitSelector` marks the submission. Test: *multi-page signup*. |
| R5 | Feature gap | `tools.ts` | No way to verify reception of a non-verification message. | Added | `email_search` (read-only, URLs reduced, untrusted). |
| R6 | Ops | `apify.ts`, `config.ts` | Could not pin an Actor build (needed for the live regression check of the-internet timeouts). | Added | `APIFY_ACTOR_BUILD`. |

Remaining after round 2: in-flight worker commands continue after a job cancel (lease stays held, so no cross-holder mutation); frames may load non-allowlisted public origins (documented policy); DNS lookups in proxy modes go from the container; JS dialogs can't be accepted; website-generated verification email not live-tested. Full suite after round 2: 164 passed (30 unit, 100 worker, 34 integration). Live results: `docs/LIVE-RESULTS.md`.

## Round 3 (2026-10-10): remaining gaps

| # | Sev. | Location | Defect | Status | Fix / coverage |
|---|---|---|---|---|---|
| R7 | Medium | `actor/src/browser.ts`, `validate.ts`, `tools.ts` | No way to handle `confirm()`/`prompt()`; every dialog was silently dismissed. | Fixed | Action-scoped `dialog` policy on click/navigate: one dispatcher per page, dismiss by default, handled within 5 s, policy removed after the action; prompt text never logged or echoed back. Tests: worker *dialogs…*, integration *confirm-gated submit*. |
| R8 | Medium | `actor/src/crawl.ts`, `src/core/crawl.ts` | A hung crawl page had no deadline; cancel did not stop the upstream request. | Fixed | Per-page and whole-crawl deadlines; fresh page per URL; cancel/deadline close the page; orchestrator watchdog. Tests: cancel during hanging navigation (worker and MCP: job cancelled, session closed, run stopped, lease released, request aborted at the destination), whole-crawl deadline, per-page deadline on a hung renderer. |
| R9 | Medium | `actor/src/policyproxy.ts` | When the browser abandoned a plain-HTTP request, the proxy kept the upstream request running. Found by the cancel test. | Fixed | Upstream destroyed on client close. |
| R10 | High | `netpolicy.ts`, `policyproxy.ts`, `browser.ts`, `config.ts` | Only main-frame navigation was origin-restricted; resources could go to any public origin; `RBA_ALLOWED_ORIGINS` defaulted to `*`. | Fixed | Resource allowlist (navigation + `RBA_SUBRESOURCE_ORIGINS` + egress-check origin), enforced before requests in the route handler, the document guard, the WebSocket guard and the proxy (host:port). Navigation default is empty. Test: zero requests at a disallowed origin across 16 request kinds; a configured resource origin is reachable but not navigable. |
| R11 | Medium | `usage.ts`, `tools.ts`, `signup.ts` | `email_search` counted reads; check and record were separate (racy); local and provider limits were indistinguishable. | Fixed | `admitEmail` counts unique message ids in one IMMEDIATE transaction for every retrieval tool; inbox creations are reserved before the provider call and released on failure; `details.source` = local or provider. Unit and integration tests. |
| R12 | Medium | `usage.ts`, `config.ts`, `.env` | Budget used provider preliminary figures (observed too low); strict limits existed only in the test process. | Fixed | Preliminary runs count at max(preliminary, estimate); report splits reconciled from preliminary (terminology corrected in round 4); conservative defaults in code, `.env.example` and the user's `.env` (backup `data/.env.bak-before-budget`). |
| R13 | Low | `browser.ts`, `tools.ts` | No visibility into why a page never finishes loading. | Added | `/diagnostics` + `session_network_log`: proxy connection timings (host/port only), refused hosts from every layer, pending and recent page requests (scrubbed URLs). Used to diagnose the-internet (site-side 503s after ~30 s). |
| R14 | Medium | `actor/src/browser.ts` | The egress-check origin (api.apify.com) stayed an allowed resource origin and its URL stayed exempt for the whole session. Found in final review. | Fixed | Exemption and origin removed right after the init-time IP check unless configured. Test: *after init, pages cannot reach the egress-check endpoint*. |
| R15 | Low | `usage.ts`, `mcp/index.ts` | An inbox reservation orphaned by a crash would hold a quota slot forever. | Fixed | Startup sweep deletes reservations older than 10 min. Unit test. |
| R16 | Low | `sessions.ts`, `config.ts` | Session view showed only the extra resource origins; `config_check` didn't flag the new empty navigation default. | Fixed | Effective list (navigation + extras) in the view; `browse_without_account` capability in `config_check`. |

Remaining after round 3:
- In-flight worker commands finish on the worker (bounded by their deadline) after a job cancel.
- DNS lookups in proxy modes leave from the container.
- Plugin/PDF-viewer subrequests and Chromium-internal traffic aren't separately tested (they still pass the proxy's host check).
- Third-party website-generated verification email isn't tested; only the controlled fixture was.
- Cost labels: see round 4.

Full suite after round 3: 179 passed (33 unit, 107 worker, 39 integration).

## Round 4 (2026-10-10): cost claims, terminology, inbox recovery

| # | Sev. | Location | Defect | Status | Fix / coverage |
|---|---|---|---|---|---|
| R17 | Medium | `usage.ts`, README | "One session's worst case is about $0.12" was wrong. It used $0.30/CU, but Apify billed $0.20/CU; it used minutes + 2 instead of the run timeout; and it treated the residential reserve (0.02 GB × $8 = $0.16) as if it were bounded. It is a reservation enforced by a lagging 60 s sweep. | Fixed | `sessionEstimate()` returns compute (bounded by the run timeout, minutes + 1) and the residential reserve (not a cap) separately; named "planning estimate", never "worst case". CU default 0.2 (provider-observed); `.env` updated (backup `data/.env.bak-before-cu-price`). |
| R18 | Medium | `usage.ts`, `apify.ts`, `sessions.ts`, dashboard | "Settled"/`measured` implied final charges. Reconciled runs were never re-read. | Fixed | Bases are now `provider_preliminary` and `provider_reconciled` (old rows migrated). Each run keeps `reconciledAt` and `history`. Reconciled runs of the current cycle are re-read every 6 h. Unit tests: history/re-read, migration. |
| R19 | Medium | `usage.ts` | The budget mixed calendar-month local sums with Apify's billing-cycle account figure, and its scope (plugin or account) was undefined. | Fixed | Scope = whole Apify account, current billing cycle. Gate = max(account, plugin runs since cycle start) + active-session estimates + new estimate (max, so no double counting). Unit test: scope/no double counting. |
| R20 | Medium | `usage.ts`, `signup.ts`, `mcp/index.ts`, `mailslurp.ts` | A stale-reservation sweep released the slot and forgot an inbox MailSlurp may already have created; a `createInbox` error was treated as "not created". | Fixed | Reservation tag on the inbox. On error: look up by tag → adopt / release only if confirmed absent / keep. Startup recovery deletes a found orphan inbox (slot stays counted), releases only when confirmed absent, defers when MailSlurp is unreachable. Inbox record and account link are written in one transaction. The client filters on each inbox's own tags (the server-side `tag` filter couldn't be verified with 0 inboxes). Unit test (three outcomes) + integration test (created-then-500 → adopted, no second inbox). |

Full suite after round 4: see the commit message for counts.

## Round 5 (2026-10-12): file handling — independent review

A separate reviewer agent read `git diff 3ba0863..HEAD` without editing and probed the built code. Findings and fixes:

| # | Sev. | Defect (reviewer) | Status | Fix / test |
|---|---|---|---|---|
| F1 | High | JPEG COM/APPn segments after the first SOS were copied through and still verified (confirmed: secret survived, `verified_for_policy`) | Fixed | Scan walker records APPn/COM after SOS; inspect reports them; rewrite skips them. Test: *COM/APP segments placed after the image data are found and removed*. |
| F2 | Medium | PNG/WebP unknown ancillary chunks (e.g. C2PA `caBX`) kept with a verified verdict (confirmed) | Fixed | Unknown ancillary chunks removed and named; unknown critical chunks refused; C2PA (`caBX`, WebP `C2PA`, JPEG APP11 JUMBF) needs `allowRemoveContentCredentials`. Test added. |
| F3 | Medium | PDF revision-property scan O(refs × size), synchronous (confirmed: 7.8 s at 20k refs) | Fixed | Bounded: ≤16 refs, substring search, 64 KB window, computed once. Test: 20k refs < 1.5 s. |
| F4 | Medium | PDF verify decoded every Flate stream fully (confirmed: +670 MB RSS) | Fixed | `inflateSync` with `maxOutputLength` (8 MB/stream, 64 MB total), scanned and discarded; skipped streams reported. Test: 96 MB bomb, RSS delta < 200 MB. |
| F5 | Medium | Parent-directory symlink race; hard links pass | Fixed (narrowed) | Hard links refused; post-open realpath + dev/ino re-check. Residual race documented. Test: hard link refused. |
| F6 | Medium | portal_upload marked "sent" only after `/upload`, though selecting can transmit | Fixed | Marked before selection; withdrawn only on a worker refusal before selection. Test: wrong selector → retry allowed; timeout case keeps the mark. |
| F7 | Low/Med | Retained JPEG trailing data / AV artwork could carry GPS yet verify | Fixed | Retained trailing bytes → residual (verdict ≤ partial); artwork extracted and run through the image inspector, identifying fields → residual. Tests added. |
| F8 | Low | Lock TTL (15 min) shorter than a worst-case PDF verification | Fixed | TTL = max(15 min, 60 × tool timeout). |
| F9 | Low | `requireTools` unused; doctor listed pdftocairo; pdfsig failure treated as unsigned | Fixed | Required tools checked per policy before work; doctor lists pdftoppm; an inconclusive pdfsig (or a signature found in the parsed object graph) requires `allowInvalidateSignatures`. Also found while fixing: pdfsig exits 2 with its answer on stdout; the runner now keeps a path-cleaned stdout tail. |
| F10 | Low | Absolute paths (username) in tool error text and stored reports | Fixed | Runner reduces paths to file names. Test added. |
| F11 | Low | `/Metadata` inside nested direct dictionaries not removed | Fixed | Recursive scrub of direct dicts/arrays. Test added. |

Also fixed during this round (found by tests): an O_RDONLY open of a FIFO in an import root blocked the server (now O_NONBLOCK); portal_upload's in-job re-check matched its own job as a "repeat"; the real-process cancellation test initially used a process that finished before the abort (now paced with `-re`). Test runs no longer leave `rba-*` temp directories behind (global teardown).

Full suite after round 5: 237 passed.
