# Live test results — 2026-10-09

All browser work ran on Apify (worker Actor `waxen_pumpkin_jnu~remote-browser-worker`, build 0.1.3 / `7mn96qidyeYsnAtb3`) through the plugin's MCP tools. A local bridge kept one MCP server process alive between calls; the final smoke test used the **installed** plugin from a fresh `claude -p` session. Limits for the run: 1 concurrent session, 8 min per session, local budget $0.58 (= Apify-reported $0.0795 at start + $0.50). No secrets appear below; IDs are Apify run IDs and local session/account IDs.

## Results

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Practice instructions read remotely (`/test_cases`, Test Case 1 "Register User" incl. Delete Account) | Passed | run `pssHsESe7cg5vo8jM`; canonical origin `https://automationexercise.com` (no redirect) |
| 2 | Signup A through the UI (`account_register`, two-page form, select/radio steps, one final submit, own MailSlurp inbox, synthetic identity "RBA Test A 3202f5") | Passed | job `job_c7ee1e8861634720`, run `5jjFX0gXcQWoWCeQS`; "Account Created!" found |
| 3 | Logged-in evidence in the original session | Passed | nav shows `Logged in as RBA Test A 3202f5`, `Logout`, `Delete Account` |
| 4 | Save state → close → original worker terminated | Passed | Apify run `5jjFX0gXcQWoWCeQS` status `SUCCEEDED`, finishedAt 19:11:52.6Z (the worker exited on `/shutdown` at close, before the abort call); lease released |
| 5 | **Restore** in a fresh worker (no fill/click before checking) | Passed | run `eaqbx9NdSxvCnRZe8`, `restoredBrowserState: true`, `Logged in as RBA Test A 3202f5`; zero fill/click calls in that session |
| 6 | Second account B + isolation | Passed | B's session shows only `Logged in as RBA Test B 437228` (A's name absent); saved states share **no** site cookie value (`sessionid`, `csrftoken` hashes differ) |
| 7 | Restore B in a fresh worker, logout, **explicit login** with stored email/password by reference | Passed | run `Jop4vGR8fCHm9WFZ0`; logged in → "Signup / Login" after logout → `Logged in as RBA Test B 437228` after login |
| 8 | Delete B and A through the site UI | Passed | "ACCOUNT DELETED!" for both; login afterwards: "Your email or password is incorrect!" (runs `Jop4vGR8fCHm9WFZ0`, `GrZKVk6KU8LmEsjUU`); screenshot `data/artifacts/shot_e9aa78e746c44b3c.png` |
| 9 | Local cleanup | Passed | `account_delete` ×2 with inbox deletion; `account_list` empty; MailSlurp `GET /inboxes/count` → 0 |
| 10 | Upload to the-internet `/upload` | **Blocked — cause undetermined** | Page never reached DOMContentLoaded from the worker within 30 s on direct, datacenter and residential routes, and also with the previous build 0.1.2 (run `ajnVozCHBoBzh8fZx`), so not a regression; one attempt eventually showed HTTP 500 with an empty title. A different client (Apify web-fetch) got HTTP 200 (its response carried an "unblocker route" header; a plain fetch was not tried). Not worked around. Next action: retry later; if it persists, test a non-AWS egress or capture the worker's network timing for that host. |
| 11 | Remote upload (substitute: Automation Exercise Contact Us, published Test Case 6) | Transfer: **Passed**. Displayed result: **Blocked** | 630-byte synthetic PDF, sha256 `923cc231…1fd8` recomputed by the worker from received bytes; file input `hasValue: true`. The form's submit is gated by `confirm()`, which the worker dismisses, so no site-side result page. Next action: add an explicit dialog policy to the worker, redeploy, retest (~$0.005). |
| 12 | Structured extraction | Passed | 34 products (name, price, detail URL) from `/products`; saved `data/results/extract_c0755f0cdb324b5e.json` |
| 13 | Bounded crawl | Passed | job `job_c3e8cca8b0134f0f`: 5 pages (limit), depth ≤ 1, 30 still queued, titles/prices extracted |
| 14 | CAPTCHA false positive | Passed | Automation Exercise `/login` contains a hidden reCAPTCHA frame: reported as `integrations` (`hidden frame (www.google.com)`), `blocked: null`, no quarantine. The old detector would have flagged `captcha`. |
| 15 | Email: inbox provisioning | Passed | 2 inboxes created and deleted |
| 16 | Email: **real message reception** | Passed | MailSlurp inbox B → inbox A, subject/body tag `rba-corr-7f998dad38`; `email_search` returned recipient = A, sender = B, tag in subject and body, link query removed |
| 17 | Email: verification-link parsing on a real delivered message | Passed | tag `rba-corr-4031aeecca`: chose `https://automationexercise.com/verify-email?[query]`, ignored decoy `evil.example`, token not returned, link not opened. The first message (`/?rba=…`) was correctly rejected as "no verification link". |
| 18 | Email: actual website-generated signup verification | **Blocked** | The authorised practice target sends no verification email. Next action: authorise a target that does, then run `account_register` with `verification` left required. |
| 19 | Proxy route: datacenter | Passed | browser 198.46.150.17 ≠ container 18.206.81.203 |
| 20 | Proxy route: residential (US) | Passed | browser 23.27.93.233 ≠ container 18.206.81.203 |
| 21 | Proxy fail-closed | Passed | datacenter + country `AQ`: worker `egress_unverified` (502), session `failed`, run `AI2mcLs3CQFOA52rx` ABORTED after 3 s, log shows only health + refused init (no navigation) |
| 22 | Installed plugin, fresh session | Passed | `claude plugin list`: enabled, read from this directory; `claude mcp list`: connected; `claude -p` listed 27 tools, `config_check` no missing names, session → `/products` 200 → close ($0.00119 preliminary) |

## Networking notes

The IP comparison shows the browser's exit IP differs from the container's; it is not a full leak test. Not covered live: WebRTC (Chromium is started with non-proxied UDP disabled), and DNS — in proxy modes the worker still resolves target hostnames from the container for its policy checks.

## Spend

| Source | Figure |
|---|---|
| Apify account, start of this run | $0.0795 |
| Apify account, after live tests (before the installed-plugin smoke session) | $0.1649 (+$0.0854; may include the one Apify web-fetch diagnostic run if that connector uses the same account) |
| Apify account, final (after the smoke session) | $0.1721 (+$0.0926 for this whole run) |
| Sum of this run's 12 sessions (local records) | $0.0905 — 5 `measured`, 7 `measured_preliminary` |
| Ceiling | $0.50 additional — not approached |

Preliminary figures read at `session_close` were lower than the later figures (e.g. run `eaqbx9NdSxvCnRZe8`: $0.00007 at close → $0.00292; `GrZKVk6KU8LmEsjUU`: $0.00005 → $0.00428). Apify finalises run usage some time after the run ends; `usage_report` re-queries runs still marked preliminary.

## MailSlurp 90 vs 100

`RBA_MAILSLURP_MAX_INBOXES_PER_MONTH=90` is this plugin's own configured cap (default and `.env`), set 10% under MailSlurp's published free-plan figure of 100 inbox creations per month. Account-level evidence: `GET /user/info` → `subscriptionType: null` (no paid subscription), `GET /inboxes/count` → 0 after cleanup. The MailSlurp endpoints tried (`/user/plan`, `/user/usage`, `/limits`, `/user/limits`) do not exist, so the plan quota itself could not be read from the account; the 100 comes from MailSlurp's pricing page, not from the API.

## Site footprint and configuration

- Automation Exercise: two synthetic accounts (A, and B for the isolation proof), both deleted through the site UI with login failure confirmed; one step-1 "Signup" submission with a reserved `.invalid` address to read the step-2 selectors (renders a form, creates no account); one Contact Us form filled with synthetic text and a file but **not** submitted (dialog dismissed).
- `.env`: exactly two lines changed (`RBA_AUTHORIZED_TARGETS=https://automationexercise.com`, `RBA_ALLOWED_ORIGINS=https://automationexercise.com,https://the-internet.herokuapp.com`); `RBA_ALLOW_PRIVATE_HOSTS` left empty; backup `data/.env.bak-before-practice-targets` (mode 600).
- Budget limits were process environment for the test bridge only (`RBA_MONTHLY_BUDGET_USD=0.58`, `RBA_MAX_CONCURRENT_SESSIONS=1`, `RBA_MAX_SESSION_MINUTES=8`, `RBA_RESIDENTIAL_RESERVE_GB=0.01`); `.env` keeps its defaults. No Apify or MailSlurp account settings were changed.
- Redirect-hop blocking, popup blocking and hung-command recovery were verified with controlled local fixtures (as required), not against public sites.

---

# Round 2 — 2026-10-10

Worker builds: 0.1.4 `fxeQ1ltOrC36v07lf` for test 1 and the first the-internet attempt; 0.1.5 `ElZnKHMSaDNFcbxAU` (adds request diagnostics) for tests 2–7; 0.1.6 `DoLqlyytVKgEFhTxk` (egress-check exemption ends after init) for test 9. Fixture Actor `waxen_pumpkin_jnu~rba-practice-fixture` build `xhkQm5SUIE07xqamy`. Limits were the persisted `.env` values ($1.00 budget, 1 session, 10 min). The only test-process overrides were the fixture's temporary origin in `RBA_AUTHORIZED_TARGETS` / `RBA_ALLOWED_ORIGINS`.

| # | Test | Scope | Result | Evidence |
|---|---|---|---|---|
| 1 | Automation Exercise under the strict resource policy (no extra origins) | public site | Passed | run `kNjtIGoIkfgd8HQRf`: `/`, `/login`, `/products` all 200, blocked: null. Refused (not needed): `fonts.googleapis.com`, `static.cloudflareinsights.com`, `pagead2.googlesyndication.com`. `RBA_SUBRESOURCE_ORIGINS` left empty. |
| 2 | the-internet timeout diagnosis (bounded: 2 navigations + 1 instrumented) | public site | Diagnosed | TLS tunnel connect 3 ms, first byte 7 ms, ~600 KB received. Request log: `foundation.js`, `foundation.alerts.js`, `dropzone.js`, a vendor script and an image each returned **HTTP 503 after ~30 s** from the site's server (Heroku router timeout). They are parser-blocking, so DOMContentLoaded misses Playwright's 30 s timeout. Other assets came in 34–72 ms. Cause is site-side; why the server times out on those files for this client is not determined. |
| 3 | Upload on the-internet | public site | Passed (name only) | run `gUyqVsbDKtXPX7Qno`: worker sha256 match (630 B), page "File Uploaded!" + `rba-synthetic-test.pdf`. The site does not display size or hash. |
| 4 | Upload end to end: local file → worker → destination bytes | controlled fixture | Passed | run `WUyD5PQU88qv4Yf9r`. Local 630 B / `923cc231…1fd8`. Worker 630 B, same hash. Fixture's received-file echo: 630 B, same hash. |
| 5 | Registration → site sends email → plugin retrieves it → follows link remotely → account verified | controlled fixture | Passed | job `job_183e8b85fbb942aa` (run `FqpaWmVpnEF0vPVAS`). The fixture delivered over SMTP to `mxslurp.click:2525` (221). Port 25 to both MX hosts timed out from the Apify container. Email accepted, link followed → `/account` showed "Email verified: yes"; account `active`, `verifiedAt` set. The submit click hit its 30 s timeout while the fixture tried port 25; the job correctly went "outcome unknown → check inbox, no resubmit". |
| 6 | New worker restores the verified login | controlled fixture | Passed | run `agXfd5FSe7ke1Uk5s`, `restoredBrowserState: true`, `/account` → "Logged in as RBA Fixture 56c536 (…)", "Email verified: yes"; no fill/click in that session |
| 7 | Same flow via Apify `send-mail` | controlled fixture | Failed (documented) | `send-mail` refuses non-owner recipients ("Users can only send an email to their own email address"). Replaced by direct SMTP. That attempt's account and inbox were deleted. |
| 8 | Cleanup | — | Passed | local accounts 0; MailSlurp `/inboxes/count` 0; fixture runs aborted (fixture accounts are in memory only) |
| 9 | Automation Exercise signup under the **strict** resource policy, then UI delete | public site | Passed | job `job_22b0b94c2a57462e`: two-page form, "Logged in as RBA Strict d0b26f" while fonts/analytics/ads were refused; "ACCOUNT DELETED!", login afterwards "Your email or password is incorrect!"; local record and inbox deleted |

**Spend, round 2:** Apify account $0.1721 → **$0.2384** (+$0.0663: 3 worker builds, 3 fixture builds (1 failed), 2 fixture runs, 1 `send-mail` run, 7 sessions). Local view at the end: provider-reconciled $0.1903 (25 runs); 1 preliminary run reported $0.00005, counted for the budget at $0.0075 (runtime estimate). On a later re-read that run had risen to $0.00507.

**Not tested live this round:** dialogs, subresource-policy zero-request proof, crawl deadlines and cancel. These are fixture-tested only.

---

# Cost reconciliation — 2026-10-10 (Apify cycle starting 2026-10-09)

All figures are read from the Apify API: `/users/me/usage/monthly`, each run's `usageTotalUsd`/`usageUsd`, each build's `usageTotalUsd`. They are provider figures that can still change.

| Item | Count | USD |
|---|---|---|
| Account total for the cycle (`/users/me/usage/monthly`) | | **0.24344** |
| `remote-browser-worker` runs (plugin sessions + live-check) | 26 | 0.19537 |
| `rba-practice-fixture` runs (test site) | 2 | 0.00317 |
| `apify/send-mail` run (failed attempt) | 1 | 0.00016 |
| `remote-browser-worker` builds (Docker) | 6 | 0.04291 |
| `rba-practice-fixture` builds (1 failed) | 3 | 0.00107 |
| **Explained** | | **0.24268** |
| **Unexplained** | | **0.00076** (0.3%; not attributable to a listed run or build) |

The diagnostic `apify/web-fetch` call made earlier is not in this account's run list: it ran under the Claude connector's own Apify account.

**Account by service:**

| Service | USD |
|---|---|
| Compute units | 0.21557 |
| Residential proxy (0.0029 GB × $8/GB) | 0.02319 |
| External data transfer | 0.00251 |
| Key-value store writes | 0.00145 |
| Internal data transfer | 0.00058 |
| Key-value store reads | 0.00015 |

**Plugin vs provider:**
- All 26 worker runs are tracked locally, with no extra or missing runs.
- Local records totalled $0.19035 against Apify's $0.19537. The whole $0.00502 difference is one run (`iVT7cyMyZdtsmIGfg`) last read while preliminary: $0.00005 then, $0.00507 at reconciliation.
- No `provider_reconciled` run has changed since it was reconciled.
- Residential proxy charges are inside each run's figure, and the plugin doesn't add them again.
- Builds ($0.044) and the test fixture ($0.0034) are outside the plugin's run tracking. They reach the budget through the account figure, because `RBA_MONTHLY_BUDGET_USD` applies to the whole account.

**Rates observed** (`usageUsd` ÷ `usage`):

| Item | Rate |
|---|---|
| Compute unit | $0.20 |
| Residential proxy | $8.00/GB |
| External data transfer | $0.20/GB |
| Internal data transfer | $0.05/GB |
| Key-value store read | $0.000005 |
| Key-value store write | $0.00005 |

---

# File handling — live end-to-end, 2026-10-11

Worker build 0.1.6 (unchanged; `git diff 3ba0863 -- actor/ fixture-actor/` empty). Controlled destination: the test fixture Actor's `/upload` endpoint (echoes received filename, size and SHA-256), run `QLvcPsaYa6i5Ri8p8`, origin allowed for the test process only. Direct mode (routing unchanged; residential was verified separately). Input: a synthetic JPEG with fixture EXIF/GPS/XMP/IPTC/COM/ICC/MPF metadata (no real personal data), in a scratch import root.

| Step | Result |
|---|---|
| `file_import` | `file_25248db886d7187c`, jpeg, image/jpeg, 3149 B, sha256 `ad1b6485…c8cc57`; no absolute path in the result |
| `media_inspect` | counts only: gps 4, author 3, comments 3, embeddedPreviews 3, device 2, timestamps 2, software 1, xmp 1, iptc 1; retained: orientation 6, ICC present |
| `media_sanitize` | job completed, `verified_for_policy`; output `file_d08d6afc79c1893f`, 2217 B, sha256 `f69b2742…f68f98`; checks: output_parses, dimensions_equal, icc_profile_unchanged, orientation_preserved, adobe_app14_preserved, byte_scan_clean, decoded_pixels_identical, source_unchanged — all true; `sameEngine: false` |
| `media_verify` | `verified_for_policy`, residual [], source unchanged |
| `portal_upload` (`requireSanitized: true`, selectors `#file` / `#upload-submit`, confirmation size+sha selectors) | job `job_9e1a35956c514372`, session `sess_f8be88b8c2e94254` (Apify run `w9UlGU8X55h1QxiLk`, 17.3 s): **portal_confirmed**; stages transferredToWorker, selectedInBrowser, sentToDestination, portalConfirmed all true; the portal showed `holiday-photo-clean.jpg 2217 f69b2742…` → **destination hash = sanitized output hash** (≠ original `ad1b6485…`) |
| Cleanup | both artifacts deleted; 0 artifacts, 0 temp files, 0 locked files; 0 local sessions/jobs/leases; fixture run aborted; 0 Apify runs RUNNING/READY |

Cost: worker run preliminary $0.00005 (estimate 2 GB × 17.3 s × $0.20/CU ≈ $0.0019), fixture run $0.00047; Apify account $0.24835 → $0.24866 immediately after (lags; expected ≈ +$0.0024 once settled). No builds were needed.

**Rerun on the reviewed code (commit b66fdcb), 2026-10-12:** same input, fixture run `RcaGPnZV5NF4QHvT8`. `media_sanitize` → `verified_for_policy` (all 8 checks true); `portal_upload` job `job_4daec04058bc4b00`, session `sess_b4c3b8d2ea2849ff` (Apify run `zQBr1HeXkYmLiMbBm`, 19.1 s) → **portal_confirmed**, all four stages true, portal shows 2217 B / `f69b2742…f68f98` = sanitized output (size and hash match). Cleanup: 0 artifacts, temp files, locks, sessions, jobs, leases; 0 Apify runs RUNNING/READY. Cost: worker run $0.00218 + fixture $0.00054 (Apify run figures). Both live file runs together: ≈ $0.005; the account figure ($0.24835 before the first run → $0.25117 when read) still lags.

---

# Release candidate, 2026-10-12

**Setup**

| Item | Value |
|---|---|
| Code | master `2826ef5` (all five workers merged) |
| Worker build | `wWt8kCNxCD61f1x7t`, deployed from `3637a40`; the `actor/` source is identical at HEAD |
| How tools were called | the built MCP server over stdio via `scripts/start-mcp.mjs`, through the SDK client, with the real `.env` |
| Test-process overrides | the fixture origin in `RBA_AUTHORIZED_TARGETS` / `RBA_ALLOWED_ORIGINS`, a scratch `RBA_IMPORT_ROOTS`, `RBA_OPERATIONS_ENABLED=true` |
| `.env` changes | none |

**Limits:** the persisted values ($1.00 budget, 1 session, 10 min).

**Side effect:** the user's `data/registry.sqlite` was migrated from schema v1 to v5 on the first start. This is additive (new columns and tables; no rows rewritten) and cannot be undone.

| # | Scenario | Mode | Result | Evidence |
|---|---|---|---|---|
| 1 | A: `/products` → extract 10 names/prices (saved) → close | local | Passed | `local:<pid>:<nonce>` run; route `not_checked` ("requests originate from this computer's network"); 10 items; no provider charge |
| 2 | A: same | remote_direct | Passed | run `gaZmx4Bo3lqB7lh4m`; 10 items; saved `data/results/extract_4e0b9eb1050747f1.json`; `run_report` finalized |
| 3 | F: `remote_proxy` datacenter + country `AQ` | remote_proxy | Refused (expected) | run `dt1iFkdSuUb7XMlHC`: `egress_unverified` at init; session `failed`; run aborted; 0 sessions afterwards. `remote_proxy` without `proxy.kind` was refused before any run |
| 4 | Proxy route + one page | remote_proxy datacenter | Route verified; **navigation timed out** | run `XXfd9YBl2oVZEHg4K`: egress IP ≠ worker IP; `browser_navigate` to the-internet with `waitUntil: load` timed out at 30 s |
| 5 | Retry on another practice site | remote_proxy datacenter | Route verified; **navigation timed out** | run `0V3h5UTmoJCdTnRde`: automationexercise `/products`, `load`, 30 s timeout |
| 6 | Diagnosis | remote_proxy datacenter | Page loaded | run `gVa1Y11DP5NDFYg7Y`: `waitUntil: domcontentloaded` gave HTTP 200, about 1.1 MB through the proxy. The network log shows only the policy-allowed hosts, plus blocked third-party font hosts |
| 7 | D: `operation_learn` (`/products?search={query}`, examples "top"/"dress") → `operation_review` → `operation_call` "jeans" → `operation_validate` "saree" | local | Passed | tier 1 `/fetch`; 3 jeans products returned; `valid: true`; operation deleted afterwards |
| 8 | C: import synthetic JPEG → sanitize → verify → upload | remote_direct | Passed | `verified_for_policy` with 3 retained ICC findings, so the upload needed the acceptance digest (passed only after review); job `job_2417ccc29aeb4737`, run `dQwjPuUYhRZhwcFNR` → `portal_confirmed`; the portal's size and sha256 equal the sanitized artifact; uploaded as `upload.jpg`; `run_report` finalized |
| 9 | B: register on fixture → email verify → restore in a new worker | remote_direct | Failed, then passed | First attempt (run `Pt975mKhj8AI13jip`): rejected by the fixture's recipient-domain allowlist. I had not allowed the inbox domain `sandbox.zazamail.link`. The job was correctly `failed`/`rejected`, with nothing retried. Second attempt: job `job_af15e77ea4dd4f7a` (run `p5tHiTNp5yYojURL3`) `completed`/`confirmed`; restore run `DGhVlOjpe4U1MlrrN` had `restoredBrowserState: true` and "Logged in as … / Email verified: yes" with no fill or click; `account_delete` reported `localRecordDeleted: true, websiteAccount: not_deleted, inbox: deleted` |

**Wasted runs**
- The first C attempt's fixture run (`eIfbj2kZPnmc0XBT3`) was lost to a bug in my test script (a wrong result key). No upload was attempted.
- B's first fixture run was lost to the domain allowlist mistake above.

**Cleanup:** 0 sessions, jobs, leases, accounts, artifacts or operations; cleanup queue empty; 0 Apify runs RUNNING/READY; MailSlurp inbox count 0. The saved extraction files stay in `data/results/`.

**Spend this round**
- 12 Apify runs (9 worker, 3 fixture): $0.0228, from the run figures (some still preliminary).
- One worker build: $0.0039.
- Total about **$0.027**.
- Apify account figure: $0.2580 before the first live run → $0.2800 at the last read. The figure lags behind run figures.
- Account limit $5; plugin budget $1.00.

---

# Stabilization round, 2026-10-13

**Worker build:** `0Y0N3EJOF9XHHxCte`, deployed from `6a418e4` (navigation readiness and operations privacy merged). The tools ran over stdio through `scripts/start-mcp.mjs` with the real config, which now lives in `~/.config/remote-browser-accounts/`. The only test-process override was `RBA_OPERATIONS_ENABLED=true`.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Network evidence for the earlier proxy timeouts, same page through the datacenter proxy vs direct | Explained | `waitUntil: load` completed in 8.5 s (proxy) vs 1.5 s (direct). Both loaded 59 same-origin requests (about 3.3 MB, one CONNECT each). Policy-blocked third-party hosts failed in under 30 ms; no request hung. The two earlier 30 s timeouts were not logged, so their cause is inferred (proxy throughput against a fixed load deadline), not proven. |
| 2 | Readiness through the proxy: `browser_navigate` with `readyWhen: { selector: '.features_items .productinfo' }` | Passed | Document ready in 17.7 s (first run) and 4.9 s (second); condition `met`; `load` still `pending` with 26–28 same-origin requests, reported and not fatal. |
| 3 | Remote saved operation (remote_proxy, datacenter, route `verified`) | Failed, then passed | First run: learning failed with "no column learned_proxy_json" (registry upgraded through the original v3 migration; fixed by migration v7). Second run: learned `ae_search_proxy` (examples "top" and "dress"), reviewed, called with "jeans" (unseen) and got 3 matching products via tier 1 inside the proxied session, validated with "saree" (`valid: true`). Listed as public, bound to `remote_proxy`, `exportable: false`. Deleted afterwards. `run_report`: effective mode `remote_proxy`, verification `verified`. |

**Not repeated:** live uploads, account signup, F refusal (already sufficient from 2026-10-12).

**Cleanup:** 0 sessions, jobs and operations; 0 Apify runs RUNNING or READY.

**Spend:**
- This round: the NAVDIAG sessions, two live L sessions and one build, about $0.016 by run figures. The account figure lags.
- Apify account: $0.2808 → $0.2983 across the round. The figure includes the build and still-settling runs.
