# Saved read operations: privacy and limits

Saved operations (`operation_learn`, `operation_review`, `operation_call`, `operation_validate`, `operation_list`, `operation_delete`) are off unless `RBA_OPERATIONS_ENABLED=true`. This page covers what a saved operation stores, who can run it, and what it can't do yet.

## What is stored

- **The spec** (`operations.spec_json`): the request template with every place an argument fills left blank. It also holds the page that triggers the request, the response recipe, and the shape of the result (key paths and types only).
- **References, not values.** Cookies and per-session values are references to the account's browser session. Account-specific literals in an account operation's request become **account constants**: references (`session:rba-account/<n>`) whose values live in the private record. Examples are user ids, workspace ids, the account's email, and other ids or tokens in the path, query, headers or body.
- **The private record** (`operation_private`) is vault-encrypted (`RBA_ENCRYPTION_KEY`). It holds the two example argument sets, the session values and the account constants. Since migration v6 it is bound to the operation id, its scope (the account, or public), the account's target origin and the learned route. A record copied to another row or account doesn't decrypt.
- **The call log** (`operation_calls`) holds the outcome class, tier, mode and duration. It never holds arguments or data.

## Who can run it

- **Account operations** are bound to the account, its target origin and its execution route (mode, plus proxy kind for `remote_proxy`). A call is refused:
  - in another account's session;
  - in a session without an account;
  - in another mode or proxy kind;
  - after the account's target origin or route has changed.
  To fix it, delete the operation and learn it again.
- **Public operations** are learned and run only in sessions without an account. A public save is refused when anything it would store, or any fixed value it would replay, looks private. That covers:
  - an email, UUID, JWT or long random token;
  - an email or inbox id of any account in this registry;
  - a cookie or storage value of the learning session.
  Places a parameter fills don't count. To fix it, learn the operation in the account it belongs to, or choose examples so those places become parameters.
- An account operation is also refused when a private-looking literal sits somewhere it can't become a reference: the trigger URL, trigger steps, description, response recipe, a JSON key, or a numeric JSON value.
- Operations saved before these rules (`privacy_version` NULL) can't be called or reviewed. Delete them and learn them again.

## No export, no cross-account reuse

There is no way yet to prove that a spec carries nothing of the account it was learned in, so:

- `operation_list` with `includeSpec` returns only the review summary, with private-looking literals redacted (`privateLiteralsRedacted` counts them) and `exportable: false`. It never returns the request template.
- No tool exports, imports, copies or shares an operation. An operation can't be reused in another account. Learn it there instead.
- Learner warnings, error messages, failure reasons and repair reasons of the operation tools are redacted locally. That covers private-looking literals, the operation's account constants and, for account operations, id-like tokens. Only true secrets go to the process-wide redactor: cookie values, and token-, JWT- or random-looking session values. Account identifiers (emails, UUIDs, numeric ids) do not, so `account_list` and returned page data still show the account's own email.
- `migrate-data` copies the whole install (database, `.env` and key) to a new folder on the same computer. It moves the install; it doesn't export operations.

## Known limits

- Detection works on the shape of a value plus the private values this install knows. A short, plain-word account identifier is not detected unless it is known: for example a username like `alice` that appears in no account email and in no cookie or storage value. Review the summary before `operation_review`.
- In account operations, numeric ids (6+ digits) and mixed ids (6+ characters with 2+ digits and a letter) become account constants. In public operations, only the strict set (email, UUID, JWT, long token, known values) is refused. A constant numeric id in a public request is kept.
- Repair re-learns into the same row and needs a new review. It applies the same privacy rules, and it keeps the request's origin and method. There are no candidate versions, history or rollback yet.
