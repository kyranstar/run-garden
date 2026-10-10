/**
 * QUICK STARTS (Stage 2 spec §9): instant documents with no AI — condition care (≈ 5 min, recovery mode, the active
 * profile's care and passive moves), desk reset (≈ 8 min, desk-relief and posture moves), hip opener (≈ 10 min,
 * hip-opening and focus-area moves). Each validates clean for the day, lands within two minutes of its length, never
 * jumps, and varies with the seed and what was done recently. The profile is the library's own; nothing is personal.
 */
import { describe, expect, it } from "vitest";
import { EQUIPMENT_IDS, EXERCISES, MUSCLE_REGION, TMJ, hasEquipment, isPlyometric, type CheckReading, type ExerciseRecord, type MuscleId } from "@rg/exercise-library";
import {
  QUICK_START_MINUTES,
  deriveDoc,
  quickStartDoc,
  quickStartKinds,
  validateWorkoutDoc,
  type DayContext,
  type QuickStartKind,
  type SuggestCtx,
} from "../src/index.js";

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => byId.get(id)!;
const TODAY = "2026-03-10";
const reading = (pre: number | null, feelingOff = false): CheckReading => ({ pre, post: null, feelingOff });
const dayOf = (r: CheckReading | null, o: Partial<DayContext> = {}): DayContext => ({ date: TODAY, today: TODAY, readings: { tmj: r }, ...o });
const DAYS: Record<string, DayContext | null> = {
  calm: dayOf(reading(1)),
  flare: dayOf(reading(7)),
  unanswered: dayOf(null),
  "feeling off": dayOf(reading(2, true)),
  future: dayOf(null, { date: "2026-03-13" }),
  template: null,
};
const CTX: SuggestCtx = { activeProfiles: [TMJ], day: DAYS.calm!, focusRefs: ["hip-flexors", "thoracic"], recentIds: [], pinned: [], excluded: [], equipment: EQUIPMENT_IDS };
const KINDS: readonly QuickStartKind[] = ["condition_care", "desk_reset", "hip_opener"];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const make = (kind: QuickStartKind, seed: number, o: Partial<SuggestCtx> = {}) => quickStartDoc(kind, EXERCISES, { ...CTX, ...o, seed });
const itemIds = (doc: ReturnType<typeof make>): string[] => doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId] : [])));

describe("quick starts validate clean and land within two minutes of their length", () => {
  for (const kind of KINDS) {
    for (const [name, day] of Object.entries(DAYS)) {
      it(`${kind}, ${name} day, 20 seeds`, () => {
        for (const seed of SEEDS) {
          const doc = make(kind, seed, { day });
          const issues = validateWorkoutDoc(doc, { library: EXERCISES, activeProfiles: [TMJ], day, equipment: EQUIPMENT_IDS });
          expect(issues.filter((i) => i.severity === "error"), `${kind} seed ${seed}`).toEqual([]);
          // Not even a cost: no move in a quick start raises a warning either.
          expect(issues.filter((i) => /items\[/.test(i.path)), `${kind} seed ${seed}`).toEqual([]);
          const minutes = deriveDoc(doc, EXERCISES).estimatedMinutes;
          expect(Math.abs(minutes - QUICK_START_MINUTES[kind]), `${kind} seed ${seed}: ${minutes} min`).toBeLessThanOrEqual(2);
          for (const id of itemIds(doc)) expect(isPlyometric(rec(id)), id).toBe(false);
          // One move per family.
          expect(new Set(itemIds(doc).map((id) => rec(id).family)).size, `${kind} seed ${seed}`).toBe(itemIds(doc).length);
        }
      });
    }
  }
});

describe("what each one holds", () => {
  it("condition care: recovery mode, the profile's care moves then passive ones, titled by the profile's block", () => {
    for (const seed of SEEDS) {
      const doc = make("condition_care", seed);
      expect(doc.intent.effort).toBe("recover");
      expect(doc.title).toBe(TMJ.care!.block.label);
      const recs = itemIds(doc).map(rec);
      for (const r of recs) expect(r.purposes, r.id).toContain("condition-care");
      expect(recs.some((r) => r.roles.some((x) => TMJ.care!.block.roles.includes(x)) && !r.contraction.every((c) => c === "passive"))).toBe(true);
      expect(recs.some((r) => r.contraction.every((c) => c === "passive"))).toBe(true);
    }
  });

  it("desk reset: desk-relief and posture moves — even when every one of them was done recently", () => {
    const deskMoves = EXERCISES.filter((e) => e.tags.includes("desk-relief") || e.tags.includes("posture")).map((e) => e.id);
    for (const recentIds of [[], deskMoves]) {
      for (const seed of SEEDS) {
        for (const r of itemIds(make("desk_reset", seed, { recentIds })).map(rec)) expect(r.tags.some((t) => t === "desk-relief" || t === "posture"), r.id).toBe(true);
      }
    }
  });

  it("hip opener: hip-opening moves and the focus areas", () => {
    const focus = new Set(CTX.focusRefs);
    const fits = (r: ExerciseRecord): boolean =>
      r.tags.includes("hip-opening") || r.regions.some((g) => focus.has(g)) || r.muscles.primary.some((m) => focus.has(m) || focus.has(MUSCLE_REGION[m as MuscleId]));
    let focusOnly = 0;
    for (const seed of SEEDS) {
      for (const r of itemIds(make("hip_opener", seed)).map(rec)) {
        expect(fits(r), r.id).toBe(true);
        if (!r.tags.includes("hip-opening")) focusOnly++;
      }
    }
    expect(focusOnly).toBeGreaterThan(0);
  });

  it("maintain on a calm day; recovery when the day asks for it; condition care always recovery", () => {
    for (const kind of ["desk_reset", "hip_opener"] as const) {
      expect(make(kind, 1).intent.effort, kind).toBe("maintain");
      expect(make(kind, 1, { day: DAYS.flare }).intent.effort, kind).toBe("recover");
      expect(make(kind, 1, { day: DAYS["feeling off"] }).intent.effort, kind).toBe("recover");
    }
    expect(make("condition_care", 1).intent.effort).toBe("recover");
  });

  it("never a jump, even when a focus area pulls one in", () => {
    for (const seed of SEEDS) {
      for (const id of itemIds(make("hip_opener", seed, { focusRefs: ["calves", "ankles", "feet"] }))) expect(isPlyometric(rec(id)), id).toBe(false);
    }
  });

  it("every item says why it is there; the document says what it is for", () => {
    for (const kind of KINDS) {
      const doc = make(kind, 1);
      expect(doc.intent.summary.length).toBeGreaterThan(0);
      for (const p of doc.parts) {
        expect(p.why, `${kind} ${p.purpose}`).toBeTruthy();
        for (const i of p.items) if (i.kind === "exercise") expect(i.why, i.libraryId).toBeTruthy();
      }
    }
  });
});

describe("varied, and respectful of the athlete's lists", () => {
  it("two seeds differ; the same seed gives the same document", () => {
    for (const kind of KINDS) {
      const docs = SEEDS.map((s) => JSON.stringify(make(kind, s)));
      expect(new Set(docs).size, kind).toBeGreaterThan(1);
      expect(JSON.stringify(make(kind, 7))).toBe(docs[6]);
    }
  });

  it("moves done recently give way to others", () => {
    for (const kind of KINDS) {
      const first = itemIds(make(kind, 3));
      const next = itemIds(make(kind, 3, { recentIds: first }));
      expect(next.filter((id) => first.includes(id)).length, kind).toBeLessThan(first.length);
    }
  });

  it("never a move set aside, never gear the place lacks", () => {
    const aside = itemIds(make("hip_opener", 1)).slice(0, 2);
    for (const seed of SEEDS) expect(itemIds(make("hip_opener", seed, { excluded: aside })).filter((id) => aside.includes(id))).toEqual([]);
    for (const kind of KINDS) {
      for (const seed of SEEDS.slice(0, 5)) {
        const doc = make(kind, seed, { equipment: ["mat"] });
        for (const id of itemIds(doc)) expect(hasEquipment(rec(id), ["mat"]), `${kind} ${id}`).toBe(true);
        expect(Math.abs(deriveDoc(doc, EXERCISES).estimatedMinutes - QUICK_START_MINUTES[kind]), kind).toBeLessThanOrEqual(2);
      }
    }
  });

  it("filled with moves while the library has them; short of moves, a set more to reach the length", () => {
    for (const kind of KINDS) for (const seed of SEEDS) for (const p of make(kind, seed).parts) for (const i of p.items) if (i.kind === "exercise") expect(i.dose.sets, `${kind} ${i.libraryId}`).toBe(1);
    const keep = new Set(["hipOpeningFlow", "lowLunge", "figureFour"]);
    const doc = make("hip_opener", 1, { excluded: EXERCISES.map((e) => e.id).filter((id) => !keep.has(id)) });
    expect(itemIds(doc).sort()).toEqual([...keep].sort());
    expect(doc.parts.some((p) => p.items.some((i) => i.kind === "exercise" && (i.dose.sets ?? 1) > 1))).toBe(true);
    expect(Math.abs(deriveDoc(doc, EXERCISES).estimatedMinutes - QUICK_START_MINUTES.hip_opener)).toBeLessThanOrEqual(2);
  });

  it("condition care is offered only while a profile with care is active", () => {
    expect(quickStartKinds({ activeProfiles: [TMJ] })).toEqual(["condition_care", "desk_reset", "hip_opener"]);
    expect(quickStartKinds({ activeProfiles: [] })).toEqual(["desk_reset", "hip_opener"]);
    expect(() => make("condition_care", 1, { activeProfiles: [] })).toThrow();
  });
});
