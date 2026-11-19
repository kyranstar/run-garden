/**
 * RECEIPT-BOUND TAKE-BACK (R1; DESIGN-3 §3.4.3, §5.3; the lead's v0.20 Q2 ruling): services/take-back.ts through
 * `POST /api/native/take-back` and `GET /api/native/receipts/:id`.
 *
 * Receipts are written as the writers write them — a place through its route, an approve's move, skip and revision through
 * run-garden's own writers with the receipt in the write's batch (as design-approve.ts writes them). Pinned:
 *  - per op (create, revise, move, skip): taken back restores what was before, archives rather than deletes, keeps the
 *    revisions, writes an audit row and marks the receipt with the request;
 *  - refusals, each writing nothing: expired, past, executed (started, done, a performed session, a match), ineligible, an
 *    intervening edit (a laptop move, a document edit, a skip, a re-time), has_dependents, group_incomplete, group_refused;
 *  - a race between preflight and apply is a reported partial; idempotency with the same and another request id;
 *  - compensation read live (the watch's delete pending → done, failed; the calendar's event pending until removed);
 *  - another account's receipt is not_found; the request stays inside the statement budget, the rest `remaining`.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Run `hold` once, just before the next guarded archive (a take-back's create inverse), to race it. */
const gates = vi.hoisted(() => ({ beforeRemove: null as null | (() => Promise<void>) }));
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

import { DateTime } from "luxon";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { planRoutes } from "../src/routes/plan.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createDocWorkout, reviseDocWorkout } from "../src/services/doc-workouts.js";
import { applyMove } from "../src/services/jobs.js";
import { skipWorkout } from "../src/services/plan-mutations.js";
import { receiptExpiry, receiptIdOf, receiptInsert, type ReceiptSpec } from "../src/services/take-back.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { auditEvents, calendarEventLinks, corosWriteJobs, performedSessions, plannedWorkouts, takeBackReceipts, workoutDocRevisions, workoutTemplates } = schema;

const LA = "America/Los_Angeles";
const T = "2026-11-16"; // a Monday
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  gates.beforeRemove = null;
  w = await nativeWorld([
    ["/api/native", nativeLibraryRoutes],
    ["/api/native", nativeTakeBackRoutes],
    ["/api/plan", planRoutes],
    ["/api/workouts", workoutRoutes],
  ]);
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
  await w.db.insert(workoutTemplates).values({
    id: "t-hips", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: at("2026-11-01", "09:00"), updatedAt: at("2026-11-01", "09:00"),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const place = async (date: string, time: string | null, clientId: string) => {
  const a = await w.call("POST", "/api/native/templates/t-hips/place", { bearer: v5.token, body: { date, clientId, ...(time ? { time } : {}) } });
  expect(a.status, a.text).toBe(201);
  return a.json as { workoutId: string; receiptId: string };
};
const takeBack = (receiptIds: string[], requestId = `req-${newId()}`, bearer: string | undefined = v5.token) =>
  w.call("POST", "/api/native/take-back", { ...(bearer ? { bearer } : {}), body: { receiptIds, requestId } });
const rowOf = async (id: string) => (await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const receiptOf = async (id: string) => (await w.db.select().from(takeBackReceipts).where(eq(takeBackReceipts.id, id)))[0]!;
const takeBacks = () => w.db.select().from(auditEvents).where(eq(auditEvents.kind, "take_back"));
const ctx = async () => {
  const prefs = await loadPreferences(w.db, w.userId);
  return { today: T, now: nowInstant(), prefs };
};

/** A coach op's receipt as design-approve.ts writes one: in the op's own batch. */
async function approveSpec(key: string, op: ReceiptSpec["op"], date: string, over: Partial<ReceiptSpec> = {}): Promise<ReceiptSpec> {
  return {
    id: await receiptIdOf(w.userId, "coach_approve", key),
    userId: w.userId,
    source: "coach_approve",
    sourceKey: key,
    madeBy: "session",
    op,
    groupId: over.groupId ?? `g-${key}`,
    dependsOn: [],
    preState: null,
    effects: [],
    expiresAt: receiptExpiry(nowInstant(), date, LA),
    ...over,
  };
}

/** A workout already on the plan (the laptop's Studio save), to change with a receipt. */
async function onPlan(date: string, time = "07:00", title = "Hips and back") {
  const made = await createDocWorkout(w.db, w.userId, { date, time, doc: calmDoc({ title }), clientId: `seed-${newId()}` }, await ctx());
  return made.workout.id;
}

async function approvedMove(workoutId: string, toDate: string, toTime: string, key = `p1:move-${newId()}`) {
  const row = await rowOf(workoutId);
  const spec = await approveSpec(key, "move", toDate, { preState: { date: row.effectiveDate, time: row.effectiveTime } });
  await applyMove(w.db, { userId: w.userId, workoutId, toDate, toTime, source: "app", corosWritesEnabled: false, onlyIf: sql`1 = 1`, alsoInBatch: receiptInsert(w.db, spec) });
  return spec.id;
}

async function approvedSkip(workoutId: string, key = `p1:skip-${newId()}`) {
  const row = await rowOf(workoutId);
  const spec = await approveSpec(key, "skip", row.effectiveDate, { preState: { date: row.effectiveDate } });
  const c = await ctx();
  expect((await skipWorkout(w.db, w.userId, workoutId, { now: c.now, today: T, source: "coach", sanctionedBy: "coach", prefs: c.prefs, onlyIf: sql`1 = 1`, alsoInBatch: receiptInsert(w.db, spec) })).skipped).toBe(true);
  return spec.id;
}

async function approvedRevise(workoutId: string, title: string, key = `p1:rev-${newId()}`) {
  const row = await rowOf(workoutId);
  const spec = await approveSpec(key, "revise", row.effectiveDate, { preState: { rev: row.workoutDocRev } });
  await reviseDocWorkout(w.db, w.userId, workoutId, { doc: calmDoc({ title }), baseRev: row.workoutDocRev! }, await ctx(), { sourceKind: "coach" }, { alsoInBatch: receiptInsert(w.db, spec) });
  return spec.id;
}

describe("each op, taken back", () => {
  it("a place (create): archived as taken_back, never deleted; the receipt marked with the request; one audit row", async () => {
    const { workoutId, receiptId } = await place(addDays(T, 2), "18:00", "c-1");
    const a = await takeBack([receiptId], "req-1");
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual({ requestId: "req-1", outcomes: [{ receiptId, outcome: "taken_back", op: "create", workoutId, at: nowInstant(), compensation: [] }], remaining: [] });
    const row = await rowOf(workoutId);
    expect([row.archivedAt, row.archiveReason]).toEqual([nowInstant(), "taken_back"]);
    expect(await receiptOf(receiptId)).toMatchObject({ status: "taken_back", requestId: "req-1", takenBackAt: nowInstant() });
    expect((await takeBacks()).map((e) => e.detail)).toEqual([{ receiptId, op: "create", workoutId, source: "place", requestId: "req-1", by: `device:${v5.id}` }]);
    // The calendar is told to keep it off (the suppression an archive always writes).
    expect(await w.db.select().from(schema.calendarEventSuppressions).where(eq(schema.calendarEventSuppressions.workoutId, workoutId))).toHaveLength(1);
  });

  it("a move: back to its day and time; a skip: scheduled again; both through run-garden's own writers", async () => {
    const id = await onPlan(addDays(T, 1), "07:00");
    const moved = await approvedMove(id, addDays(T, 3), "18:30");
    expect([(await rowOf(id)).effectiveDate, (await rowOf(id)).effectiveTime]).toEqual([addDays(T, 3), "18:30"]);
    expect((await takeBack([moved])).json.outcomes[0].outcome).toBe("taken_back");
    expect([(await rowOf(id)).effectiveDate, (await rowOf(id)).effectiveTime]).toEqual([addDays(T, 1), "07:00"]);
    const other = await onPlan(addDays(T, 1), "12:00", "Second");
    const skipped = await approvedSkip(other);
    expect([(await rowOf(other)).completionState, (await rowOf(other)).sanctionedBy]).toEqual(["skipped", "coach"]);
    expect((await takeBack([skipped])).json.outcomes[0].outcome).toBe("taken_back");
    expect([(await rowOf(other)).completionState, (await rowOf(other)).sanctionedBy, (await rowOf(other)).resolutionDate]).toEqual(["scheduled", null, null]);
  });

  it("a revision: revised back to its base's document as a NEW revision — every revision kept", async () => {
    const id = await onPlan(addDays(T, 1));
    const revised = await approvedRevise(id, "Coach's version");
    expect([(await rowOf(id)).title, (await rowOf(id)).workoutDocRev]).toEqual(["Coach's version", 2]);
    const a = await takeBack([revised]);
    expect(a.json.outcomes[0].outcome, a.text).toBe("taken_back");
    expect([(await rowOf(id)).title, (await rowOf(id)).workoutDocRev]).toEqual(["Hips and back", 3]);
    const revs = await w.db.select({ rev: workoutDocRevisions.rev, doc: workoutDocRevisions.doc, ref: workoutDocRevisions.sourceRef }).from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id));
    expect(revs.map((r) => [r.rev, JSON.parse(r.doc).title])).toEqual([[1, "Hips and back"], [2, "Coach's version"], [3, "Hips and back"]]);
    expect(revs[2]!.ref).toBe(`take_back:${revised}`);
  });
});

describe("refusals, each writing nothing", () => {
  const snapshot = async () => ({ rows: await w.db.select().from(plannedWorkouts), receipts: await w.db.select().from(takeBackReceipts), audits: await takeBacks() });

  it("an intervening edit — a laptop move, a document edit, a skip, a re-time — is changed_since, with how it stands now", async () => {
    const day = addDays(T, 2);
    const edits: Array<[string, (id: string) => Promise<unknown>]> = [
      ["laptop move", (id) => w.call("POST", `/api/plan/workouts/${id}/move`, { body: { toDate: addDays(T, 4), toTime: "07:00" } })],
      ["document edit", async (id) => w.call("PUT", `/api/workouts/${id}/doc`, { body: { doc: calmDoc({ title: "Mine now" }), baseRev: (await rowOf(id)).workoutDocRev } })],
      ["skip", (id) => w.call("POST", `/api/plan/workouts/${id}/skip`, { body: {} })],
      ["re-time", (id) => w.call("POST", `/api/plan/workouts/${id}/move`, { body: { toDate: day, toTime: "19:00" } })],
    ];
    for (const [name, edit] of edits) {
      const { workoutId, receiptId } = await place(day, "18:00", `c-${name}`);
      const edited = (await edit(workoutId)) as { status: number; text: string };
      expect([name, edited.status], edited.text).toEqual([name, 200]);
      const before = await snapshot();
      const a = await takeBack([receiptId]);
      expect([name, a.json.outcomes[0].outcome, a.json.outcomes[0].error]).toEqual([name, "refused", "changed_since"]);
      expect(a.json.outcomes[0].why).toBe("It changed after it was added, so it stays as it is now.");
      expect(a.json.outcomes[0].now).toMatchObject({ archived_at: null });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("executed: started, done, a performed session or a completion match — performed work is never touched", async () => {
    const cases: Array<[string, (id: string) => Promise<unknown>]> = [
      ["started", (id) => w.db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id))],
      ["done", (id) => w.db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, id))],
      ["performed", (id) => w.db.insert(performedSessions).values({ id: newId(), userId: w.userId, workoutId: id, source: "app", localDate: T, seconds: 60, payloadHash: "h", createdAt: nowInstant(), updatedAt: nowInstant() } as typeof performedSessions.$inferInsert)],
      ["matched", (id) => w.db.insert(schema.workoutCompletionMatches).values({ id: newId(), workoutId: id, activityId: "a-1", confidence: 1, method: "manual", matchedAt: nowInstant() } as typeof schema.workoutCompletionMatches.$inferInsert)],
    ];
    for (const [name, make] of cases) {
      const { workoutId, receiptId } = await place(T, "18:00", `c-${name}`);
      await make(workoutId);
      const before = await snapshot();
      const a = await takeBack([receiptId]);
      expect([name, a.json.outcomes[0].error], a.text).toEqual([name, "executed"]);
      expect(await snapshot()).toEqual(before);
    }
  });

  it("expired after 8 days (or once its day has ended); a move back to a day gone is past; a race is ineligible", async () => {
    const far = await place(addDays(T, 12), "07:00", "c-far");
    const today = await place(T, "18:00", "c-today");
    const id = await onPlan(T, "07:00");
    const moved = await approvedMove(id, addDays(T, 3), "07:00");
    const race = await place(addDays(T, 4), "07:00", "c-race");
    await w.db.update(plannedWorkouts).set({ category: "race" }).where(eq(plannedWorkouts.id, race.workoutId));
    vi.setSystemTime(new Date(at(addDays(T, 1), "09:00")));
    const before = await snapshot();
    const a = await takeBack([today.receiptId, moved, race.receiptId]);
    expect(a.json.outcomes.map((o: { error: string }) => o.error)).toEqual(["expired", "past", "ineligible"]);
    vi.setSystemTime(new Date(at(addDays(T, 9), "09:00")));
    expect((await takeBack([far.receiptId])).json.outcomes[0].error).toBe("expired");
    expect(await snapshot()).toEqual(before);
    // The receipt's own read says so too.
    expect((await w.call("GET", `/api/native/receipts/${far.receiptId}`, { bearer: v5.token })).json.status).toBe("expired");
  });

  it("a group goes back together: group_incomplete names the rest, has_dependents the one relying on it; a group refused in part is refused whole", async () => {
    // Two ops approved together, the second relying on the first (as design-approve.ts writes them).
    const x = await onPlan(addDays(T, 2), "07:00", "First");
    const y = await onPlan(addDays(T, 2), "12:00", "Second");
    const a1 = await approvedMove(x, addDays(T, 3), "07:00", "p2:a");
    const second = await approveSpec("p2:b", "skip", addDays(T, 2), { groupId: "g-p2:a", dependsOn: [a1], preState: { date: addDays(T, 2) } });
    await w.db.update(takeBackReceipts).set({ groupId: "g-p2:a" }).where(eq(takeBackReceipts.id, a1));
    const c = await ctx();
    await skipWorkout(w.db, w.userId, y, { now: c.now, today: T, source: "coach", sanctionedBy: "coach", prefs: c.prefs, onlyIf: sql`1 = 1`, alsoInBatch: receiptInsert(w.db, second) });
    const before = await snapshot();
    const alone = await takeBack([a1]);
    expect(alone.json.outcomes).toEqual([{ receiptId: a1, outcome: "refused", error: "has_dependents", why: expect.any(String), receiptIds: [second.id] }]);
    const other = await takeBack([second.id]);
    expect(other.json.outcomes).toEqual([{ receiptId: second.id, outcome: "refused", error: "group_incomplete", why: expect.any(String), receiptIds: [a1] }]);
    expect(await snapshot()).toEqual(before);
    // One of the two changed since: the other is refused with it, nothing of the group written.
    await w.call("POST", `/api/plan/workouts/${x}/move`, { body: { toDate: addDays(T, 5), toTime: "07:00" } });
    const held = await snapshot();
    const both = await takeBack([a1, second.id]);
    expect(both.json.outcomes.map((o: { error: string }) => o.error)).toEqual(["changed_since", "group_refused"]);
    expect(await snapshot()).toEqual(held);
  });
});

describe("races, retries and the account", () => {
  it("a race between preflight and apply is a reported partial: the one done stays done, the other said changed just now", async () => {
    const x = await place(addDays(T, 2), "07:00", "c-x");
    const y = await place(addDays(T, 2), "12:00", "c-y");
    // The two as one group (an approve's two new workouts): y written after x, so y goes back first.
    await w.db.update(takeBackReceipts).set({ groupId: "g-xy" }).where(eq(takeBackReceipts.id, x.receiptId));
    await w.db.update(takeBackReceipts).set({ groupId: "g-xy", dependsOn: JSON.stringify([x.receiptId]) }).where(eq(takeBackReceipts.id, y.receiptId));
    let raced = false;
    gates.beforeRemove = async () => {
      // y's inverse is the first: let it through, and race x's on the laptop right before it.
      gates.beforeRemove = async () => {
        raced = true;
        const m = await w.call("POST", `/api/plan/workouts/${x.workoutId}/move`, { body: { toDate: addDays(T, 4), toTime: "07:00" } });
        expect(m.status).toBe(200);
      };
    };
    const a = await takeBack([x.receiptId, y.receiptId], "req-race");
    expect(raced).toBe(true);
    expect(a.json.outcomes.map((o: { receiptId: string; outcome: string; error?: string }) => [o.receiptId, o.outcome, o.error ?? null])).toEqual([
      [x.receiptId, "refused", "changed_since"],
      [y.receiptId, "taken_back", null],
    ]);
    expect([(await rowOf(y.workoutId)).archiveReason, (await rowOf(x.workoutId)).archivedAt]).toEqual(["taken_back", null]);
    expect([(await receiptOf(x.receiptId)).status, (await receiptOf(y.receiptId)).status]).toEqual(["open", "taken_back"]);
  });

  it("idempotent: the same requestId answers what it did, writing nothing; another is already_taken_back", async () => {
    const { workoutId, receiptId } = await place(addDays(T, 1), "07:00", "c-idem");
    const first = await takeBack([receiptId], "req-a");
    const rows = await w.db.select().from(plannedWorkouts);
    const again = await takeBack([receiptId], "req-a");
    expect(again.json).toEqual(first.json);
    expect(again.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
    const other = await takeBack([receiptId], "req-b");
    expect(other.json.outcomes).toEqual([{ receiptId, outcome: "already_taken_back", op: "create", workoutId, at: nowInstant(), compensation: [] }]);
    expect(await w.db.select().from(plannedWorkouts)).toEqual(rows);
    expect(await takeBacks()).toHaveLength(1);
  });

  it("another account's receipt, or none, is not_found; it is never touched", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirs = await receiptIdOf(other.userId, "place", "c-theirs");
    await w.db.insert(takeBackReceipts).values({ id: theirs, userId: other.userId, source: "place", sourceKey: "c-theirs", madeBy: "session", workoutId: "w-theirs", op: "create", groupId: theirs, postState: "{}", createdAt: nowInstant(), expiresAt: at(addDays(T, 3), "00:00") });
    const a = await takeBack([theirs, "tb_nothing"]);
    expect(a.json.outcomes).toEqual([{ receiptId: theirs, outcome: "not_found" }, { receiptId: "tb_nothing", outcome: "not_found" }]);
    expect((await receiptOf(theirs)).status).toBe("open");
    expect((await w.call("GET", `/api/native/receipts/${theirs}`, { bearer: v5.token })).status).toBe(404);
  });

  it("stays within the request's statement budget: what doesn't fit comes back remaining, and goes with the same requestId", async () => {
    const placed = [];
    for (let i = 0; i < 5; i++) placed.push(await place(addDays(T, 1 + i), "07:00", `c-many-${i}`));
    const ids = placed.map((p) => p.receiptId);
    const a = await takeBack(ids, "req-many");
    expect(a.statements.length).toBeLessThanOrEqual(45);
    expect(a.json.remaining.length).toBeGreaterThan(0);
    const done = a.json.outcomes.filter((o: { outcome: string }) => o.outcome === "taken_back").map((o: { receiptId: string }) => o.receiptId);
    expect([...done, ...a.json.remaining].sort()).toEqual([...ids].sort());
    const b = await takeBack(ids, "req-many");
    expect(b.statements.length).toBeLessThanOrEqual(45);
    expect(b.json.outcomes.every((o: { outcome: string; receiptId: string }) => o.outcome === "taken_back" || b.json.remaining.includes(o.receiptId))).toBe(true);
  });
});

describe("compensation, read live", () => {
  it("the watch's delete pending → done, or failed; the calendar's event pending until the sync removes it — never 'undone' early", async () => {
    const { workoutId, receiptId } = await place(addDays(T, 1), "07:00", "c-comp");
    await w.db.insert(calendarEventLinks).values({ id: "l-1", workoutId, calendarId: "cal", eventId: "ev", state: "synced", createdAt: nowInstant(), updatedAt: nowInstant() });
    const a = await takeBack([receiptId]);
    expect(a.json.outcomes[0].compensation).toEqual([{ provider: "calendar", state: "pending" }]);
    // The watch's delete, queued for the copy the app had pushed.
    const job = { id: `unpush:${newId()}`, userId: w.userId, workoutId, kind: "coach_delete_workout", expectedContentFingerprint: "x", originalDate: addDays(T, 1), destinationDate: addDays(T, 1), requestedAt: nowInstant(), status: "queued", createdAt: nowInstant(), updatedAt: nowInstant() };
    await w.db.insert(corosWriteJobs).values(job as typeof corosWriteJobs.$inferInsert);
    const read = () => w.call("GET", `/api/native/receipts/${receiptId}`, { bearer: v5.token });
    expect((await read()).json).toMatchObject({ status: "taken_back", compensation: [{ provider: "watch", state: "pending" }, { provider: "calendar", state: "pending" }] });
    await w.db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, job.id));
    await w.db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, "l-1"));
    expect((await read()).json.compensation).toEqual([{ provider: "watch", state: "done" }]);
    await w.db.update(corosWriteJobs).set({ status: "failed" }).where(and(eq(corosWriteJobs.id, job.id)));
    expect((await read()).json.compensation).toEqual([{ provider: "watch", state: "failed" }]);
    expect((await read()).headers["cache-control"]).toBe("no-store");
  });
});
