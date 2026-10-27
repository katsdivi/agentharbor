# Acceptance matrix (release candidate)

Status: release-candidate evidence. The fixture suites were written by W5; the live rows were run by the lead on 2026-10-12.

- Final code: master `2826ef5` and later doc commits.
- Deployed worker build `wWt8kCNxCD61f1x7t`; its `actor/` source is identical to HEAD.
- Live rows link to `docs/LIVE-RESULTS.md` ("Release candidate, 2026-10-12").
- A row has a second proof level only when the same scenario was also run live.

## How to read this

Each requirement has exactly one **proof level**:

| Proof level | Meaning |
|---|---|
| local fixture | The built MCP server is driven over stdio by the SDK client (`npm run test:e2e`), like Claude Code does. Targets are local fixture sites. Remote modes use the **fake** Apify API, which runs the real worker as a local process behind an HTTPS front (`test/fixtures/tls-front.ts`). This proves orchestrator and worker plumbing. It does not prove the behaviour of the live provider or of any third-party site. |
| controlled live site | A live Apify run against the project's own `rba-practice-fixture` Actor. That Actor is not a third-party site. |
| public practice site | A live Apify run against an authorised practice target (automationexercise.com, the-internet.herokuapp.com). It says nothing about other sites. |
| not exercised | No evidence in this cycle. |

Rules:
- A mock is not provider proof.
- Extraction is not upload proof.
- A container run is not macOS proof.
- `local` rows count as macOS evidence only because the suite ran on macOS (Darwin 25.2, Apple silicon).
- Earlier live results in `docs/LIVE-RESULTS.md` used worker builds 0.1.3 to 0.1.6, before the execution-mode refactor. They are context only, not evidence for this release.

## Matrix

| Requirement | Implementation | Evidence (test file :: test) | Proof level | Remaining limitation |
|---|---|---|---|---|
| A. Fresh data dir → extraction → saved result → cleanup, remote_direct | `src/mcp/tools/core.ts`, `src/core/sessions.ts` | `test/e2e/a-extraction.e2e.ts` :: "remote_direct: navigate -> extract (save) -> close …" | local fixture **+ public practice site** | Live: session `sess_4823a092f71d4f01`, Apify run `gaZmx4Bo3lqB7lh4m`, 10 items, saved `data/results/extract_*.json`, session closed. The install step is covered by the clean-install row below. |
| A. Same flow, local mode | `src/providers/local.ts` | `a-extraction.e2e.ts` :: "local: …" | local fixture (macOS) **+ public practice site** | Live: session `sess_c60cc809909b4bff` (`local:<pid>:<nonce>`). Requests came from this Mac; 10 items; no provider charge. |
| B. Register + verify → restore in a new worker with no fill or click → cleanup, remote_direct and local | `src/core/signup.ts`, `sessions.ts`, `accounts.ts` | `test/e2e/b-account-restore.e2e.ts`. Checks: new run id, `restoredBrowserState`, no POST in the restore session, lease refusal, bound-mode refusal, lease released, `account_delete` | local fixture **+ controlled live site** (remote_direct) | Live: registration job `job_af15e77ea4dd4f7a` → `completed`/`confirmed` (email via MailSlurp, verification link followed). A new run then showed `restoredBrowserState: true` and `/account` displayed "Logged in as …" and "Email verified: yes" with no fill or click. Local mode is fixture-only. An earlier attempt was correctly `failed`/`rejected` (fixture refused the inbox domain I had configured). |
| C. Import → inspect findings → sanitize → verify → **decision on retained findings** (the upload is refused until `acceptRetainedFindings` equals the shown digest) → upload → `portal_confirmed`, with the destination's sha256 equal to the sanitized artifact. remote_direct and local | `src/files/**`, `src/files/portal.ts` | `test/e2e/c-e1-upload.e2e.ts` :: "C remote_direct …", "C local …" | local fixture **+ controlled live site** (remote_direct) | Needs ffmpeg. Live: job `job_2417ccc29aeb4737`, run `dQwjPuUYhRZhwcFNR`. ICC findings ×3 were retained, so the upload was made with the shown acceptance digest. `portal_confirmed`; size and sha256 shown by the portal equal the sanitized artifact; sent as `upload.jpg`. |
| C. Run report for the upload job | `src/reports/**` (`run_report`) | `c-e1-upload.e2e.ts` (in both C tests). Checks: `source: finalized_snapshot`; requested and effective mode; `route.proxy`/`verification`; file sha256 and sanitization "verified_for_policy … accepted by digest"; `confirmation.kind: portal_confirmed` with SHA-256 evidence; `cleanup.pending: []` with the closed session in `done`; cost basis (local: "no provider charge"); no metadata value or local path in the response | local fixture **+ controlled live site** | The live C report is a `finalized_snapshot` with effective mode `remote_direct`. Cost figures are provider-preliminary until Apify settles them. |
| D. Learn a read operation (two examples) → draft refused → review (bad hash refused) → call with an unseen input → validate: a learning example is refused, a new input gives `valid: true`. local, remote_direct, remote_proxy. Disabled by default (`config_missing`) | `src/operations/**`, `src/mcp/tools/operations.ts`, worker `/fetch` and `/capture` | `test/e2e/d-operations.e2e.ts` | local fixture **+ public practice site (local mode only)** | Live: learned `ae_product_search` from `automationexercise.com/products?search={query}` (examples "top", "dress"), reviewed, called with "jeans" (3 items via tier 1 `/fetch`), and validated with "saree" (`valid: true`). Remote modes are fixture-only. The operation was deleted afterwards. Arbitrary user-specific constants in a spec are not detected (W1 limitation). |
| D, remote_proxy: no orchestrator → target connection | as above | `d-operations.e2e.ts` :: "remote_proxy: …". Every request the target received came from a socket opened by the test proxy (local-port ownership). A control test shows a direct request is detected. | local fixture | The test proxy stands in for the provider's proxy. |
| E1. Ambiguous upload submit → `outcome_unknown` → repeat refused before any worker → the destination receives exactly one copy | `src/files/portal.ts` | `c-e1-upload.e2e.ts` :: "E1 …" (fixture's server-side `uploads` counter) | local fixture | — |
| E2. Ambiguous signup (no email) → `outcome_unknown`, `safeToRetry.safe: false`. The same `idempotencyKey` (concurrent and later) joins one job, with one inbox and one submission. | `src/core/jobs.ts`, `src/core/signup.ts` | `test/e2e/e2-signup-recovery.e2e.ts` :: "no verification email arrives …" | local fixture | — |
| E2. MCP server **SIGKILLed** after the submit → a new server process → the job becomes `outcome_unknown` ("interrupted"), the orphaned remote run is stopped, the lease is freed. A resume with `accountId` checks the inbox, completes, and never resubmits. | `src/core/recovery.ts`, `src/mcp/index.ts` | `e2-signup-recovery.e2e.ts` :: "the MCP server is killed after the submit …" | local fixture | Real process crash and restart, against the fake provider. |
| F. Explicit `remote_proxy` that cannot be obtained → refused, no local or direct fallback, **zero requests** to either target | `src/core/modes.ts`, `sessions.ts`, `actor/src/browser.ts` | `test/e2e/f-proxy-fail-closed.e2e.ts` (`session_start`, `crawl_start`) | local fixture | Zero requests is a total count. The request source is also separated by user-agent class (`test/fixtures/ua-counter.ts`). |
| F2. Proxy reachable but the egress equals the worker's direct IP → refused | as above | `f-proxy-fail-closed.e2e.ts` :: "F2 …" | local fixture | The equal IP is simulated by the test proxy. |
| Modes: refusal matrix (8 contradictions, plus crawl_start and portal_upload) refused before any job or worker | `modes.ts`, `src/mcp/tools/shared.ts` | `test/e2e/modes.e2e.ts` :: "refuses: …" | local fixture | — |
| Modes: no remote provider → `config_missing`, no local fallback; local still works | `sessions.requireProvider` | `modes.e2e.ts` :: "no remote provider configured …" | local fixture | — |
| Modes: local without the worker build → `config_missing`, no remote run | `LocalProvider.unavailableReason` | `modes.e2e.ts` :: "local without the worker build …" | local fixture | Refused before any session row is written (the test asserts no row). |
| Modes: remote_direct (`not_checked`, worker proxy `direct`); remote_proxy verified, browser traffic through the proxy, country upper-cased; legacy `proxyMode` mapping; default `remote_direct` | `modes.ts`, `sessions.ts` | `modes.e2e.ts` | local fixture **+ public practice site** | Live remote_proxy datacenter: route `verified` (egress IP ≠ worker IP) in 3 sessions. Navigation with `waitUntil: load` **timed out (30 s)** on the-internet and on automationexercise. With `domcontentloaded`, automationexercise loaded (HTTP 200, about 1.1 MB through the proxy). Live F: datacenter + `AQ` was refused at init (`egress_unverified`); the run was aborted with no navigation and no session left. |
| Modes: local uses a minimal worker env (no test mode, no secrets; checked with `ps -E`), a temporary Chromium `--user-data-dir` (never the personal Chrome profile), no egress request, no usage row | `src/providers/local.ts` | `modes.e2e.ts` :: "local: real LocalProvider …" | local fixture (macOS) | The env check needs macOS `ps -E`. |
| LOCAL-NAV-RACE regression: the first navigate right after a local `session_start` succeeds | fix `54ddc3c` | `modes.e2e.ts` :: "local: the first browser_navigate … (LOCAL-NAV-RACE regression)" | local fixture (macOS) | — |
| No orphaned workers or runs after close or server exit; no secret values in server stderr | `src/mcp/index.ts`, `sessions.close` | the teardown test in each e2e file | local fixture | — |

## Install and packaging

| Requirement | Evidence | Proof level | Limitation |
|---|---|---|---|
| Clean install from a packaged artifact and from a clean clone (path with spaces, no `.env`, temporary `CLAUDE_PLUGIN_DATA`) | W4 on `2d5e5ea` (packaged zip 9/9, clone 11/11). Repeated by the lead on the final commit (see the final report) | local (macOS arm64) | Linux, Windows and Node 22.x untested. A copied install has no local mode (actor dependencies are not installed). |
| The installed plugin loads the final build | `config_check` in a fresh Claude Code session (see the final report) | local (macOS arm64) | — |

## Defects found by this suite

| Id | Found | Symptom | Status |
|---|---|---|---|
| LOCAL-NAV-RACE | `d6f3f7e` | In local mode, the first navigation after start was interrupted by a late `about:blank`. | **Fixed** in `54ddc3c`; regression test in `modes.e2e.ts`. |
| REPORT-LOCAL-VERIFICATION | `4a75bb6` | `run_report` labelled local runs `informational_local`, not `not_checked`. | **Fixed** in `2826ef5`; regression test in `c-e1-upload.e2e.ts`. |
| OPS-PROXY-KIND | `4a75bb6` | A public operation learned in `remote_proxy` lost its proxy kind, so a call without route arguments was refused. | **Fixed** in `2826ef5` (learned proxy stored); regression test in `d-operations.e2e.ts`. |
| PROXY-LOAD-TIMEOUT (live) | live 2026-10-12 | Through the datacenter proxy, `browser_navigate` with the default `waitUntil: load` timed out at 30 s on two practice sites; `domcontentloaded` worked. | **Open, documented.** Workaround: `waitUntil: "domcontentloaded"` in `remote_proxy`. Cause not isolated (proxy latency vs. many subresources). |

## Live runs (2026-10-12)

| Row | Result | Run / evidence |
|---|---|---|
| A-live, remote_direct | Passed | run `gaZmx4Bo3lqB7lh4m` |
| A-live, local | Passed | `local:` run (this Mac) |
| B-live | Passed (second attempt) | registration run `p5tHiTNp5yYojURL3`, restore run `DGhVlOjpe4U1MlrrN`, fixture run `GC9UUPxJjsDnVkHsX`. The first attempt (`Pt975mKhj8AI13jip`) was rejected by the fixture's domain allowlist (my configuration error), and the plugin reported it as `failed`/`rejected`. |
| C-live | Passed | run `dQwjPuUYhRZhwcFNR`, fixture run `hfpZKjgDxw1e86hVl` |
| D-live | Passed (local mode) | operation `op_51b9fca28bba4927`, since deleted |
| F-live | Passed (refused) | run `dt1iFkdSuUb7XMlHC` (aborted at init) |
| modes-live, remote_proxy | Route verified; `load` navigation timed out; `domcontentloaded` passed | runs `XXfd9YBl2oVZEHg4K`, `0V3h5UTmoJCdTnRde`, `gVa1Y11DP5NDFYg7Y` |
| E-live (ambiguous submission) | Not exercised live | Deliberately not provoked against a live site; fixture-only. |

## Running

```bash
npm run test:e2e        # build + e2e suite (separate from `npm test`; 1.5 to 2.5 min on an M-series Mac)
```

The suite runs in a private TMPDIR (`vitest.e2e.config.ts`), so a concurrent unit or integration run cannot delete its live data dirs.
Final run on master: 7 files, 45 tests, all passed (no expected failures remain).
