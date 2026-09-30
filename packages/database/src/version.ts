/**
 * The schema an export belongs to: the highest numbered migration in
 * `packages/database/migrations`. A restore accepts a file stamped with this
 * value or an older one (every migration so far only adds; the restore's check
 * refuses any table or column the file holds that no longer exists) and
 * refuses a newer one. The Worker cannot list the migrations directory at runtime, so
 * this is a constant; `test/schema-version.test.ts` fails when a migration is
 * added without bumping it.
 */
export const SCHEMA_VERSION = "0023";
