# Platform matrix

This page states only what was actually run. "Untested" means nobody has run it. It doesn't
mean the platform is known to work, and it doesn't mean it is known to fail.

**Declared versus tested.** `package.json` declares `engines.node >= 22.13`, and the launcher enforces it.
That declaration is a minimum the code is written for. It is not a claim that every version or OS meeting
it was tested. Only the row under "Tested" was actually run. `config_check` reports this install's
`versions` (release, MCP server version = release + build commit, manifest consistency, worker protocol).

## Tested

| OS | CPU | Node.js | npm | Claude Code | What was run |
|---|---|---|---|---|---|
| macOS 26 (Darwin 25.2.0) | arm64 (Apple silicon) | 24.7.0 | 10.5.0 | 2.1.296 | full test suite; `npm run package`; clean install from the packaged zip and from a fresh `git clone`, each in a folder whose path contains spaces (`npm ci`, build, `doctor`, `claude plugin validate`, MCP stdio initialize/tools/list/config_check); local mode with Playwright Chromium 1.64 |

Remote modes run the browser worker on Apify's Linux containers, whatever the local OS. The
local machine runs only the MCP server, SQLite and the optional file tools.

## Untested

| Platform | Status | Known concerns from reading the code (not observed) |
|---|---|---|
| macOS x64 (Intel) | untested | none known |
| Linux x64 / arm64 | untested; no container run was possible here (Docker daemon not running) | Playwright Chromium needs system libraries (`npx playwright install --with-deps chromium`) for local mode |
| Windows 10/11 | untested | `.env` and data-folder modes (600/700) aren't enforced by Windows, and `doctor` skips the permission check there; local mode checks worker processes with `ps`, which Windows doesn't have; the media tools need Windows builds of ffmpeg and Poppler on `PATH` |
| WSL2 | untested | treat as Linux |
| Node.js 22.13 – 23.x | untested (the minimum is enforced by the launcher and `doctor`) | `node:sqlite` prints an ExperimentalWarning, which the launcher suppresses |
| Node.js < 22.13 | not supported | the launcher refuses with a message |
| claude.ai / Cowork (directory listing) | untested | the plugin's MCP server is a local stdio process, and its data, dashboard and file tools are local; check the component support table before assuming these surfaces load it |

To add a row, run `npm run smoke:install` and the test suite on that platform, and record
the exact versions.
