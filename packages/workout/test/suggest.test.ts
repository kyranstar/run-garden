/**
 * SUGGESTIONS (Stage 2 spec §8; principles §2.1, §2.5): the prompting around warm-ups and cool-downs. A warm-up rehearses
 * the main part, activation wakes its prime movers before they load, a cool-down eases what was worked and the athlete's
 * focus areas, care offers the active profile's care moves. Every suggestion passes the validator for the day. The
 * condition profile in these tests is the library's own; nothing here is personal.
 */
import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, PART_FORMATS, PART_PURPOSES, type WorkoutDoc, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, GLOSSARY, TMJ, hasEquipment, isPlyometric, type CheckReading, type ExerciseRecord } from "@rg/exercise-library";
import { suggestForPart, suggestedItem, validateWorkoutDoc, type DayContext, type SuggestCtx, type Suggestion } from "../src/index.js";

type Over = Record<string, unknown>;
const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => {
  const r = byId.get(id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};
const ex = (libraryId: string, dose: Over = { sets: 2, reps: 8 }): WorkoutItem => ({ kind: "exercise", libraryId, dose }) as WorkoutItem;
const part = (purpose: string, format: string, items: WorkoutItem[]): WorkoutPart => ({ purpose, format, items }) as WorkoutPart;
const docOf = (parts: WorkoutPart[], effort: WorkoutDoc["intent"]["effort"] = "maintain", focus: string[] = []): WorkoutDoc =>
  ({ version: 1, title: "Test", intent: { summary: "A test workout.", goals: [], focus, effort }, parts, source: { kind: "studio" } }) as WorkoutDoc;

const TODAY = "2026-03-10";
const reading = (pre: number | null, feelingOff = false): CheckReading => ({ pre, post: null, feelingOff });
const dayOf = (r: CheckReading | null, o: Partial<DayContext> = {}): DayContext => ({ date: TODAY, today: TODAY, readings: { tmj: r }, ...o });
const CALM = dayOf(reading(1));
const DAYS: Record<string, DayContext | null> = {
  calm: CALM,
  flare: dayOf(reading(7)),
  unanswered: dayOf(null),
  "feeling off": dayOf(reading(1, true)),
  future: dayOf(null, { date: "2026-03-14" }),
  template: null,
};

const CTX: SuggestCtx = { activeProfiles: [TMJ], day: CALM, focusRefs: [], recentIds: [], pinned: [], excluded: [], equipment: EQUIPMENT_IDS };
const suggest = (doc: WorkoutDoc, i: number, o: Partial<SuggestCtx> = {}): Suggestion[] => suggestForPart(doc, i, EXERCISES, { ...CTX, ...o });
const ids = (s: readonly Suggestion[]): string[] => s.map((x) => x.libraryId);

/** A draft as the builder starts it: parts may be empty until something is added. */
const HINGE_DAY = docOf([part("warmup", "flow", []), part("activation", "straight", []), part("main", "straight", [ex("rdl")]), part("cooldown", "holds", [])]);
const SQUAT_DAY = docOf([part("warmup", "flow", []), part("activation", "straight", []), part("main", "straight", [ex("gobletSquat"), ex("bwSplitSquat")]), part("cooldown", "holds", [])]);

describe("activation wakes the main part's prime movers before they load", () => {
  it("a hinge gets a glute activation suggestion first, with its reason", () => {
    const s = suggest(HINGE_DAY, 1);
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(rec(s[0]!.libraryId).tags).toContain("glute-activation");
    expect(s[0]!.reason).toBe("wakes the glutes before Romanian deadlift");
    for (const x of s) expect(rec(x.libraryId).purposes).toContain("activation");
    // Even a harder glute activation outranks an easier hinge drill that wakes both prime movers (no warm-up part here
    // to take the drill).
    const noWarmup = docOf([part("activation", "straight", []), part("main", "straight", [ex("rdl")])]);
    expect(ids(suggest(noWarmup, 0, { excluded: ["activePigeonLegLift", "bridgeBlock", "bridge"] }))[0]).toBe("singleLegBridge");
  });

  it("with work to wake, never drifts to a focus area", () => {
    for (const x of suggest(HINGE_DAY, 1, { focusRefs: ["thoracic", "upper-back"] })) expect(x.reason).toMatch(/^wakes the .+ before Romanian deadlift$/);
  });

  it("so does a squat; every suggestion works a prime mover or the glute med that steadies the knee", () => {
    const s = suggest(SQUAT_DAY, 1);
    expect(rec(s[0]!.libraryId).tags).toContain("glute-activation");
    const movers = new Set(["quads", "glute-max", "glute-med"]);
    for (const x of s) expect(rec(x.libraryId).muscles.primary.some((m) => movers.has(m)), x.libraryId).toBe(true);
    expect(s.map((x) => x.reason)).toContain("wakes the glute med before Goblet squat");
  });

  it("a press wakes the shoulder's stabilisers: rotator cuff, serratus, lower traps", () => {
    const press = docOf([part("activation", "straight", []), part("main", "straight", [ex("floorPress"), ex("pushup")])]);
    const s = suggest(press, 0);
    expect(s.length).toBeGreaterThan(0);
    const stabilisers = new Set(["rotator-cuff", "serratus-anterior", "lower-traps"]);
    expect(s.some((x) => rec(x.libraryId).muscles.primary.some((m) => stabilisers.has(m)))).toBe(true);
    expect(s.some((x) => /^wakes the (rotator cuff|serratus|lower traps) before (Floor press|Push-up)$/.test(x.reason))).toBe(true);
  });
});

describe("a warm-up rehearses the main part", () => {
  it("before a hinge: a hinge pattern first, the rest warm the areas the hinge works", () => {
    const s = suggest(HINGE_DAY, 0);
    expect(s).toHaveLength(3);
    expect(rec(s[0]!.libraryId).patterns).toContain("hinge");
    expect(s[0]!.reason).toBe("rehearses the hinge for Romanian deadlift");
    const worked = new Set(rec("rdl").regions);
    for (const x of s) {
      const r = rec(x.libraryId);
      expect(r.purposes.some((p) => p === "warmup" || p === "mobility"), x.libraryId).toBe(true);
      expect(r.regions.some((g) => worked.has(g)) || r.patterns.includes("hinge"), x.libraryId).toBe(true);
    }
  });
});

describe("a warm-up raises the temperature: never a passive move, nor a stretch or a recovery move", () => {
  const cooling = (id: string): boolean => {
    const r = rec(id);
    const rest = r.purposes.filter((p) => p !== "mobility");
    return !r.purposes.includes("warmup") && rest.length > 0 && rest.every((p) => p === "stretch" || p === "cooldown" || p === "recovery");
  };
  it("nothing passive before an RDL or a goblet squat, on any day, with any focus", () => {
    for (const doc of [HINGE_DAY, SQUAT_DAY]) {
      for (const day of Object.values(DAYS)) {
        for (const focusRefs of [[], ["hip-flexors", "thoracic"], ["hips"], ["neck", "jaw"]]) {
          for (const x of suggest(doc, 0, { day, focusRefs })) {
            expect(rec(x.libraryId).contraction.every((c) => c === "passive"), x.libraryId).toBe(false);
            expect(cooling(x.libraryId), x.libraryId).toBe(false);
          }
        }
      }
    }
  });

  it("with only a focus to warm, across seeds that rotate the ties: still nothing passive, nothing only for cooling down", () => {
    for (const focus of [["thoracic"], ["chest"], ["hips"], ["hip-flexors"], ["glutes"], ["neck"], ["upper-back"]]) {
      const doc = docOf([part("warmup", "flow", []), part("main", "straight", [])], "maintain", focus);
      for (let seed = 1; seed <= 20; seed++) {
        for (const x of suggest(doc, 0, { seed })) {
          expect(rec(x.libraryId).contraction.every((c) => c === "passive"), `${focus} ${x.libraryId}`).toBe(false);
          expect(cooling(x.libraryId), `${focus} ${x.libraryId}`).toBe(false);
        }
      }
    }
  });

  it("warms what the pattern asks of the joints: ankles and hips for a squat, upper spine and shoulders for a press", () => {
    const squat = docOf([part("warmup", "flow", []), part("main", "straight", [ex("gobletSquat")])]);
    const all = (doc: WorkoutDoc) => [...suggest(doc, 0), ...suggest(doc, 0, { recentIds: ids(suggest(doc, 0)) })];
    expect(all(squat).some((x) => rec(x.libraryId).regions.includes("ankles"))).toBe(true);
    const press = docOf([part("warmup", "flow", []), part("main", "straight", [ex("floorPress")])]);
    expect(all(press).some((x) => rec(x.libraryId).regions.some((g) => g === "thoracic") && /^warms the .*(upper spine|shoulders).* for Floor press$/.test(x.reason))).toBe(true);
  });
});

describe("one part per move: it is offered where it fits best", () => {
  it("the hinge drill rehearses the hinge in the warm-up rather than waking the hamstrings in activation", () => {
    expect(ids(suggest(HINGE_DAY, 0))).toContain("hingeDrill");
    expect(ids(suggest(HINGE_DAY, 1))).not.toContain("hingeDrill");
    // With no warm-up to take it, activation offers it.
    expect(ids(suggest(docOf([part("activation", "straight", []), part("main", "straight", [ex("rdl")])]), 0))).toContain("hingeDrill");
  });

  it("on a tie the earlier part keeps the move: legs up settles you in, rather than winding you down", () => {
    const doc = docOf([part("arrive", "holds", []), part("cooldown", "holds", [])]);
    expect(ids(suggest(doc, 0))).toContain("legsUp");
    expect(ids(suggest(doc, 1))).not.toContain("legsUp");
  });

  it("a core lift goes to the main part, a move that is only an accessory to the accessory part", () => {
    const doc = docOf([part("main", "straight", [ex("gobletSquat")]), part("accessory", "straight", [])]);
    const main = suggest(doc, 0);
    const acc = suggest(doc, 1);
    expect(main.length).toBeGreaterThan(0);
    expect(acc.length).toBeGreaterThan(0);
    for (const x of main) expect(rec(x.libraryId).roles, x.libraryId).toContain("core");
    for (const x of acc) expect(rec(x.libraryId).roles, x.libraryId).not.toContain("core");
  });

  it("no move is offered in two parts of one document", () => {
    const full = docOf([part("warmup", "flow", []), part("activation", "straight", []), part("main", "straight", [ex("gobletSquat")]), part("accessory", "straight", []), part("cooldown", "holds", [])]);
    for (const doc of [HINGE_DAY, SQUAT_DAY, full]) {
      for (const focusRefs of [[], ["hips", "thoracic"]]) {
        const lists = doc.parts.map((_, i) => ids(suggest(doc, i, { focusRefs })));
        const flat = lists.flat();
        expect(new Set(flat).size, JSON.stringify(lists)).toBe(flat.length);
      }
    }
  });
});

describe("a cool-down eases what the main part worked and the focus areas", () => {
  it("after squats: quad, glute and hip stretches", () => {
    const s = suggest(SQUAT_DAY, 3);
    expect(s).toHaveLength(3);
    for (const x of s) {
      const r = rec(x.libraryId);
      expect(r.regions.some((g) => g === "quads" || g === "hips" || g === "glutes"), x.libraryId).toBe(true);
      expect(r.purposes.some((p) => p === "stretch" || p === "cooldown" || p === "mobility" || p === "recovery"), x.libraryId).toBe(true);
      expect(r.purposes.some((p) => p === "strength" || p === "power"), x.libraryId).toBe(false);
      expect(x.reason).toMatch(/ after (Goblet squat|Split squat)$/);
    }
  });

  it("never a warm-up flow, never a lift", () => {
    const both = docOf([part("main", "straight", [ex("rdl"), ex("gobletSquat")]), part("cooldown", "holds", [])]);
    const none = docOf([part("main", "straight", []), part("cooldown", "holds", [])]);
    // A cool-down on its own: no main part to claim a lift that serves a focus area.
    const alone = docOf([part("cooldown", "holds", [])]);
    const cases: Array<[WorkoutDoc, string[]]> = [[both, []], [both, ["hip-flexors", "thoracic"]], [both, ["hamstrings"]], [none, ["soleus", "ankles"]], [none, ["glute-min-tfl"]], [alone, ["glute-min-tfl"]]];
    for (const [doc, focusRefs] of cases) {
      const cool = doc.parts.findIndex((p) => p.purpose === "cooldown");
      for (const x of suggest(doc, cool, { focusRefs })) {
        const r = rec(x.libraryId);
        const easing = r.purposes.some((p) => p === "stretch" || p === "cooldown" || p === "recovery") || r.contraction.every((c) => c === "passive");
        expect(easing || !r.purposes.includes("warmup"), x.libraryId).toBe(true);
        expect(r.purposes.some((p) => p === "strength" || p === "power"), x.libraryId).toBe(false);
      }
    }
  });

  it("a focus area joins in; with no main work the focus areas lead", () => {
    const empty = docOf([part("warmup", "flow", []), part("main", "straight", []), part("cooldown", "holds", [])]);
    const s = suggest(empty, 2, { focusRefs: ["upper-back"] });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      const r = rec(x.libraryId);
      expect(r.regions.includes("upper-back") || [...r.muscles.primary].some((m) => ["rhomboids", "lower-traps", "upper-traps", "middle-traps"].includes(m)), x.libraryId).toBe(true);
      expect(x.reason).toBe("eases your upper back, a focus area");
    }
  });
});

describe("care offers the active profile's care moves", () => {
  const doc = docOf([part("main", "straight", [ex("gobletSquat")]), part("care", "holds", [])]);
  it("its block's moves while a profile is active, nothing without one", () => {
    const s = suggest(doc, 1);
    expect(s.length).toBeGreaterThan(0);
    const roles = new Set(TMJ.care!.block.roles);
    for (const x of s) expect(rec(x.libraryId).roles.some((r) => roles.has(r)), x.libraryId).toBe(true);
    expect(s[0]!.reason).toBe(`part of your ${TMJ.care!.block.label.toLowerCase()}`);
    expect(suggest(doc, 1, { activeProfiles: [] })).toEqual([]);
  });
});

describe("every suggestion passes the validator for the day", () => {
  const all = (effort: WorkoutDoc["intent"]["effort"]): WorkoutDoc =>
    docOf(
      [
        part("arrive", "holds", [ex("legsUp", { holdSec: 60 })]),
        part("warmup", "flow", [ex("catCow", { reps: 8 })]),
        part("activation", "straight", [ex("birdDog", { reps: 6 })]),
        part("power", "straight", [ex("landingStick", { sets: 2, reps: 4 })]),
        part("main", "straight", [ex("rdl"), ex("gobletSquat")]),
        part("accessory", "straight", [ex("deadBug", { reps: 6 })]),
        part("care", "holds", [ex("chinTuck", { reps: 8 })]),
        part("cooldown", "holds", [ex("childHands", { holdSec: 60 })]),
      ],
      effort,
      ["hips"],
    );

  for (const [name, day] of Object.entries(DAYS)) {
    for (const effort of ["recover", "maintain", "develop"] as const) {
      it(`${name} day, ${effort}: no suggestion raises an issue, and none adds an error`, () => {
        const doc = all(effort);
        const v = { library: EXERCISES, activeProfiles: [TMJ], day, equipment: EQUIPMENT_IDS };
        const before = validateWorkoutDoc(doc, v).filter((i) => i.severity === "error").length;
        doc.parts.forEach((p, pi) => {
          const s = suggest(doc, pi, { day, focusRefs: ["hips"] });
          expect(s.length).toBeLessThanOrEqual(3);
          for (const x of s) {
            const r = rec(x.libraryId);
            const items = [...p.items, suggestedItem(r, p.purpose)];
            const next = { ...doc, parts: doc.parts.map((q, qi) => (qi === pi ? { ...q, items } : q)) };
            const issues = validateWorkoutDoc(next, v);
            const at = `parts[${pi}].items[${items.length - 1}]`;
            expect(issues.filter((i) => i.path.startsWith(at)), `${p.purpose}: ${x.libraryId}`).toEqual([]);
            expect(issues.filter((i) => i.severity === "error").length, `${p.purpose}: ${x.libraryId}`).toBe(before);
            expect(x.reason.length).toBeGreaterThan(0);
            expect(x.reason.length).toBeLessThanOrEqual(120);
          }
        });
      });
    }
  }
});

describe("the athlete's lists and the place", () => {
  it("never suggests a move already in the document", () => {
    const withBridge = docOf([part("activation", "straight", [ex("bridge", { reps: 10 })]), part("main", "straight", [ex("rdl")])]);
    expect(ids(suggest(withBridge, 0))).not.toContain("bridge");
    // Nor another of its family in the same part.
    expect(ids(suggest(withBridge, 0)).filter((id) => rec(id).family === rec("bridge").family)).toEqual([]);
    // A move anywhere else in the document — an item or an alternate — is not offered again.
    const elsewhere = docOf([
      part("activation", "straight", []),
      part("main", "straight", [ex("rdl"), { ...ex("bridgeBlock", { reps: 10 }), alternates: [{ libraryId: "bridge" }] } as WorkoutItem]),
    ]);
    const offered = ids(suggest(elsewhere, 0));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain("bridgeBlock");
    expect(offered).not.toContain("bridge");
    expect(ids(suggest(HINGE_DAY, 2))).not.toContain("rdl");
  });

  it("never suggests a move set aside, or one needing gear the place lacks", () => {
    const first = ids(suggest(HINGE_DAY, 1))[0]!;
    expect(ids(suggest(HINGE_DAY, 1, { excluded: [first] }))).not.toContain(first);
    for (const i of [0, 1, 3]) {
      const s = suggest(HINGE_DAY, i, { equipment: ["mat"] });
      expect(s.length).toBeGreaterThan(0);
      for (const x of s) expect(hasEquipment(rec(x.libraryId), ["mat"]), x.libraryId).toBe(true);
    }
  });

  it("novelty: a move done recently gives way to one that wasn't", () => {
    const s0 = ids(suggest(HINGE_DAY, 1));
    const s1 = ids(suggest(HINGE_DAY, 1, { recentIds: [s0[0]!] }));
    expect(s1[0]).not.toBe(s0[0]);
    expect(rec(s1[0]!).tags).toContain("glute-activation");
  });

  it("pins: of two glute bridges that fit alike, the pinned one comes first", () => {
    for (const pin of ["bridge", "bridgeBlock"]) expect(ids(suggest(HINGE_DAY, 1, { pinned: [pin] }))[0]).toBe(pin);
  });

  it("variety: one per family, and different reasons before any repeats", () => {
    const noWarmup = docOf([part("activation", "straight", []), part("main", "straight", [ex("rdl")])]);
    const s = suggest(noWarmup, 0);
    expect(s.map((x) => x.reason)).toEqual(["wakes the glutes before Romanian deadlift", "wakes the hamstrings before Romanian deadlift", "wakes the glutes before Romanian deadlift"]);
    for (const doc of [HINGE_DAY, SQUAT_DAY]) {
      for (const i of [0, 1, 3]) {
        const families = suggest(doc, i).map((x) => rec(x.libraryId).family);
        expect(new Set(families).size, `part ${i}`).toBe(families.length);
      }
    }
  });
});

describe("jumps only in a power part, on a day that passes the gate", () => {
  const doc = (effort: WorkoutDoc["intent"]["effort"]): WorkoutDoc =>
    docOf([part("warmup", "flow", []), part("power", "straight", []), part("main", "straight", [ex("gobletSquat")]), part("cooldown", "holds", [])], effort);

  it("a calm, answered day: the power part offers the bottom rungs first", () => {
    const s = suggest(doc("maintain"), 1);
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      expect(isPlyometric(rec(x.libraryId))).toBe(true);
      expect(rec(x.libraryId).easier).toEqual([]); // nothing done yet: the gentlest variants
    }
    // With the bottom rungs done, the next ones up are open — and nothing past them.
    const done = new Set(["snapDown", "landingStick"]);
    const up = ids(suggest(doc("maintain"), 1, { day: dayOf(reading(1), { done }) }));
    expect(up.some((id) => rec(id).easier.length > 0)).toBe(true);
    for (const id of up) expect(rec(id).easier.length === 0 || rec(id).easier.some((e) => done.has(e)), id).toBe(true);
  });

  it("never on a recovery, unanswered, feeling-off, future or template day", () => {
    expect(suggest(doc("recover"), 1)).toEqual([]);
    for (const day of [dayOf(null), dayOf(reading(1, true)), dayOf(reading(1), { date: "2026-03-12" }), null]) {
      expect(ids(suggest(doc("maintain"), 1, { day })).filter((id) => isPlyometric(rec(id)))).toEqual([]);
    }
  });

  it("never in any other part, on any day — even with rungs done that open the warm-up's hops", () => {
    const parts = docOf(
      [part("warmup", "flow", []), part("activation", "straight", []), part("main", "straight", [ex("gobletSquat")]), part("accessory", "straight", []), part("cooldown", "holds", [])],
      "develop",
    );
    const done = new Set(["snapDown", "landingStick", "pogoHop"]);
    // With the calves as the focus and nothing in the main part, a hop would rank high in a warm-up or an accessory.
    const calves = docOf([part("warmup", "flow", []), part("main", "straight", []), part("accessory", "straight", [])], "develop");
    for (const day of Object.values(DAYS)) {
      for (const i of [0, 1, 2, 3, 4]) expect(ids(suggest(parts, i, { day: day ? { ...day, done } : null })).filter((id) => isPlyometric(rec(id)))).toEqual([]);
      for (const i of [0, 2]) expect(ids(suggest(calves, i, { day: day ? { ...day, done } : null, focusRefs: ["calves"] })).filter((id) => isPlyometric(rec(id)))).toEqual([]);
    }
  });

  it("with no profile switched on, still never on a recovery or feeling-off day", () => {
    expect(ids(suggest(doc("recover"), 1, { activeProfiles: [] })).filter((id) => isPlyometric(rec(id)))).toEqual([]);
    expect(ids(suggest(doc("maintain"), 1, { activeProfiles: [], day: dayOf(null, { readings: {}, feelingOff: true }) })).filter((id) => isPlyometric(rec(id)))).toEqual([]);
    expect(ids(suggest(doc("maintain"), 1, { activeProfiles: [], day: dayOf(null, { readings: {} }) })).some((id) => isPlyometric(rec(id)))).toBe(true);
  });
});

describe("main and accessory: easier first, ties taking turns by seed", () => {
  it("no hard eccentric leads an accessory part, and an accessory after a main part still gets lifts to suggest", () => {
    // A squat day: a hinge is what the workout lacks, and the hardest hinge (an eccentric Nordic curl) must not lead.
    const acc = docOf([part("main", "straight", [ex("gobletSquat")]), part("accessory", "straight", [])], "develop");
    for (const day of Object.values(DAYS)) {
      const s = suggest(acc, 1, { day });
      expect(s.length, String(day?.date)).toBeGreaterThan(0);
      expect(rec(s[0]!.libraryId).difficulty, s[0]!.libraryId).toBeLessThanOrEqual(3);
      expect(s.some((x) => rec(x.libraryId).purposes.includes("strength")), String(day?.date)).toBe(true);
    }
  });

  it("the same seed gives the same list; seeds take turns among equal fits; no seed sorts by name", () => {
    const empty = docOf([part("main", "straight", [])], "maintain");
    const at = (seed?: number) => ids(suggest(empty, 0, { seed }));
    expect(at(3)).toEqual(at(3));
    expect(new Set(Array.from({ length: 12 }, (_, i) => at(i + 1).join(","))).size).toBeGreaterThan(1);
    expect(at()).toEqual(at());
  });
});

describe("a malformed part is a programming error", () => {
  it("throws rather than quietly offering nothing", () => {
    const bad = docOf([part("cooldown", "nope", []), part("main", "straight", [ex("gobletSquat")])]);
    expect(() => suggest(bad, 0)).toThrow(/malformed/);
  });
});

describe("the builder's words are in the glossary", () => {
  it("every part purpose, format and effort has a sentence", () => {
    expect([...PART_PURPOSES, ...PART_FORMATS, ...EFFORT_LEVELS].filter((id) => !(id in GLOSSARY))).toEqual([]);
  });
});
