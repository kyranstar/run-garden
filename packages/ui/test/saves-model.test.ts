/**
 * "From your saves", the model (saves-model.ts): the open batch's words on Today and in the coach (the saves flow
 * redesigned §3.1–§3.2), and the batch page's — one row per new move, its line, the tally (§3.3) — word for word. Pure.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@rg/api-client";
import type { SaveBatchDto, SaveBatchRowDto } from "@rg/saves";
import {
  batchFacts,
  canFit,
  FIT_FAILED_LINE,
  fitRefusal,
  FITTING_LINE,
  isFitBatchGone,
  OPEN_FIRST_LINE,
  openShown,
  pageRowsOf,
  pendingLinksOf,
  purposeLine,
  PUT_ASIDE_LINE,
  savesChipLabel,
  tallyLine,
  todayHeadline,
  todaySubline,
  waitingBatches,
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
    // A batch with nothing left in it (final fix wave, saves flow redesign): no words — the read again shows no card.
    expect(fitRefusal(new ApiError(409, { error: "empty" }))).toBeNull();
    expect(fitRefusal(new ApiError(404, { error: "not_found" }))).toBeNull();
    expect(fitRefusal(new ApiError(500, null))).toBe(FIT_FAILED_LINE);
    expect(fitRefusal(new TypeError("Failed to fetch"))).toBe(FIT_FAILED_LINE);
  });

  it("a fit's run refused for its batch (404 saves_batch_not_found) is the fit's failure; any other 404 is not", () => {
    expect(isFitBatchGone(new ApiError(404, { error: "saves_batch_not_found" }))).toBe(true);
    expect(isFitBatchGone(new ApiError(404, { error: "not_found" }))).toBe(false);
    expect(isFitBatchGone(new ApiError(404, null))).toBe(false);
    expect(isFitBatchGone(new ApiError(409, { error: "saves_batch_not_found" }))).toBe(false);
    expect(isFitBatchGone(new TypeError("Failed to fetch"))).toBe(false);
  });
});

// ── The batch page (the saves flow redesigned §3.3) ──

const BATCH: SaveBatchDto = {
  id: "b1", status: "released", notice: null, theme: null, createdAt: "2026-10-23T10:00:00.000Z", releasedAt: "2026-10-23T10:00:00.000Z",
  savedAt: null, fittedAt: null, counts: { new: 2, linked: 1, removed: 0 }, dismissedAt: null, fitStartedAt: null, fitting: false,
};
const batch = (over: Partial<SaveBatchDto>): SaveBatchDto => ({ ...BATCH, ...over });

function link(postMoveId: string, move: Partial<SaveBatchRowDto["move"]> & { id: string; name: string }, over: Partial<SaveBatchRowDto> = {}): SaveBatchRowDto {
  return {
    postMoveId, position: 0, status: "pending", post: { url: null, creator: "maker_z", kind: "routine" },
    move: { summary: "", kind: "new", check: false, seenDose: "3 x 10", purpose: null, choice: null, ...move },
    ...over,
  };
}

describe("the batch page's words and rows (the saves flow redesigned §3.3)", () => {
  it("tallyLine: every move on the coach's call, by how many — one, both, all {word}", () => {
    expect(tallyLine({}, ["a"])).toBe("On the coach's call");
    expect(tallyLine({}, ["a", "b"])).toBe("Both on the coach's call");
    expect(tallyLine({}, ["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toBe("All nine on the coach's call");
    expect(tallyLine({ a: undefined }, ["a", "b", "c"])).toBe("All three on the coach's call");
    // Past twelve, digits.
    expect(tallyLine({}, Array.from({ length: 13 }, (_, i) => `m${i}`))).toBe("All 13 on the coach's call");
  });

  it("tallyLine, mixed: {i} in · {o} out · {c} on the coach's call, zero parts left out; a choice for no listed move counts for nothing", () => {
    expect(tallyLine({ a: "include", b: "skip" }, ["a", "b", "c"])).toBe("1 in · 1 out · 1 on the coach's call");
    expect(tallyLine({ a: "include", b: "include", c: "skip" }, ["a", "b", "c", "d", "e", "f"])).toBe("2 in · 1 out · 3 on the coach's call");
    expect(tallyLine({ a: "include", b: "include" }, ["a", "b"])).toBe("2 in");
    expect(tallyLine({ a: "skip" }, ["a", "b", "c"])).toBe("1 out · 2 on the coach's call");
    expect(tallyLine({ a: "include", b: "skip" }, ["a", "b"])).toBe("1 in · 1 out");
    expect(tallyLine({ gone: "include" }, ["a"])).toBe("On the coach's call");
    expect(tallyLine({}, [])).toBe("");
  });

  it("pageRowsOf: one row per distinct move of the kept rows, in the posts' order, each with its first kept link; the moves already yours apart", () => {
    const quadA = link("pm1", { id: "myZorbexQuad1", name: "Zorbex quad shuffle", purpose: "Loosens the quads." });
    const owned = link("pm2", { id: "bridge", name: "Glute bridge", kind: "linked", linkedName: "Bridge" });
    const neck = link("pm3", { id: "myZorbexNeck1", name: "Zorbex neck nod", check: true, like: { id: "myLantern1", name: "Lantern reach" } });
    const quadB = link("pm4", { id: "myZorbexQuad1", name: "Zorbex quad shuffle", check: true }, { position: 1 });
    const gone = link("pm5", { id: "myZorbexCalf1", name: "Zorbex calf rocker" }, { status: "removed" });
    const ownedAgain = link("pm6", { id: "bridge", name: "Bridge", kind: "linked", linkedName: "Bridge" });
    const { fresh, owned: yours } = pageRowsOf([quadA, owned, neck, quadB, gone, ownedAgain]);
    expect(fresh.map((r) => [r.moveId, r.row.postMoveId, r.name])).toEqual([
      ["myZorbexQuad1", "pm1", "Zorbex quad shuffle"],
      ["myZorbexNeck1", "pm3", "Zorbex neck nod"],
    ]);
    expect(fresh[0]!.purpose).toBe("Loosens the quads.");
    // Flagged on any of its kept links; the like is the move's.
    expect(fresh[0]!.check).toBe(true);
    expect(fresh[0]!.like).toBeUndefined();
    expect(fresh[1]!.check).toBe(true);
    expect(fresh[1]!.like).toEqual({ id: "myLantern1", name: "Lantern reach" });
    // A move already yours, once, by the name it has in your moves.
    expect(yours).toEqual([{ moveId: "bridge", name: "Bridge", row: owned }]);
    // A move whose first link was removed holds its next kept link.
    const later = pageRowsOf([{ ...quadA, status: "removed" }, quadB]).fresh;
    expect(later.map((r) => r.row.postMoveId)).toEqual(["pm4"]);
    // Every link of a removed move removed: no row.
    expect(pageRowsOf([gone]).fresh).toEqual([]);
  });

  it("pendingLinksOf: a move's pending links — each post that shows it", () => {
    const rows = [
      link("pm1", { id: "myZorbexQuad1", name: "Zorbex quad shuffle" }),
      link("pm2", { id: "myZorbexNeck1", name: "Zorbex neck nod" }),
      link("pm3", { id: "myZorbexQuad1", name: "Zorbex quad shuffle" }),
      link("pm4", { id: "myZorbexQuad1", name: "Zorbex quad shuffle" }, { status: "removed" }),
    ];
    expect(pendingLinksOf(rows, "myZorbexQuad1")).toEqual(["pm1", "pm3"]);
  });

  it("purposeLine: the post's purpose, trimmed; else the summary's first sentence; at most 80 characters, cut between words", () => {
    expect(purposeLine(link("pm1", { id: "m", name: "M", purpose: "  Loosens the quads before a run.  ", summary: "Shuffle the quads." }))).toBe("Loosens the quads before a run.");
    expect(purposeLine(link("pm1", { id: "m", name: "M", purpose: null, summary: "Nod slowly, the jaw soft. Then hold it." }))).toBe("Nod slowly, the jaw soft.");
    expect(purposeLine(link("pm1", { id: "m", name: "M", purpose: "   ", summary: "Reach long and slow" }))).toBe("Reach long and slow");
    const long = "Opens the hips and the upper back together so the stride lengthens without the lower back taking over the work";
    const cut = purposeLine(link("pm1", { id: "m", name: "M", purpose: null, summary: long }));
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long.charAt(cut.length - 1)).toBe(" ");
    expect(purposeLine(link("pm1", { id: "m", name: "M", purpose: null, summary: "" }))).toBe("");
  });

  it("canFit: released or saved, not fitted in, no fit at work; waitingBatches counts the batches not yet fitted in", () => {
    expect(canFit(BATCH)).toBe(true);
    expect(canFit(batch({ status: "saved", savedAt: "2026-10-24T10:00:00.000Z" }))).toBe(true);
    expect(canFit(batch({ dismissedAt: "2026-10-24T10:00:00.000Z" }))).toBe(true);
    expect(canFit(batch({ status: "saved", fitting: true, fitStartedAt: "2026-10-24T10:00:00.000Z" }))).toBe(false);
    expect(canFit(batch({ status: "saved", fittedAt: "2026-10-24T11:00:00.000Z" }))).toBe(false);
    expect(canFit(batch({ status: "held" }))).toBe(false);
    expect(canFit(batch({ status: "superseded" }))).toBe(false);
    expect(
      waitingBatches([
        BATCH,
        batch({ status: "saved" }),
        batch({ dismissedAt: "2026-10-24T10:00:00.000Z" }),
        batch({ status: "saved", fittedAt: "2026-10-24T11:00:00.000Z" }),
        batch({ status: "held" }),
        batch({ status: "superseded" }),
      ]),
    ).toBe(3);
  });

  it("batchFacts: a batch put aside (and not fitted in) reads Put aside", () => {
    expect(batchFacts(batch({ dismissedAt: "2026-10-24T10:00:00.000Z" }))).toEqual(["2 new", "1 linked", "Put aside"]);
    expect(batchFacts(BATCH)).toEqual(["2 new", "1 linked"]);
  });
});
