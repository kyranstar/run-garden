/**
 * Shared set-up for the Phase 3 watch suites: a synthetic program ("Strength program"), its slots, a session built
 * today with the pre-check answered, the live COROS catalog's T-codes (synthesized ids, no personal data), and an Env
 * with the switch on or off. Callers pin the clock (`vi.useFakeTimers({ toFake: ["Date"] })`) to `NOON`.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { upsertExerciseCatalog } from "../src/services/exercise-catalog.js";
import { buildSession, type SessionResponse } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { liveExerciseCatalog } from "../../../packages/domain/test/coach-survival/catalog.js";
import type { MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";

const { plannedWorkouts, programs, userConditions } = schema;

/** A Friday. */
export const DAY = "2026-10-09";
export const TOMORROW = "2026-10-10";
/** Noon in the test user's zone (America/Los_Angeles). */
export const NOON = `${DAY}T19:00:00.000Z`;
export const PROGRAM_NAME = "Strength program";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...over,
  } as Env;
}

export const switchOn = (over: Partial<Env> = {}): Env => makeEnv({ WATCH_PUSH_ENABLED: "1", ...over });

export async function seedProgram(db: Db, userId: string, name = PROGRAM_NAME): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "adaptive", name, status: "active", disciplines: ["strength", "yoga"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }), createdAt: NOON, updatedAt: NOON, archivedAt: null,
  });
  return id;
}

export async function seedTmj(db: Db, userId: string): Promise<void> {
  await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
}

/** A slot as placement writes it: an outline, calendar only, no watch address. */
export async function seedSlot(db: Db, userId: string, programId: string, date: string, id = slotId(programId, date)): Promise<string> {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: PROGRAM_NAME, category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
  });
  return id;
}

/** Today's build of the slot, the pre-check answered. */
export async function buildToday(db: Db, userId: string, prefs: UserPreferences, workoutId: string): Promise<SessionResponse> {
  return buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, { today: DAY, now: NOON, prefs });
}

/** The live COROS strength catalog's T-codes, under synthesized ids (packages/domain/test/coach-survival/catalog.ts). */
export async function seedCatalog(db: Db): Promise<Map<string, string>> {
  const catalog = liveExerciseCatalog();
  await upsertExerciseCatalog(db, [...catalog].map(([id, name]) => ({ id, name })));
  return catalog;
}

/** A real (mock) COROS connection: the cloud lane can log in and write. */
export async function connectMock(db: Db, userId: string, server: MockCorosServer): Promise<void> {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  if (res.status !== "connected") throw new Error(`mock COROS did not connect: ${res.status}`);
}

/** A fetch that counts every call it passes on (the subrequest budget), and lets a test act when one passes. */
export function counting(
  server: MockCorosServer,
  onCall?: (url: URL, init: RequestInit | undefined) => void | Promise<void>,
): { fetchImpl: typeof fetch; calls: () => number; writes: () => number } {
  let calls = 0;
  let writes = 0;
  const fetchImpl = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    calls += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/training/schedule/update") writes += 1;
    const res = await server.fetchImpl(input, init);
    await onCall?.(url, init);
    return res;
  } as typeof fetch;
  return { fetchImpl, calls: () => calls, writes: () => writes };
}

export async function rowOf(db: Db, id: string) {
  return (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
}
