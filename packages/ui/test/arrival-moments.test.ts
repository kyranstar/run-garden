/**
 * GARDEN MOMENTS FROM THE OBJECTIVES (the new shape §7): a best ever on a key result and a finished objective become
 * arrival beats on Today — "A best ever on Wall sit hold: 96 s." and "“Hold a strong wall sit” is complete." — riding
 * the arrival block's own watermark:
 *  - one dated today is a today line, whatever the watermark (as today's preview events are);
 *  - one dated after the watermark and before today is a beat line ("Since …");
 *  - one at or before the watermark is old news, never repeated;
 *  - they lead their lines (personal news before the garden's own), within the lines' caps;
 *  - a brand-new garden celebrates nothing, these included;
 *  - they never move the watermark (`nextSeen` is the durable events' alone).
 *
 * A key result's best ever counts once it has something to beat (the board's `best`: two points or more). A finished
 * objective is dated by the day it was marked complete, in the athlete's zone. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyResultMeasureSchema, type GardenEvent, type ObjectiveBoardCard, type ObjectiveBoardDto } from "@rg/domain";
import { selectArrival, type ArrivalEvent, type ArrivalMoment } from "../src/screens/arrival.js";
import { objectiveMoments } from "../src/screens/growth/moment-words.js";

const TODAY = "2026-10-14";
const YESTERDAY = "2026-10-13";
const OLDER = "2026-10-10";
const T0 = "2026-09-01T12:00:00.000Z";

let seq = 0;
const ev = (kind: GardenEvent["kind"], date: string, extra: Partial<ArrivalEvent> = {}): ArrivalEvent =>
  ({ id: `ge-${date}-${seq}`, date, seq: seq++, simulationVersion: 3, kind, ...extra }) as ArrivalEvent;

const seenAt = (d: string) => ({ lastSeenDate: d, lastSeenSeq: 0, celebratedSpeciesIds: [] });

function card(id: string, title: string, o: { status?: "active" | "paused" | "done"; updatedAt?: string; best?: { date: string; display: number } | null } = {}): ObjectiveBoardCard {
  const kr = {
    id: `${id}-k`, objectiveId: id, label: "Wall sit hold", measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] }), direction: "up" as const,
    baseline: 60, target: 120, unit: "s" as const, dueDate: null, position: 0, createdAt: T0, updatedAt: T0,
  };
  return {
    objective: { id, title, why: null, status: o.status ?? "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: o.updatedAt ?? T0, keyResults: [kr] },
    keyResults: [
      {
        keyResult: kr,
        progress: { unit: "s", current: 96, series: [], lastMeasuredAt: null, sampleSize: 0, evidence: "sparse", display: { unit: "s", current: 96 } },
        best: o.best === undefined ? null : o.best ? { date: o.best.date, value: o.best.display, display: o.best.display } : null,
      },
    ],
    served: [],
    streakWeeks: 0,
    note: null,
  };
}

const board = (...objectives: ObjectiveBoardCard[]): ObjectiveBoardDto => ({ today: TODAY, objectives });

describe("objectiveMoments", () => {
  it("a key result's best ever, on its day, in its own unit", () => {
    expect(objectiveMoments(board(card("o1", "Legs", { best: { date: YESTERDAY, display: 96 } })), "UTC")).toEqual([
      { date: YESTERDAY, line: "A best ever on Wall sit hold: 96 s." },
    ]);
  });

  it("nothing yet to beat (no best): no moment", () => {
    expect(objectiveMoments(board(card("o1", "Legs", { best: null })), "UTC")).toEqual([]);
  });

  it("a finished objective, on the day it was marked complete in the athlete's zone", () => {
    // 03:00 UTC on the 14th is still the 13th in Los Angeles.
    const done = card("o2", "Hold a strong wall sit", { status: "done", updatedAt: "2026-10-14T03:00:00.000Z" });
    expect(objectiveMoments(board(done), "America/Los_Angeles")).toEqual([{ date: YESTERDAY, line: "“Hold a strong wall sit” is complete." }]);
    expect(objectiveMoments(board(done), "UTC")).toEqual([{ date: TODAY, line: "“Hold a strong wall sit” is complete." }]);
  });

  it("a board read that failed, came back partial or in an older shape is no moment — never a crash on Today", () => {
    expect(objectiveMoments(undefined, "UTC")).toEqual([]);
    expect(objectiveMoments(null, "UTC")).toEqual([]);
    expect(objectiveMoments({} as ObjectiveBoardDto, "UTC")).toEqual([]);
    expect(objectiveMoments({ today: TODAY, objectives: null } as unknown as ObjectiveBoardDto, "UTC")).toEqual([]);
    const partial = [
      null,
      {},
      { objective: { id: "o9", title: "No measures", status: "done", updatedAt: "not a date" } },
      { objective: { id: "o8", title: "Legs", status: "active", updatedAt: T0 }, keyResults: [null, { best: { date: YESTERDAY } }, { keyResult: null, best: null }] },
    ];
    expect(objectiveMoments({ today: TODAY, objectives: partial } as unknown as ObjectiveBoardDto, "UTC")).toEqual([]);
    // A zone the runtime doesn't know reads UTC.
    const done = card("o2", "Hold a strong wall sit", { status: "done", updatedAt: "2026-10-14T03:00:00.000Z" });
    expect(objectiveMoments(board(done), "Not/AZone")).toEqual([{ date: TODAY, line: "“Hold a strong wall sit” is complete." }]);
  });

  it("an objective under way or paused is no moment of its own", () => {
    expect(objectiveMoments(board(card("o1", "Legs"), card("o2", "Posture", { status: "paused" })), "UTC")).toEqual([]);
  });
});

describe("arrival.ts stays light", () => {
  it("imports no screen code: a worker test reads it, and the worker's typecheck has no JSX", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/screens/arrival.ts", import.meta.url)), "utf8");
    const from = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(from.filter((f) => f!.startsWith("."))).toEqual([]);
  });
});

describe("selectArrival with moments", () => {
  const best: ArrivalMoment = { date: YESTERDAY, line: "A best ever on Wall sit hold: 96 s." };
  const done: ArrivalMoment = { date: TODAY, line: "“Legs” is complete." };

  it("one after the watermark leads the beat lines; one dated today leads the today lines", () => {
    const out = selectArrival(
      [ev("run_completed", YESTERDAY, { workoutCategory: "easy" }), ev("soil_tended", TODAY, { preview: true })],
      seenAt(OLDER),
      TODAY,
      [best, done],
    );
    expect(out.beatLines).toEqual(["A best ever on Wall sit hold: 96 s.", "An easy run watered the garden."]);
    expect(out.todayLines).toEqual(["“Legs” is complete.", "Strength work fed the soil."]);
  });

  it("at or before the watermark: old news, never repeated; today's still says so", () => {
    const out = selectArrival([ev("run_completed", YESTERDAY, { workoutCategory: "easy", seq: 0 })], seenAt(YESTERDAY), TODAY, [best, done]);
    expect(out.beatLines).toEqual([]);
    expect(out.todayLines).toEqual(["“Legs” is complete."]);
  });

  it("they count toward the caps: three beat lines and two today lines at most, the rest overflow", () => {
    const many = (d: string, n: number): ArrivalMoment[] => Array.from({ length: n }, (_, i) => ({ date: d, line: `Moment ${d} ${i}.` }));
    const out = selectArrival([ev("run_completed", YESTERDAY, { workoutCategory: "easy" })], seenAt(OLDER), TODAY, [...many(YESTERDAY, 3), ...many(TODAY, 3)]);
    expect(out.beatLines).toEqual(["Moment 2026-10-13 0.", "Moment 2026-10-13 1.", "Moment 2026-10-13 2."]);
    expect(out.beatOverflow).toBe(true);
    expect(out.todayLines).toHaveLength(2);
    expect(out.todayOverflow).toBe(true);
  });

  it("a brand-new garden celebrates nothing, these included", () => {
    const out = selectArrival([], null, TODAY, [best, done]);
    expect(out.markSeenImmediately).toBe(true);
    expect(out.beatLines).toEqual([]);
    expect(out.todayLines).toEqual([]);
  });

  it("they never move the watermark", () => {
    const events = [ev("run_completed", YESTERDAY, { workoutCategory: "easy", seq: 7 })];
    const without = selectArrival(events, seenAt(OLDER), TODAY);
    const withThem = selectArrival(events, seenAt(OLDER), TODAY, [best, done]);
    expect(withThem.nextSeen).toEqual(without.nextSeen);
  });

  it("none given: exactly as before", () => {
    const events = [ev("run_completed", YESTERDAY, { workoutCategory: "long" }), ev("run_completed", TODAY, { preview: true, workoutCategory: "quality" })];
    expect(selectArrival(events, seenAt(OLDER), TODAY, [])).toEqual(selectArrival(events, seenAt(OLDER), TODAY));
  });
});
