/**
 * WHAT THE WATCH WILL SHOW — one answer, computed, never narrated.
 *
 * The coach's vocabulary is wider than the wire's. A block measured in metres is
 * refused by `buildRunProgram`; a movement the athlete's COROS library has never
 * heard of has no id to write; COROS's program namespace has no mobility sport,
 * so a mobility session files under Strength. None of that is a failure — it is
 * the shape of the product — but until this file existed none of it was SAID.
 * The athlete got one reasonless sentence behind one tap ("it was never written
 * to your COROS watch"), which reads as a bug, and the proposal manifest — the
 * thing they read BEFORE approving — did not mention the watch at all.
 *
 * The rule this file enforces is the manifest's own rule, applied to the wire:
 * THE APP NEVER CLAIMS A COVERAGE IT CANNOT COMPUTE. Every verdict below comes
 * from the same facts `coach-apply.ts`'s `watchPushable` reads — whether a run's
 * blocks are timed, and whether every movement resolved to a catalog id — so the
 * disclosure and the push decision cannot drift. `watch-coverage.test.ts` pins
 * that equivalence against `watchPushable` itself, over a whole vocabulary of
 * sessions rather than a few examples.
 *
 * "A LIFT CANNOT REACH THE WATCH" WAS NEVER TRUE (corrected 2026-08-17). This
 * file used to return `none` for every lift and every mobility session and give
 * `discipline_off_wire` as the reason, quoting a comment that said the executor
 * "builds a structured RUN program and nothing else". `createWorkout` has always
 * dispatched a non-run session to `buildStrengthProgram`, the write lane resolves
 * the athlete's ~382-row COROS exercise catalog specifically so it can, and the
 * intent harness has since pushed nine lift and mobility shapes through the real
 * executor and read every one back. The gate was a product decision wearing a
 * protocol limit's clothes, and this file was the place it got told to the
 * athlete as fact. `discipline_off_wire` is gone; what is left are the limits
 * that are real, and each of them is either actionable or coarse rather than
 * fatal.
 *
 * Two adapters feed the one rule set:
 *
 *   · {@link watchSessionShape} — from a `CoachSession`, which is what the
 *     proposal manifest holds BEFORE approval.
 *   · `watchShapeOfRow` (routes/plan.ts) — from a stored `planned_workouts`
 *     row, which is all the session sheet has AFTER approval.
 *
 * They are separate because the two callers hold different objects, and one
 * test drives a session through `sessionColumns` + `writeStages` and asserts
 * both adapters reach the same verdict.
 */
import type { CoachExercise, CoachSession } from "./coach.js";

/**
 * How much of what Run Garden holds reaches the watch.
 *
 *   · `full`    — everything crosses. Say nothing.
 *   · `partial` — the session reaches the watch, but the watch's copy is
 *                 poorer than the app's (see the gaps).
 *   · `none`    — the wire cannot hold this session at all. It lives in Run
 *                 Garden and Google Calendar, and that is the whole story.
 *
 * `none` is NOT an error state and must never be worded as one.
 */
export type WatchCoverage = "full" | "partial" | "none";

/**
 * Why coverage is not `full`. Enumerated, because a reason the UI can name is
 * a boundary and a reason it cannot is a bug report.
 */
export type WatchGapCode =
  /** A run block measured in distance. `buildRunProgram` refuses the whole
   * session rather than write a target that is not spike-verified. */
  | "distance_target"
  /** Nothing to write — a session whose body is empty, or a run with no blocks
   * ("forty minutes, by feel"). A real prescription with no structure in it. */
  | "empty_body"
  /**
   * Movements the athlete's synced COROS library has no id for.
   *
   * THE LIVE BLOCKER for strength work, and the one the athlete can clear: the
   * builder throws on the first unresolved id rather than write a program COROS
   * would reject, and a partial push would put a DIFFERENT session on the watch
   * with no way for the watch to say what was dropped. So the session is refused
   * whole, and the names are the actionable part.
   */
  | "off_catalog"
  /** Steps that will arrive on the watch with no pace band, because Run
   * Garden does not know the athlete's threshold pace yet. Mirrors
   * `missingPaceTargets` in the create executor, `rest` blocks excluded. */
  | "pace_targets_owed"
  /**
   * A mobility session files under Strength on the watch. COROS's program
   * namespace is 1 Run / 2 Bike / 3 Swim / 4 Strength and has no mobility or
   * yoga sport, so this is COARSE FILING, not a loss: every step crosses, the
   * app keeps the honest discipline, and only the watch's own drawer is wrong.
   */
  | "filed_as_strength"
  /**
   * Per-side work and eccentric tempo reach the watch as TEXT on the step (its
   * `overview`) and not as anything the watch counts. The wire has no field for
   * either — the work itself is preserved (per-side is written as two identical
   * steps, so the total is right) but the watch will not tell the athlete
   * mid-set that this set is the left one, or that the lowering is four
   * seconds. `count` is how many movements are affected.
   */
  | "cues_ride_as_text";

export interface WatchGap {
  code: WatchGapCode;
  /** The movements this gap is about, when it is about specific movements. */
  names?: string[];
  /** How many steps this gap is about, when a count is the substance. */
  count?: number;
}

export interface WatchCoverageView {
  coverage: WatchCoverage;
  /** Which body the session has — the same word `sessionSport` files it
   * under. The UI needs it to name the session ("a lift", "a mobility
   * session") rather than say "this" twice in one sentence. */
  discipline: "run" | "lift" | "mobility";
  gaps: WatchGap[];
}

/**
 * A movement whose prescription can only cross as prose: per-side work, or an
 * eccentric tempo. Exported because both adapters must agree about it, and
 * because it is the same test the create executor applies when it decides what
 * to write into a step's `overview`.
 */
export function exerciseCuesAsText(e: CoachExercise): boolean {
  return !!e.perSide || e.eccentricSeconds !== undefined;
}

/**
 * A session reduced to the facts the wire cares about — the one input to the
 * rule set, so a caller holding a `CoachSession` and a caller holding a
 * database row are answering the same question.
 */
export interface WatchSessionShape {
  discipline: "run" | "lift" | "mobility";
  /** How each run block is measured. Empty for a non-run or a bodyless one. */
  runBlocks: ReadonlyArray<"duration" | "distance">;
  /** Blocks that name an intensity the wire will carry no pace band for.
   * A caller that cannot know (the manifest has no threshold pace) passes 0,
   * which is the honest answer: it declines to claim rather than guess. */
  paceTargetsOwed: number;
  exercises: ReadonlyArray<{
    name: string;
    onWatch: boolean;
    /** See `exerciseCuesAsText`. */
    cuesAsText?: boolean;
  }>;
}

/**
 * THE RULE SET. Ordered, because the reasons are not independent: the thing that
 * actually keeps a session off the watch comes first, since that is the one the
 * athlete would act on, and a reason list that led with a survivable gap would
 * send them fixing something that changes nothing.
 */
export function watchCoverage(shape: WatchSessionShape): WatchCoverageView {
  const base = { discipline: shape.discipline } as const;

  if (shape.discipline === "run") {
    if (shape.runBlocks.length === 0) {
      return { ...base, coverage: "none", gaps: [{ code: "empty_body" }] };
    }
    if (shape.runBlocks.includes("distance")) {
      return { ...base, coverage: "none", gaps: [{ code: "distance_target" }] };
    }
    if (shape.paceTargetsOwed > 0) {
      return {
        ...base,
        coverage: "partial",
        gaps: [{ code: "pace_targets_owed", count: shape.paceTargetsOwed }],
      };
    }
    return { ...base, coverage: "full", gaps: [] };
  }

  // A lift or a mobility session. Both cross; both cross as Strength programs.
  if (shape.exercises.length === 0) {
    return { ...base, coverage: "none", gaps: [{ code: "empty_body" }] };
  }
  const offCatalog = shape.exercises.filter((e) => !e.onWatch).map((e) => e.name);
  if (offCatalog.length > 0) {
    // EVERY movement or none — the builder refuses the first unresolved id and
    // should, so this is the whole session's answer and not a footnote on it.
    return { ...base, coverage: "none", gaps: [{ code: "off_catalog", names: offCatalog }] };
  }

  const gaps: WatchGap[] = [];
  if (shape.discipline === "mobility") gaps.push({ code: "filed_as_strength" });
  const cued = shape.exercises.filter((e) => e.cuesAsText).length;
  if (cued > 0) gaps.push({ code: "cues_ride_as_text", count: cued });
  return gaps.length > 0
    ? { ...base, coverage: "partial", gaps }
    : { ...base, coverage: "full", gaps: [] };
}

/**
 * A proposed session's shape, before anything is stored.
 *
 * `paceTargetsOwed` is 0 here on purpose: the threshold pace lives in the
 * athlete's profile, the manifest renders from ops alone, and a manifest that
 * guessed would tell half the athletes their pace targets are missing when
 * they are not. Declining to claim is the honest half of the same rule.
 */
export function watchSessionShape(s: CoachSession): WatchSessionShape {
  const block = s.lift ?? s.mobility;
  return {
    discipline: s.lift ? "lift" : s.mobility ? "mobility" : "run",
    runBlocks: (s.run?.blocks ?? []).map((b) => (b.kind === "duration" ? "duration" : "distance")),
    paceTargetsOwed: 0,
    exercises: (block?.exercises ?? []).map((e) => ({
      name: e.name,
      onWatch: !!e.originId,
      ...(exerciseCuesAsText(e) ? { cuesAsText: true } : {}),
    })),
  };
}

/** The coverage of a proposed session — the manifest's one call. */
export function sessionWatchCoverage(s: CoachSession): WatchCoverageView {
  return watchCoverage(watchSessionShape(s));
}
