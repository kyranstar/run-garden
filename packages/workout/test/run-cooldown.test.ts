/**
 * A COOL-DOWN AFTER A RUN (CUJ J04, R10): sore calves and hamstrings after a long run. The athlete's focus areas feed the
 * Studio's suggestions; before the library had calf stretches, the cool-down after a run offered nothing for the calves.
 * Now it offers a calf stretch, wherever the athlete is and whatever the day's seed, and only moves that ease. The
 * condition profile is the library's own; nothing here is personal.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc, WorkoutItem, WorkoutPart } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, LOCATION_PRESETS, NO_EQUIPMENT_GEAR, TMJ, type CheckReading, type ExerciseRecord } from "@rg/exercise-library";
import { suggestForPart, type DayContext, type SuggestCtx } from "../src/index.js";

const TODAY = "2026-03-10";
const reading = (pre: number | null): CheckReading => ({ pre, post: null, feelingOff: false });
const day: DayContext = { date: TODAY, today: TODAY, readings: { tmj: reading(1) } };
const CTX: SuggestCtx = { activeProfiles: [TMJ], day, focusRefs: [], recentIds: [], pinned: [], excluded: [], equipment: EQUIPMENT_IDS };

const part = (purpose: string, format: string, items: WorkoutItem[]): WorkoutPart => ({ purpose, format, items }) as WorkoutPart;
const run = (durationSec: number): WorkoutItem => ({ kind: "run", effort: "long", target: { durationSec } }) as WorkoutItem;
/** A long run, then a cool-down still to fill. */
const AFTER_A_RUN = {
  version: 1, title: "Long run", intent: { summary: "A long, easy run.", goals: [], focus: [], effort: "maintain" },
  parts: [part("run", "steady", [run(5400)]), part("cooldown", "holds", [])], source: { kind: "studio" },
} as WorkoutDoc;
const COOLDOWN = 1;

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => byId.get(id)!;
const calfStretch = (id: string) => rec(id).family === "calfStretch";
const eases = (r: ExerciseRecord) => r.purposes.some((p) => p === "stretch" || p === "cooldown" || p === "recovery") || r.contraction.every((c) => c === "passive");
const PLACES: Array<[string, readonly string[]]> = [
  ...LOCATION_PRESETS.map((l): [string, readonly string[]] => [l.name, l.equipment]),
  ["No equipment", NO_EQUIPMENT_GEAR],
];
const SEEDS = Array.from({ length: 30 }, (_, i) => 20260301 + i);

describe("a cool-down after a run, with the calves as a focus area", () => {
  it("offers a calf stretch at every place, on every day's seed, and only moves that ease", () => {
    for (const [place, equipment] of PLACES) {
      for (const seed of [undefined, ...SEEDS]) {
        const s = suggestForPart(AFTER_A_RUN, COOLDOWN, EXERCISES, { ...CTX, equipment, focusRefs: ["calves"], ...(seed === undefined ? {} : { seed }) });
        const ids = s.map((x) => x.libraryId);
        expect(ids.some(calfStretch), `${place} ${seed}: ${ids.join(", ")}`).toBe(true);
        for (const id of ids) {
          expect(eases(rec(id)), `${place} ${id}`).toBe(true);
          expect(rec(id).purposes.some((p) => p === "strength" || p === "power"), `${place} ${id}`).toBe(false);
        }
        expect(s.find((x) => calfStretch(x.libraryId))!.reason).toBe("eases your calves, a focus area");
      }
    }
  });

  it("with the soleus named too (a focus area's refs), still a calf stretch", () => {
    const ids = suggestForPart(AFTER_A_RUN, COOLDOWN, EXERCISES, { ...CTX, focusRefs: ["calves", "soleus"] }).map((x) => x.libraryId);
    expect(ids.some(calfStretch)).toBe(true);
  });

  it("before the calf stretches existed, the same cool-down had nothing for the calves", () => {
    const NEW = new Set(["calfStretch", "soleusStretch", "calfRaise", "bentKneeCalfRaise", "singleLegCalfRaise", "eccentricHeelDrop", "tibialisRaise", "calfRelease", "ankleCircles"]);
    const before = EXERCISES.filter((e) => !NEW.has(e.id));
    const ids = suggestForPart(AFTER_A_RUN, COOLDOWN, before, { ...CTX, focusRefs: ["calves"] }).map((x) => x.libraryId);
    expect(ids.filter((id) => rec(id).regions.includes("calves"))).toEqual([]);
  });
});

describe("sore calves and hamstrings after a long run (J04)", () => {
  it("the cool-down eases both areas at every place and on every day's seed: a calf move and a hamstring move", () => {
    for (const [place, equipment] of PLACES) {
      for (const seed of [undefined, ...SEEDS]) {
        const s = suggestForPart(AFTER_A_RUN, COOLDOWN, EXERCISES, { ...CTX, equipment, focusRefs: ["calves", "hamstrings"], ...(seed === undefined ? {} : { seed }) });
        const reasons = s.map((x) => x.reason);
        expect(reasons, `${place} ${seed}`).toContain("eases your calves, a focus area");
        expect(reasons, `${place} ${seed}`).toContain("eases your hamstrings, a focus area");
        for (const x of s) expect(eases(rec(x.libraryId)), `${place} ${x.libraryId}`).toBe(true);
      }
    }
  });
});
