/**
 * v6 (W1 follow-up, saved-operation privacy). Additive only: new nullable
 * columns on `operations`; no row is rewritten.
 *
 *  - privacy_version: the privacy rules the stored spec was checked against
 *    (src/operations/privacy.ts). NULL = saved before them: such an operation
 *    is never callable (delete and re-learn it). Its private record keeps the
 *    older encryption binding; version 1+ binds the private record to the
 *    operation id AND its scope (account id, or public).
 *  - bound_origin: the account's target origin when the operation was learned
 *    (NULL for public operations). A call is refused once the account's
 *    origin differs.
 *  - bound_route_json: {mode, proxyKind} of the learning session, which for an
 *    account operation is the account's route. A call is refused in another
 *    mode or proxy kind, or once the account's route changed.
 *
 * Slot note: docs/dev/INTERFACES.md §3 reserved v6 for W4 (install metadata,
 * "only if needed"); the lead assigned v6 to this change.
 */
import { addColumn, type Migration } from '../migrations.js';

export const v6: Migration = {
  version: 6,
  name: 'operations_privacy',
  up(sql) {
    addColumn(sql, 'operations', 'privacy_version', 'INTEGER');
    addColumn(sql, 'operations', 'bound_origin', 'TEXT');
    addColumn(sql, 'operations', 'bound_route_json', 'TEXT');
  },
};
