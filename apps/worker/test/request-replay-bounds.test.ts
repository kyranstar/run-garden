/**
 * A REQUEST NEVER RUNS A LONG GARDEN REPLAY (cron reliability, part 4).
 *
 * Parts 2–3 capped the garden's walk and replay in the crons and made a replay crash-safe (the day it must start from
 * goes on record — account_state.garden_changed_from — before anything is purged), but the requests that walk the
 * garden ran uncapped: the garden page (buildGardenView → advanceGarden) and every route that replays after a change
 * (plan.ts skip / unskip / match / unmatch / remove, the coach's approve). With a long replay on record — the owner
 * approved one of 69 days, to rewrite a stale checkpoint — ANY of those requests ran the whole of it in one invocation
 * (measured: ~64 ms of node CPU and ~830 D1 statements, several times what the free plan lets one invocation spend),
 * was killed, and the next request did the same. Matching a run from three weeks back replayed three-odd weeks.
 *
 * Every request now walks at most REQUEST_REPLAY_MAX_DAYS a call. The rest stays on record; the rendered garden
 * (garden_state) is the one it showed before the replay began until the walk passes it — never rewound (C21); and
 * requests and crons, taking turns, land exactly where one uncapped replay lands — also when one of them is killed.
 *
 * Dates are relative to the real clock (the routes read it): run it with the clock shifted too (shift-date.mjs).
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { gardenRoutes } from "../src/routes/garden.js";
import { planRoutes } from "../src/routes/plan.js";
import { coachRoutes } from "../src/routes/coach.js";
import { CRON_GARDEN_MAX_DAYS, REQUEST_REPLAY_MAX_DAYS, SWEEP_REPLAY_MAX_DAYS } from "../src/services/cron-limits.js";
import { advanceGarden, ensureGarden, recordReplayFrom, resimulateFrom } from "../src/services/garden-sync.js";
import { recordChunk } from "../src/services/backfill.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { gardenTimeline, replayMarker } from "./garden-compare.js";

const CAP = REQUEST_REPLAY_MAX_DAYS;

const ENV = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "0",
  SESSION_SECRET: "test-session-secret",
  TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

/** How long the pending replay is: what the owner approved (2026-08-01 → 2026-10-08). */
const REPLAY_DAYS = 69;

interface World {
  base: Db;
  userId: string;
  prefs: UserPreferences;
  cookie: string;
  today: string;
  /** The day the replay is on record from. */
  replayFrom: string;
  ids: { today: string; skipped: string; matchWorkout: string; matchActivity: string; matched: string; past: string };
}

async function insertActivity(db: Db, userId: string, date: string, sport: string, localTime = "07:00", extra: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: `${date}T${localTime}:00Z`,
    startTimeLocal: `${date}T${localTime}:00`,
    sport,
    durationSeconds: 2700,
    distanceMeters: sport === "run" ? 8000 : null,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...extra,
  });
  return id;
}

async function insertWorkout(db: Db, userId: string, date: string, state: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id.slice(0, 8)}`,
    title: "Tempo",
    category: "quality",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: state,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...extra,
  } as typeof schema.plannedWorkouts.$inferInsert);
  return id;
}

/**
 * A garden grown from eleven weeks back through yesterday on runs, lifts and yoga, with the rows the routes act on;
 * then a lift lands on the first day of the replay (so the replay changes the garden) and the replay goes on record.
 */
async function world(): Promise<World> {
  const base = makeTestDb({ boundVariableCap: 100 });
  const { userId, prefs } = await makeTestUser(base);
  const today = todayInZone(prefs.timezone);
  const genesis = addDays(today, -78);
  for (let d = 77; d >= 1; d--) {
    const k = d % 7;
    if (k === 0 || k === 2 || k === 4) await insertActivity(base, userId, addDays(today, -d), "run");
    if (k === 1) await insertActivity(base, userId, addDays(today, -d), "strength", "18:00");
    if (k === 5) await insertActivity(base, userId, addDays(today, -d), "yoga", "19:00");
  }
  const todayWorkout = await insertWorkout(base, userId, today, "scheduled");
  const skipped = await insertWorkout(base, userId, addDays(today, -30), "skipped", { resolutionDate: addDays(today, -30) });
  // A run three weeks back the garden credits as unplanned, and the session it belongs to.
  const matchDay = addDays(today, -21);
  const matchActivity = await insertActivity(base, userId, matchDay, "run", "06:10", { durationSeconds: 3000 });
  const matchWorkout = await insertWorkout(base, userId, matchDay, "unresolved");
  // A session matched forty days back (unmatch replays from it), and an open one 25 days back (remove does).
  const matchedDay = addDays(today, -40);
  const matched = await insertWorkout(base, userId, matchedDay, "completed", { resolutionDate: matchedDay });
  const matchedActivity = await insertActivity(base, userId, matchedDay, "run", "06:20", { completionMatchId: `m-${matchedDay}` });
  await base.insert(schema.workoutCompletionMatches).values({
    id: `m-${matchedDay}`,
    workoutId: matched,
    activityId: matchedActivity,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
  const past = await insertWorkout(base, userId, addDays(today, -25), "unresolved");

  await ensureGarden(base, userId, prefs, genesis);
  const grown = await advanceGarden(base, userId, prefs);
  expect(grown.lastSimulatedDate).toBe(addDays(today, -1));

  const replayFrom = addDays(today, -REPLAY_DAYS);
  await insertActivity(base, userId, replayFrom, "strength", "20:00");
  await recordReplayFrom(base, userId, replayFrom);
  const cookie = `${SESSION_COOKIE}=${await createSession(base, userId)}`;
  return {
    base,
    userId,
    prefs,
    cookie,
    today,
    replayFrom,
    ids: { today: todayWorkout, skipped, matchWorkout, matchActivity, matched, past },
  };
}

/** A copy of the world that counts the garden days each call walks (one day-input write a day). */
function counted(w: World, opts: { kill?: { at: number } } = {}) {
  const c = { days: 0, writes: 0, dead: false };
  const db = cloneTestDb(w.base, {
    boundVariableCap: 100,
    onStatement: (sql) => {
      if (c.dead) throw new Error("Exceeded CPU time limit (simulated kill)");
      if (/^insert into "garden_day_inputs"/i.test(sql)) c.days += 1;
      if (isWrite(sql) && !/"account_state"|"sessions"/.test(sql)) {
        c.writes += 1;
        // The invocation dies at this write: it and every statement after it fail, as on the platform.
        if (opts.kill && c.writes === opts.kill.at) {
          c.dead = true;
          throw new Error("Exceeded CPU time limit (simulated kill)");
        }
      }
    },
  });
  return {
    db,
    c,
    /** Run one call; how many garden days it walked. */
    async step(run: (db: Db) => unknown): Promise<number> {
      c.days = 0;
      await run(db);
      return c.days;
    },
  };
}

const json = (cookie: string, body?: unknown): RequestInit => ({
  method: "POST",
  headers: { Cookie: cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Every request that walks the garden, as the app makes it. */
function requests(w: World): Array<[string, (db: Db) => Response | Promise<Response>]> {
  const garden = (db: Db) => mountRoutes(db, "/api/garden", gardenRoutes);
  const plan = (db: Db) => mountRoutes(db, "/api/plan", planRoutes);
  return [
    ["GET /api/garden", (db) => garden(db).request("/api/garden", { headers: { Cookie: w.cookie } }, ENV)],
    ["POST skip (today)", (db) => plan(db).request(`/api/plan/workouts/${w.ids.today}/skip`, json(w.cookie), ENV)],
    ["POST unskip (30 days back)", (db) => plan(db).request(`/api/plan/workouts/${w.ids.skipped}/unskip`, json(w.cookie), ENV)],
    ["POST match (21 days back)", (db) => plan(db).request(`/api/plan/workouts/${w.ids.matchWorkout}/match`, json(w.cookie, { activityId: w.ids.matchActivity }), ENV)],
    ["POST unmatch (40 days back)", (db) => plan(db).request(`/api/plan/workouts/${w.ids.matched}/unmatch`, json(w.cookie), ENV)],
    ["POST remove (25 days back)", (db) => plan(db).request(`/api/plan/workouts/${w.ids.past}/remove`, json(w.cookie), ENV)],
    [
      "POST approve (a skip of today)",
      async (db) => {
        const id = newId();
        await db.insert(schema.coachProposals).values({
          id,
          userId: w.userId,
          title: "Proposal",
          evidence: "e",
          rationale: "r",
          flags: [],
          status: "pending",
          createdAt: nowInstant(),
          expiresAt: w.today,
          ops: [{ kind: "skip", workoutId: w.ids.today, reason: "tired" }],
        });
        return mountRoutes(db, "/api/coach", coachRoutes).request(`/api/coach/proposals/${id}/approve`, json(w.cookie), ENV);
      },
    ],
  ];
}

async function shown(db: Db, userId: string) {
  const [s] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
  return { day: s!.lastSimulatedDate, snapshot: s!.snapshot };
}

/** Every simulated day has its stored input: no purged day left unwritten. */
async function inputGaps(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ date: schema.gardenDayInputs.date })
    .from(schema.gardenDayInputs)
    .where(eq(schema.gardenDayInputs.userId, userId))
    .orderBy(asc(schema.gardenDayInputs.date));
  const gaps: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    for (let d = addDays(rows[i - 1]!.date, 1); d < rows[i]!.date; d = addDays(d, 1)) gaps.push(d);
  }
  return gaps;
}

describe("a request walks at most REQUEST_REPLAY_MAX_DAYS of garden, whatever is pending", () => {
  it("with a 69-day replay on record, every request path walks at most the cap and renders the garden it showed before", { timeout: 60_000 }, async () => {
    const w = await world();
    const before = await shown(w.base, w.userId);
    // What the garden page showed before the replay went on record (the same tables, minus the record).
    const pre = cloneTestDb(w.base);
    await pre.update(schema.accountState).set({ gardenChangedFrom: null }).where(eq(schema.accountState.userId, w.userId));
    const preView = (await (await mountRoutes(pre, "/api/garden", gardenRoutes).request("/api/garden", { headers: { Cookie: w.cookie } }, ENV)).json()) as {
      snapshot: unknown;
      previewEvents: unknown;
      condition: string;
    };

    const walked: Record<string, number> = {};
    for (const [name, call] of requests(w)) {
      const run = counted(w);
      let status = 0;
      walked[name] = await run.step(async (db) => {
        status = (await call(db)).status;
      });
      expect(status, name).toBe(200);
      // Never rewound, never moved while the replay is behind it.
      expect(await shown(run.db, w.userId), name).toEqual(before);
      expect(await replayMarker(run.db, w.userId), name).not.toBeNull();
      expect(await inputGaps(run.db, w.userId), name).toEqual([]);
      if (name === "GET /api/garden") {
        const view = (await (await mountRoutes(run.db, "/api/garden", gardenRoutes).request("/api/garden", { headers: { Cookie: w.cookie } }, ENV)).json()) as typeof preView;
        expect(view.snapshot).toEqual(preView.snapshot);
        expect(view.previewEvents).toEqual(preView.previewEvents);
        expect(view.condition).toBe(preView.condition);
        // The day slider: every simulated day, none skipped, ending where the garden shows.
        const timeline = (await (await mountRoutes(run.db, "/api/garden", gardenRoutes).request("/api/garden/timeline", { headers: { Cookie: w.cookie } }, ENV)).json()) as {
          days: Array<{ date: string }>;
        };
        const dates = timeline.days.map((d) => d.date);
        expect(dates.at(-1)).toBe(before.day);
        expect(dates.every((d, i) => i === 0 || d === addDays(dates[i - 1]!, 1))).toBe(true);
      }
    }
    console.log(`[requests] garden days walked per call with a ${REPLAY_DAYS}-day replay on record: ${JSON.stringify(walked)}`);
    for (const [name, days] of Object.entries(walked)) expect(days, name).toBeLessThanOrEqual(CAP);
    expect(walked["GET /api/garden"]).toBe(CAP);
  });

  it("the Backfill button's first chunk (its request's waitUntil) walks at most the cap too", { timeout: 60_000 }, async () => {
    const w = await world();
    const run = counted(w);
    const before = await shown(run.db, w.userId);
    const day = addDays(w.today, -50);
    const days = await run.step((db) =>
      recordChunk(db, w.userId, {
        chunkStart: addDays(w.today, -90),
        chunkEnd: w.today,
        activities: [
          {
            provider: "coros",
            providerActivityId: `bf-${day}`,
            startTime: `${day}T15:00:00Z`,
            startTimeLocal: `${day}T08:00:00`,
            timezone: "America/Los_Angeles",
            sport: "run",
            durationSeconds: 2800,
            elapsedSeconds: 2850,
            distanceMeters: 7600,
            contentFingerprint: `bf-${day}`,
          },
        ],
        lapsByProviderId: {},
        skippedSportTypes: {},
      }),
    );
    expect(days).toBeLessThanOrEqual(CAP);
    expect(await shown(run.db, w.userId)).toEqual(before);
    expect(await replayMarker(run.db, w.userId)).not.toBeNull();
  });

  it("with nothing pending, matching a run from three weeks back walks at most the cap; the next garden reads finish it", { timeout: 60_000 }, async () => {
    const w = await world();
    await w.base.update(schema.accountState).set({ gardenChangedFrom: null }).where(eq(schema.accountState.userId, w.userId));
    // The reference: the same match, its replay uncapped.
    const reference = cloneTestDb(w.base);
    const [match] = requests(w).filter(([n]) => n.startsWith("POST match"));
    await match![1](reference);
    const garden = (db: Db) => mountRoutes(db, "/api/garden", gardenRoutes).request("/api/garden", { headers: { Cookie: w.cookie } }, ENV);
    // The match leaves the rest of its replay on record; one uncapped walk finishes it, then the page's own heals.
    while ((await replayMarker(reference, w.userId)) !== null) await advanceGarden(reference, w.userId, w.prefs);
    await garden(reference);
    const expected = await gardenTimeline(reference, w.userId, { mondayCheckpointsOnly: true });

    const run = counted(w);
    const before = await shown(run.db, w.userId);
    const days = await run.step(async (db) => expect((await match![1](db)).status).toBe(200));
    expect(days).toBeLessThanOrEqual(CAP);
    expect(await shown(run.db, w.userId)).toEqual(before);
    for (let i = 0; i < 10 && (await replayMarker(run.db, w.userId)) !== null; i++) {
      expect(await run.step(garden)).toBeLessThanOrEqual(CAP);
    }
    expect(await replayMarker(run.db, w.userId)).toBeNull();
    expect(await gardenTimeline(run.db, w.userId, { mondayCheckpointsOnly: true })).toEqual(expected);
  });
});

describe("requests and crons taking turns finish a long replay exactly where one uncapped replay lands", () => {
  const gardenRead = (w: World) => (db: Db) => mountRoutes(db, "/api/garden", gardenRoutes).request("/api/garden", { headers: { Cookie: w.cookie } }, ENV);
  /** One uncapped replay, then a garden read with nothing left to walk (the page's own heals: start species). */
  async function reference(w: World) {
    const ref = cloneTestDb(w.base);
    await resimulateFrom(ref, w.userId, w.replayFrom, w.prefs);
    expect(await replayMarker(ref, w.userId)).toBeNull();
    await gardenRead(w)(ref);
    return gardenTimeline(ref, w.userId, { mondayCheckpointsOnly: true });
  }

  it("garden reads, hourly and sweep steps in turn: each within its cap, the rendered garden never rewound, the end byte-identical", { timeout: 60_000 }, async () => {
    const w = await world();
    const expected = await reference(w);
    const before = await shown(w.base, w.userId);
    const run = counted(w);
    const turns: Array<[string, number, (db: Db) => unknown]> = [
      ["garden read", CAP, gardenRead(w)],
      ["hourly", CRON_GARDEN_MAX_DAYS, (db) => advanceGarden(db, w.userId, w.prefs, new Date(), { maxWalkDays: CRON_GARDEN_MAX_DAYS, maxResimDays: CRON_GARDEN_MAX_DAYS })],
      ["sweep", SWEEP_REPLAY_MAX_DAYS, (db) => advanceGarden(db, w.userId, w.prefs, new Date(), { maxWalkDays: SWEEP_REPLAY_MAX_DAYS, maxResimDays: SWEEP_REPLAY_MAX_DAYS })],
    ];
    const log: string[] = [];
    for (let i = 0; i < 60 && (await replayMarker(run.db, w.userId)) !== null; i++) {
      const [name, cap, call] = turns[i % turns.length]!;
      const days = await run.step(call);
      log.push(`${name}:${days}`);
      expect(days, name).toBeLessThanOrEqual(cap);
      const now = await shown(run.db, w.userId);
      if ((await replayMarker(run.db, w.userId)) !== null) expect(now).toEqual(before); // behind it: untouched
      else expect(now.day >= before.day).toBe(true); // passed it: moved forward, never back
    }
    console.log(`[requests] turns to finish a ${REPLAY_DAYS}-day replay: ${log.join(" ")}`);
    expect(await replayMarker(run.db, w.userId)).toBeNull();
    expect(await gardenTimeline(run.db, w.userId, { mondayCheckpointsOnly: true })).toEqual(expected);
  });

  it("a request killed at any write of its step is resumed by the next: no day left without its input, the end byte-identical", { timeout: 120_000 }, async () => {
    const w = await world();
    const expected = await reference(w);
    const before = await shown(w.base, w.userId);
    // How many writes one request's step makes.
    const probe = counted(w);
    await probe.step(gardenRead(w));
    const writes = probe.c.writes;
    expect(writes).toBeGreaterThan(CAP);

    for (let k = 1; k <= writes; k++) {
      const run = counted(w, { kill: { at: k } });
      await run.step(gardenRead(w)).catch(() => undefined);
      run.c.dead = false;
      // The record survived; the rendered garden is where it was.
      expect(await replayMarker(run.db, w.userId)).not.toBeNull();
      expect(await shown(run.db, w.userId)).toEqual(before);
      // The next request resumes it: afterwards every day the garden has simulated has its input again.
      expect(await run.step(gardenRead(w))).toBeLessThanOrEqual(CAP);
      expect(await inputGaps(run.db, w.userId)).toEqual([]);
      for (let i = 0; i < 20 && (await replayMarker(run.db, w.userId)) !== null; i++) await run.step(gardenRead(w));
      expect(await replayMarker(run.db, w.userId)).toBeNull();
      expect(await gardenTimeline(run.db, w.userId, { mondayCheckpointsOnly: true }), `killed at write ${k}`).toEqual(expected);
    }
  });
});
