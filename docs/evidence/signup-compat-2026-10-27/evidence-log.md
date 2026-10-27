# Signup compatibility test — evidence log (2026-10-27, UTC)

## MCP discovery / smoke test
- Server `plugin:remote-browser-accounts:remote-browser` connected; build 7b11081 clean, dist hash matches record.
  (A separate project-level server named `remote-browser` from .mcp.json reports CONNECTION_CLOSED; the plugin-namespaced one works.)
- config_check: provider apify, envFile found, no missing vars (browser/email/storage/signup). Default mode remote_direct.
- Authorized signup targets: https://automationexercise.com ONLY. Navigation allowlist: automationexercise.com, the-internet.herokuapp.com.
- Smoke: sess_6766daaafd414121 remote_direct, 09:11:11Z, navigate /login OK (463 ms), inspect OK, closed ($0.0053 prelim, 47 s).
- Inspect step: submitted signup step 1 with example.com placeholder to read page-2 selectors; abandoned (no account created).

## Site 1 automationexercise.com
- Register job job_39750c4d80df4c1c, account acct_7173994e5da44fc9, mode remote_direct, disposable MailSlurp inbox (site requires an email address).
- 09:13:41Z created → 09:13:49Z completed; page /account_created, success text "Account Created" observed. Newsletter/optin left unchecked.
- Email verification: not required by site (no email step requested).
- Credential login: sess_1825ae8ad69549dd (restoreState=false, restoredBrowserState=false), 09:14:04Z. Fill via secret refs only. "Logged in as Testy Fictional" observed. Screenshot site1-credential-login.png (shot_7a87f003815c4463).
- Logout → /login, nav shows "Signup / Login". Re-login with credentials → "Logged in as" observed.
- session_save_state 09:15:10Z (2 cookies); session closed WITHOUT logout.
- Restoration: sess_b712cc0639044ae2 fresh worker (different egress IP), restoredBrowserState=true, ZERO fill calls; "/" shows "Logged in as Testy Fictional". Screenshot site1-restored-session.png (shot_d108ee5967044916).
- Deletion via site UI "Delete Account" link: "ACCOUNT DELETED!" 09:15:~25Z. Post-check credential login → "Your email or password is incorrect!".
- Cleanup: session closed; account_delete(deleteInbox) → local record deleted, inbox deleted. inbox_list/account_list/session_status all empty.
- Elapsed: register 09:13:41Z → cleanup ~09:16Z (≈2.5 min, excl. inspection). Human interventions: none. All steps via plugin tools.

## Sites 2 & 3 — attempted with plugin as configured (user: "try it, no need to add it")
- sess_54b8010d8e8e41b4 remote_direct 09:17:34Z.
- Site 2 practice.expandtesting.com: browser_navigate → navigation_blocked ("not in allowedNavigationOrigins"); account_register → unauthorized_target (not in RBA_AUTHORIZED_TARGETS). Refused before any job/inbox creation.
- Site 3 parabank.parasoft.com: same two refusals.
- No page loaded, so no inspection, signup, email, login, restoration or deletion possible. No fallback to Chrome/Playwright used.
- Session closed ($0.0033 prelim). inbox_list / account_list empty; no new jobs.

## Re-run of sites 2 & 3 after config change (09:31Z)
- config_check: authorizedTargets now lists automationexercise.com, practice.expandtesting.com, parabank.parasoft.com.
  config_check does NOT surface RBA_ALLOWED_ORIGINS (navigation allowlist); confirmed instead via the env file and
  session_start.allowedNavigationOrigins (sess_df023b3801f24baf), which listed both new origins. That gap is why the
  earlier run looked misconfigured even though the signup list was what mattered for account_register.
- Inspection sess_df023b3801f24baf: both register pages loaded (200). Neither asks for an email; both log in by username.
  browser_fill has no username secret, so usernames are literals (non-secret), recorded here.

## Site 2 practice.expandtesting.com — PASS (with a plugin false negative)
- Username rbaexp1cd1b9. account_register job_eb7142b2d69d48b3, acct_ef40fbe6ada74c3b, remote_direct, disposable inbox (unused),
  verification.required=false, synthetic. Submitted 09:33:27Z, redirected to /login (the site's normal post-signup redirect).
- Job reported failed/rejected: rejectedText "Invalid" matched static text on the /login page. This was MY overly broad
  rejectionTexts entry, not a site rejection. Account was auto-quarantined; quarantine lifted manually (reason recorded).
  Finding: rejection matching scans the whole page, so generic words on a redirect target produce false negatives.
- Credential login sess_dd1e64b592344e38 (restoredBrowserState=false) 09:34Z: /secure shows "Hi, rbaexp1cd1b9!".
  Password via secret ref only. Screenshot site2-credential-login.png (shot_3e2e8d97bfc94656).
- Logout (/logout → /login) and re-login → /secure. session_save_state 09:34:45Z (3 cookies); closed without logout.
- Restoration sess_8d303609f47f4eec restoredBrowserState=true, ZERO fills: /secure shows "Hi, rbaexp1cd1b9!".
  Screenshot site2-restored-session.png (shot_c40cc8b8c32543a8).
- Deletion: no account-deletion UI on the site (secure area offers only Logout). Website account remains.
  account_delete(deleteInbox): localRecordDeleted=true, inbox deleted, websiteAccount "not_deleted" (plugin's own caveat).
- Elapsed register → cleanup ≈ 3 min. Human interventions: none (one manual quarantine lift via plugin tool).

## Site 3 parabank.parasoft.com — BLOCKED at signup submit
- Username rbapbc863a1, all other fields obvious fixture data (000-00-0000 SSN, 555-0100 phone, 00000 zip).
  Submit selector input[type="submit"][value="Register"] (page also has a "Log In" submit).
- account_register job_cec5b66802b24faa, acct_deb3ef33fc7c41bc, remote_direct, disposable inbox (unused).
  Submitted 09:35:46Z → HTTP 403 on register.htm, plugin classified blocked=human_verification and stopped (no resubmit).
- Account status blocked → not leasable, so credential login / restoration could not be tested. Block left in place.
- Characterisation sess_a55b60a3f63d49b8 (different egress IP 35.175.201.170): GET index.htm → 200, normal page.
  So the site blocks the signup POST from the datacenter egress, not page loads. Screenshot site3-get-ok-post-blocked.png.
- Unknown whether the account was created server-side (403 after POST). Not verified.
- Not tried: remote_proxy residential re-submission (would be a second submit; needs user decision).
- Cleanup: account_delete(deleteInbox) → local record + inbox deleted.

## Final state (09:37Z)
- account_list [], email_inbox_list [], session_status [] (no active sessions).
- Session cost (prelim, closed sessions only): ~$0.012 across 4 sessions; the 2 register-job sessions are not included.

## Site 3 parabank.parasoft.com — retry via residential proxy (user approved resubmit, 09:38Z) — PASS
- The blocked record acct_deb3ef33fc7c41bc was already deleted locally, so nothing to unblock. Whether rbapbc863a1 exists
  server-side from the 403 attempt remains unverified.
- New username rbapb9d9db2. account_register job_66543f35e41c4f7b, acct_ad852f27adde4101, mode remote_proxy
  {kind: residential, country: US} via Apify. Submitted 09:38:32Z → 200, "Your account was created successfully" → completed/confirmed.
- Credential login sess_c7cf7aef7a6843b6 (restoredBrowserState=false), route verified, egress 74.219.47.98 (residential) vs
  container 100.53.242.88. Accounts Overview "Welcome Testy Fictional" (site-seeded acct 14565, $515.50).
  Screenshot site3-credential-login.png (shot_330ea106d2014de6).
- Logout (logout.htm → index.htm) and re-login → overview.htm. session_save_state 09:39:14Z (1 cookie, JSESSIONID); closed without logout.
- Restoration sess_384bc59bc74141f9 restoredBrowserState=true, ZERO fills, new worker (container 35.175.201.170, same residential
  egress): overview.htm shows "Welcome Testy Fictional". Screenshot site3-restored-session.png (shot_8dfeeeb6ea934150).
- Deletion: no account-deletion UI on ParaBank (shared demo DB, reset periodically). Logged out; website account remains.
  account_delete(deleteInbox): local record + inbox deleted, websiteAccount "not_deleted".
- Finding: ParaBank 403s the signup POST from Apify datacenter egress but accepts it from residential; GETs work from both.

## Final state (09:40Z)
- account_list [], email_inbox_list [], session_status [] (no active sessions).

## Clarifications (added after review, 2026-10-27; earlier entries left as written)
- Site 2 "Human interventions: none (one manual quarantine lift via plugin tool)" is inaccurate wording: there was no manual
  browser input, but there WAS an operator-agent intervention (quarantine lift overriding the plugin's verdict).
- Site 3 is not an uninterrupted autonomous success: attempt 1 was blocked (403/human verification); attempt 2 ran only after
  explicit user approval to resubmit through a residential proxy. No CAPTCHA or challenge was solved.
- "Final state" entries describe LOCAL state only. External accounts remain: rbaexp1cd1b9 (expandtesting) and rbapb9d9db2
  (parabank) confirmed, no delete option on either site; rbapbc863a1 (parabank) status unknown.
- All runs used build 0.1.0+7b11081. The three limitations (config_check hides RBA_ALLOWED_ORIGINS, whole-page rejection
  matching, no username credential reference) were present and were not changed.

## Recorded demo run — automationexercise.com, execution mode local (2026-10-27 09:51:45–09:52:36Z)
- Build 0.1.0+7b11081.dirty (commit 7b11081 + uncommitted RBA_LOCAL_RECORD_VIDEO_DIR recording change). Separate from the
  remote_direct runs above; those used the unmodified build.
- Pre-run: unrecorded remote_direct session sess_a06c493eb017416b checked selectors (signup step 1 submitted with an example.com
  placeholder, page 2 inspected, NOT submitted; no account created).
- job_26e64955950d4193, acct_f42cdf75f73f43e1, mode local, disposable inbox (unused; site sends no email), synthetic "Alex Demo".
  "Account Created" observed 09:51:49Z. Worker 1 sess_ed0f9311a0b44ce7: logout, credential re-login ("Logged in as Alex Demo"),
  session_save_state 09:52:09Z (2 cookies), closed without logout.
- Worker 2 sess_7d14cf824ccb486a restoredBrowserState=true, zero fills: "Logged in as Alex Demo". Site "Delete Account" →
  "ACCOUNT DELETED!"; credential login afterwards → "Your email or password is incorrect!".
- account_delete(deleteInbox): local record + inbox deleted. account_list / email_inbox_list / session_status empty.
- No retries, no human or operator intervention during the run. Videos and run log: docs/demo/.
