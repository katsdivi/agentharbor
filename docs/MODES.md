# Execution modes

Every browser session runs in exactly one execution mode. The mode decides where the website sees requests coming from.

| Mode | Where the browser runs | Where requests originate | Cost | Route check |
|---|---|---|---|---|
| `remote_direct` (default) | A remote Apify Actor run (isolated container) | The provider's worker IP | Apify compute | None needed. The reported egress IP is informational |
| `remote_proxy` | A remote Apify Actor run | The requested Apify proxy (`datacenter` or `residential`, with an optional country) | Apify compute plus proxy | Required. The session is refused unless the browser's egress IP differs from the worker's direct IP |
| `local` | A worker process on this computer, started only on request | This computer's network | No provider charge | None. No IP-echo service is contacted |

## Rules

- **No fallback.** A mode that cannot be honoured is refused with an error naming what is missing (for example, `APIFY_TOKEN` for remote modes, or `npm run build` for local mode). Nothing silently moves to another mode, proxy or account.
- **Accounts are bound to a mode.** An account keeps the mode it was created in (cookies are tied to the route they were made on). Using it in another mode is refused. Accounts created before execution modes existed were migrated to `remote_direct` or `remote_proxy`, depending on their proxy setting.
- **Personal browser data is never used.** In `local` mode the worker launches the bundled Chromium with a fresh temporary profile inside a private run directory. That directory is deleted when the run ends and swept at startup if a run was orphaned. The worker never discovers, reads or imports the personal browser profile or its cookies.
- **Same network policy everywhere.** Local and remote workers share the same worker code: the navigation allowlist, the per-hop redirect checks, the policy proxy, and private-network blocking (loopback and RFC 1918 hosts are blocked unless listed in `RBA_ALLOW_PRIVATE_HOSTS`).
- **No mode is anonymous.** In `remote_proxy`, "verified" means only that the egress IP differed from the worker's IP at session start. It does not prove a location, a stable IP for the whole session, or anonymity.

## Page loads through a proxy

In `remote_proxy`, pages arrive more slowly and at a less predictable rate than in `remote_direct`. In one measured run (2026-10-12, datacenter proxy), the HTML document arrived as fast as in direct mode (about 0.5 s). The page's 59 subresources, about 3.3 MB, took 1.3–7.8 s each instead of about 0.5 s. All of them completed, and `load` fired after 8.5 s instead of 1.5 s. Other runs on the same pages went past a fixed 30 s `load` wait, while DOMContentLoaded arrived quickly. Hosts that the network policy refuses (fonts, analytics, ads) fail in under 30 ms in every mode, so they don't add delay.

For this reason, navigation readiness does not hinge on the `load` event (see `browser_navigate`):
- The document has to arrive and parse within `timeoutMs`.
- After that, the wait for `load` is bounded by `settleMs` and never fails. If it doesn't fire, the result shows `readiness.load: "pending"` and lists the requests still in flight.
- A task that needs a specific element, text or response states it with `readyWhen`. Allow a longer `readyWhen.timeoutMs` in `remote_proxy` mode.

## What account binding enforces, and what it does not

**Enforced in code** (`src/core/modes.ts`, `src/core/sessions.ts`, `src/operations/service.ts`):
- **Account mode is fixed at creation.** An account's execution mode is stored when it is created (`account_add`, `account_register`). No tool changes it. Starting a session for that account in another mode is refused (`invalid_input`, "refusing to switch routes silently").
- **Proxy route is fixed too.** For `remote_proxy` accounts the proxy kind is fixed, and so is the proxy country when one was stored. A request for a different kind or country is refused. When no country is requested, the stored one is used.
- **A session's route never changes.** Its mode and route are chosen once at `session_start` and recorded (`sessions.execution_mode`, `route_json`). No call moves a running session to another mode, provider or proxy. A worker that fails or ends ends the session.
- **Saved operations follow the same rule.** An operation run with an explicit `sessionId` refuses a mode that differs from that session's mode. An account operation runs only in a session leased to that account.
- **One holder per account.** Only one session or job can use an account at a time.
- **No fallback.** A mode that cannot be honoured is refused (`config_missing` / `invalid_input`). Nothing is ever moved to another mode instead.

**Not enforced, and not claimed:**
- **IP addresses.** The plugin does not guarantee the same exit IP across sessions. Proxy "sticky" session keys are best effort on the provider's side. Remote workers get a new container IP per run.
- **`local` mode network.** For `local` accounts, requests come from whatever network this computer is on at the time (home, office, VPN). The plugin does not detect network changes.
- **The website's view.** Binding prevents the plugin from silently switching routes. It does not control how a website links an account to devices, IPs or behaviour.
- **Changing an account's mode.** To use a website account through a different mode, register or add it as a separate account record in that mode. This is an explicit user decision; the plugin never migrates cookies between modes.

## Choosing a mode

- Per call: `session_start`, `crawl_start`, `account_register`, `account_add` and `portal_upload` take `mode` and `proxy` (`{ "kind": "residential", "country": "DE" }`). The legacy `proxyMode` is still accepted: `direct` maps to `remote_direct`, `datacenter` or `residential` maps to `remote_proxy`.
- Default: `RBA_DEFAULT_EXECUTION_MODE=local|remote_direct|remote_proxy`. When it is unset, the default comes from `RBA_DEFAULT_PROXY_MODE`, so existing installs keep `remote_direct`.
- `pipeline_capabilities` shows which modes are available right now and why the others are not.

## What a session reports

`session_start` and `session_status` return:

```json
"executionMode": "local",
"route": {
  "mode": "local", "provider": "local", "proxy": null, "source": "explicit",
  "verification": "not_checked",
  "meaning": "runs on this computer ...",
  "limits": ["Requests originate from this computer's network; no route check is performed in local mode.", "..."]
}
```

## Local mode requirements

- The plugin is built (`npm run build` creates `actor/dist`).
- Worker dependencies are installed (`npm ci --prefix actor`).
- Playwright's Chromium is installed (`npx --prefix actor playwright install chromium`).

The worker listens on `127.0.0.1` only and requires a per-session bearer token. Its environment contains no plugin secrets.

Tested on macOS (arm64) only.
