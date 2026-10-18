/**
 * A WHOLE PLAN, A REQUEST AT A TIME, EACH WITHIN 45 (§8 §4, 2026-10-18).
 *
 * A thread proposal that shapes a plan is approved a chunk a request (routes/thread-structural.ts), answering
 * `remaining` until done; the Plan's Retire is too. Measured the way coach-approve-budget.test.ts measures an approve:
 * every D1 statement and every fetch a request costs, its waitUntil work included, against a COROS that renormalizes
 * and a connected Google Calendar — create (7 and 40 sessions), firm up, reshape, wind down over sessions on the
 * watch and the calendar, extend, and Retire over a plan with 30 future sessions.
 *
 * Before: a seven-session createPlan measured 68 in one request (workout-doc-budget.test.ts's PRE_TASK).
 *
 * Synthetic fixtures only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, startOfIsoWeek, todayInZone, type CoachOp, type CoachSession, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { coachRoutes } from "../src/routes/coach.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { renormalizingCoros, type RenormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { RETIRE_FINISH, RETIRE_FIXED, THREAD_APPROVE_FINISH, THREAD_APPROVE_FIXED } from "../src/routes/thread-structural.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const BUDGET = 45;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** The statements and fetches a request spent inside its chunks: the rest is the request's own. */
let inChunk = false;
let chunkCost = 0;
vi.mock("../src/services/coach-apply.js", async (original) => {
  const m = await original<typeof import("../src/services/coach-apply.js")>();
  return {
    ...m,
    applyStructuralChunk: async (...args: Parameters<typeof m.applyStructuralChunk>) => {
      inChunk = true;
      try {
        return await m.applyStructuralChunk(...args);
      } finally {
        inChunk = false;
      }
    },
  };
});

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
let statements = 0;
let fetches = 0;
let monday: string;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: () => {
      statements += 1;
      if (inChunk) chunkCost += 1;
    },
  });
  ({ userId } = await makeTestUser(db, { corosWritesEnabled: true }));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  monday = addDays(startOfIsoWeek(todayInZone(prefs.timezone)), 7);
  await db.insert(schema.providerConnections).values({
    id: newId(), userId, provider: "google_calendar", status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY), encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  server = renormalizingCoros();
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

/** One request, its waitUntil work included: status, JSON and the D1 statements + fetches it cost. */
async function invoke(path: string) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  chunkCost = 0;
  const res = await app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" } }, makeEnv(), executionCtx as never);
  await Promise.all(pending);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  own.push({ path: path.split("/").at(-1)!, last: !json?.remaining, own: statements + fetches - chunkCost });
  return { status: res.status, json, total: statements + fetches };
}

/** Ask until nothing remains, as the client does (bounded): every request's cost, and the last answer. */
async function untilDone(path: string, max = 40) {
  const totals: number[] = [];
  for (let i = 0; i < max; i++) {
    const r = await invoke(path);
    totals.push(r.total);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // What the request spends outside its chunks is what the budget reserves for it: the calendar's step aside, which
    // the finishing approve takes only in the room left (`calendarOpsFitting`).
    const mine = own.at(-1)!;
    const retire = path.endsWith("/retire");
    const reserved = retire ? RETIRE_FIXED + (mine.last ? RETIRE_FINISH : 0) : THREAD_APPROVE_FIXED + (mine.last ? THREAD_APPROVE_FINISH : 0);
    if (retire || !mine.last) expect(mine.own, JSON.stringify(mine)).toBeLessThanOrEqual(reserved);
    if (!r.json?.remaining) return { totals, last: r.json! };
  }
  throw new Error(`still remaining after ${max} requests`);
}

const run = (title: string, minutes: number): CoachSession => ({
  category: "easy",
  title,
  durationMinutes: minutes,
  run: { blocks: [{ kind: "duration", value: 10, intensity: "easy" }, { kind: "duration", value: minutes - 10, intensity: "steady" }] },
});
const days = (from: string, n: number, title = "Easy") =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), session: run(`${title} ${i}`, 30 + i) }));

async function proposal(ops: CoachOp[], title = "Plan"): Promise<string> {
  const id = newId();
  await db.insert(schema.coachProposals).values({
    id, userId, title, evidence: "e", rationale: "r", flags: [], ops: ops.map((o) => coachOpSchema.parse(o)), status: "pending",
    createdAt: nowInstant(), expiresAt: addDays(monday, 30),
  });
  return id;
}

/** A plan of `n` sessions from Monday, approved through the route, its sessions on the watch and the calendar. */
async function settledPlan(n: number): Promise<string> {
  const id = await proposal([{ kind: "createPlan", discipline: "run", name: "Base block", startDate: monday, endDate: addDays(monday, 69), firmSessions: days(monday, n), shapeWeeks: [] }]);
  await untilDone(`/api/coach/proposals/${id}/approve`);
  for (let i = 0; i < 10 && (await executeCloudJobs(db, makeEnv(), userId, prefs, {})).executed > 0; i++);
  for (let i = 0; i < 10; i++) await syncCalendar(db, makeEnv(), userId);
  return `cp-${id}-0`;
}

/** The most each case's requests cost, for the report. */
const measured: Record<string, { requests: number; max: number }> = {};
/** Each request's own cost (outside its chunks), and whether it finished. */
const own: { path: string; last: boolean; own: number }[] = [];
afterAll(() => console.log("thread approve budgets:", JSON.stringify(measured), JSON.stringify(own)));

describe("a structural thread approve answers within 45 a request, `remaining` until done", () => {
  it("createPlan of 7 sessions", { timeout: 60_000 }, async () => {
    const id = await proposal([{ kind: "createPlan", discipline: "run", name: "Base block", startDate: monday, endDate: addDays(monday, 27), firmSessions: days(monday, 7), shapeWeeks: [] }], "New block");
    const { totals, last } = await untilDone(`/api/coach/proposals/${id}/approve`);
    measured.createPlan7 = { requests: totals.length, max: Math.max(...totals) };
    expect(Math.max(...totals), totals.join(" ")).toBeLessThanOrEqual(BUDGET);
    expect(last).toMatchObject({ ok: true, summaries: ["Added “Base block” with 7 sessions"], coachDrain: true });
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    expect(p!.status).toBe("approved");
    const rows = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.planId, `cp-${id}-0`));
    expect(rows).toHaveLength(7);
    const receipts = (await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId))).filter((m) => m.role === "receipt");
    expect(receipts.map((m) => m.body)).toEqual(["✓ approved — New block"]);
  });

  it("createPlan of 40 sessions", { timeout: 60_000 }, async () => {
    const id = await proposal([{ kind: "createPlan", discipline: "run", name: "Long block", startDate: monday, endDate: addDays(monday, 69), firmSessions: days(monday, 40), shapeWeeks: [] }]);
    const { totals } = await untilDone(`/api/coach/proposals/${id}/approve`);
    measured.createPlan40 = { requests: totals.length, max: Math.max(...totals) };
    expect(Math.max(...totals), totals.join(" ")).toBeLessThanOrEqual(BUDGET);
    expect(totals.length).toBeGreaterThan(1);
    expect(await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.planId, `cp-${id}-0`))).toHaveLength(40);
  });

  it("firmUp of 7, reshapeWeek of 5 and extendPlan of 10 weeks, on a settled plan", { timeout: 60_000 }, async () => {
    const planId = await settledPlan(14);
    const firm = await proposal([{ kind: "firmUp", planId, weekStart: addDays(monday, 21), sessions: days(addDays(monday, 21), 7, "Firm") }]);
    const firmed = await untilDone(`/api/coach/proposals/${firm}/approve`);
    measured.firmUp7 = { requests: firmed.totals.length, max: Math.max(...firmed.totals) };
    const reshape = await proposal([{ kind: "reshapeWeek", planId, weekStart: addDays(monday, 7), sessions: days(addDays(monday, 7), 5, "Reshaped") }]);
    const reshaped = await untilDone(`/api/coach/proposals/${reshape}/approve`);
    measured.reshapeWeek5 = { requests: reshaped.totals.length, max: Math.max(...reshaped.totals) };
    const extend = await proposal([{ kind: "extendPlan", planId, shapeWeeks: Array.from({ length: 10 }, (_, i) => ({ weekStart: addDays(monday, 70 + 7 * i), volumeTarget: "30 km", keySessions: ["long run"] })) }]);
    const extended = await untilDone(`/api/coach/proposals/${extend}/approve`);
    measured.extendPlan10 = { requests: extended.totals.length, max: Math.max(...extended.totals) };
    for (const t of [firmed, reshaped, extended]) expect(Math.max(...t.totals), t.totals.join(" ")).toBeLessThanOrEqual(BUDGET);
    expect(extended.totals).toHaveLength(1);
  });

  it("windDown of 10 over two weeks of sessions on the watch and the calendar", { timeout: 60_000 }, async () => {
    const planId = await settledPlan(21);
    const synced = await db.select().from(schema.plannedWorkouts).where(and(eq(schema.plannedWorkouts.planId, planId), eq(schema.plannedWorkouts.corosSyncState, "synced")));
    expect(synced.length).toBeGreaterThan(10);
    const id = await proposal([{ kind: "windDown", planId, sessions: days(addDays(monday, 7), 10, "Taper") }]);
    const { totals } = await untilDone(`/api/coach/proposals/${id}/approve`);
    measured.windDown10 = { requests: totals.length, max: Math.max(...totals) };
    expect(Math.max(...totals), totals.join(" ")).toBeLessThanOrEqual(BUDGET);
    const unpushes = await db.select().from(schema.corosWriteJobs).where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "coach_delete_workout")));
    expect(unpushes).toHaveLength(14);
  });
});

describe("the Plan's Retire answers within 45 a request, `remaining` until the plan is retired", () => {
  it("a plan with 30 future sessions, on the watch and the calendar", { timeout: 60_000 }, async () => {
    const planId = await settledPlan(30);
    const { totals, last } = await untilDone(`/api/coach/plans/${planId}/retire`);
    measured.retire30 = { requests: totals.length, max: Math.max(...totals) };
    expect(Math.max(...totals), totals.join(" ")).toBeLessThanOrEqual(BUDGET);
    expect(totals.length).toBeGreaterThan(1);
    expect(last).toEqual({ ok: true });
    const [plan] = await db.select().from(schema.coachPlans).where(eq(schema.coachPlans.id, planId));
    expect(plan!.status).toBe("retired");
    const live = (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.planId, planId))).filter((w) => !w.archivedAt);
    expect(live).toEqual([]);
    const receipts = (await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId))).filter((m) => m.body.startsWith("Plan retired"));
    expect(receipts).toHaveLength(1);
  });

  it("a plan that isn't there is a 404, not a receipt", async () => {
    const r = await invoke("/api/coach/plans/cp-gone/retire");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
  });
});
