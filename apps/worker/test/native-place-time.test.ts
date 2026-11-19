/**
 * A PLACE NEVER LANDS IN THE PAST, AND THE DAY'S COLLISION PASS NEVER ENDS ANOTHER'S TAKE-BACK (R1 review B-8, B-9):
 *  - today, a time already gone is 422 `past_time`; untimed after its window, the next quarter hour, pinned — or 422
 *    `no_time_today` when none is left; a resent place is answered as before whatever the clock (Review B's RB-6);
 *  - a later untimed write (a second place, a Studio save) that re-times an earlier placed row settles that row's receipt
 *    to where the pass put it, so the earlier one is still taken back (Review B's RB-7) — but never a row someone changed
 *    beside the re-time.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays } from "@rg/domain";
import { keyedRowId } from "../src/services/doc-workouts.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { at, closeKit, T, takeBackKit, type Kit } from "./take-back-kit.js";

let k: Kit;
beforeEach(async () => {
  k = await takeBackKit();
});
afterEach(closeKit);

/**
 * Two clientIds whose rows tie on a day so that the FIRST one is the one the pass moves: two alike sessions at one time keep
 * the smaller row id where it is (day-placement.ts `relaidDay`), and a row's id is its key's hash (`keyedRowId`).
 */
async function movedFirst(earlier: (n: number) => string, later: (n: number) => string): Promise<[string, string]> {
  for (let n = 0; n < 64; n++) {
    const [a, b] = [earlier(n), later(n)];
    if ((await keyedRowId(k.w.userId, a.startsWith("laptop") ? a : `place:${a}`)) > (await keyedRowId(k.w.userId, b.startsWith("laptop") ? b : `place:${b}`))) return [a, b];
  }
  throw new Error("no pair of keys found");
}

const placeRaw = (body: Record<string, unknown>) => k.w.call("POST", "/api/native/templates/t-hips/place", { bearer: k.v5.token, body });

describe("a place today, at a time not yet gone (B-8)", () => {
  it("RB-6: untimed after its window: the next quarter hour, pinned", async () => {
    vi.setSystemTime(new Date(at(T, "21:20")));
    const p = await k.place(T, null, "c-late");
    expect(p.time).toBe("21:30");
  });

  it("a time already gone today: 422 past_time, nothing written", async () => {
    const a = await placeRaw({ date: T, time: "06:00", clientId: "c-gone" });
    expect([a.status, a.json.error]).toEqual([422, "past_time"]);
    expect(a.json.why).toEqual(expect.any(String));
    expect(a.writes).toEqual([]);
  });

  it("untimed with no time left today: 422 no_time_today", async () => {
    vi.setSystemTime(new Date(at(T, "23:50")));
    const a = await placeRaw({ date: T, clientId: "c-none" });
    expect([a.status, a.json.error]).toEqual([422, "no_time_today"]);
  });

  it("a place resent after its time has gone is answered as it was (repeated), never refused", async () => {
    const first = await k.place(T, "10:00", "c-resend");
    vi.setSystemTime(new Date(at(T, "11:00")));
    const again = await placeRaw({ date: T, time: "10:00", clientId: "c-resend" });
    expect([again.status, again.json.repeated, again.json.workoutId, again.json.receiptId]).toEqual([200, true, first.workoutId, first.receiptId]);
  });

  it("a later day keeps its window", async () => {
    vi.setSystemTime(new Date(at(T, "21:20")));
    const p = await k.place(addDays(T, 1), null, "c-tomorrow");
    expect(p.time < "21:30").toBe(true);
  });
});

describe("the collision pass keeps the earlier receipts (B-9)", () => {
  it("RB-7: a second untimed place re-times the first; the first is still taken back", async () => {
    const day = addDays(T, 1);
    const [c1, c2] = await movedFirst((n) => `c-u1-${n}`, (n) => `c-u2-${n}`);
    const p1 = await k.place(day, null, c1);
    k.tick();
    const p2 = await k.place(day, null, c2);
    expect([(await k.rowOf(p1.workoutId)).effectiveTime, p2.time]).toEqual(["07:30", p1.time]);
    k.tick();
    const res = await k.takeBack([p1.receiptId]);
    expect(res.json.outcomes[0].outcome).toBe("taken_back");
    expect((await k.rowOf(p1.workoutId)).archivedAt).not.toBeNull();
    expect((await k.takeBack([p2.receiptId])).json.outcomes[0].outcome).toBe("taken_back");
  });

  it("an untimed place its own pass re-times: its receipt holds where the pass put it, and it is taken back", async () => {
    const day = addDays(T, 1);
    // The larger id is the one moved: placed second, its own pass moves it off the first's time.
    const [moved, kept] = await movedFirst((n) => `c-o2-${n}`, (n) => `c-o1-${n}`);
    const first = await k.place(day, null, kept);
    k.tick();
    const second = await k.place(day, null, moved);
    expect([(await k.rowOf(first.workoutId)).effectiveTime, second.time]).toEqual([first.time, "07:30"]);
    k.tick();
    expect((await k.takeBack([second.receiptId])).json.outcomes[0].outcome).toBe("taken_back");
  });

  it("a Studio save's pass re-times a placed row: still taken back", async () => {
    const day = addDays(T, 1);
    const [c1, laptop] = await movedFirst((n) => `c-s1-${n}`, (n) => `laptop-${n}`);
    const p1 = await k.place(day, null, c1);
    k.tick();
    const saved = await k.w.call("POST", "/api/workouts", { body: { date: day, doc: calmDoc(), clientId: laptop } });
    expect(saved.status, saved.text).toBeLessThan(300);
    expect((await k.rowOf(p1.workoutId)).effectiveTime).not.toBe(p1.time);
    k.tick();
    expect((await k.takeBack([p1.receiptId])).json.outcomes[0].outcome).toBe("taken_back");
  });

  it("a row changed beside the re-time stays changed_since", async () => {
    const day = addDays(T, 1);
    const [c1, c2] = await movedFirst((n) => `c-c1-${n}`, (n) => `c-c2-${n}`);
    const p1 = await k.place(day, null, c1);
    await k.w.db.update(schema.plannedWorkouts).set({ title: "Renamed on the laptop" }).where(eq(schema.plannedWorkouts.id, p1.workoutId));
    k.tick();
    await k.place(day, null, c2);
    expect((await k.rowOf(p1.workoutId)).effectiveTime).not.toBe(p1.time);
    k.tick();
    const o = (await k.takeBack([p1.receiptId])).json.outcomes[0];
    expect([o.outcome, o.error]).toEqual(["refused", "changed_since"]);
  });
});
