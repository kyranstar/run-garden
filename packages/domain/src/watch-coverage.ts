/**
 * WHAT THE WATCH WILL SHOW — one answer, computed, never narrated.
 *
 * The coach's vocabulary is wider than the wire's. A lift is a real session
 * and the create lane builds run programs only; a block measured in metres is
 * refused by `buildRunProgram`; a movement the athlete's COROS library has
 * never heard of has no id to write. None of that is a failure — it is the
 * shape of the product — but until this file existed none of it was SAID.
 * The athlete got one reasonless sentence behind one tap ("it was never
 * written to your COROS watch"), which reads as a bug, and the proposal
 * manifest — the thing they read BEFORE approving — did not mention the watch
 * at all.
 *
 * The rule this file enforces is the manifest's own rule, applied to the wire:
 * THE APP NEVER CLAIMS A COVERAGE IT CANNOT COMPUTE. Every verdict below comes
 * from the same three facts `coach-apply.ts`'s `watchPushable` reads — which
 * discipline body the session has, whether its run blocks are timed, and
 * whether its movements resolved to catalog ids — so the disclosure and the
 * push decision cannot drift. `watch-coverage.test.ts` pins that equivalence
 * against `watchPushable` itself.
 *
 * Two adapters feed the one rule set:
 *
 *   · {@link watchSessionShape} — from a `CoachSession`, which is what the
 *     proposal manifest holds BEFORE approval.
 *   · `watchShapeOfRow` (routes/plan.ts) — from a stored `planned_workouts`
 *     row, which is all the session sheet has AFTER approval.
 *
 * They are separate because the two callers hold different objects, and one
 * test drives a session through `sessionColumns` and asserts both adapters
 * reach the same verdict.
 */
import type { CoachSession } from "./coach.js";

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
  /** Lift and mobility sessions have no create path: the executor builds a
   * structured RUN program and nothing else (coach-apply.ts `watchPushable`). */
  | "discipline_off_wire"
  /** A run block measured in distance. `buildRunProgram` refuses the whole
   * session rather than write a target that is not spike-verified. */
  | "distance_target"
  /** Nothing timed to write — a session whose body is empty. */
  | "empty_body"
  /** Movements the athlete's synced COROS library has no id for. Named, so
   * the athlete can rename them into the library if they want to. */
  | "off_catalog"
  /** Steps that will arrive on the watch with no pace band, because Run
   * Garden does not know the athlete's threshold pace yet. Mirrors
   * `missingPaceTargets` in the create executor, `rest` blocks excluded. */
  | "pace_targets_owed";

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
  exercises: ReadonlyArray<{ name: string; onWatch: boolean }>;
}

/**
 * THE RULE SET. Ordered, because the reasons are not independent: a lift's
 * movements being off-catalog does not become the reason it stays in the app
 * — the discipline already was — and saying so would send the athlete
 * renaming exercises to fix something renaming cannot fix.
 */
export function watchCoverage(shape: WatchSessionShape): WatchCoverageView {
  const offCatalog = shape.exercises.filter((e) => !e.onWatch).map((e) => e.name);
  const base = { discipline: shape.discipline } as const;

  if (shape.discipline !== "run") {
    // Lift and mobility are app-only regardless of catalog resolution. The
    // off-catalog names still ride along: they are a SECOND, separately true
    // fact ("and the library has never heard of these"), and the one the
    // athlete could act on if strength pushes ever land.
    return {
      ...base,
      coverage: "none",
      gaps: [
        { code: "discipline_off_wire" },
        ...(offCatalog.length > 0 ? [{ code: "off_catalog" as const, names: offCatalog }] : []),
      ],
    };
  }
  if (shape.runBlocks.length === 0) return { ...base, coverage: "none", gaps: [{ code: "empty_body" }] };
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
    exercises: (block?.exercises ?? []).map((e) => ({ name: e.name, onWatch: !!e.originId })),
  };
}

/** The coverage of a proposed session — the manifest's one call. */
export function sessionWatchCoverage(s: CoachSession): WatchCoverageView {
  return watchCoverage(watchSessionShape(s));
}
