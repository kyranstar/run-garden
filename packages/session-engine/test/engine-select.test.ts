import type { CoverageTargets } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Coverage, Lib, Rng, Select, type HistorySession, type SelectCtx } from "../src/index.js";
import { dataWith, ex, session } from "./fixtures.js";

// Ported from the standalone tests/engine-select.test.js.

const base = dataWith([
  ex("hipA", { regions: ["hips"], position: "supine" }),
  ex("hipB", { regions: ["hips"], position: "standing" }),
  ex("neck", { regions: ["neck"], position: "seated" }),
  ex("thoracic", { regions: ["thoracic"], position: "supine", tags: ["desk-relief"] }),
]);
const today = "2026-09-29";
const byId = (ids: string[]) => ids.map(id => Lib.get(base, id)!);
const ids = (ranked: ReturnType<typeof Select.rank>) => ranked.map(r => r.ex.id);

interface CtxExtra extends Partial<SelectCtx> { sessions?: HistorySession[]; targets?: CoverageTargets }
function ctx(extra: CtxExtra = {}): SelectCtx {
  const { sessions = [], targets = { patterns: {}, regions: {} }, ...rest } = extra;
  const data = { ...base, targets };
  const debt = Coverage.debt(data, sessions, today);
  return {
    today, theme: null, debt, maxDebt: Math.max(1, ...Object.values(debt.patterns), ...Object.values(debt.regions)),
    coverageLast: Coverage.exposures(data, sessions, today).last, stats: Select.stats(data, sessions, today),
    prefs: { ratings: {}, excluded: [], pinned: [] }, rng: Rng.create("seed"), newMoveOpen: false,
    ...rest,
  };
}

test("theme fit outranks everything else being equal", () => {
  const theme = { id: "t", name: "Desk", blurb: "", modes: [], formats: [], coreBias: [], emphasis: { patterns: {}, regions: { thoracic: 2 }, tags: { "desk-relief": 2 } } };
  const ranked = Select.rank(base, byId(["hipA", "neck", "thoracic"]), ctx({ theme }));
  expect(ranked[0]!.ex.id).toBe("thoracic");
  expect(ranked[0]!.reasons[0]).toBe("Fits today's theme: Desk");
});

test("debt: an untrained region ranks first and says for how long", () => {
  const sessions = [session("2026-09-20", { done: [{ id: "neck" }] }), session("2026-09-28", { done: [{ id: "hipA" }, { id: "hipB" }] })];
  const c = ctx({ sessions, targets: { patterns: {}, regions: { neck: 2, hips: 1 } } });
  const ranked = Select.rank(base, byId(["hipA", "neck"]), c);
  expect(ranked[0]!.ex.id).toBe("neck");
  expect(ranked[0]!.reasons, ranked[0]!.reasons.join(" | ")).toContain("Neck: 9 days since trained");
});

test("no 'not trained yet' reasons before there's any history", () => {
  const ranked = Select.rank(base, byId(["hipA", "neck"]), ctx({ targets: { patterns: { mobility: 2 }, regions: { hips: 2 } } }));
  for (const r of ranked) expect(r.reasons.some(x => /trained|behind/.test(x)), r.reasons.join(" | ")).toBe(false);
});

test("reasons name a body area before a movement type", () => {
  const sessions = [session("2026-09-20", { done: [{ id: "neck" }] })];
  const ranked = Select.rank(base, byId(["hipA"]), ctx({ sessions, targets: { patterns: { mobility: 5 }, regions: { hips: 1 } } }));
  expect(ranked[0]!.reasons.some(x => x.startsWith("Hips")), ranked[0]!.reasons.join(" | ")).toBe(true);
});

test("ratings and recent repetition move exercises up and down", () => {
  const liked = ctx({ prefs: { ratings: { hipB: 1, hipA: -1 }, excluded: [], pinned: [] } });
  expect(ids(Select.rank(base, byId(["hipA", "hipB"]), liked))).toEqual(["hipB", "hipA"]);
  expect(Select.rank(base, byId(["hipB"]), liked)[0]!.reasons).toContain("You rated this 👍");
  const sessions = [session("2026-09-27", { done: [{ id: "hipA" }] }), session("2026-09-28", { done: [{ id: "hipA" }] }), session("2026-09-01", { done: [{ id: "hipB" }] })];
  expect(ids(Select.rank(base, byId(["hipA", "hipB"]), ctx({ sessions })))).toEqual(["hipB", "hipA"]);
});

test("repetition looks back three sessions, not just two", () => {
  // hipA was done 3 sessions ago, hipB 4 sessions ago; both are old enough for full novelty.
  const sessions = [
    session("2026-08-01", { done: [{ id: "hipB" }] }),
    session("2026-08-02", { done: [{ id: "hipA" }] }),
    session("2026-08-03", { done: [{ id: "neck" }] }),
    session("2026-08-04", { done: [{ id: "thoracic" }] }),
  ];
  // Flow gives hipA a small edge (+1); the repetition penalty must outweigh it.
  expect(Select.rank(base, byId(["hipA", "hipB"]), ctx({ sessions, prevPosition: "supine" }))[0]!.ex.id).toBe("hipB");
});

test("flow prefers the same position group as the previous exercise", () => {
  const sessions = [session("2026-09-01", { done: [{ id: "hipA" }, { id: "hipB" }] })];
  expect(Select.rank(base, byId(["hipA", "hipB"]), ctx({ sessions, prevPosition: "standing" }))[0]!.ex.id).toBe("hipB");
  expect(Select.rank(base, byId(["hipA", "hipB"]), ctx({ sessions, prevPosition: "prone" }))[0]!.ex.id).toBe("hipA");
});

test("never-done exercises get the New badge only while the weekly slot is open", () => {
  const sessions = [session("2026-09-01", { done: [{ id: "hipA" }] })];
  const open = Select.rank(base, byId(["hipA", "hipB"]), ctx({ sessions, newMoveOpen: true }));
  expect(open[0]!.ex.id).toBe("hipB");
  expect(open[0]!.isNew).toBe(true);
  expect(open[0]!.reasons[0]).toBe("New move this week");
  expect(Select.rank(base, byId(["hipB"]), ctx({ sessions }))[0]!.isNew).toBe(false);
});

test("moves from the user's saved reels get a bonus and say so", () => {
  const sessions = [session("2026-09-01", { done: [{ id: "hipA" }, { id: "hipB" }] })];
  // Saves are the person's own (their private provenance), passed in as ids, never read from the record.
  const ranked = Select.rank(base, byId(["hipB", "hipA"]), ctx({ sessions, saved: new Set(["hipA"]) }));
  expect(ranked[0]!.ex.id).toBe("hipA");
  expect(ranked[0]!.reasons).toContain("From your saves");
  expect(Select.rank(base, byId(["hipB", "hipA"]), ctx({ sessions }))[0]!.reasons).not.toContain("From your saves");
});

test("prep bonus for exercises that share a region with today's core lifts", () => {
  const sessions = [session("2026-09-01", { done: [{ id: "hipA" }, { id: "neck" }] })];
  const ranked = Select.rank(base, byId(["neck", "hipA"]), ctx({ sessions, coreRegions: ["hips"] }));
  expect(ranked[0]!.ex.id).toBe("hipA");
  expect(ranked[0]!.reasons).toContain("Preps today's lifts");
});

test("damaged history doesn't crash stats", () => {
  expect(() => Select.stats(base, [{ id: "x", date: "2026-09-10", entries: [null], done: [null] } as unknown as HistorySession], today)).not.toThrow();
});

test("ranking is deterministic for the same seed", () => {
  const a = ids(Select.rank(base, byId(["hipA", "hipB", "neck", "thoracic"]), ctx()));
  const b = ids(Select.rank(base, byId(["hipA", "hipB", "neck", "thoracic"]), ctx()));
  expect(a).toEqual(b);
});

describe("beyond the standalone suite", () => {
  test("a move flagged in logged sessions is penalised by the profile's weight × its flag rate", () => {
    const sessions = [
      session("2026-08-01", { entries: [{ id: "hipA", clenched: true, sets: [] }, { id: "hipB", sets: [] }] }),
      session("2026-08-02", { entries: [{ id: "hipA", clenched: true, sets: [] }, { id: "hipB", sets: [] }] }),
    ];
    const c = ctx({ sessions, jitter: () => 0 });
    const [a, b] = [Select.score(base, Lib.get(base, "hipA")!, c), Select.score(base, Lib.get(base, "hipB")!, c)];
    expect(b.total - a.total).toBeCloseTo(2, 10);   // TMJ flagPenaltyWeight 2 × a flag rate of 1
    const none = { ...base, profiles: { active: [], care: [] } };
    expect(Select.score(none, Lib.get(base, "hipB")!, c).total - Select.score(none, Lib.get(base, "hipA")!, c).total).toBeCloseTo(0, 10);
  });
});
