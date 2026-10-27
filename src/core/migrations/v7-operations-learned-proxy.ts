/**
 * v7: adds operations.learned_proxy_json where it is missing.
 *
 * The column was first added by editing the v3 CREATE TABLE after v3 had already
 * been applied to at least one real registry, so databases migrated through the
 * original v3 never received it (found live: "table operations has no column named
 * learned_proxy_json"). Applied migrations are never edited again; this one is
 * idempotent (fresh databases already have the column from v3).
 */
import { addColumn, type Migration } from '../migrations.js';

export const v7: Migration = {
  version: 7,
  name: 'operations_learned_proxy',
  up(sql) {
    addColumn(sql, 'operations', 'learned_proxy_json', 'TEXT');
  },
};
