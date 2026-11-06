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
