/**
 * User-visible state machines. Keep these small and understandable; raw
 * provider terminology never leaks into primary UI.
 */

/** Alignment between Run Garden's intended schedule and the COROS calendar. */
export type CorosSyncState =
  | "synced" // COROS agrees with Run Garden; verified by read or write
  | "syncing" // a provider operation is actively being attempted
  | "waiting_for_device" // queued; no COROS connection to run it
  | "calendar_only" // a local date change exists that COROS doesn't have (writing unavailable or disabled)
  | "needs_attention" // legacy — no longer produced; healed by migration
  | "sync_issue"; // terminal write failure; user can retry

export const COROS_SYNC_LABELS: Record<CorosSyncState, string> = {
  synced: "Synced",
  syncing: "Syncing",
  waiting_for_device: "Waiting for COROS",
  calendar_only: "Not synced to COROS",
  needs_attention: "Needs attention",
  sync_issue: "Sync issue",
};

/**
 * The per-workout view the API DERIVES (`sync-status.ts` `deriveWorkoutSync`),
 * as opposed to the `coros_sync_state` column above.
 *
 * A superset by exactly one member, and the member is the reason the type had
 * to fork. `CorosSyncState` is a claim about a session's DATE — every one of
 * its six values compares "where Run Garden has it" with "where COROS has it"
 * — so the derivation could return `synced` for a session whose date matched
 * while the coach had rewritten its content underneath. There is no COROS job
 * kind that writes content, so nothing was pending, nothing was failed, and
 * the athlete was told their calf-sparing 30 minutes was on their watch when
 * the watch held 5×3min at threshold.
 *
 * `content_stale` is that case, and it is a different sentence from
 * `calendar_only`: "on your watch, but the version there is older" versus
 * "not sent yet". Keeping it out of `CorosSyncState` keeps it out of the
 * stored column, which no writer should ever put it in — it is not a fact
 * about the calendar, and it is recomputed from the open content intent on
 * every read.
 */
export type WorkoutSyncView = CorosSyncState | "content_stale";

/** Relationship between a planned workout and its managed Calendar event. */
export type CalendarSyncState =
  | "not_created" // no managed event yet (e.g. Calendar not connected)
  | "synced" // event exists and matches intended schedule
  | "pending" // local change not yet pushed to Calendar
  | "user_deleted" // user deleted the managed event; do not recreate
  | "error"; // last Calendar operation failed

/** Completion lifecycle of a planned workout. */
export type CompletionState =
  | "scheduled" // in the future, or within the post-window sync grace period
  | "unresolved" // window passed, no match found, user not yet asked/answered
  | "completed" // matched and merged
  | "skipped" // user explicitly skipped
  | "missed"; // user confirmed it did not happen, or unresolved for too long

/** How a COROS write was ultimately performed (diagnostics only). */
export type CorosWritePath = "official_api" | "direct_update" | "remove_and_add";

/** Watch sync truthfulness: we can verify the COROS calendar, not the watch. */
export type WatchSyncState = "calendar_verified_watch_unverified" | "unknown";
