# Vendored: api-anything (pinned)

- Upstream: https://github.com/goodnight000/api-anything
- Revision: `4a785e8d9e72a00e2dddc0dc56569a86826df07b`
- License: MIT, Copyright (c) 2026 Tianjun Zheng (see `LICENSE` in this folder)
- Not installed from npm. The files are copied from that commit, so no upstream package scripts ever run.

`MANIFEST.json` records the sha256 of every copied file. `test/unit/operations-vendor.test.ts` checks the
copies against it, so a local edit to a vendored file fails the tests.

## What is used

These files are copied verbatim. They only parse and transform data: no file system access, no network, no child processes.

| File | Imports |
|---|---|
| `types.ts` | (none) |
| `spec.ts` | `zod` (same version as this plugin, 4.6.5) |
| `codec.ts` | type `./spec` |
| `extract.ts` | `node-html-parser`, `./codec`, type `./spec` |
| `classify.ts` | `node-html-parser`, `./extract`, type `./spec` |
| `secrets.ts` | type `./codec`, type `./session` |
| `learn.ts` | `./codec`, `./extract`, `./secrets`, `./session`, `./spec`, type `./types` |

`session.ts` is **derived**. It contains only the pure cookie helpers of the upstream file (line ranges are in its
header). The upstream file store, locks, browser import and `tldts`-based helpers are left out.

## What is not used, and what replaces it

| Upstream | Why not | Replaced by |
|---|---|---|
| `http.ts` | sends requests from this machine | worker route `POST /fetch` (same network policy and proxy as the browser) |
| `browser.ts`, `login.ts`, `import.ts` | launch the personal Chrome profile and read everyday-browser cookies | worker route `POST /capture` in a fresh automation context; account state comes from the encrypted account vault |
| `execute.ts`, `heal.ts` | drive the two above | `src/operations/runner.ts` (tier 1 `/fetch`, tier 3 `/capture`), bounded repair by re-learning |
| `store.ts`, `session.ts` (I/O parts) | `~/.api-anything` file store | SQLite tables of migration v3, vault-encrypted private parts |
| `outline.ts`, CLI, MCP server | not needed | `src/mcp/tools/operations.ts` |
