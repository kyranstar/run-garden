/**
 * A PROGRAMME'S SETTINGS SAVED WITHIN A REQUEST'S BUDGET (2026-10-19; the coach's programme edits found it). The settings
 * sheet's save (`PATCH /api/programs/:id`) wrote the config and re-placed the programme's slots in ONE request: a change
 * of days retracts every flexible slot the new pattern drops (about 8 statements each — the row, its archive, its queued
 * writes, its calendar suppression, its intents, its watch copy) and places the new ones, so a days change at four weeks
 * ahead measured 123 statements against the free plan's 50 an invocation, and failed part way.
 *
 * Now the route writes the config, places what fits (`placeSlots` with a budget: retractions first, then the new slots
 * with their day's collision pass, then the rest of the refresh), and answers `placing: true` until nothing is left; the
 * sheet asks again. Every request ≤ 45 statements and fetches, its waitUntil work included. A client that never asks
 * again (a cached old one) still ends right: the hourly pass places what is left, with the same rule. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The calendar, when a test connects it: a fake whose every call counts as a fetch (each is one to Google).
const google = vi.hoisted(() => ({ fake: null as unknown, calls: [] as string[] }));
vi.mock("../src/services/google-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-calendar.js")>()),
  googleCalendarClient: vi.fn(async () => google.fake),
}));

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, newId, type AdaptiveConfig } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { programRoutes } from "../src/routes/programs.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { placeSlots, placeSlotsForAllPrograms, placeSlotsWithin } from "../src/services/program-slots.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { programs, plannedWorkouts } = schema;
/** A Wednesday morning in UTC: this week's Monday and Tuesday have gone. */
const NOW = new Date("2026-10-14T08:00:00.000Z");
const TODAY = "2026-10-14";
const REQUEST_BUDGET = 45;

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  google.fake = null;
  google.calls = [];
});

/** A Google calendar that takes every insert (and counts each call as a fetch). */
function connectCalendar() {
  let seq = 0;
  const call = (what: string) => {
    google.calls.push(what);
    fetches += 1;
  };
  google.fake = {
    listCalendars: async () => [],
    createCalendar: async () => ({ id: "cal" }),
    freeBusy: async () => [],
    listEvents: async () => {
      call("list");
      return { items: [], nextSyncToken: "tok" };
    },
    insertEvent: async () => {
      call("insert");
      return { id: `ev-${++seq}` };
    },
    patchEvent: async () => call("patch"),
    deleteEvent: async () => call("delete"),
  };
}

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0" } as Env;

/** A programme placed from this Monday — Monday's and Tuesday's sessions done — at `ahead` weeks. */
async function programme(o: { goal: number; days: number[]; ahead: number }, owner = userId, d = db): Promise<string> {
  const id = newId();
  await d.insert(programs).values({
    id, userId: owner, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null,
    raceDate: null, source: null, config: adaptiveConfigSchema.parse({ weeklyGoal: o.goal, preferredDays: o.days, placementWeeksAhead: o.ahead }),
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), archivedAt: null,
  });
  await placeSlots(d, owner, id, "2026-10-12", await loadPreferences(d, owner), "2026-10-12T05:00:00.000Z");
  for (const r of await d.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, id))) {
    if (r.effectiveDate < TODAY) await d.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, r.id));
  }
  return id;
}

async function patch(id: string, body: unknown) {
  const app = mountRoutes(db, "/api/programs", programRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(`/api/programs/${id}`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env, executionCtx as never);
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, any>, total: statements + fetches };
}

/** Save, then ask again with nothing to change (as the settings sheet does) until the route says nothing is left. */
async function saveUntilPlaced(id: string, body: unknown) {
  const costs: number[] = [];
  let last: Record<string, any> = {};
  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) throw new Error("the save never finished placing");
    const res = await patch(id, i === 0 ? body : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    costs.push(res.total);
    last = res.json;
    if (!res.json.placing) break;
  }
  return { costs, last };
}

/** The live slots, as dates (what the athlete sees on the calendar). */
async function liveDates(id: string, d = db): Promise<string[]> {
  const rows = await d.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, id), isNull(plannedWorkouts.archivedAt)));
  return rows.map((r) => `${r.effectiveDate}:${r.completionState}`).sort();
}

/** The same programme and change on a second account, placed in one unbounded pass: the end state to reach. */
async function unbounded(
  o: { goal: number; days: number[]; ahead: number },
  change: Partial<AdaptiveConfig>,
  status: "active" | "retired" = "active",
): Promise<string[]> {
  const other = makeTestDb({ boundVariableCap: 100 });
  const made = await makeTestUser(other, { timezone: "UTC" });
  await savePreferences(other, made.userId, { ...made.prefs, timezone: "UTC" });
  const id = await programme(o, made.userId, other);
  const [p] = await other.select().from(programs).where(eq(programs.id, id));
  await other.update(programs).set({ status, config: adaptiveConfigSchema.parse({ ...p!.config, ...change }) }).where(eq(programs.id, id));
  await placeSlots(other, made.userId, id, TODAY, await loadPreferences(other, made.userId), NOW.toISOString());
  return liveDates(id, other);
}

describe("PATCH /api/programs/:id within the budget", () => {
  for (const [label, o, change] of [
    ["days, four weeks ahead (measured 123 in one request)", { goal: 3, days: [0, 2, 4], ahead: 4 }, { preferredDays: [1, 3, 5] }],
    ["days and goal, four weeks ahead (measured 129)", { goal: 4, days: [0, 1, 3, 5], ahead: 4 }, { preferredDays: [2, 4, 5, 6], weeklyGoal: 3 }],
    ["days, two weeks ahead", { goal: 2, days: [1, 3], ahead: 2 }, { preferredDays: [0, 4] }],
    ["goal down, four weeks ahead", { goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 }, { weeklyGoal: 5 }],
    ["minutes, six a week at four weeks ahead", { goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 }, { defaultMinutes: 45 }],
  ] as Array<[string, { goal: number; days: number[]; ahead: number }, Partial<AdaptiveConfig>]>) {
    it(`${label}: every request within 45, \`placing\` until done — the same end as one unbounded pass`, async () => {
      const id = await programme(o);
      const { costs, last } = await saveUntilPlaced(id, { config: change });
      for (const cost of costs) expect(cost, `costs ${costs.join(", ")}`).toBeLessThanOrEqual(REQUEST_BUDGET);
      expect(last.program.config).toMatchObject(change);
      expect(await liveDates(id)).toEqual(await unbounded(o, change));
      // Done ones stay as they were.
      expect((await liveDates(id)).filter((d) => d.endsWith(":completed"))).toHaveLength(o.days.filter((d) => d < 2).length);
    });
  }

  it("a client that never asks again (a cached old one): the first request writes the config, the hourly pass places the rest", async () => {
    const o = { goal: 3, days: [0, 2, 4], ahead: 4 };
    const change = { preferredDays: [1, 3, 5] };
    const id = await programme(o);
    const first = await patch(id, { config: change });
    expect(first.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(first.json.placing).toBe(true);
    // The save itself landed whole on the first request.
    expect(first.json.program.config).toMatchObject(change);
    expect(await liveDates(id)).not.toEqual(await unbounded(o, change));
    await placeSlotsForAllPrograms(db, NOW);
    expect(await liveDates(id)).toEqual(await unbounded(o, change));
  });

  it("the calendar books in the last request's room — never while placing, never past the budget", async () => {
    connectCalendar();
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
    const o = { goal: 3, days: [0, 2, 4], ahead: 4 };
    const id = await programme(o);
    const inserts: number[] = [];
    const costs: number[] = [];
    for (let i = 0; ; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the save never finished placing");
      google.calls = [];
      const res = await patch(id, i === 0 ? { config: { preferredDays: [1, 3, 5] } } : {});
      costs.push(res.total);
      inserts.push(google.calls.filter((c) => c === "insert").length);
      if (!res.json.placing) break;
    }
    for (const cost of costs) expect(cost, `costs ${costs.join(", ")}`).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Nothing booked while some is left; the last request books what its room holds, at most a request's ops.
    expect(inserts.slice(0, -1).every((n) => n === 0), inserts.join(", ")).toBe(true);
    expect(inserts.at(-1)).toBeGreaterThan(0);
    expect(inserts.at(-1)).toBeLessThanOrEqual(CALENDAR_OPS_PER_REQUEST);
  });

  it("Retire, six a week at four weeks ahead: every request within 45 while its sessions come back off, the same end as one pass", async () => {
    const o = { goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 };
    const id = await programme(o);
    const { costs, last } = await saveUntilPlaced(id, { status: "retired" });
    expect(costs.length).toBeGreaterThan(1);
    for (const cost of costs) expect(cost, `costs ${costs.join(", ")}`).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(last.program.status).toBe("retired");
    const end = await liveDates(id);
    expect(end).toEqual(await unbounded(o, {}, "retired"));
    // Only the done ones and today's are left.
    expect(end).toEqual(["2026-10-12:completed", "2026-10-13:completed", "2026-10-14:scheduled"]);
  });

  it("a new programme, seven a week at four weeks ahead: within 45, and placed by the asks that follow", async () => {
    const app = mountRoutes(db, "/api/programs", programRoutes);
    const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
    statements = 0;
    fetches = 0;
    const config = { weeklyGoal: 7, preferredDays: [0, 1, 2, 3, 4, 5, 6], placementWeeksAhead: 4 };
    const res = await app.request(
      "/api/programs",
      { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Mobility", config }) },
      env,
      executionCtx as never,
    );
    expect(res.status).toBe(201);
    expect(statements + fetches).toBeLessThanOrEqual(REQUEST_BUDGET);
    const created = (await res.json()) as { program: { id: string }; placing?: boolean };
    const { costs } = created.placing ? await saveUntilPlaced(created.program.id, {}) : { costs: [] };
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Every day of the window from tomorrow (today's session window has gone by 08:00): Thursday to Sunday, and 28 more.
    const end = await liveDates(created.program.id);
    expect(end).toHaveLength(4 + 28);
    expect(end[0]).toBe("2026-10-15:scheduled");
  });
});

interface Scenario {
  o: { goal: number; days: number[]; ahead: number };
  /** Saved and placed (in one pass) before the change: the change then brings retracted slots back. */
  before?: Partial<AdaptiveConfig>;
  change: Partial<AdaptiveConfig>;
  status?: "active" | "retired";
  /** Weekdays already holding a run at the morning hour, from today to the window's end: the collision pass re-times. */
  runsOn?: number[];
}

/** A scenario set up on `d`, its change saved but not yet placed: the programme's id. */
async function arrange(s: Scenario, owner: string, d: Db): Promise<string> {
  const id = await programme(s.o, owner, d);
  const prefs = await loadPreferences(d, owner);
  const save = async (change: Partial<AdaptiveConfig>, status: "active" | "retired", name: string) => {
    const [p] = await d.select().from(programs).where(eq(programs.id, id));
    await d.update(programs).set({ status, name, config: adaptiveConfigSchema.parse({ ...p!.config, ...change }) }).where(eq(programs.id, id));
  };
  if (s.before) {
    await save(s.before, "active", "Mobility");
    await placeSlots(d, owner, id, TODAY, prefs, NOW.toISOString());
  }
  for (const wd of s.runsOn ?? []) {
    for (let week = 0; week <= s.o.ahead; week++) {
      const date = addDays("2026-10-12", 7 * week + wd);
      if (date < TODAY) continue;
      await d.insert(plannedWorkouts).values({
        id: newId(), userId: owner, planId: "coros-plan", sourceWorkoutId: `src-${date}`, title: "Easy run", category: "easy", sport: "run",
        originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: wd >= 5 ? prefs.weekendMorningTime : prefs.weekdayMorningTime,
        sourceContentFingerprint: "fp", fallbackEstimatedDurationSeconds: 3600, calendarBlockDurationSeconds: 3600, completionState: "scheduled",
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      });
    }
  }
  await save(s.change, s.status ?? "active", "Evening mobility");
  return id;
}

/** Every live session from today, its day, time and state — the programme's and the runs beside them. */
async function liveSchedule(owner: string, d: Db): Promise<string[]> {
  const rows = await d.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, owner), isNull(plannedWorkouts.archivedAt)));
  return rows.map((r) => `${r.effectiveDate} ${r.effectiveTime} ${r.title} ${r.completionState}`).sort();
}

describe("placeSlotsWithin: what a pass declares bounds what it runs", () => {
  const scenarios: Array<[string, Scenario]> = [
    ["days", { o: { goal: 3, days: [0, 2, 4], ahead: 4 }, change: { preferredDays: [1, 3, 5] } }],
    ["days and goal", { o: { goal: 4, days: [0, 1, 3, 5], ahead: 4 }, change: { preferredDays: [2, 4, 5, 6], weeklyGoal: 3 } }],
    ["goal up", { o: { goal: 2, days: [1, 3], ahead: 4 }, change: { weeklyGoal: 5 } }],
    ["minutes and name", { o: { goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 }, change: { defaultMinutes: 45 } }],
    ["retired", { o: { goal: 5, days: [0, 1, 2, 3, 4], ahead: 4 }, change: {}, status: "retired" }],
    // The days back where they were: the retracted slots come back (revived), not new rows.
    ["days and back again", { o: { goal: 3, days: [0, 2, 4], ahead: 4 }, before: { preferredDays: [1, 3, 5] }, change: { preferredDays: [0, 2, 4] } }],
    // The new days hold a run at the slot's hour: the collision pass re-times what it places, and declares it.
    ["days onto runs", { o: { goal: 3, days: [0, 2, 4], ahead: 4 }, change: { preferredDays: [1, 3, 5], defaultMinutes: 60 }, runsOn: [1, 3, 5] }],
    // A longer session on days that hold a run: nothing new on the day, yet the pass re-times what is there.
    ["minutes beside runs", { o: { goal: 3, days: [1, 3, 5], ahead: 4 }, change: { defaultMinutes: 90 }, runsOn: [1, 3, 5] }],
  ];
  // A request's room; one that leaves room after its retraction for a step of the fill (which must wait for the rest of
  // the retractions); the least that holds the fixed reads and one retraction (3 + 1 + 1 + RETRACT_COST); and none.
  for (const budget of [36, 22, 15, 1]) {
    for (const [label, s] of scenarios) {
      it(`${label}, a budget of ${budget}: each pass runs at most what it declares, within the budget past its first step, and ends where one pass would`, async () => {
        const id = await arrange(s, userId, db);
        const prefs = await loadPreferences(db, userId);
        const passes: Array<{ ran: number; spent: number }> = [];
        for (let i = 0; ; i++) {
          if (i >= MAX_LOOP_ITERATIONS) throw new Error("placement never finished");
          statements = 0;
          const res = await placeSlotsWithin(db, userId, id, TODAY, prefs, NOW.toISOString(), budget);
          passes.push({ ran: statements, spent: res.spent });
          if (!res.more) break;
        }
        for (const pass of passes) expect(pass.ran, JSON.stringify(passes)).toBeLessThanOrEqual(pass.spent);
        // Past the forced first step (a budget too small for any), a pass stays inside its budget.
        if (budget >= 15) for (const pass of passes) expect(pass.spent, JSON.stringify(passes)).toBeLessThanOrEqual(budget);
        // A second look finds nothing to do; the end — days, times, titles — is one unbounded pass's.
        expect(await placeSlotsWithin(db, userId, id, TODAY, prefs, NOW.toISOString(), budget)).toMatchObject({ placed: [], archived: [], more: false });
        const other = makeTestDb({ boundVariableCap: 100 });
        const made = await makeTestUser(other, { timezone: "UTC" });
        await savePreferences(other, made.userId, { ...made.prefs, timezone: "UTC" });
        const otherId = await arrange(s, made.userId, other);
        await placeSlots(other, made.userId, otherId, TODAY, await loadPreferences(other, made.userId), NOW.toISOString());
        const end = await liveSchedule(userId, db);
        expect(end).toEqual(await liveSchedule(made.userId, other));
        if (s.runsOn) {
          // The pass did re-time: no slot sits at its run's hour.
          const at = new Map<string, Set<string>>();
          for (const line of end.filter((l) => !l.includes(" completed"))) {
            const [date, time] = line.split(" ");
            at.set(date!, new Set([...(at.get(date!) ?? []), time!]));
          }
          const shared = end.filter((l) => l.includes("Easy run")).map((l) => l.split(" ")[0]!);
          expect(shared.some((date) => end.some((l) => l.startsWith(date) && l.includes("Evening mobility")))).toBe(true);
          for (const date of shared) expect(at.get(date)!.size, date).toBe(end.filter((l) => l.startsWith(date)).length);
        }
      });
    }
  }
});
