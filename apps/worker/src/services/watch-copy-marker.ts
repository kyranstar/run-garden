/**
 * THE "TAKE THE WATCH'S COPY" MARK on a row's `source_content_fingerprint` (watch-version.ts `keepWatchVersion`): the
 * athlete chose the watch's version, and the next COROS read that sees the session rewrites the row from the wire.
 *
 * The mark keeps the fingerprint it replaced — `take-watch-copy:<what the app last observed on the wire>` — because
 * that is still what the watch holds: a move made before the read guards against it (jobs.ts `enqueueMoveJob`), a new
 * change of the app's restores it (`unmarkedFingerprint`: the app's claim is live again, and its rewrite proves
 * ownership by it), and a verified move keeps the mark over what it observed (`keepsMark`), so the read still takes the
 * watch's copy. The import reads the mark as content it no longer agrees with (rule 7), and drops the row's lift or
 * mobility structure as it adopts (import-plan.ts).
 *
 * No other module of the app's: every job kind and the import read it from here.
 */
import { sql, type SQL, type AnyColumn } from "drizzle-orm";

export const TAKE_WATCH_COPY = "take-watch-copy";
const PREFIX = `${TAKE_WATCH_COPY}:`;

/** The row carries the mark. */
export function takesWatchCopy(fingerprint: string | null | undefined): boolean {
  return typeof fingerprint === "string" && (fingerprint === TAKE_WATCH_COPY || fingerprint.startsWith(PREFIX));
}

/** What the watch holds, as last observed: the mark's own fingerprint, or the fingerprint itself when unmarked. */
export function watchCopyBase(fingerprint: string): string {
  if (fingerprint.startsWith(PREFIX)) return fingerprint.slice(PREFIX.length);
  return fingerprint === TAKE_WATCH_COPY ? "" : fingerprint;
}

/** SQL: the column marked — once (a second keep keeps the first mark's fingerprint). */
export function markedFingerprint(column: AnyColumn): SQL {
  return sql`case when ${column} like ${`${TAKE_WATCH_COPY}%`} then ${column} else ${PREFIX} || ${column} end`;
}

/** SQL: the column unmarked — the fingerprint the mark kept, or the column as it is. */
export function unmarkedFingerprint(column: AnyColumn): SQL {
  return sql`case when ${column} like ${`${TAKE_WATCH_COPY}%`} then substr(${column}, ${PREFIX.length + 1}) else ${column} end`;
}

/** SQL: a newly observed fingerprint, under the column's mark when it carries one. */
export function keepsMark(column: AnyColumn, observed: string): SQL {
  return sql`case when ${column} like ${`${TAKE_WATCH_COPY}%`} then ${PREFIX} || ${observed} else ${observed} end`;
}

/**
 * What the import writes beside its own rewrite when it adopts the watch's copy for a marked row: the app's lift or
 * mobility structure goes (the wire's copy never has one, and the sheet would read the eased movements first). Kept
 * until then, so nothing of the app's copy is lost if no read ever comes.
 */
export function adoptsWatchCopy(row: { sourceContentFingerprint: string }): { structuredJson?: null } {
  return takesWatchCopy(row.sourceContentFingerprint) ? { structuredJson: null } : {};
}
