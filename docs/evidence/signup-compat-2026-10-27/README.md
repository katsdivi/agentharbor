# Signup compatibility test, 2026-10-27

Live test of the account lifecycle (signup, credential login, logout and re-login, restoring a saved session, deletion, local cleanup) on three public practice sites. Everything ran through the plugin's MCP tools on Apify. The raw step-by-step record is [`evidence-log.md`](evidence-log.md); this page summarises it and keeps its qualifications. Where the two differ, the log is the source.

**Build under test:** plugin `0.1.0+7b11081` (commit `7b11081`, clean tree, dist hash matched the build record). All results below are for this build only. The limitations listed at the end were present in it. If they are fixed later, the fixed build gets its own version and its own validation; these runs are not evidence for it.

## Results

| Site | Signup | Login, logout, re-login | Saved session restored (no fills) | Deleted on the site | Interventions |
|---|---|---|---|---|---|
| automationexercise.com | Passed | Passed | Passed | **Yes**, through the site's "Delete Account" | None during the run |
| practice.expandtesting.com | Succeeded, but **reported as failed** by the plugin (false rejection) | Passed | Passed | **No**: the site has no delete option | Operator agent lifted the quarantine |
| parabank.parasoft.com | 1st attempt **blocked** (HTTP 403, human verification). 2nd attempt passed | Passed (2nd account) | Passed (2nd account) | **No**: the site has no delete option | User approved a resubmit through a residential proxy |

Only AutomationExercise completed the full lifecycle, deletion included, with no intervention.

### automationexercise.com

- Job `job_39750c4d80df4c1c`, `remote_direct`, disposable MailSlurp inbox (the site asks for an email; it sent no verification mail).
- Signup confirmed by the site's "Account Created" page. Login, logout and re-login showed "Logged in as Testy Fictional". A fresh worker with the saved cookies showed the same text with zero fill calls.
- Deleted through the site's own "Delete Account" link ("ACCOUNT DELETED!"). A later login attempt with the same credentials was refused ("Your email or password is incorrect!").
- Before the run, while reading selectors, the operator agent submitted page 1 of the signup form with an `example.com` placeholder and abandoned it on page 2. No account was created from that step.

### practice.expandtesting.com

- Job `job_eb7142b2d69d48b3`, username `rbaexp1cd1b9`, `remote_direct`. The site asks for no email; an inbox was created anyway and never used.
- The signup succeeded: the site redirected to `/login` as it normally does, and logging in later reached the secure area ("Hi, rbaexp1cd1b9!").
- The plugin reported the job as **failed/rejected** and quarantined the account. The cause was the rejection word `Invalid`, which the operator agent had supplied: the plugin checks rejection words against the whole page after submit, and the `/login` page contains that word in its own static text.
- The operator agent lifted the quarantine (`account_quarantine lift`, reason recorded) and continued. The login, re-login and restore steps that followed all passed.

### parabank.parasoft.com

- **Attempt 1:** job `job_cec5b66802b24faa`, username `rbapbc863a1`, `remote_direct` (Apify datacenter egress). The signup form submission returned **HTTP 403 / human verification**. The plugin stopped, did not resubmit, and marked the account `blocked`. A plain page load from another datacenter worker returned 200, so the site blocked the form submission, not page access. The local record and inbox were then deleted. **Whether `rbapbc863a1` exists on ParaBank is unknown**; it was not checked.
- **Attempt 2:** after the user explicitly approved a resubmit, the operator agent ran a new signup (job `job_66543f35e41c4f7b`, username `rbapb9d9db2`) with `remote_proxy`, residential, US, through Apify. The site confirmed it ("Your account was created successfully"), and login, re-login and restore all passed.
- No CAPTCHA or challenge was solved. The second attempt went through a different network route that the site did not challenge. The plugin does not change proxies on its own after a block; this change was a user decision.

## Manual browser input vs. intervention

These are separate claims:

- **No manual browser input — true for all three sites.** No human typed into or clicked in any browser. Every page action went through the plugin's tools, and passwords were filled only from stored secret references. Usernames were typed as plain values by the operator agent, because the plugin has no username secret (limitation 3).
- **No human or operator intervention — true only for AutomationExercise.**
  - ExpandTesting: the operator agent overrode the plugin's verdict by lifting a quarantine.
  - ParaBank: the user approved a second submission and a change of route after the site blocked the first one.
  - For all three sites, the site allowlists were configured before the runs. ExpandTesting and ParaBank were added between the first attempt (refused by the plugin as not allowed) and the re-run.

"Operator agent" means the Claude Code session driving the plugin tools. Its choices (form selectors, rejection words, usernames) shaped the results, including the ExpandTesting false failure.

## Accounts left on the sites

Local cleanup is complete; deleting the accounts on the external sites is **not**:

- `rbaexp1cd1b9` on practice.expandtesting.com: confirmed to exist, no way to delete it.
- `rbapb9d9db2` on parabank.parasoft.com: confirmed to exist, no way to delete it. ParaBank is a shared demo database that is reset periodically.
- `rbapbc863a1` on parabank.parasoft.com: **status unknown** (the submission received a 403).

All three local account records and their MailSlurp inboxes were deleted. At the end, `account_list`, `email_inbox_list` and `session_status` were empty.

## Known limitations found by this test

1. **`config_check` does not show the navigation allowlist** (`RBA_ALLOWED_ORIGINS`). It lists the signup targets only, so a site can look configured when navigating to it is still refused. During the test the allowlist was confirmed from the env file and from `session_start`'s `allowedNavigationOrigins`.
2. **Rejection words are matched against the whole page after submit.** A word that appears in a page's own static text (here `Invalid` on a login page) makes a successful signup report as rejected, and the account gets quarantined.
3. **No credential reference for usernames.** `browser_fill` has secret references for `account_email` and `account_password` only, so on username-based sites the username is filled as a plain value and is not stored with the account's credentials.

None of these were changed during or after the runs.

## Recording

The main video uses **AutomationExercise**, the only site whose full lifecycle, deletion included, was verified without intervention. ParaBank registration is not repeated for the recording, and proxies are not switched to get past another anti-bot block. If a recorded run differs from the results above, it is logged as a new run rather than replacing these.

## Files

- [`evidence-log.md`](evidence-log.md): timestamped log with job, account and session ids.
- `screenshots/`: `site1-*` (AutomationExercise), `site2-*` (ExpandTesting), `site3-get-ok-post-blocked.png` (ParaBank page load after the blocked submit), `site3-credential-login.png` and `site3-restored-session.png` (ParaBank 2nd account). Password fields are masked; no cookies, browser state or inbox exports are stored here (see `.gitignore`).
