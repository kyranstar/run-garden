/**
 * WHAT TO DO ABOUT IT — the second half of every sync disclosure.
 *
 * The athlete's words, and the whole reason this file exists: *"we need it
 * always in sync, or clearly tells me when its not and what to do to fix it."*
 *
 * Run Garden had built the first half twice over. `watchCoverage` says what the
 * wire cannot carry; the `content_stale` view says the watch is holding a
 * version the app replaced; the pill says "Older on watch"; the banner names
 * the date. Every one of those states THAT something is off. Not one of them
 * says WHAT TO DO, so all of them read the same way — as a warning — including
 * the majority that need nothing from the athlete at all.
 *
 * So every situation resolves to exactly one action, and the action names its
 * AGENT first:
 *
 *   · `app`     — Run Garden is fixing it. A state that needs no human must not
 *                 read like a warning; it reads like a receipt.
 *   · `athlete` — one thing, in their words, on the session it concerns.
 *   · `nobody`  — it cannot be fixed, and saying so plainly is the answer. This
 *                 is the one that took discipline: an earlier build offered a
 *                 "Retry" that enqueued nothing and left an unclearable badge,
 *                 which is what a fabricated action costs.
 *
 * A FULLY SYNCED SESSION HAS NO ACTION. `syncAction` returns null, the DTO omits
 * the field, and every surface renders exactly what it rendered before.
 *
 * The words live in the UI (`syncActionCopy`), the same split
 * `watchCoverageSentences` already uses: this file decides what is true, one
 * function decides how to say it, and no surface writes its own sentence.
 */
import type { WorkoutSyncView } from "./states.js";
import type { WatchCoverageView } from "./watch-coverage.js";

/** Who has to do something for this session to be in sync. */
export type SyncActor = "app" | "athlete" | "nobody";

export type SyncActionCode =
  // ── the app is doing it ───────────────────────────────────────────────────
  /** A create, a move or a content rewrite is queued or running. */
  | "sending"
  /** The app's new version cannot cross the wire, so the watch's stale copy is
   * being REMOVED rather than left prescribing withdrawn work. Queued or
   * running (`coach_delete_workout`). */
  | "removing_from_watch"
  /** On the watch, but with steps and no pace targets, because Run Garden does
   * not know the athlete's threshold pace yet. It arrives from COROS on its
   * own, and the convergence lane re-pushes when it does. */
  | "pace_targets_pending"
  // ── the athlete has to do one thing ──────────────────────────────────────
  /** Something is waiting on a COROS connection that is not there. */
  | "connect_coros"
  /** Watch updates are off in Settings, so nothing Run Garden decides can
   * reach the watch. Deliberately NOT worded as "and then this session goes" —
   * turning them on changes what happens NEXT; it does not re-send this. */
  | "enable_coros_writes"
  /** A write failed terminally AND a control exists that genuinely enqueues
   * another one. Never produced when the only available control would enqueue
   * nothing. */
  | "retry_write"
  /** COROS and Run Garden hold this session on different days and neither is
   * authoritative — the athlete picks. */
  | "choose_a_date"
  /** A run measured in distance: the watch needs timed steps. */
  | "make_it_measurable"
  /**
   * Movements the athlete's COROS library has no id for — and since strength
   * pushes opened up (2026-08-17) this is the ONE thing keeping the session off
   * the watch, so it is genuinely actionable rather than a footnote on a
   * discipline that could never travel.
   */
  | "name_it_on_the_watch"
  // ── nothing can be done ──────────────────────────────────────────────────
  /** There is no structure for the watch to hold — "forty minutes, by feel", a
   * strength day whose movements get picked in the gym. A real prescription, and
   * not one a watch can carry. Never to be worded as an error. */
  | "lives_here"
  /** COROS is holding a version of this session that nothing can rewrite — it
   * was pushed before the content lane existed, or its ownership stamp cannot
   * be re-proven. The app's copy is the one to run. */
  | "watch_keeps_old_copy";

export interface SyncAction {
  agent: SyncActor;
  code: SyncActionCode;
  /** Movements this action is about, when it is about specific movements. */
  names?: string[];
  /** Steps this action is about, when a count is the substance. */
  count?: number;
  /**
   * The in-app control that performs it, when one does — and ONLY when pressing
   * it really enqueues work. `retry` is `POST /plan/workouts/:id/retry-coros`,
   * which re-arms the move lane for this row; `settings` is a link. Absent for
   * every `app` and `nobody` action, by construction.
   */
  control?: "retry" | "settings";
}

/**
 * What the row's own COROS write jobs are doing about it — the shape, not the
 * job kind, so this file does not have to know the lane's vocabulary.
 *
 * `sending` covers a create, a move and a content rewrite alike: from the
 * athlete's side they are one fact ("it's on its way"). `unpushing` is separate
 * because it is the opposite promise — the watch is losing a session, and being
 * told "sending" while that happens would be a lie in the reassuring direction.
 *
 * `failed` means TERMINALLY failed. A transient failure requeues (the executor
 * retries to a cap), and a requeued job is `sending` again, so there is no
 * "will retry by itself" state to render.
 */
export type WriteLane = "none" | "sending" | "unpushing" | "failed";

export interface SyncSituation {
  /** `deriveWorkoutSync`'s answer for this row. */
  view: WorkoutSyncView;
  /** What the wire can carry of this session; absent when all of it can. */
  coverage?: WatchCoverageView;
  /** The COROS cloud connection is live (it IS the executor). */
  connected: boolean;
  /** `prefs.corosWritesEnabled`. */
  writesEnabled: boolean;
  /** What this row's write jobs are doing. */
  write: WriteLane;
  /**
   * The session's story is over: it is completed, skipped, missed, or its day
   * has passed. Nothing is going to be sent for it, so nothing should be asked
   * of anyone — a past session's watch copy is history, which is also the rule
   * the convergence backfill applies.
   */
  settled: boolean;
}

/**
 * The gap the coverage disclosure leads with — see `watchCoverage`'s ordered
 * rule set, which puts the reason that ACTUALLY keeps the session off the watch
 * first, because that is the one worth acting on.
 *
 * `null` for the gaps that are real and have no action: a mobility session filed
 * under Strength, and the per-side/tempo cues that ride as text. Those are
 * disclosed by the coverage note in the same words they always were, and adding
 * "nothing to do about it" underneath is the second telling this app keeps having
 * to delete.
 */
function coverageAction(coverage: WatchCoverageView): SyncAction | null {
  const lead = coverage.gaps[0];
  switch (lead?.code) {
    case "distance_target":
      // The one wire limit an athlete can actually route around: the same
      // session written in minutes crosses fine.
      return { agent: "athlete", code: "make_it_measurable" };
    case "off_catalog":
      return {
        agent: "athlete",
        code: "name_it_on_the_watch",
        ...(lead.names ? { names: lead.names } : {}),
      };
    case "pace_targets_owed":
      return {
        agent: "app",
        code: "pace_targets_pending",
        ...(lead.count ? { count: lead.count } : {}),
      };
    case "empty_body":
      return { agent: "nobody", code: "lives_here" };
    default:
      // `filed_as_strength`, `cues_ride_as_text`, and any future gap that does
      // not stop the session crossing. The session IS on the watch; nothing is
      // owed by anyone.
      return null;
  }
}

/**
 * THE ONE ANSWER to "what do I do about this session", ordered.
 *
 * The order is the argument, so it is written out:
 *
 *  1. A settled session asks nothing of anyone. Its watch copy is history.
 *  2. Nothing off, nothing to say — the silence a synced run has always had.
 *  3. A session the wire CANNOT CARRY outranks everything about connections,
 *     settings and retries: none of them can change the answer, and offering
 *     them is how an app comes to suggest fixes for a boundary. (This is the
 *     same precedence `plan.tsx` reached for by hand when it suppressed the
 *     retry button and the Settings nudge on `coverage: "none"`.)
 *  4. Work in flight is the next loudest true thing, and it is a receipt.
 *  5. Then the things a person can do, cheapest first: reconnect, enable, pick
 *     a day, retry.
 *  6. Then the honest dead ends.
 */
export function syncAction(s: SyncSituation): SyncAction | null {
  if (s.settled) return null;

  const carried = s.coverage === undefined || s.coverage.coverage === "full";
  if (s.view === "synced" && carried) return null;

  // 3 · the wire's own limits, which no button changes.
  if (s.coverage && s.coverage.coverage === "none") {
    const limit = coverageAction(s.coverage);
    if (limit) return limit;
  }

  // 4 · in flight. A queued write with no connection to run it is not in
  // flight, it is waiting on the athlete — same fact `waiting_for_device`
  // names, said as the thing to do about it.
  if (s.write === "sending" || s.write === "unpushing") {
    if (!s.connected) return { agent: "athlete", code: "connect_coros", control: "settings" };
    return s.write === "unpushing"
      ? { agent: "app", code: "removing_from_watch" }
      : { agent: "app", code: "sending" };
  }
  if (s.view === "syncing") return { agent: "app", code: "sending" };
  if (s.view === "waiting_for_device") {
    return { agent: "athlete", code: "connect_coros", control: "settings" };
  }

  // Is anything actually waiting to cross? A session COROS holds, on the right
  // day, in the right version has nothing pending — so a missing connection or
  // a disabled setting is not something to do about IT, and saying "reconnect
  // COROS" on a session that is already there is the noise this file exists to
  // stop. (This is the `partial`/pace-targets row: synced, and still not
  // everything the app holds.)
  const waiting = s.view !== "synced" || s.write === "failed";

  // 5 · what a person can do. Connection and settings come first because they
  // are the reason every other control below would fail.
  if (waiting && !s.connected) {
    return { agent: "athlete", code: "connect_coros", control: "settings" };
  }
  if (waiting && !s.writesEnabled) {
    return { agent: "athlete", code: "enable_coros_writes", control: "settings" };
  }
  // A date the two systems disagree on, with no write in flight either way:
  // the app has no basis for choosing, so it does not pretend to.
  if (s.view === "needs_attention") return { agent: "athlete", code: "choose_a_date" };

  // 6 · COROS holds a version of this session and nothing can rewrite it —
  // whether the rewrite was never possible or was tried and failed terminally.
  // The retry control CANNOT help here and must not be offered: it enqueues a
  // move to the day the session is already on, which is the retry-that-enqueues-
  // nothing this app has already shipped once.
  if (s.view === "content_stale") return { agent: "nobody", code: "watch_keeps_old_copy" };

  // A DATE divergence is exactly what that control does act on — it re-arms the
  // move lane for this row, and the session can cross the wire (rule 3 already
  // returned for the ones that cannot).
  if (s.view === "calendar_only" || s.view === "sync_issue" || s.write === "failed") {
    return { agent: "athlete", code: "retry_write", control: "retry" };
  }

  // Everything crosses, the date agrees, nothing is pending — but coverage is
  // `partial`, which is the pace-target case and the app's own to close.
  return s.coverage ? coverageAction(s.coverage) : null;
}
