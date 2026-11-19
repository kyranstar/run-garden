/**
 * WHAT A TAKE-BACK ANSWERS IS TRUE (R1 review B-4…B-7, A MINOR-2, MINOR-4; the reviews' surviving mutants):
 *  - the watch's delete reads done only once verified; cancelled, needing attention or neutralised by a restore is failed; a
 *    superseded one is its newer job's; a delete owed while COROS writes are off is pending (Review B's RB-4, B-6);
 *  - the calendar after a move, skip or revise take-back follows the row's own sync state, never "pending" for ever
 *    (Review B's RB-3); after a create, pending while its event is still linked;
 *  - a receipt another request took back meanwhile answers already_taken_back, never changed_since (Review B's RB-5);
 *  - changed_since says how the session stands in the phone's words, never planned_workouts' columns (A MINOR-2);
 *  - a phone takes back only what it made — its own places and approves (A MINOR-4); the laptop, what anyone made;
 *  - the claim takes only an open receipt; a claim that lands without its inverse fails its batch; a receipt lapses at its
 *    exact instant, in preflight and in the claim alike.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Run `hold` once, just before the next guarded move or archive (a take-back's move or create inverse), to race it. */
const gates = vi.hoisted(() => ({ beforeMove: null as null | (() => Promise<void>), beforeRemove: null as null | (() => Promise<void>) }));
vi.mock("../src/services/jobs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/jobs.js")>();
  return {
    ...real,
    applyMove: async (...args: Parameters<typeof real.applyMove>) => {
      const hold = gates.beforeMove;
      gates.beforeMove = null;
      if (hold) await hold();
      return real.applyMove(...args);
    },
  };
});
vi.mock("../src/services/plan-mutations.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/plan-mutations.js")>();
  return {
    ...real,
    removeFromPlan: async (...args: Parameters<typeof real.removeFromPlan>) => {
      const hold = gates.beforeRemove;
      gates.beforeRemove = null;
      if (hold) await hold();
      return real.removeFromPlan(...args);
    },
  };
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { runAtomically } from "../src/services/db.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { takeBackBatchOf } from "../src/services/take-back.js";
import { seedDevice } from "./native-fixture.js";
import { at, closeKit, T, takeBackKit, type Kit } from "./take-back-kit.js";

const { calendarEventLinks, corosWriteJobs, plannedWorkouts, sessionBuilds, takeBackReceipts } = schema;

let k: Kit;
beforeEach(async () => {
  gates.beforeMove = null;
  gates.beforeRemove = null;
  k = await takeBackKit();
});
afterEach(closeKit);

const read = async (id: string) => (await k.w.call("GET", `/api/native/receipts/${id}`, { bearer: k.v5.token })).json;
const deleteJob = (workoutId: string, status: string, requestedAt = nowInstant()) => ({
  id: `unpush:${newId()}`, userId: k.w.userId, workoutId, kind: "coach_delete_workout", expectedContentFingerprint: "x", originalDate: addDays(T, 1), destinationDate: addDays(T, 1), requestedAt, status, createdAt: requestedAt, updatedAt: requestedAt,
}) as typeof corosWriteJobs.$inferInsert;

describe("the watch's part, as its jobs say (B-4, B-6)", () => {
  it("RB-4: done only once verified; cancelled, needing attention or restored is failed; superseded is its newer job's", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 1), "07:00", "c-comp");
    k.tick();
    expect((await k.takeBack([receiptId])).json.outcomes[0].outcome).toBe("taken_back");
    const job = deleteJob(workoutId, "queued");
    await k.w.db.insert(corosWriteJobs).values(job);
    const states: Record<string, unknown> = {};
    for (const status of ["queued", "verifying", "verified", "failed", "cancelled", "needs_attention", "restored"]) {
      await k.w.db.update(corosWriteJobs).set({ status }).where(eq(corosWriteJobs.id, job.id!));
      states[status] = (await read(receiptId)).compensation;
    }
    const watch = (state: string) => [{ provider: "watch", state }];
    expect(states).toEqual({
      queued: watch("pending"), verifying: watch("pending"), verified: watch("done"), failed: watch("failed"),
      cancelled: watch("failed"), needs_attention: watch("failed"), restored: watch("failed"),
    });
    // Superseded by a newer delete: that one's state. Superseded with none newer: not done.
    await k.w.db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, job.id!));
    expect((await read(receiptId)).compensation).toEqual(watch("failed"));
    k.tick();
    await k.w.db.insert(corosWriteJobs).values(deleteJob(workoutId, "in_progress"));
    expect((await read(receiptId)).compensation).toEqual(watch("pending"));
  });

  it("B-6: a delete owed on the sent build while COROS writes are off is pending, then its job's once it runs", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 1), "07:00", "c-owed");
    k.tick();
    expect((await k.takeBack([receiptId])).json.outcomes[0].outcome).toBe("taken_back");
    expect((await read(receiptId)).compensation).toEqual([]);
    await k.w.db.insert(sessionBuilds).values({ id: "b-1", userId: k.w.userId, workoutId, version: 1, engineVersion: "1", inputsHash: "h", payload: { unpushOwedAt: nowInstant() }, lockedAt: nowInstant(), createdAt: nowInstant() });
    expect((await read(receiptId)).compensation).toEqual([{ provider: "watch", state: "pending" }]);
    // Writes back on: the owed mark comes off as its delete is queued — then the job says.
    await k.w.db.update(sessionBuilds).set({ payload: {} }).where(eq(sessionBuilds.id, "b-1"));
    k.tick();
    await k.w.db.insert(corosWriteJobs).values(deleteJob(workoutId, "verified"));
    expect((await read(receiptId)).compensation).toEqual([{ provider: "watch", state: "done" }]);
  });
});

describe("the calendar's part follows the row (B-5)", () => {
  it("RB-3: a move taken back is pending while the row's event is still to be moved, then done", async () => {
    const id = await k.onPlan(addDays(T, 1), "07:00");
    await k.w.db.insert(calendarEventLinks).values({ id: "l-1", workoutId: id, calendarId: "cal", eventId: "ev", state: "synced", createdAt: nowInstant(), updatedAt: nowInstant() });
    k.tick();
    const moved = await k.approvedMove(id, addDays(T, 3), "18:30");
    k.tick();
    const res = await k.takeBack([moved]);
    expect(res.json.outcomes[0].outcome).toBe("taken_back");
    await k.w.db.update(plannedWorkouts).set({ calendarSyncState: "pending" }).where(eq(plannedWorkouts.id, id));
    expect((await read(moved)).compensation).toEqual([{ provider: "calendar", state: "pending" }]);
    await k.w.db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, id));
    expect((await read(moved)).compensation).toEqual([{ provider: "calendar", state: "done" }]);
  });

  it("a create taken back is pending while its event is still linked (the sync removes it)", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 1), "07:00", "c-cal");
    await k.w.db.insert(calendarEventLinks).values({ id: "l-2", workoutId, calendarId: "cal", eventId: "ev2", state: "synced", createdAt: nowInstant(), updatedAt: nowInstant() });
    k.tick();
    await k.takeBack([receiptId]);
    await k.w.db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, workoutId));
    expect((await read(receiptId)).compensation).toEqual([{ provider: "calendar", state: "pending" }]);
    await k.w.db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, "l-2"));
    expect((await read(receiptId)).compensation).toEqual([]);
  });
});

describe("a race answers what happened (B-7)", () => {
  it("RB-5: another request took it back meanwhile: already_taken_back, never changed_since", async () => {
    const { receiptId } = await k.place(addDays(T, 1), "07:00", "c-race2");
    k.tick();
    let other: { json: any } | null = null;
    gates.beforeRemove = async () => {
      other = await k.takeBack([receiptId], "req-second");
    };
    const first = await k.takeBack([receiptId], "req-first");
    expect(other!.json.outcomes[0].outcome).toBe("taken_back");
    expect(first.json.outcomes[0]).toMatchObject({ receiptId, outcome: "already_taken_back", op: "create" });
    expect((await k.receiptOf(receiptId)).requestId).toBe("req-second");
  });

  it("the claim takes only an open receipt: taken back, then moved back by the laptop, a request already past its preflight writes nothing", async () => {
    const id = await k.onPlan(addDays(T, 1), "07:00");
    k.tick();
    const moved = await k.approvedMove(id, addDays(T, 3), "18:00");
    k.tick();
    gates.beforeMove = async () => {
      // Its preflight done: another request takes it back, then the laptop moves the session where the coach had put it.
      expect((await k.takeBack([moved], "req-x")).json.outcomes[0].outcome).toBe("taken_back");
      k.tick();
      expect((await k.w.call("POST", `/api/plan/workouts/${id}/move`, { body: { toDate: addDays(T, 3), toTime: "18:00" } })).status).toBe(200);
      k.tick();
    };
    const y = await k.takeBack([moved], "req-y");
    expect(y.json.outcomes[0].outcome).toBe("already_taken_back");
    const row = await k.rowOf(id);
    expect([row.effectiveDate, row.effectiveTime]).toEqual([addDays(T, 3), "18:00"]);
    expect((await k.receiptOf(moved)).requestId).toBe("req-x");
  });
});

describe("changed_since in the phone's words (A MINOR-2)", () => {
  it("how the session stands now: its day, time, state, title and minutes — never the row's columns", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 2), "18:00", "c-moved");
    k.tick();
    expect((await k.w.call("POST", `/api/plan/workouts/${workoutId}/move`, { body: { toDate: addDays(T, 4), toTime: "07:00" } })).status).toBe(200);
    k.tick();
    const o = (await k.takeBack([receiptId])).json.outcomes[0];
    expect([o.outcome, o.error]).toEqual(["refused", "changed_since"]);
    expect(o.now).toEqual({ date: addDays(T, 4), time: "07:00", state: "scheduled", archived: false, title: "Hips and back", minutes: expect.any(Number) });
  });

  it("a session gone: now is null", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 1), "07:00", "c-gone");
    await k.w.db.delete(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    const o = (await k.takeBack([receiptId])).json.outcomes[0];
    expect([o.outcome, o.error, o.now]).toEqual(["refused", "changed_since", null]);
  });
});

describe("a phone takes back what it made (A MINOR-4)", () => {
  it("the laptop's approve and another phone's place are not_found to this phone, and stay open; its own go back; the laptop takes back any", async () => {
    const id = await k.onPlan(addDays(T, 1), "07:00");
    k.tick();
    const laptops = await k.approvedMove(id, addDays(T, 3), "18:00", { madeBy: "session" });
    const other = await seedDevice(k.w.db, k.w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const a = await k.w.call("POST", "/api/native/templates/t-hips/place", { bearer: other.token, body: { date: addDays(T, 2), clientId: "c-other", time: "07:00" } });
    expect(a.status, a.text).toBe(201);
    const mine = await k.place(addDays(T, 2), "12:00", "c-mine");
    k.tick();
    const res = await k.takeBack([laptops, a.json.receiptId, mine.receiptId]);
    expect(res.json.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(["not_found", "not_found", "taken_back"]);
    expect([(await k.receiptOf(laptops)).status, (await k.receiptOf(a.json.receiptId)).status]).toEqual(["open", "open"]);
    expect((await k.w.call("GET", `/api/native/receipts/${laptops}`, { bearer: k.v5.token })).status).toBe(404);
    expect((await k.w.call("GET", `/api/native/receipts/${mine.receiptId}`, { bearer: k.v5.token })).status).toBe(200);
    // The other phone takes back its own; the laptop takes back its own approve.
    expect((await k.takeBack([a.json.receiptId], undefined, other.token)).json.outcomes[0].outcome).toBe("taken_back");
    const laptop = await k.w.call("POST", "/api/native/take-back", { body: { receiptIds: [laptops], requestId: "req-laptop" } });
    expect(laptop.json.outcomes[0].outcome).toBe("taken_back");
  });
});

describe("the claim and its check, at the batch (the reviews' surviving mutants)", () => {
  async function placedReceipt() {
    const p = await k.place(addDays(T, 1), "07:00", `c-${newId()}`);
    k.tick();
    return { ...p, r: await k.receiptOf(p.receiptId) };
  }
  const prefs = () => loadPreferences(k.w.db, k.w.userId);

  it("a claim that landed without its inverse fails the whole batch: the receipt stays open", async () => {
    const { r, workoutId } = await placedReceipt();
    const now = nowInstant();
    // The inverse held to a condition that never holds: its archive doesn't land, so its check fails the batch.
    await expect(removeFromPlan(k.w.db, k.w.userId, workoutId, { now, source: "undo", prefs: await prefs(), archiveReason: "taken_back", onlyIf: sql`0`, takeBack: takeBackBatchOf(k.w.db, r, "req-z", "device:x", now) })).rejects.toThrow();
    expect((await k.receiptOf(r.id)).status).toBe("open");
    expect((await k.rowOf(workoutId)).archivedAt).toBeNull();
  });

  it("the claim lapses at the receipt's exact instant (and holds a millisecond before)", async () => {
    const { r, workoutId } = await placedReceipt();
    const claim = (instant: string) => runAtomically(k.w.db, takeBackBatchOf(k.w.db, r, `req-${instant}`, "device:x", instant).first({ now: instant, workoutId }));
    await claim(r.expiresAt);
    expect((await k.receiptOf(r.id)).status).toBe("open");
    await claim(new Date(Date.parse(r.expiresAt) - 1).toISOString());
    expect((await k.receiptOf(r.id)).status).toBe("taken_back");
  });

  it("RB-8: preflight agrees — 1 ms before the day's end it is taken back; at it, expired", async () => {
    const a = await k.place(T, "18:00", "c-b1");
    const b = await k.place(T, "19:00", "c-b2");
    const end = (await k.receiptOf(a.receiptId)).expiresAt;
    expect(end).toBe(at(addDays(T, 1), "00:00"));
    vi.setSystemTime(new Date(Date.parse(end) - 1));
    expect((await k.takeBack([a.receiptId])).json.outcomes[0].outcome).toBe("taken_back");
    vi.setSystemTime(new Date(Date.parse(end)));
    expect((await k.takeBack([b.receiptId])).json.outcomes[0].error).toBe("expired");
    expect((await k.receiptOf(b.receiptId)).status).toBe("open");
  });

  it("an id another account holds is not_found (ids collide across accounts)", async () => {
    const { r } = await placedReceipt();
    await k.w.db.update(takeBackReceipts).set({ userId: "someone-else" }).where(eq(takeBackReceipts.id, r.id));
    expect((await k.takeBack([r.id])).json.outcomes[0].outcome).toBe("not_found");
  });
});
