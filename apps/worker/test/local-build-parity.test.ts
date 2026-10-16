/**
 * R11: a quick start, or a template whose document is on the device, started offline is played from a build made ON THE
 * DEVICE (`packages/ui/src/player/local-build.ts`). The player must play it as it plays the server's build of the same
 * document: the same steps, items, moves, targets, length, what each slot says, and the parts and doses in the builder's
 * words. Only what the server alone can work out is left out: ⇄'s lists (judged against the athlete's history), a jump's
 * `fresh` mark, and Today's lead line.
 */
import { describe, expect, it } from "vitest";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { QUICK_START_KINDS, quickStartDoc, type ValidateCtx } from "@rg/workout";
import { localBuild } from "../../../packages/ui/src/player/local-build.js";
import { materializeDocBuild, type DocSlot } from "../src/services/doc-build.js";
import { docFacts } from "../src/services/session-build.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";

const DAY = "2026-10-07";
const location = { id: "home", name: "Home", equipment: ["dumbbell", "band"], implements: {} };
const judge: ValidateCtx = { library: EXERCISES, activeProfiles: [PROFILES.tmj], day: { date: DAY, today: DAY, readings: {} } };
const checks = { tmj: { pre: 2, feelingOff: false } };

/** What a slot says beside its steps, without ⇄'s lists (the server's alone). */
const said = (slots: Record<string, DocSlot>): Record<string, { cue?: string; max?: true }> => {
  const out: Record<string, { cue?: string; max?: true }> = {};
  for (const [key, { alternates: _a, offers: _o, ...rest }] of Object.entries(slots)) if (Object.keys(rest).length > 0) out[key] = rest;
  return out;
};

function expectParity(doc: WorkoutDoc): void {
  const server = materializeDocBuild(doc, { date: DAY, location, checks, library: EXERCISES, judge });
  const { build, view } = localBuild(doc, { localId: "local:abc", date: DAY, checks, location, library: EXERCISES, now: Date.parse(`${DAY}T07:00:00Z`) });
  expect(build.steps).toEqual(server.build.steps);
  expect(build.items).toEqual(server.build.items.map(({ fresh: _fresh, ...item }) => item));
  expect(build.targets).toEqual(server.build.targets);
  // Every move it plays, as the server sends it (the server's also holds ⇄'s moves).
  for (const [id, rec] of Object.entries(build.exercises)) expect(rec).toEqual(server.build.exercises[id]);
  for (const s of build.steps) if (s.kind !== "rest" && s.exerciseId) expect(build.exercises[s.exerciseId]).toBeDefined();
  expect({ minutes: build.minutes, plannedSeconds: build.plannedSeconds, mode: build.mode, date: build.date, alternatives: build.alternatives }).toEqual({
    minutes: server.build.minutes,
    plannedSeconds: server.build.plannedSeconds,
    mode: server.build.mode,
    date: server.build.date,
    alternatives: {},
  });
  expect(build.params).toEqual(server.build.params);
  expect(build.fromDoc).toEqual({ rev: null, swaps: [], blocked: [], slots: said(server.slots), ...docFacts(doc) });
  const { lead: _lead, ...serverView } = server.view;
  expect(view).toEqual(serverView);
  expect(build.buildId).toBe("local:abc");
}

describe("a build made on the device is the server's build of the same document (R11)", () => {
  for (const kind of QUICK_START_KINDS) {
    it(`every quick start: ${kind}, across seeds`, () => {
      for (const seed of [1, 7, 20261007, 99]) {
        const made = quickStartDoc(kind, EXERCISES, { activeProfiles: [PROFILES.tmj], day: null, focusRefs: [], recentIds: [], pinned: [], excluded: [], equipment: location.equipment, seed });
        if (!("doc" in made)) throw new Error(made.reason);
        expectParity(made.doc);
      }
    });
  }

  it("a template's document: cues, a hold to max, a free move, a run, rests, a circuit's rounds, a move twice", () => {
    expectParity(landingsDoc());
    expectParity(calmDoc());
    expectParity(
      workoutDocSchema.parse({
        ...calmDoc(),
        basedOn: { kind: "template", id: "tpl-1" },
        parts: [
          { purpose: "warmup", format: "straight", items: [{ kind: "run", target: { durationSec: 300 }, effort: "easy", cue: "Nose breathing." }] },
          {
            purpose: "main",
            format: "circuit",
            rounds: 2,
            restBetweenRoundsSec: 60,
            items: [
              { kind: "exercise", libraryId: "bridge", dose: { sets: 1, reps: 12 }, cue: "Squeeze at the top." },
              { kind: "exercise", libraryId: "deadBug", dose: { sets: 1, reps: { min: 8, max: 10 } } },
              { kind: "free_exercise", name: "Wall angels", dose: { sets: 1, reps: 10 }, cue: "Back flat." },
            ],
          },
          {
            purpose: "accessory",
            format: "straight",
            items: [
              { kind: "exercise", libraryId: "sidePlank", dose: { sets: 2, holdSec: 30, max: true, perSide: true } },
              { kind: "rest", seconds: 60 },
              { kind: "exercise", libraryId: "bridge", dose: { sets: 1, reps: 15 } },
            ],
          },
        ],
      }),
    );
  });
});
