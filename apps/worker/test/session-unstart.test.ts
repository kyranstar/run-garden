/**
 * DISCARD UN-STARTS (ruling 2b-R9): `POST /api/sessions/:workoutId/unstart` returns a started slot to `built` and
 * unlocks its build, so Today offers Start again (not a Continue that would replay the discarded session).
 *
 *  - only the owner's slot (404 otherwise); refused while a restore runs (423, `requireUser`);
 *  - refused once a performed session exists for the slot (409 `performed`): the session was saved, from this device
 *    or another — it is not the player's to take back;
 *  - idempotent: a slot already built answers as it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, nowInstant, type PerformedSessionWireInput, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { buildSession, loadSession, startSession, unstartSession, type SessionResponse } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts, programs, sessionBuilds, userConditions } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

const DAY = "2026-10-06";
const NOON = `${DAY}T19:00:00.000Z`;

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  // The routes read today from the clock: pinned to the slot's day (Date only; timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  programId = newId();
  await db.insert(programs).values({
    id: programId, userId, kind: "adaptive", name: "Program one", status: "active", disciplines: ["yoga", "strength"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }), createdAt: NOON, updatedAt: NOON, archivedAt: null,
  });
  await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

async function started(): Promise<{ workoutId: string; session: SessionResponse }> {
  const id = slotId(programId, DAY);
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: "Program one", category: "yoga", sport: "yoga",
    originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
  });
  const built = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, { today: DAY, now: NOON, prefs });
  return { workoutId: id, session: await startSession(db, userId, id, built.build!.buildId, NOON) };
}

const ctx = () => ({ today: DAY, now: nowInstant() });
const lockedBuilds = async (workoutId: string) =>
  (await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId))).filter((b) => b.lockedAt !== null);

describe("unstartSession", () => {
  it("returns a started slot to built and unlocks its build: Start can lock it again", async () => {
    const { workoutId, session } = await started();
    expect(session).toMatchObject({ contentState: "started", locked: true });
    const after = await unstartSession(db, userId, workoutId, ctx());
    expect(after).toMatchObject({ contentState: "built", locked: false });
    expect(after.build?.buildId).toBe(session.build!.buildId);
    expect(await lockedBuilds(workoutId)).toEqual([]);
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(row!.contentState).toBe("built");
    // The same build is Start's again, as the sheet shows it.
    const again = await startSession(db, userId, workoutId, after.build!.buildId, NOON);
    expect(again).toMatchObject({ contentState: "started", locked: true });
  });

  it("keeps the started build on record (ruling 2b-R19): unlocked, its day known, through a move and a new build", async () => {
    const { workoutId, session } = await started();
    await unstartSession(db, userId, workoutId, ctx());
    // Moved to the next day and opened there: a new build of the slot, which prunes the builds never started.
    const NEXT = "2026-10-07";
    await db.update(plannedWorkouts).set({ effectiveDate: NEXT }).where(eq(plannedWorkouts.id, workoutId));
    const fresh = await buildSession(db, userId, workoutId, {}, { today: NEXT, now: `${NEXT}T19:00:00.000Z`, prefs });
    expect(fresh.build!.buildId).not.toBe(session.build!.buildId);
    const rows = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId));
    const kept = rows.find((b) => b.id === session.build!.buildId);
    expect(kept?.lockedAt).toBeNull();
    expect((kept?.payload as { build?: { date?: string } } | undefined)?.build?.date).toBe(DAY);
    // The slot shows the new day's build, not the one kept on record.
    expect((await loadSession(db, userId, workoutId, NEXT)).build?.buildId).toBe(fresh.build!.buildId);
  });

  it("is idempotent: a slot already built answers as it is, and writes nothing", async () => {
    const { workoutId } = await started();
    const first = await unstartSession(db, userId, workoutId, ctx());
    statements.length = 0;
    const second = await unstartSession(db, userId, workoutId, ctx());
    expect(second).toEqual(first);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("refuses once a performed session exists for the slot, and changes nothing", async () => {
    const { workoutId, session } = await started();
    const build = session.build!;
    const wire: PerformedSessionWireInput = {
      id: newId(), source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate: DAY,
      startedAt: `${DAY}T19:05:00.000Z`, endedAt: `${DAY}T19:35:00.000Z`, seconds: 1800, plannedSeconds: build.plannedSeconds,
      minutes: build.minutes, mode: build.mode, theme: build.theme, locationId: build.locationId, blockRef: build.blockRef,
      blockNumber: 1, completed: false, stepsTotal: 10, stepsDone: 2, movesDone: [], note: null, newMove: null, entries: [], checks: [],
      review: {},
    };
    expect(await savePerformedSession(db, userId, wire.id, wire, { now: NOON, prefs })).toMatchObject({ status: "saved" });
    statements.length = 0;
    await expect(unstartSession(db, userId, workoutId, ctx())).rejects.toThrow("performed");
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await loadSession(db, userId, workoutId, DAY)).contentState).toBe("done");
  });

  it("refuses a started slot whose session was saved from elsewhere (a watch session linked to it) — never undoes a save", async () => {
    const { workoutId } = await started();
    await db.insert(schema.performedSessions).values({
      id: newId(), userId, workoutId, activityId: null, buildId: null, source: "watch", sourceRef: "w-1", localDate: DAY,
      startedAt: `${DAY}T19:05:00.000Z`, endedAt: null, seconds: 1800, plannedSeconds: null, minutes: null, mode: null, theme: null,
      locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [],
      note: null, newMove: null, payloadHash: "h", createdAt: NOON, updatedAt: NOON,
    });
    await expect(unstartSession(db, userId, workoutId, ctx())).rejects.toThrow("performed");
    const [row] = await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
    expect(row!.contentState).toBe("started");
    expect(await lockedBuilds(workoutId)).toHaveLength(1);
  });
});

describe("POST /api/sessions/:workoutId/unstart", () => {
  const makeEnv = (): Env =>
    ({
      DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0",
      AI_DEFAULT_ENABLED: "1", SESSION_SECRET: "test-session-secret", TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
      ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret",
    }) as Env;
  const post = async (workoutId: string, who = userId) => {
    const cookie = `${SESSION_COOKIE}=${await createSession(db, who, "test")}`;
    return mountRoutes(db, "/api/sessions", sessionRoutes).request(
      `/api/sessions/${workoutId}/unstart`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" } },
      makeEnv(),
    );
  };

  it("200 with the session built again; 404 for another user's slot", async () => {
    const { workoutId } = await started();
    const other = (await makeTestUser(db)).userId;
    expect((await post(workoutId, other)).status).toBe(404);
    const ok = await post(workoutId);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ workoutId, contentState: "built", locked: false });
    // Again: the same answer.
    expect((await post(workoutId)).status).toBe(200);
  });

  it("409 performed once the session was saved", async () => {
    const { workoutId } = await started();
    await db.insert(schema.performedSessions).values({
      id: newId(), userId, workoutId, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: DAY,
      startedAt: `${DAY}T19:05:00.000Z`, endedAt: null, seconds: 1800, plannedSeconds: null, minutes: null, mode: null, theme: null,
      locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [],
      note: null, newMove: null, payloadHash: "h", createdAt: NOON, updatedAt: NOON,
    });
    const res = await post(workoutId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "performed" });
  });

  it("423 while a restore is replacing the account; the slot stays started", async () => {
    const { workoutId } = await started();
    await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const res = await post(workoutId);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: "restore_in_progress" });
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(row!.contentState).toBe("started");
  });
});
