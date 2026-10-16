/**
 * A DESIGNED APPROVE BOOKS THE CALENDAR AS A STUDIO SAVE DOES — WITHIN ITS REQUEST (Stage 3 Task 9; Task 8's notes).
 *
 * The thread coach's approve and the Studio's own saves hand the calendar one bounded sync step through waitUntil. A
 * designed approve does too, once the approve loop is over (nothing `remaining`) and the request wrote something —
 * but only as many calendar ops as the room its declared costs left (`calendarOpsFitting`): the approve fills its
 * request to 45 by design, so a full chunk books nothing and leaves it to the half-hourly reconcile, as every request
 * past CALENDAR_OPS_PER_REQUEST does.
 *
 * Measured the way doc-workout-budget.test.ts measures a Studio save: every D1 statement and every fetch, the
 * waitUntil work included, against a Google Calendar that is connected and settled, on a busy account. Synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, parseStoredWorkoutDoc, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { coachRoutes } from "../src/routes/coach.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import {
  APPROVE_FIXED,
  CALENDAR_STEP_FIXED,
  CALENDAR_STEP_PER_OP,
  calendarOpsFitting,
  REQUEST_BUDGET,
  type DesignedOp,
} from "../src/services/design-approve.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { activateTmj, calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(designer = true): Env {
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
    ...(designer ? { COACH_DESIGNER: "1" } : {}),
  } as Env;
}

/** Google Calendar's events endpoint, enough for a settled mirror; its inserts by workout id. */
function fakeGoogle() {
  let n = 0;
  const inserted: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") return json({ items: [], nextSyncToken: String(n) });
    if (method === "POST") {
      const body = JSON.parse(String(init!.body)) as { extendedProperties?: { private?: { rgWorkoutId?: string } } };
      inserted.push(body.extendedProperties?.private?.rgWorkoutId ?? "?");
      return json({ id: `ev${++n}` });
    }
    if (id && method === "PATCH") return json({ id });
    if (id && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 400);
  };
  return { handle, inserted };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements = 0;
let fetches = 0;
let google: ReturnType<typeof fakeGoogle>;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
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
  google = fakeGoogle();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "www.googleapis.com") return google.handle(url, init);
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  await activateTmj(db, userId);
  await busyAccount();
  await syncCalendar(db, makeEnv(), userId);
  google.inserted.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fortnight of planned runs (two a day on every third day; `crowded` days hold five). */
async function busyAccount(crowded: string[] = []): Promise<void> {
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const slots = crowded.includes(date) ? ["06:00", "08:00", "12:00", "17:00", "20:00"] : i % 3 === 0 ? ["07:00", "18:00"] : ["07:00"];
    for (const slot of slots) {
      const id = `w-${i}-${slot}`;
      await db.insert(schema.plannedWorkouts).values({
        id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run",
        originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: slot,
        sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
        createdAt: nowInstant(), updatedAt: nowInstant(),
      }).onConflictDoNothing();
    }
  }
}

const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

/** A week's proposal of `drafts`, reviewed and pending. */
async function designed(drafts: Array<{ doc: object; target: DocWorkoutTarget }>): Promise<{ id: string; opIds: string[] }> {
  const run = async (role: "main" | "designer", parentId: string | null) => {
    const id = `run-${newId()}`;
    await db.insert(schema.coachRuns).values({
      id, userId, parentId, role, scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    return { id, role, scope: { kind: "week" as const }, parentId, rehearsal: false };
  };
  const main = await run("main", null);
  const opIds: string[] = [];
  for (const d of drafts) {
    const designer = await run("designer", main.id);
    const ctx: ToolContext = { db, env: makeEnv(), userId, run: designer, now: new Date(), toolUseId: `toolu_${newId()}` };
    const res = await proposeWorkout.run(ctx, d);
    if (isToolErr(res)) throw new Error(`propose refused: ${res.error} — ${res.why}`);
    opIds.push(designer.id);
  }
  const id = designProposalId(main.id);
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
  await db.update(schema.coachProposals).set({ status: "pending", ops: (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: REVIEW })) }).where(eq(schema.coachProposals.id, id));
  return { id, opIds };
}

/** One request, its waitUntil work included. */
async function invoke(path: string, body: unknown, designer = true) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    makeEnv(designer),
    executionCtx as never,
  );
  const waited = pending.length;
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, any>, total: statements + fetches, waited };
}

const designRows = async () =>
  (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, userId))).filter(
    (w) => parseStoredWorkoutDoc(w.workoutDoc)?.basedOn?.kind === "proposal",
  );

describe("the calendar's step after a designed approve", () => {
  it("how many calendar ops fit the room an approve left: none below one op's room, never past the request's cap", () => {
    expect(calendarOpsFitting(0)).toBe(0);
    expect(calendarOpsFitting(CALENDAR_STEP_FIXED + CALENDAR_STEP_PER_OP - 1)).toBe(0);
    expect(calendarOpsFitting(CALENDAR_STEP_FIXED + CALENDAR_STEP_PER_OP)).toBe(1);
    expect(calendarOpsFitting(CALENDAR_STEP_FIXED + 2 * CALENDAR_STEP_PER_OP + 1)).toBe(2);
    expect(calendarOpsFitting(REQUEST_BUDGET)).toBe(CALENDAR_OPS_PER_REQUEST);
    // The declared step: the measured fixed part (the reads, the list, the cursor) and each op (a Google call and its
    // writes), each with room to spare.
    expect(CALENDAR_STEP_FIXED).toBeGreaterThanOrEqual(13);
    expect(CALENDAR_STEP_PER_OP).toBeGreaterThanOrEqual(4);
  });

  it("one workout at a time asked for: approved and booked in the same request, within 45", async () => {
    const date = addDays(today, 2);
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date, time: "17:30" } }]);
    const res = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.remaining).toEqual([]);
    expect(res.waited).toBe(1);
    const [row] = await designRows();
    expect(google.inserted).toEqual([row!.id]);
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
  });

  it("a chunk that leaves ops remaining books nothing; the last one books what its room allows", async () => {
    const { id, opIds } = await designed(
      Array.from({ length: 3 }, (_, i) => ({ doc: calmDoc({ title: `Day ${i + 1}` }), target: { kind: "new" as const, date: addDays(today, i + 1), time: "17:30" } })),
    );
    const first = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(first.json.remaining.length).toBeGreaterThan(0);
    expect(first.waited).toBe(0);
    expect(google.inserted).toEqual([]);
    expect(first.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    const last = await invoke(`/api/coach/proposals/${id}/approve`, { opIds: first.json.remaining });
    expect(last.json.remaining).toEqual([]);
    expect(last.waited).toBe(1);
    expect(google.inserted.length).toBeGreaterThan(0);
    expect(google.inserted.length).toBeLessThanOrEqual(CALENDAR_OPS_PER_REQUEST);
    expect(last.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(opIds).toHaveLength(3);
  });

  it("a chunk with room left that still leaves an op remaining books nothing: the step is the loop's last request's", async () => {
    // A timed workout (16) leaves 22; a workout placed on a day of six sessions declares 24 and waits for the next request.
    const crowded = addDays(today, 5);
    await busyAccount([crowded]);
    await syncCalendar(db, makeEnv(), userId);
    google.inserted.length = 0;
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "Timed" }), target: { kind: "new", date: addDays(today, 2), time: "17:30" } },
      { doc: calmDoc({ title: "Placed" }), target: { kind: "new", date: crowded } },
    ]);
    const first = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(first.json.remaining).toEqual([opIds[1]]);
    expect(calendarOpsFitting(REQUEST_BUDGET - APPROVE_FIXED - 16)).toBeGreaterThan(0);
    expect(first.waited).toBe(0);
    expect(google.inserted).toEqual([]);
  });

  it("a request whose ops filled its room books nothing — the half-hourly reconcile does", async () => {
    // Six sessions on the day: a workout placed there declares its base and every one its collision pass could move, so
    // nothing is left for a calendar op.
    const crowded = addDays(today, 4);
    await busyAccount([crowded]);
    await syncCalendar(db, makeEnv(), userId);
    google.inserted.length = 0;
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date: crowded } }]);
    const res = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.applied).toHaveLength(1);
    expect(res.waited).toBe(0);
    expect(google.inserted).toEqual([]);
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
  });

  it("nothing written, nothing booked: a decline, a settled repeat, the designer off", async () => {
    const { id } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(today, 2), time: "17:30" } }]);
    expect((await invoke(`/api/coach/proposals/${id}/approve`, {}, false)).waited).toBe(0);
    const once = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(once.waited).toBe(1);
    const again = await invoke(`/api/coach/proposals/${id}/approve`, {});
    expect(again.status).toBe(200);
    expect(again.waited).toBe(0);
    const other = await designed([{ doc: calmDoc({ title: "Other" }), target: { kind: "new", date: addDays(today, 3), time: "17:30" } }]);
    expect((await invoke(`/api/coach/proposals/${other.id}/decline`, {})).waited).toBe(0);
  });

  it("the room is the approve's own: APPROVE_FIXED and what its ops declared", () => {
    // One timed create leaves room for a calendar op; the request's cap holds whatever the room.
    expect(REQUEST_BUDGET - APPROVE_FIXED - 16).toBeGreaterThanOrEqual(CALENDAR_STEP_FIXED + CALENDAR_STEP_PER_OP);
  });
});
