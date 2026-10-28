/**
 * THE HOT READS NEVER CARRY THE WORKOUT DOCUMENT, AND A BAD ONE BREAKS NOTHING (Stage 1 Task 11; controller ruling
 * 2026-10-10).
 *
 * `workout_doc` is plain JSON text (Drizzle's json mode parsed it on every full-row read and threw on a malformed
 * value). The reads that never need it — the Plan page's today, the hourly import's planned rows, the coach's dossier
 * — leave it out of their SQL, and a row whose document is malformed JSON breaks none of them. Synthetic fixtures
 * only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, parseStoredWorkoutDoc, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
import type { SourcePlannedWorkout } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { hourly } from "../src/index.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { buildDayInput } from "../src/services/garden-sync.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { buildDossier } from "../src/services/coach-context.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";

const { plannedWorkouts } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let statements: string[];

/**
 * A select that reads the document's BYTES: the column selected, or json_extract'ed (a write that names it — the import's
 * own revisions — is not a read). Its `"workout_doc" is not null` flag (the Plan's and Today's `hasDoc`, routes/plan.ts
 * `planRowColumns`) yields an integer and materialises nothing, so it is not one (workout editability, final review).
 */
const readsDoc = (q: string) => /^\s*select\b/i.test(q) && /"workout_doc"(?!\s+is\s+not\s+null\b)/i.test(q);

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  // Three rows: today's and tomorrow's with a document that is not JSON at all, yesterday's done with a valid one.
  const row = (id: string, date: string, workoutDoc: string, completionState = "scheduled") => ({
    id, userId, planId: "plan-1", sourceWorkoutId: `plan-1:${id}`, sourceIdInPlan: id, title: "Easy 30", category: "easy",
    sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00",
    completionState, sourceContentFingerprint: `fp-${id}`, calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
    workoutDoc, workoutDocRev: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const valid = JSON.stringify({ version: 1, title: "Easy 30", intent: { summary: "Easy", goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }], source: { kind: "coros_import" } });
  await db.insert(plannedWorkouts).values([row("1", today, ""), row("2", addDays(today, 1), ""), row("3", addDays(today, -1), valid, "completed")]);
  // The malformed text written by plain SQL, past any column mapping: what a bad write or a hand edit would leave.
  await db.run(sql`update planned_workouts set workout_doc = '{not json' where id = '1'`);
  await db.run(sql`update planned_workouts set workout_doc = '[1, 2' where id = '2'`);
  statements.length = 0;
});

describe("the hot reads", () => {
  it("the Plan page's today answers with a malformed document on the page, and reads no document", async () => {
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    statements.length = 0;
    const res = await app.request("/api/plan/today", { headers: { Cookie: cookie } }, { FIXTURE_MODE: "1" } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todaySessions: Array<{ workout: { id: string } }>; upcoming: Array<{ id: string }> };
    expect(body.todaySessions.map((s) => s.workout.id)).toEqual(["1"]);
    expect(body.upcoming.map((w) => w.id)).toEqual(["1", "2"]);
    expect(statements.filter((q) => /from "planned_workouts"/.test(q)).length).toBeGreaterThan(0);
    expect(statements.filter(readsDoc)).toEqual([]);
  });

  it("the hourly import reads every row without its document, and a malformed one stops nothing", async () => {
    const src = (id: string, date: string, fp: string): SourcePlannedWorkout => ({
      sourcePlanId: "plan-1", sourceWorkoutId: `plan-1:${id}`, sourceIdInPlan: id, title: "Easy 30", sport: "run", date,
      stages: [{ id: "s1", order: 0, kind: "work", durationType: "time", durationSeconds: 1800 }], contentFingerprint: fp, isRestDay: false,
    });
    // The first read creates the plan row and claims the seeded rows by address; the second changes row 2 upstream.
    await importPlanSnapshot(db, { userId, plan: { sourcePlanId: "plan-1", name: "Plan" }, workouts: [src("1", today, "fp-1"), src("2", addDays(today, 1), "fp-2")], rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" }, prefs);
    statements.length = 0;
    const stats = await importPlanSnapshot(
      db,
      { userId, plan: { sourcePlanId: "plan-1", name: "Plan" }, workouts: [src("1", today, "fp-1"), src("2", addDays(today, 1), "fp-2b")], rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" },
      prefs,
    );
    expect(stats.updatedContent).toBe(1);
    expect(statements.filter(readsDoc)).toEqual([]);
    // Row 1 kept its (malformed) column untouched; row 2's content change wrote it a real document at the next revision.
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("1")!.workoutDoc).toBe("{not json");
    expect(parseStoredWorkoutDoc(byId.get("2")!.workoutDoc)?.source.kind).toBe("coros_import");
    expect(byId.get("2")!.workoutDocRev).toBe(2);
  });

  it("the coach's dossier reads no document, malformed or not", async () => {
    statements.length = 0;
    const dossier = await buildDossier(db, userId, prefs, today);
    expect(dossier).toBeTruthy();
    expect(statements.filter(readsDoc)).toEqual([]);
  });

  it("the check itself: the hasDoc flag is not a read of the document; its column selected or json_extract'ed still is", () => {
    expect(readsDoc('select "id", "workout_doc" is not null from "planned_workouts"')).toBe(false);
    expect(readsDoc('select "planned_workouts"."id", "planned_workouts"."workout_doc" is not null from "planned_workouts"')).toBe(false);
    expect(readsDoc('select "id", "workout_doc", "workout_doc_rev" from "planned_workouts"')).toBe(true);
    expect(readsDoc('select "id", "workout_doc" is not null, "workout_doc" from "planned_workouts"')).toBe(true);
    expect(readsDoc(`select json_extract("planned_workouts"."workout_doc", '$.title') from "planned_workouts"`)).toBe(true);
    expect(readsDoc('update "planned_workouts" set "workout_doc" = ?')).toBe(false);
  });

  it("any full-row read still works on a malformed document: the column is text, parsed only by parseStoredWorkoutDoc", async () => {
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    expect(rows.find((r) => r.id === "1")!.workoutDoc).toBe("{not json");
    expect(parseStoredWorkoutDoc(rows.find((r) => r.id === "1")!.workoutDoc)).toBeNull();
    expect(parseStoredWorkoutDoc(rows.find((r) => r.id === "3")!.workoutDoc)?.title).toBe("Easy 30");
  });
});

// ── The crons ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the hourly and half-hourly crons", () => {
  /** A select of planned rows that carries the document. */
  const readsPlannedDoc = (q: string) => readsDoc(q) && /from "planned_workouts"/.test(q);

  it("hourly() — reconcile, the garden, the legacy heal, placement, the triggers — reads no planned row's document, and a malformed one stops none of it", { timeout: 120_000 }, async () => {
    const cron = makeTestDb({ onStatement: (q) => statements.push(q) });
    const acct = await seedRealisticAccount(cron, { gardenBehindDays: 3, newActivities: false });
    // Every planned row of the account holds a document that is not JSON (plain SQL: past any column mapping).
    await cron.run(sql`update planned_workouts set workout_doc = '{not json', workout_doc_rev = 1`);
    vi.stubGlobal("fetch", acct.fetchImpl);
    try {
      statements.length = 0;
      await hourly(cron, acct.env);
    } finally {
      vi.unstubAllGlobals();
    }
    const [run] = await cron
      .select({ status: schema.syncRuns.status })
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.userId, acct.userId), eq(schema.syncRuns.kind, "reconcile")))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1);
    expect(run?.status).toBe("ok");
    expect(statements.some((q) => /from "planned_workouts"/.test(q))).toBe(true);
    expect(statements.filter(readsPlannedDoc)).toEqual([]);
  });

  it("the garden's day input (the hourly walk's, when a day is not cached) reads no planned row's document", async () => {
    // A Monday: the day's rows, the resolutions that land on it, and the week's adherence — all three reads.
    statements.length = 0;
    const input = await buildDayInput(db, userId, startOfIsoWeek(today), prefs);
    expect(input).toBeTruthy();
    expect(statements.filter((q) => /from "planned_workouts"/.test(q)).length).toBeGreaterThanOrEqual(3);
    expect(statements.filter(readsPlannedDoc)).toEqual([]);
  });

  it("the calendar sync reads no planned row's document", async () => {
    await connectGoogle(db, userId);
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fakeGoogle(url, init);
    }) as typeof fetch);
    try {
      statements.length = 0;
      const stats = await syncCalendar(db, ENV, userId);
      expect(stats.skipped).toBe(false);
      expect(stats.created).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(statements.some((q) => /from "planned_workouts"/.test(q))).toBe(true);
    expect(statements.filter(readsPlannedDoc)).toEqual([]);
  });
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = { APP_URL: "https://app.test", TOKEN_ENCRYPTION_KEY: TEST_KEY, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c" } as unknown as Env;

/** A connected, settled Google Calendar for the user (synthetic tokens). */
async function connectGoogle(on: Db, owner: string): Promise<void> {
  await savePreferences(on, owner, { ...(await loadPreferences(on, owner)), calendarId: "cal" });
  await on.insert(schema.providerConnections).values({
    id: newId(), userId: owner, provider: "google_calendar", status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY), encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

/** Google Calendar's events endpoint, just enough for a sync: list, insert, patch, delete. */
let googleEvents = 0;
async function fakeGoogle(url: URL, init?: RequestInit): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const method = (init?.method ?? "GET").toUpperCase();
  const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
  if (!m) return json({}, 404);
  if (method === "GET") return json({ items: [], nextSyncToken: "t" });
  if (method === "POST") return json({ id: `ev${++googleEvents}` });
  if (m[1] && method === "PATCH") return json({ id: m[1] });
  if (m[1] && method === "DELETE") return new Response(null, { status: 204 });
  return json({}, 400);
}
