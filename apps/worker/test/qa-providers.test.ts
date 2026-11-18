/**
 * NO PROVIDER JOB, CALENDAR EVENT OR EXTERNAL CALL FOR THE QA ACCOUNT, EVEN ADVERSARIALLY (services/qa-account.ts): the QA
 * account is given what no route can give it — a connected COROS account and Google Calendar (tokens and all), COROS writes
 * on and a calendar chosen — and every switch is on (the watch, the coach designer, plan drafts, AI with a key). Then its
 * phone does everything a phone can (every fixture moved, skipped and put back, Build, Start, a save, the watch drain, a
 * document edit), and every cron runs. `fetch` is never called; no `coros_write_jobs`, `calendar_event_links`,
 * `studio_plan_pushes`, `sync_runs`, coach run, weekly review or model use row exists for it; and the crons leave its tables
 * exactly as they were. The owner's account is inert here (no connections, AI off), so any call would be the QA account's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, performedSessionSaveSchema } from "@rg/domain";
import { encryptSecret } from "../src/auth/crypto.js";
import { halfHourly, hourly, weekly } from "../src/index.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { googleCalendarClient } from "../src/services/google-calendar.js";
import { corosClient } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { tableHashes } from "../src/services/parity.js";
import { createQaUser, mintQaPairing, seedQaFixtures, type QaFixture, type QaTarget } from "../src/services/qa-account.js";
import { pinMiddayToday } from "./helpers.js";
import { nativeWorld, type NativeWorld } from "./native-fixture.js";

const { calendarEventLinks, coachRuns, corosWriteJobs, llmUsage, plannedWorkouts, providerConnections, studioPlanPushes, syncRuns, weeklyReviews } = schema;

const SWITCHES = {
  WATCH_PUSH_ENABLED: "1",
  COACH_DESIGNER: "1",
  PLAN_DRAFTS: "1",
  AI_DEFAULT_ENABLED: "1",
  AI_GATEWAY_API_KEY: "synthetic-key",
  AI_GATEWAY_BASE_URL: "https://gateway.invalid/v1",
  COROS_MCP_URL: "https://coros-mcp.invalid",
  COROS_MCP_TOKEN: "synthetic",
} as const;

let today: string;
let w: NativeWorld;
let qa: QaTarget;
let fixtures: QaFixture[];
let token: string;
let fetched: string[];

/** What no route can do: the QA account connected to COROS and Google Calendar, with writes on and a calendar chosen. */
async function plantProviders(userId: string): Promise<void> {
  const key = w.env.TOKEN_ENCRYPTION_KEY;
  const now = nowInstant();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await w.db.insert(providerConnections).values([
    {
      id: newId(), userId, provider: "coros", status: "connected", createdAt: now, updatedAt: now, meta: { email: "qa@example.test", region: "us" },
      externalAccountId: "qa-coros", encryptedAccessToken: await encryptSecret("coros-access", key), encryptedRefreshToken: await encryptSecret("md5", key), accessTokenExpiresAt: later,
    },
    {
      id: newId(), userId, provider: "google_calendar", status: "connected", createdAt: now, updatedAt: now, externalAccountId: "qa@example.test",
      encryptedAccessToken: await encryptSecret("google-access", key), encryptedRefreshToken: await encryptSecret("google-refresh", key), accessTokenExpiresAt: later,
    },
  ]);
  await savePreferences(w.db, userId, { ...(await loadPreferences(w.db, userId)), corosWritesEnabled: true, calendarId: "qa-calendar", aiEnabled: true });
}

beforeEach(async () => {
  today = pinMiddayToday();
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error("no external call for the QA account");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/native", nativeRoutes],
      ["/api/plan", planRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/workouts", workoutRoutes],
    ],
    { env: SWITCHES },
  );
  // The owner, inert: no connection, AI off — so a call here could only be the QA account's.
  await savePreferences(w.db, w.userId, { ...(await loadPreferences(w.db, w.userId)), aiEnabled: false });
  qa = await createQaUser(w.db, w.env, w.userId);
  ({ fixtures } = await seedQaFixtures(w.db, w.env, qa));
  await plantProviders(qa.userId);
  const minted = await mintQaPairing(w.db, w.env, qa);
  if ("refused" in minted) throw new Error("refused");
  token = (await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.code, label: "LifeOS phone" } })).json.token;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const as = (method: string, path: string, body?: unknown) => w.call(method, path, { bearer: token, ...(body === undefined ? {} : { body }) });

async function providerRows(userId: string) {
  const ids = (await w.db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).map((r) => r.id);
  return {
    corosWriteJobs: (await w.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).length,
    calendarEventLinks: ids.length ? (await w.db.select().from(calendarEventLinks).where(inArray(calendarEventLinks.workoutId, ids))).length : 0,
    studioPlanPushes: (await w.db.select().from(studioPlanPushes)).length,
    syncRuns: (await w.db.select().from(syncRuns).where(eq(syncRuns.userId, userId))).length,
    coachRuns: (await w.db.select().from(coachRuns).where(eq(coachRuns.userId, userId))).length,
    weeklyReviews: (await w.db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, userId))).length,
    llmUsage: (await w.db.select().from(llmUsage).where(eq(llmUsage.userId, userId))).length,
  };
}
const NONE = { corosWriteJobs: 0, calendarEventLinks: 0, studioPlanPushes: 0, syncRuns: 0, coachRuns: 0, weeklyReviews: 0, llmUsage: 0 };

describe("the provider boundary refuses the QA account, connection rows or not", () => {
  it("no Google Calendar or COROS client, no calendar sync, no cloud job run", async () => {
    expect(await googleCalendarClient(w.db, w.env, qa.userId)).toBeNull();
    expect(await corosClient(w.db, w.env, qa.userId)).toBeNull();
    expect((await syncCalendar(w.db, w.env, qa.userId)).skipped).toBe(true);
    expect((await executeCloudJobs(w.db, w.env, qa.userId, await loadPreferences(w.db, qa.userId))).executed).toBe(0);
    expect(fetched).toEqual([]);
  });
});

describe("everything the QA phone can do, every switch on", () => {
  it("writes no provider job or calendar event, and calls nothing outside", async () => {
    const todays = fixtures.filter((f) => f.date === today);
    for (const f of todays) {
      const to = `${String(Math.min(22, Number(f.time.slice(0, 2)) + 1)).padStart(2, "0")}:30`;
      const moved = await as("POST", `/api/plan/workouts/${f.id}/move`, { toDate: today, toTime: to, from: { date: today, time: f.time } });
      expect([f.title, moved.status], moved.text).toEqual([f.title, 200]);
      expect(moved.json.watchDrain, "no watch copy to take off").toBeUndefined();
      expect((await as("POST", `/api/plan/workouts/${f.id}/skip`)).status).toBe(200);
      expect((await as("POST", `/api/plan/workouts/${f.id}/unskip`)).status).toBe(200);
    }
    const hips = fixtures.find((f) => f.title === "QA Hips and back")!;
    const slot = fixtures.find((f) => f.kind === "programme_slot" && f.date === today)!;
    expect((await as("POST", `/api/sessions/${slot.id}/build`, {})).status).toBe(200);
    const built = await as("POST", `/api/sessions/${hips.id}/build`, {});
    expect(built.status, built.text).toBe(200);
    const b = built.json.build;
    expect((await as("POST", `/api/sessions/${hips.id}/start`, { buildId: b.buildId })).status).toBe(200);
    const items = (b.items ?? []) as Array<{ exerciseId: string }>;
    const id = newId();
    const save = performedSessionSaveSchema.parse({
      id, source: "app", sourceRef: null, workoutId: hips.id, buildId: b.buildId, localDate: b.date, startedAt: new Date(Date.now() - 600_000).toISOString(),
      endedAt: new Date().toISOString(), seconds: 600, plannedSeconds: b.plannedSeconds ?? null, minutes: b.minutes ?? null, mode: b.mode ?? null, theme: b.theme ?? null,
      locationId: b.locationId ?? null, blockRef: b.blockRef ?? null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
      movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 60 })), note: null, newMove: b.newMove ?? null, entries: [], checks: [], review: {},
    });
    expect((await as("PUT", `/api/sessions/performed/${id}`, save)).json.status).toBe("saved");
    // The watch drain: the watch is off for the QA account's requests, so it is the switch-off 404, as on a deployment
    // without the watch (and no move above answered `watchDrain`, so the phone never asks).
    expect((await as("POST", "/api/sessions/watch/drain", { workoutId: hips.id })).json).toEqual({ error: "not_found" });
    // A document edit (v3) of tomorrow's.
    const core = fixtures.find((f) => f.title === "QA Core reset")!;
    const doc = await as("GET", `/api/workouts/${core.id}/doc`);
    expect(doc.status, doc.text).toBe(200);
    const edited = await as("PUT", `/api/workouts/${core.id}/doc`, { doc: { ...doc.json.doc, title: "QA Core reset, shorter" }, baseRev: doc.json.rev });
    expect(edited.status, edited.text).toBe(200);
    expect(await providerRows(qa.userId)).toEqual(NONE);
    expect(fetched).toEqual([]);
  });
});

describe("the crons never see the QA account", () => {
  it("half-hourly, hourly and weekly leave its tables exactly as they were, write no run row for it and call nothing", async () => {
    const before = await tableHashes(w.db, qa.userId);
    await halfHourly(w.db, w.env);
    await hourly(w.db, w.env);
    await weekly(w.db, w.env);
    expect(await tableHashes(w.db, qa.userId)).toEqual(before);
    expect(await providerRows(qa.userId)).toEqual(NONE);
    expect(fetched).toEqual([]);
    // …while the owner's account is still worked on (its run rows), so the crons did run.
    expect((await w.db.select().from(syncRuns).where(and(eq(syncRuns.userId, w.userId)))).length).toBeGreaterThan(0);
  });
});
