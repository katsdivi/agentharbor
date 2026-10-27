# Release-candidate interfaces and ownership

Status: **contract for the release-candidate work**. The lead owns this file. Workers propose changes in
their design report and never edit it or a lead-owned file directly.

Baseline: commit `eb065b3`, 243/243 tests passing (`npx vitest run`, 172 s), plugin id
`remote-browser-accounts`, Apify Actor build 0.1.6.

## 1. Lead-owned contracts (no worker edits)

| Contract | File(s) | Notes |
|---|---|---|
| Execution modes | `src/core/modes.ts` | resolution and refusal rules (section 2) |
| Database schema and migrations | `src/core/db.ts`, `src/core/migrations.ts` | versioned; workers get reserved version slots (section 3) |
| Worker wire protocol | `actor/src/protocol.ts`, `actor/src/validate.ts` | W1 proposes route shapes; the lead merges them and redeploys the Actor **once** |
| Provider registry | `src/providers/types.ts`, `src/providers/local.ts`, `src/core/context.ts` | section 4 |
| Tool registry | `src/mcp/tools/index.ts`, `src/mcp/tools/types.ts` | section 5 |
| Pipeline skill, command, capabilities tool | `skills/pipeline/`, `commands/`, `src/mcp/tools/pipeline.ts` | |
| Manifest identity | `.claude-plugin/*.json` `name` field | W4 may edit everything else in the manifests |
| Actor deployment, live paid runs | | the lead and W5 only, bounded, cost reported |

## 2. Execution modes (`src/core/modes.ts`)

```ts
export type ExecutionMode = 'local' | 'remote_direct' | 'remote_proxy';
export type ProxyKind = 'datacenter' | 'residential';
export interface ResolvedRoute {
  mode: ExecutionMode;
  proxy: { kind: ProxyKind; country?: string } | null; // non-null only for remote_proxy
  source: 'explicit' | 'account' | 'config_default' | 'legacy_proxyMode';
  /** Worker-level ProxyMode actually sent to the worker. */
  workerProxyMode: 'direct' | 'datacenter' | 'residential';
}
export function resolveRoute(input: {
  mode?: ExecutionMode; proxyMode?: 'direct'|'datacenter'|'residential'; country?: string;
  account?: { execution_mode: ExecutionMode; proxy_mode: string; proxy_country: string | null } | null;
  cfg: Config;
}): ResolvedRoute; // throws RbaError
```

What each mode means:
- `local`: the browser worker runs on this computer. Requests originate from this computer's network. It uses a fresh, temporary automation profile (the bundled Chromium with no user-data-dir) and the same network policy. It never discovers, reads or imports the personal Chrome profile or its cookies. Only the `direct` route is used.
- `remote_direct`: the Apify worker with no proxy. Requests originate from the provider's worker IP. **This is the default for existing users** (`proxy_mode='direct'`).
- `remote_proxy`: the Apify worker through the requested Apify proxy (`datacenter` or `residential`, optional country). It fails closed: if the proxy cannot be obtained or the egress IP cannot be verified as different from the worker's direct IP, the session is refused and nothing is sent to the target.
- No mode is ever called "anonymous".

Resolution order: explicit `mode`, then the account's stored `execution_mode`, then `RBA_DEFAULT_EXECUTION_MODE` (unset falls back to the legacy `RBA_DEFAULT_PROXY_MODE` mapping).

Legacy mapping (a documented derivation, not a fallback): if `proxyMode` is given without `mode`, `direct` maps to `remote_direct`, and `datacenter` or `residential` maps to `remote_proxy`.

Refusals (an `RbaError`, never coercion):
- `remote_proxy` with `proxyMode: 'direct'` or with no proxy kind gives `invalid_input`.
- `local` or `remote_direct` with a non-direct proxy gives `invalid_input`.
- The requested mode differs from the account's `execution_mode` (or the route differs from the account's proxy route) gives `invalid_input`: "account X is bound to <mode>; refusing to switch routes silently".
- A `remote_*` mode with no Apify provider configured gives `config_missing`. There is never a local fallback.
- `local` without a built worker or browser gives `config_missing`. There is never a remote fallback.

## 3. Migrations (`src/core/migrations.ts`)

- `schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`.
- v1 is the existing `SCHEMA` (all `IF NOT EXISTS`), so existing databases are adopted as v1.
- Each migration runs in one `BEGIN IMMEDIATE` transaction, is idempotent (it checks `PRAGMA table_info` before `ALTER`), and must not drop or rewrite user data.
- A database newer than the code is refused with a clear `config_missing` error, never downgraded.
- **Reserved slots.** A worker writes its migration in its own file `src/core/migrations/vN-<name>.ts` only after the lead approves the schema in the design reply.

| Version | Owner | Content |
|---|---|---|
| v2 | lead | `accounts.execution_mode`, `sessions.execution_mode`, `sessions.route_json` |
| v3 | W1 | saved operations |
| v4 | W2 | workflow and step state, idempotency keys, cleanup queue |
| v5 | W3 | run reports, acceptance records |
| v6 | W1/O | operations privacy binding (`operations.privacy_version`, `bound_origin`, `bound_route_json`; `src/core/migrations/v6-operations-privacy.ts`) |
| v7 | lead | `operations.learned_proxy_json` for registries migrated through the original v3 |
| v8 | lead | email modes: `inbox_meta` (kept/disposable, bound sender sites, open window, lifecycle) and `inbox_tombstones` (salted hashes of retired/deleted addresses) |
| next free slot | W4 | install metadata (only if needed) |

## 4. Providers

```ts
interface BrowserProvider { readonly name: string; readonly kind: 'remote' | 'local'; startRun; getRun; abortRun; accountUsage }
ctx.providers: { remote: BrowserProvider | null; local: BrowserProvider | null }
ctx.provider  // == ctx.providers.remote (kept for Usage / existing code)
```

`LocalProvider` (`src/providers/local.ts`) spawns `node actor/dist/main.js` with:
- a temporary `CRAWLEE_STORAGE_DIR`;
- `RBA_WORKER_BIND_HOST=127.0.0.1`;
- a minimal environment (`PATH`, `HOME`, storage dir, port, and `PLAYWRIGHT_BROWSERS_PATH` passthrough), never `RBA_WORKER_TEST_MODE` and never the inherited `process.env`.

Its `runId` is `local:<pid>:<nonce>`, and the nonce appears on the child's command line (`--rba-local-run=<nonce>`). `getRun` and `abortRun` work from a new process: they check `kill(pid, 0)` and that `ps` shows the nonce, so they never touch a reused PID.

Local runs record no Apify usage. `recordRunUsage` returns `{usd: 0, basis: 'local_no_provider_charge'}`. Local sessions count toward `RBA_MAX_CONCURRENT_SESSIONS` and not toward the budget.

**Egress in local mode: no IP-echo service is contacted.** The worker gets a loopback check URL that its own policy blocks. `SessionView.route.verification` is `not_checked`, and `route.limits` explains why.

`SessionView` gains:
- `executionMode`
- `route: { mode, provider, proxy, source, verification: 'verified'|'not_checked'|'failed'|'pending', meaning, limits[] }`

`ExecutionReport.route.verification` uses the same values.

## 5. MCP tools

`src/mcp/tools/index.ts` exports `TOOLS = [...core, ...files, ...operations, ...reports, ...pipeline]`.

| File | Owner |
|---|---|
| `src/mcp/tools/core.ts` | lead (W2 may edit job/recovery handlers there after design approval) |
| `src/mcp/tools/files.ts` | W3 |
| `src/mcp/tools/operations.ts` | W1 |
| `src/mcp/tools/reports.ts` | W3 |
| `src/mcp/tools/pipeline.ts` | lead |

`ToolDef` and `ToolResult` live in `src/mcp/tools/types.ts`. Shared zod pieces (`modeArgs`, `country`, `target`) live in `src/mcp/tools/shared.ts` (lead).

Every tool that starts browser or HTTP work takes `mode?: ExecutionMode` and `proxy?: { kind, country? }`. The legacy `proxyMode` stays accepted.

## 6. Per-run execution report (W3 implements; the lead wires it into the pipeline)

```ts
interface ExecutionReport {
  reportVersion: 1; runId: string; jobId?: string; createdAt: string;
  requestedMode: ExecutionMode | null; effectiveMode: ExecutionMode;
  route: { proxy: ResolvedRoute['proxy']; verification: 'verified' | 'not_checked' | 'failed' | 'pending'; limits: string[] }; // copy SessionView.route
  account: { id: string; origin: string } | null;      // reference only, never credentials
  files: Array<{ artifactId: string; sha256: string; sanitization: string }>;
  confirmation: { kind: string; evidence: string } | null;
  cleanup: { pending: string[]; done: string[] };
  cost: { estimatedUsd: number | null; providerReportedUsd: number | null; basis: string };
  uncertain: string[];
}
```

## 7. File ownership by worker

- **W1, operations / api-anything.** Owns:
  - `src/operations/**`, `src/vendor/api-anything/**` (pinned `4a785e8d9e72a00e2dddc0dc56569a86826df07b`, with LICENSE and attribution);
  - `src/mcp/tools/operations.ts`, `test/**/operations*`;
  - the proposed worker routes, which the lead merges into `actor/src/` and `protocol.ts`;
  - migration v3.
- **W2, workflow correctness.** Owns:
  - `src/core/jobs.ts`, `src/core/signup.ts`, `src/files/portal.ts` (outcome and recovery parts), `src/core/recovery.ts` (new);
  - the recovery parts of `src/core/sessions.ts`, after the lead's mode changes have landed;
  - `test/**/recovery*`, `test/**/workflow*`; migration v4.
- **W3, privacy and artifacts.** Owns:
  - `src/files/**` except the outcome logic in `portal.ts`;
  - `src/core/redact.ts`, `src/reports/**`, `src/mcp/tools/files.ts`, `src/mcp/tools/reports.ts`;
  - `actor/src/netpolicy.ts` (proposals only), `test/**/privacy*`, media tests; migration v5.
- **W4, install and distribution.**
  - Owns: `package.json` scripts and engines, `scripts/**`, `src/cli/**`, the manifests (except `name`), `.env.example`, `README.md` install section, `docs/INSTALL.md`, `docs/PLATFORMS.md`, `release/**` (catalog and directory materials), `.gitignore`.
  - Data-directory resolution in `src/core/config.ts`: the `dataDir` block only.
  - Display-name config: `RBA_DISPLAY_NAME`.
- **W5, acceptance.** Owns: `test/e2e/**`, `test/fixtures/**` additions (new files only), `docs/ACCEPTANCE.md` evidence. Reads everything and edits nothing else.

## 8. Rules for every worker

- Design report first: the files you will touch, the interfaces you need from the lead, the migration SQL, and risks. Implement only after the go-ahead.
- Work in your own git worktree and branch. Symlink only `node_modules` and `actor/node_modules`. Build your own `dist/` and `actor/dist/`. Never share another tree's build output.
- **No live Apify runs.** No `.env` edits or reads of secret values. No plugin reinstall. No writes under `~/.claude/plugins`. No pushes, publishing or listing submissions.
- Tests use `freePort()`, `testCtx()` (a temporary `.env`), synthetic fixtures and `localhost` only. Remove your `rba-*` temp dirs; disk space is tight.
- Never describe a mock as a working integration. Never say "anonymous", "10/10", "production ready" or "works on any website".
- Report: the commit on your branch, the tests you ran (with counts), what is verified, and what is a known limitation.

## 9. Foundation status and design decisions

The foundation commit is the one that adds this section.

Landed:
- `src/core/modes.ts`;
- `src/core/migrations.ts`, with v2 applied;
- `src/providers/local.ts`;
- `Sessions(..., providers)`, `sessions.requireProvider(mode)` and `providerFor(row)`;
- the `src/mcp/tools/{index,types,shared,core,files}.ts` split;
- `routeShape`, `routeArgs` and `resolveToolRoute(ctx, args, accountId)` in `shared.ts`;
- `mode`/`proxy` on `session_start`, `account_add`, `account_register`, `crawl_start` and `portal_upload`;
- `Usage.assertConcurrency()`.

Registering a worker migration: add `import { vN } from './migrations/vN-<name>.js'` to the `MIGRATIONS` array in `migrations.ts`. That one-line edit is pre-approved for the worker that owns the slot.

### W1 (approved, with these decisions)
- `RBA_OPERATIONS_ENABLED`, default off: the tools stay registered and return `config_missing`.
- Fixture: `test/fixtures/operations-site.ts` (yours).
- `purpose: 'operation'`: you may add it to the `StartOptions.purpose` union in `sessions.ts` (a one-line edit).
- Implement the `/fetch` and `/capture` routes yourself, in `actor/src/` (new files plus minimal edits to `server.ts`, `protocol.ts` and `validate.ts`). The lead reviews them at merge and redeploys once.
- Keep `protocolVersion` at 1 and detect support through `HealthResponse.capabilities`.
- Verify that `context.request` actually goes through the PolicyProxy, and test it.
- v3 SQL is approved.

### W2 (approved, with these decisions)
- You may edit:
  - the job, recovery and `account_*` handlers in `src/mcp/tools/core.ts`;
  - the recovery gate in `src/mcp/index.ts`;
  - the reap and cleanup parts of `sessions.ts`, but not `start()`'s route logic.
- New statuses are allowed (`completed_unconfirmed`, `outcome_unknown`, `interrupted`). Export `TERMINAL` from `jobs.ts` and use it everywhere.
- `ExecutionReport.cleanup` reads `cleanup_queue`.
- For fault injection, use wrapper providers and clients in your own test files.
- Keep `account_delete` as the tool name; returning `localRecordDeleted` / `websiteAccount: 'not_deleted'` is enough, so no alias is needed.
- `portal.ts`: you own the outcome and step logic; W3 owns preflight and acceptance.
- v4 SQL is approved.

## 10. Stabilization round (navigation readiness, operations privacy)

Lead-reviewed protocol additions. `protocolVersion` stays 1; support is detected through `HealthResponse.capabilities`, which includes `readiness`.
- **`/navigate`:**
  - Accepts `readyWhen: { selector?, textContains?, response?: { urlContains, status? }, timeoutMs? }` and `settleMs`.
  - The document (commit + DOMContentLoaded) is required within `timeoutMs`.
  - `readyWhen` is a task condition: when it is not met, the call fails with the new error code `condition_not_met`.
  - The settle wait toward load is capped and never fails.
- **`readiness` field:** `NavigateResponse`, `ClickResponse` and `WorkerError` carry `readiness?: { document, load, condition, conditionDetail?, pendingRequests: { count, hosts }, documentMs, loadMs, elapsedMs }`.
- **`readyWhen` on more routes:** `/extract` and `/inspect` accept `readyWhen`.
- **Deadlines:** `commandDeadlineMs` includes the condition and settle budgets.
- **Older Actor builds:** a worker without the `readiness` capability gets the old requests from internal callers. An explicit `readyWhen` against it is refused (`config_missing`).
- **Migration v6:** operations privacy binding (`privacy_version`, `bound_origin`, `bound_route_json`).
