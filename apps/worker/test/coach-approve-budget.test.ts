/**
 * "MAKE IT SO" ANSWERS WITHIN ONE FREE-PLAN INVOCATION (2026-10-10, ruling 3-R11).
 *
 * The owner approved a proposal that rewrote a strength session. The approve committed — proposal `approved`,
 * resolved_at set, applied_refs set — but the client showed an error, and the second tap got 409 not_pending.
 * The route did all of this in ONE invocation: applyOps, the proposal update, a receipt, a capped garden resim, then
 * `waitUntil(syncCalendar)` AND `waitUntil(executeCloudJobs)` — the whole lane, cap 3, which for one rewrite is a
 * plan-wide read before and after the write (ten schedule windows), calculate, the write, and the job and row
 * bookkeeping. Workers Free gives an invocation 50 subrequests (D1 statements and fetches alike); the suites budget 45.
 *
 * Measured here the way watch-push-move-budget.test.ts measures a move: every D1 statement and every fetch (COROS and
 * Google) the request costs, its waitUntil work included, against a COROS that renormalizes and a Google Calendar
 * that is connected and settled.
 *
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { coachOpSchema, newId, nowInstant, addDays, todayInZone, type CoachOp, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { coachRoutes } from "../src/routes/coach.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { renormalizingCoros, type RenormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const BUDGET = 45;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SQUAT = "425898928110747648";
const PUSHUP = "426109589008859137";

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

const STRENGTH = {
  category: "strength",
  title: "Strength A",
  durationMinutes: 35,
  lift: {
    exercises: [
      { name: "Push-up", originId: PUSHUP, sets: 3, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Air squat", originId: SQUAT, sets: 3, reps: 15, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Goblet squat", originId: SQUAT, sets: 4, reps: 8, weight: { type: "kg", value: 20 }, restSeconds: 90 },
    ],
  },
};
const EASED = {
  ...STRENGTH,
  durationMinutes: 30,
  lift: {
    exercises: [
      { name: "Push-up", originId: PUSHUP, sets: 2, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Air squat", originId: SQUAT, sets: 2, reps: 15, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Goblet squat", originId: SQUAT, sets: 3, reps: 8, weight: { type: "kg", value: 16 }, restSeconds: 90 },
    ],
  },
};

/** Google Calendar's events endpoint, just enough for a settled mirror: list, insert, patch, delete. */
function fakeGoogle() {
  const events = new Map<string, Record<string, unknown>>();
  let n = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") return json({ items: [], nextSyncToken: String(n) });
    if (method === "POST") {
      const ev = `ev${++n}`;
      events.set(ev, JSON.parse(String(init!.body)) as Record<string, unknown>);
      return json({ id: ev });
    }
    if (id && method === "PATCH") return json({ id });
    if (id && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 400);
  };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: RenormalizingCoros;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db, { corosWritesEnabled: true }));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "google_calendar",
    status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY),
    encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  server = renormalizingCoros();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  await db.insert(schema.corosExercises).values([
    { id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() },
    { id: PUSHUP, name: "Push-up", raw: {}, updatedAt: nowInstant() },
  ]);
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

/** One request, its waitUntil work included: status, JSON and the D1 statements + fetches it cost. */
async function invoke(app: ReturnType<typeof mountRoutes>, path: string, body?: unknown) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null, total: statements + fetches, statements, fetches };
}

/** A coach strength session on the watch and in the calendar, both settled. */
async function pushedStrength(date: string): Promise<string> {
  const added = await applyOps(db, userId, prefs, `p-add-${date}`, [coachOpSchema.parse({ kind: "add", date, session: STRENGTH })]);
  const workoutId = added.created[0]!;
  await executeCloudJobs(db, makeEnv(), userId, prefs, {});
  await syncCalendar(db, makeEnv(), userId);
  const [row] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId));
  expect(row!.corosSyncState).toBe("synced");
  return workoutId;
}

async function proposal(ops: CoachOp[], expiresAt: string): Promise<string> {
  const id = newId();
  await db.insert(schema.coachProposals).values({
    id, userId, title: "Ease the lift", evidence: "e", rationale: "r", flags: [], ops, status: "pending", createdAt: nowInstant(), expiresAt,
  });
  return id;
}

const rewriteOf = async (workoutId: string) =>
  (
    await db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "coach_update_workout")))
  )[0];

describe("approving a proposal that rewrites a session on the watch (3-R11)", () => {
  it("answers success within 45, the rewrite queued for a drain of its own; the drain runs it within 45", async () => {
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 5);
    const workoutId = await pushedStrength(date);
    const id = await proposal([{ kind: "ease", workoutId, session: EASED } as CoachOp], date);
    const app = mountRoutes(db, "/api/coach", coachRoutes);

    const approved = await invoke(app, `/api/coach/proposals/${id}/approve`);

    expect(approved.status).toBe(200);
    expect(approved.json?.ok).toBe(true);
    expect(approved.total, `${approved.statements} statements + ${approved.fetches} fetches`).toBeLessThanOrEqual(BUDGET);
    expect(approved.json?.coachDrain).toBe(true);
    expect((await rewriteOf(workoutId))!.status).toBe("queued");

    const drained = await invoke(app, "/api/coach/drain", {});

    expect(drained.status).toBe(200);
    expect(drained.json?.executed).toBe(1);
    expect(drained.total, `${drained.statements} statements + ${drained.fetches} fetches`).toBeLessThanOrEqual(BUDGET);
    expect((await rewriteOf(workoutId))!.status).toBe("verified");

    // Nothing left: the next drain is a cheap no-op the client's loop stops on.
    const idle = await invoke(app, "/api/coach/drain", {});
    expect(idle.json?.executed).toBe(0);
  });

  it("the drain takes the coach's write, never an older queued read", async () => {
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 5);
    const workoutId = await pushedStrength(date);
    // A catch-up read queued an hour ago, still waiting for the cron: older than anything the approve queues.
    await db.insert(schema.corosWriteJobs).values({
      id: "read-now-old", userId, workoutId: "", kind: "read_now", status: "queued", payload: {},
      originalDate: today, destinationDate: today, expectedContentFingerprint: "",
      requestedAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: nowInstant(),
    });
    const id = await proposal([{ kind: "ease", workoutId, session: EASED } as CoachOp], date);
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    expect((await invoke(app, `/api/coach/proposals/${id}/approve`)).json?.coachDrain).toBe(true);

    const drained = await invoke(app, "/api/coach/drain", {});

    expect(drained.json?.executed).toBe(1);
    expect((await rewriteOf(workoutId))!.status).toBe("verified");
    const [read] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, "read-now-old"));
    expect(read!.status).toBe("queued");
  });

  it("an approve that committed answers success even when the receipt after it fails", async () => {
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 5);
    const workoutId = await pushedStrength(date);
    const id = await proposal([{ kind: "ease", workoutId, session: EASED } as CoachOp], date);
    // Any write to the thread fails from here on: the apply and the proposal's own update are already in.
    await db.run(sql`CREATE TRIGGER no_receipts BEFORE INSERT ON coach_messages BEGIN SELECT RAISE(ABORT, 'thread unavailable'); END`);
    const app = mountRoutes(db, "/api/coach", coachRoutes);

    const approved = await invoke(app, `/api/coach/proposals/${id}/approve`);

    expect(approved.status).toBe(200);
    expect(approved.json?.ok).toBe(true);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    expect(p!.status).toBe("approved");
  });

  it("GET /proposals/:id answers its status — what the card re-reads after a lost answer — and only to its owner", async () => {
    const today = todayInZone(prefs.timezone);
    const id = await proposal([], addDays(today, 3));
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const app = mountRoutes(db, "/api/coach", coachRoutes);

    const res = await app.request(`/api/coach/proposals/${id}`, { headers: { Cookie: cookie } }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: "pending", resolvedAt: null });

    const { userId: other } = await makeTestUser(db);
    const theirs = `${SESSION_COOKIE}=${await createSession(db, other)}`;
    expect((await app.request(`/api/coach/proposals/${id}`, { headers: { Cookie: theirs } }, makeEnv())).status).toBe(404);
  });

  it("an approve that queued no watch write answers no coachDrain", async () => {
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 4);
    const workoutId = await pushedStrength(date);
    const id = await proposal([{ kind: "move", workoutId, toDate: date, toTime: "06:30" } as CoachOp], date);
    const app = mountRoutes(db, "/api/coach", coachRoutes);

    const approved = await invoke(app, `/api/coach/proposals/${id}/approve`);

    expect(approved.status).toBe(200);
    expect(approved.json?.coachDrain).toBeUndefined();
  });
});
