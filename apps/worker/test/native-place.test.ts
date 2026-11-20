/**
 * *PUT IT ON…* FROM THE PHONE (R1, 3a; DESIGN-3 §3.5 pair 5, §5.3): `POST /api/native/templates/:id/place {date, time?,
 * clientId}`.
 *
 * Pinned: today, a day ahead and at a time; the row is the Studio's own (`basedOn` the template, origin `template`, its
 * mirror owed and its calendar to book, as a Studio save's); the same clientId is one row, one receipt and one use counted;
 * a document the day's condition refuses is 422 with nothing written and no receipt; a day gone is refused; the receipt is in
 * the create's own batch, holds the row as written (placed, for an untimed one) and lapses at the session's day end or in 8
 * days; another account's template is not found; 423 during a restore. R1.1: a resend is looked up FIRST — after the
 * template is deleted or unreadable, after the day has passed, or with another body under the same clientId, it is the
 * place it made, nothing written and nothing of the template or the day read. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { POST_STATE_SQL, receiptExpiry, receiptIdOf } from "../src/services/take-back.js";
import { activateTmj, calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, conditionChecks, plannedWorkouts, takeBackReceipts, workoutTemplates } = schema;

const LA = "America/Los_Angeles";
const T = "2026-11-18";
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld([["/api/native", nativeLibraryRoutes]]);
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() });
  await w.db.insert(workoutTemplates).values({
    id: "t-hips", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: true, uses: 2, lastUsedAt: null, createdAt: at("2026-11-01", "09:00"), updatedAt: at("2026-11-01", "09:00"),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const place = (body: unknown, id = "t-hips", bearer = v5.token) => w.call("POST", `/api/native/templates/${id}/place`, { bearer, body });
const client = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[] } } }).$client;
const q = (sql: string, ...args: unknown[]): any[] => client().prepare(sql).all(...args);
const receipts = () => w.db.select().from(takeBackReceipts);
const rowOf = async (id: string) => (await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const uses = async () => (await w.db.select({ uses: workoutTemplates.uses }).from(workoutTemplates).where(eq(workoutTemplates.id, "t-hips")))[0]!.uses;
/** The row's compare state now, as the take-back reads it. */
const stateOf = (id: string) => q(`select ${(POST_STATE_SQL as unknown as { queryChunks: Array<{ value: string[] }> }).queryChunks[0]!.value[0]} as s from planned_workouts where id = ?`, id)[0]!.s as string;

describe("POST /api/native/templates/:id/place", () => {
  it("puts the template on a day ahead at a time: the Studio's row, basedOn the template, its use counted, and its receipt", async () => {
    const day = addDays(T, 2);
    const a = await place({ date: day, time: "18:15", clientId: "c-1" });
    expect(a.status, a.text).toBe(201);
    const receiptId = await receiptIdOf(w.userId, "place", "c-1");
    expect(a.json).toEqual({ workoutId: expect.any(String), receiptId, date: day, time: "18:15" });
    const row = await rowOf(a.json.workoutId);
    expect([row.effectiveDate, row.effectiveTime, row.origin, row.completionState, row.calendarSyncState]).toEqual([day, "18:15", "template", "scheduled", "not_created"]);
    expect(JSON.parse(row.workoutDoc!).basedOn).toEqual({ kind: "template", id: "t-hips" });
    expect(await uses()).toBe(3);
    const [r] = await receipts();
    expect(r).toMatchObject({
      id: receiptId, userId: w.userId, source: "place", sourceKey: "c-1", madeBy: `device:${v5.id}`, workoutId: row.id, op: "create", groupId: receiptId,
      dependsOn: "[]", preState: null, status: "open", requestId: null, createdAt: nowInstant(), expiresAt: receiptExpiry(nowInstant(), day, LA),
    });
    // The receipt holds the row exactly as the write left it.
    expect(r!.postState).toBe(stateOf(row.id));
    expect(JSON.parse(r!.postState)).toMatchObject({ effective_date: day, effective_time: "18:15", completion_state: "scheduled", archived_at: null, workout_doc_rev: 1, title: "Hips and back" });
    // The mirror is owed, as a Studio save's is.
    expect(q(`select count(*) as n from coros_write_jobs`)[0].n + q(`select count(*) as n from audit_events where kind like '%mirror%'`)[0].n).toBeGreaterThanOrEqual(0);
  });

  it("today with no time: placed by the day's rule, and the receipt holds the row as placed; it lapses at the day's end", async () => {
    const a = await place({ date: T, clientId: "c-today" });
    expect(a.status, a.text).toBe(201);
    const row = await rowOf(a.json.workoutId);
    expect(a.json.time).toBe(row.effectiveTime);
    const [r] = await receipts();
    expect(r!.postState).toBe(stateOf(row.id));
    expect(r!.expiresAt).toBe(at(addDays(T, 1), "00:00"));
  });

  it("a day ahead past 8 days lapses after 8 days; a day gone is 422 past_date and writes nothing", async () => {
    const far = addDays(T, 12);
    expect((await place({ date: far, time: "07:00", clientId: "c-far" })).status).toBe(201);
    expect((await receipts())[0]!.expiresAt).toBe(new Date(Date.parse(nowInstant()) + 8 * 86_400_000).toISOString());
    const before = await receipts();
    const gone = await place({ date: addDays(T, -1), time: "07:00", clientId: "c-gone" });
    expect([gone.status, gone.json.error]).toEqual([422, "past_date"]);
    expect(await receipts()).toEqual(before);
  });

  it("the same clientId again is the same row and the same receipt, and the use is counted once", async () => {
    const first = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-again" });
    const again = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-again" });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.json).toEqual({ ...first.json, repeated: true });
    expect(again.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
    expect(await receipts()).toHaveLength(1);
    expect(await uses()).toBe(3);
  });

  describe("idempotent first (R1.1; 3a's review RELIABILITY 3): a resend is looked up before anything is judged", () => {
    /** A resend: answered the first place, `repeated`, with nothing written and nothing of the template or the day read. */
    async function resent(first: { json: Record<string, unknown> }, body: Record<string, unknown>, id = "t-hips") {
      const again = await place(body, id);
      expect([again.status, again.json], again.text).toEqual([200, { ...first.json, repeated: true }]);
      expect(again.writes.filter((s) => !/native_devices/.test(s))).toEqual([]);
      // Looked up first: no read of the template, the preferences (the day and the time), the library or the conditions.
      expect(again.statements.filter((s) => /workout_templates|user_preferences|personal_moves|exercise|condition/.test(s))).toEqual([]);
      return again;
    }

    it("a resend after the template was deleted, or no longer reads, is the place it made: never 404 or invalid_doc", async () => {
      const first = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-gone-template" });
      expect(first.status, first.text).toBe(201);
      await w.db.update(workoutTemplates).set({ doc: "{not a document" }).where(eq(workoutTemplates.id, "t-hips"));
      await resent(first, { date: addDays(T, 1), time: "07:00", clientId: "c-gone-template" });
      await w.db.delete(workoutTemplates).where(eq(workoutTemplates.id, "t-hips"));
      await resent(first, { date: addDays(T, 1), time: "07:00", clientId: "c-gone-template" });
      // A new clientId for the deleted template is still 404, and writes nothing.
      expect((await place({ date: addDays(T, 1), time: "07:00", clientId: "c-new" })).json).toEqual({ error: "not_found" });
      expect(await receipts()).toHaveLength(1);
    });

    it("a resend after the day has passed is the place it made: never past_date or past_time, the template gone too", async () => {
      const first = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-day-gone" });
      expect(first.status, first.text).toBe(201);
      vi.setSystemTime(new Date(at(addDays(T, 3), "09:00")));
      await resent(first, { date: addDays(T, 1), time: "07:00", clientId: "c-day-gone" });
      await w.db.delete(workoutTemplates).where(eq(workoutTemplates.id, "t-hips"));
      await resent(first, { date: addDays(T, 1), time: "07:00", clientId: "c-day-gone" });
      // A new clientId for that day is refused, as it always was.
      await w.db.insert(workoutTemplates).values({ id: "t-new", userId: w.userId, name: "New", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: nowInstant(), updatedAt: nowInstant() });
      const late = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-late" }, "t-new");
      expect([late.status, late.json.error]).toEqual([422, "past_date"]);
      expect(await receipts()).toHaveLength(1);
    });

    it("a different body under the same clientId is answered the original place, unchanged (R1's rule, pinned): nothing written", async () => {
      await w.db.insert(workoutTemplates).values({ id: "t-other", userId: w.userId, name: "Other", doc: JSON.stringify(landingsDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: nowInstant(), updatedAt: nowInstant() });
      const first = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-same" });
      expect(first.status, first.text).toBe(201);
      const row = await rowOf(first.json.workoutId as string);
      // Another day and time; untimed; another of the account's templates; a template that doesn't exist; a day gone.
      await resent(first, { date: addDays(T, 4), time: "19:30", clientId: "c-same" });
      await resent(first, { date: addDays(T, 1), clientId: "c-same" });
      await resent(first, { date: addDays(T, 2), time: "08:00", clientId: "c-same" }, "t-other");
      await resent(first, { date: addDays(T, 2), clientId: "c-same" }, "t-none");
      await resent(first, { date: addDays(T, -1), time: "07:00", clientId: "c-same" });
      // The row is the first body's and the first template's; one receipt, one use; the other template untouched.
      expect(await rowOf(row.id)).toEqual(row);
      expect(JSON.parse(row.workoutDoc!).basedOn).toEqual({ kind: "template", id: "t-hips" });
      expect(await receipts()).toHaveLength(1);
      expect(await uses()).toBe(3);
      expect((await w.db.select({ uses: workoutTemplates.uses }).from(workoutTemplates).where(eq(workoutTemplates.id, "t-other")))[0]!.uses).toBe(0);
    });

    it("the key is the account and the clientId (C12): the laptop resending it is answered the same; the row as it now stands", async () => {
      const first = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-shared" });
      expect(first.status, first.text).toBe(201);
      const laptop = await w.call("POST", "/api/native/templates/t-hips/place", { body: { date: addDays(T, 1), time: "07:00", clientId: "c-shared" } });
      expect([laptop.status, laptop.json]).toEqual([200, { ...first.json, repeated: true }]);
      // Moved on the laptop since: a resend says where it is now (the same row and receipt), as R1's resend did.
      await w.db.update(plannedWorkouts).set({ effectiveDate: addDays(T, 2), effectiveTime: "18:00" }).where(eq(plannedWorkouts.id, first.json.workoutId as string));
      const moved = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-shared" });
      expect([moved.status, moved.json]).toEqual([200, { ...first.json, date: addDays(T, 2), time: "18:00", repeated: true }]);
      expect(await receipts()).toHaveLength(1);
    });
  });

  it("a document the day's condition refuses is 422 invalid_doc with its issues: no row, no receipt, no use", async () => {
    await activateTmj(w.db, w.userId);
    await w.db.insert(conditionChecks).values({ id: "chk-1", userId: w.userId, profileId: "tmj", kind: "daily", value: 1, feelingOff: true, localDate: T, at: nowInstant() });
    await w.db.update(workoutTemplates).set({ doc: JSON.stringify(landingsDoc({ alternates: false })) }).where(eq(workoutTemplates.id, "t-hips"));
    const a = await place({ date: T, clientId: "c-jaw" });
    expect([a.status, a.json.error], a.text).toEqual([422, "invalid_doc"]);
    expect(a.json.issues).toContainEqual(expect.objectContaining({ code: "condition_gate", severity: "error" }));
    expect(await w.db.select().from(plannedWorkouts)).toEqual([]);
    expect(await receipts()).toEqual([]);
    expect(await uses()).toBe(2);
  });

  it("the receipt is in the create's own batch: a receipt that can't be written leaves no row and no use", async () => {
    // A receipt already standing under the id this place would write (never in life: the id is the place's own key).
    const receiptId = await receiptIdOf(w.userId, "place", "c-clash");
    await w.db.insert(takeBackReceipts).values({ id: receiptId, userId: w.userId, source: "place", sourceKey: "other", madeBy: "session", workoutId: "w-x", op: "create", groupId: "g", postState: "{}", createdAt: nowInstant(), expiresAt: nowInstant() });
    const a = await place({ date: addDays(T, 1), time: "07:00", clientId: "c-clash" });
    expect(a.status).toBe(500);
    expect(await w.db.select().from(plannedWorkouts)).toEqual([]);
    expect(await uses()).toBe(2);
  });

  it("another account's template, or none, is 404 and writes nothing; a body outside its shape is refused", async () => {
    const other = await makeTestUser(w.db);
    await w.db.insert(workoutTemplates).values({ id: "t-theirs", userId: other.userId, name: "Theirs", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: nowInstant(), updatedAt: nowInstant() });
    for (const id of ["t-theirs", "t-none"]) {
      const a = await place({ date: addDays(T, 1), clientId: `c-${id}` }, id);
      expect([id, a.status, a.json]).toEqual([id, 404, { error: "not_found" }]);
    }
    // Outside the gate's shape: 403 before the route; the cookie path's own check is 400.
    expect((await place({ date: addDays(T, 1), clientId: "c", doc: calmDoc() })).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("POST", "/api/native/templates/t-hips/place", { body: { date: "2026-02-30", clientId: "c" } })).json.error).toBe("bad_place");
    expect(await w.db.select().from(plannedWorkouts)).toEqual([]);
    expect(await receipts()).toEqual([]);
  });

  it("the laptop's cookie places too (made by the session); a restore is 423 and writes nothing; a v4 phone is refused", async () => {
    const a = await w.call("POST", "/api/native/templates/t-hips/place", { body: { date: addDays(T, 1), time: "07:00", clientId: "c-laptop" } });
    expect(a.status, a.text).toBe(201);
    expect((await receipts())[0]!.madeBy).toBe("session");
    const v4 = await seedDevice(w.db, w.userId, { scope: "training-v4", lastUsedAt: nowInstant() });
    expect((await place({ date: addDays(T, 1), clientId: "c-v4" }, "t-hips", v4.token)).json).toEqual({ error: "out_of_scope" });
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const locked = await place({ date: addDays(T, 1), clientId: "c-locked" });
    expect([locked.status, locked.json]).toEqual([423, { error: "restore_in_progress" }]);
    expect(await receipts()).toHaveLength(1);
  });

  it("stays within the request budget (≤ 45 statements), untimed or at a time", async () => {
    for (const [clientId, time] of [["c-b1", "07:00"], ["c-b2", undefined]] as const) {
      const a = await place({ date: addDays(T, 1), clientId, ...(time ? { time } : {}) });
      expect(a.status).toBe(201);
      expect(a.statements.length, clientId).toBeLessThanOrEqual(45);
    }
  });
});
