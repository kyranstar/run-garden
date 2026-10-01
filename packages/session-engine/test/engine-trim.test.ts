import { addDays } from "@rg/domain";
import { describe, expect, test } from "vitest";
import { Coverage, Hist, HistIndex, Planner, Select, type Block, type HistorySession, type ProgramState } from "../src/index.js";
import { PLACES, data as realData } from "./builder-fixtures.js";
import { dataWith, ex, lifted, session } from "./fixtures.js";

// Trimmed histories (ruling 2a-R6): `Hist.trim` keeps the sessions a build reads one by one and `Hist.summarize`
// the all-time facts it reads of the rest. The differential test proves a trimmed history plans byte-identically on
// seeded histories; these pin each rule of the trim, including the ones random histories rarely need.

const T = "2026-09-29";
const day = (n: number) => addDays(T, n);
const ids = (sessions: readonly HistorySession[]) => sessions.map(s => s.date);
const block = (startedAt: string, o: Partial<Block> = {}): Block => ({ id: "b1", number: 1, startedAt, weeks: 5, core: {}, rotations: [], ...o });
const logged = (id: string, o: { format?: string; flags?: string[] } = {}) => ({ id, format: o.format ?? "straight", flags: o.flags ?? [], sets: [{ w: null, reps: 8, secs: null }] });

describe("Hist.trim keeps what a build reads session by session", () => {
  test("the last 14 days, and anything dated later (coverage, the week, each family's last day up to 14)", () => {
    const sessions = [-30, -20, -15, -14, -13, -6, -1, 1].map(n => session(day(n)));
    expect(ids(Hist.trim(sessions, T, null))).toEqual([-14, -13, -6, -1, 1].map(day));
  });

  test("the last three sessions on or before today, however old (repetition, the last session)", () => {
    const sessions = [-60, -50, -40, -30].map(n => session(day(n)));
    expect(ids(Hist.trim(sessions, T, null))).toEqual([-50, -40, -30].map(day));
  });

  test("the last themed session before today, behind any number of unthemed ones (the theme not to repeat)", () => {
    const sessions = [session(day(-90), { theme: "older" }), session(day(-60), { theme: "hipsPosture" }), ...[-50, -40, -30, -20].map(n => session(day(n)))];
    expect(ids(Hist.trim(sessions, T, null))).toEqual([-60, -40, -30, -20].map(day));
  });

  test("the block's sessions since it started (or a lift rotated in), while it runs (rotation on a lift's log)", () => {
    // The last three (-30, -25, -20) are kept anyway: -34 is kept only while a block reads it.
    const sessions = [-34, -30, -25, -20].map(n => session(day(n)));
    expect(ids(Hist.trim([session(day(-40)), ...sessions], T, block(day(-35), { weeks: 6 })))).toEqual([-34, -30, -25, -20].map(day));
    const rotated = block(day(-20), { rotations: [{ family: "squat", from: "a", to: "b", date: day(-34), why: "graduated" }] });
    expect(ids(Hist.trim([session(day(-40)), ...sessions], T, rotated))).toEqual([-34, -30, -25, -20].map(day));
    // A block that ran out starts again today: only the window and the rest.
    expect(ids(Hist.trim([session(day(-40)), ...sessions], T, block(day(-35))))).toEqual([-30, -25, -20].map(day));
  });

  test("each move's two newest progression entries, under the id it was logged as (targets, a topped-out lift)", () => {
    const sessions = [
      session(day(-90), { entries: [logged("press")] }),
      session(day(-80), { entries: [logged("press")] }),
      session(day(-70), { entries: [logged("press"), logged("oldPress")] }),
      session(day(-65), { entries: [logged("press", { format: "ladder" })] }),
      session(day(-64), { entries: [logged("press", { format: "circuit" })] }),
      session(day(-63), { entries: [{ id: "press", format: "straight", flags: [], sets: [] }] }),
      ...[-50, -40, -30].map(n => session(day(n))),
    ];
    expect(ids(Hist.trim(sessions, T, null))).toEqual([-80, -70, -50, -40, -30].map(day));
  });
});

describe("Hist.summarize: the all-time facts of the rest", () => {
  test("first and last done, entries and flags per raw id, as of a day", () => {
    const sessions = [
      session(day(-40), { done: [{ id: "a" }], entries: [logged("b", { flags: ["clenched", "clenched"] })] }),
      session(day(-10), { startedAt: null, done: [{ id: "a" }, { id: "b" }], entries: [logged("b")] }),
      session(day(2), { entries: [logged("b", { flags: ["clenched"] }), logged("c")] }),
    ];
    expect(Hist.summarize(sessions, T)).toEqual({
      asOf: T,
      moves: {
        a: { first: { when: `${day(-40)}T18:00:00`, date: day(-40) }, last: day(-10), logged: 0, flags: {} },
        b: { first: { when: `${day(-40)}T18:00:00`, date: day(-40) }, last: day(-10), logged: 2, flags: { clenched: 1 } },
        c: { first: { when: `${day(2)}T18:00:00`, date: day(2) }, last: null, logged: 0, flags: {} },
      },
    });
  });

  test("a summary answers for its own day only", () => {
    const data = dataWith([lifted("gobletSquat"), ex("catCow")]);
    const sessions = [session(day(-3), { done: [{ id: "catCow" }] })];
    const h = HistIndex.of(data, sessions, Hist.summarize(sessions, day(-1)));
    expect(() => Coverage.exposuresIn(h, T)).toThrow(/cannot answer for/);
    expect(() => Select.statsIn(h, T)).toThrow(/cannot answer for/);
  });

  test("with a summary, the all-time facts come from it, whatever the trimmed sessions hold", () => {
    const data = dataWith([lifted("gobletSquat", { legacyIds: ["oldGoblet"] }), ex("catCow", { regions: ["thoracic"] })]);
    const whole = [
      session(day(-200), { done: [{ id: "oldGoblet" }], entries: [logged("oldGoblet", { flags: ["clenched"] })] }),
      session(day(-100), { done: [{ id: "catCow" }] }),
      ...[-5, -4, -3].map(n => session(day(n))),
      session(day(-2), { done: [{ id: "gobletSquat" }], entries: [logged("gobletSquat")] }),
    ];
    const trimmed = Hist.trim(whole, T, null);
    expect(ids(trimmed)).toEqual([-200, -5, -4, -3, -2].map(day));
    const h = HistIndex.of(data, trimmed, Hist.summarize(whole, T));
    const full = HistIndex.of(data, whole);
    expect(Select.statsIn(h, T).get("gobletSquat")).toEqual(Select.statsIn(full, T).get("gobletSquat"));
    expect(Select.statsIn(h, T).get("catCow")).toEqual({ lastDate: day(-100), recent: 0, logged: 0, flags: {} });
    expect(Select.statsIn(full, T).get("catCow")).toEqual({ lastDate: day(-100), recent: 0, logged: 0, flags: {} });
    expect(Coverage.exposuresIn(h, T).last).toEqual(Coverage.exposuresIn(full, T).last);
    expect([...Hist.firstDoneIn(h)].sort()).toEqual([...Hist.firstDoneIn(full)].sort());
  });
});

test("a summary in any order: a renamed move was first done at its earliest id's first session (start, then date)", () => {
  const data = dataWith([lifted("gobletSquat", { legacyIds: ["oldGoblet"] })]);
  const at = (when: string, date: string) => ({ first: { when, date }, last: date, logged: 0, flags: {} });
  // Two sessions that started at the same instant on different local dates: the history orders them by date.
  const moves = { gobletSquat: at("2026-09-22T23:30:00Z", day(-6)), oldGoblet: at("2026-09-22T23:30:00Z", day(-7)) };
  const first = (m: Record<string, ReturnType<typeof at>>) => Hist.firstDoneIn(HistIndex.of(data, [], { asOf: T, moves: m })).get("gobletSquat");
  expect(first(moves)).toBe(day(-7));
  expect(first({ oldGoblet: moves.oldGoblet, gobletSquat: moves.gobletSquat })).toBe(day(-7));
  expect(first({ oldGoblet: at("2026-09-23T07:00:00Z", day(-6)), gobletSquat: at("2026-09-23T06:00:00Z", day(-6)) })).toBe(day(-6));
});

test("a whole program planned from a trimmed history and its summary is the plan from the whole history", () => {
  // A long gap, a run of imports with no theme, a block well under way: the differential's seeded histories cover
  // the rest; this one is spelled out.
  const sessions: HistorySession[] = [];
  for (let n = -120; n <= -40; n += 3) {
    sessions.push(session(day(n), { theme: n % 2 ? "hipsPosture" : null, mode: "consistent", done: [{ id: "catCow" }], entries: [logged("gobletSquat")] }));
  }
  for (const n of [-20, -12, -9]) sessions.push(session(day(n), { startedAt: null, done: [{ id: "gobletSquat" }, { id: "deadBug" }] }));
  const program: ProgramState = {
    settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" },
    locations: PLACES, prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions,
  };
  const trimmed: ProgramState = { ...program, sessions: Hist.trim(sessions, T, null), summary: Hist.summarize(sessions, T) };
  expect(trimmed.sessions.length).toBeLessThan(sessions.length / 2);
  const strip = (r: ReturnType<typeof Planner.planToday>) => JSON.stringify({ ...r, view: { ...r.view, input: { ...r.view.input, sessions: [], summary: undefined } } });
  expect(strip(Planner.planToday(realData, { today: T, day: null }, trimmed))).toBe(strip(Planner.planToday(realData, { today: T, day: null }, program)));
});
