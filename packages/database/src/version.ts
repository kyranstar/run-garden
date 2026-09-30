/**
 * The schema an export belongs to: the highest numbered migration in
 * `packages/database/migrations`. A restore refuses a file stamped with any
 * other value. The Worker cannot list the migrations directory at runtime, so
 * this is a constant; `test/schema-version.test.ts` fails when a migration is
 * added without bumping it.
 */
export const SCHEMA_VERSION = "0022";
