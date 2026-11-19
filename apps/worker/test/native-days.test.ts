/**
 * THE PHONE'S DAYS (stage 2c, kit v0.16; DESIGN-2c §2.1, §2.5, §9.1): `GET /api/native/days?from&to` for a `training-v4`
 * device — the account's planned sessions and extra sessions, at most 14 days a request, within today − 90 … today + 14 on
 * the account's clock; reads only.
 *
 *  - bounds: 400 `bad_range` for a malformed or too-long window, 400 `out_of_horizon` `{today, earliest, latest}` outside
 *    the horizon; the gate's query rule (exactly `from` and `to`, each once, each `YYYY-MM-DD`) refuses 403 before the route;
 *  - every kind on one day (Studio, template, a course's outline due today and one ahead, a written course session, an
 *    engine slot, on-demand, a coach run, a COROS-plan run, a rest row; archived and removed rows left out), every state
 *    (`doneBy` app, coros, said_done; skipped, missed, unresolved, a race, under way today and yesterday) and `can`;
 *  - extras (an unmatched COROS run, an unmatched app session, a strength and a yoga session; a matched run and an import
 *    never; dated by the local start, or the UTC one when there is none; never on a day ahead), never as answering a session;
 *  - the account's clock (`tense` under a faked clock at 23:30 and 00:30), two accounts (nothing of the other's ever
 *    listed, a match to another account's activity never read), writes nothing (every table, no `waitUntil`, no expiry
 *    moved, no external call), parity with the plan read, the gate, the restore's 503, and the statement budget.
 *
 * Under a faked `Date`, on a made-up course (`course-fixture.ts`), the Calendar sync mocked. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, courseConfigSchema, humanizeWorkoutTitle, newId, type CourseConfig, type WorkoutDoc } from "@rg/domain";
import { sha256Hex } from "../src/auth/crypto.js";
import { lifeosRoutes } from "../src/routes/lifeos.js";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { templateRoutes } from "../src/routes/templates.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import type { Db } from "../src/services/db.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type NativeWorld } from "./native-fixture.js";

const { accountState, activities, nativeDevices, plannedWorkouts, programs, providerConnections, sessionBuilds, workoutCompletionMatches } = schema;

const LA = "America/Los_Angeles";
/** A Monday in Los Angeles, and noon of it. */
const T = "2026-11-16";
const WED = "2026-11-18";
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const NOW = at(T, "12:00");
const PLAN_TOKEN = "p".repeat(64);
const V4 = "training-v4";

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
  w = await nativeWorld(
    [
      ["/api/native", nativeRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/workouts", workoutRoutes],
      ["/api/templates", templateRoutes],
      ["/api/lifeos", lifeosRoutes],
    ],
    { env: { LIFEOS_TOKEN_SHA256: await sha256Hex(PLAN_TOKEN) } },
  );
  // Last used just now: a read in this hour writes no last use, so what a request writes is the route's alone.
  ({ token } = await seedDevice(w.db, w.userId, { scope: V4, lastUsedAt: NOW, expiresAt: "2026-12-10T08:00:00.000Z" }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const days = (from: string, to: string, opts: { bearer?: string; cookie?: boolean } = {}) =>
  w.call("GET", `/api/native/days?from=${from}&to=${to}`, opts.cookie ? {} : { bearer: opts.bearer ?? token });
const ok = async (from: string, to: string) => {
  const a = await days(from, to);
  expect(a.status, a.text).toBe(200);
  return a.json as { version: number; today: string; readAt: string; corosReadAt: string | null; days: Array<Record<string, any>> };
};
const dayOf = (body: { days: Array<Record<string, any>> }, date: string) => body.days.find((d) => d.date === date)!;
const sessionOf = (body: { days: Array<Record<string, any>> }, id: string) => body.days.flatMap((d) => d.sessions).find((s: { id: string }) => s.id === id);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A planned row, as the import or the coach would put one (not an app session) — `over` says what it is. */
async function row(over: Partial<typeof plannedWorkouts.$inferInsert> & { effectiveDate?: string }, userId = w.userId): Promise<string> {
  const id = over.id ?? newId();
  const date = over.effectiveDate ?? T;
  await w.db.insert(plannedWorkouts).values({
    id, userId, planId: "coros-plan", sourceWorkoutId: `coros-plan:${id}`, title: "Easy 30", category: "easy", sport: "run",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "06:30", sourceContentFingerprint: `fp-${id}`,
    calendarBlockDurationSeconds: 1800, sourceEstimatedDurationSeconds: 1800, createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

/** An activity of the account's (COROS unless `over` says otherwise). */
async function activity(over: Partial<typeof activities.$inferInsert> & { startTime: string }, userId = w.userId): Promise<string> {
  const id = over.id ?? newId();
  await w.db.insert(activities).values({
    id, userId, source: "coros", corosActivityId: `c-${id}`, sport: "run", durationSeconds: 3480, distanceMeters: 11400,
    title: "Morning Run", createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

/** A standing match of `workoutId` to `activityId`, the activity pointing at it, and the row completed. */
async function matched(workoutId: string, activityId: string, opts: { undone?: boolean; complete?: boolean } = {}): Promise<string> {
  const id = newId();
  await w.db.insert(workoutCompletionMatches).values({ id, workoutId, activityId, confidence: 1, method: "scored_auto", matchedAt: NOW, undoneAt: opts.undone ? NOW : null });
  if (!opts.undone) await w.db.update(activities).set({ completionMatchId: id }).where(eq(activities.id, activityId));
  if (opts.complete !== false) await w.db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: T }).where(eq(plannedWorkouts.id, workoutId));
  return id;
}

/** A plan of the registry's: a COROS plan (`coros_import`), a coach's, or an adaptive programme. */
async function plan(id: string, kind: string, name: string, userId = w.userId): Promise<void> {
  await w.db.insert(programs).values({
    id, userId, kind, name, status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null,
    config: {}, createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
}

/** A running course on Mondays and Wednesdays at `time`, its outlines placed as the hourly pass places them. */
async function course(db: Db, userId: string, config: Partial<CourseConfig> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null,
    raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 2], time: "18:15", placementWeeksAhead: 1, ...config }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
  await placeSlots(db, userId, id, T, await loadPreferences(db, userId), NOW);
  return id;
}

/** A document workout made on the laptop, as the web makes one. */
async function made(doc: WorkoutDoc, date: string, time: string): Promise<string> {
  const a = await w.call("POST", "/api/workouts", { body: { doc, date, time, clientId: `slot-${newId()}` } });
  expect(a.status, a.text).toBe(201);
  return a.json.workout.id as string;
}

interface Kinds {
  studio: string;
  template: string;
  dueOutline: string;
  laterOutline: string;
  writtenCourse: string;
  engine: string;
  onDemand: string;
  coachRun: string;
  watchRun: string;
  rest: string;
  archived: string;
  removed: string;
  coursePlan: string;
  enginePlan: string;
}

/** Every kind of row on today, and an outline on Wednesday. */
async function everyKind(): Promise<Kinds> {
  const studio = await made(calmDoc({ title: "Studio hips" }), T, "07:00");
  const saved = await w.call("POST", "/api/templates", { body: { name: "Saved hips", doc: calmDoc({ title: "Template hips" }) } });
  expect(saved.status, saved.text).toBe(201);
  const used = await w.call("POST", `/api/templates/${saved.json.template.id}/use`, { body: {} });
  const template = await made(used.json.doc as WorkoutDoc, T, "08:00");

  const coursePlan = await course(w.db, w.userId);
  const written = await course(w.db, w.userId, { time: "19:30" });
  // The web opened that one today: written as session 1.
  const opened = await w.call("GET", `/api/sessions/${slotId(written, T)}`);
  expect([opened.status, opened.json.origin], opened.text).toEqual([200, "studio"]);

  const engine = await seedSlot(w.db, w.userId, T);
  const [engineRow] = await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, engine));
  const onDemand = await row({ origin: "on_demand", planId: engineRow!.planId, title: "Quick session", category: "strength", sport: "strength", effectiveTime: "12:00", contentState: "outline" });

  const runDoc = JSON.stringify({ version: 1, title: "Easy 30", intent: { summary: "Easy", goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }], source: { kind: "studio" } });
  const coachRun = await row({ origin: "coach", contentState: "outline", planId: "coach-plan", workoutDoc: runDoc, workoutDocRev: 3, effectiveTime: "06:00" });

  await plan("coros-plan", "coros_import", "Half marathon");
  const watchRun = await row({ title: "T1004", category: "quality", qualitySubtype: "threshold", effectiveTime: "18:30", originalPlanDate: addDays(T, -1), stageSummary: "10 min warm up · 3 × 8 min threshold · 10 min cool down", expectedDistanceMeters: 9000 });
  const rest = await row({ title: "Rest", category: "rest", sport: "rest", effectiveTime: "" });
  const archived = await row({ archivedAt: NOW, archiveReason: "absence_confirmed", title: "Gone run" });
  const removed = await row({ archivedAt: NOW, archiveReason: "user_removed", title: "Removed run" });
  return {
    studio, template, dueOutline: slotId(coursePlan, T), laterOutline: slotId(coursePlan, WED), writtenCourse: slotId(written, T), engine, onDemand,
    coachRun, watchRun, rest, archived, removed, coursePlan, enginePlan: engineRow!.planId,
  };
}

const raw = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).$client;
/** Every table's rows, sorted: what "nothing written" is compared on. */
function snapshot(): Record<string, string[]> {
  const tables = raw().prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all().map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, raw().prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r)).sort()]));
}

// ── Bounds and the query rule ───────────────────────────────────────────────────────────────────────────────────

describe("bounds: at most 14 days, within today − 90 … today + 14 on the account's clock", () => {
  it("14 days answer each day once, in order; 15 days, from after to, or a date that isn't one are 400 bad_range", async () => {
    const body = await ok(T, addDays(T, 13));
    expect(body.days.map((d) => d.date)).toEqual(Array.from({ length: 14 }, (_, i) => addDays(T, i)));
    expect([body.version, body.today]).toEqual([1, T]);
    for (const [from, to] of [[T, addDays(T, 14)], [addDays(T, 1), T], ["2026-02-30", "2026-03-01"], [T, "2026-13-01"]] as const) {
      const a = await days(from, to);
      expect([from, to, a.status, a.json]).toEqual([from, to, 400, { error: "bad_range" }]);
    }
  });

  it("from T − 90 and to T + 14 answer; T − 91 or T + 15 is 400 out_of_horizon with today, earliest and latest", async () => {
    expect((await ok(addDays(T, -90), addDays(T, -77))).days[0]!.date).toBe(addDays(T, -90));
    expect((await ok(addDays(T, 1), addDays(T, 14))).days.at(-1)!.date).toBe(addDays(T, 14));
    const horizon = { error: "out_of_horizon", today: T, earliest: addDays(T, -90), latest: addDays(T, 14) };
    for (const [from, to] of [[addDays(T, -91), addDays(T, -80)], [addDays(T, 2), addDays(T, 15)]] as const) {
      const a = await days(from, to);
      expect([a.status, a.json]).toEqual([400, horizon]);
    }
  });

  it("the gate's query rule: an unknown key, a repeated key, a short date — 403 out_of_scope before the route", async () => {
    for (const q of [`from=${T}&to=${T}&x=1`, `from=${T}&from=${T}&to=${T}`, `from=2026-1-1&to=${T}`, `from=${T}`, ""]) {
      const a = await w.call("GET", `/api/native/days${q ? `?${q}` : ""}`, { bearer: token });
      expect([q, a.status, a.json]).toEqual([q, 403, { error: "out_of_scope" }]);
      // Refused at the gate: no read of the account's at all.
      expect(a.statements.filter((s) => !/native_devices/.test(s))).toEqual([]);
    }
    // The cookie has no query rule: the route checks the values itself.
    expect([(await w.call("GET", "/api/native/days?from=2026-1-1&to=2026-11-16")).status]).toEqual([400]);
    expect((await w.call("GET", `/api/native/days?from=${T}&to=${T}&x=1`)).status).toBe(200);
  });
});

// ── Every kind, every state ─────────────────────────────────────────────────────────────────────────────────────

describe("every kind of row on one day", () => {
  it("says each one's kind, plan, content, written and docRev — archived and removed rows left out, rest as the day's word", async () => {
    const k = await everyKind();
    const body = await ok(T, WED);
    const today = dayOf(body, T);
    expect([today.tense, today.rest, today.partial]).toEqual(["today", true, null]);
    const byId = Object.fromEntries(today.sessions.map((s: Record<string, any>) => [s.id, [s.kind, s.planName, s.content, s.written, s.docRev]]));
    expect(byId).toEqual({
      [k.studio]: ["studio", null, "document", true, 1],
      [k.template]: ["template", null, "document", true, 1],
      [k.dueOutline]: ["course", "Evening practice", "outline", false, null],
      [k.writtenCourse]: ["course", "Evening practice", "document", true, 1],
      [k.engine]: ["programme", "Mobility", "engine", true, null],
      [k.onDemand]: ["on_demand", null, "engine", true, null],
      [k.coachRun]: ["coach", null, "document", true, 3],
      [k.watchRun]: ["watch_plan", "Half marathon", "stages", true, null],
    });
    // Wednesday's outline ahead.
    expect(dayOf(body, WED).sessions.find((s: { id: string }) => s.id === k.laterOutline)).toMatchObject({ kind: "course", content: "outline", written: false });
    expect(dayOf(body, WED).tense).toBe("ahead");
  });

  it("a session's exact shape: the title as stored, the label only when it differs, its time, minutes and where it moved from", async () => {
    const k = await everyKind();
    const body = await ok(T, T);
    const label = humanizeWorkoutTitle("T1004", "quality", "threshold");
    expect(label).not.toBe("T1004");
    expect(sessionOf(body, k.watchRun)).toEqual({
      id: k.watchRun, title: "T1004", label, sport: "run", category: "quality", time: "18:30", minutes: 30,
      state: "scheduled", doneAt: null, doneBy: null, movedFrom: addDays(T, -1),
      kind: "watch_plan", planName: "Half marathon", content: "stages", written: true, docRev: null,
      underWay: false, can: { move: true, skip: true, unskip: false },
    });
    // No label where the title is already words; the keys in this order, and no other.
    const studio = sessionOf(body, k.studio);
    expect(Object.keys(studio)).toEqual(["id", "title", "sport", "category", "time", "minutes", "state", "doneAt", "doneBy", "movedFrom", "kind", "planName", "content", "written", "docRev", "underWay", "can"]);
    expect([studio.title, studio.movedFrom]).toEqual(["Studio hips", null]);
    // Timed first by time, then untimed, then by id: the coach's 06:00 first.
    expect(dayOf(body, T).sessions[0].id).toBe(k.coachRun);
  });

  it("a row of another account's plan id reads no plan: the plan's kind and name are joined by the account", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    await plan("their-plan", "coros_import", "Their marathon", other.userId);
    const id = await row({ planId: "their-plan" });
    expect(sessionOf(await ok(T, T), id)).toMatchObject({ kind: "other", planName: null });
  });
});

describe("every state, how it was done, and what the phone may ask", () => {
  it("doneBy: an app save, COROS, Mark done; and doneAt the standing match's start", async () => {
    const app = await row({ title: "Lifted", sport: "strength", category: "strength" });
    const appAct = await activity({ source: "app", sport: "strength", startTime: at(T, "07:10"), startTimeLocal: `${T}T07:10:00`, distanceMeters: null });
    await matched(app, appAct);
    const coros = await row({ title: "Ran" });
    const corosAct = await activity({ startTime: at(T, "06:40"), startTimeLocal: `${T}T06:40:00` });
    await matched(coros, corosAct);
    const said = await row({ title: "Lab hips", completionState: "completed", sanctionedBy: "athlete_said_done", sport: "yoga", category: "yoga" });
    // Completed some other way (a match undone since, no word of the athlete's): done, by nothing the phone names.
    const other = await row({ title: "Other", completionState: "completed" });
    await matched(other, await activity({ startTime: at(T, "05:00") }), { undone: true });
    const body = await ok(T, T);
    expect([app, coros, said, other].map((id) => [sessionOf(body, id).state, sessionOf(body, id).doneBy, sessionOf(body, id).doneAt])).toEqual([
      ["completed", "app", at(T, "07:10")],
      ["completed", "coros", at(T, "06:40")],
      ["completed", "said_done", null],
      ["completed", null, null],
    ]);
    // Done is done: neither moved nor skipped.
    expect(sessionOf(body, coros).can).toEqual({ move: false, skip: false, unskip: false });
  });

  it("skipped, missed, unresolved, a race, a later word passed as sent", async () => {
    const skipped = await row({ completionState: "skipped" });
    const missed = await row({ completionState: "missed", effectiveDate: addDays(T, -1) });
    const unresolved = await row({ completionState: "unresolved", effectiveDate: addDays(T, -1) });
    const race = await row({ category: "race", title: "City 10K" });
    const later = await row({ completionState: "deferred" });
    const body = await ok(addDays(T, -1), T);
    expect(Object.fromEntries([skipped, missed, unresolved, race, later].map((id) => [id, [sessionOf(body, id).state, sessionOf(body, id).can]]))).toEqual({
      [skipped]: ["skipped", { move: false, skip: false, unskip: true }],
      [missed]: ["missed", { move: false, skip: false, unskip: false }],
      [unresolved]: ["unresolved", { move: true, skip: true, unskip: false }],
      [race]: ["scheduled", { move: false, skip: true, unskip: false }],
      [later]: ["deferred", { move: false, skip: false, unskip: false }],
    });
    // A past day not settled yet reads as stored: scheduled, past.
    const unsettled = await row({ effectiveDate: addDays(T, -2) });
    const past = await ok(addDays(T, -2), addDays(T, -2));
    expect([past.days[0]!.tense, sessionOf(past, unsettled).state]).toEqual(["past", "scheduled"]);
  });

  it("under way: started today, and started yesterday within its save days — neither moved nor skipped", async () => {
    const started = async (date: string) => {
      const id = await row({ origin: "program", planId: "p-started", effectiveDate: date, contentState: "started", sport: "strength", category: "strength" });
      await w.db.insert(sessionBuilds).values({ id: newId(), userId: w.userId, workoutId: id, version: 1, engineVersion: "e", inputsHash: "h", payload: { build: { date } }, lockedAt: NOW, createdAt: NOW });
      return id;
    };
    const today = await started(T);
    const yesterday = await started(addDays(T, -1));
    const long = await started(addDays(T, -3));
    const body = await ok(addDays(T, -3), T);
    expect([today, yesterday, long].map((id) => [sessionOf(body, id).underWay, sessionOf(body, id).can.move, sessionOf(body, id).can.skip])).toEqual([
      [true, false, false],
      [true, false, false],
      // Past its save days nothing refuses: the save still lands, and reconcile asks.
      [false, true, true],
    ]);
  });
});

// ── Extras ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("extras: a run, lift or yoga session that completed no planned session", () => {
  it("lists each on its own day, in the order done, with its sport, title in words, local time, length, distance and source", async () => {
    const Y = addDays(T, -1);
    const run = await activity({ startTime: at(Y, "07:12"), startTimeLocal: `${Y}T07:12:00`, title: "Morning Run" });
    const app = await activity({ source: "app", corosActivityId: null, sport: "strength", title: null, startTime: at(Y, "18:41"), startTimeLocal: `${Y}T18:41:00`, durationSeconds: 2460, distanceMeters: 0 });
    const lift = await activity({ sport: "strength", title: "T1041", startTime: at(Y, "12:00"), startTimeLocal: `${Y}T12:00:00`, durationSeconds: 1800, distanceMeters: 0 });
    const yoga = await activity({ sport: "yoga", title: "Evening flow", startTime: at(Y, "20:00"), startTimeLocal: `${Y}T20:00:00`, durationSeconds: 1200, distanceMeters: null });
    // Matched to a plan: done work on that session, never an extra.
    const planned = await row({ effectiveDate: Y });
    const matchedRun = await activity({ startTime: at(Y, "06:00"), startTimeLocal: `${Y}T06:00:00` });
    await matched(planned, matchedRun);
    // Imported history: never an extra. A ride: not a run, lift or yoga.
    await activity({ source: "import", corosActivityId: null, startTime: at(Y, "09:00"), startTimeLocal: `${Y}T09:00:00` });
    await activity({ sport: "ride", startTime: at(Y, "10:00"), startTimeLocal: `${Y}T10:00:00` });
    const body = await ok(Y, Y);
    expect(dayOf(body, Y).extras).toEqual([
      { id: run, sport: "run", title: "Morning Run", time: "07:12", seconds: 3480, distanceMeters: 11400, source: "coros" },
      { id: lift, sport: "strength", title: "Strength", time: "12:00", seconds: 1800, distanceMeters: null, source: "coros" },
      { id: app, sport: "strength", title: "Strength", time: "18:41", seconds: 2460, distanceMeters: null, source: "app" },
      { id: yoga, sport: "yoga", title: "Evening flow", time: "20:00", seconds: 1200, distanceMeters: null, source: "coros" },
    ]);
    // The planned session it completed says so; no extra is ever a session's answer.
    expect(sessionOf(body, planned)).toMatchObject({ state: "completed", doneBy: "coros" });
    expect(JSON.stringify(dayOf(body, Y).extras)).not.toContain(matchedRun);
  });

  it("is dated by its local start (23:50 stays its day), or by its UTC start when it has none; never listed on a day ahead", async () => {
    const Y = addDays(T, -1);
    const late = await activity({ startTime: at(addDays(T, -2), "23:50"), startTimeLocal: `${addDays(T, -2)}T23:50:00` });
    // No local start: dated by the UTC day (run-garden's rule), its time unknown.
    const utc = await activity({ startTime: `${Y}T00:10:00.000Z`, startTimeLocal: null });
    // A session whose local start reads tomorrow (a clock wrong somewhere): a day ahead lists no extra.
    const ahead = await activity({ startTime: at(addDays(T, 1), "07:00"), startTimeLocal: `${addDays(T, 1)}T07:00:00` });
    const body = await ok(addDays(T, -2), addDays(T, 1));
    expect(dayOf(body, addDays(T, -2)).extras.map((e: { id: string }) => e.id)).toEqual([late]);
    expect(dayOf(body, Y).extras.map((e: { id: string; time: string | null }) => [e.id, e.time])).toEqual([[utc, null]]);
    expect(dayOf(body, addDays(T, 1)).extras).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ahead);
  });
});

// ── The account's clock ─────────────────────────────────────────────────────────────────────────────────────────

describe("tense on the account's clock, never UTC's or the phone's", () => {
  it("at 23:30 in Los Angeles (07:30 UTC the next day) today is still the account's day; at 00:30 the next", async () => {
    vi.setSystemTime(new Date(at(T, "23:30")));
    const late = await ok(addDays(T, -1), addDays(T, 1));
    expect([late.today, late.days.map((d) => d.tense)]).toEqual([T, ["past", "today", "ahead"]]);
    vi.setSystemTime(new Date(at(addDays(T, 1), "00:30")));
    const early = await ok(addDays(T, -1), addDays(T, 1));
    expect([early.today, early.days.map((d) => d.tense)]).toEqual([addDays(T, 1), ["past", "past", "today"]]);
    // And the horizon follows it: T + 15 is inside now.
    expect((await days(addDays(T, 2), addDays(T, 15))).status).toBe(200);
  });
});

// ── Two accounts ────────────────────────────────────────────────────────────────────────────────────────────────

describe("two accounts on the same days", () => {
  it("nothing of the other account's is ever listed — rows, matches or unmatched runs — and a match to its activity is never read", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirRow = await row({ title: "Their run" }, other.userId);
    const theirAct = await activity({ startTime: at(T, "07:00"), startTimeLocal: `${T}T07:00:00`, title: "Their Run" }, other.userId);
    const theirExtra = await activity({ startTime: at(T, "08:00"), startTimeLocal: `${T}T08:00:00`, title: "Their Extra" }, other.userId);
    await matched(theirRow, theirAct);
    await w.db.insert(providerConnections).values({ id: newId(), userId: other.userId, provider: "coros", status: "connected", lastSyncAt: "2026-11-16T10:00:00.000Z", createdAt: NOW, updatedAt: NOW });
    // The owner's own row, crafted to name the other account's activity in a standing match: never read as done by it.
    const mine = await row({ title: "My run" });
    await w.db.insert(workoutCompletionMatches).values({ id: newId(), workoutId: mine, activityId: theirExtra, confidence: 1, method: "manual", matchedAt: NOW });
    const a = await days(addDays(T, -1), addDays(T, 1));
    expect(a.status).toBe(200);
    for (const id of [theirRow, theirAct, theirExtra, other.userId, "Their"]) expect(a.text.includes(id), id).toBe(false);
    expect(sessionOf(a.json as never, mine)).toMatchObject({ doneAt: null, doneBy: null });
    expect(a.json.corosReadAt).toBeNull();
  });
});

// ── Writes nothing ──────────────────────────────────────────────────────────────────────────────────────────────

describe("a read: it writes nothing", () => {
  it("every table as it was, no write statement, no waitUntil, no expiry moved, no external call", async () => {
    await everyKind();
    await activity({ startTime: at(T, "07:12"), startTimeLocal: `${T}T07:12:00` });
    const before = snapshot();
    const waitUntil = vi.fn();
    const res = await w.app.request(`/api/native/days?from=${addDays(T, -3)}&to=${addDays(T, 10)}`, { headers: { Authorization: `Bearer ${token}` } }, w.env, {
      waitUntil,
      passThroughOnException: () => undefined,
      props: {},
    } as never);
    expect(res.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    const a = await days(addDays(T, -3), addDays(T, 10));
    expect(a.writes).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("the gate's own last use is the one write, at most hourly; the expiry never moves", async () => {
    const stale = await seedDevice(w.db, w.userId, { scope: V4, lastUsedAt: at(T, "09:00"), expiresAt: "2026-12-10T08:00:00.000Z" });
    const a = await days(T, T, { bearer: stale.token });
    expect(a.writes.map((s) => /^update "?(\w+)"?/i.exec(s)?.[1])).toEqual(["native_devices"]);
    const [d] = await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, stale.id));
    expect([d!.lastUsedAt, d!.expiresAt]).toEqual([NOW, "2026-12-10T08:00:00.000Z"]);
    expect((await days(T, T, { bearer: stale.token })).writes).toEqual([]);
  });
});

// ── Parity with the plan read ───────────────────────────────────────────────────────────────────────────────────

describe("parity: /days' trimmed fields are the plan read's, byte for byte", () => {
  it("for 14 days of every kind and state", async () => {
    await everyKind();
    const done = await row({ title: "Ran", effectiveDate: addDays(T, -2) });
    await matched(done, await activity({ startTime: at(addDays(T, -2), "06:40"), startTimeLocal: `${addDays(T, -2)}T06:40:00` }));
    await row({ completionState: "skipped", effectiveDate: addDays(T, 3) });
    const from = addDays(T, -3);
    const to = addDays(T, 10);
    const plan = await w.call("GET", `/api/lifeos/plan?from=${from}&to=${to}`, { bearer: PLAN_TOKEN, cookie: false });
    expect(plan.status, plan.text).toBe(200);
    const body = await ok(from, to);
    const trimmed = {
      version: 1,
      days: body.days.map((d) => ({
        date: d.date,
        rest: d.rest,
        sessions: d.sessions.map((s: Record<string, unknown>) => ({ id: s.id, title: s.title, sport: s.sport, category: s.category, time: s.time, minutes: s.minutes, state: s.state, doneAt: s.doneAt })),
      })),
    };
    expect(JSON.stringify(trimmed)).toBe(plan.text);
  });
});

// ── The gate, the restore, the switch ───────────────────────────────────────────────────────────────────────────

describe("the gate", () => {
  it("v1, v2 and v3 are 403; v4 and the cookie are 200, the same answer, no-store", async () => {
    for (const scope of ["training-slice-v1", "training-v2", "training-v3"]) {
      const d = await seedDevice(w.db, w.userId, { scope, lastUsedAt: NOW });
      const a = await days(T, T, { bearer: d.token });
      expect([scope, a.status, a.json]).toEqual([scope, 403, { error: "out_of_scope" }]);
    }
    const device = await days(T, T);
    const cookie = await days(T, T, { cookie: true });
    expect([device.status, cookie.status, device.headers["cache-control"]]).toEqual([200, 200, "no-store"]);
    expect({ ...cookie.json, readAt: null }).toEqual({ ...device.json, readAt: null });
  });

  it("503 restore_in_progress, retryable, while a restore replaces the account: before any read of its rows", async () => {
    await everyKind();
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: NOW, updatedAt: NOW });
    for (const opts of [{}, { cookie: true }]) {
      const a = await days(T, T, opts);
      expect([a.status, a.json, a.headers["cache-control"]]).toEqual([503, { error: "restore_in_progress", retryable: true }, "no-store"]);
      expect(a.statements.some((s) => /planned_workouts|activities/.test(s))).toBe(false);
    }
  });

  it("device sign-in off: 401 device_access_off", async () => {
    const a = await w.call("GET", `/api/native/days?from=${T}&to=${T}`, { bearer: token, env: { NATIVE_DEVICES: "0" } });
    expect([a.status, a.json]).toEqual([401, { error: "device_access_off" }]);
  });

  it("corosReadAt: the COROS connection's last read, else null; readAt this answer's time", async () => {
    expect((await ok(T, T)).corosReadAt).toBeNull();
    await w.db.insert(providerConnections).values({ id: newId(), userId: w.userId, provider: "coros", status: "connected", encryptedAccessToken: "secret-a", encryptedRefreshToken: "secret-r", lastSyncAt: "2026-11-16T18:30:04.000Z", createdAt: NOW, updatedAt: NOW });
    const a = await days(T, T);
    expect([a.json.corosReadAt, a.json.readAt]).toEqual(["2026-11-16T18:30:04.000Z", NOW]);
    expect(a.text).not.toContain("secret");
    expect(a.statements.find((s) => /provider_connections/.test(s))).not.toMatch(/encrypted/);
  });
});

// ── The budget ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("what it costs", () => {
  const count = (a: Answer) => a.statements.length;

  it("7 statements: the gate, the restore check, the preferences, the rows, the matches, the extras, corosReadAt", async () => {
    await everyKind();
    const a = await days(addDays(T, -3), addDays(T, 10));
    expect(a.status).toBe(200);
    expect(count(a)).toBe(7);
  });

  it("plus 1 for each further chunk of 90 training rows", async () => {
    for (let i = 0; i < 200; i += 1) await row({ effectiveDate: T, effectiveTime: "05:00" });
    const a = await days(T, addDays(T, 13));
    expect(a.status).toBe(200);
    // 200 rows: three chunks of matches.
    expect(count(a)).toBe(9);
    // Capped at 30 a day and said so.
    expect(a.json.days[0].partial).toBe("capped");
    expect(a.json.days[0].sessions).toHaveLength(30);
  });
});
