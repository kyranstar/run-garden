/**
 * READ IT AGAIN, LINED UP (phase 5a plan Task 5; design 2026-11-05 §6.6): a re-read of a post that already has links is
 * stored only lined up with them — each found move at its link's position (links, provenance, corrections and the
 * coach's memory are all keyed by position), approved reading corrections applied again on top, saved insights kept,
 * new moves after the rest. A linked move the new reading doesn't hold keeps the earlier reading whole. Pure.
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { extractionSchema, type Extraction } from "@rg/saves";
import { alignReading, type KeptRow } from "../src/services/saves-reread.js";

const conditions = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "ok" },
  ]),
);
const move = (name: string, over: Record<string, unknown> = {}) => ({
  name, aliases: [] as string[], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose: `${name} purpose`,
  dose: { text: "10 each side", type: "reps" as const, range: [10, 10] as [number, number] }, patterns: ["mobility"], regions: ["hips"],
  equipment: ["mat"], position: "seated", laterality: "alternating", load: "bodyweight", contraction: ["isotonic"], difficulty: 2,
  conditions, evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high", ...over,
});
const reading = (names: (string | ReturnType<typeof move>)[], over: Record<string, unknown> = {}): Extraction =>
  extractionSchema.parse({ kind: "routine", summary: "s", themes: [], moves: names.map((n) => (typeof n === "string" ? move(n) : n)), ...over });
const earlier = (names: string[], over: Record<string, unknown> = {}) => ({ kind: "routine", summary: "old", themes: [], moves: names.map((name) => ({ name })), insights: ["Old note"], ...over });
const row = (position: number, name: string, over: Partial<KeptRow> = {}): KeptRow => ({ position, moveId: `my${position}`, moveKind: "personal", status: "saved", name, ...over });
const names = (x: Extraction) => x.moves.map((m) => m.name);

describe("alignReading", () => {
  it("a post with no links takes the new reading as it is", () => {
    const fresh = reading(["Zorbex hip lift", "Zorbex knee sway"]);
    const out = alignReading(fresh, { earlier: null, rows: [], fixes: [], keepInsights: false });
    expect(out).toEqual({ ok: true, extraction: fresh, kept: [], added: [0, 1] });
  });

  it("each found move sits at its link's position, whatever order the new reading found them in; new ones come after", () => {
    const fresh = reading(["Zorbex calf drop", "Zorbex hip lift", "Zorbex knee sway", "Zorbex ankle roll"], {
      routine: { order: [0, 1, 2, 3] },
      dropped: [{ move: 0, field: "regions", values: ["shinz"] }],
    });
    const out = alignReading(fresh, {
      earlier: earlier(["Zorbex hip lift", "Zorbex knee sway", "Zorbex calf drop"]),
      rows: [row(0, "Zorbex hip lift"), row(1, "Zorbex knee sway"), row(2, "Zorbex calf drop")],
      fixes: [], keepInsights: false,
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(names(out.extraction)).toEqual(["Zorbex hip lift", "Zorbex knee sway", "Zorbex calf drop", "Zorbex ankle roll"]);
    expect(out.kept).toEqual([0, 1, 2]);
    expect(out.added).toEqual([3]);
    // What points at a move by its place follows it.
    expect(out.extraction.routine?.order).toEqual([2, 0, 1, 3]);
    expect(out.extraction.dropped).toEqual([{ move: 2, field: "regions", values: ["shinz"] }]);
  });

  it("finds a move by the earlier reading's name, an alias, or the move's own (renamed) name", () => {
    // REBASED 2026-11-06 (phase 5 backfill; review I4): no close names — a near name may be another move.
    const fresh = reading(["Zorbex knee sway", move("Zorbex rib opener", { aliases: ["Zorbex side reach"] }), "Zorbex hip lift"]);
    const out = alignReading(fresh, {
      earlier: earlier(["Zorbex side reach", "Zorbex hip lift", "Kneeling sway"]),
      rows: [row(0, "My side reach"), row(1, "Zorbex hip lift"), row(2, "Zorbex knee sway")],
      fixes: [], keepInsights: false,
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(names(out.extraction)).toEqual(["Zorbex rib opener", "Zorbex hip lift", "Zorbex knee sway"]);
  });

  it("a row the owner left out is a place too: its move goes back there, not after", () => {
    const out = alignReading(reading(["Zorbex knee sway", "Zorbex hip lift"]), {
      earlier: earlier(["Zorbex hip lift", "Zorbex knee sway"]),
      rows: [row(0, "Zorbex hip lift"), row(1, "Zorbex knee sway", { status: "removed" })],
      fixes: [], keepInsights: false,
    });
    expect(out.ok && names(out.extraction)).toEqual(["Zorbex hip lift", "Zorbex knee sway"]);
  });

  it("a linked move the new reading doesn't hold: the earlier reading stays, and says which", () => {
    const out = alignReading(reading(["Zorbex hip lift", "Zorbex calf drop"]), {
      earlier: earlier(["Zorbex hip lift", "Zorbex knee sway"]),
      rows: [row(0, "Zorbex hip lift"), row(1, "Zorbex knee sway")],
      fixes: [], keepInsights: false,
    });
    expect(out).toEqual({ ok: false, why: "missing", missing: ["Zorbex knee sway"] });
  });

  it("an approved correction to the reading is applied again on the new words — the latest of each field", () => {
    const out = alignReading(reading(["Zorbex knee sway", "Zorbex hip lift"]), {
      earlier: earlier(["Zorbex hip lift", "Zorbex knee sway"]),
      rows: [row(0, "Zorbex hip lift"), row(1, "Zorbex knee sway")],
      fixes: [
        { position: 0, field: "why", after: "first fix" },
        { position: 0, field: "why", after: "Opens the hips after easy runs" },
        { position: 1, field: "useWhen", after: [{ text: "after a long run", evidence: "stated" }] },
      ],
      keepInsights: false,
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.extraction.moves[0]!.why).toBe("Opens the hips after easy runs");
    expect(out.extraction.moves[1]!.useWhen).toEqual([{ text: "after a long run", evidence: "stated" }]);
  });

  it("saved insights (in the coach's memory by their place) are kept; otherwise the new reading's", () => {
    const fresh = reading(["Zorbex hip lift"], { insights: [{ text: "New note", scope: "general" }] });
    const args = { earlier: earlier(["Zorbex hip lift"]), rows: [row(0, "Zorbex hip lift")], fixes: [] };
    const kept = alignReading(fresh, { ...args, keepInsights: true });
    const fresher = alignReading(fresh, { ...args, keepInsights: false });
    expect(kept.ok && kept.extraction.insights).toEqual(["Old note"]);
    expect(fresher.ok && fresher.extraction.insights).toEqual([{ text: "New note", scope: "general" }]);
  });

  it("a place below the last link with no new move left to fill it keeps the earlier reading", () => {
    const out = alignReading(reading(["Zorbex hip lift", "Zorbex calf drop"]), {
      earlier: earlier(["Zorbex hip lift", "Zorbex knee sway", "Zorbex calf drop"]),
      rows: [row(0, "Zorbex hip lift"), row(2, "Zorbex calf drop")],
      fixes: [], keepInsights: false,
    });
    expect(out).toEqual({ ok: false, why: "invalid" });
  });
});

describe("alignReading never takes one move for another (review I4)", () => {
  it("a near name is not the move: 'Zorbex squat' isn't 'Zorbex split squat' — the earlier reading stays", () => {
    const out = alignReading(reading(["Zorbex split squat", "Zorbex hip lift"]), {
      earlier: earlier(["Zorbex squat", "Zorbex hip lift"]),
      rows: [row(0, "Zorbex squat"), row(1, "Zorbex hip lift")],
      fixes: [], keepInsights: false,
    });
    expect(out).toEqual({ ok: false, why: "missing", missing: ["Zorbex squat"] });
  });

  it("a move's own name beats another move's alias", () => {
    const out = alignReading(reading([move("Zorbex hip opener", { aliases: ["Zorbex hip lift"] }), "Zorbex hip lift"]), {
      earlier: earlier(["Zorbex hip lift", "Zorbex hip opener"]),
      rows: [row(0, "Zorbex hip lift"), row(1, "Zorbex hip opener")],
      fixes: [], keepInsights: false,
    });
    expect(out.ok && names(out.extraction)).toEqual(["Zorbex hip lift", "Zorbex hip opener"]);
  });
});
