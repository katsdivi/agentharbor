# Release and distribution materials

Status: **prepared, not tested end-to-end.** Nothing in this folder has been pushed,
published or submitted. No repository URL exists yet, so `OWNER/REPO` is a placeholder.

| File | Purpose |
|---|---|
| `marketplace/.claude-plugin/marketplace.json` | catalog template for a GitHub-hosted marketplace |
| `DIRECTORY-SUBMISSION.md` | materials and known blockers for Anthropic's plugin directory |
| `CHECKLIST.md` | the steps to run before any release |

## Three different routes

These routes are separate, and getting into one doesn't imply the others.

1. **Self-hosted marketplace.** A `.claude-plugin/marketplace.json` in a git repository you
   control. Once the file is pushed it is "published"; there is no review. Users run
   `claude plugin marketplace add OWNER/REPO` and then
   `claude plugin install remote-browser-accounts@remote-browser-accounts-releases`.
   Auto-update is off by default for third-party marketplaces.
   ([publish](https://code.claude.com/docs/en/plugins/publish), [host](https://code.claude.com/docs/en/plugins/host-marketplace))
2. **Anthropic's plugin directory** (claude.ai/directory). You submit from the developer
   portal at claude.ai/directory/manage, and that needs a paid claude.ai plan. The portal runs
   validation and, after submission, a security scan. Some findings are held for a human
   reviewer. Listing isn't guaranteed. A listed plugin reaches Claude Code users as
   `<name>@synced`. ([publish](https://code.claude.com/docs/en/plugins/publish#submit-to-anthropics-directory),
   [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist))
3. **Anthropic's official marketplace** (`claude-plugins-official`). It doesn't take
   submissions through the directory portal. The docs say only that partners can ask their
   Anthropic contact. No action is planned.

## Why the catalog points at a release ref, not `main`

When Claude Code installs from git, it copies the plugin into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and runs a frozen,
`--ignore-scripts` lockfile install for the root `package.json` (60 s limit). It never runs
a build ([loading reference](https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies)).
`dist/` is not committed on the source branch, so a `github` source pointing at `main` would
install a plugin whose launcher reports "not built" and exits.

The planned release flow, which hasn't been run:

1. On a clean, committed tree: `npm run package` (it refuses a dirty build).
2. Create a release branch or tag (for example `release-0.1.0`) whose root is the contents of
   `pkg/remote-browser-accounts-<version>/`, with no other files.
3. In the catalog, set `ref` to that branch or tag and add `"sha": "<40-hex commit>"` to pin it.
4. Bump `version` in `.claude-plugin/plugin.json` for every release. Users only receive a new
   copy when the version changes ([versions](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)).
5. Run `claude plugin validate --strict` on the release tree, then install from the pushed
   marketplace on a clean machine before announcing anything.

Another option is an `archive` source pointing at the packaged `.zip` with its `sha256`
([marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference#archive-plugin-source)).

## Local mode in copied installs

Claude Code installs only the root dependencies. `actor/`'s dependencies (Playwright,
Apify SDK) and Playwright Chromium are not installed for a copied plugin. Local mode is
therefore supported only in a source checkout for 0.1.x, and `doctor` reports what is
missing.

## Marketplace name

The template uses `remote-browser-accounts-releases`, so it can't collide with the existing
local marketplace `remote-browser-accounts-local`. The lead owns manifest `name` fields, so
this name is a proposal. A user who switches marketplaces gets a new plugin id
(`remote-browser-accounts@<marketplace>`) and a new, empty `${CLAUDE_PLUGIN_DATA}`. Their
existing `.env` and data are not moved: see `docs/INSTALL.md` (`migrate-data`).
