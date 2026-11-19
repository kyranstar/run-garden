/**
 * A GROUP GOES BACK NEWEST FIRST, AND WHOLE OR NOT AT ALL WHERE THAT CAN BE KNOWN (R1 review B-2, B-3; DESIGN-3 §3.4.3, C5):
 *  - the statement budget never takes an older receipt of a group back while a newer one of it waits: once one of a group
 *    is left for the next request, every later one of it is too (Review B's RB-2, kept);
 *  - what a writer would refuse whatever the moment — a revise whose earlier document the day's condition no longer allows,
 *    a revision row gone, a move with no time to go back to — is found BEFORE anything of the group is written, and the
 *    group refused whole: `cant_restore` (or `ineligible`), never a 500 (Review B's RB-1, kept);
 *  - one its writer refuses at the write all the same (the moment changed it since its check) is that receipt's honest
 *    refusal, reported beside what the request did take back — never a 500.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Run `hold` once, just before the next revise through run-garden's writer (a take-back's revise inverse), to race it. */
const gates = vi.hoisted(() => ({ beforeRevise: null as null | (() => Promise<void>) }));
vi.mock("../src/services/doc-workouts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/doc-workouts.js")>();
  return {
    ...real,
    reviseDocWorkout: async (...args: Parameters<typeof real.reviseDocWorkout>) => {
      const hold = gates.beforeRevise;
      gates.beforeRevise = null;
      if (hold) await hold();
      return real.reviseDocWorkout(...args);
    },
  };
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { DocInvalidError } from "../src/services/doc-workouts.js";
import { REFUSAL_WORDS } from "../src/services/take-back.js";
import { activateTmj, calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { closeKit, T, takeBackKit, type Kit } from "./take-back-kit.js";

let k: Kit;
beforeEach(async () => {
  gates.beforeRevise = null;
  k = await takeBackKit();
});
afterEach(closeKit);

const flare = (id = "chk-1") => k.w.db.insert(schema.conditionChecks).values({ id, userId: k.w.userId, profileId: "tmj", kind: "daily", value: 1, feelingOff: true, localDate: T, at: nowInstant() });
const byReceipt = (json: { outcomes: Array<{ receiptId: string }> }) => Object.fromEntries(json.outcomes.map((o) => [o.receiptId, o])) as Record<string, any>;

describe("the statement budget keeps a group's order (B-3)", () => {
  it("RB-2: a newer receipt left for the next request holds back every older one of its group", async () => {
    const g = "g-rb2";
    const s = await k.onPlan(addDays(T, 1), "07:00");
    const r = await k.onPlan(addDays(T, 2), "07:00");
    const m = await k.onPlan(addDays(T, 3), "07:00");
    k.tick();
    const skipR = await k.approvedSkip(s, { groupId: g });
    k.tick();
    const revR = await k.approvedRevise(r, calmDoc({ title: "Coach version" }), { groupId: g, dependsOn: [skipR] });
    k.tick();
    const moveR = await k.approvedMove(m, addDays(T, 4), "07:00", { groupId: g, dependsOn: [skipR, revR] });
    k.tick();
    const order: string[][] = [];
    let ask = [skipR, revR, moveR];
    for (let round = 0; ask.length > 0 && round < 4; round++) {
      const res = await k.takeBack(ask, "req-rb2");
      expect(res.status, res.text).toBe(200);
      const by = byReceipt(res.json);
      order.push(ask.filter((id) => by[id]?.outcome === "taken_back"));
      // Whatever is left is the group's oldest: never one older than a receipt still open.
      for (const left of res.json.remaining as string[]) expect((await k.receiptOf(left)).status).toBe("open");
      if (round === 0) expect(res.json.remaining).toEqual([revR, skipR]);
      ask = res.json.remaining;
      k.tick();
    }
    expect(order.flat()).toEqual([moveR, revR, skipR]);
    expect(order[0]).toEqual([moveR]);
  });
});

describe("a group refused whole before anything of it is written (B-2)", () => {
  it("RB-1: a revise whose earlier document the day's condition now refuses: cant_restore, its partner group_refused, nothing written", async () => {
    await activateTmj(k.w.db, k.w.userId);
    const w1 = await k.onPlan(T, "18:00", landingsDoc({ alternates: false }));
    const g = "g-rb1";
    k.tick();
    const a = await k.approvedRevise(w1, calmDoc({ title: "Coach calm" }), { groupId: g });
    const w2 = await k.onPlan(addDays(T, 1), "07:00");
    k.tick();
    const b = await k.approvedSkip(w2, { groupId: g, dependsOn: [a] });
    await flare();
    k.tick();
    for (const requestId of ["req-rb1", "req-rb1", "req-rb1-again"]) {
      const res = await k.takeBack([a, b], requestId);
      expect(res.status, res.text).toBe(200);
      const by = byReceipt(res.json);
      expect([by[a].outcome, by[a].error, by[a].why]).toEqual(["refused", "cant_restore", REFUSAL_WORDS.cant_restore]);
      expect([by[b].outcome, by[b].error]).toEqual(["refused", "group_refused"]);
      expect(res.json.remaining).toEqual([]);
      expect(res.writes.filter((s: string) => !/^select/i.test(s))).toEqual([]);
    }
    expect([(await k.receiptOf(a)).status, (await k.receiptOf(b)).status]).toEqual(["open", "open"]);
    expect((await k.rowOf(w2)).completionState).toBe("skipped");
    expect((await k.rowOf(w1)).title).toBe("Coach calm");
  });

  it("a revise whose earlier revision row is gone: refused whole at preflight", async () => {
    const w1 = await k.onPlan(addDays(T, 1), "07:00");
    const g = "g-gone";
    k.tick();
    const a = await k.approvedRevise(w1, calmDoc({ title: "Coach calm" }), { groupId: g, preState: { rev: 99 } });
    const w2 = await k.onPlan(addDays(T, 2), "07:00");
    k.tick();
    const b = await k.approvedSkip(w2, { groupId: g, dependsOn: [a] });
    k.tick();
    const by = byReceipt((await k.takeBack([a, b])).json);
    expect([by[a].error, by[b].error]).toEqual(["cant_restore", "group_refused"]);
    expect((await k.receiptOf(b)).status).toBe("open");
    expect((await k.rowOf(w2)).completionState).toBe("skipped");
  });

  it("a move with no time to go back to: ineligible at preflight, its newer partner untouched", async () => {
    const m = await k.onPlan(addDays(T, 1), "07:00");
    const g = "g-notime";
    k.tick();
    const a = await k.approvedMove(m, addDays(T, 3), "18:00", { groupId: g, preState: { date: addDays(T, 1), time: null } });
    const s = await k.onPlan(addDays(T, 2), "07:00");
    k.tick();
    const b = await k.approvedSkip(s, { groupId: g, dependsOn: [a] });
    k.tick();
    const by = byReceipt((await k.takeBack([a, b])).json);
    expect([by[a].error, by[b].error]).toEqual(["ineligible", "group_refused"]);
    expect((await k.rowOf(s)).completionState).toBe("skipped");
  });

  it("its writer refuses at the write what its preflight passed: that receipt's cant_restore, reported beside its taken-back partner — never a 500", async () => {
    await activateTmj(k.w.db, k.w.userId);
    const w1 = await k.onPlan(T, "18:00", landingsDoc({ alternates: false }));
    const g = "g-race";
    k.tick();
    const a = await k.approvedRevise(w1, calmDoc({ title: "Coach calm" }), { groupId: g });
    const w2 = await k.onPlan(addDays(T, 1), "07:00");
    k.tick();
    const b = await k.approvedSkip(w2, { groupId: g, dependsOn: [a] });
    k.tick();
    // The skip goes first (newest); the revise doesn't fit beside it, and is left for the next request.
    const first = await k.takeBack([a, b], "req-race");
    expect(byReceipt(first.json)[b].outcome).toBe("taken_back");
    expect(first.json.remaining).toEqual([a]);
    gates.beforeRevise = async () => {
      throw new DocInvalidError([]);
    };
    const res = await k.takeBack([a, b], "req-race");
    expect(res.status, res.text).toBe(200);
    const by = byReceipt(res.json);
    expect(by[b].outcome).toBe("taken_back");
    expect([by[a].outcome, by[a].error]).toEqual(["refused", "cant_restore"]);
    expect(res.json.remaining).toEqual([]);
    expect([(await k.receiptOf(a)).status, (await k.receiptOf(b)).status]).toEqual(["open", "taken_back"]);
    expect((await k.rowOf(w1)).title).toBe("Coach calm");
  });
});
