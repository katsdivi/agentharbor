# Installing remote-browser-accounts

This page covers installing, configuring, upgrading and removing the plugin. Platform
support is in [PLATFORMS.md](PLATFORMS.md). The plugin id is `remote-browser-accounts`
and never changes. Only the label shown in the UI (`displayName`, `RBA_DISPLAY_NAME`) can.

## What you need

- Node.js 22.13 or later (the plugin uses the built-in `node:sqlite`), npm 10 or later.
- Claude Code with plugin support. Tested here with 2.1.296.
- Your own provider accounts and credentials (see [Bring your own credentials](#bring-your-own-credentials)).
  The plugin ships with none.
- Optional, for the file tools: ffmpeg/ffprobe and Poppler (`npm run doctor` lists them).
- Optional, for execution mode `local`: the worker's dependencies and Playwright Chromium
  (see [Local mode](#local-mode)).

## Install paths

There are three ways to install. Only the first is supported for 0.1.x. The other two
are prepared, and their test status is given in each section.

### 1. Source checkout + local marketplace (supported)

```bash
git clone <repository-url> "remote-browser-accounts"
cd "remote-browser-accounts"
npm ci && npm --prefix actor ci
npm run build
npm run doctor                      # what is installed; exit 0 = the server can start
claude plugin validate .
claude plugin marketplace add "$(pwd)"
claude plugin install remote-browser-accounts@remote-browser-accounts-local
```

With a local-path marketplace, Claude Code loads the plugin **in place**: the MCP server
runs from this checkout and `${CLAUDE_PLUGIN_ROOT}` is this folder. Claude Code doesn't
install dependencies or build for an in-place plugin, so after a `git pull` run
`npm ci && npm --prefix actor ci && npm run build` yourself, then `/reload-plugins` or
start a new session.

Paths with spaces are supported. The launcher and all scripts decode their own location.

### 2. Packaged artifact (prepared, tested locally)

`npm run package` builds `pkg/remote-browser-accounts-<version>/`, a `.zip` of it and a
`.sha256`. The package contains the manifests, the prebuilt `dist/` and `actor/dist/`, readable
source, the docs and a runtime-only `package-lock.json`. Files are copied from an allowlist,
and the script then **fails** if any `.env`, `data/`, `*.sqlite`, `node_modules`, `.claude/`
or `test/` path got in, or if a file looks like it contains a credential.

To install from the package, unzip it, run `npm ci --omit=dev` inside it, and then either load
it for one session with `claude --plugin-dir <folder>`, or serve it from a marketplace (for
example as an `archive` source with its `sha256`). When Claude Code copies a plugin into its
cache it runs that same lockfile install itself (`--ignore-scripts`, 60 s limit).

`npm run smoke:install -- --artifact pkg/<name>.zip --work <dir>` runs these checks in a new
folder whose path contains spaces: unpack and verify the checksum, `npm ci --omit=dev
--ignore-scripts`, `claude plugin validate`, `doctor`, and an MCP stdio session
(initialize, tools/list, config_check) with a temporary `CLAUDE_PLUGIN_DATA` and no `.env`.
The smoke test doesn't install the plugin into Claude Code.

### 3. GitHub-hosted marketplace (prepared, not tested end-to-end)

`release/marketplace/.claude-plugin/marketplace.json` is a catalog template for a
GitHub-hosted marketplace. Claude Code doesn't run a build step when it installs from git,
and `dist/` isn't committed. So a `github` source that points at the source branch would
install a plugin that can't start (the launcher then says so on stderr). The catalog must
point at a release ref that contains the packaged build. See `release/README.md`. None of
this has been pushed or installed.

## Where configuration and data live

| Install | `.env` used | Data folder |
|---|---|---|
| **Recommended:** user config folder | `~/.config/remote-browser-accounts/.env` (or `$XDG_CONFIG_HOME/…`, or `$RBA_CONFIG_HOME`) | next to it: `…/data` |
| Existing in-place install (checkout + local marketplace) | `<checkout>/.env` | `<checkout>/data` (unchanged; `doctor` warns, see below) |
| New install with a `.env` in the plugin data folder | `${CLAUDE_PLUGIN_DATA}/.env` | `${CLAUDE_PLUGIN_DATA}/data` |
| `RBA_ENV_FILE=/path/.env` set | that file | `/path/data` |
| `RBA_DATA_DIR` set | as above | `RBA_DATA_DIR` (relative to the `.env` folder) |

The `.env` lookup order is `RBA_ENV_FILE`, then `${CLAUDE_PLUGIN_DATA}/.env`, then the user config
folder, then `${CLAUDE_PLUGIN_ROOT}/.env`, then the checkout's `.env`.

**Keep the `.env` and data out of the plugin folder.** Measured with Claude Code 2.1.296: installing or
updating a plugin from a local-directory marketplace copies the **whole** plugin folder into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, including `.env`, `data/` and other files listed
in `.gitignore`. This happens even though the plugin is then read in place. A `.env` in the checkout is therefore duplicated
on every install or update. `doctor` warns when the plugin folder holds `.env*` files or `data/`, and
when a cache copy does. Move them with `npm run migrate-data -- --user-config --retire-source`, then
remove the renamed `.env.migrated-*` and the old `data/` from the checkout yourself, after checking the copy.
`npm run clean-plugin-cache` lists cache copies holding secrets or state; `-- --yes` removes their
`.env*` and `data/` (never `.env.example`). It refuses the copy in use, a copy holding the `.env`
or data in use, and a copy a running process references. The data always sits next to the `.env`
it belongs to, because the encryption key in that `.env` is the only way to read the stored
accounts.

`${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/remote-browser-accounts-<marketplace>/`.
Claude Code keeps it across plugin updates. The versioned plugin folder
(`${CLAUDE_PLUGIN_ROOT}` for copied installs) is replaced on every update, so state must never
be written there.

**Refusal instead of guessing.** Suppose more than one `.env` is found, and an install other
than the one picked has data next to it. The server then refuses to start, and `doctor`
reports the problem with both paths. To resolve it, set `RBA_ENV_FILE`, or rename the `.env`
you don't want. The plugin never switches silently to empty data or a different key.

### Create the .env

```bash
npm run init-env                                            # checkout: <checkout>/.env
npm run init-env -- --plugin-data remote-browser-accounts-local   # the plugin data folder for that marketplace
npm run init-env -- --target "/some/folder"                 # /some/folder/.env
```

The file is created at mode 600 with a generated `RBA_ENCRYPTION_KEY` and `RBA_DASHBOARD_TOKEN`.
The values are never printed, and an existing `.env` is never overwritten. `init-env` refuses to
create a new `.env` that would hide an existing install with data. Then fill in your provider
credentials in that file yourself (never in chat), and run `npm run check-config`, which lists
missing variable names only.

**Back up the `.env` and the data folder together.** Without the key, the stored credentials
and browser states can't be decrypted.

### Move an existing install's data (optional)

```bash
npm run migrate-data -- --plugin-data remote-browser-accounts-local
npm run migrate-data -- --target "/some/folder" [--retire-source]
```

`migrate-data` copies the `.env` and the data folder, and never moves or deletes them. The
database is copied with `VACUUM INTO` and checked with `integrity_check` and per-table row
counts. The command refuses if the target already has a `.env` or a registry, or if the source
database is in use (a non-empty write-ahead log): quit Claude Code sessions and the dashboard
first. `--retire-source` renames the source `.env` to `.env.migrated-<time>` so the copy
becomes the one in use. Nothing is deleted.

## Bring your own credentials

You need your own accounts. The plugin never ships, shares or proxies credentials.

| Variable | Where to get it | Needed for |
|---|---|---|
| `APIFY_TOKEN` | Apify Console → Settings → Integrations (personal API token) | remote modes |
| `APIFY_ACTOR_ID` | printed by `npm run deploy-actor` (deploys the worker as a **private** Actor in your account) | remote modes |
| `MAILSLURP_API_KEY` | MailSlurp dashboard → API key | verification email |
| `RBA_AUTHORIZED_TARGETS` | your own list of sites you are authorised to create or use accounts on | account registration and use |

Rules:

- Keep the `.env` at mode 600. `doctor` and `check-config` warn if group or others can read it.
- Never paste credentials into a Claude chat. The plugin asks only for variable names.
- `deploy-actor` and `live-check` use your Apify credit. The defaults in `.env.example` are
  conservative (a `RBA_MONTHLY_BUDGET_USD` gate).
- `RBA_APIFY_CU_PRICE_USD` is an estimate. Check your own Apify plan's compute-unit price.

## Local mode

Execution mode `local` runs the browser worker on this computer. It needs:

- `actor/dist/main.js` (`npm run build`);
- the worker's dependencies (`npm --prefix actor ci`);
- Playwright Chromium (`cd actor && npx playwright install chromium`).

`doctor` reports all three. When Claude Code installs a plugin by copying it, it installs only
the root `package.json` dependencies, never `actor/`'s. For 0.1.x, local mode is therefore
supported only in a source checkout (install path 1).

## Upgrades

- **Checkout:** `git pull && npm ci && npm --prefix actor ci && npm run build`, then
  `/reload-plugins`.
- **Copied installs** (from a marketplace): `claude plugin update remote-browser-accounts@<marketplace>`.
  The `.env` and data in `${CLAUDE_PLUGIN_DATA}` are kept. The version in `plugin.json` controls
  when users get an update, so it must be bumped for every release.
- **Database schema (one-way):** the server migrates the registry forward at startup. Each migration
  runs in its own transaction and doesn't drop user data. Before upgrading an existing registry, the server writes a
  snapshot to `<data>/backups/registry-v<from>-before-v<to>-<time>.sqlite` (mode 600). The snapshot is a
  consistent copy made with `VACUUM INTO`, and the upgrade is logged with its path. A registry created by a
  newer version is refused, never downgraded. `doctor` shows the registry's schema version and whether this
  build will migrate it.
- **Older builds and upgraded databases:** an older build is **not supported** against an upgraded registry.
  Builds since schema v2 refuse a newer schema, and builds before that do not check at all. To go back:
  1. Quit Claude Code sessions and the dashboard.
  2. Move `registry.sqlite`, `registry.sqlite-wal` and `registry.sqlite-shm` aside.
  3. Copy the matching `backups/registry-v<N>-…sqlite` to `registry.sqlite`.
  4. Run the older build that uses schema v<N>.

  Anything recorded after the snapshot (sessions, jobs, accounts and files created later) is not in it.
- **Back up before upgrading anyway:** copy the `.env` and the data folder together (with Claude Code sessions
  closed). The key in that `.env` is required to read the encrypted account data in either copy.

## Removing

- `claude plugin uninstall remote-browser-accounts@<marketplace>` deletes `${CLAUDE_PLUGIN_DATA}`
  (your `.env` and data, if they live there) unless you pass `--keep-data`. Back up first.
- An in-place install's `<checkout>/.env` and `<checkout>/data` are never touched by Claude Code.
- If an install copied the plugin folder into `~/.claude/plugins/cache/`, that copy can
  include a `.env` and a `data/` folder. Run `npm run clean-plugin-cache` (lists them) and
  `npm run clean-plugin-cache -- --yes` (removes them from inactive copies), or uninstall.

## Troubleshooting

- The server doesn't start: the launcher writes one line to stderr. Common causes are Node too
  old, a missing build, or missing dependencies. Run `npm run doctor`.
- `config_missing` from a tool: run `npm run check-config` and fill in the variables it names.
- A refusal that names two `.env` files: see [Where configuration and data live](#where-configuration-and-data-live).
