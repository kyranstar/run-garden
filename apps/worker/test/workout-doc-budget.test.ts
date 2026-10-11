/**
 * WHAT THE WORKOUT DOCUMENT COSTS A REQUEST (Stage 1 Task 11, fix round 1, ruling a).
 *
 * A writer of planned workouts writes each row's document in the row's own statement, and the revisions of ALL the
 * rows it writes in ONE statement (per 80 rows) in the same batch: an op of N sessions, or a read of N changed
 * workouts, costs one statement more than before the documents — not N. Measured the way coach-approve-budget
 * measures an approve: every D1 statement and every fetch the request costs, its waitUntil work included, against a
 * COROS that renormalizes and a connected Google Calendar. The count before the documents is the same request less
 * its revision statements (the documents add no other statement: each rides its row's own insert or update).
 *
 * Synthetic fixtures only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, startOfIsoWeek, todayInZone, type CoachOp, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { coachRoutes } from "../src/routes/coach.js";
import { syncRoutes } from "../src/routes/sync.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { renormalizingCoros, type RenormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

/** Google Calendar's events endpoint, just enough for a settled mirror: list, insert, patch, delete. */
function fakeGoogle() {
  let n = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    if (method === "GET") return json({ items: [], nextSyncToken: String(n) });
    if (method === "POST") return json({ id: `ev${++n}` });
    if (m[1] && method === "PATCH") return json({ id: m[1] });
    if (m[1] && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 400);
  };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: RenormalizingCoros;
let statements: string[] = [];
let fetches = 0;
let today: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  ({ userId } = await makeTestUser(db, { corosWritesEnabled: true }));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  today = todayInZone(prefs.timezone);
  await db.insert(schema.providerConnections).values({
    id: newId(), userId, provider: "google_calendar", status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY), encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  // The mock's schedule is this week and next: the read's window holds all of it.
  server = renormalizingCoros({ baseMonday: startOfIsoWeek(today) });
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  const google = fakeGoogle();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "www.googleapis.com") return google(url, init);
    if (url.href === COROS_LOCALE_URL) return new Response("window.en_US={};", { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Cost {
  status: number;
  statements: number;
  fetches: number;
  total: number;
  /** The revision statements: what the documents added. */
  revisions: number;
  /** The same request before the documents. */
  before: number;
}

/** One request, its waitUntil work included: what it cost. */
async function invoke(app: ReturnType<typeof mountRoutes>, path: string, body?: unknown): Promise<Cost> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = [];
  fetches = 0;
  const res = await app.request(
    path,
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const revisions = statements.filter((q) => /^insert into "workout_doc_revisions"/.test(q)).length;
  const total = statements.length + fetches;
  return { status: res.status, statements: statements.length, fetches, total, revisions, before: total - revisions };
}

const run = (title: string, minutes: number) => ({
  category: "easy",
  title,
  durationMinutes: minutes,
  run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
});

async function proposal(ops: CoachOp[]): Promise<string> {
  const id = newId();
  await db.insert(schema.coachProposals).values({
    id, userId, title: "Plan", evidence: "e", rationale: "r", flags: [], ops, status: "pending", createdAt: nowInstant(), expiresAt: addDays(today, 30),
  });
  return id;
}

/** What each case measured, for the task report. */
const measured: Record<string, Cost> = {};

/**
 * The same requests before the documents: measured at `ca6c47e` (the commit before Task 11) in a git-archive snapshot
 * of it, with this file's harness (task-11-report.md, fix round 1). All four were over the 45 budget already: a
 * session's row, stages, watch write and calendar event, and a read's import and ingest, each cost statements — that
 * overage is not the documents' to fix. The documents may add one revision statement per op, or per batch of ten
 * rows a read writes; nothing else.
 */
const PRE_TASK = { createPlan7: 68, reshapeWeek4: 67, readNowFirst: 158, readNow7: 140 };

describe("one revision statement per op or read, not per session", () => {
  it("a createPlan of 7 sessions, then a reshapeWeek of 4, through the approve route", { timeout: 60_000 }, async () => {
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const monday = addDays(startOfIsoWeek(today), 14);
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const create = await proposal([
      coachOpSchema.parse({
        kind: "createPlan", discipline: "run", name: "Base block", startDate: monday, endDate: addDays(monday, 27), raceDate: null,
        firmSessions: days.map((date, i) => ({ date, session: run(`Easy ${30 + i}`, 30 + i) })), shapeWeeks: [],
      }),
    ]);
    const created = await invoke(app, `/api/coach/proposals/${create}/approve`);
    expect(created.status).toBe(200);
    expect(created.revisions).toBe(1);
    const planId = (await db.select({ id: schema.coachPlans.id }).from(schema.coachPlans).where(eq(schema.coachPlans.userId, userId)))[0]!.id;
    const docs = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.workoutDocRevisions)
      .where(eq(schema.workoutDocRevisions.userId, userId));
    expect(docs[0]!.n).toBe(7);
    measured.createPlan7 = created;

    const reshape = await proposal([
      coachOpSchema.parse({ kind: "reshapeWeek", planId, weekStart: monday, sessions: days.slice(0, 4).map((date, i) => ({ date, session: run(`Steady ${40 + i}`, 40 + i) })) }),
    ]);
    const reshaped = await invoke(app, `/api/coach/proposals/${reshape}/approve`);
    expect(reshaped.status).toBe(200);
    expect(reshaped.revisions).toBe(1);
    measured.reshapeWeek4 = reshaped;
    // The four new sessions each have their revision 1.
    const revs = await db
      .select({ id: schema.workoutDocRevisions.id })
      .from(schema.workoutDocRevisions)
      .where(and(eq(schema.workoutDocRevisions.userId, userId), eq(schema.workoutDocRevisions.sourceRef, reshape)));
    expect(revs).toHaveLength(4);
    // One statement more than before the documents, not one per session.
    expect(created.total, JSON.stringify(created)).toBeLessThanOrEqual(PRE_TASK.createPlan7 + 1);
    expect(reshaped.total, JSON.stringify(reshaped)).toBeLessThanOrEqual(PRE_TASK.reshapeWeek4 + 1);
  });

  it("a read-now that finds 7 workouts changed in COROS", { timeout: 60_000 }, async () => {
    const app = mountRoutes(db, "/api/sync", syncRoutes);
    const first = await invoke(app, "/api/sync/read-now");
    expect(first.status).toBe(200);
    // Seven programs renamed in COROS: seven content changes, each a new document at the next revision.
    for (const program of (server.state.schedule.programs ?? []).slice(0, 7)) program.name = `${program.name} (changed)`;
    await db.update(schema.providerConnections).set({ lastSyncAt: "2000-01-01T00:00:00.000Z" }).where(eq(schema.providerConnections.userId, userId));
    const changed = await invoke(app, "/api/sync/read-now");
    expect(changed.status).toBe(200);
    // Seven rows took the new content; the one the read's own activity completed keeps its document (frozen), and
    // the other six are at revision 2 — all six revisions in one statement.
    const rows = await db
      .select({ id: schema.plannedWorkouts.id, title: schema.plannedWorkouts.title, state: schema.plannedWorkouts.completionState, rev: schema.plannedWorkouts.workoutDocRev })
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.userId, userId));
    const renamed = rows.filter((r) => r.title.endsWith("(changed)"));
    expect(renamed).toHaveLength(7);
    const open = renamed.filter((r) => !["completed", "skipped", "missed"].includes(r.state));
    expect(open.length).toBeGreaterThanOrEqual(6);
    expect(open.every((r) => r.rev === 2)).toBe(true);
    expect(renamed.filter((r) => !open.includes(r)).every((r) => r.rev === 1)).toBe(true);
    const revisedNow = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.workoutDocRevisions)
      .where(and(eq(schema.workoutDocRevisions.userId, userId), eq(schema.workoutDocRevisions.rev, 2)));
    expect(revisedNow[0]!.n).toBe(open.length);
    expect(changed.revisions).toBe(1);
    expect(changed.total, JSON.stringify(changed)).toBeLessThanOrEqual(PRE_TASK.readNow7 + 1);
    // The first read wrote eleven workouts: two batches (ten and one), a revision statement each.
    expect(first.revisions).toBe(2);
    expect(first.total, JSON.stringify(first)).toBeLessThanOrEqual(PRE_TASK.readNowFirst + 2);
    measured.readNow7 = changed;
    measured.readNowFirst = first;
  });

  // The numbers for the task report, on request only (`RG_PRINT_COSTS=1`).
  afterAll(() => {
    if (process.env.RG_PRINT_COSTS) console.log("WORKOUT DOC COSTS", JSON.stringify(measured));
  });
});
