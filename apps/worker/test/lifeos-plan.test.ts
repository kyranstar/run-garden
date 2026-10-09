/**
 * LifeOS reads the plan (`GET /api/lifeos/plan`): the owner's habit app learns each day's planned sessions, rest
 * days and which sessions were done. A read-only machine endpoint behind a bearer token whose SHA-256 is the Worker
 * secret `LIFEOS_TOKEN_SHA256`; without the secret it doesn't exist (404). No cookie, no writes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { lifeosRoutes } from "../src/routes/lifeos.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { activities, plannedWorkouts, users, workoutCompletionMatches } = schema;
const TOKEN = "a".repeat(64);

let db: Db;
let userId: string;
let email: string;

async function makeEnv(token: string | null = TOKEN): Promise<Env> {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: email,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...(token === null ? {} : { LIFEOS_TOKEN_SHA256: await sha256Hex(token) }),
  };
}

async function get(path: string, init: RequestInit = { headers: { Authorization: `Bearer ${TOKEN}` } }, env?: Env) {
  const app = mountRoutes(db, "/api/lifeos", lifeosRoutes);
  return app.request(path, init, env ?? (await makeEnv()));
}

async function seed(
  id: string,
  date: string,
  fields: Partial<typeof plannedWorkouts.$inferInsert> = {},
): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "plan-1",
    sourceWorkoutId: id,
    title: "Easy run",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "18:30",
    sourceContentFingerprint: id,
    calendarBlockDurationSeconds: 3000,
    sourceEstimatedDurationSeconds: 2400,
    completionState: "scheduled",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...fields,
  });
}

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db));
  email = `runner-${userId}@example.com`;
});

describe("GET /api/lifeos/plan", () => {
  it("doesn't exist without the secret", async () => {
    const res = await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-06", undefined, await makeEnv(null));
    expect(res.status).toBe(404);
  });

  it("refuses a missing or wrong token", async () => {
    expect((await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-06", {})).status).toBe(401);
    const wrong = await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-06", { headers: { Authorization: `Bearer ${"b".repeat(64)}` } });
    expect(wrong.status).toBe(401);
    const cookieOnly = await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-06", { headers: { Cookie: `rg_session=${TOKEN}` } });
    expect(cookieOnly.status).toBe(401);
  });

  it("refuses a bad range", async () => {
    for (const query of ["from=2026-10-06&to=2026-10-05", "from=2026-10-01&to=2026-11-15", "from=yesterday&to=2026-10-05", "to=2026-10-05"]) {
      expect((await get(`/api/lifeos/plan?${query}`)).status, query).toBe(400);
    }
  });

  it("lists every day: sessions, rest rows, and nothing planned", async () => {
    await seed("w-1", "2026-10-05");
    await seed("w-rest", "2026-10-06", { category: "rest", title: "Rest" });
    await seed("w-old", "2026-10-07", { archivedAt: nowInstant(), archiveReason: "replaced" });
    await seed("w-moved", "2026-10-07", { originalPlanDate: "2026-10-04", effectiveTime: "", title: "Long run",
      category: "long", sourceEstimatedDurationSeconds: null, fallbackEstimatedDurationSeconds: 5430 });
    const res = await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-08");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { version: number; days: { date: string; rest: boolean; sessions: Record<string, unknown>[] }[] };
    expect(body.version).toBe(1);
    expect(body.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(body.days[0]).toEqual({
      date: "2026-10-05",
      rest: false,
      sessions: [{ id: "w-1", title: "Easy run", sport: "run", category: "easy", time: "18:30", minutes: 40, state: "scheduled", doneAt: null }],
    });
    expect(body.days[1]).toEqual({ date: "2026-10-06", rest: true, sessions: [] });
    expect(body.days[2]!.sessions).toEqual([
      { id: "w-moved", title: "Long run", sport: "run", category: "long", time: null, minutes: 91, state: "scheduled", doneAt: null },
    ]);
    expect(body.days[3]).toEqual({ date: "2026-10-08", rest: false, sessions: [] });
  });

  it("says when a done session's matched activity started, and not for an undone match", async () => {
    await seed("w-done", "2026-10-05", { completionState: "completed" });
    await seed("w-undone", "2026-10-06", { completionState: "unresolved" });
    await db.insert(activities).values([
      { id: "a-1", userId, startTime: "2026-10-06T01:40:00.000Z", sport: "run", durationSeconds: 2500, createdAt: nowInstant(), updatedAt: nowInstant() },
      { id: "a-2", userId, startTime: "2026-10-07T01:40:00.000Z", sport: "run", durationSeconds: 2500, createdAt: nowInstant(), updatedAt: nowInstant() },
    ]);
    await db.insert(workoutCompletionMatches).values([
      { id: "m-1", workoutId: "w-done", activityId: "a-1", confidence: 1, method: "scored_auto", matchedAt: nowInstant() },
      { id: "m-2", workoutId: "w-undone", activityId: "a-2", confidence: 1, method: "manual", matchedAt: nowInstant(), undoneAt: nowInstant() },
    ]);
    const body = (await (await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-06")).json()) as {
      days: { sessions: { id: string; state: string; doneAt: string | null }[] }[];
    };
    expect(body.days[0]!.sessions[0]).toMatchObject({ id: "w-done", state: "completed", doneAt: "2026-10-06T01:40:00.000Z" });
    expect(body.days[1]!.sessions[0]).toMatchObject({ id: "w-undone", state: "unresolved", doneAt: null });
  });

  it("is the owner's plan only", async () => {
    const other = await makeTestUser(db);
    await db.insert(plannedWorkouts).values({
      id: "theirs", userId: other.userId, planId: "p", sourceWorkoutId: "theirs", title: "Tempo", category: "tempo",
      sport: "run", originalPlanDate: "2026-10-05", lastVerifiedCorosDate: "", effectiveDate: "2026-10-05",
      effectiveTime: "07:00", sourceContentFingerprint: "x", calendarBlockDurationSeconds: 1800,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    const body = (await (await get("/api/lifeos/plan?from=2026-10-05&to=2026-10-05")).json()) as { days: { sessions: unknown[] }[] };
    expect(body.days[0]!.sessions).toEqual([]);
    expect(await db.select().from(users)).toHaveLength(2);
  });
});
