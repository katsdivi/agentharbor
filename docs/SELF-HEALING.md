# Saved-operation self-healing: what exists and what does not

Audit as of the stabilization round (2026-10-13). Retries and re-learning are **not** a validated repair system, and nothing here
claims one. File references are to `src/operations/`.

| Capability | Status | Evidence / behaviour |
|---|---|---|
| Failure classification | **Implemented** | the vendored `judge` classifies a call as ok / drift / auth / rate / blocked / input / error (`vendor/api-anything/classify.ts`), and `service.ts` decides from it whether the browser may be used as a fallback (tier 3, `/capture`, in the same mode and session) |
| Bounded repair | **Implemented** | one re-learn per call, only with `allowRepair`; 30 min cooldown and at most 3 per 24 h per operation (`store.ts` `takeRepair`) |
| Unchanged account / origin / action scope on repair | **Implemented** | repair reuses the stored trigger, examples and `readOnly` declaration; it runs only in the operation's bound account/route; a re-learned request with a different origin or method is refused; the privacy gate runs again |
| Candidate operation version | **Missing** | repair **overwrites** the stored spec (`store.ts` `replaceSpec`), and the previous spec is lost; to limit the damage, a changed request shape sets the operation to `needs_review`, so it cannot be called until reviewed again |
| Semantic output validation | **Missing (shape only)** | `operation_validate` compares key paths and types of the result with the learned shape and refuses the learning examples as inputs. It does not check meaning (whether the right records were returned, counts, an echo of the argument) |
| Promotion history | **Missing** | only the latest `reviewed_at` / `reviewed_sha256` is kept, and it is overwritten |
| Rollback or disablement after regression | **Missing** | a `disabled` status exists and is honoured, but nothing sets it automatically, and there is no rollback because the old spec is not kept |

## Plan for the missing pieces (not built in this round)

1. **Version table.** Add `operation_versions` (spec, sha, source `learn`/`repair`, status `candidate`/`active`/`retired`, review fields, note) in a new migration.
2. **Repair creates candidates.** Repair writes a candidate; the active version keeps serving until a candidate is promoted.
3. **`operation_promote`.** Requires a review bound to the candidate's sha.
4. **Validation gate.** Promotion requires `operation_validate` to pass on the candidate with inputs different from its examples.
5. **`operation_rollback`.** Re-activates the previous version and records why.
6. **Pin calls to a version.** Record the active `spec_sha` in `operation_calls`, so a regression is tied to a version.
7. **Auto-disable.** After N consecutive drift or auth failures on the active version, disable the operation with a `status_reason`; `operation_enable` requires a review.
8. **Semantic invariants.** Declared at review: non-empty, argument echoed in results, count bounds, required fields, and a digest of the reviewed sample's field types or values.
9. **Same gates for candidates.** The privacy gate and the account/route binding apply to every candidate.
10. **Visible history.** `operation_list` shows the version history; `run_report` names the version used.
