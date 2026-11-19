/**
 * STAGE 2A'S PLAN EDITS FROM THE PHONE (stage 2 DESIGN §4.1, §5, §9 "Moves in run-garden too"): a device paired at scope
 * `training-v2` reaches run-garden's own move, skip and unskip routes and the watch drain — the web's handlers, guard and
 * services, nothing re-implemented — and a `training-slice-v1` device is still refused them, 403 `out_of_scope`.
 *
 *  - v2 moves (another day, or a time on the same day), skips and unskips, and the rows are what the web's would be;
 *  - v1 is refused before any write, and a new pairing never upgrades it;
 *  - the device's bodies: Move strictly `{toDate, toTime, from?}`, skip, unskip and drain empty;
 *  - a session done or under way gets run-garden's own refusal and `why`, as the web does;
 *  - Move's optional `from` (for every caller): a move made against a stale view is 409 `session_changed`, nothing written —
 *    held in the guarded write itself, not only at a read;
 *  - the gate as for v1: the restore lock (423), the kill switch, revoked, expired and pending;
 *  - `watchDrain` handed back, and the device's drain taking a sent copy off the watch (a mock COROS);
 *  - every request within a request's budget (45 statements and fetches, its waitUntil work included; D1's bind cap on).
 *
 * Through the real route modules on the repo's migrations, under a faked `Date`. "Nothing written" is the whole database
 * compared before and after, but for the two sign-in tables a request touches by itself (a device's last use, a cookie's
 * session). Synthetic data only; `fetch` stubbed (a mock COROS where the watch is in play).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, newId, nowInstant, performedSessionSaveSchema, programSessionPushJobSchema } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";

/** Hold a move between its read and its write (`applyMove` reads the sent build first for a move to another day). */
const gates = vi.hoisted(() => ({ move: null as null | (() => Promise<void>) }));
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

import { sha256Hex } from "../src/auth/crypto.js";
import type { Env } from "../src/env.js";
import { savePreferences, loadPreferences } from "../src/services/calendar-sync.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { COMPLETED_WORDS, GONE_WORDS, MOVED_SINCE_WORDS, SET_ASIDE_WORDS, UNDER_WAY_WORDS } from "../src/services/session-guard.js";
import { slotId } from "../src/services/program-slots.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type CallOpts, type NativeWorld } from "./native-fixture.js";
import { buildToday, connectMock, DAY, NOON, seedCatalog, seedTmj, TOMORROW } from "./watch-push-fixture.js";

const { accountState, corosWriteJobs, plannedWorkouts, programs } = schema;

const LA = "America/Los_Angeles";
const V1 = "training-slice-v1";
const V2 = "training-v2";
/** A request's budget: D1 statements and fetches, its waitUntil work included (the free plan's 50, with room). */
const BUDGET = 45;
const D = "2026-11-18"; // a Wednesday: "today" on the phone
const THU = addDays(D, 1);
const FRI = addDays(D, 2);
const SAT = addDays(D, 3);
const instant = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const setClock = (date: string, hhmm: string) => vi.setSystemTime(new Date(instant(date, hhmm)));

let w: NativeWorld;
/** A v2 phone's token and a v1 phone's, both active, last used just now (so a request writes no last use). */
let v2: string;
let v1: string;
let fetches = 0;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  gates.move = null;
});

const client = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[]; run(...a: unknown[]): unknown } } }).$client;
const q = (sql: string, ...args: unknown[]): any[] => client().prepare(sql).all(...args);
const exec = (sql: string, ...args: unknown[]): void => void client().prepare(sql).run(...args);

/** Every table, every row, but the sign-in tables a request touches by itself: "nothing written" is this, unchanged. */
function everything(): Record<string, unknown[]> {
  const tables = q(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('native_devices', 'sessions') order by name`).map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, q(`select * from "${t}" order by rowid`)]));
}

const rowOf = (id: string) =>
  q(`select effective_date as date, effective_time as time, completion_state as completion, content_state as content from planned_workouts where id = ?`, id)[0];
const overridesOf = (id: string) => q(`select kind, from_date as "from", to_date as "to", to_time as time, source from schedule_overrides where workout_id = ? order by rowid`, id);

/** A request, with the fetches it made: its total against the budget. */
async function costed(method: string, path: string, opts: CallOpts = {}): Promise<Answer & { total: number }> {
  const before = fetches;
  const a = await w.call(method, path, opts);
  return { ...a, total: a.statements.length + fetches - before };
}

const move = (id: string, body: unknown, bearer: string | null = v2) => costed("POST", `/api/plan/workouts/${id}/move`, bearer === null ? { body } : { bearer, body });
const skip = (id: string, bearer: string | null = v2) => costed("POST", `/api/plan/workouts/${id}/skip`, bearer === null ? {} : { bearer });
const unskip = (id: string, bearer: string | null = v2) => costed("POST", `/api/plan/workouts/${id}/unskip`, bearer === null ? {} : { bearer });
/** The watch drain: the phone's names the session it moved (`{workoutId}`, its bound); the web's sends `{}`, as it does. */
const drain = (bearer: string | null = v2, workoutId?: string) =>
  costed("POST", "/api/sessions/watch/drain", bearer === null ? { body: workoutId ? { workoutId } : {} } : { bearer, body: workoutId ? { workoutId } : {} });

/** A Studio workout the laptop makes on `day` at `time`: the kind of session the phone plays. */
async function workoutOn(day: string, time = "18:00"): Promise<string> {
  const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: day, time, clientId: `slot-${newId()}` } });
  expect(made.status, made.text).toBeLessThan(300);
  return made.json.workout.id as string;
}

/** The phone opens today's session and starts it: Build `{}`, Start `{buildId}`, with its token. */
async function phoneStarts(id: string): Promise<any> {
  const built = await w.call("POST", `/api/sessions/${id}/build`, { bearer: v2, body: {} });
  expect(built.status, built.text).toBe(200);
  const started = await w.call("POST", `/api/sessions/${id}/start`, { bearer: v2, body: { buildId: built.json.build.buildId } });
  expect(started.status, started.text).toBe(200);
  return started.json.build;
}

/** The phone's save of its session of `id`, as its outbox sends it. */
async function phoneSaves(id: string, build: any): Promise<void> {
  const items = (build.items ?? []) as Array<{ exerciseId: string; slotKey?: string }>;
  const body = performedSessionSaveSchema.parse({
    id: `p-${id}`, source: "app", sourceRef: null, workoutId: id, buildId: build.buildId, localDate: build.date,
    startedAt: instant(D, "18:00"), endedAt: instant(D, "18:30"), seconds: 1800, plannedSeconds: build.plannedSeconds ?? 1800, minutes: build.minutes ?? 30,
    mode: build.mode ?? "build", theme: build.theme ?? null, locationId: build.locationId ?? null, blockRef: build.blockRef ?? null, blockNumber: null,
    completed: true, stepsTotal: (build.steps ?? []).length || 1, stepsDone: (build.steps ?? []).length || 1,
    movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
    note: null, newMove: build.newMove ?? null,
    entries: [{ exerciseId: items[0]?.exerciseId ?? "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
    checks: [], review: {},
  });
  const saved = await w.call("PUT", `/api/sessions/performed/${body.id}`, { bearer: v2, body });
  expect([saved.status, saved.json.status], saved.text).toEqual([200, "saved"]);
}

async function world(env: Partial<Env> = {}) {
  fetches = 0;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/native", nativeRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/plan", planRoutes],
      ["/api/workouts", workoutRoutes],
    ],
    { env },
  );
  v2 = (await seedDevice(w.db, w.userId, { scope: V2, lastUsedAt: nowInstant(), expiresAt: "2027-06-01T00:00:00.000Z" })).token;
  v1 = (await seedDevice(w.db, w.userId, { scope: V1, lastUsedAt: nowInstant(), expiresAt: "2027-06-01T00:00:00.000Z" })).token;
}

describe("a v2 phone moves, skips and unskips through run-garden's own routes", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
  });

  it("moves to another day this week, and to a time on the same day (later), with from: taken, and the rows are the web's", async () => {
    const phone = await workoutOn(THU);
    const laptop = await workoutOn(THU);
    const a = await move(phone, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    const b = await move(laptop, { toDate: SAT, toTime: "18:15" }, null);
    expect([a.status, a.json], a.text).toEqual([200, { workoutId: phone, corosSyncState: "calendar_only" }]);
    expect([b.status, b.json]).toEqual([200, { workoutId: laptop, corosSyncState: "calendar_only" }]);
    expect(rowOf(phone)).toEqual({ date: SAT, time: "18:15", completion: "scheduled", content: rowOf(laptop).content });
    expect(rowOf(laptop)).toMatchObject({ date: SAT, time: "18:15" });
    expect(overridesOf(phone)).toEqual(overridesOf(laptop));
    expect(overridesOf(phone).at(-1)).toEqual({ kind: "user_move", from: THU, to: SAT, time: "18:15", source: "app" });

    // 15 min later: the same day, a new time.
    const later = await move(phone, { toDate: SAT, toTime: "18:30", from: { date: SAT, time: "18:15" } });
    expect(later.status, later.text).toBe(200);
    expect(rowOf(phone)).toMatchObject({ date: SAT, time: "18:30" });
    expect(overridesOf(phone).at(-1)).toEqual({ kind: "time_change", from: SAT, to: SAT, time: "18:30", source: "app" });
  });

  it("from is optional for the phone too: a move without it is taken as the web's is", async () => {
    const id = await workoutOn(THU);
    const a = await move(id, { toDate: FRI, toTime: "07:00" });
    expect(a.status, a.text).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
  });

  it("skips and unskips: skipped on today's date, then scheduled again, as run-garden counts them", async () => {
    const id = await workoutOn(THU);
    const s = await skip(id);
    expect([s.status, s.json]).toEqual([200, { ok: true }]);
    expect(rowOf(id)).toMatchObject({ date: THU, completion: "skipped" });
    expect(q(`select resolution_date as d from planned_workouts where id = ?`, id)).toEqual([{ d: D }]);
    // A skip of one already skipped answers ok and skips nothing again (the route's own: a retry is safe).
    const overrides = overridesOf(id);
    expect((await skip(id)).json).toEqual({ ok: true });
    expect(rowOf(id)).toMatchObject({ date: THU, completion: "skipped" });
    expect(overridesOf(id)).toEqual(overrides);
    const u = await unskip(id);
    expect([u.status, u.json]).toEqual([200, { ok: true }]);
    expect(rowOf(id)).toMatchObject({ date: THU, completion: "scheduled" });
    expect(overridesOf(id).at(-1)).toMatchObject({ kind: "restore", source: "app" });
    // The same unskip again (its answer lost): 200 as the first (kit v0.14, below); one that isn't on the plan: 404.
    expect([(await unskip(id)).status, (await unskip(id)).json]).toEqual([200, { ok: true }]);
    expect([(await unskip("no-such-session")).status, (await unskip("no-such-session")).json]).toEqual([404, { error: "not_found" }]);
  });

  it("a session gone, or a race, gets the route's own refusal, nothing written", async () => {
    const before = everything();
    const gone = await move("no-such-session", { toDate: FRI, toTime: "07:00", from: { date: THU, time: "18:00" } });
    expect([gone.status, gone.json]).toEqual([404, { error: "not_found", why: "This session is no longer on your plan." }]);
    expect(everything()).toEqual(before);
    const race = `race-${newId()}`;
    await w.db.insert(plannedWorkouts).values({
      id: race, userId: w.userId, planId: "tp-1", sourceWorkoutId: race, title: "Half marathon", category: "race", sport: "run",
      originalPlanDate: SAT, lastVerifiedCorosDate: SAT, effectiveDate: SAT, effectiveTime: "08:00", sourceContentFingerprint: "x",
      calendarBlockDurationSeconds: 7200, corosSyncState: "synced", completionState: "scheduled", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    const held = everything();
    const r = await move(race, { toDate: FRI, toTime: "08:00", from: { date: SAT, time: "08:00" } });
    expect([r.status, r.json]).toEqual([422, { error: "races_cannot_move" }]);
    expect(everything()).toEqual(held);
  });

  it("v2's Build is still `{}` only in 2a: an override is 403 out_of_scope", async () => {
    const id = await workoutOn(D);
    const a = await w.call("POST", `/api/sessions/${id}/build`, { bearer: v2, body: { overrides: { mode: "build" } } });
    expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
  });
});

describe("a v1 phone is refused them, and keeps v1", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world({ WATCH_PUSH_ENABLED: "1" });
  });

  it("move, skip, unskip and the drain: 403 out_of_scope, the device's read the only statement, nothing written", async () => {
    const id = await workoutOn(THU);
    await skip(id, null);
    await unskip(id, null);
    const before = everything();
    for (const a of [
      await move(id, { toDate: FRI, toTime: "07:00", from: { date: THU, time: "18:00" } }, v1),
      await move(id, { toDate: FRI, toTime: "07:00" }, v1),
      await skip(id, v1),
      await unskip(id, v1),
      await drain(v1),
      await drain(v1, id),
    ]) {
      expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
      expect(a.statements).toHaveLength(1);
    }
    expect(everything()).toEqual(before);
    expect(rowOf(id)).toMatchObject({ date: THU, time: "18:00", completion: "scheduled" });
  });

  it("a new pairing is minted at the newest scope (v3, which holds v2's moves); the v1 phone stays v1, refused as before", async () => {
    const { code } = (await w.call("POST", "/api/native/pairings", { body: {} })).json;
    const { token, check } = (await w.call("POST", "/api/native/pair", { cookie: false, body: { code, label: "New phone" } })).json;
    expect((await w.call("POST", `/api/native/devices/${await sha256Hex(token)}/confirm`, { body: { check } })).status).toBe(200);
    // A new pairing no longer upgrades or touches the v1 phone; only the laptop's grant moves a phone up (stage 2b).
    expect((await w.call("GET", "/api/native/me", { bearer: token })).json.device.scope).toBe("training-v4");
    expect((await w.call("GET", "/api/native/me", { bearer: v1 })).json.device.scope).toBe(V1);
    const id = await workoutOn(THU);
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, v1)).status).toBe(403);
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, token)).status).toBe(200);
  });
});

describe("the device's bodies", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
    id = await workoutOn(THU);
  });

  it("Move is strictly {toDate, toTime, from?}: anything else is 403 out_of_scope, no handler run, nothing written", async () => {
    const ok = { toDate: FRI, toTime: "07:00" };
    const from = { date: THU, time: "18:00" };
    const refused = [
      JSON.stringify({ ...ok, force: true }),
      JSON.stringify({ ...ok, from: { ...from, source: "coach" } }),
      JSON.stringify({ ...ok, from: { date: THU } }),
      JSON.stringify({ ...ok, from: { time: "18:00" } }),
      JSON.stringify({ ...ok, from: THU }),
      JSON.stringify({ ...ok, from: null }),
      JSON.stringify({ ...ok, from: { date: "Thursday", time: "18:00" } }),
      JSON.stringify({ ...ok, from: { date: THU, time: "6pm" } }),
      JSON.stringify({ toDate: FRI }),
      JSON.stringify({ toTime: "07:00" }),
      JSON.stringify({ toDate: 20261120, toTime: "07:00" }),
      JSON.stringify({ toDate: "2026-11-31", toTime: "07:00" }),
      JSON.stringify({ toDate: FRI, toTime: "7pm" }),
      JSON.stringify({ toDate: FRI, toTime: "24:00" }),
      JSON.stringify({ toDate: FRI, toTime: "" }),
      JSON.stringify({ toDate: FRI, toTime: null }),
      '{"toDate":"2026-11-20","toTime":"07:00","__proto__":{"x":1}}',
      "[]",
      "null",
      "",
      "not json",
      "{} {}",
    ];
    const before = everything();
    for (const raw of refused) {
      const a = await w.call("POST", `/api/plan/workouts/${id}/move`, { bearer: v2, raw });
      expect([raw, a.status, a.json]).toEqual([raw, 403, { error: "out_of_scope" }]);
      expect(a.statements).toHaveLength(1);
    }
    expect(everything()).toEqual(before);
    // In the grammar: an untimed `from` (null), and the plain move.
    const untimed = await w.call("POST", `/api/plan/workouts/${id}/move`, { bearer: v2, raw: JSON.stringify({ ...ok, from: { date: THU, time: null } }) });
    expect([untimed.status, untimed.json.error]).toEqual([409, "session_changed"]);
    expect((await w.call("POST", `/api/plan/workouts/${id}/move`, { bearer: v2, raw: ` ${JSON.stringify({ ...ok, from })} ` })).status).toBe(200);
  });

  it("the web's move is not held to it: a cookie's extra key is ignored as before", async () => {
    const a = await move(id, { toDate: FRI, toTime: "07:00", force: true }, null);
    expect(a.status, a.text).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
  });

  it("skip and unskip carry no body (or {}): anything in one is 403 out_of_scope", async () => {
    for (const path of [`/api/plan/workouts/${id}/skip`, `/api/plan/workouts/${id}/unskip`]) {
      for (const raw of ['{"x":1}', '{"until":"2026-11-30"}', "[]", "null", "not json", "{} {}"]) {
        const a = await w.call("POST", path, { bearer: v2, raw });
        expect([path, raw, a.status, a.json]).toEqual([path, raw, 403, { error: "out_of_scope" }]);
        expect(a.writes).toEqual([]);
      }
    }
    expect(rowOf(id)).toMatchObject({ completion: "scheduled" });
    expect((await w.call("POST", `/api/plan/workouts/${id}/skip`, { bearer: v2 })).json).toEqual({ ok: true });
    expect((await w.call("POST", `/api/plan/workouts/${id}/unskip`, { bearer: v2, raw: " { } " })).json).toEqual({ ok: true });
    expect((await w.call("POST", `/api/plan/workouts/${id}/skip`, { bearer: v2, raw: "" })).json).toEqual({ ok: true });
  });

  it("the phone's drain names the one session it moved, exactly {workoutId}: no body, {} or anything more is 403 out_of_scope", async () => {
    for (const raw of ["", "{}", " { } ", '{"workoutId":""}', `{"workoutId":${JSON.stringify("x".repeat(201))}}`, '{"workoutId":7}', '{"workoutId":null}', `{"workoutId":"${id}","all":true}`, '{"x":1}', "[]", "null", "not json"]) {
      const a = await w.call("POST", "/api/sessions/watch/drain", { bearer: v2, raw });
      expect([raw.slice(0, 40), a.status, a.json]).toEqual([raw.slice(0, 40), 403, { error: "out_of_scope" }]);
      expect(a.writes).toEqual([]);
    }
  });
});

describe("a session done or under way: run-garden's own refusal and why", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
    id = await workoutOn(D);
    setClock(D, "17:55");
  });

  it("under way (started on the phone): move and skip are 409 session_under_way with its words, nothing written", async () => {
    await phoneStarts(id);
    const before = everything();
    for (const bearer of [v2, null]) {
      for (const a of [await move(id, { toDate: THU, toTime: "18:00", from: { date: D, time: "18:00" } }, bearer), await skip(id, bearer)]) {
        expect([a.status, a.json]).toEqual([409, { error: "session_under_way", why: UNDER_WAY_WORDS }]);
      }
    }
    expect(everything()).toEqual(before);
  });

  it("done (saved from the phone): move and skip are 409 session_completed with its words, unskip 422; nothing written", async () => {
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    await phoneSaves(id, build);
    expect(rowOf(id)).toMatchObject({ completion: "completed" });
    const before = everything();
    for (const bearer of [v2, null]) {
      for (const a of [await move(id, { toDate: THU, toTime: "18:00", from: { date: D, time: "18:00" } }, bearer), await skip(id, bearer)]) {
        expect([a.status, a.json]).toEqual([409, { error: "session_completed", why: COMPLETED_WORDS }]);
      }
      expect([(await unskip(id, bearer)).status]).toEqual([422]);
    }
    expect(everything()).toEqual(before);
  });

  it("the guard's refusal comes before a stale from: a done session says it is done", async () => {
    const build = await phoneStarts(id);
    setClock(D, "18:40");
    await phoneSaves(id, build);
    const a = await move(id, { toDate: THU, toTime: "18:00", from: { date: FRI, time: "07:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_completed", why: COMPLETED_WORDS }]);
  });
});

describe("Move's from: a move made against a stale view is refused, for every caller", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
    id = await workoutOn(THU);
  });

  it("the laptop moved it to another day first: the phone's move from the old slot is 409 session_changed, nothing written", async () => {
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
    const before = everything();
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
    expect(everything()).toEqual(before);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
  });

  it("only its time changed meanwhile: still stale, still refused", async () => {
    expect((await move(id, { toDate: THU, toTime: "19:00" }, null)).status).toBe(200);
    const before = everything();
    const a = await move(id, { toDate: THU, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
    expect(everything()).toEqual(before);
  });

  it("an untimed row: from's time null is where it stands; a time is stale", async () => {
    exec(`update planned_workouts set effective_time = '' where id = ?`, id);
    const before = everything();
    const stale = await move(id, { toDate: FRI, toTime: "07:00", from: { date: THU, time: "18:00" } });
    expect([stale.status, stale.json.error]).toEqual([409, "session_changed"]);
    expect(everything()).toEqual(before);
    // R2-2: the phone's move sets a time on a row that had none.
    const taken = await move(id, { toDate: FRI, toTime: "07:00", from: { date: THU, time: null } });
    expect(taken.status, taken.text).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
  });

  it("Undo is a move back with from at the new slot: taken, and the row is where it was", async () => {
    expect((await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } })).status).toBe(200);
    expect((await move(id, { toDate: THU, toTime: "18:00", from: { date: SAT, time: "18:15" } })).status).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: THU, time: "18:00", completion: "scheduled" });
    // An Undo sent after the laptop moved it again is refused, never an overwrite of the laptop's choice.
    expect((await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } })).status).toBe(200);
    expect((await move(id, { toDate: FRI, toTime: "12:00" }, null)).status).toBe(200);
    const undo = await move(id, { toDate: THU, toTime: "18:00", from: { date: SAT, time: "18:15" } });
    expect([undo.status, undo.json.error]).toEqual([409, "session_changed"]);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "12:00" });
  });

  it("the web may send it too, held to the same rule; without it the web's move is as it always was", async () => {
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, v2)).status).toBe(200);
    const before = everything();
    const stale = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } }, null);
    expect([stale.status, stale.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
    expect(everything()).toEqual(before);
    expect((await move(id, { toDate: SAT, toTime: "18:15", from: { date: FRI, time: "07:00" } }, null)).status).toBe(200);
    expect((await move(id, { toDate: THU, toTime: "18:00" }, null)).status).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: THU, time: "18:00" });
    // A malformed from from the web is refused 400, as any malformed move (the web never sends one).
    expect([(await move(id, { toDate: FRI, toTime: "07:00", from: { date: THU } }, null)).status]).toEqual([400]);
  });

  it("held in the guarded write: the laptop's move landing between the phone's read and its write wins, and nothing of the phone's lands", async () => {
    const made = overridesOf(id);
    const audits = () => q(`select count(*) as n from audit_events where kind = 'workout_moved'`)[0].n as number;
    const audited = audits();
    let laptop: Record<string, unknown[]> = {};
    gates.move = async () => {
      expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
      laptop = everything();
    };
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
    // The laptop's move alone: its override and its audit, none of the phone's; the database as the laptop left it.
    expect(overridesOf(id)).toEqual([...made, { kind: "user_move", from: THU, to: FRI, time: "07:00", source: "app" }]);
    expect(audits()).toBe(audited + 1);
    expect(everything()).toEqual(laptop);
  });

  it("…and without from the same race is the web's as before: the later move wins (from is what makes a late edit safe)", async () => {
    gates.move = async () => {
      expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
    };
    const a = await move(id, { toDate: SAT, toTime: "18:15" });
    expect(a.status, a.text).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: SAT, time: "18:15" });
  });

  // m1 (review RG): `from` holds the row's state too, not only its slot — a session removed or set aside since is not
  // re-dated behind the person's back, and the phone is never told a move landed that run-garden doesn't show.
  it("the laptop removed it meanwhile: the phone's move from its slot is 404 not_found, nothing written", async () => {
    const removed = await w.call("DELETE", `/api/workouts/${id}`);
    expect(removed.status, removed.text).toBe(200);
    expect(q(`select archived_at is not null as archived from planned_workouts where id = ?`, id)).toEqual([{ archived: 1 }]);
    const before = everything();
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([404, { error: "not_found", why: GONE_WORDS }]);
    expect(everything()).toEqual(before);
  });

  it.each([
    ["skipped on the laptop", async () => expect((await skip(id, null)).status).toBe(200)],
    // As reconcile writes it once the window has passed unanswered, or the athlete says it didn't happen.
    ["missed", async () => exec(`update planned_workouts set completion_state = 'missed', resolution_date = ? where id = ?`, D, id)],
  ])("%s meanwhile: the phone's move from its slot is 409 session_changed, set aside, nothing written", async (_name, setAside) => {
    await setAside();
    const state = rowOf(id).completion;
    const before = everything();
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: SET_ASIDE_WORDS }]);
    expect(everything()).toEqual(before);
    expect(rowOf(id)).toMatchObject({ date: THU, time: "18:00", completion: state });
  });

  it("the web without from is unchanged: it still re-dates a skipped row, as before", async () => {
    expect((await skip(id, null)).status).toBe(200);
    expect((await move(id, { toDate: SAT, toTime: "18:15" }, null)).status).toBe(200);
    expect(rowOf(id)).toMatchObject({ date: SAT, time: "18:15", completion: "skipped" });
  });

  it.each(["removed", "skipped"] as const)("held in the guarded write: the laptop's session %s between the phone's read and its write wins; nothing of the phone's lands", async (what) => {
    let laptop: Record<string, unknown[]> = {};
    gates.move = async () => {
      const a = what === "removed" ? await w.call("POST", `/api/plan/workouts/${id}/remove`, { body: {} }) : await skip(id, null);
      expect(a.status, a.text).toBe(200);
      laptop = everything();
    };
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual(what === "removed" ? [404, { error: "not_found", why: GONE_WORDS }] : [409, { error: "session_changed", why: SET_ASIDE_WORDS }]);
    expect(everything()).toEqual(laptop);
    expect(rowOf(id)).toMatchObject({ date: THU, time: "18:00" });
  });

  it("skipped and then removed on the laptop: removed is what it says (404 not_found), before set aside (r2 N7)", async () => {
    expect((await skip(id, null)).status).toBe(200);
    const removed = await w.call("POST", `/api/plan/workouts/${id}/remove`, { body: {} });
    expect(removed.status, removed.text).toBe(200);
    expect(q(`select archived_at is not null as archived, completion_state as state from planned_workouts where id = ?`, id)).toEqual([{ archived: 1, state: "skipped" }]);
    const before = everything();
    const a = await move(id, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } });
    expect([a.status, a.json]).toEqual([404, { error: "not_found", why: GONE_WORDS }]);
    expect(everything()).toEqual(before);
  });

  it("the web's move audit is as it always was, with no seen; only a move sent with from records one (r2 N9)", async () => {
    const audit = () => q(`select detail from audit_events where kind = 'workout_moved' order by created_at desc, rowid desc limit 1`).map((r) => JSON.parse(r.detail as string))[0];
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
    expect(audit()).toEqual({ workoutId: id, fromDate: THU, toDate: FRI, toTime: "07:00", source: "app" });
    // The phone's move without from: as the web's.
    expect((await move(id, { toDate: SAT, toTime: "07:00" })).status).toBe(200);
    expect(audit()).toEqual({ workoutId: id, fromDate: FRI, toDate: SAT, toTime: "07:00", source: "app" });
    expect((await move(id, { toDate: THU, toTime: "18:00", from: { date: SAT, time: "07:00" } })).status).toBe(200);
    expect(audit()).toEqual({ workoutId: id, fromDate: SAT, toDate: THU, toTime: "18:00", source: "app", seen: { date: SAT, time: "07:00" } });
  });
});

describe("a race the guard wins: its own words, never 'moved since' (m4)", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
    id = await workoutOn(D);
    // The laptop moved it to 19:00 this morning: the phone's view (18:00) is stale.
    expect((await move(id, { toDate: D, toTime: "19:00" }, null)).status).toBe(200);
    setClock(D, "17:55");
  });

  it("started on the phone between the read and the write: session_under_way, with its words", async () => {
    gates.move = async () => void (await phoneStarts(id));
    const a = await move(id, { toDate: THU, toTime: "18:00", from: { date: D, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_under_way", why: UNDER_WAY_WORDS }]);
    expect(rowOf(id)).toMatchObject({ date: D, time: "19:00", content: "started" });
  });

  it("done between the read and the write (a save landing): session_completed, with its words", async () => {
    gates.move = async () => exec(`update planned_workouts set completion_state = 'completed' where id = ?`, id);
    const a = await move(id, { toDate: THU, toTime: "18:00", from: { date: D, time: "18:00" } });
    expect([a.status, a.json]).toEqual([409, { error: "session_completed", why: COMPLETED_WORDS }]);
    expect(rowOf(id)).toMatchObject({ date: D, time: "19:00", completion: "completed" });
  });
});

describe("the gate, as for v1", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world({ WATCH_PUSH_ENABLED: "1" });
    id = await workoutOn(THU);
  });
  /** Each of v2's four, in turn. */
  const all = async (bearer: string, env?: CallOpts["env"]) => [
    await w.call("POST", `/api/plan/workouts/${id}/move`, { bearer, env, body: { toDate: FRI, toTime: "07:00", from: { date: THU, time: "18:00" } } }),
    await w.call("POST", `/api/plan/workouts/${id}/skip`, { bearer, env }),
    await w.call("POST", `/api/plan/workouts/${id}/unskip`, { bearer, env }),
    await w.call("POST", "/api/sessions/watch/drain", { bearer, env, body: { workoutId: id } }),
  ];

  it("the restore lock: each is 423 restore_in_progress and writes nothing; reads still answer; v1 is still 403 first", async () => {
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const before = everything();
    for (const a of await all(v2)) expect([a.status, a.json]).toEqual([423, { error: "restore_in_progress" }]);
    for (const a of await all(v1)) expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
    expect(everything()).toEqual(before);
    expect((await w.call("GET", "/api/native/today", { bearer: v2 })).status).toBe(200);
  });

  it("the kill switch off: 401 device_access_off before any read", async () => {
    for (const off of [undefined, "0", "true"]) {
      for (const a of await all(v2, { NATIVE_DEVICES: off })) {
        expect([a.status, a.json]).toEqual([401, { error: "device_access_off" }]);
        expect(a.statements).toEqual([]);
      }
    }
  });

  it("revoked, expired or pending: 401, nothing written", async () => {
    const revoked = (await seedDevice(w.db, w.userId, { scope: V2, state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" })).token;
    const expired = (await seedDevice(w.db, w.userId, { scope: V2, expiresAt: new Date(Date.now() - 1000).toISOString() })).token;
    const pending = (await seedDevice(w.db, w.userId, { scope: V2, state: "pending", confirmedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString() })).token;
    const before = everything();
    for (const [token, error] of [[revoked, "device_revoked"], [expired, "device_expired"], [pending, "device_pending"]] as const) {
      for (const a of await all(token)) expect([a.status, a.json]).toEqual([401, { error }]);
    }
    expect(everything()).toEqual(before);
  });

  it("a device row with a scope this Worker doesn't know, a prototype's name included: 403 out_of_scope, never a 500 (m2)", async () => {
    for (const scope of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "training-v5", "TRAINING-V2", "training-v2 ", ""]) {
      const { token } = await seedDevice(w.db, w.userId, { scope, lastUsedAt: nowInstant() });
      for (const a of [await w.call("GET", "/api/native/me", { bearer: token }), await w.call("GET", "/api/native/today", { bearer: token }), ...(await all(token))]) {
        expect([scope, a.status, a.json]).toEqual([scope, 403, { error: "out_of_scope" }]);
      }
    }
  });

  it("a revoke takes effect on the next request: the phone that moved is refused right after", async () => {
    const phone = await seedDevice(w.db, w.userId, { scope: V2, lastUsedAt: nowInstant() });
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, phone.token)).status).toBe(200);
    expect((await w.call("POST", `/api/native/devices/${phone.id}/revoke`, { body: {} })).json).toEqual({ ok: true, revoked: true });
    const a = await move(id, { toDate: SAT, toTime: "07:00", from: { date: FRI, time: "07:00" } }, phone.token);
    expect([a.status, a.json]).toEqual([401, { error: "device_revoked" }]);
    expect(rowOf(id)).toMatchObject({ date: FRI, time: "07:00" });
  });
});

describe("the watch: watchDrain handed back, and the phone's drain", () => {
  let server: MockCorosServer;
  const PROGRAM = "prog-native-plan-edits-01";
  const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training" };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOON));
    await world({ WATCH_PUSH_ENABLED: "1" });
    server = mockCorosServer();
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      fetches += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
      return server.fetchImpl(input, init);
    }) as typeof fetch);
    await savePreferences(w.db, w.userId, { ...(await loadPreferences(w.db, w.userId)), corosWritesEnabled: true });
    await seedTmj(w.db, w.userId);
    await seedCatalog(w.db);
    await connectMock(w.db, w.userId, server);
    await w.db.insert(programs).values({
      id: PROGRAM, userId: w.userId, kind: "adaptive", name: "Strength program", status: "active", disciplines: ["strength", "yoga"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: NOON, updatedAt: NOON, archivedAt: null,
    });
  });

  const jobOf = async (jobId: string) => (await w.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0];
  const copiesNamed = (stamp: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === stamp).length;

  /** Today's programme slot, built on the laptop with its check, sent and on the watch. */
  async function sentSlot(): Promise<{ workoutId: string; buildId: string; stamp: string }> {
    const workoutId = slotId(PROGRAM, DAY);
    await w.db.insert(plannedWorkouts).values({
      id: workoutId, userId: w.userId, planId: PROGRAM, sourceWorkoutId: workoutId, title: "Strength program", category: "strength", sport: "strength",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
    });
    const buildId = (await buildToday(w.db, w.userId, await loadPreferences(w.db, w.userId), workoutId)).build!.buildId;
    const { digest } = (await w.call("GET", `/api/sessions/${workoutId}/watch-preview`)).json as { digest: string };
    expect((await w.call("POST", `/api/sessions/${workoutId}/send-to-watch`, { body: { buildId, digest } })).status).toBe(200);
    await w.call("POST", "/api/sessions/watch/drain", { body: {} });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    const stamp = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name;
    return { workoutId, buildId, stamp };
  }

  it("the phone moves a sent programme session: watchDrain, the take-off queued; its drain takes the copy off; each within budget", async () => {
    const { workoutId, buildId, stamp } = await sentSlot();
    expect(copiesNamed(stamp)).toBe(1);
    const mv = await move(workoutId, { toDate: TOMORROW, toTime: "18:00", from: { date: DAY, time: "18:00" } });
    expect([mv.status, mv.json], mv.text).toEqual([200, { workoutId, corosSyncState: "calendar_only", watchDrain: true }]);
    expect(mv.total).toBeLessThanOrEqual(BUDGET);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(copiesNamed(stamp)).toBe(1);

    const d = await drain(v2, workoutId);
    expect([d.status, d.json], d.text).toEqual([200, { ran: true, pending: 0 }]);
    expect(d.total).toBeLessThanOrEqual(BUDGET);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(stamp)).toBe(0);
    // Nothing left: the phone's chain stops on the next answer.
    expect((await drain(v2, workoutId)).json).toEqual({ ran: false, pending: 0 });
  });

  it("its answer lost, the move resent: 200 with the same answer (watchDrain still, the take-off still waiting), nothing new queued", async () => {
    const { workoutId, buildId, stamp } = await sentSlot();
    const body = { toDate: TOMORROW, toTime: "18:00", from: { date: DAY, time: "18:00" } };
    const first = await move(workoutId, body);
    expect(first.status, first.text).toBe(200);
    const before = everything();
    const again = await move(workoutId, body);
    expect([again.status, again.json]).toEqual([200, first.json]);
    expect(again.total).toBeLessThanOrEqual(BUDGET);
    expect(everything()).toEqual(before);
    expect((await drain(v2, workoutId)).json).toEqual({ ran: true, pending: 0 });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(copiesNamed(stamp)).toBe(0);
  });

  it("the phone's drain runs only the session it names: another session's queued push and the mirror's sweep wait for the lanes", async () => {
    const { workoutId, buildId } = await sentSlot();
    // Another programme's session today, built and sent on the laptop, its push queued and not yet run.
    const other = "prog-native-plan-edits-02";
    await w.db.insert(programs).values({
      id: other, userId: w.userId, kind: "adaptive", name: "Mobility program", status: "active", disciplines: ["strength", "yoga"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: NOON, updatedAt: NOON, archivedAt: null,
    });
    const otherId = slotId(other, DAY);
    await w.db.insert(plannedWorkouts).values({
      id: otherId, userId: w.userId, planId: other, sourceWorkoutId: otherId, title: "Mobility program", category: "strength", sport: "strength",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "07:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
    });
    const otherBuild = (await buildToday(w.db, w.userId, await loadPreferences(w.db, w.userId), otherId)).build!.buildId;
    const { digest } = (await w.call("GET", `/api/sessions/${otherId}/watch-preview`)).json as { digest: string };
    expect((await w.call("POST", `/api/sessions/${otherId}/send-to-watch`, { body: { buildId: otherBuild, digest } })).status).toBe(200);
    expect((await jobOf(`push:${otherBuild}`))!.status).toBe("queued");
    // And a Studio workout tomorrow with no copy yet: the mirror's sweep has work.
    const studio = await workoutOn(TOMORROW);

    expect((await move(workoutId, { toDate: TOMORROW, toTime: "18:00", from: { date: DAY, time: "18:00" } })).json.watchDrain).toBe(true);
    const jobsBefore = q(`select id, status from coros_write_jobs where workout_id <> ? order by id`, workoutId);
    const buildsBefore = q(`select id from session_builds where workout_id = ? order by id`, studio);
    // The account's drain takes a push first; the phone's runs only its own session's take-off, and counts only its own.
    const d = await drain(v2, workoutId);
    expect([d.status, d.json], d.text).toEqual([200, { ran: true, pending: 0 }]);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(q(`select id, status from coros_write_jobs where workout_id <> ? order by id`, workoutId)).toEqual(jobsBefore);
    expect((await jobOf(`push:${otherBuild}`))!.status).toBe("queued");
    expect(q(`select id from session_builds where workout_id = ? order by id`, studio)).toEqual(buildsBefore);
    expect((await drain(v2, workoutId)).json).toEqual({ ran: false, pending: 0 });
    // A session id that isn't the account's: nothing runs.
    expect((await drain(v2, "someone-elses-session")).json).toEqual({ ran: false, pending: 0 });
    // The web's drain is the account's, as before: it runs the other work.
    const web = await drain(null);
    expect([web.status, web.json.ran]).toEqual([200, true]);
    expect(q(`select id, status from coros_write_jobs where workout_id <> ? order by id`, workoutId)).not.toEqual(jobsBefore);
  });

  it("the phone's named drain claims only watch-copy jobs: never that session's own COROS move or coach job (r2 N17)", async () => {
    const workoutId = await seedSlot(w.db, w.userId, DAY);
    const earlier = new Date(Date.parse(NOON) - 3_600_000).toISOString();
    const job = (id: string, kind: string) => ({
      id, userId: w.userId, workoutId, kind, expectedContentFingerprint: "x", originalDate: DAY, destinationDate: TOMORROW, requestedAt: earlier, status: "queued", updatedAt: earlier,
    });
    // Queued ahead of any watch job, all this session's: a COROS move, an address-path delete (the lanes'), a coach write.
    await w.db.insert(corosWriteJobs).values([job("move-job-n17", "move_scheduled_workout"), job(`${workoutId}-unpush`, "coach_delete_workout"), job("coach-job-n17", "coach_update_workout")]);
    const jobs = () => q(`select * from coros_write_jobs where workout_id = ? order by id`, workoutId);
    const before = jobs();
    const d = await drain(v2, workoutId);
    expect([d.status, d.json], d.text).toEqual([200, { ran: false, pending: 0 }]);
    expect(jobs()).toEqual(before);
  });

  it("with the watch switch off: the move hands back no watchDrain, and the drain is 404 as for the web", async () => {
    const workoutId = await seedSlot(w.db, w.userId, DAY);
    const off = { WATCH_PUSH_ENABLED: undefined };
    const mv = await w.call("POST", `/api/plan/workouts/${workoutId}/move`, { bearer: v2, env: off, body: { toDate: TOMORROW, toTime: "18:00", from: { date: DAY, time: "18:00" } } });
    expect(mv.status, mv.text).toBe(200);
    expect(mv.json.watchDrain).toBeUndefined();
    for (const [bearer, body] of [[v2, { workoutId }], [null, {}]] as const) {
      const d = await w.call("POST", "/api/sessions/watch/drain", { ...(bearer ? { bearer } : {}), env: off, body });
      expect([d.status, d.json]).toEqual([404, { error: "not_found" }]);
    }
  });
});

describe("a retried request whose first answer was lost (kit v0.14): 200, and nothing new", () => {
  let id: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world();
    id = await workoutOn(THU);
  });
  const body = { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } };

  it("a move resent with the same {toDate, toTime, from}: 200 with the first answer, no row, override, intent, job or audit added", async () => {
    const first = await move(id, body);
    expect(first.status, first.text).toBe(200);
    const before = everything();
    for (let i = 0; i < 2; i++) {
      const again = await move(id, body);
      expect([again.status, again.json]).toEqual([200, first.json]);
    }
    expect(everything()).toEqual(before);
  });

  it("an untimed session's move (from's time null), resent: 200, nothing added", async () => {
    exec(`update planned_workouts set effective_time = '' where id = ?`, id);
    const untimed = { ...body, from: { date: THU, time: null } };
    expect((await move(id, untimed)).status).toBe(200);
    const before = everything();
    expect((await move(id, untimed)).status).toBe(200);
    expect(everything()).toEqual(before);
  });

  it("not the phone's own success: the laptop put it at the phone's destination itself — 409 moved since, nothing written", async () => {
    expect((await move(id, { toDate: SAT, toTime: "18:15" }, null)).status).toBe(200);
    const before = everything();
    const a = await move(id, body);
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
    expect(everything()).toEqual(before);
  });

  it("not once something else moved it since, even back to the same place: 409 moved since", async () => {
    expect((await move(id, body)).status).toBe(200);
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
    expect((await move(id, { toDate: SAT, toTime: "18:15" }, null)).status).toBe(200);
    const a = await move(id, body);
    expect([a.status, a.json]).toEqual([409, { error: "session_changed", why: MOVED_SINCE_WORDS }]);
  });

  it("not once it was set aside since: 409 set aside; nor another move from the same slot to elsewhere: 409 moved since", async () => {
    expect((await move(id, body)).status).toBe(200);
    expect((await move(id, { ...body, toDate: FRI })).json).toEqual({ error: "session_changed", why: MOVED_SINCE_WORDS });
    expect((await skip(id, null)).status).toBe(200);
    expect((await move(id, body)).json).toEqual({ error: "session_changed", why: SET_ASIDE_WORDS });
  });

  it("a skip resent: 200, skipped once (no second skip, take-off or override)", async () => {
    expect((await skip(id)).json).toEqual({ ok: true });
    const row = q(`select * from planned_workouts where id = ?`, id);
    const changes = () => ({ overrides: overridesOf(id), jobs: q(`select * from coros_write_jobs order by id`), intents: q(`select * from sync_intents order by rowid`), audits: q(`select * from audit_events order by rowid`) });
    const before = changes();
    expect((await skip(id)).json).toEqual({ ok: true });
    expect(q(`select * from planned_workouts where id = ?`, id)).toEqual(row);
    expect(changes()).toEqual(before);
  });

  it("an unskip resent: 200, as the first was, nothing written; an unskip of one never skipped, or changed since, is still 422", async () => {
    expect((await skip(id)).status).toBe(200);
    expect((await unskip(id)).json).toEqual({ ok: true });
    const before = everything();
    const again = await unskip(id);
    expect([again.status, again.json]).toEqual([200, { ok: true }]);
    expect(everything()).toEqual(before);
    // Never skipped: as before.
    const other = await workoutOn(FRI);
    expect([(await unskip(other)).status, (await unskip(other)).json]).toEqual([422, { error: "not_skipped" }]);
    // Moved since the unskip: the resent unskip is no longer the last thing that happened to it.
    expect((await move(id, { toDate: FRI, toTime: "07:00" }, null)).status).toBe(200);
    expect([(await unskip(id)).status]).toEqual([422]);
  });

  it("an unskip resent after the laptop removed it: 422, not taken (r2 N13)", async () => {
    expect((await skip(id)).status).toBe(200);
    expect((await unskip(id)).json).toEqual({ ok: true });
    expect((await w.call("POST", `/api/plan/workouts/${id}/remove`, { body: {} })).status).toBe(200);
    // Removing writes no schedule override: the row's latest is still the unskip's restore, so only the archive says no.
    expect(overridesOf(id).at(-1)).toMatchObject({ kind: "restore", source: "app" });
    const before = everything();
    const a = await unskip(id);
    expect([a.status, a.json]).toEqual([422, { error: "not_skipped" }]);
    expect(everything()).toEqual(before);
  });

  it("a move resent after its destination day passed (unresolved, at exactly its destination): taken, 200, nothing written (r2-m2)", async () => {
    const first = await move(id, body);
    expect(first.status, first.text).toBe(200);
    // The destination day passes with nothing done: the daily reconcile asks about it.
    setClock(addDays(SAT, 2), "03:15");
    await reconcileCompletionStates(w.db, w.userId, await loadPreferences(w.db, w.userId));
    expect(rowOf(id)).toMatchObject({ date: SAT, time: "18:15", completion: "unresolved" });
    const before = everything();
    const again = await move(id, body);
    expect([again.status, again.json]).toEqual([200, first.json]);
    expect(everything()).toEqual(before);
  });
});

describe("the request budget: every v2 request within 45 statements and fetches, D1's bind cap on", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(D, "09:00");
    await world({ WATCH_PUSH_ENABLED: "1" });
  });

  it("a move with from, a stale one refused, a skip, an unskip, a programme slot's move and the drain", async () => {
    const doc = await workoutOn(THU);
    const slot = await seedSlot(w.db, w.userId, THU);
    const costs: Array<[string, number, number]> = [];
    const spend = async (label: string, a: Promise<Answer & { total: number }>) => {
      const r = await a;
      costs.push([label, r.status, r.total]);
      return r;
    };
    await spend("move, from", move(doc, { toDate: SAT, toTime: "18:15", from: { date: THU, time: "18:00" } }));
    await spend("move, stale from", move(doc, { toDate: FRI, toTime: "18:15", from: { date: THU, time: "18:00" } }));
    await spend("move, the slot (watchDrain)", move(slot, { toDate: FRI, toTime: "18:00", from: { date: THU, time: "18:00" } }));
    await spend("move, the slot, resent", move(slot, { toDate: FRI, toTime: "18:00", from: { date: THU, time: "18:00" } }));
    await spend("drain, the slot", drain(v2, slot));
    await spend("skip", skip(doc));
    await spend("skip, resent", skip(doc));
    await spend("unskip", unskip(doc));
    await spend("unskip, resent", unskip(doc));
    await spend("skip, the slot", skip(slot));
    await spend("unskip, the slot", unskip(slot));
    expect(costs.map(([label, status]) => [label, status])).toEqual([
      ["move, from", 200],
      ["move, stale from", 409],
      ["move, the slot (watchDrain)", 200],
      ["move, the slot, resent", 200],
      ["drain, the slot", 200],
      ["skip", 200],
      ["skip, resent", 200],
      ["unskip", 200],
      ["unskip, resent", 200],
      ["skip, the slot", 200],
      ["unskip, the slot", 200],
    ]);
    console.info(`[native-plan-edits budget] ${costs.map(([l, , t]) => `${l}: ${t}`).join("; ")}`);
    expect(costs.filter(([, , total]) => total > BUDGET)).toEqual([]);
  });
});
