/**
 * EVERY COACH SESSION IN THE INTENT CORPUS BECOMES A DOCUMENT (programme spec §3.3, Amendment A). The corpus
 * (intent-corpus.ts) is the coach's whole vocabulary — every intensity, every block spelling, every exercise field in
 * every accepted spelling, circuits, the mobility body, bodyless and empty sessions, a rest day — written in the
 * dialect a model emits and parsed by the real schema. For each one:
 *  - the document is valid, and a rest day has none;
 *  - deriveDoc(document).category is the session's own category (one declared exception, below);
 *  - every exercise field lands in the document or in kept — a new CoachExercise field does not compile here until
 *    it is accounted for;
 *  - the converter's run-block roles are the wire's (`runBlockRoles`), over the corpus and every short sequence.
 */
import { describe, expect, it } from "vitest";
import { workoutDocSchema, type CoachExercise, type CoachRunBlock, type CoachSession, type WorkoutItem } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { runBlockRoles } from "@rg/coros";
import { deriveDoc, docFromCoachSession, playerStepsFromDoc, stagesFromDoc, type KeptEntry } from "@rg/workout";
import { strictExerciseKey } from "../src/services/exercise-catalog.js";
import { FIXTURES } from "./intent-corpus.js";

/** A coach's name → the library move with that exact name (case, punctuation and plurals folded). */
const byKey = new Map(EXERCISES.map((e) => [strictExerciseKey(e.name), e.id]));
const resolveName = (name: string): string | null => byKey.get(strictExerciseKey(name)) ?? null;

/**
 * The corpus sessions whose own blocks say something other than their category. The document derives its category
 * from what it holds (principles §3.1: computed, never authored); the coach's own word is kept beside it.
 */
const DERIVED_DIFFERENTLY: Record<string, { derived: string; why: string }> = {
  "run/every-intensity-distance": {
    derived: "quality",
    why: "filed long, but it holds a threshold and an interval block in about 48 minutes of running",
  },
};

const moves = (items: WorkoutItem[]) => items.filter((i): i is Extract<WorkoutItem, { kind: "exercise" | "free_exercise" }> => i.kind === "exercise" || i.kind === "free_exercise");

describe("every coach corpus session → a document", () => {
  it("the corpus is the whole vocabulary", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(FIXTURES.map((f) => f.session.category))).toEqual(new Set(["easy", "long", "quality", "rest", "strength", "yoga"]));
  });

  for (const f of FIXTURES) {
    it(f.name, () => {
      const withWords = docFromCoachSession(f.session, { resolveName, raw: f.raw });
      const stored = docFromCoachSession(f.session, { resolveName });
      if (f.session.category === "rest") {
        expect(withWords).toBeNull();
        expect(stored).toBeNull();
        return;
      }
      for (const { doc, kept } of [withWords!, stored!]) {
        expect(workoutDocSchema.safeParse(doc).success).toBe(true);
        expect(deriveDoc(doc, EXERCISES).category).toBe(DERIVED_DIFFERENTLY[f.name]?.derived ?? f.session.category);
        expect(kept).toContainEqual(expect.objectContaining({ at: "session", field: "category", value: f.session.category }));
        // Both adapters read it.
        expect(playerStepsFromDoc(doc, EXERCISES).length).toBeGreaterThan(0);
        expect(stagesFromDoc(doc, EXERCISES).length).toBeGreaterThan(0);
      }
    });
  }

  it("the declared exception is still one: its blocks really are hard", () => {
    for (const name of Object.keys(DERIVED_DIFFERENTLY)) {
      const f = FIXTURES.find((x) => x.name === name)!;
      const { doc } = docFromCoachSession(f.session, { resolveName })!;
      expect(deriveDoc(doc, EXERCISES).category).not.toBe(f.session.category);
    }
  });
});

/** How each exercise field lands: in the document item, or in kept. Keyed by every field, so a new one must be added. */
const LANDS: Record<keyof CoachExercise, (e: CoachExercise, item: ReturnType<typeof moves>[number], kept: KeptEntry[], at: string, raw: Record<string, unknown> | undefined) => void> = {
  name: (e, item) => {
    if (item.kind === "exercise") expect(item.libraryId).toBe(resolveName(e.name));
    else expect(item.name).toBe(e.name);
  },
  sets: (e, item) => expect(item.dose.sets).toBe(e.sets),
  reps: (e, item) => expect(item.dose.reps).toBe(e.reps ?? undefined),
  holdSeconds: (e, item) => expect(item.dose.holdSec).toBe(e.holdSeconds ?? undefined),
  perSide: (e, item) => expect(item.dose.perSide).toBe(e.perSide ? true : undefined),
  eccentricSeconds: (e, item) => expect(item.dose.tempo?.eccentricSec).toBe(e.eccentricSeconds ?? undefined),
  weight: (e, item, kept, at, raw) => {
    const load = item.dose.load;
    if (e.weight.type === "kg") {
      if (load === undefined || load === "bodyweight") throw new Error(`${at}: a ${e.weight.value} kg load did not land`);
      // The stored kilos are a tenth; the typed text's own kilos may be finer (45 lb = 20.41 kg, stored 20.4).
      expect(Math.abs(load.kg - e.weight.value)).toBeLessThan(0.05);
      if (typeof raw?.weight === "string") expect(load.typed).toBe(raw.weight.trim());
    } else if (load !== "bodyweight") {
      expect(load).toBeUndefined();
      expect(kept).toContainEqual(expect.objectContaining({ at, field: "weight", value: raw?.weight }));
    }
  },
  restSeconds: (e, item) => expect(item.dose.restSec).toBe(e.restSeconds),
  note: (e, item) => expect(item.cue).toBe(e.note ?? undefined),
  originId: (e, _item, kept, at) => {
    if (e.originId) expect(kept).toContainEqual(expect.objectContaining({ at, field: "originId", value: e.originId }));
  },
};

describe("every exercise field lands in the document or in kept", () => {
  it("over every lift and mobility exercise of the corpus, with and without the coach's own words", () => {
    let checked = 0;
    for (const f of FIXTURES) {
      const body = f.session.lift ?? f.session.mobility;
      if (!body || body.exercises.length === 0) continue;
      const rawBody = ((f.raw as Record<string, unknown>)[f.session.lift ? "lift" : "mobility"] as { exercises: Array<Record<string, unknown>> }).exercises;
      for (const raw of [true, false]) {
        const { doc, kept } = docFromCoachSession(f.session, { resolveName, ...(raw ? { raw: f.raw } : {}) })!;
        const items = moves(doc.parts.flatMap((p) => p.items));
        expect(items).toHaveLength(body.exercises.length);
        body.exercises.forEach((e, i) => {
          for (const land of Object.values(LANDS)) land(e, items[i]!, kept, `exercise ${i + 1}`, raw ? rawBody[i] : undefined);
          checked += 1;
        });
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

/** The part each block of a run session landed in: a warm-up, a cool-down, else the run part (work and recovery). */
function partOfEachBlock(session: CoachSession): string[] {
  const { doc } = docFromCoachSession(session, { resolveName })!;
  return doc.parts.flatMap((p) => p.items.map(() => p.purpose));
}
const PART_OF_ROLE: Record<string, string> = { warmup: "warmup", cooldown: "cooldown", work: "run", recovery: "run" };
const wire = (blocks: readonly CoachRunBlock[]) => runBlockRoles(blocks).map((r) => PART_OF_ROLE[r]);
const runSession = (blocks: CoachRunBlock[]): CoachSession =>
  ({ category: "quality", title: "Run", durationMinutes: 40, run: { blocks } }) as CoachSession;

describe("the converter's run-block roles are the wire's (runBlockRoles, imported — not a copy)", () => {
  it("over the corpus", () => {
    for (const f of FIXTURES) if (f.session.run?.blocks.length) expect(partOfEachBlock(f.session), f.name).toEqual(wire(f.session.run.blocks));
  });

  it("over every sequence of up to four blocks", () => {
    const states = ["easy", "steady", "threshold", "interval", "rest", undefined] as const;
    let seqs: CoachRunBlock[][] = [[]];
    for (let n = 1; n <= 4; n++) {
      seqs = seqs.flatMap((s) => states.map((i): CoachRunBlock[] => [...s, { kind: "duration", value: 5, ...(i === undefined ? {} : { intensity: i }) }]));
      for (const blocks of seqs) expect(partOfEachBlock(runSession(blocks))).toEqual(wire(blocks));
    }
  });

  it("a block's declared role wins, as it does on the wire", () => {
    // The schema strips `role` today (create-executor.ts: dormant until the coach vocabulary grows it); a block that
    // carries one lands where the wire puts it.
    const block = (intensity: CoachRunBlock["intensity"], role?: string): CoachRunBlock =>
      ({ kind: "duration", value: 10, ...(intensity ? { intensity } : {}), ...(role ? { role } : {}) }) as CoachRunBlock;
    const cases: CoachRunBlock[][] = [
      [block("easy", "work"), block("threshold"), block("easy")],
      [block("easy"), block("threshold"), block("easy", "Warm up")],
      [block("threshold", "cool-down"), block("easy")],
      [block("easy", "recovery"), block("interval"), block("easy", "cooldown")],
    ];
    for (const blocks of cases) {
      const roles = wire(blocks);
      expect(partOfEachBlock(runSession(blocks))).toEqual(roles);
      // The declaration really changed something: without it the parts would differ.
      const undeclared = blocks.map(({ role: _r, ...b }: CoachRunBlock & { role?: string }) => b as CoachRunBlock);
      expect(wire(undeclared)).not.toEqual(roles);
    }
  });
});
