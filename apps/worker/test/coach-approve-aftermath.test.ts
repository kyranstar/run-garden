/**
 * THE APPROVE ROUTE'S AFTERMATH (audit 1, coach finding 9).
 *
 * Task 1 gave `POST /proposals/:id/approve` the same aftermath the athlete's own
 * edits have — the garden replays from the earliest day an op resolved,
 * archived or restored, and the calendar follows the plan — and nothing tested
 * either half. The garden and the calendar are external effects here, so they
 * are observed at the module boundary: `resimulateFrom` and `syncCalendar` are
 * spied on, every other export is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type CoachOp, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const spies = vi.hoisted(() => ({
  resimulateFrom: vi.fn(async () => undefined),
  syncCalendar: vi.fn(async () => undefined),
}));
vi.mock("../src/services/garden-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/garden-sync.js")>()),
  resimulateFrom: spies.resimulateFrom,
}));
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: spies.syncCalendar,
}));

const { coachRoutes } = await import("../src/routes/coach.js");
const { REQUEST_GARDEN_STEP } = await import("../src/services/garden-sync.js");
const { CALENDAR_OPS_PER_REQUEST } = await import("../src/services/calendar-sync.js");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  spies.resimulateFrom.mockClear();
  spies.syncCalendar.mockClear();
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

async function seedWorkout(id: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Tempo",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function approve(id: string, ops: CoachOp[], expiresAt: string) {
  await db.insert(schema.coachProposals).values({
    id,
    userId,
    title: "Proposal",
    evidence: "e",
    rationale: "r",
    flags: [],
    ops,
    status: "pending",
    createdAt: nowInstant(),
    expiresAt,
  });
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return app.request(`/api/coach/proposals/${id}/approve`, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
}

describe("approve: the garden and the calendar follow the plan", () => {
  it("a skip of today's session replays the garden from today and syncs the calendar", async () => {
    const today = todayInZone(prefs.timezone);
    await seedWorkout("w-today", today);

    const res = await approve("p1", [{ kind: "skip", workoutId: "w-today", reason: "tired" }], today);

    expect(res.status).toBe(200);
    expect(spies.resimulateFrom).toHaveBeenCalledTimes(1);
    // One request's step of garden, never the uncapped default (cron reliability, part 4).
    expect(spies.resimulateFrom).toHaveBeenCalledWith(
      db,
      userId,
      today,
      expect.objectContaining({ timezone: prefs.timezone }),
      expect.any(Date),
      REQUEST_GARDEN_STEP,
    );
    expect(spies.syncCalendar).toHaveBeenCalledTimes(1);
    // One bounded step of the calendar in the approve's own invocation (2026-10-10); the half-hourly run books the rest.
    // (Read argument by argument: a failed toHaveBeenCalledWith prints `db` whole, which runs the worker out of heap.)
    const [calDb, , calUser, calOpts] = spies.syncCalendar.mock.calls[0] as unknown[];
    expect(calDb === db && calUser === userId).toBe(true);
    expect(calOpts).toEqual({ maxOps: CALENDAR_OPS_PER_REQUEST });
  });

  it("ops that reach no past day leave the garden alone, and still sync the calendar", async () => {
    const today = todayInZone(prefs.timezone);
    await seedWorkout("w-ahead", addDays(today, 3));

    const res = await approve("p2", [{ kind: "remove", workoutId: "w-ahead" }], addDays(today, 3));

    expect(res.status).toBe(200);
    expect(spies.resimulateFrom).not.toHaveBeenCalled();
    expect(spies.syncCalendar).toHaveBeenCalledTimes(1);
  });

  it("a refused (expired) approve runs neither", async () => {
    const today = todayInZone(prefs.timezone);
    await seedWorkout("w-today", today);

    const res = await approve("p3", [{ kind: "skip", workoutId: "w-today" }], addDays(today, -1));

    expect(res.status).toBe(409);
    expect(spies.resimulateFrom).not.toHaveBeenCalled();
    expect(spies.syncCalendar).not.toHaveBeenCalled();
  });
});
