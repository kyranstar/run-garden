/**
 * THE HOURLY CLOSES WHAT CAN NEVER MATTER (the owner, 2026-10-19). An open content claim on a session whose story is
 * over — removed, done, missed, skipped, or its day gone — can never be acted on, so the hourly closes it as moot
 * (`closeMootContentClaims`), with its reason on the intent, and they stop piling up. Data-safe: it writes the intents
 * and nothing else, a bounded number a pass. And a claim closed so still holds the session's content: the Plan reads a
 * past session's stages as the app's, as it did, and the import never hands it back to COROS's snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, todayInZone, type CoachSession, type UserPreferences } from "@rg/domain";
import { normalizeCorosSchedule } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { hourly } from "../src/index.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { MOOT_CONTENT_CLAIMS_PER_PASS } from "../src/services/cron-limits.js";
import { closeContentClaims, recordIntent, resolveIntent } from "../src/services/sync-intents.js";
import { closeMootContentClaims } from "../src/services/watch-version.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
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
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Db;
let counting = false;
let written: string[] = [];
let statements = 0;
let userId: string;
let prefs: UserPreferences;
let today: string;

beforeEach(async () => {
  counting = false;
  written = [];
  statements = 0;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      if (!counting) return;
      statements += 1;
      if (isWrite(sql)) written.push(sql);
    },
  });
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  prefs = user.prefs;
  today = todayInZone(prefs.timezone);
});

async function session(o: { date: string; completionState?: string; archived?: boolean; sport?: string; stages?: "distance" }): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    sourceIdInPlan: "7",
    title: "Easy 5k",
    category: "easy",
    sport: o.sport ?? "run",
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "0123456789abcdef",
    calendarBlockDurationSeconds: 2400,
    completionState: o.completionState ?? "scheduled",
    ...(o.archived ? { archivedAt: nowInstant(), archiveReason: "user_removed" } : {}),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  if (o.stages === "distance") {
    await db.insert(schema.plannedWorkoutStages).values({
      id: `${id}-s0`,
      workoutId: id,
      ord: 0,
      kind: "work",
      durationType: "distance",
      distanceMeters: 5000,
      label: "easy",
    } as typeof schema.plannedWorkoutStages.$inferInsert);
  }
  return id;
}

async function claim(workoutId: string, payload?: Record<string, unknown>): Promise<string> {
  return recordIntent(db, {
    userId,
    targetKind: "workout",
    targetId: workoutId,
    kind: "content",
    source: "coach_ease",
    ...(payload ? { payload } : {}),
  });
}

const intentOf = async (id: string) =>
  (await db.select().from(schema.syncIntents).where(eq(schema.syncIntents.id, id)))[0]!;

describe("closeMootContentClaims", () => {
  it("closes, with its reason, every claim on a session that is over — and none on one still to run", async () => {
    const cases = {
      past: await claim(await session({ date: addDays(today, -2) }), { fingerprint: "abc" }),
      missed: await claim(await session({ date: addDays(today, -9), completionState: "missed" })),
      completed: await claim(await session({ date: today, completionState: "completed" })),
      skipped: await claim(await session({ date: addDays(today, 3), completionState: "skipped" })),
      archived: await claim(await session({ date: addDays(today, 5), archived: true })),
    };
    const todays = await claim(await session({ date: today }));
    const ahead = await claim(await session({ date: addDays(today, 4) }));

    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(5);
    for (const [because, id] of Object.entries(cases)) {
      const intent = await intentOf(id);
      expect(intent.resolvedAt, because).toBeTruthy();
      expect(intent.payload?.["closedBecause"], because).toBe(because);
    }
    // What the payload held stays.
    expect((await intentOf(cases.past)).payload?.["fingerprint"]).toBe("abc");
    for (const id of [todays, ahead]) expect((await intentOf(id)).resolvedAt).toBeNull();
    // Idempotent: nothing left to close.
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(0);
  });

  it("writes the intents and nothing else, in at most one read and five writes — and leaves another account's alone", async () => {
    for (const state of ["missed", "completed", "skipped", "scheduled"]) {
      for (let i = 0; i < 3; i++) await claim(await session({ date: addDays(today, -3 - i), completionState: state }));
    }
    await claim(await session({ date: addDays(today, 2), archived: true }));
    const other = await makeTestUser(db, {});
    const theirs = newId();
    await db.insert(schema.syncIntents).values({
      id: theirs, userId: other.userId, targetKind: "workout", targetId: "elsewhere", kind: "content", source: "coach_ease", createdAt: nowInstant(),
    });
    const before = await db.select().from(schema.plannedWorkouts);
    counting = true;
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(13);
    counting = false;
    expect(statements).toBeLessThanOrEqual(6);
    expect(written.length).toBeGreaterThan(0);
    for (const sql of written) expect(sql).toMatch(/^\s*update "sync_intents"/i);
    expect(await db.select().from(schema.plannedWorkouts), "no session written").toEqual(before);
    expect(await db.select().from(schema.corosWriteJobs)).toEqual([]);
    expect((await intentOf(theirs)).resolvedAt).toBeNull();
  });

  it("closes at most MOOT_CONTENT_CLAIMS_PER_PASS a pass, oldest first; the next pass closes the rest", async () => {
    const extra = 5;
    for (let i = 0; i < MOOT_CONTENT_CLAIMS_PER_PASS + extra; i++) await claim(await session({ date: addDays(today, -1 - i) }));
    counting = true;
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(MOOT_CONTENT_CLAIMS_PER_PASS);
    counting = false;
    expect(statements).toBe(2);
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(extra);
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(0);
  });

  it("a past session keeps its stages read as the app's — the Plan shows it as it did before the close", async () => {
    // An imported run the app rewrote into a distance: its coverage is read off the app's own stages (an open claim
    // makes them the app's). Closing the claim as moot must not flip the past session to COROS's copy.
    const id = await session({ date: addDays(today, -4), completionState: "missed", stages: "distance" });
    await claim(id);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const coverage = async () => {
      const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}`, { headers: { Cookie: cookie } }, makeEnv());
      expect(res.status).toBe(200);
      return ((await res.json()) as { workout: { watchCoverage?: unknown } }).workout.watchCoverage;
    };
    const before = await coverage();
    expect(before, "the app's own distance run is disclosed").toBeDefined();
    await closeMootContentClaims(db, userId, today, nowInstant());
    expect(await coverage()).toEqual(before);
  });
});

describe("closeContentClaims", () => {
  it("closes only a claim still open: one a verified rewrite closed meanwhile stays a convergence", async () => {
    const converged = await claim(await session({ date: addDays(today, -1) }));
    await resolveIntent(db, converged, "2026-10-01T00:00:00.000Z");
    await closeContentClaims(db, userId, [converged], "past", nowInstant());
    const intent = await intentOf(converged);
    expect(intent.resolvedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(intent.payload?.["closedBecause"]).toBeUndefined();
  });
});

describe("the hourly runs it", () => {
  it("closes a past session's claim, and says how many on its run row", async () => {
    const past = await claim(await session({ date: addDays(today, -6), completionState: "missed" }));
    const ahead = await claim(await session({ date: addDays(today, 6) }));
    await hourly(db, makeEnv());
    expect((await intentOf(past)).payload?.["closedBecause"]).toBe("missed");
    expect((await intentOf(ahead)).resolvedAt).toBeNull();
    const [run] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.userId, userId), eq(schema.syncRuns.kind, "reconcile")))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1);
    expect(run!.status).toBe("ok");
    expect((run!.stats as { mootClaims?: number }).mootClaims).toBe(1);
  });
});

describe("a claim closed as moot still holds the session's content against the import", () => {
  it("an edit made on COROS afterwards never rewrites the app's copy of a session the athlete skipped", async () => {
    const server = mockCorosServer();
    const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
    expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
    const readAndImport = async () => {
      const normalized = normalizeCorosSchedule(server.state.schedule);
      await importPlanSnapshot(
        db,
        {
          userId,
          plan: {
            sourcePlanId: normalized.planId,
            name: normalized.planName,
            ...(normalized.planStart ? { startDate: normalized.planStart } : {}),
            ...(normalized.planEnd ? { endDate: normalized.planEnd } : {}),
          },
          workouts: normalized.workouts,
          rangeStart: addDays(today, -40),
          rangeEnd: addDays(today, 80),
          source: "fixture",
        },
        prefs,
      );
    };
    await readAndImport();
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
    const eased: CoachSession = {
      category: "easy",
      title: "Easy, legs heavy",
      durationMinutes: 35,
      run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
    } as unknown as CoachSession;
    const out = await applyOps(db, userId, prefs, "p-ease-sweep", [coachOpSchema.parse({ kind: "ease", workoutId: row!.id, session: eased })]);
    expect(out.missed).toEqual([]);
    await db.update(schema.plannedWorkouts).set({ completionState: "skipped" }).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(await closeMootContentClaims(db, userId, today, nowInstant())).toBe(1);

    // The athlete edits that session on COROS: its content upstream changes.
    const job = (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, row!.id)))[0]!;
    const program = server.programByIdInPlan((job.payload as { idInPlan: string }).idInPlan)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: 6421 }];
    await readAndImport();

    const [after] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, row!.id));
    expect(after!.title, "the app's copy stays the app's").toBe("Easy, legs heavy");
    expect(after!.completionState).toBe("skipped");
  });
});
