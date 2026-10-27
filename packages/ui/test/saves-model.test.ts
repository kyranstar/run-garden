/**
 * "From your saves", the model (saves-model.ts): the open batch's words on Today and in the coach (the saves flow
 * redesigned §3.1–§3.2), word for word. Pure. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@rg/api-client";
import {
  FIT_FAILED_LINE,
  fitRefusal,
  FITTING_LINE,
  OPEN_FIRST_LINE,
  openShown,
  PUT_ASIDE_LINE,
  savesChipLabel,
  todayHeadline,
  todaySubline,
} from "../src/screens/studio/saves-model.js";

describe("the open batch's words (the saves flow redesigned)", () => {
  it("the Today card's headline and the line under it", () => {
    expect(todayHeadline({ new: 9, linked: 4 })).toBe("9 new moves from your saves");
    expect(todayHeadline({ new: 1, linked: 0 })).toBe("1 new move from your saves");
    expect(todaySubline({ new: 9, linked: 4 })).toBe("4 more were already yours");
    expect(todaySubline({ new: 9, linked: 1 })).toBe("1 more was already yours");
    expect(todaySubline({ new: 2, linked: 0 })).toBeNull();
    expect(todayHeadline({ new: 0, linked: 3 })).toBe("3 saved moves you already have");
    // With no new move the headline says them all: nothing under it.
    expect(todaySubline({ new: 0, linked: 3 })).toBeNull();
  });

  it("the coach's chip", () => {
    expect(savesChipLabel({ new: 1, linked: 0 })).toBe("1 new saved move");
    expect(savesChipLabel({ new: 9, linked: 4 })).toBe("9 new saved moves");
    expect(savesChipLabel({ new: 0, linked: 3 })).toBe("3 saved moves");
  });

  it("the lines every surface shares", () => {
    expect(FITTING_LINE).toBe("Fitting in… open the coach");
    expect(OPEN_FIRST_LINE).toBe("finish the batch that is open first");
    expect(PUT_ASIDE_LINE).toBe("Put aside. Find it again under Settings → Saves (or the Studio tab), where Fit them in brings it back.");
  });

  it("an open batch with nothing left in it (every row removed) is no open batch", () => {
    const open = { id: "b1", counts: { new: 0, linked: 0 }, groups: [], line: "Zero saved moves you already have came in.", fitting: false };
    expect(openShown({ open })).toBeNull();
    expect(openShown({ open: null })).toBeNull();
    expect(openShown(undefined)).toBeNull();
    const some = { ...open, counts: { new: 0, linked: 2 } };
    expect(openShown({ open: some })).toBe(some);
  });

  it("a fit refused: another batch open says so; a fit at work or a batch gone says nothing (the read again shows it); anything else, try again", () => {
    expect(fitRefusal(new ApiError(409, { error: "batch_open" }))).toBe(OPEN_FIRST_LINE);
    expect(fitRefusal(new ApiError(409, { error: "fitting" }))).toBeNull();
    expect(fitRefusal(new ApiError(409, { error: "already_fitted" }))).toBeNull();
    expect(fitRefusal(new ApiError(404, { error: "not_found" }))).toBeNull();
    expect(fitRefusal(new ApiError(500, null))).toBe(FIT_FAILED_LINE);
    expect(fitRefusal(new TypeError("Failed to fetch"))).toBe(FIT_FAILED_LINE);
  });
});
