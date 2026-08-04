import { describe, expect, it } from "vitest";
import { CHUNK_DAYS, firstChunk, nextBackfillAction } from "../src/services/backfill.js";

describe("firstChunk", () => {
  it("starts just behind the rolling snapshot window, not at today", () => {
    // The rolling snapshot already owns the last 14 days; backfill must not
    // redo that work.
    const { chunkStart, chunkEnd } = firstChunk("2026-08-04", 14);
    expect(chunkEnd).toBe("2026-07-21");
    // 90 days INCLUSIVE of chunkEnd — the same span nextBackfillAction uses.
    expect(chunkStart).toBe("2026-04-23");
  });
});

describe("nextBackfillAction", () => {
  const floor = "2021-08-04";

  it("continues into the next older chunk when a chunk had activities", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 0 },
      { activitiesFound: 12 },
      floor,
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2026-01-23",
      chunkEnd: "2026-04-22",
    });
  });

  it("keeps going after ONE empty chunk — a single gap is just a break from training", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 0 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops after two consecutive empty chunks", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 1 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action).toEqual({ kind: "done", reason: "empty_run" });
  });

  it("resets the empty run when a later chunk finds activities again", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 1 },
      { activitiesFound: 3 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops at the floor rather than walking back forever", () => {
    // Already standing on the floor: the next chunk would end at 2021-08-03,
    // below it, so there is nothing left to ask for.
    const action = nextBackfillAction(
      { earliestDateReached: "2021-08-04", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({ kind: "done", reason: "floor_reached" });
  });

  it("clamps a chunk that would straddle the floor", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2021-11-01", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2021-08-04",
      chunkEnd: "2021-10-31",
    });
  });

  it("uses a 90-day chunk", () => {
    expect(CHUNK_DAYS).toBe(90);
  });
});
