import { describe, expect, it } from "vitest";
import { dropUnknownEnums } from "../src/index.js";

// The reading's list fields are vocabularies: one unknown word (a region the library doesn't have) must not throw a
// paid reply away (live finding, 2026-11-05). The word goes, with a note; a list left empty is the schema's to refuse.

const reply = (move: Record<string, unknown>) => ({ kind: "single_move", moves: [move] });

describe("dropUnknownEnums", () => {
  it("drops an unknown region and says which", () => {
    const out = dropUnknownEnums(reply({ regions: ["hips", "forearmz"], patterns: ["mobility"] }));
    expect((out.value as { moves: { regions: string[] }[] }).moves[0]!.regions).toEqual(["hips"]);
    expect(out.dropped).toEqual([{ move: 0, field: "regions", values: ["forearmz"] }]);
  });

  it("covers patterns, equipment, equipmentOneOf and contraction, per move", () => {
    const out = dropUnknownEnums({
      moves: [
        { patterns: ["mobility", "wiggle"], equipment: ["mat", "spoon"], contraction: ["isotonic"] },
        { equipmentOneOf: ["bench", "throne"], contraction: ["passive", "floaty"] },
      ],
    });
    expect(out.dropped).toEqual([
      { move: 0, field: "patterns", values: ["wiggle"] },
      { move: 0, field: "equipment", values: ["spoon"] },
      { move: 1, field: "equipmentOneOf", values: ["throne"] },
      { move: 1, field: "contraction", values: ["floaty"] },
    ]);
  });

  it("leaves a list whose every value is unknown as it is: the schema refuses it and the retry names the options", () => {
    const out = dropUnknownEnums(reply({ regions: ["forearmz"] }));
    expect((out.value as { moves: { regions: string[] }[] }).moves[0]!.regions).toEqual(["forearmz"]);
    expect(out.dropped).toEqual([]);
  });

  it("drops a non-string entry beside good ones, and cuts a long value's note to 40 characters", () => {
    const long = "x".repeat(90);
    const out = dropUnknownEnums(reply({ regions: ["hips", 7, long] }));
    expect((out.value as { moves: { regions: unknown[] }[] }).moves[0]!.regions).toEqual(["hips"]);
    expect(out.dropped).toEqual([{ move: 0, field: "regions", values: ["7", "x".repeat(40)] }]);
  });

  it("touches nothing that isn't a reading's move list, and never the single-valued fields", () => {
    expect(dropUnknownEnums(null)).toEqual({ value: null, dropped: [] });
    expect(dropUnknownEnums({ moves: "no" })).toEqual({ value: { moves: "no" }, dropped: [] });
    const out = dropUnknownEnums(reply({ position: "floaty", regions: ["hips"] }));
    expect((out.value as { moves: { position: string }[] }).moves[0]!.position).toBe("floaty");
    expect(out.dropped).toEqual([]);
  });
});

describe("dropUnknownEnums: extract-6's optional fields never fail a reading (final review F4)", () => {
  type M = Record<string, unknown>;
  const first = (out: ReturnType<typeof dropUnknownEnums>) => (out.value as { moves: M[] }).moves[0]!;

  it("a quote it can't use goes, noted; one it can mend is mended", () => {
    const out = dropUnknownEnums(reply({
      quotes: [
        { field: "cues", text: "keep the ribs down", from: "caption" },
        { field: "dose", text: "x".repeat(250), from: "transcript", at: "1:05" },
        { field: "name", text: "the zorbex lift", from: "title" },
        { field: "why", text: 7, from: "caption" },
        ...Array.from({ length: 8 }, (_, i) => ({ field: "steps", text: `step ${i}`, from: "caption" })),
      ],
    }));
    const quotes = first(out).quotes as M[];
    expect(quotes).toHaveLength(8);
    expect(quotes[0]).toEqual({ field: "dose", text: "x".repeat(200), from: "transcript", at: 65 });
    expect(quotes[1]).toEqual({ field: "name", text: "the zorbex lift", from: "caption" });
    expect(out.dropped).toEqual([{ move: 0, field: "quotes", values: ["keep the ribs down", "7", "step 6", "step 7"] }]);
  });

  it("use-when and skip-when items are mended (their words cut to 160, an unknown evidence a guess), at most 4 kept", () => {
    const out = dropUnknownEnums(reply({
      useWhen: [{ text: "u".repeat(200), evidence: "maybe" }, "plain words", { text: 3 }, ...Array.from({ length: 4 }, (_, i) => ({ text: `w${i}`, evidence: "stated" }))],
      skipWhen: { text: "not a list" },
      why: "y".repeat(300),
    }));
    const m = first(out);
    expect(m.useWhen).toEqual([
      { text: "u".repeat(160), evidence: "inferred" }, { text: "plain words", evidence: "inferred" },
      { text: "w0", evidence: "stated" }, { text: "w1", evidence: "stated" },
    ]);
    expect(m.skipWhen).toBeUndefined();
    expect(m.why).toBe("y".repeat(200));
    expect(out.dropped).toEqual([{ move: 0, field: "useWhen", values: ["3", "w2", "w3"] }, { move: 0, field: "skipWhen", values: ["not a list"] }]);
  });

  it("a reading's speech past 4,000 characters is cut there, and an insight with an unknown scope stays with its post", () => {
    const out = dropUnknownEnums({ moves: [], speech: "s".repeat(4_500), insights: [{ text: "Twice a week", scope: "forever" }, "plain"] });
    const v = out.value as { speech: string; insights: unknown[] };
    expect(v.speech).toHaveLength(4_000);
    expect(v.insights).toEqual([{ text: "Twice a week", scope: "this_routine" }, "plain"]);
  });
});
