/**
 * R10 fix round 1: ⇄'s offers for the lower leg. A calf raise lifts the heels and a tibialis raise lifts the toes:
 * opposite movements, so neither is ever offered for the other as "The same movement"; a calf raise's own offers are
 * its ladder and its family first.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import { libraryOffers } from "../src/services/doc-build.js";

const find = (id: string) => EXERCISES.find((e) => e.id === id);
const none = { ids: new Set<string>(), keys: new Set<string>() };
const CALF_RAISES = ["calfRaise", "bentKneeCalfRaise", "eccentricHeelDrop", "singleLegCalfRaise"];

describe("libraryOffers for the calf and shin raises", () => {
  it("the tibialis raise is never offered a calf raise as the same movement, nor a calf raise the tibialis raise", () => {
    for (const o of libraryOffers(find("tibialisRaise")!, EXERCISES, find, none)) {
      if (CALF_RAISES.includes(o.to.id)) expect(o.reason, o.to.id).not.toBe("The same movement");
    }
    for (const id of CALF_RAISES) {
      const tib = libraryOffers(find(id)!, EXERCISES, find, none).find((o) => o.to.id === "tibialisRaise");
      if (tib) expect(tib.reason, id).not.toBe("The same movement");
    }
  });

  it("a calf raise is offered its own ladder and family first", () => {
    const offers = libraryOffers(find("singleLegCalfRaise")!, EXERCISES, find, none);
    expect(offers[0]).toMatchObject({ reason: "An easier version" });
    expect(offers[0]!.to.id).toBe("eccentricHeelDrop");
    const calf = offers.filter((o) => CALF_RAISES.includes(o.to.id)).map((o) => o.to.id);
    expect(calf).toEqual(expect.arrayContaining(["eccentricHeelDrop", "calfRaise", "bentKneeCalfRaise"]));
  });
});
