/**
 * THE SESSION GUARD. A completed session's credit can't be duplicated or lost by moving or skipping it, and a session under
 * way can't be moved or skipped out from under the device playing it, whatever client calls the route.
 *
 * Through the real route handlers, on the repo's migrations, under a faked `Date`, D1's bind cap on. Each comparison is of the
 * records themselves: per-activity credits, source ids, the row, the matches, the garden's counters. A matching final hash can
 * hide one lost credit offset by a duplicate, so no test here rests on one. Synthetic data only; `fetch` is stubbed.
 *
 * WHAT THE CONCURRENCY TESTS CAN SHOW: one process, one connection. The orderings are forced with gates between a route's read
 * and its write. Not shown: D1's network, retries, two isolates, replicas.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, performedSessionSaveSchema, type SourceActivity, type UserPreferences } from "@rg/domain";

/** Hold a request between a route's read and its write. A test sets one, and it clears itself. */
const gates = vi.hoisted(() => ({
  /**
   * `applyMove`, after its read of the row and before any write of it: at `sentBuildIdOf`, which a move to another day of a
   * session the app built reads first (a guarded move writes its row next; an unguarded one, the override and the intent).
   */
  move: null as null | (() => Promise<void>),
  /** `skipWorkout` and `removeFromPlan`, before their writes. */
  mutation: null as null | (() => Promise<void>),
}));

vi.mock("../src/services/session-build.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/session-build.js")>();
  return {
    ...real,
    sentBuildIdOf: async (...args: Parameters<typeof real.sentBuildIdOf>) => {
      const hold = gates.move;
      gates.move = null;
      if (hold) await hold();
      return real.sentBuildIdOf(...args);
    },
  };
});
vi.mock("../src/services/plan-mutations.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/plan-mutations.js")>();
  const held = async () => {
    const hold = gates.mutation;
    gates.mutation = null;
    if (hold) await hold();
  };
  return {
    ...real,
    skipWorkout: async (...args: Parameters<typeof real.skipWorkout>) => {
      await held();
      return real.skipWorkout(...args);
    },
    removeFromPlan: async (...args: Parameters<typeof real.removeFromPlan>) => {
      await held();
      return real.removeFromPlan(...args);
    },
  };
});

import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { syncRoutes } from "../src/routes/sync.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { ingestActivities } from "../src/services/completion.js";
import type { Db } from "../src/services/db.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { advanceGarden, ensureGarden, firstDayToReplay, recordReplayFrom, REQUEST_GARDEN_STEP, resimulateFrom } from "../src/services/garden-sync.js";
import { planAdjustId } from "../src/services/proposal-kinds.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { syncCalendar } from "../src/services/calendar-sync.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { postSyncNote } from "../src/services/sync-notes.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { FakeGoogle } from "./fake-google-calendar.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachProposals, coachRuns, corosWriteJobs, plannedWorkouts, providerConnections, syncIntents, syncNotes, trainingPlans } = schema;

const eqId = (id: string) => eq(plannedWorkouts.id, id);
const LA = "America/Los_Angeles";
const GENESIS = "2026-11-02"; // a Monday
const FRI = "2026-11-13";
const MON = "2026-11-16";
const TUE = "2026-11-17";
const D = "2026-11-18"; // a Wednesday

const instant = (date: string, hhmm: string): string => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const setClock = (date: string, hhmm: string) => vi.setSystemTime(new Date(instant(date, hhmm)));

const env = {
  DB: {},
  ASSETS: {},
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  WATCH_PUSH_ENABLED: "1",
  COACH_DESIGNER: "1",
} as unknown as Env;

interface Answer {
  status: number;
  json: Record<string, any>;
  writes: string[];
}
interface World {
  db: Db;
  userId: string;
  cookie: string;
  statements: string[];
  call: (method: string, path: string, body?: unknown) => Promise<Answer>;
}

function bind(db: Db, userId: string, cookie: string, statements: string[]): World {
  const app = mountRoutes(db, "/api/plan", planRoutes);
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/workouts", workoutRoutes);
  app.route("/api/coach", coachRoutes);
  app.route("/api/sync", syncRoutes);
  return {
    db,
    userId,
    cookie,
    statements,
    call: async (method, path, body) => {
      const pending: Promise<unknown>[] = [];
      const from = statements.length;
      // As an old cached bundle or a direct API call reaches it: the session cookie, no Origin, nothing else to go on.
      const res = await app.request(
        path,
        { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} } as never,
      );
      await Promise.allSettled(pending);
      const text = await res.text();
      let json: Record<string, any> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { text };
      }
      return { status: res.status, json, writes: statements.slice(from).filter(isWrite) };
    },
  };
}

let migrated: Db;
beforeAll(() => {
  migrated = makeTestDb();
});

async function world(prefs: Partial<UserPreferences> = {}): Promise<World> {
  setClock(GENESIS, "12:00");
  const statements: string[] = [];
  const db = cloneTestDb(migrated, { boundVariableCap: 100, onStatement: (s) => void statements.push(s) });
  const { userId } = await makeTestUser(db, { timezone: LA, ...prefs });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const w = bind(db, userId, cookie, statements);
  await db.insert(trainingPlans).values({ id: `plan-${userId.slice(0, 8)}`, userId, sourcePlanId: "guard-plan", name: "Synthetic plan", startDate: "2026-10-20", endDate: "2026-12-31", status: "active", createdAt: nowInstant(), updatedAt: nowInstant() });
  await ensureGarden(db, userId, await loadPreferences(db, userId), GENESIS);
  return w;
}

/** An exact copy as it stands: same ids, so two branches can be compared. */
function fork(w: World): World {
  const statements: string[] = [];
  return bind(cloneTestDb(w.db, { boundVariableCap: 100, onStatement: (s) => void statements.push(s) }), w.userId, w.cookie, statements);
}

const raw = (w: World) => (w.db as unknown as { $client: { prepare(sql: string): { all(...a: unknown[]): any[]; run(...a: unknown[]): unknown } } }).$client;
const q = (w: World, text: string, ...args: unknown[]): any[] => raw(w).prepare(text).all(...args);

async function advance(w: World): Promise<void> {
  const prefs = await loadPreferences(w.db, w.userId);
  for (let i = 0; i < 40; i++) {
    const r = await advanceGarden(w.db, w.userId, prefs, new Date(), REQUEST_GARDEN_STEP);
    if (!r.resimPending && r.simulatedDays === 0) return;
  }
  throw new Error("the garden never settled");
}
/** The hourly's plan and garden passes. */
async function hourly(w: World): Promise<void> {
  await reconcileCompletionStates(w.db, w.userId, await loadPreferences(w.db, w.userId));
  await advance(w);
}
async function drive(w: World, from: string, to: string): Promise<void> {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    setClock(d, "03:15");
    await hourly(w);
  }
}

/** The COROS reader's part after the wire (`corosReadNow`): the new days on record, the ingest, one capped replay. */
async function corosReport(w: World, sources: SourceActivity[]): Promise<void> {
  const prefs = await loadPreferences(w.db, w.userId);
  const seen = new Set(q(w, `select provider_activity_id as id from activity_source_links l join activities a on a.id = l.activity_id where l.provider='coros' and a.user_id = ?`, w.userId).map((r) => r.id as string));
  const newDays = new Set(sources.filter((a) => !seen.has(a.providerActivityId)).map((a) => (a.startTimeLocal ?? a.startTime).slice(0, 10)));
  const first = [...newDays].sort()[0];
  if (first !== undefined) await recordReplayFrom(w.db, w.userId, first);
  const stats = await ingestActivities(w.db, { userId: w.userId, sources });
  const earliest = await firstDayToReplay(w.db, w.userId, stats.affectedDates, newDays, prefs);
  if (earliest) await resimulateFrom(w.db, w.userId, earliest, prefs, new Date(), REQUEST_GARDEN_STEP);
}
const corosSource = (o: { label: string; date: string; hhmm: string; seconds: number; sport: string }): SourceActivity =>
  ({
    provider: "coros",
    providerActivityId: o.label,
    startTime: DateTime.fromISO(`${o.date}T${o.hhmm}`, { zone: LA }).toUTC().toISO({ suppressMilliseconds: true })!,
    startTimeLocal: `${o.date}T${o.hhmm}:00`,
    sport: o.sport,
    durationSeconds: o.seconds,
    avgHeartRate: 104,
    title: "Synthetic watch session",
    contentFingerprint: `fp-${o.label}`,
  }) as SourceActivity;

/** A Studio workout on `day`, made through the route the day before. */
async function slotOn(w: World, day: string, over: Record<string, unknown> = {}): Promise<string> {
  setClock(addDays(day, -1), "12:00");
  await hourly(w);
  const made = await w.call("POST", "/api/workouts", { doc: calmDoc(), date: day, time: "18:00", clientId: `slot-${newId()}`, ...over });
  expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
  return made.json.workout.id as string;
}

async function buildAndStart(w: World, id: string): Promise<any> {
  const built = await w.call("POST", `/api/sessions/${id}/build`, {});
  expect(built.status, JSON.stringify(built.json)).toBe(200);
  const started = await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId });
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  return started.json.build;
}

/** What the outbox sends. */
function wire(o: { id: string; workoutId: string; build: any; startedAt: string; endedAt: string; localDate?: string }) {
  const b = o.build;
  const items = (b?.items ?? []) as Array<{ exerciseId: string; slotKey?: string }>;
  const first = items[0]?.exerciseId ?? "bridge";
  return performedSessionSaveSchema.parse({
    id: o.id, source: "app", sourceRef: null, workoutId: o.workoutId, buildId: b?.buildId ?? null, localDate: o.localDate ?? b?.date,
    startedAt: o.startedAt, endedAt: o.endedAt, seconds: 1800, plannedSeconds: b?.plannedSeconds ?? 1800, minutes: b?.minutes ?? 30, mode: b?.mode ?? "build",
    theme: b?.theme ?? null, locationId: b?.locationId ?? null, blockRef: b?.blockRef ?? null, blockNumber: null, completed: true, stepsTotal: (b?.steps ?? []).length || 1, stepsDone: (b?.steps ?? []).length || 1,
    movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
    note: null, newMove: b?.newMove ?? null,
    entries: [{ exerciseId: first, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
    checks: [], review: {},
  });
}

async function saved(w: World, id: string, build: any, day: string, performedId = `p-${id}`): Promise<Answer> {
  setClock(day, "18:45");
  return w.call("PUT", `/api/sessions/performed/${performedId}`, wire({ id: performedId, workoutId: id, build, startedAt: instant(day, "18:00"), endedAt: instant(day, "18:30") }));
}

/**
 * THE RECORD, whatever a final hash says: each day's credits and debits by activity, the garden's events, its counters, the
 * row, the sessions, the activities by their source ids, the matches. Activity ids read as their sources, so two branches that
 * each made a row of the same report compare equal.
 */
function record(w: World) {
  const links = q(w, `select l.provider, l.provider_activity_id as pid, l.activity_id as aid from activity_source_links l join activities a on a.id = l.activity_id where a.user_id = ? order by l.provider, l.provider_activity_id`, w.userId);
  const nameOf = (aid: string | null): string | null => {
    if (aid === null) return null;
    const names = links.filter((l) => l.aid === aid).map((l) => `${l.provider}:${l.pid}`);
    return names.length ? names.join("+") : aid;
  };
  const named = (id: unknown): unknown => (typeof id === "string" && id.startsWith("unplanned-") ? `unplanned-${nameOf(id.slice("unplanned-".length))}` : id);
  const [s] = q(w, `select snapshot, last_simulated_date as last from garden_state where user_id = ?`, w.userId);
  const snap = JSON.parse(s.snapshot);
  return {
    credits: q(w, `select id, input from garden_day_inputs where id like ? order by id`, `${w.userId}:%`).flatMap((r) => {
      const i = JSON.parse(r.input);
      const date = (r.id as string).slice(w.userId.length + 1);
      const completed = (i.completedRuns as Array<Record<string, any>>).map((c) => ({ workoutId: named(c.workoutId), activityId: nameOf(c.activityId ?? null), discipline: c.discipline ?? "run", unplanned: c.unplanned === true }));
      return completed.length + (i.missedRuns ?? []).length > 0 ? [{ date, completed, missed: i.missedRuns ?? [] }] : [];
    }),
    events: q(w, `select date, kind, workout_id as w, activity_id as a from garden_events where user_id = ? and (workout_id is not null or activity_id is not null) order by date, seq`, w.userId).map((e) => ({ date: e.date, kind: e.kind, workout: named(e.w), activity: nameOf(e.a) })),
    counters: { strength: snap.state.strengthSessionCount, yoga: snap.state.yogaSessionCount, runs: snap.state.totalCompletedRuns, long: snap.state.longRunCount, last: s.last },
    rows: q(w, `select id, effective_date as date, effective_time as time, completion_state as completion, content_state as content, resolution_date as resolution, archived_at is not null as archived from planned_workouts where user_id = ? order by id`, w.userId),
    sessions: q(w, `select id, workout_id as workout, source, local_date as day, activity_id as a from performed_sessions where user_id = ? order by id`, w.userId).map((p) => ({ ...p, a: nameOf(p.a) })),
    activities: q(w, `select id, source, sport, start_time_local as at, duration_seconds as seconds, completion_match_id is not null as matched from activities where user_id = ? order by start_time, id`, w.userId).map((a) => ({ ...a, id: nameOf(a.id) })),
    matches: q(w, `select workout_id as workout, activity_id as a, method, undone_at is not null as undone from workout_completion_matches where workout_id in (select id from planned_workouts where user_id = ?) order by rowid`, w.userId).map((m) => ({ ...m, a: nameOf(m.a) })),
  };
}

/** The same world's garden replayed from genesis: what the live tables say, whatever the walk left. */
async function replayed(w: World) {
  const t = fork(w);
  await resimulateFrom(t.db, t.userId, GENESIS, await loadPreferences(t.db, t.userId));
  await advance(t);
  return record(t);
}

const rowOf = (w: World, id: string) => q(w, `select effective_date as date, effective_time as time, completion_state as completion, content_state as content, archived_at is not null as archived, resolution_date as resolution, last_verified_coros_date as lvd from planned_workouts where id = ?`, id)[0];
const overrides = (w: World, id: string) => q(w, `select count(*) as n from schedule_overrides where workout_id = ?`, id)[0].n as number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  gates.move = null;
  gates.mutation = null;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const COMPLETED_ANSWER = expect.objectContaining({ error: "session_completed", why: expect.any(String) });
const UNDER_WAY_ANSWER = expect.objectContaining({ error: "session_under_way", why: expect.stringContaining("may still be running") });

// ── A completed session ──────────────────────────────────────────────────────────────────────────────────────────────

async function savedOn(day: string): Promise<{ w: World; id: string; performedId: string }> {
  const w = await world();
  const id = await slotOn(w, day);
  setClock(day, "18:00");
  const build = await buildAndStart(w, id);
  const answer = await saved(w, id, build, day);
  expect(answer.status, JSON.stringify(answer.json)).toBe(200);
  return { w, id, performedId: `p-${id}` };
}

describe("a completed session stays where its credit is", () => {
  it("the original double credit, through the routes: saved Friday, moved ahead across a Monday, the walk reaches the new day: one credit, on Friday", async () => {
    const { w, id } = await savedOn(FRI);
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    const control = fork(w);
    setClock(addDays(FRI, 2), "12:00");
    const answer = await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: TUE, toTime: "18:00" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(COMPLETED_ANSWER);
    expect(answer.writes).toEqual([]);
    expect(rowOf(w, id)).toMatchObject({ date: FRI, completion: "completed", content: "done" });
    await drive(w, addDays(FRI, 3), addDays(TUE, 3));
    await drive(control, addDays(FRI, 3), addDays(TUE, 3));
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.counters.strength + after.counters.yoga).toBe(1);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId, x.unplanned]))).toEqual([[FRI, id, false]]);
    expect((await replayed(w)).credits).toEqual(after.credits);
  });

  it("moved across a Monday with a replay after it: refused, no double credit; the report's credit stands apart", async () => {
    const { w, id } = await savedOn(FRI);
    await drive(w, addDays(FRI, 1), addDays(MON, 3));
    const control = fork(w);
    setClock(addDays(MON, 3), "09:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: TUE, toTime: "18:00" })).status).toBe(409);
    const trigger = () => [corosSource({ label: "lbl-trigger", date: TUE, hhmm: "07:00", seconds: 1500, sport: "run" })];
    setClock(addDays(MON, 3), "10:00");
    await corosReport(w, trigger());
    await corosReport(control, trigger());
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.counters.strength + after.counters.yoga).toBe(1);
    expect(after.credits.filter((c) => c.date === TUE).flatMap((c) => c.completed.map((x) => x.workoutId))).toEqual(["unplanned-coros:lbl-trigger"]);
  });

  it("moved back across a Monday with a replay after it: refused, the credit isn't lost", async () => {
    const { w, id } = await savedOn(TUE);
    await drive(w, addDays(TUE, 1), addDays(TUE, 2));
    const control = fork(w);
    setClock(addDays(TUE, 2), "09:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: FRI, toTime: "18:00" })).status).toBe(409);
    const trigger = () => [corosSource({ label: "lbl-trigger2", date: addDays(TUE, 1), hhmm: "07:00", seconds: 1500, sport: "run" })];
    setClock(addDays(TUE, 2), "10:00");
    await corosReport(w, trigger());
    await corosReport(control, trigger());
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.counters.strength + after.counters.yoga).toBe(1);
    expect(after.credits.filter((c) => c.date === TUE).flatMap((c) => c.completed.map((x) => x.workoutId))).toEqual([id]);
  });

  /** A long run the watch reports, matched by the ingest: the row a stale tab's Move reaches. */
  async function matchedRun(): Promise<{ w: World; id: string }> {
    const w = await world();
    const id = "guard-run";
    await w.db.insert(plannedWorkouts).values({
      id, userId: w.userId, planId: "guard-plan-row", sourceWorkoutId: "4738:2", title: "Long run", category: "long", sport: "run", originalPlanDate: FRI, lastVerifiedCorosDate: FRI, effectiveDate: FRI, effectiveTime: "07:00",
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, fallbackEstimatedDurationSeconds: 3600, createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await drive(w, addDays(FRI, -2), FRI);
    setClock(FRI, "12:00");
    await corosReport(w, [corosSource({ label: "lbl-long", date: FRI, hhmm: "07:05", seconds: 3550, sport: "run" })]);
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    return { w, id };
  }

  it("a run the watch reported, moved ahead: refused; one planned credit, by its one source id; runs and long runs stay one", async () => {
    const { w, id } = await matchedRun();
    const control = fork(w);
    setClock(addDays(FRI, 2), "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: TUE, toTime: "07:00" })).status).toBe(409);
    await drive(w, addDays(FRI, 3), addDays(TUE, 3));
    await drive(control, addDays(FRI, 3), addDays(TUE, 3));
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.counters).toMatchObject({ runs: 1, long: 1 });
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId, x.activityId]))).toEqual([[FRI, id, "coros:lbl-long"]]);
  });

  it("an app session auto-matched by the watch (`completed` and still an outline, the row SessionSheet offers Move on): refused", async () => {
    const w = await world();
    const id = await slotOn(w, FRI);
    setClock(FRI, "20:00");
    await corosReport(w, [corosSource({ label: "lbl-app", date: FRI, hhmm: "18:01", seconds: 1790, sport: "strength" })]);
    const row = rowOf(w, id);
    expect(row.completion).toBe("completed");
    expect(["outline", "built", null]).toContain(row.content);
    const control = fork(w);
    const answer = await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(FRI, 1), toTime: "18:00" });
    expect([answer.status, answer.writes]).toEqual([409, []]);
    await drive(w, addDays(FRI, 1), addDays(FRI, 4));
    await drive(control, addDays(FRI, 1), addDays(FRI, 4));
    expect(record(w)).toEqual(record(control));
  });

  it.each([
    ["skip", "/skip", undefined],
    ["remove", "/remove", undefined],
  ] as const)("/%s on a completed session: refused in words, nothing written, the record unchanged; again, the same", async (_name, path, body) => {
    const { w, id } = await savedOn(FRI);
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    const before = record(w);
    setClock(addDays(FRI, 2), "12:00");
    for (let i = 0; i < 2; i++) {
      const answer = await w.call("POST", `/api/plan/workouts/${id}${path}`, body);
      expect(answer.status).toBe(409);
      expect(answer.json).toEqual(COMPLETED_ANSWER);
      expect(answer.writes).toEqual([]);
    }
    expect(record(w)).toEqual(before);
  });

  it("/move twice, from a stale tab: refused each time, no override and no intent left behind", async () => {
    const { w, id } = await savedOn(FRI);
    const overridesBefore = overrides(w, id);
    for (const toDate of [addDays(FRI, 2), addDays(FRI, -1)]) {
      setClock(FRI, "19:00");
      expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate, toTime: "18:00" })).status).toBe(409);
    }
    expect(overrides(w, id)).toBe(overridesBefore);
    expect(rowOf(w, id)).toMatchObject({ date: FRI });
  });

  it("/defer is gone: 404, and a completed row stays completed", async () => {
    const { w, id } = await savedOn(FRI);
    const answer = await w.call("POST", `/api/plan/workouts/${id}/defer`);
    expect(answer.status).toBe(404);
    expect(answer.writes).toEqual([]);
    expect(rowOf(w, id).completion).toBe("completed");
  });
});

describe("a move's date", () => {
  it.each(["not-a-date", "", "2026-13-40", "2026-02-30", "18/11/2026", "2026-11-18T10:00:00"])("%j: 400 `invalid_request`, nothing written, nothing stored", async (toDate) => {
    const w = await world();
    const id = await slotOn(w, D);
    const answer = await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate, toTime: "18:00" });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toBe("invalid_request");
    expect(answer.writes).toEqual([]);
    expect(rowOf(w, id).date).toBe(D);
  });
});

// ── A session under way ──────────────────────────────────────────────────────────────────────────────────────────────

async function startedOn(day: string): Promise<{ w: World; id: string; build: any }> {
  const w = await world();
  const id = await slotOn(w, day);
  setClock(day, "18:00");
  const build = await buildAndStart(w, id);
  return { w, id, build };
}

describe("a session under way: the routes refuse while its save would land", () => {
  const ROUTES: Array<[string, string, Record<string, string> | undefined]> = [
    ["move", "move", { toDate: addDays(D, 4), toTime: "18:00" }],
    ["skip", "skip", undefined],
    ["remove", "remove", undefined],
  ];

  it.each(ROUTES)("/%s on its day and the next: refused in the honest words, nothing written", async (_name, route, body) => {
    const { w, id } = await startedOn(D);
    const before = rowOf(w, id);
    for (const [day, hhmm] of [[D, "18:05"], [addDays(D, 1), "23:50"]] as const) {
      setClock(day, hhmm);
      const answer = await w.call("POST", `/api/plan/workouts/${id}/${route}`, body);
      expect(answer.status).toBe(409);
      expect(answer.json).toEqual(UNDER_WAY_ANSWER);
      expect(answer.writes).toEqual([]);
      expect(rowOf(w, id)).toEqual(before);
    }
  });

  it.each(ROUTES)("/%s past its window (the day after next): no longer refused; the API opens, as the save's day has passed", async (_name, route, body) => {
    const { w, id } = await startedOn(D);
    setClock(addDays(D, 2), "00:05");
    const answer = await w.call("POST", `/api/plan/workouts/${id}/${route}`, body);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
  });

  it("the main line: Start, the laptop's refused move, skip and remove, repeated, then the phone's save: one session, one credit, on its day, retry `same_payload`; as if nobody had tried", async () => {
    const { w, id, build } = await startedOn(D);
    const control = fork(w);
    setClock(D, "18:10");
    for (const path of ["move", "skip", "remove", "move", "skip", "remove"]) {
      const answer = await w.call("POST", `/api/plan/workouts/${id}/${path}`, path === "move" ? { toDate: addDays(D, 2), toTime: "18:00" } : undefined);
      expect(answer.status).toBe(409);
    }
    const first = await saved(w, id, build, D);
    expect(first.json.status).toBe("saved");
    const retry = await saved(w, id, build, D);
    expect(retry.json.status).toBe("same_payload");
    await saved(control, id, build, D);
    await drive(w, addDays(D, 1), addDays(D, 3));
    await drive(control, addDays(D, 1), addDays(D, 3));
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.sessions).toHaveLength(1);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId, x.unplanned]))).toEqual([[D, id, false]]);
    expect((await replayed(w)).credits).toEqual(after.credits);
    // Saved, it is done: the completed refusal now, past any window.
    setClock(addDays(D, 3), "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 5), toTime: "18:00" })).json).toEqual(COMPLETED_ANSWER);
  });

  it("a slot not started, and one discarded back to built: not refused", async () => {
    const w = await world();
    const a = await slotOn(w, D);
    const b = await slotOn(w, addDays(D, 1));
    setClock(D, "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${a}/move`, { toDate: addDays(D, 2), toTime: "12:00" })).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${b}/skip`)).status).toBe(200);
  });

  it("a session under way moved by the Calendar or COROS to another day stays guarded only through its save's own days: the build's and the next", async () => {
    const { w, id } = await startedOn(D);
    await w.db.update(plannedWorkouts).set({ effectiveDate: addDays(D, 5) }).where(eqId(id));
    setClock(addDays(D, 1), "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/skip`)).status).toBe(409);
    setClock(addDays(D, 2), "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/skip`)).status).toBe(200);
  });
});

describe("concurrent updates, forced: what lands between a route's read and its write", () => {
  it("a save landing inside a /move: the row isn't moved, the answer says done; one credit on its day", async () => {
    const { w, id, build } = await startedOn(D);
    // Past the window the guard reads the row as open; the session's save then lands in the gap.
    setClock(addDays(D, 2), "09:00");
    let landed: Answer | null = null;
    gates.move = async () => {
      landed = await w.call("PUT", `/api/sessions/performed/p-race`, wire({ id: "p-race", workoutId: id, build, startedAt: instant(D, "18:00"), endedAt: instant(D, "18:30") }));
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 5), toTime: "18:00" });
    expect(landed!.status, JSON.stringify(landed!.json)).toBe(200);
    expect(rowOf(w, id)).toMatchObject({ date: D, completion: "completed", content: "done" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(COMPLETED_ANSWER);
    await drive(w, addDays(D, 3), addDays(D, 6));
    expect(record(w).credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId]))).toEqual([[D, id]]);
  });

  it("a Start landing inside a /move: the row isn't moved, the answer says under way", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "17:55");
    const built = await w.call("POST", `/api/sessions/${id}/build`, {});
    gates.move = async () => {
      expect((await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId })).status).toBe(200);
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 2), toTime: "18:00" });
    expect(rowOf(w, id)).toMatchObject({ date: D, content: "started" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(UNDER_WAY_ANSWER);
  });

  it("a Start landing inside a /skip: the row isn't skipped, the answer says under way", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "17:55");
    const built = await w.call("POST", `/api/sessions/${id}/build`, {});
    gates.mutation = async () => {
      expect((await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId })).status).toBe(200);
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/skip`);
    expect(rowOf(w, id)).toMatchObject({ completion: "scheduled", content: "started" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(UNDER_WAY_ANSWER);
  });

  it("a Start landing inside a /remove: the row isn't archived, the answer says under way", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "17:55");
    const built = await w.call("POST", `/api/sessions/${id}/build`, {});
    gates.mutation = async () => {
      expect((await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId })).status).toBe(200);
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/remove`);
    expect(rowOf(w, id)).toMatchObject({ archived: 0, content: "started" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(UNDER_WAY_ANSWER);
  });

  it("a save landing inside a /skip of an unresolved session: the skip's own guard keeps the credit", async () => {
    const { w, id, build } = await startedOn(D);
    setClock(addDays(D, 2), "09:00");
    gates.mutation = async () => {
      expect((await w.call("PUT", `/api/sessions/performed/p-race`, wire({ id: "p-race", workoutId: id, build, startedAt: instant(D, "18:00"), endedAt: instant(D, "18:30") }))).status).toBe(200);
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/skip`);
    expect(rowOf(w, id)).toMatchObject({ completion: "completed", content: "done" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(COMPLETED_ANSWER);
  });

  it("a save landing inside a /remove: the row isn't archived, the answer says done", async () => {
    const { w, id, build } = await startedOn(D);
    setClock(addDays(D, 2), "09:00");
    gates.mutation = async () => {
      expect((await w.call("PUT", `/api/sessions/performed/p-race`, wire({ id: "p-race", workoutId: id, build, startedAt: instant(D, "18:00"), endedAt: instant(D, "18:30") }))).status).toBe(200);
    };
    const answer = await w.call("POST", `/api/plan/workouts/${id}/remove`);
    expect(rowOf(w, id)).toMatchObject({ archived: 0, completion: "completed" });
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(COMPLETED_ANSWER);
  });
});

// ── The coach ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function mainRun(w: World): Promise<ToolContext> {
  const id = `run-${newId()}`;
  const now = nowInstant();
  await w.db.insert(coachRuns).values({ id, userId: w.userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Sort out my week", status: "active", state: null, steps: 0, costUsd: 0, createdAt: now, updatedAt: now });
  return { db: w.db, env, userId: w.userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `t_${newId()}` };
}
const change = (workoutId: string, c: Record<string, unknown>) => ({ workoutId, change: c, why: "It fits the week." });
async function proposed(w: World, ...inputs: Array<ReturnType<typeof change>>): Promise<string> {
  const ctx = await mainRun(w);
  for (const input of inputs) {
    const r = await adjustPlan.run({ ...ctx, toolUseId: `t_${newId()}` }, input);
    if (isToolErr(r)) throw new Error(`adjust_plan: ${r.error} ${r.why}`);
  }
  const id = designProposalId(ctx.run.id);
  await w.db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
  return id;
}

describe("the coach and a session under way", () => {
  it.each([
    ["a move", { kind: "move", toDate: addDays(D, 3), toTime: "12:00" }],
    ["a skip", { kind: "skip", reason: "Rest the legs." }],
  ])("adjust_plan refuses %s at propose while it is under way, and stores nothing", async (_name, c) => {
    const { w, id } = await startedOn(D);
    setClock(D, "18:10");
    const ctx = await mainRun(w);
    const r = await adjustPlan.run(ctx, change(id, c));
    expect(isToolErr(r) ? r.error : "stored").toBe("under_way");
    if (isToolErr(r)) expect(r.why).toContain("may still be running");
    const [p] = await w.db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    expect(p?.ops ?? []).toEqual([]);
  });

  it("approve refuses per op: drawn before Start, the session's move and skip stay open and say why; the other op applies", async () => {
    for (const c of [{ kind: "move", toDate: addDays(D, 3), toTime: "12:00" }, { kind: "skip", reason: "Rest the legs." }] as Array<Record<string, unknown>>) {
      const w = await world();
      const id = await slotOn(w, D);
      const other = await slotOn(w, addDays(D, 1));
      setClock(D, "12:00");
      const proposal = await proposed(w, change(id, c), change(other, { kind: "skip", reason: "Rest." }));
      setClock(D, "18:00");
      const build = await buildAndStart(w, id);
      const before = rowOf(w, id);
      const trail = overrides(w, id);
      const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`, { opIds: [planAdjustId(id), planAdjustId(other)] });
      expect(res.status).toBe(200);
      expect(res.json.refused).toEqual([expect.objectContaining({ opId: planAdjustId(id), error: "not_editable", cause: "under_way", why: expect.stringContaining("may still be running") })]);
      expect(res.json.changed.map((x: { opId: string }) => x.opId)).toEqual([planAdjustId(other)]);
      expect(rowOf(w, id)).toEqual(before);
      expect(overrides(w, id)).toBe(trail);
      expect(rowOf(w, other).completion).toBe("skipped");
      // The save still lands, once.
      expect((await saved(w, id, build, D)).json.status).toBe("saved");
      expect(rowOf(w, id)).toMatchObject({ date: D, completion: "completed" });
    }
  });

  it("approve, `{}` from an old bundle and the same approve repeated: refused the same way, nothing applied twice", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "12:00");
    const proposal = await proposed(w, change(id, { kind: "skip", reason: "Rest." }));
    setClock(D, "18:00");
    await buildAndStart(w, id);
    for (let i = 0; i < 2; i++) {
      const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`, {});
      expect(res.json.refused.map((r: { cause?: string }) => r.cause)).toEqual(["under_way"]);
      expect(rowOf(w, id).completion).toBe("scheduled");
    }
  });

  it("the card stays open: once the session is discarded, the same approve applies", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "12:00");
    const proposal = await proposed(w, change(id, { kind: "skip", reason: "Rest." }));
    setClock(D, "18:00");
    await buildAndStart(w, id);
    expect((await w.call("POST", `/api/coach/proposals/${proposal}/approve`, {})).json.refused).toHaveLength(1);
    expect((await w.call("POST", `/api/sessions/${id}/unstart`)).status).toBe(200);
    const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`, {});
    expect(res.json.refused).toEqual([]);
    expect(rowOf(w, id).completion).toBe("skipped");
  });

  it("past its window the coach's own rule answers, not this one: a day gone is `past_date`", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "12:00");
    const proposal = await proposed(w, change(id, { kind: "skip", reason: "Rest." }));
    setClock(D, "18:00");
    await buildAndStart(w, id);
    setClock(addDays(D, 2), "12:00");
    await w.db.update(coachProposals).set({ expiresAt: addDays(D, 9) }).where(eq(coachProposals.id, proposal));
    const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["past_date"]);
  });

  it("GAP, named: a Start landing inside an approve's move still lands: approve judges at its read, and the applier has no write-time guard", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "12:00");
    const proposal = await proposed(w, change(id, { kind: "move", toDate: addDays(D, 3), toTime: "12:00" }));
    setClock(D, "17:55");
    const built = await w.call("POST", `/api/sessions/${id}/build`, {});
    gates.move = async () => {
      expect((await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId })).status).toBe(200);
    };
    const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`, {});
    expect(res.json.changed.map((x: { opId: string }) => x.opId)).toEqual([planAdjustId(id)]);
    // Moved, and `started` lost: the applier read the row as built, so it wrote it back to an outline. The phone plays on.
    expect(rowOf(w, id)).toMatchObject({ date: addDays(D, 3), content: "outline" });
  });

  it("GAP, named: a thread coach's op on a session under way still lands; the thread route is not gated (owner P5)", async () => {
    const { w, id } = await startedOn(D);
    setClock(D, "18:10");
    const proposal = `tp-${newId()}`;
    await w.db.insert(coachProposals).values({ id: proposal, userId: w.userId, planId: null, title: "This week", evidence: "", rationale: "", flags: [], ops: [{ kind: "skip", workoutId: id }], status: "pending", createdAt: nowInstant(), expiresAt: addDays(D, 7) } as never);
    const res = await w.call("POST", `/api/coach/proposals/${proposal}/approve`);
    expect(res.status).toBe(200);
    expect(rowOf(w, id).completion).toBe("skipped");
  });
});

// ── What keeps working ───────────────────────────────────────────────────────────────────────────────────────────────

describe("what sits below the routes, and the corrections, keep working", () => {
  it("reconcile: a started session goes `unresolved` at D+2 and `missed` at D+7, as before", async () => {
    const { w, id } = await startedOn(D);
    await drive(w, addDays(D, 1), addDays(D, 3));
    expect(rowOf(w, id).completion).toBe("unresolved");
    await drive(w, addDays(D, 4), addDays(D, 7));
    expect(rowOf(w, id).completion).toBe("missed");
  });

  it("a late save after the auto-miss still lands: the guard never reaches a save", async () => {
    const { w, id, build } = await startedOn(D);
    await drive(w, addDays(D, 1), addDays(D, 8));
    expect(rowOf(w, id).completion).toBe("missed");
    expect((await saved(w, id, build, addDays(D, 8))).json.status).toBe("saved");
    expect(rowOf(w, id)).toMatchObject({ date: D, completion: "completed", content: "done" });
  });

  it("`retry-coros` on a completed and on a started row: answers, the date unchanged", async () => {
    const { w, id } = await savedOn(FRI);
    setClock(FRI, "19:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/retry-coros`)).status).toBe(200);
    expect(rowOf(w, id)).toMatchObject({ date: FRI, completion: "completed" });
    const running = await startedOn(D);
    setClock(D, "18:10");
    expect((await running.w.call("POST", `/api/plan/workouts/${running.id}/retry-coros`)).status).toBe(200);
    expect(rowOf(running.w, running.id)).toMatchObject({ date: D, content: "started" });
  });

  /** A watch-plan session and a failed move job with its open intent. */
  async function failedMoveOn(w: World, completion: "scheduled" | "completed") {
    const id = "guard-retry";
    const now = nowInstant();
    await w.db.insert(plannedWorkouts).values({
      id, userId: w.userId, planId: "guard-plan-row", sourceWorkoutId: "4738:9", sourceIdInPlan: "9", title: "Tempo", category: "quality", sport: "run", originalPlanDate: D, lastVerifiedCorosDate: D, effectiveDate: addDays(D, 1), effectiveTime: "07:00",
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, fallbackEstimatedDurationSeconds: 3600, completionState: completion, createdAt: now, updatedAt: now,
    });
    await w.db.insert(corosWriteJobs).values({ id: "job-failed", userId: w.userId, workoutId: id, kind: "move_scheduled_workout", expectedContentFingerprint: "", originalDate: D, destinationDate: addDays(D, 1), payload: {}, requestedAt: now, status: "failed", updatedAt: now } as never);
    await w.db.insert(syncIntents).values({ id: "intent-open", userId: w.userId, targetKind: "workout", targetId: id, kind: "move", payload: { fromDate: D, toDate: addDays(D, 1), toTime: "07:00" }, source: "user_move", createdAt: now } as never);
    return id;
  }

  it("`/api/sync/retry` still retries a failed move, on a completed row too: it re-applies the row's own date", async () => {
    const w = await world();
    setClock(D, "12:00");
    const id = await failedMoveOn(w, "completed");
    const res = await w.call("POST", "/api/sync/retry");
    expect(res.status).toBe(200);
    expect(res.json.movesRetried).toBe(1);
    expect(rowOf(w, id)).toMatchObject({ date: addDays(D, 1), completion: "completed" });
  });

  it("sync-note Undo still moves a session that isn't app-built", async () => {
    const w = await world();
    setClock(D, "12:00");
    const id = await failedMoveOn(w, "scheduled");
    await postSyncNote(w.db, { userId: w.userId, workoutId: id, kind: "adopted_coros_change", payload: { previousDate: addDays(D, 3), newDate: addDays(D, 1) } });
    const [note] = q(w, `select id from sync_notes where workout_id = ?`, id);
    const res = await w.call("POST", `/api/sync/notes/${note.id}/undo`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(rowOf(w, id).date).toBe(addDays(D, 3));
  });

  it.each(["adopted_coros_change", "kept_local_change"] as const)("sync-note Undo (%s) on a session done since the note: 409 `session_completed`, nothing moved, the note kept, and the feed offers no Undo for it", async (kind) => {
    const w = await world();
    setClock(D, "12:00");
    const id = await failedMoveOn(w, "completed");
    await postSyncNote(w.db, { userId: w.userId, workoutId: id, kind, payload: kind === "adopted_coros_change" ? { previousDate: addDays(D, 3), newDate: addDays(D, 1) } : { displacedDate: addDays(D, 3), keptDate: addDays(D, 1) } });
    const [note] = q(w, `select id from sync_notes where workout_id = ?`, id);
    const overridesBefore = overrides(w, id);
    const answer = await w.call("POST", `/api/sync/notes/${note.id}/undo`);
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual(COMPLETED_ANSWER);
    expect(answer.writes).toEqual([]);
    expect(rowOf(w, id)).toMatchObject({ date: addDays(D, 1), completion: "completed" });
    expect(overrides(w, id)).toBe(overridesBefore);
    const feed = await w.call("GET", "/api/sync/notes");
    expect(feed.json.notes).toEqual([expect.objectContaining({ id: note.id, kind, undoable: false })]);
  });

  it("sync-note Undo's feed: a session still to come keeps its Undo (no `undoable` said)", async () => {
    const w = await world();
    setClock(D, "12:00");
    const id = await failedMoveOn(w, "scheduled");
    await postSyncNote(w.db, { userId: w.userId, workoutId: id, kind: "adopted_coros_change", payload: { previousDate: addDays(D, 3), newDate: addDays(D, 1) } });
    const feed = await w.call("GET", "/api/sync/notes");
    expect(feed.json.notes).toHaveLength(1);
    expect(feed.json.notes[0].undoable).toBeUndefined();
  });

  it("sync-note Undo on a run COROS moved, done since on its new day: refused, and its one credit stays on that day — per activity, as if Undo was never tapped", async () => {
    const w = await world();
    const SAT = addDays(D, 3);
    const id = await watchPlanRun(w, SAT);
    // The athlete moved it to Wednesday in COROS: adopted, with its note.
    setClock(addDays(D, -2), "12:00");
    await corosRead(w, id, D);
    const [note] = q(w, `select id, kind from sync_notes where workout_id = ?`, id);
    expect(note.kind).toBe("adopted_coros_change");
    await drive(w, addDays(D, -1), D);
    setClock(D, "12:00");
    await corosReport(w, [corosSource({ label: "lbl-wed", date: D, hhmm: "07:05", seconds: 3550, sport: "run" })]);
    await drive(w, addDays(D, 1), addDays(D, 1));
    expect(rowOf(w, id).completion).toBe("completed");
    const control = fork(w);
    setClock(addDays(D, 1), "12:00");
    const answer = await w.call("POST", `/api/sync/notes/${note.id}/undo`);
    expect([answer.status, answer.json.error]).toEqual([409, "session_completed"]);
    await drive(w, addDays(D, 2), addDays(SAT, 2));
    await drive(control, addDays(D, 2), addDays(SAT, 2));
    const after = record(w);
    expect(after).toEqual(record(control));
    expect(after.counters).toMatchObject({ runs: 1, long: 1 });
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId, x.activityId]))).toEqual([[D, id, "coros:lbl-wed"]]);
    expect(q(w, `select dismissed_at from sync_notes where id = ?`, note.id)[0].dismissed_at).toBeNull();
  });

  it("the watch reports first while the phone still plays (`completed`, still `started`): the routes say done, and the phone's save still lands, on the same activity", async () => {
    const { w, id, build } = await startedOn(D);
    setClock(D, "18:35");
    await corosReport(w, [corosSource({ label: "lbl-first", date: D, hhmm: "18:01", seconds: 1790, sport: "strength" })]);
    expect(rowOf(w, id)).toMatchObject({ completion: "completed", content: "started" });
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 2), toTime: "18:00" })).json).toEqual(COMPLETED_ANSWER);
    expect((await saved(w, id, build, D)).json.status).toBe("saved");
    await drive(w, addDays(D, 1), addDays(D, 2));
    const after = record(w);
    expect(rowOf(w, id)).toMatchObject({ date: D, completion: "completed", content: "done" });
    expect(after.activities).toHaveLength(1);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId]))).toEqual([[D, id]]);
  });

  it("Undo match is not blocked, and it reopens the way out of a wrong completion: unmatched, the row can be removed; the activity and its source id stay", async () => {
    const { w, id } = await savedOn(FRI);
    setClock(FRI, "19:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/remove`)).status).toBe(409);
    expect((await w.call("POST", `/api/plan/workouts/${id}/unmatch`)).status).toBe(200);
    expect(rowOf(w, id)).toMatchObject({ completion: "unresolved", content: "done" });
    expect((await w.call("POST", `/api/plan/workouts/${id}/remove`)).status).toBe(200);
    const after = record(w);
    expect(rowOf(w, id).archived).toBe(1);
    expect(after.activities).toHaveLength(1);
    expect(after.sessions).toHaveLength(1);
  });

  it("GAP, named: Undo match opens the row, so a move is taken: it stays `done` and goes `scheduled` on its new day, the activity's credit unplanned on its own day, once", async () => {
    const { w, id } = await savedOn(FRI);
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    setClock(addDays(FRI, 2), "12:00");
    expect((await w.call("POST", `/api/plan/workouts/${id}/unmatch`)).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: TUE, toTime: "18:00" })).status).toBe(200);
    expect(rowOf(w, id)).toMatchObject({ date: TUE, completion: "scheduled", content: "done" });
    await drive(w, addDays(FRI, 3), addDays(TUE, 1));
    const after = await replayed(w);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.unplanned]))).toEqual([[FRI, true]]);
    expect(after.counters.strength + after.counters.yoga).toBe(1);
  });

  it("Undo match, then a re-link: `/match` is not blocked, the credit is back, on one activity", async () => {
    const { w, id } = await savedOn(FRI);
    setClock(FRI, "19:00");
    const [activity] = q(w, `select id from activities where user_id = ?`, w.userId);
    expect((await w.call("POST", `/api/plan/workouts/${id}/unmatch`)).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${id}/match`, { activityId: activity.id })).status).toBe(200);
    expect(rowOf(w, id).completion).toBe("completed");
    expect(record(w).matches.filter((m) => !m.undone).map((m) => m.method)).toEqual(["manual"]);
  });

  it("an un-skip, and a skip of an already skipped session, answer as before", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "12:00");
    for (let i = 0; i < 2; i++) expect((await w.call("POST", `/api/plan/workouts/${id}/skip`)).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${id}/unskip`)).status).toBe(200);
    expect(rowOf(w, id).completion).toBe("scheduled");
  });

  it("a missed session: Remove still takes it off the plan, the debit with it (the one route correction a miss has)", async () => {
    const { w, id } = await startedOn(D);
    await drive(w, addDays(D, 1), addDays(D, 7));
    expect(rowOf(w, id).completion).toBe("missed");
    expect((await w.call("POST", `/api/plan/workouts/${id}/remove`)).status).toBe(200);
    expect(rowOf(w, id).archived).toBe(1);
  });
});

// ── The hazards JOINT §3.2 names ─────────────────────────────────────────────────────────────────────────────────────

describe("the hazards, after the guard (each says what happens; the guard doesn't make any of them worse)", () => {
  it("the laptop's Continue, End and Discard reach /unstart while the phone plays on: the gate opens, a move lands, and the phone's save still lands: one credit, on the slot's new day", async () => {
    const { w, id, build } = await startedOn(D);
    setClock(D, "18:10");
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 2), toTime: "18:00" })).status).toBe(409);
    expect((await w.call("POST", `/api/sessions/${id}/unstart`)).status).toBe(200);
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 2), toTime: "18:00" })).status).toBe(200);
    const answer = await saved(w, id, build, D);
    expect(answer.json.status).toBe("saved");
    expect(rowOf(w, id)).toMatchObject({ date: addDays(D, 2), completion: "completed", content: "done" });
    await drive(w, addDays(D, 1), addDays(D, 4));
    const after = record(w);
    expect(after.sessions).toHaveLength(1);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId]))).toEqual([[addDays(D, 2), id]]);
    // Done now: the guard holds from here.
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 5), toTime: "18:00" })).status).toBe(409);
  });

  it("a Start on a session a laptop skipped: not refused (older than the guard, Start doesn't read the skip). Under way from there; the save overwrites the skip: one credit", async () => {
    const w = await world();
    const id = await slotOn(w, D);
    setClock(D, "17:55");
    const built = await w.call("POST", `/api/sessions/${id}/build`, {});
    expect((await w.call("POST", `/api/plan/workouts/${id}/skip`)).status).toBe(200);
    const started = await w.call("POST", `/api/sessions/${id}/start`, { buildId: built.json.build.buildId });
    expect(started.status).toBe(200);
    expect(rowOf(w, id)).toMatchObject({ completion: "skipped", content: "started" });
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { toDate: addDays(D, 2), toTime: "18:00" })).status).toBe(409);
    expect((await saved(w, id, started.json.build, D)).json.status).toBe("saved");
    expect(rowOf(w, id)).toMatchObject({ date: D, completion: "completed", content: "done" });
    await drive(w, addDays(D, 1), addDays(D, 2));
    expect(record(w).credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId]))).toEqual([[D, id]]);
  });

  it("Discard on a Start-now row archives it (below the routes, so the guard doesn't touch it); a later save lands `slot_gone`, its activity unplanned", async () => {
    const w = await world();
    setClock(D, "18:00");
    const made = await w.call("POST", "/api/workouts", { doc: calmDoc(), date: D, time: "18:00", startNow: true, clientId: "guard-now" });
    expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
    const id = made.json.workout.id as string;
    const build = await buildAndStart(w, id);
    const discarded = await w.call("POST", `/api/sessions/${id}/unstart`);
    expect(discarded.json.removed).toBe(true);
    expect(rowOf(w, id).archived).toBe(1);
    const answer = await saved(w, id, build, D);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(answer.json.notes).toContain("slot_gone");
    await drive(w, addDays(D, 1), addDays(D, 2));
    const after = record(w);
    expect(after.sessions).toHaveLength(1);
    expect(after.credits.flatMap((c) => c.completed.map((x) => x.unplanned))).toEqual([true]);
  });
});

// ── COROS date adoption (JOINT Fix 6) ────────────────────────────────────────────────────────────────────────────────

/** A COROS read of a watch-plan session: its id at this date, the same content (the import, as a read hands it over). */
async function corosRead(w: World, id: string, date: string): Promise<void> {
  const prefs = await loadPreferences(w.db, w.userId);
  await importPlanSnapshot(
    w.db,
    {
      userId: w.userId,
      plan: { sourcePlanId: "guard-plan", name: "Synthetic plan" },
      workouts: [{ sourcePlanId: "guard-plan", sourceWorkoutId: "4738:2", sourceIdInPlan: "2", date, title: "Long run", sport: "run", contentFingerprint: "fp", stages: [], estimatedDurationSeconds: 3600, isRestDay: false }],
      rangeStart: "2026-11-01",
      rangeEnd: "2026-12-20",
      source: "fixture",
    },
    prefs,
  );
  expect(rowOf(w, id)).toBeTruthy();
}

async function watchPlanRun(w: World, day: string): Promise<string> {
  const id = "guard-run";
  await w.db.insert(plannedWorkouts).values({
    id, userId: w.userId, planId: "guard-plan-row", sourceWorkoutId: "4738:2", sourceIdInPlan: "2", title: "Long run", category: "long", sport: "run", originalPlanDate: day, lastVerifiedCorosDate: day, effectiveDate: day, effectiveTime: "07:00",
    sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, fallbackEstimatedDurationSeconds: 3600, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  return id;
}

describe("a finished session's day doesn't follow COROS", () => {
  it("a run the watch reported, re-dated on COROS: its day stays, the read's date is on record, no note; one credit, by its one source id, as if COROS had left it", async () => {
    const w = await world();
    const id = await watchPlanRun(w, FRI);
    await drive(w, addDays(FRI, -2), FRI);
    setClock(FRI, "12:00");
    await corosReport(w, [corosSource({ label: "lbl-long", date: FRI, hhmm: "07:05", seconds: 3550, sport: "run" })]);
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    expect(rowOf(w, id).completion).toBe("completed");
    const control = fork(w);
    setClock(addDays(FRI, 2), "12:00");
    await corosRead(w, id, TUE);
    await corosRead(w, id, TUE); // the next read finds nothing new
    expect(rowOf(w, id)).toMatchObject({ date: FRI, lvd: TUE, completion: "completed" });
    expect(await w.db.select().from(syncNotes).where(eq(syncNotes.workoutId, id))).toEqual([]);
    await drive(w, addDays(FRI, 3), addDays(TUE, 3));
    await drive(control, addDays(FRI, 3), addDays(TUE, 3));
    const after = record(w);
    expect({ ...after, rows: [] }).toEqual({ ...record(control), rows: [] });
    expect(after.counters).toMatchObject({ runs: 1, long: 1 });
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId, x.activityId]))).toEqual([[FRI, id, "coros:lbl-long"]]);
    expect(after.events.map((e) => [e.date, e.kind, e.activity])).toEqual(record(control).events.map((e) => [e.date, e.kind, e.activity]));
  });

  it("a session still to come follows COROS as before, with its note", async () => {
    const w = await world();
    const id = await watchPlanRun(w, D);
    setClock(addDays(D, -2), "12:00");
    await corosRead(w, id, addDays(D, 2));
    expect(rowOf(w, id)).toMatchObject({ date: addDays(D, 2), lvd: addDays(D, 2), completion: "scheduled" });
    expect((await w.db.select().from(syncNotes).where(eq(syncNotes.workoutId, id))).map((n) => n.kind)).toEqual(["adopted_coros_change"]);
  });
});

// ── The Calendar, which JOINT's Fix 5 leaves as it is ────────────────────────────────────────────────────────────────

describe("GAP, named: the Calendar sits below the guard until JOINT Fix 5, and a drag still moves the row", () => {
  async function calendarWorld(id: () => Promise<string>, w: World) {
    const key = Buffer.alloc(32, 7).toString("base64");
    const prefs = await loadPreferences(w.db, w.userId);
    const { savePreferences } = await import("../src/services/calendar-sync.js");
    await savePreferences(w.db, w.userId, { ...prefs, calendarId: "cal" });
    await w.db.insert(providerConnections).values({
      id: newId(), userId: w.userId, provider: "google_calendar", status: "connected", encryptedRefreshToken: await encryptSecret("refresh", key), encryptedAccessToken: await encryptSecret("access", key),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    const google = new FakeGoogle({ now: new Date().toISOString(), zone: LA, origin: "https://app.test", firstDay: GENESIS });
    vi.stubGlobal("fetch", google.fetch);
    const workout = await id();
    await syncCalendar(w.db, env, w.userId);
    const event = [...google.events.values()].find((e) => e.body.extendedProperties?.private?.rgWorkoutId === workout);
    expect(event, "the session's event is on the calendar").toBeTruthy();
    /** The athlete drags the event `days` on, in Google. */
    const drag = async (days: number) => {
      const shift = (iso: string) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
      event!.body = { ...event!.body, start: { ...event!.body.start, dateTime: shift(event!.body.start.dateTime) }, end: { ...event!.body.end, dateTime: shift(event!.body.end.dateTime) } };
      event!.seq = ++(google as unknown as { seq: number }).seq;
      await syncCalendar(w.db, env, w.userId);
    };
    return { workout, drag };
  }

  it("a drag on a session under way re-dates it: the phone's save still lands, on the slot's new day", async () => {
    const w = await world();
    let build: any;
    const { workout, drag } = await calendarWorld(async () => {
      const id = await slotOn(w, D);
      setClock(D, "18:00");
      build = await buildAndStart(w, id);
      return id;
    }, w);
    await drag(2);
    expect(rowOf(w, workout)).toMatchObject({ date: addDays(D, 2), content: "started" });
    expect((await saved(w, workout, build, D)).json.status).toBe("saved");
    expect(rowOf(w, workout)).toMatchObject({ date: addDays(D, 2), completion: "completed" });
  });

  it("a drag on a done session re-dates it, and the walk credits it twice: the double credit Fix 5 is for", async () => {
    const w = await world();
    let build: any;
    const { workout, drag } = await calendarWorld(async () => {
      const id = await slotOn(w, FRI);
      setClock(FRI, "18:00");
      build = await buildAndStart(w, id);
      return id;
    }, w);
    expect((await saved(w, workout, build, FRI)).json.status).toBe("saved");
    await drive(w, addDays(FRI, 1), addDays(FRI, 2));
    await drag(4);
    expect(rowOf(w, workout)).toMatchObject({ date: TUE, completion: "completed" });
    await drive(w, addDays(FRI, 3), addDays(TUE, 3));
    const after = record(w);
    expect(after.counters.strength + after.counters.yoga).toBe(2);
    expect(after.credits.flatMap((c) => c.completed.map((x) => [c.date, x.workoutId]))).toEqual([[FRI, workout], [TUE, workout]]);
  });
});
