/**
 * "YOUR WATCH HAS AN EARLIER VERSION" COUNTS ONLY WHAT IS STILL TO RUN — the owner, 2026-10-19: "It's always there
 * and annoying and not actionable or removable." The line counted three sessions weeks past and missed — a mobility
 * session and a programme's two strength sessions, each with a rewrite that had failed — for ever: the count dropped
 * only completed sessions. Now the account line (`computeSyncStatus`, `GET /api/sync/status`) and the row's
 * "Older on watch" (`content_stale`, `routes/plan.ts`) consider a divergence only on a session in the plan, not done,
 * missed or skipped, its day today or later — and not while a write for it is on its way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { recordIntent } from "../src/services/sync-intents.js";
import { computeSyncStatus } from "../src/services/sync-status.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

/** `GET /api/sync/status` on an account with a COROS connection and no studio plan, measured on e7fc4a6. */
const STATUS_STATEMENTS = 12;

let db: Db;
/** Statements the app runs while `counting` (the cost pin). */
let counting = false;
let statements = 0;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let today: string;

beforeEach(async () => {
  counting = false;
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (counting && statements++) });
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  prefs = user.prefs;
  await connectTestCoros(db, userId);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  today = todayInZone(prefs.timezone);
});

/** A session COROS holds on its day (an imported one unless `origin` says the app built it). */
async function session(o: {
  date: string;
  title?: string;
  category?: string;
  sport?: string;
  completionState?: string;
  origin?: string;
  archived?: boolean;
  corosSyncState?: string;
}): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    sourceIdInPlan: "7",
    title: o.title ?? "Easy 40",
    category: o.category ?? "easy",
    sport: o.sport ?? "run",
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "0123456789abcdef",
    calendarBlockDurationSeconds: 2400,
    completionState: o.completionState ?? "scheduled",
    corosSyncState: o.corosSyncState ?? "calendar_only",
    ...(o.origin ? { origin: o.origin } : {}),
    ...(o.archived ? { archivedAt: nowInstant(), archiveReason: "user_removed" } : {}),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** The app's open claim on its content: an approved change the watch has not been given. */
async function claim(workoutId: string): Promise<void> {
  await recordIntent(db, { userId, targetKind: "workout", targetId: workoutId, kind: "content", source: "coach_ease" });
}

/** A rewrite of it, in this status. */
async function rewrite(workoutId: string, status: string): Promise<void> {
  await db.insert(schema.corosWriteJobs).values({
    id: `${workoutId}-content-${status}`,
    userId,
    workoutId,
    kind: "coach_update_workout",
    status,
    expectedContentFingerprint: "0123456789abcdef",
    originalDate: today,
    destinationDate: today,
    requestedAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function views(): Promise<Map<string, string>> {
  const res = await mountRoutes(db, "/api/plan", planRoutes).request(
    `/api/plan/workouts?start=${addDays(today, -40)}`,
    { headers: { Cookie: cookie } },
    makeEnv(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { workouts: Array<{ id: string; corosSyncView: string }> };
  return new Map(body.workouts.map((w) => [w.id, w.corosSyncView]));
}

describe("what the account line counts", () => {
  it("never a past, missed session — a mobility one, or a programme's two strength ones whose rewrites failed", async () => {
    // The owner's three, in shape (no names): weeks gone, missed, each with an open claim, a terminally failed
    // rewrite, and a stored sync state of `sync_issue`.
    const ids = [
      await session({ date: addDays(today, -27), title: "Mobility flow", category: "mobility", sport: "yoga", completionState: "missed", corosSyncState: "sync_issue" }),
      await session({ date: addDays(today, -26), title: "Strength A", category: "strength", sport: "strength", completionState: "missed", origin: "program", corosSyncState: "sync_issue" }),
      await session({ date: addDays(today, -19), title: "Strength B", category: "strength", sport: "strength", completionState: "missed", origin: "program", corosSyncState: "sync_issue" }),
    ];
    for (const id of ids) {
      await claim(id);
      await rewrite(id, "failed");
    }

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.contentStaleCount).toBe(0);
    expect(status.contentStaleSessions).toEqual([]);
    expect(status.issueCount, "a past session's failed rewrite is not an issue either").toBe(0);
    const v = await views();
    for (const id of ids) expect(v.get(id), "no 'Older on watch' on a session that is over").not.toBe("content_stale");
  });

  it("a session ahead, and today's; never one done, skipped or removed — soonest first, as the athlete reads it", async () => {
    const ahead = await session({ date: addDays(today, 3), title: "4P1", category: "quality", sport: "run" });
    const todays = await session({ date: today, title: "Tempo 30" });
    const doneToday = await session({ date: today, title: "Done one", completionState: "completed" });
    const skipped = await session({ date: addDays(today, 2), title: "Skipped one", completionState: "skipped" });
    const removed = await session({ date: addDays(today, 4), title: "Removed one", archived: true });
    for (const id of [ahead, todays, doneToday, skipped, removed]) await claim(id);

    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.contentStaleCount).toBe(2);
    expect(status.contentStaleSessions).toEqual([
      { workoutId: todays, date: today, title: "Tempo 30" },
      // A code-like COROS title reads as its kind, as every other surface says it.
      { workoutId: ahead, date: addDays(today, 3), title: "Quality" },
    ]);
    const v = await views();
    expect(v.get(ahead)).toBe("content_stale");
    expect(v.get(todays)).toBe("content_stale");
    expect(v.get(doneToday)).not.toBe("content_stale");
    expect(v.get(skipped)).not.toBe("content_stale");
  });

  it("never one whose day has gone, answered or not; today's still counts, answered or not", async () => {
    const yesterday = await session({ date: addDays(today, -1) });
    const unanswered = await session({ date: addDays(today, -3), completionState: "unresolved" });
    const todayUnanswered = await session({ date: today, completionState: "unresolved" });
    for (const id of [yesterday, unanswered, todayUnanswered]) await claim(id);
    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.contentStaleSessions.map((s) => s.workoutId)).toEqual([todayUnanswered]);
    const v = await views();
    expect(v.get(yesterday)).not.toBe("content_stale");
    expect(v.get(unanswered)).not.toBe("content_stale");
    expect(v.get(todayUnanswered)).toBe("content_stale");
  });

  it("names a session once, however many open claims it carries", async () => {
    const ahead = await session({ date: addDays(today, 2) });
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.syncIntents).values({
        id: newId(), userId, targetKind: "workout", targetId: ahead, kind: "content", source: "coach_ease", createdAt: nowInstant(),
      });
    }
    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.contentStaleCount).toBe(1);
    expect(status.contentStaleSessions.map((s) => s.workoutId)).toEqual([ahead]);
  });

  it("not while a write for it is on its way — that is 'sending', which the row says", async () => {
    const ahead = await session({ date: addDays(today, 5) });
    await claim(ahead);
    await rewrite(ahead, "queued");
    const status = await computeSyncStatus(db, userId, prefs);
    expect(status.contentStaleCount).toBe(0);
    expect((await views()).get(ahead)).toBe("syncing");

    // …and back once that write has failed: the divergence is real again, and the failure is an issue.
    await db.delete(schema.corosWriteJobs);
    await rewrite(ahead, "failed");
    const again = await computeSyncStatus(db, userId, prefs);
    expect(again.contentStaleCount).toBe(1);
    expect(again.issueCount).toBe(1);
  });

  it("says the same over GET /api/sync/status, in the same statements as before", async () => {
    const ahead = await session({ date: addDays(today, 1), title: "Hills 6x1" });
    await claim(ahead);
    await claim(await session({ date: addDays(today, -3), completionState: "missed" }));
    const app = mountRoutes(db, "/api/sync", syncRoutes);
    counting = true;
    const res = await app.request("/api/sync/status", { headers: { Cookie: cookie } }, makeEnv());
    counting = false;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentStaleCount: number; contentStaleSessions: unknown };
    expect(body.contentStaleCount).toBe(1);
    expect(body.contentStaleSessions).toEqual([{ workoutId: ahead, date: addDays(today, 1), title: "Hills 6x1" }]);
    // Polled every 30 s: the list is the count's own read (its columns and a NOT EXISTS), no statement more than the
    // count alone took (measured on e7fc4a6: STATUS_STATEMENTS).
    expect(statements).toBe(STATUS_STATEMENTS);
  });
});
