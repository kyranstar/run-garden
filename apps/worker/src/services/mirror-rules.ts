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

/** A failed push's re-queues (M3): after 1 h, then 6 h, then 24 h; a fourth failure stops. */
export const MIRROR_RETRY_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000] as const;

/** The row fields the rules read (a planned workout as stored). */
export type MirrorRow = typeof plannedWorkouts.$inferSelect;

/**
 * A row as the rules can read it: the planned workout, its document when the read carried it (a read without it — the
 * Plan's rows — has its revision, which a stored document always has).
 */
export type RuleRow = Omit<MirrorRow, "workoutDoc"> & { workoutDoc?: string | null };

/**
 * What the mirror remembers of a session it could not push for a reason only making the copy shows — on its owed mark's
 * payload, for that revision and day, so the sweep does not make the record again every run, and one session never holds
 * the window up. A new owed mark, a revision or a move forgets it.
 *  - `too_long`, `not_document`: for good (for that revision and day).
 *  - `today_checked` (M1): for that revision and today — the day's build is the copy, pushed on its next build; a session
 *    of today judged so is not judged again by every sweep that day (it would spend the run's one attempt each hour).
 *  - `error` (an unexpected throw while the copy was prepared; its message's first 120 characters): for a while — `at`
 *    the last one, `count` how many in a row — on MIRROR_RETRY_BACKOFF_MS (1 h, 6 h, 24 h, then `gave_up`), so a
 *    transient failure heals and a persistent one cannot stall the account.
 */
export interface MirrorMemory {
  refused: "too_long" | "not_document" | "error" | "today_checked";
  rev: number | null;
  day: string;
  message?: string;
  at?: string;
  count?: number;
}

/** The memory on an owed mark's payload, if it is one. */
export function memoryOf(payload: unknown): MirrorMemory | null {
  const m = (typeof payload === "string" ? safeJson(payload) : payload) as Partial<MirrorMemory> | null;
  if (!m || (m.refused !== "too_long" && m.refused !== "not_document" && m.refused !== "error" && m.refused !== "today_checked") || typeof m.day !== "string") {
    return null;
  }
  return {
    refused: m.refused,
    rev: typeof m.rev === "number" ? m.rev : null,
    day: m.day,
    ...(typeof m.at === "string" ? { at: m.at } : {}),
    ...(typeof m.count === "number" ? { count: m.count } : {}),
  };
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The memory of this row's revision and day, if `memory` is one (a revision or a move forgets it). */
export const memoryFor = (memory: MirrorMemory | null | undefined, row: Pick<MirrorRow, "workoutDocRev" | "effectiveDate">): MirrorMemory | null =>
  memory && memory.rev === row.workoutDocRev && memory.day === row.effectiveDate ? memory : null;

/**
 * THE SWEEP'S ERROR LADDER RAN OUT for this row's revision and day (`verdictOf`'s `gave_up`): three throws in a row while
 * the copy was prepared, so the sweep makes it no more until a change marks the session owed again (which forgets it).
 */
export function errorsGaveUp(memory: MirrorMemory | null | undefined, row: Pick<MirrorRow, "workoutDocRev" | "effectiveDate">): boolean {
  const known = memoryFor(memory, row);
  return known?.refused === "error" && MIRROR_RETRY_BACKOFF_MS[(known.count ?? 1) - 1] === undefined;
}

/** A push as the re-queue rule reads it: its day, the revision it was made from (null: it does not say), its re-queues. */
export interface RequeuedPush {
  happenDay: string;
  fromDocRev: number | null;
  /** The mirror's re-queues of it after it failed (`$.mirrorRetries`). */
  retries: number;
}

/** A push of the row's own day and revision — or one that does not say its revision: the one the sweep would re-queue. */
export const pushOfRowNow = (p: Pick<RequeuedPush, "happenDay" | "fromDocRev">, row: Pick<MirrorRow, "workoutDocRev" | "effectiveDate">): boolean =>
  p.happenDay === row.effectiveDate && (p.fromDocRev === null || p.fromDocRev === row.workoutDocRev);

/** Re-queues left on the ladder (M3): a push re-queued three times is left (`gave_up`). */
export const requeuesLeft = (retries: number): boolean => MIRROR_RETRY_BACKOFF_MS[retries] !== undefined;

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

// Spelled out (doc-workouts.ts imports the mirror's importer): a workout started at once — Start now, played offline
// (`calendar_sync_state`, doc-workouts.ts `STARTED_AT_ONCE_STATES`). The sweep's SQL reads it too (mirror.ts).
export const STARTED_AT_ONCE: readonly string[] = ["app_only", "app_only_offline"];

/**
 * A session of a kind the mirror holds (§3.1): the app's own (`appAuthoredRow`: a programme's slot, an on-demand session,
 * a Studio or template workout) — not a run, a rest day or a race, nor a workout started at once (M5). The coach's own
 * sessions and designed runs mirror in their lane.
 */
export const mirroredKind = (row: Pick<MirrorRow, "origin" | "sport" | "category" | "calendarSyncState">): boolean =>
  appAuthoredRow(row) && row.sport !== "run" && row.category !== "rest" && row.category !== "race" && !STARTED_AT_ONCE.includes(row.calendarSyncState);

/** Done, skipped, missed, under way or archived: the copy stays as it is (a done session's is what the athlete did). */
const resolvedRow = (row: RuleRow): boolean =>
  row.archivedAt !== null || row.completionState !== "scheduled" || row.contentState === "started" || row.contentState === "done";

/**
 * A PROVISIONAL COPY'S refusals (§3.2): the switch, the writes, kept off, not a document workout (a run is never one —
 * the Studio refuses it — nor a rest day or a race; a designed run is the coach lane's, origin null, and mirrors there),
 * a workout started at once (`not_mirrored`, M5: Start now, played offline — it is played on the phone, even when the
 * app closed before Start), resolved, a day gone, beyond the window. (A read without the document is judged by its
 * revision.)
 */
export function rowRefusal(row: RuleRow, env: Env, ctx: RuleCtx): MirrorRowRefusal | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  if (!docOriginRow(row) || row.workoutDoc === null || row.workoutDocRev === null || row.sport === "run" || row.category === "rest" || row.category === "race") {
    return "not_document";
  }
  if (STARTED_AT_ONCE.includes(row.calendarSyncState)) return "not_mirrored";
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
export function dayRowRefusal(row: RuleRow, env: Env, ctx: RuleCtx): MirrorRowRefusal | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  if (!mirroredKind(row)) return "not_mirrored";
  if (resolvedRow(row)) return "resolved";
  if (row.effectiveDate < ctx.today) return "past";
  if (row.effectiveDate > ctx.today) return "not_today";
  return null;
}
