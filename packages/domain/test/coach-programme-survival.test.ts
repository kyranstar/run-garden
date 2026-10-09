/**
 * DO SELECTOR REQUESTS SURVIVE A WEEK THAT HOLDS A PROGRAMME SESSION? (re-review NEW-1, ruling 3-R13)
 *
 * A programme or on-demand session may be moved, skipped or removed by the coach but never eased or re-timed — the
 * fatal `app_built_session`. Selector rule 2 says a selector may not reach what an op may not touch, so "take 30% off
 * everything next week" over a week with a programme session must resolve onto the other sessions only. When it did
 * not, the resolved `adjust` of the programme row binned the WHOLE proposal (repair round, then stored `rejected`) —
 * every athlete with a programme, most weeks.
 *
 * Survival-style, after the coach failure lesson: not one scenario but every athlete state the survival harness
 * knows, each with a programme running alongside, and the selector requests a coach plausibly writes over each of its
 * weeks — through the real pipeline (parse → expand → resolve → validateOps → applyOps). Every one must survive, no
 * resolved adjust may name an app-built row, and move/skip/remove must still reach them.
 */
import { describe, expect, it, vi } from "vitest";
import { addDays } from "../src/time.js";
import { expandSelectors } from "../src/coach-selectors.js";
import { appAuthoredRow } from "../src/watch-address.js";
import type { CoachAuthoredOp } from "../src/coach.js";
import { buildExerciseIndex } from "../../../apps/worker/src/services/exercise-catalog.js";
import { athletes, withAppBuiltSessions, type AthleteState } from "./coach-survival/athletes.js";
import { liveExerciseCatalog } from "./coach-survival/catalog.js";
import { rngFor, wakeEnvelope } from "./coach-survival/plans.js";
import { runSample } from "./coach-survival/pipeline.js";

vi.setConfig({ testTimeout: 120_000 });

const INDEX = buildExerciseIndex(liveExerciseCatalog());

/** The selector requests a coach writes over one week of the calendar. */
function requestsFor(s: AthleteState, monday: string): Array<{ key: string; ops: CoachAuthoredOp[] }> {
  const week = { by: "match" as const, from: monday, to: addDays(monday, 6) };
  const weekend = { by: "match" as const, from: addDays(monday, 5), to: addDays(monday, 6) };
  const midweek = { by: "match" as const, from: addDays(monday, 2), to: addDays(monday, 3) };
  const out: Array<{ key: string; ops: CoachAuthoredOp[] }> = [
    { key: "deload the week (×0.7)", ops: [{ kind: "adjustEach", select: week, durationScale: 0.7 }] },
    { key: "shave ten minutes off the week", ops: [{ kind: "adjustEach", select: week, durationDeltaMinutes: -10 }] },
    { key: "shorten the week's runs", ops: [{ kind: "adjustEach", select: { ...week, discipline: "run" }, durationScale: 0.8 }] },
    { key: "skip the weekend", ops: [{ kind: "skipEach", select: weekend, reason: "you're away" }] },
    { key: "clear midweek", ops: [{ kind: "removeEach", select: midweek }] },
    { key: "push the week's lifting back a week", ops: [{ kind: "moveEach", select: { ...week, discipline: "strength" }, shiftDays: 7 }] },
    {
      key: "deload + move the lifting",
      ops: [
        { kind: "adjustEach", select: week, durationScale: 0.8 },
        { kind: "moveEach", select: { ...week, discipline: "strength" }, shiftDays: 1 },
      ],
    },
  ];
  // A request by ids, naming the week's sessions — programme rows among them — the way a model copies handles.
  const ids = s.ctx.workouts.filter((w) => w.date >= week.from && w.date <= week.to && w.completionState === "scheduled").map((w) => w.id);
  if (ids.length > 0) out.push({ key: "shorten these sessions (by ids)", ops: [{ kind: "adjustEach", select: { by: "ids", ids }, durationScale: 0.75 }] });
  // Only what a coach would write: a request over a weekend with nothing on it is the fixture's emptiness, not the
  // rule under test — so keep a request only if every selector in it finds work with programmes left out of it.
  const planned = s.ctx.workouts.filter((w) => !appAuthoredRow({ origin: w.origin ?? null }));
  return out.filter((req) => expandSelectors(req.ops, planned, s.ctx.today).empty.length === 0 || req.key.includes("by ids"));
}

describe("selector requests over weeks that hold programme sessions", () => {
  it("every request survives the pipeline, and no resolved adjust lands on an app-built row", async () => {
    const rng = rngFor(20261008);
    const failures: string[] = [];
    let samples = 0;
    let reachedAppBuilt = 0;
    for (const base of athletes()) {
      const s = withAppBuiltSessions(base);
      const appBuilt = new Set(s.ctx.workouts.filter((w) => appAuthoredRow({ origin: w.origin ?? null })).map((w) => w.id));
      for (const monday of [s.A, addDays(s.A, 7)]) {
        for (const req of requestsFor(s, monday)) {
          const { ops } = expandSelectors(req.ops, s.ctx.workouts, s.ctx.today);
          const adjusted = ops.filter((o) => o.kind === "adjust" && appBuilt.has(o.workoutId));
          if (adjusted.length > 0) failures.push(`${s.key} ${monday} "${req.key}": adjusts app-built ${adjusted.map((o) => ("workoutId" in o ? o.workoutId : "")).join(",")}`);
          reachedAppBuilt += ops.filter((o) => o.kind !== "adjust" && "workoutId" in o && appBuilt.has(o.workoutId)).length;
          const r = await runSample(s, req.key, wakeEnvelope(rng, req.ops, addDays(s.ctx.today, 2)), { index: INDEX });
          samples++;
          if (!r.survived) failures.push(`${s.key} ${monday} "${req.key}": ${r.failedAt} ${r.causes.join(", ")} — ${r.detail}`);
        }
      }
    }
    expect(samples).toBeGreaterThan(80);
    expect(failures).toEqual([]);
    // Move, skip and remove are legal on a programme session (3-R13): the selector must still reach them.
    expect(reachedAppBuilt).toBeGreaterThan(0);
  });
});
