/**
 * The parity harness (Phase 0 Task 12): admin endpoints a staging rehearsal
 * uses to prove a migration changed nothing it should not have. They answer
 * with HASHES, COUNTS AND DATES ONLY — a rehearsal's output is pasted into
 * notes and chats, so it must never carry a title, a note, an email or a
 * token. Every table hash orders rows by primary key and hashes canonical
 * JSON (Ruling R2), through the same helpers the export and the copier use.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { AppContext } from "../src/auth/middleware.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { sha256Hex } from "../src/auth/crypto.js";
import type { Db } from "../src/services/db.js";
import { ACCOUNT_TABLES, canonicalJson, orderedRows } from "../src/services/account-tables.js";
import { patchAccountState } from "../src/services/account-state.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { calendarHash, gardenHash, jobCounts, ParityRefused, tableHashes } from "../src/services/parity.js";
import { adminRoutes, allowedDtoPath } from "../src/routes/admin.js";
import { planRoutes } from "../src/routes/plan.js";
import { gardenRoutes } from "../src/routes/garden.js";
import { coachRoutes } from "../src/routes/coach.js";
import { insightRoutes } from "../src/routes/misc.js";
import worker from "../src/index.js";
import { seedFullAccount } from "./account-fixture.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const STAMP = "2026-01-01T00:00:00Z";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  };
}

/** The app's own read routes, on the test db — what the DTO endpoint calls
 * in-process (index.ts hands it the real app). */
function appRoutes(db: Db): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/plan", planRoutes);
  app.route("/api/garden", gardenRoutes);
  app.route("/api/coach", coachRoutes);
  app.route("/api/insights", insightRoutes);
  return app;
}

function adminApp(db: Db): Hono<AppContext> {
  const inner = appRoutes(db);
  return mountRoutes(db, "/api/admin", adminRoutes((req, env, ctx) => inner.fetch(req, env, ctx)));
}

async function call(
  db: Db,
  env: Env,
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Cookie = `${SESSION_COOKIE}=${opts.token}`;
  return adminApp(db).request(
    path,
    { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    env,
  );
}

async function insertWorkout(db: Db, userId: string, date: string, state = "scheduled"): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    title: "Session",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: state,
    resolutionDate: state !== "scheduled" ? date : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

async function matchActivity(db: Db, userId: string, workoutId: string, date: string): Promise<void> {
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T07:30:00Z`,
    startTimeLocal: `${date}T07:30:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000,
    sourceMergeConfidence: 1,
    completionMatchId: `m-${activityId}`,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: `m-${activityId}`,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
}

/** A real, 20-day-old garden with a few completed runs, simulated through
 * `now` (frozen so every call sees the same today). */
async function seedGarden(db: Db) {
  const { userId, prefs } = await makeTestUser(db);
  const genesis = addDays(todayInZone(prefs.timezone), -20);
  const now = new Date(`${addDays(genesis, 20)}T12:00:00Z`);
  await ensureGarden(db, userId, prefs, genesis);
  for (const offset of [2, 5, 9, 13]) {
    const date = addDays(genesis, offset);
    const w = await insertWorkout(db, userId, date, "completed");
    await matchActivity(db, userId, w, date);
  }
  await insertWorkout(db, userId, addDays(genesis, 7), "missed");
  const sim = await advanceGarden(db, userId, prefs, now);
  expect(sim.simulatedDays).toBeGreaterThan(15);
  return { userId, prefs, now };
}

/** Every string value in this account's rows (JSON values included) that the
 * fixture tagged — the "content" no response may carry. */
async function seededStrings(db: Db, userId: string): Promise<string[]> {
  const tag = userId.slice(0, 8);
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes(tag) && value !== userId) out.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const t of ACCOUNT_TABLES) {
    if (t.scope.kind === "excluded") continue;
    for (const row of await orderedRows(db, t.table, { userId })) walk(row);
  }
  return [...out];
}

describe("tableHashes", () => {
  it("covers every account table, is stable across calls, and leaves out tables no account owns", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);

    const first = await tableHashes(db, userId);
    const second = await tableHashes(db, userId);
    expect(second).toEqual(first);

    const owned = ACCOUNT_TABLES.filter((t) => t.scope.kind !== "excluded").map((t) => t.name);
    expect(Object.keys(first).sort()).toEqual([...owned].sort());
    expect(first.planned_workouts!.rows).toBeGreaterThan(100);
    for (const { sha256 } of Object.values(first)) expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("one changed planned-workout title changes planned_workouts and nothing else", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const before = await tableHashes(db, userId);

    const [one] = await orderedRows(db, schema.plannedWorkouts, { userId, limit: 1 });
    await db
      .update(schema.plannedWorkouts)
      .set({ title: "A different title" })
      .where(eq(schema.plannedWorkouts.id, String(one!.id)));
    const after = await tableHashes(db, userId);

    const changed = Object.keys(before).filter((name) => before[name]!.sha256 !== after[name]!.sha256);
    expect(changed).toEqual(["planned_workouts"]);
    expect(after.planned_workouts!.rows).toBe(before.planned_workouts!.rows);
  });

  it("reads only this account, and hashes provider tokens as null (a scrubbed staging copy matches)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, me);
    await seedFullAccount(db, other);
    const before = await tableHashes(db, me);

    await db.update(schema.plannedWorkouts).set({ title: "changed" }).where(eq(schema.plannedWorkouts.userId, other));
    await db
      .update(schema.providerConnections)
      .set({ encryptedAccessToken: null, encryptedRefreshToken: null })
      .where(eq(schema.providerConnections.userId, me));

    expect(await tableHashes(db, me)).toEqual(before);
  });
});

describe("gardenHash", () => {
  it("a from-genesis resim reproduces the garden, and a second resim hashes the same (determinism)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs, now } = await seedGarden(db);

    const stored = await gardenHash(db, userId, prefs, { resim: false, now });
    const first = await gardenHash(db, userId, prefs, { resim: true, now });
    const second = await gardenHash(db, userId, prefs, { resim: true, now });

    expect(second).toEqual(first);
    expect(first).toEqual(stored);
    expect(first.snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(first.events).toMatch(/^[0-9a-f]{64}$/);
    expect(first.eventRows).toBeGreaterThan(0);
    expect(first.lastSimulatedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("a resim from a later date replays from the checkpoint before it and lands on the same hashes", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs, now } = await seedGarden(db);
    const stored = await gardenHash(db, userId, prefs, { resim: false, now });
    const from = addDays(stored.lastSimulatedDate!, -6);
    expect(await gardenHash(db, userId, prefs, { resim: true, from, now })).toEqual(stored);
  });

  it("the hash sees a changed garden", async () => {
    const db = makeTestDb();
    const { userId, prefs, now } = await seedGarden(db);
    const before = await gardenHash(db, userId, prefs, { resim: false, now });
    await db
      .update(schema.gardenEvents)
      .set({ detail: "edited" })
      .where(eq(schema.gardenEvents.userId, userId));
    const after = await gardenHash(db, userId, prefs, { resim: false, now });
    expect(after.events).not.toBe(before.events);
    expect(after.snapshot).toBe(before.snapshot);
  });

  it("without resim it writes nothing", async () => {
    const statements: string[] = [];
    const db = makeTestDb({ onStatement: (s) => statements.push(s) });
    const { userId, prefs, now } = await seedGarden(db);
    statements.length = 0;
    await gardenHash(db, userId, prefs, { resim: false, now });
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("refuses to resimulate a garden a restore is replacing or still catching up — never the catch-up path", async () => {
    const db = makeTestDb();
    const { userId, prefs, now } = await seedGarden(db);
    await patchAccountState(db, userId, { gardenCatchUpPending: true });
    await expect(gardenHash(db, userId, prefs, { resim: true, now })).rejects.toBeInstanceOf(ParityRefused);
    await patchAccountState(db, userId, { gardenCatchUpPending: false, restoreId: "r1" });
    await expect(gardenHash(db, userId, prefs, { resim: true, now })).rejects.toBeInstanceOf(ParityRefused);
    // Hashing what is stored is still fine.
    expect((await gardenHash(db, userId, prefs, { resim: false, now })).snapshot).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("calendarHash", () => {
  it("changes with a link's fingerprint and with the suppressions, and not with write stamps", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = await insertWorkout(db, userId, "2026-01-05");
    await db.insert(schema.calendarEventLinks).values({
      id: "link-1",
      workoutId,
      calendarId: "primary",
      eventId: "evt-1",
      lastWrittenFingerprint: "fp-1",
      lastWrittenAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    const base = await calendarHash(db, userId);
    expect(await calendarHash(db, userId)).toEqual(base);
    expect(base.linkRows).toBe(1);
    expect(base.suppressionRows).toBe(0);

    await db
      .update(schema.calendarEventLinks)
      .set({ lastWrittenAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" })
      .where(eq(schema.calendarEventLinks.id, "link-1"));
    expect(await calendarHash(db, userId)).toEqual(base);

    await db
      .update(schema.calendarEventLinks)
      .set({ lastWrittenFingerprint: "fp-2" })
      .where(eq(schema.calendarEventLinks.id, "link-1"));
    const refingered = await calendarHash(db, userId);
    expect(refingered.links).not.toBe(base.links);
    expect(refingered.suppressions).toBe(base.suppressions);

    await db.insert(schema.calendarEventSuppressions).values({
      id: "sup-1",
      workoutId,
      eventId: "evt-0",
      reason: "user_deleted",
      createdAt: STAMP,
    });
    const suppressed = await calendarHash(db, userId);
    expect(suppressed.suppressions).not.toBe(refingered.suppressions);
    expect(suppressed.links).toBe(refingered.links);
    expect(suppressed.suppressionRows).toBe(1);
  });
});

describe("jobCounts", () => {
  it("counts this account's watch-write jobs by kind and status since a date", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    const job = (userId: string, kind: string, status: string, requestedAt: string) => ({
      id: newId(),
      userId,
      workoutId: "w",
      kind,
      expectedContentFingerprint: "fp",
      originalDate: "2026-01-05",
      destinationDate: "2026-01-06",
      requestedAt,
      status,
      updatedAt: requestedAt,
    });
    await db.insert(schema.corosWriteJobs).values([
      job(userId, "move_scheduled_workout", "verified", "2026-03-02T10:00:00.000Z"),
      job(userId, "move_scheduled_workout", "verified", "2026-03-05T10:00:00.000Z"),
      job(userId, "move_scheduled_workout", "failed", "2026-03-05T11:00:00.000Z"),
      job(userId, "delete_scheduled_workout", "queued", "2026-03-06T10:00:00.000Z"),
      job(userId, "move_scheduled_workout", "verified", "2026-02-20T10:00:00.000Z"),
      job(other, "move_scheduled_workout", "verified", "2026-03-05T10:00:00.000Z"),
    ]);
    expect(await jobCounts(db, userId, "2026-03-01")).toEqual({
      "delete_scheduled_workout:queued": 1,
      "move_scheduled_workout:failed": 1,
      "move_scheduled_workout:verified": 2,
    });
    expect(await jobCounts(db, userId, "2026-04-01")).toEqual({});
  });
});

describe("the DTO allowlist", () => {
  it("allows the app's read DTOs with their own query parameters, normalised", () => {
    expect(allowedDtoPath("/api/plan/today")).toBe("/api/plan/today");
    expect(allowedDtoPath("/api/plan/week?week=2026-09-28")).toBe("/api/plan/week?start=2026-09-28");
    expect(allowedDtoPath("/api/plan/week?start=2026-09-28")).toBe("/api/plan/week?start=2026-09-28");
    expect(allowedDtoPath("/api/plan/workouts?start=2026-09-01&end=2026-10-01")).toBe(
      "/api/plan/workouts?start=2026-09-01&end=2026-10-01",
    );
    expect(allowedDtoPath("/api/garden")).toBe("/api/garden");
    expect(allowedDtoPath("/api/coach/plans")).toBe("/api/coach/plans");
    expect(allowedDtoPath("/api/coach/state")).toBe("/api/coach/state");
    expect(allowedDtoPath("/api/insights?discipline=strength")).toBe("/api/insights?discipline=strength");
  });

  it("refuses everything else: other paths, other methods' routes, foreign hosts, odd parameters", () => {
    for (const bad of [
      "/api/settings/export/manifest",
      "/api/settings",
      "/api/admin/parity/tables",
      "/api/admin/parity/dto?paths=/api/garden",
      "/api/plan/../settings",
      "/api/plan/%74oday",
      "https://evil.test/api/garden",
      "//evil.test/api/garden",
      "api/garden",
      "/api/garden?x=1",
      "/api/garden#frag",
      "/api/plan/week?week=monday",
      "/api/plan/week?week=2026-09-28&week=2026-10-05",
      "/api/insights?discipline=../../x",
      "/api/plan/workouts/abc",
    ]) {
      expect(allowedDtoPath(bad), bad).toBeNull();
    }
  });
});

describe("/api/admin/parity routes", () => {
  it("404 when neither STAGING nor PARITY_ENABLED is set — signed in or not", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const token = await createSession(db, userId, "test");
    for (const [method, path] of [
      ["GET", "/api/admin/parity/tables"],
      ["POST", "/api/admin/parity/garden"],
      ["GET", "/api/admin/parity/calendar"],
      ["GET", "/api/admin/parity/jobs?since=2026-01-01"],
      ["GET", "/api/admin/parity/dto?paths=/api/garden"],
    ] as const) {
      for (const env of [makeEnv(), makeEnv({ STAGING: "0", PARITY_ENABLED: "0" })]) {
        const signedIn = await call(db, env, path, { token, method, body: method === "POST" ? { resim: false } : undefined });
        expect(signedIn.status, `${method} ${path}`).toBe(404);
        const anonymous = await call(db, env, path, { method, body: method === "POST" ? { resim: false } : undefined });
        expect(anonymous.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("is mounted on the real app: 404 when off, behind sign-in when on", async () => {
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const get = (env: Env) => worker.fetch(new Request("https://app.test/api/admin/parity/tables"), env, ctx);
    expect((await get(makeEnv())).status).toBe(404);
    expect((await get(makeEnv({ PARITY_ENABLED: "1" }))).status).toBe(401);
  });

  it("needs a signed-in user when enabled", async () => {
    const db = makeTestDb();
    const res = await call(db, makeEnv({ PARITY_ENABLED: "1" }), "/api/admin/parity/tables");
    expect(res.status).toBe(401);
  });

  it("with PARITY_ENABLED (production) hashes without resimulating, and refuses a resim", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await seedGarden(db);
    const token = await createSession(db, userId, "test");
    const env = makeEnv({ PARITY_ENABLED: "1" });

    const refused = await call(db, env, "/api/admin/parity/garden", { token, method: "POST", body: { resim: true } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "resim_staging_only" });

    const hashed = await call(db, env, "/api/admin/parity/garden", { token, method: "POST", body: { resim: false } });
    expect(hashed.status).toBe(200);
    expect(await hashed.json()).toEqual({ ...(await gardenHash(db, userId, prefs, { resim: false })), resimPending: false });
  });

  it("on staging resimulates through the ordinary path, and refuses while a restore catch-up is pending", async () => {
    const db = makeTestDb();
    const { userId } = await seedGarden(db);
    const token = await createSession(db, userId, "test");
    const env = makeEnv({ STAGING: "1" });

    const res = await call(db, env, "/api/admin/parity/garden", { token, method: "POST", body: { resim: true } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["eventRows", "events", "lastSimulatedDate", "resimPending", "snapshot"]);

    const badFrom = await call(db, env, "/api/admin/parity/garden", {
      token,
      method: "POST",
      body: { resim: true, from: "last tuesday" },
    });
    expect(badFrom.status).toBe(400);

    await patchAccountState(db, userId, { gardenCatchUpPending: true });
    const pending = await call(db, env, "/api/admin/parity/garden", { token, method: "POST", body: { resim: true } });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: "garden_catch_up_pending" });
  });

  it("jobs needs a date", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const token = await createSession(db, userId, "test");
    const env = makeEnv({ PARITY_ENABLED: "1" });
    expect((await call(db, env, "/api/admin/parity/jobs", { token })).status).toBe(400);
    expect((await call(db, env, "/api/admin/parity/jobs?since=soon", { token })).status).toBe(400);
    const ok = await call(db, env, "/api/admin/parity/jobs?since=2026-01-01", { token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ since: "2026-01-01", counts: {} });
  });

  it("hashes DTOs by calling the app's own handlers with the caller's session", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await seedGarden(db);
    const token = await createSession(db, userId, "test");
    const env = makeEnv({ STAGING: "1" });
    const monday = startOfIsoWeek(todayInZone(prefs.timezone));
    const week = `/api/plan/week?week=${monday}`;

    const res = await call(db, env, `/api/admin/parity/dto?paths=${encodeURIComponent(week)}&paths=/api/coach/plans`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { status: number; sha256: string }>;
    const normalised = `/api/plan/week?start=${monday}`;
    expect(Object.keys(body).sort()).toEqual(["/api/coach/plans", normalised]);

    // The same bytes a signed-in browser gets, hashed canonically.
    const direct = await appRoutes(db).request(normalised, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, env);
    expect(direct.status).toBe(200);
    expect(body[normalised]).toEqual({ status: 200, sha256: await sha256Hex(canonicalJson(await direct.json())) });
    expect(body["/api/coach/plans"]!.status).toBe(200);

    const refused = await call(db, env, "/api/admin/parity/dto?paths=/api/settings", { token });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "path_not_allowed", index: 0 });
    expect((await call(db, env, "/api/admin/parity/dto", { token })).status).toBe(400);
  });

  it("no response carries any of the account's content — only hashes, counts and dates", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    // Job kinds and statuses ARE reported (as "<kind>:<status>" counts) — they
    // are enumerations in real data, so give the fixture's rows real ones.
    await db
      .update(schema.corosWriteJobs)
      .set({ kind: "move_scheduled_workout", status: "verified", requestedAt: "2026-03-02T10:00:00.000Z" })
      .where(eq(schema.corosWriteJobs.userId, userId));
    const content = await seededStrings(db, userId);
    expect(content.length).toBeGreaterThan(100);
    const token = await createSession(db, userId, "test");
    const monday = startOfIsoWeek(todayInZone(prefs.timezone));
    const paths = [
      "/api/plan/today",
      `/api/plan/week?week=${monday}`,
      "/api/plan/workouts",
      "/api/garden",
      "/api/coach/plans",
      "/api/coach/state",
      "/api/insights?discipline=run",
    ];

    // The fixture's synthetic values are not valid dates, so some DTO
    // handlers fail on them (500); their error bodies are hashed like any
    // other. Keep the expected stack traces out of the test output.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses: unknown[] = [];
    for (const env of [makeEnv({ PARITY_ENABLED: "1" }), makeEnv({ STAGING: "1" })]) {
      for (const [method, path, body] of [
        ["GET", "/api/admin/parity/tables", undefined],
        ["POST", "/api/admin/parity/garden", { resim: false }],
        ["GET", "/api/admin/parity/calendar", undefined],
        ["GET", "/api/admin/parity/jobs?since=2026-01-01", undefined],
        ["GET", `/api/admin/parity/dto?${paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&")}`, undefined],
      ] as const) {
        const res = await call(db, env, path, { token, method, body });
        expect(res.status, path).toBe(200);
        responses.push(await res.json());
      }
    }
    quiet.mockRestore();
    const text = JSON.stringify(responses);
    const leaked = content.filter((s) => text.includes(s));
    expect(leaked).toEqual([]);
    expect(text).not.toContain(userId);
    // And the job counts did come through.
    expect(text).toContain("move_scheduled_workout:verified");
  });
});

describe("tableHashes reads through the export's own scoping", () => {
  it("a child row whose parent belongs to another account is not counted", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    const theirs = await insertWorkout(db, other, "2026-01-05");
    await db.insert(schema.calendarEventSuppressions).values({
      id: "sup-theirs",
      workoutId: theirs,
      eventId: "evt",
      reason: "user_deleted",
      createdAt: STAMP,
    });
    const mine = await tableHashes(db, me);
    expect(mine.calendar_event_suppressions!.rows).toBe(0);
    const rows = await db
      .select()
      .from(schema.calendarEventSuppressions)
      .where(and(eq(schema.calendarEventSuppressions.workoutId, theirs)));
    expect(rows).toHaveLength(1);
  });
});
