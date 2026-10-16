/**
 * HOW TASK 13'S NEW LIBRARY MOVES REACH THE WATCH (A9, R9). The gym lifts the COROS catalog holds as the same lift go as
 * its steps (a curated `exact` mapping); the back squat and the band-assisted pull-up are curated `close` — COROS's
 * "Squats" is any squat (round 2, Minor 3: a watch-logged bodyweight or goblet squat must not become barbell history),
 * its Pull-ups the unassisted lift — so they go as free text; the stretches and the slow-lowering moves name nothing in
 * the catalog and go as free text under their library names — the push's own fallback for an unmapped move, pinned here
 * for these moves. The live COROS catalog's T-codes under synthesized ids; no personal data.
 */
import { describe, expect, it } from "vitest";
import { WATCH_NAME_MAX, WATCH_SIDE_LABEL, workoutDocSchema } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { liveExerciseCatalog } from "../../../packages/domain/test/coach-survival/catalog.js";
import { computedCorosKey, corosKeyOf, libraryIdsByKey } from "../src/services/coros-exercise-map.js";
import { watchStepsFromDoc } from "../src/services/watch-doc.js";
import { catalogIdsByKey, watchNameOf, type WatchPlanDeps } from "../src/services/watch-push.js";

const deps: WatchPlanDeps = { catalogIdByKey: catalogIdsByKey(liveExerciseCatalog()), keyOf: (id) => corosKeyOf(id) };
const name = (id: string) => EXERCISES.find((e) => e.id === id)!.name;

/** The new moves the catalog holds, by the T-code each goes to the watch as. */
const CATALOG: Record<string, string> = { barbellRdl: "T1287", latPulldown: "T1342", legPress: "T1065" };
/** The new moves that go as free text. */
const FREE = [
  "barbellBackSquat", "bandAssistedPullUp", "eccentricPullUp", "standingHamstringStretch", "halfKneelingHamstringStretch", "standingQuadStretch", "sideLyingQuadStretch",
  "adductorRockBack", "frogStretch", "bentKneeHeelDrop", "eccentricPushup", "singleLegBoxSit", "hamstringSlideOut",
];

describe("Task 13's new moves on the watch", () => {
  it("each new move's key: the catalog's step for three gym lifts, none for the rest; no name match was left unreviewed", () => {
    for (const [id, key] of Object.entries(CATALOG)) {
      expect(corosKeyOf(id), id).toBe(key);
      expect(libraryIdsByKey().get(key), key).toBe(id);
    }
    // A watch-logged "Squats" (T1061) reads back as no library move at all — never the barbell back squat.
    expect(libraryIdsByKey().has("T1061")).toBe(false);
    expect([...libraryIdsByKey().values()]).not.toContain("barbellBackSquat");
    for (const id of FREE) {
      expect(EXERCISES.some((e) => e.id === id), id).toBe(true);
      expect(corosKeyOf(id), id).toBeNull();
      // Free text by curation (the pull-up) or because no catalog name is the move's: never a computed match.
      if (!EXERCISES.find((e) => e.id === id)!.providers?.coros) expect(computedCorosKey({ name: name(id) }), id).toBeNull();
    }
  });

  it("a workout of them goes to the watch: the catalog lifts as catalog steps, every other move as free text under its library name", () => {
    const ids = [...Object.keys(CATALOG), ...FREE];
    const doc = workoutDocSchema.parse({
      version: 1, title: "New moves", intent: { summary: "The new moves.", goals: [], focus: [], effort: "maintain" }, source: { kind: "coach" },
      // One set each; a one-sided move plays each side as its own step, its side on the name.
      parts: [{ purpose: "main", format: "straight", items: ids.map((libraryId) => ({ kind: "exercise", libraryId, dose: { sets: 1, reps: 5, restSec: 0 } })) }],
    });
    const plan = watchStepsFromDoc(doc, EXERCISES, deps);
    expect(plan.refusal).toBeNull();
    const sided = (id: string) => EXERCISES.find((e) => e.id === id)!.laterality === "unilateral";
    expect(plan.steps).toHaveLength(ids.reduce((n, id) => n + (sided(id) ? 2 : 1), 0));
    // The three catalog lifts are both-sided, so each is one catalog step under its T-code.
    expect(plan.steps.filter((s) => s.originId !== "0").map((s) => s.name)).toEqual(Object.values(CATALOG));
    // Every other move as free text: its library name, cut to the watch's room as the push cuts any name (leaving a
    // one-sided move room for its side label), in the build's order.
    const room = WATCH_NAME_MAX - Math.max(WATCH_SIDE_LABEL.left.length, WATCH_SIDE_LABEL.right.length);
    const expected = FREE.flatMap((id) =>
      sided(id)
        ? [`${watchNameOf(name(id), room).name}${WATCH_SIDE_LABEL.left}`, `${watchNameOf(name(id), room).name}${WATCH_SIDE_LABEL.right}`]
        : [watchNameOf(name(id)).name],
    );
    const free = plan.steps.filter((s) => s.originId === "0");
    expect(plan.freeText).toBe(free.length);
    expect(free.map((s) => s.name)).toEqual(expected);
    // A short name goes whole: what the athlete reads in the app is what the watch shows.
    expect(free.map((s) => s.name)).toContain("Frog stretch");
  });
});
