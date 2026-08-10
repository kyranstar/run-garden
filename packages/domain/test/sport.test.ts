import { describe, expect, it } from "vitest";
import { isAdventureSport, SPORT_BY_ID, sportIdForCorosCode, sportLabel, SPORTS } from "../src/index.js";

describe("sport registry", () => {
  it("keeps the existing stored ids stable", () => {
    expect(sportIdForCorosCode(100)).toBe("run");
    expect(sportIdForCorosCode(102)).toBe("run"); // trail run
    expect(sportIdForCorosCode(402)).toBe("strength");
    expect(sportIdForCorosCode(403)).toBe("yoga");
    expect(sportIdForCorosCode(904)).toBe("yoga");
    expect(sportIdForCorosCode(500)).toBe("ski");
  });

  it("names the newly admitted sports", () => {
    expect(sportIdForCorosCode(104)).toBe("hike");
    expect(sportIdForCorosCode(105)).toBe("hike"); // mtn climb
    expect(sportIdForCorosCode(501)).toBe("snowboard");
    expect(sportIdForCorosCode(502)).toBe("xc-ski");
    expect(sportIdForCorosCode(503)).toBe("ski-touring");
    expect(sportIdForCorosCode(900)).toBe("walk");
    expect(sportIdForCorosCode(801)).toBe("climb"); // bouldering
  });

  it("collapses the bike/swim ranges like the old corosSportName did", () => {
    expect(sportIdForCorosCode(204)).toBe("bike"); // MTB
    expect(sportIdForCorosCode(299)).toBe("bike");
    expect(sportIdForCorosCode(301)).toBe("swim"); // open water
  });

  it("admits unknown codes as other, never throws", () => {
    expect(sportIdForCorosCode(31337)).toBe("other");
  });

  it("classifies disciplines vs adventures", () => {
    expect(isAdventureSport("run")).toBe(false);
    expect(isAdventureSport("strength")).toBe(false);
    expect(isAdventureSport("yoga")).toBe(false);
    expect(isAdventureSport("hike")).toBe(true);
    expect(isAdventureSport("walk")).toBe(true);
    // Unknown stored strings are non-discipline → adventure by default.
    expect(isAdventureSport("coros_9999")).toBe(true);
  });

  it("labels every registered sport and falls back gracefully", () => {
    for (const s of SPORTS) expect(sportLabel(s.id)).toBe(s.label);
    expect(sportLabel("mystery")).toBe("Mystery");
    expect(SPORT_BY_ID.get("hike")?.label).toBe("Hike");
  });
});
