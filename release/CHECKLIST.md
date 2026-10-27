# Release checklist

Run these on a clean, committed tree. Record the results (counts and versions) in the release notes.

1. `npm ci && npm --prefix actor ci && npm run build`
2. `npm test`: every test passes. Record the count.
3. `claude plugin validate --strict .`
4. Bump `version` in `.claude-plugin/plugin.json`, `package.json` and `SERVER_VERSION` together.
5. `npm run package`. It refuses a dirty build and fails on denylisted paths or credential-like content.
6. `npm run smoke:install -- --artifact pkg/remote-browser-accounts-<v>.zip --work <scratch dir with a space>`
7. `npm run smoke:install -- --clone . --ref <branch> --work <scratch dir with a space>`
8. Credential check of what will be published (prints locations only, never values):
   `git log -p` scanned for token patterns, plus the denylist and credential scan from step 5.
9. Update `docs/PLATFORMS.md` with only the platforms actually run.
10. Do **not** push, publish or submit without the owner's explicit go-ahead.
