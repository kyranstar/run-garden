/**
 * A WORKOUT PLAYED OFFLINE, RECORDED ON RECONNECT (R11, the lead's ruling b): `POST /api/workouts` with
 * `playedOffline: true` records what was done, not a plan. It is honoured only for an app-authored document (a quick
 * start or a template's), dated today or up to seven days back, made to start at once (no calendar) with the device's
 * key (`clientId`, so a retry names the same row). It skips the day's gate — the day was judged on the device — and
 * still refuses a document that does not read or is too large. Such a row left with no session is removed by the daily
 * reconcile once its day is over and the outbox has had its reach (a week) to deliver, and is never asked about or
 * missed. (Fix round 1: a quick start's ref names a quick start the app makes; a template is one of the account's.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { PLAYED_OFFLINE_CALENDAR_STATE, PLAYED_OFFLINE_DAYS_BACK } from "../src/services/doc-workouts.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, type Reply } from "./doc-workout-fixture.js";

const { plannedWorkouts, performedSessions, workoutTemplates } = schema;

const calendar = vi.hoisted(() => ({ syncs: 0 }));
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => {
    calendar.syncs += 1;
    return {};
  }),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  calendar.syncs = 0;
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  call = await clientFor(db, userId);
  // The account's template "t1" (a template's document is based on it).
  await db.insert(workoutTemplates).values({ id: "t1", userId, name: "Mine", doc: JSON.stringify(calmDoc()), createdAt: nowInstant(), updatedAt: nowInstant() });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0];
const quick = (doc: WorkoutDoc): WorkoutDoc => ({ ...doc, source: { kind: "studio", ref: "quick_start:desk_reset" } }) as WorkoutDoc;
const fromTemplate = (doc: WorkoutDoc): WorkoutDoc => ({ ...doc, basedOn: { kind: "template", id: "t1" } }) as WorkoutDoc;
const offline = (body: Record<string, unknown>) => call("POST", "/api/workouts", { startNow: true, playedOffline: true, clientId: newId(), ...body });

describe("POST /api/workouts with playedOffline", () => {
  it("records a quick start played offline: the day's gate is skipped, no calendar is booked, and the same key names the same row", async () => {
    await activateTmj(db, userId);
    // A jump today while the server knows the athlete feels off (since 2026-10-23 an unanswered check no longer closes
    // one): the planned create refuses it.
    expect((await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 1, feelingOff: true })).status).toBe(200);
    const gated = quick(landingsDoc({ alternates: false }));
    expect((await call("POST", "/api/workouts", { date: today, doc: gated, startNow: true, clientId: newId() })).status).toBe(422);
    const clientId = newId();
    const made = await offline({ date: today, doc: gated, clientId });
    expect(made.status).toBe(201);
    const row = (await rowOf(made.body.workout.id))!;
    expect(row.calendarSyncState).toBe(PLAYED_OFFLINE_CALENDAR_STATE);
    expect(calendar.syncs).toBe(0);
    const again = await offline({ date: today, doc: gated, clientId });
    expect(again.status).toBe(200);
    expect(again.body.workout.id).toBe(made.body.workout.id);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).length).toBe(1);
  });

  it("keeps the day it was played: today or up to seven days back; never ahead, never older", async () => {
    for (const back of [0, 1, 7]) expect((await offline({ date: addDays(today, -back), doc: quick(calmDoc()) })).status, `${back} back`).toBe(201);
    for (const day of [addDays(today, -8), addDays(today, 1)]) {
      const res = await offline({ date: day, doc: quick(calmDoc()) });
      expect(res.status, day).toBe(422);
      expect(res.body).toMatchObject({ error: "played_offline_refused", why: "date" });
    }
    // Without the flag, a day past is still refused.
    expect((await call("POST", "/api/workouts", { date: addDays(today, -1), doc: quick(calmDoc()), startNow: true, clientId: newId() })).body).toMatchObject({ error: "past_date" });
  });

  it("only for a quick start's or a template's document: a coach's, a programme's or a new Studio workout's is refused", async () => {
    expect((await offline({ date: today, doc: fromTemplate(calmDoc()) })).status).toBe(201);
    for (const kind of ["desk_reset", "hip_opener", "condition_care"]) {
      expect((await offline({ date: today, doc: { ...calmDoc(), title: kind, source: { kind: "studio", ref: `quick_start:${kind}` } } })).status, kind).toBe(201);
    }
    const other = await makeTestUser(db);
    await db.insert(workoutTemplates).values({ id: "t-theirs", userId: other.userId, name: "Theirs", doc: JSON.stringify(calmDoc()), createdAt: nowInstant(), updatedAt: nowInstant() });
    const refused: WorkoutDoc[] = [
      calmDoc(),
      { ...calmDoc(), source: { kind: "coach" } } as WorkoutDoc,
      { ...calmDoc(), source: { kind: "engine" } } as WorkoutDoc,
      // A coach's document dressed as a template's is still the coach's.
      { ...fromTemplate(calmDoc()), source: { kind: "coach" } } as WorkoutDoc,
      // A quick start's ref that names no quick start the app makes (fix round 1).
      { ...calmDoc(), source: { kind: "studio", ref: "quick_start:anything" } } as WorkoutDoc,
      { ...calmDoc(), source: { kind: "studio", ref: "quick_start:" } } as WorkoutDoc,
      // A template another account holds (fix round 1).
      { ...calmDoc(), basedOn: { kind: "template", id: "t-theirs" } } as WorkoutDoc,
    ];
    for (const doc of refused) {
      const res = await offline({ date: today, doc });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: "played_offline_refused", why: "source" });
    }
  });

  it("a template the account deleted before the device reconnected: what was played is still recorded (fix round 2)", async () => {
    // Played offline from "t1", then deleted from the account (on another device) before this one reconnects.
    const doc = { ...fromTemplate(calmDoc()), title: "Deleted since" } as WorkoutDoc;
    await db.delete(workoutTemplates).where(eq(workoutTemplates.id, "t1"));
    const made = await offline({ date: today, doc });
    expect(made.status).toBe(201);
    expect((await rowOf(made.body.workout.id))!.calendarSyncState).toBe(PLAYED_OFFLINE_CALENDAR_STATE);
    // An id no template holds at all is the same: no account's.
    expect((await offline({ date: today, doc: { ...calmDoc(), title: "Never held", basedOn: { kind: "template", id: "t-gone" } } as WorkoutDoc })).status).toBe(201);
  });

  it("needs the device's key and Start now: without either it is refused", async () => {
    const noKey = await call("POST", "/api/workouts", { date: today, doc: quick(calmDoc()), startNow: true, playedOffline: true });
    expect(noKey.status).toBe(422);
    expect(noKey.body).toMatchObject({ error: "played_offline_refused", why: "key" });
    const planned = await call("POST", "/api/workouts", { date: today, doc: quick(calmDoc()), clientId: newId(), playedOffline: true });
    expect(planned.status).toBe(422);
    expect(planned.body).toMatchObject({ error: "played_offline_refused", why: "key" });
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).length).toBe(0);
  });

  it("still refuses a document that does not read, or one too large", async () => {
    const broken = await offline({ date: today, doc: { ...quick(calmDoc()), parts: "none" } });
    expect(broken.status).toBe(422);
    expect(broken.body.error).toBe("invalid_doc");
    const huge = quick({ ...calmDoc(), parts: [0, 1, 2, 3].map(() => ({ ...calmDoc().parts[0]!, items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 20, reps: 188, restSec: 0 } }] })) } as WorkoutDoc);
    const big = await offline({ date: today, doc: huge });
    expect(big.status).toBe(422);
    expect(big.body.issues).toContainEqual(expect.objectContaining({ code: "too_large" }));
  });
});

describe("the session played offline lands on its workout", () => {
  it("one session, its before-reading as one check at its own day and time, the workout done, booked on no calendar", async () => {
    await activateTmj(db, userId);
    const day = addDays(today, -1);
    const made = await offline({ date: day, doc: quick(calmDoc()) });
    expect(made.status).toBe(201);
    const workoutId = made.body.workout.id as string;
    const id = newId();
    const at = `${day}T18:00:00.000Z`;
    const body = {
      id, source: "app", sourceRef: null, workoutId, buildId: null, localDate: day,
      startedAt: at, endedAt: `${day}T18:20:00.000Z`, seconds: 1200, plannedSeconds: 1200, minutes: 20,
      mode: "build", theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true,
      stepsTotal: 1, stepsDone: 1, movesDone: [{ exerciseId: "bridge", seconds: 120, slotKey: "core:0" }], note: null, newMove: null,
      entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, side: null, reps: 12, seconds: null, load: null, done: true, flags: [] }] }],
      checks: [{ profileId: "tmj", kind: "pre", value: 2, feelingOff: false, at }],
      review: {},
    };
    const saved = await call("PUT", `/api/sessions/performed/${id}`, body);
    expect(saved.body).toMatchObject({ status: "saved" });
    // Sent again (a retry whose answer was lost): nothing more.
    expect((await call("PUT", `/api/sessions/performed/${id}`, body)).body).toMatchObject({ status: "same_payload" });
    const sessions = await db.select().from(performedSessions).where(eq(performedSessions.userId, userId));
    expect(sessions.map((s) => [s.workoutId, s.localDate])).toEqual([[workoutId, day]]);
    const checks = await db.select().from(schema.conditionChecks).where(eq(schema.conditionChecks.userId, userId));
    expect(checks.map((c) => [c.kind, c.value, c.localDate, c.at, c.workoutId])).toEqual([["pre", 2, day, at, workoutId]]);
    const row = (await rowOf(workoutId))!;
    expect(row.calendarSyncState).toBe(PLAYED_OFFLINE_CALENDAR_STATE);
    expect(row.contentState).toBe("done");
    expect(calendar.syncs).toBe(0);
  });
});

describe("the daily reconcile and a workout played offline", () => {
  it("one left with no session is kept the outbox's reach (a week), then removed — never asked about, never missed", async () => {
    const made = await offline({ date: addDays(today, -3), doc: quick(calmDoc()) });
    expect(made.status).toBe(201);
    const id = made.body.workout.id as string;
    // Its day is over, but it was made just now: the outbox is still delivering its session.
    await reconcileCompletionStates(db, userId, prefs, new Date());
    expect((await rowOf(id))?.archivedAt ?? null).toBeNull();
    expect((await rowOf(id))!.completionState).toBe("scheduled");
    // Six days on, the outbox may still deliver it (a save late in its week): kept (fix round 1).
    await reconcileCompletionStates(db, userId, prefs, new Date(Date.now() + 6 * DAY_MS));
    expect((await rowOf(id))?.archivedAt ?? null).toBeNull();
    // Past the outbox's reach, still with no session: removed, as an abandoned Start now is.
    expect(PLAYED_OFFLINE_DAYS_BACK).toBe(7);
    const later = new Date(Date.now() + (PLAYED_OFFLINE_DAYS_BACK * 24 + 1) * 60 * 60 * 1000);
    const stats = await reconcileCompletionStates(db, userId, prefs, later);
    expect(stats.abandonedRemoved).toBe(1);
    const row = await rowOf(id);
    expect(row === undefined || row.archivedAt !== null).toBe(true);
    expect(row?.completionState ?? "scheduled").not.toBe("missed");
  });

  it("one whose session landed is kept", async () => {
    const made = await offline({ date: addDays(today, -2), doc: quick(calmDoc()) });
    const id = made.body.workout.id as string;
    await db.insert(performedSessions).values({
      id: newId(), userId, workoutId: id, source: "app", localDate: addDays(today, -2), payloadHash: "h", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await reconcileCompletionStates(db, userId, prefs, new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect((await rowOf(id))!.archivedAt).toBeNull();
  });
});
