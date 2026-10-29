/**
 * WHAT THE MIRROR HOLDS, FROM THE ROW ALONE (the watch mirrors the plan §3.1–§3.3, §3.6): the pure refusals the mirror
 * answers before it reads anything — the switch, the athlete's writes, kept off, the kind of session, resolved, the day.
 * A leaf, apart from the mirror itself (mirror.ts imports session-build and watch-push), so the sheet's watch state
 * (watch-push.ts `watchStateOf`) asks the same rules without closing an import cycle through them.
 */
import { addDays, appAuthoredRow, docOriginRow } from "@rg/domain";
import type { plannedWorkouts } from "@rg/database";
import { watchPushEnabled, type Env } from "../env.js";
import type { BuildCtx } from "./session-build.js";

/** The mirror's window: today … today + 28 days (§3.2). */
export const MIRROR_WINDOW_DAYS = 28;

/** The row fields the rules read (a planned workout as stored). */
export type MirrorRow = typeof plannedWorkouts.$inferSelect;

/** What the row alone refuses the mirror (a subset of mirror.ts `MirrorSkip`). */
export type MirrorRowRefusal =
  | "switch_off"
  | "writes_off"
  | "kept_off"
  | "not_document"
  | "resolved"
  | "past"
  | "beyond_window"
  | "not_mirrored"
  | "not_today";

/** The ctx the rules read: the athlete's writes and today. */
type RuleCtx = Pick<BuildCtx, "today"> & { prefs: Pick<BuildCtx["prefs"], "corosWritesEnabled"> };

// Spelled out (doc-workouts.ts imports the mirror's importer): a workout started at once — Start now, played offline.
const STARTED_AT_ONCE: readonly string[] = ["app_only", "app_only_offline"];

/**
 * A session of a kind the mirror holds (§3.1): the app's own (`appAuthoredRow`: a programme's slot, an on-demand session,
 * a Studio or template workout) — not a run, a rest day or a race, nor a workout started at once (M5). The coach's own
 * sessions and designed runs mirror in their lane.
 */
export const mirroredKind = (row: Pick<MirrorRow, "origin" | "sport" | "category" | "calendarSyncState">): boolean =>
  appAuthoredRow(row) && row.sport !== "run" && row.category !== "rest" && row.category !== "race" && !STARTED_AT_ONCE.includes(row.calendarSyncState);

/** Done, skipped, missed, under way or archived: the copy stays as it is (a done session's is what the athlete did). */
const resolvedRow = (row: MirrorRow): boolean =>
  row.archivedAt !== null || row.completionState !== "scheduled" || row.contentState === "started" || row.contentState === "done";

/**
 * A PROVISIONAL COPY'S refusals (§3.2): the switch, the writes, kept off, not a document workout (a run is never one —
 * the Studio refuses it — nor a rest day or a race; a designed run is the coach lane's, origin null, and mirrors there),
 * resolved, a day gone, beyond the window.
 */
export function rowRefusal(row: MirrorRow, env: Env, ctx: RuleCtx): MirrorRowRefusal | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  if (!docOriginRow(row) || row.workoutDoc === null || row.workoutDocRev === null || row.sport === "run" || row.category === "rest" || row.category === "race") {
    return "not_document";
  }
  if (resolvedRow(row)) return "resolved";
  if (row.effectiveDate < ctx.today) return "past";
  if (row.effectiveDate > addDays(ctx.today, MIRROR_WINDOW_DAYS)) return "beyond_window";
  return null;
}

/**
 * A DAY'S BUILD's refusals (§3.3): the switch, the writes, kept off; not a session the mirror holds on its day
 * (`not_mirrored`: not the app's — the coach's sessions and designed runs mirror in their own lane — a run, a rest day, a
 * race, or a workout started at once, M5); resolved; a day other than today. A document workout and an engine slot alike.
 */
export function dayRowRefusal(row: MirrorRow, env: Env, ctx: RuleCtx): MirrorRowRefusal | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  if (!mirroredKind(row)) return "not_mirrored";
  if (resolvedRow(row)) return "resolved";
  if (row.effectiveDate < ctx.today) return "past";
  if (row.effectiveDate > ctx.today) return "not_today";
  return null;
}
