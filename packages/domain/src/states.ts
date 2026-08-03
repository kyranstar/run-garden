/**
 * User-visible state machines. Keep these small and understandable; raw
 * provider terminology never leaks into primary UI.
 */

/** Alignment between Run Garden's intended schedule and the COROS calendar. */
export type CorosSyncState =
  | "synced" // COROS agrees with Run Garden; verified by read or write
  | "syncing" // a provider operation is actively being attempted
  | "waiting_for_device" // queued; desktop bridge offline ("Waiting for Mac")
  | "calendar_only" // a local date change exists that COROS doesn't have (writing unavailable or disabled)
  | "needs_attention"; // conflict, failed verification, or ambiguity

export const COROS_SYNC_LABELS: Record<CorosSyncState, string> = {
  synced: "Synced",
  syncing: "Syncing",
  waiting_for_device: "Waiting for Mac",
  calendar_only: "Not synced to COROS",
  needs_attention: "Needs attention",
};

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
  | "provisionally_completed" // matched via Strava; richer COROS record awaited
  | "completed" // matched and merged
  | "skipped" // user explicitly skipped
  | "missed"; // user confirmed it did not happen, or unresolved for too long

/** How a COROS write was ultimately performed (diagnostics only). */
export type CorosWritePath = "official_api" | "direct_update" | "remove_and_add";

/** Watch sync truthfulness: we can verify the COROS calendar, not the watch. */
export type WatchSyncState = "calendar_verified_watch_unverified" | "unknown";
