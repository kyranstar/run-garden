import { describe, expect, test } from "vitest";
import { agentSearch, EXERCISES, searchLibrary, isPracticeMove, type ExerciseRecord } from "../src/index.js";

// The moves of the TRE sequence: found by plain words and by their tag, in both searches, and held apart from what the
// day's build, the quick starts and the suggestions pick from (`isPracticeMove`). Their wall sit is its own move: a
// long, shallow hold at moderate effort isn't a measure of the deep one, and must not read as a wall-sit record.

const TRE_ONLY = ["footEdgeShifts", "supportedOneLegSquat", "wideForwardFold", "standingPsoasStretch", "highWallSit", "hangingForwardFold", "floorTremor"];
const REUSED = ["singleLegCalfRaise", "bridge", "reclinedButterfly", "legsUp"];
const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => byId.get(id)!;

describe("the TRE moves", () => {
  test("the sequence's own moves are practice moves, and the ones it borrows stay general", () => {
    expect(TRE_ONLY.filter((id) => !isPracticeMove(rec(id)))).toEqual([]);
    expect(REUSED.filter((id) => isPracticeMove(rec(id)))).toEqual([]);
  });

  test("every practice move in the library is one of the sequence's", () => {
    expect(EXERCISES.filter(isPracticeMove).map((e) => e.id).sort()).toEqual([...TRE_ONLY].sort());
  });

  test("the Studio's tag filter lists the sequence's own moves", () => {
    expect(searchLibrary(EXERCISES, "", { tag: "tre" }).map((e) => e.id).sort()).toEqual([...TRE_ONLY].sort());
  });

  test("the coach finds the tremor in plain words", () => {
    expect(agentSearch(EXERCISES, "tremor").hits[0]?.record.id).toBe("floorTremor");
    expect(agentSearch(EXERCISES, "TRE").hits.map((h) => h.record.id)).toEqual(expect.arrayContaining(TRE_ONLY));
  });

  test("the high wall sit is not the deep one the wall-sit objective measures", () => {
    expect(rec("highWallSit").id).not.toBe("wallSit");
    expect(rec("highWallSit").legacyIds).toEqual([]);
    expect(rec("wallSit").legacyIds).not.toContain("highWallSit");
  });

  test("the how-to names how to stop the tremor, both ways", () => {
    const said = [...rec("floorTremor").text.setup, ...rec("floorTremor").text.steps].join(" ");
    expect(said).toMatch(/straight/i);
    expect(said).toMatch(/your side/i);
  });
});
