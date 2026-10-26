import { describe, expect, it } from "vitest";
import type { ExerciseRecord } from "@rg/exercise-library";
import { batchNotice, groupCounts, moveGroup, numberWord, savesCardLine } from "../src/index.js";

type M = Pick<ExerciseRecord, "regions" | "contraction">;
const m = (region: string, contraction = "isotonic"): M => ({ regions: [region], contraction: [contraction] }) as unknown as M;

describe("moveGroup", () => {
  it("maps regions and plyometrics", () => {
    expect(moveGroup(m("hips"))).toBe("hip");
    expect(moveGroup(m("glutes"))).toBe("hip");
    expect(moveGroup(m("jaw"))).toBe("neck");
    expect(moveGroup(m("neck"))).toBe("neck");
    expect(moveGroup(m("thoracic"))).toBe("upper back");
    expect(moveGroup(m("upper-back"))).toBe("upper back");
    expect(moveGroup(m("shoulders"))).toBe("shoulder");
    expect(moveGroup(m("core"))).toBe("core");
    expect(moveGroup(m("quads"))).toBe("leg");
    expect(moveGroup(m("feet"))).toBe("leg");
    expect(moveGroup(m("chest"))).toBe("other");
    expect(moveGroup(m("quads", "plyometric"))).toBe("jump");
    expect(moveGroup({ regions: [], contraction: ["isotonic"] })).toBe("other");
  });
});

describe("batchNotice", () => {
  const four = [m("hips"), m("glutes"), m("neck"), m("calves", "plyometric")];
  it("new and linked", () => {
    expect(batchNotice(four, 3)).toBe("From your saves: 4 new moves (2 hip, 1 neck, 1 jump), 3 you already had.");
  });
  it("one new, none linked", () => {
    expect(batchNotice([m("hips")], 0)).toBe("From your saves: 1 new move (hip).");
  });
  it("none new", () => {
    expect(batchNotice([], 2)).toBe("From your saves: 2 moves you already had.");
    expect(batchNotice([], 1)).toBe("From your saves: 1 move you already had.");
  });
  it("at most three groups, biggest first", () => {
    const ms = [m("hips"), m("neck"), m("neck"), m("core"), m("quads"), m("quads"), m("quads")];
    expect(batchNotice(ms, 0)).toBe("From your saves: 7 new moves (3 leg, 2 neck, 1 hip).");
  });
});

describe("the open card's copy", () => {
  it("numberWord spells one to twelve", () => {
    expect([numberWord(1), numberWord(9), numberWord(12), numberWord(13)]).toEqual(["one", "nine", "twelve", "13"]);
  });
  it("groupCounts puts the biggest first, ties in first-seen order", () => {
    expect(groupCounts([m("hips"), m("neck"), m("glutes"), m("quads", "plyometric")])).toEqual([
      { group: "hip", count: 2 }, { group: "neck", count: 1 }, { group: "jump", count: 1 },
    ]);
  });
  it("savesCardLine writes the card copy", () => {
    expect(savesCardLine({ new: 9, linked: 4 }, [{ group: "upper back", count: 3 }, { group: "neck", count: 2 }, { group: "core", count: 2 }, { group: "hip", count: 1 }, { group: "leg", count: 1 }]))
      .toBe("Nine new moves came in from your saves: 3 upper back, 2 neck, 2 core, 1 hip and 1 more. Want me to fit them into the week, or choose first?");
    expect(savesCardLine({ new: 4, linked: 0 }, [{ group: "hip", count: 2 }, { group: "neck", count: 1 }, { group: "jump", count: 1 }]))
      .toBe("Four new moves came in from your saves: 2 hip, 1 neck and 1 jump. Want me to fit them into the week, or choose first?");
    expect(savesCardLine({ new: 1, linked: 2 }, [{ group: "hip", count: 1 }])).toBe("One new move came in from your saves: hip. Want me to fit it into the week, or choose first?");
    expect(savesCardLine({ new: 0, linked: 3 }, [])).toBe("Three saved moves you already have came in. Want me to fit them into the week, or choose first?");
  });
});
