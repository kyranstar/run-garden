import { describe, expect, test } from "vitest";
import { Hist, Records, type HistorySession } from "../src/index.js";
import { seededHistory, WORLDS } from "./seeded-history.js";

// The review screen shows what the session just played achieved (`Records.forSession`), on the phone, offline — where
// the history is not. The server folds the history into a small state at Start (`Records.baseline`, trimmed to the
// moves the build can play and the weeks the session can touch); the player folds the one new session onto it
// (`Records.forSessionFrom`). These say that is the same answer as the whole history would give.

/** Cut points where the next session is the newest so far (as a session just played always is). */
function cuts(sessions: HistorySession[]): number[] {
  const out: number[] = [];
  for (let k = 5; k < sessions.length; k += 3) {
    const sorted = Hist.sorted(sessions.slice(0, k + 1));
    if (sorted[sorted.length - 1] === sessions[k]) out.push(k);
  }
  return out;
}

describe("records from a baseline equal records from the whole history", () => {
  for (const world of WORLDS) {
    test(`${world.name}: every cut of three seeded histories, weekly goals 2 and 4`, () => {
      let compared = 0;
      let nonEmpty = 0;
      for (const seed of ["r1", "r2", "r3"]) {
        const { sessions } = seededHistory(world.data, world.renamed, seed, 90);
        for (const k of cuts(sessions)) {
          const s = sessions[k]!;
          const ids = Hist.idsIn(s).map((raw) => Hist.canonical(world.data, raw));
          for (const weeklyGoal of [2, 4]) {
            const whole = Records.forSession(world.data, sessions.slice(0, k + 1), s.id!, { weeklyGoal });
            const base = Records.baseline(world.data, sessions.slice(0, k), { ids, date: s.date, weeklyGoal });
            // What is stored on the device is plain data.
            const stored = JSON.parse(JSON.stringify(base)) as typeof base;
            expect(Records.forSessionFrom(world.data, stored, s)).toEqual(whole);
            compared++;
            if (whole.records.length + whole.milestones.length > 0) nonEmpty++;
          }
        }
      }
      expect(compared).toBeGreaterThan(100);
      expect(nonEmpty).toBeGreaterThan(50);
    });
  }

  test("the baseline keeps only the moves asked for and the weeks the session can touch", () => {
    const { data, renamed } = WORLDS[0]!;
    const { sessions } = seededHistory(data, renamed, "r1", 90);
    const last = sessions[sessions.length - 1]!;
    const base = Records.baseline(data, sessions.slice(0, -1), { ids: ["gobletSquat"], date: last.date, weeklyGoal: 2 });
    expect(Object.keys(base.bests).every((id) => id === "gobletSquat")).toBe(true);
    expect(Object.keys(base.weekCounts).length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(base).length).toBeLessThan(4000);
  });
});
