/**
 * THE PHONE'S HISTORY (stage 2c, kit v0.16; DESIGN-2c §2.2, §9.1): `GET /api/native/history?before&limit` for a
 * `training-v4` device — what was done, newest first, in pages of whole days, back one year on the account's clock.
 *
 *  - pages: whole days (`limit` 1 takes a day's every row), `next`, the default `before` (today in), the year's bound, and a
 *    day cut at 60 rows with `capped`;
 *  - every source: an app session with its sets, moves and note, an app session merged with its watch copy (the athlete's
 *    own record shown), a watch strength copy (in the athlete's unit), a planned COROS run, an extra run, a session said
 *    done, an import;
 *  - the exact key set of a row, so no heart rate, pace, check or telemetry can slip in — and no check row is ever read;
 *  - two accounts, writes nothing, the gate, the restore's 503 and the budget (≤ 15).
 *
 * Under a faked `Date`. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, humanizeWorkoutTitle, newId } from "@rg/domain";
import { nativeRoutes } from "../src/routes/native.js";
import { exerciseDisplayName } from "../src/services/logged-sets.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, activities, conditionChecks, performedSessions, performedSets, plannedWorkouts, sessionBuilds, workoutCompletionMatches } = schema;

const LA = "America/Los_Angeles";
const T = "2026-11-16";
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const NOW = at(T, "12:00");
const V4 = "training-v4";
const ROW_KEYS = ["id", "date", "time", "source", "sport", "title", "seconds", "distanceMeters", "planned", "extra", "moves", "sets", "note"];

let w: NativeWorld;
let token: string;
let fetched: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    throw new Error("no external call from a read");
  }) as typeof fetch);
  w = await nativeWorld([["/api/native", nativeRoutes]]);
  ({ token } = await seedDevice(w.db, w.userId, { scope: V4, lastUsedAt: NOW }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const history = (query = "", bearer = token) => w.call("GET", `/api/native/history${query}`, { bearer });
const page = async (query = "") => {
  const a = await history(query);
  expect(a.status, a.text).toBe(200);
  return a.json as { version: number; today: string; readAt: string; corosReadAt: string | null; rows: Array<Record<string, any>>; next: string | null; capped: boolean };
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function activity(over: Partial<typeof activities.$inferInsert> & { startTime: string }, userId = w.userId): Promise<string> {
  const id = over.id ?? newId();
  await w.db.insert(activities).values({
    id, userId, source: "coros", corosActivityId: `c-${id}`, sport: "run", durationSeconds: 3480, distanceMeters: 11400, title: "Morning Run",
    // What the phone is never told.
    avgHeartRate: 147.75, maxHeartRate: 178.5, avgPaceSecPerKm: 305.125, elevationGainMeters: 88.25, trainingLoad: 92.5, deviceName: "Synthetic Watch 3",
    telemetry: { feelRating: 4, cadence: { avg: 172 } } as never,
    createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

async function workout(over: Partial<typeof plannedWorkouts.$inferInsert> & { effectiveDate: string }, userId = w.userId): Promise<string> {
  const id = over.id ?? newId();
  const date = over.effectiveDate;
  await w.db.insert(plannedWorkouts).values({
    id, userId, planId: "plan-1", sourceWorkoutId: `src-${id}`, title: "Easy run", category: "easy", sport: "run", originalPlanDate: date,
    lastVerifiedCorosDate: date, effectiveTime: "18:00", sourceContentFingerprint: `fp-${id}`, calendarBlockDurationSeconds: 1800,
    completionState: "scheduled", createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

async function match(workoutId: string, activityId: string): Promise<string> {
  const id = newId();
  await w.db.insert(workoutCompletionMatches).values({ id, workoutId, activityId, confidence: 1, method: "scored_auto", matchedAt: NOW });
  await w.db.update(activities).set({ completionMatchId: id }).where(eq(activities.id, activityId));
  await w.db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
  return id;
}

/** A performed session of `activityId`, with its sets (`[exerciseId, reps, load?]`). */
async function performed(
  activityId: string,
  over: Partial<typeof performedSessions.$inferInsert> & { source: string; localDate: string },
  sets: Array<[string, number, { v: number; u: "lb" | "kg" } | null]> = [],
): Promise<string> {
  const id = over.id ?? newId();
  await w.db.insert(performedSessions).values({ id, userId: w.userId, activityId, completed: true, seconds: 2460, payloadHash: `h-${id}`, createdAt: NOW, updatedAt: NOW, ...over });
  for (const [i, [exerciseId, reps, load]] of sets.entries()) {
    await w.db.insert(performedSets).values({
      id: `${id}:${i}`, performedSessionId: id, entryIndex: i, exerciseId, setIndex: 0, reps, seconds: null,
      loadValue: load?.v ?? null, loadUnit: load?.u ?? null, loadKg: load ? (load.u === "kg" ? load.v : load.v * 0.4536) : null, done: true,
    });
  }
  return id;
}

interface Sources {
  app: string;
  appWorkout: string;
  merged: string;
  watch: string;
  plannedRun: string;
  plannedRunWorkout: string;
  extraRun: string;
  said: string;
  imported: string;
}

/** One of every source, a day apart, newest first: T − 1 … T − 7. */
async function everySource(): Promise<Sources> {
  const d = (n: number) => addDays(T, -n);
  // An app session played in run-garden's player, completing its planned session: sets, moves and its note.
  const appWorkout = await workout({ effectiveDate: d(1), title: "Lower body", category: "strength", sport: "strength", origin: "studio" });
  const app = await activity({ source: "app", corosActivityId: null, sport: "strength", title: "Lower body", startTime: at(d(1), "18:41"), startTimeLocal: `${d(1)}T18:41:00`, durationSeconds: 2460, distanceMeters: null });
  await match(appWorkout, app);
  const buildId = newId();
  await w.db.insert(sessionBuilds).values({
    id: buildId, userId: w.userId, workoutId: appWorkout, version: 1, engineVersion: "e", inputsHash: "h", lockedAt: NOW, createdAt: NOW,
    payload: { build: { date: d(1), items: Array.from({ length: 12 }, (_, i) => ({ slotKey: `s${i}`, exerciseId: "bridge" })) } },
  });
  const sessionId = await performed(
    app,
    { id: app, source: "app", localDate: d(1), workoutId: appWorkout, buildId, note: "Felt strong", movesDone: Array.from({ length: 12 }, () => ({ exerciseId: "bridge", seconds: 60 })) },
    [["bridge", 8, { v: 20, u: "kg" }], ["deadBug", 10, null]],
  );
  // Its readings: never in History.
  await w.db.insert(conditionChecks).values({ id: newId(), userId: w.userId, profileId: "tmj", kind: "pre", value: 7, feelingOff: false, localDate: d(1), at: NOW, performedSessionId: sessionId, workoutId: appWorkout });

  // An app session merged with the watch's copy of it (one COROS row): the athlete's own record, as typed.
  const merged = await activity({ sport: "strength", title: "Strength", startTime: at(d(2), "07:00"), startTimeLocal: `${d(2)}T07:00:00`, durationSeconds: 1900, distanceMeters: 0 });
  await performed(merged, { source: "app", localDate: d(2), movesDone: [{ exerciseId: "bridge", seconds: 60 }] }, [["bridge", 12, { v: 45, u: "lb" }]]);
  await performed(merged, { source: "watch", localDate: d(2) }, [["coros:T1041", 99, { v: 50, u: "kg" }]]);

  // The watch's own strength copy, in the athlete's unit (lb by default).
  const watch = await activity({ sport: "strength", title: "T1041", startTime: at(d(3), "12:00"), startTimeLocal: `${d(3)}T12:00:00`, durationSeconds: 1500, distanceMeters: 0 });
  await performed(watch, { source: "watch", localDate: d(3) }, [["coros:T1041", 10, { v: 20, u: "kg" }]]);

  // A planned COROS run, and an extra one.
  const plannedRunWorkout = await workout({ effectiveDate: d(4), title: "T1004", category: "quality", qualitySubtype: "threshold" });
  const plannedRun = await activity({ startTime: at(d(4), "07:12"), startTimeLocal: `${d(4)}T07:12:00`, distanceMeters: 7000, durationSeconds: 2520 });
  await match(plannedRunWorkout, plannedRun);
  const extraRun = await activity({ startTime: at(d(5), "07:12"), startTimeLocal: `${d(5)}T07:12:00` });

  // Said done (Mark done), no standing match.
  const said = await workout({ effectiveDate: d(6), title: "Lab hips and back", category: "yoga", sport: "yoga", completionState: "completed", sanctionedBy: "athlete_said_done" });

  // The standalone tool's past.
  const imported = await activity({ source: "import", corosActivityId: null, startTime: at(d(7), "08:00"), startTimeLocal: `${d(7)}T08:00:00`, title: "Long run" });
  return { app, appWorkout, merged, watch, plannedRun, plannedRunWorkout, extraRun, said, imported };
}

const raw = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).$client;
function snapshot(): Record<string, string[]> {
  const tables = raw().prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all().map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, raw().prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r)).sort()]));
}

// ── Every source ────────────────────────────────────────────────────────────────────────────────────────────────

describe("every source, newest first", () => {
  it("each row exactly: an app session's sets, moves and note; the merged one's own record; the watch's copy; runs; said done; an import", async () => {
    const s = await everySource();
    const body = await page();
    expect([body.version, body.today, body.next, body.capped]).toEqual([1, T, null, false]);
    const d = (n: number) => addDays(T, -n);
    expect(body.rows).toEqual([
      {
        id: s.app, date: d(1), time: "18:41", source: "app", sport: "strength", title: "Lower body", seconds: 2460, distanceMeters: null,
        planned: { workoutId: s.appWorkout, title: "Lower body", category: "strength", date: d(1) }, extra: false,
        moves: { done: 12, planned: 12 },
        sets: [
          { exerciseId: "bridge", name: exerciseDisplayName("bridge"), sets: [{ reps: 8, seconds: null, load: { v: 20, u: "kg" }, side: null }] },
          { exerciseId: "deadBug", name: exerciseDisplayName("deadBug"), sets: [{ reps: 10, seconds: null, load: null, side: null }] },
        ],
        note: "Felt strong",
      },
      {
        id: s.merged, date: d(2), time: "07:00", source: "coros", sport: "strength", title: "Strength", seconds: 1900, distanceMeters: null,
        planned: null, extra: true, moves: { done: 1, planned: null },
        sets: [{ exerciseId: "bridge", name: exerciseDisplayName("bridge"), sets: [{ reps: 12, seconds: null, load: { v: 45, u: "lb" }, side: null }] }],
        note: null,
      },
      {
        id: s.watch, date: d(3), time: "12:00", source: "coros", sport: "strength", title: "Strength", seconds: 1500, distanceMeters: null,
        planned: null, extra: true, moves: null,
        sets: [{ exerciseId: "coros:T1041", name: exerciseDisplayName("coros:T1041"), sets: [{ reps: 10, seconds: null, load: { v: 44, u: "lb" }, side: null }] }],
        note: null,
      },
      {
        id: s.plannedRun, date: d(4), time: "07:12", source: "coros", sport: "run", title: "Morning Run", seconds: 2520, distanceMeters: 7000,
        planned: { workoutId: s.plannedRunWorkout, title: "T1004", label: humanizeWorkoutTitle("T1004", "quality", "threshold"), category: "quality", date: d(4) },
        extra: false, moves: null, sets: null, note: null,
      },
      { id: s.extraRun, date: d(5), time: "07:12", source: "coros", sport: "run", title: "Morning Run", seconds: 3480, distanceMeters: 11400, planned: null, extra: true, moves: null, sets: null, note: null },
      {
        id: `said:${s.said}`, date: d(6), time: null, source: "said_done", sport: "yoga", title: "Lab hips and back", seconds: null, distanceMeters: null,
        planned: { workoutId: s.said, title: "Lab hips and back", category: "yoga", date: d(6) }, extra: false, moves: null, sets: null, note: null,
      },
      { id: s.imported, date: d(7), time: "08:00", source: "import", sport: "run", title: "Long run", seconds: 3480, distanceMeters: 11400, planned: null, extra: false, moves: null, sets: null, note: null },
    ]);
  });

  it("a row's exact key set: no heart rate, pace, elevation, load, cadence, feel, device or check can slip in, and no check row is read", async () => {
    await everySource();
    const a = await history();
    for (const row of a.json.rows as Array<Record<string, unknown>>) expect(Object.keys(row)).toEqual(ROW_KEYS);
    for (const word of ["147.75", "178.5", "305.125", "88.25", "92.5", "Synthetic Watch", "feel", "cadence", "Heart", "pace", "checks", "tmj", "trainingLoad", "elevation"]) {
      expect(a.text.includes(word), word).toBe(false);
    }
    expect(a.statements.some((s) => /condition_checks/.test(s))).toBe(false);
    // Nor any column it doesn't need: the activities read names none of them.
    expect(a.statements.find((s) => /from "activities"/.test(s))).not.toMatch(/heart_rate|pace|elevation|training_load|device_name|telemetry/);
  });

  it("a session said done with a standing match is the match's row, never said twice; an archived one is gone", async () => {
    const said = await workout({ effectiveDate: addDays(T, -2), completionState: "completed", sanctionedBy: "athlete_said_done" });
    await match(said, await activity({ startTime: at(addDays(T, -2), "07:00"), startTimeLocal: `${addDays(T, -2)}T07:00:00` }));
    await workout({ effectiveDate: addDays(T, -3), completionState: "completed", sanctionedBy: "athlete_said_done", archivedAt: NOW });
    const body = await page();
    expect(body.rows.map((r) => r.source)).toEqual(["coros"]);
    expect(body.rows[0]!.planned.workoutId).toBe(said);
  });
});

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("pages of whole days", () => {
  it("limit 1 takes the newest day's every row; next pages before it; the last page says no next", async () => {
    const D1 = addDays(T, -1);
    const D2 = addDays(T, -4);
    for (const hh of ["06:00", "12:00", "18:00"]) await activity({ startTime: at(D1, hh), startTimeLocal: `${D1}T${hh}:00` });
    for (const hh of ["07:00", "08:00"]) await activity({ startTime: at(D2, hh), startTimeLocal: `${D2}T${hh}:00` });
    const first = await page("?limit=1");
    expect([first.rows.map((r) => [r.date, r.time]), first.next]).toEqual([[[D1, "18:00"], [D1, "12:00"], [D1, "06:00"]], D1]);
    const second = await page(`?limit=1&before=${first.next}`);
    expect([second.rows.map((r) => r.date), second.next]).toEqual([[D2, D2], null]);
    // limit 30 (the default): both days, no next.
    const all = await page();
    expect([all.rows.length, all.next]).toEqual([5, null]);
    expect((await page("?limit=30")).rows).toEqual(all.rows);
  });

  it("the default before is the account's tomorrow: today's sessions are in the first page", async () => {
    await activity({ startTime: at(T, "07:00"), startTimeLocal: `${T}T07:00:00` });
    expect((await page()).rows.map((r) => r.date)).toEqual([T]);
    expect((await page(`?before=${T}`)).rows).toEqual([]);
  });

  it("the year: rows dated a year back at most; before a year back or more is 400 out_of_horizon with today and earliest", async () => {
    const earliest = addDays(T, -365);
    await activity({ startTime: at(earliest, "07:00"), startTimeLocal: `${earliest}T07:00:00` });
    await activity({ startTime: at(addDays(T, -366), "07:00"), startTimeLocal: `${addDays(T, -366)}T07:00:00` });
    expect((await page()).rows.map((r) => r.date)).toEqual([earliest]);
    expect((await page(`?before=${addDays(T, -364)}`)).rows.map((r) => r.date)).toEqual([earliest]);
    for (const before of [earliest, addDays(T, -400)]) {
      const a = await history(`?before=${before}`);
      expect([a.status, a.json]).toEqual([400, { error: "out_of_horizon", today: T, earliest }]);
    }
  });

  it("a day over 60 rows is cut at 60, and the page says capped", async () => {
    const D = addDays(T, -2);
    for (let i = 0; i < 61; i += 1) await activity({ startTime: `${D}T15:${String(i % 60).padStart(2, "0")}:${String(i).padStart(2, "0")}.000Z`, startTimeLocal: `${D}T07:00:00` });
    const body = await page();
    expect([body.rows.length, body.capped]).toEqual([60, true]);
  });

  it("whole days past a page's read of 130 activities: never a day half shown, and the next page goes on from it", async () => {
    // 140 activities, 10 a day over 14 days: the read stops short of the oldest days, which come on later pages.
    for (let day = 1; day <= 14; day += 1) {
      const D = addDays(T, -day);
      for (let i = 0; i < 10; i += 1) await activity({ startTime: at(D, `0${i}:30`), startTimeLocal: `${D}T0${i}:30:00` });
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let n = 0; n < 10; n += 1) {
      const body = await page(`?limit=30${before ? `&before=${before}` : ""}`);
      const perDay = new Map<string, number>();
      for (const r of body.rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
      for (const [date, count] of perDay) expect([date, count]).toEqual([date, 10]);
      seen.push(...body.rows.map((r) => r.id as string));
      before = body.next;
      if (before === null) break;
    }
    expect([seen.length, new Set(seen).size]).toEqual([140, 140]);
  });

  it("the query: a before that isn't a date is 400 bad_range, a limit outside 1–30 400 bad_limit; the gate refuses the rest", async () => {
    expect((await history("?limit=31")).json).toEqual({ error: "bad_limit" });
    expect((await history("?before=2026-02-30")).json).toEqual({ error: "bad_range" });
    for (const q of ["?limit=0", "?limit=01", "?limit=100", "?before=2026-1-1", "?x=1", "?before=2026-11-01&before=2026-11-02", "?limit=1&limit=2"]) {
      const a = await history(q);
      expect([q, a.status, a.json]).toEqual([q, 403, { error: "out_of_scope" }]);
    }
    // The cookie has no query rule: the route checks the values itself.
    expect((await w.call("GET", "/api/native/history?limit=0")).json).toEqual({ error: "bad_limit" });
    expect((await w.call("GET", "/api/native/history?before=2026-1-1")).json).toEqual({ error: "bad_range" });
  });
});

// ── Two accounts, writes nothing, the gate, the budget ──────────────────────────────────────────────────────────

describe("two accounts", () => {
  it("nothing of the other account's is listed; a match naming another account's workout reads as no plan", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirs = await activity({ startTime: at(addDays(T, -1), "07:00"), startTimeLocal: `${addDays(T, -1)}T07:00:00`, title: "Their Run" }, other.userId);
    const theirWorkout = await workout({ effectiveDate: addDays(T, -2), title: "Their said", completionState: "completed", sanctionedBy: "athlete_said_done" }, other.userId);
    const theirPlanned = await workout({ effectiveDate: addDays(T, -3), title: "Their plan" }, other.userId);
    // The owner's activity, crafted to name the other account's workout through a match.
    const mine = await activity({ startTime: at(addDays(T, -3), "07:00"), startTimeLocal: `${addDays(T, -3)}T07:00:00` });
    const crafted = newId();
    await w.db.insert(workoutCompletionMatches).values({ id: crafted, workoutId: theirPlanned, activityId: mine, confidence: 1, method: "manual", matchedAt: NOW });
    await w.db.update(activities).set({ completionMatchId: crafted }).where(eq(activities.id, mine));
    const a = await history();
    expect(a.status).toBe(200);
    expect(a.json.rows.map((r: { id: string }) => r.id)).toEqual([mine]);
    for (const id of [theirs, theirWorkout, theirPlanned, "Their"]) expect(a.text.includes(id), id).toBe(false);
    expect(a.json.rows[0].planned).toBeNull();
  });
});

describe("a read: it writes nothing", () => {
  it("every table as it was, no write statement, no waitUntil, no external call", async () => {
    await everySource();
    const before = snapshot();
    const waitUntil = vi.fn();
    const res = await w.app.request("/api/native/history?limit=30", { headers: { Authorization: `Bearer ${token}` } }, w.env, { waitUntil, passThroughOnException: () => undefined, props: {} } as never);
    expect(res.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect((await history()).writes).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe("the gate", () => {
  it("v1, v2 and v3 are 403; v4 and the cookie are 200, the same answer, no-store", async () => {
    await everySource();
    for (const scope of ["training-slice-v1", "training-v2", "training-v3"]) {
      const d = await seedDevice(w.db, w.userId, { scope, lastUsedAt: NOW });
      expect([scope, (await history("", d.token)).json]).toEqual([scope, { error: "out_of_scope" }]);
    }
    const device = await history();
    const cookie = await w.call("GET", "/api/native/history");
    expect([device.status, cookie.status, device.headers["cache-control"]]).toEqual([200, 200, "no-store"]);
    expect(cookie.json).toEqual(device.json);
  });

  it("503 restore_in_progress, retryable, while a restore replaces the account: before any read of its rows", async () => {
    await everySource();
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: NOW, updatedAt: NOW });
    const a = await history();
    expect([a.status, a.json, a.headers["cache-control"]]).toEqual([503, { error: "restore_in_progress", retryable: true }, "no-store"]);
    expect(a.statements.some((s) => /planned_workouts|activities|performed/.test(s))).toBe(false);
  });
});

describe("what it costs", () => {
  it("at most 15 statements for a page of every source (10 here)", async () => {
    await everySource();
    const a = await history();
    expect(a.status).toBe(200);
    expect(a.statements.length).toBeLessThanOrEqual(15);
    // The gate, restore, preferences; the activities, said done; matches, sessions, sets; build sizes; corosReadAt.
    expect(a.statements.length).toBe(10);
  });
});
