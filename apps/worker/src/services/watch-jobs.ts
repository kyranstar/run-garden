/**
 * THE WATCH'S OWN JOBS, as SQL (the targeted drain's, ruling 3-R11; the watch mirrors the plan §3.7, §3.9). A leaf — only
 * the schema — so the drain (jobs.ts), the sheet's watch state (watch-push.ts) and the account line (sync-status.ts) say
 * the same jobs without importing one another.
 */
import { and, eq, like, or, type SQL } from "drizzle-orm";
import { corosWriteJobs } from "@rg/database";

/** The one delete of an adopted row's old copy (`adoptedCopyUnpush`): its id's suffix, which the import reads as "in flight". */
export const ADOPTED_COPY_JOB_SUFFIX = "-unpush-copy";

/** A job on its way: queued, claimed, running, or being read back. */
export const WATCH_JOB_UNDERWAY = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * A program push (`push:<buildId>` — a day build's, or a provisional copy's, `provisional: true`, the same kind), a sent
 * build's delete (`unpush:<buildId>`) and an adopted row's held copy's delete (`<id>-unpush-copy`). Not a coach job, nor
 * an address-path delete (`<id>-unpush`): those are the lanes'. One SQL condition on `coros_write_jobs`.
 */
export function watchJobCondition(): SQL {
  return or(
    eq(corosWriteJobs.kind, "program_session_push"),
    and(
      eq(corosWriteJobs.kind, "coach_delete_workout"),
      or(like(corosWriteJobs.id, "unpush:%"), like(corosWriteJobs.id, `%${ADOPTED_COPY_JOB_SUFFIX}`)),
    ),
  )!;
}
