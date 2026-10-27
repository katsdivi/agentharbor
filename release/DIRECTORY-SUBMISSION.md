# Anthropic plugin directory: submission materials (draft)

Status: **draft, not submitted.** Submitting requires a paid claude.ai plan and the developer
portal at claude.ai/directory/manage. Passing local checks doesn't mean the portal will accept
the plugin, and review isn't guaranteed. Sources: [publish](https://code.claude.com/docs/en/plugins/publish#submit-to-anthropics-directory),
[pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist),
[manifest reference: directory listing fields](https://code.claude.com/docs/en/plugins-reference).

## Listing text

- **Name (id):** `remote-browser-accounts` (permanent; kebab-case, ASCII)
- **Display name:** Remote Browser Accounts. This is a descriptive label, not a brand.
- **Short description:** Browser sessions (local or on your own Apify account), scraping and
  bounded crawls, MailSlurp verification email, and encrypted persistent website accounts with
  exclusive leases. You bring your own credentials.
- **Long description:** README.md (well over the 40-word minimum).
- **Keywords:** browser, automation, scraping, apify, mailslurp, mcp
- **License:** MIT (`LICENSE` file and `plugin.json`).

## Data-flow disclosure (for the README and the review)

- The MCP server runs locally over stdio. It calls the **Apify API** (start, stop and poll the
  user's own private worker Actor; usage) and the **MailSlurp API** (create inboxes, read
  messages). It calls nothing else.
- Target websites are contacted by the browser worker: in Apify's cloud for the remote modes,
  or on the user's computer for local mode, which uses a fresh automation profile and never the
  user's own browser profile.
- Credentials are read from the user's `.env` file. Website passwords and browser states are
  stored locally, encrypted (AES-256-GCM, with the key in that `.env`), in a SQLite registry in
  the plugin's data folder. Nothing is sent to the plugin author.
- An optional local dashboard binds to 127.0.0.1 and requires a token.

## plugin.json fields to add once URLs exist

`homepage`, `repository`, `documentationUrl`, `supportUrl` and `privacyPolicyUrl` all need
real `https://` URLs. `homepage` must parse as a URL, or the plugin fails to load. Don't add
placeholder URLs.

## Known blockers and expected holds

| Item | Checklist result | Status / plan |
|---|---|---|
| No public repository yet | can't submit | owner decision |
| `dist/` isn't on the source branch; Claude Code doesn't build | install would fail to start | submit a release ref containing the packaged build (see `release/README.md`) |
| Compiled JavaScript in `dist/` | possible hold: "commit readable source" | the package also ships `src/` (TypeScript) and `tsc` output is unminified |
| `package.json` + `package-lock.json` at the plugin root | **always held**: "Dependencies install from a lockfile" | expected; registry-only, exact pins, https URLs (checked by `npm run package`) |
| MCP server runs `node <file>` (not a shell script) | possible hold: "Scripts the validator couldn't follow" | plugin is at the repository root, which avoids the subfolder rules |
| Credentials come from a `.env` file, not `userConfig` with `sensitive: true` | possible hold or finding | option for a later version: `userConfig` for `APIFY_TOKEN` / `MAILSLURP_API_KEY` passed through `.mcp.json` `env`; not implemented |
| Files over 256 KiB / more than 512 files | held | package: about 140 files; largest is `package-lock.json`, under 256 KiB |
| `.DS_Store` files | blocking | the package excludes them |
| Surfaces | — | it is unverified whether claude.ai / Cowork load a local stdio MCP server plugin like this one; check the component support table before claiming support |

## Before submitting

Run everything in `release/CHECKLIST.md`, then use **Validate** in the portal and fix every
**Blocking** finding. Make no claims about acceptance, review time or placement.
