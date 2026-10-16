/**
 * THE WORKOUT ROW SAYS WHEN THE APP MADE IT (`appMade`; the owner, 2026-10-16: "yoga is for yoga programs, this is
 * mobility generally"). Plan and Today label the yoga kind of a workout the app made "Mobility" and an import "Yoga"
 * (`workoutKindLabel` in packages/ui). The row's origin already says it for the app's own sessions (a programme's slot,
 * an on-demand session, a Studio or template workout — a coach-designed one is a Studio row); the thread coach's
 * sessions have no origin, and are known by the `cw-` id every one of its creates carries (`coach-apply.ts`). An
 * import, and an imported session the coach eased, keep their own ids: no `appMade`.
 *
 * Worked out from the row the routes already read: not one statement more on any of them (counts pinned from the
 * code before the field). Synthetic fixtures only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, startOfIsoWeek } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts } = schema;

let db: Db;
let userId: string;
let today: string;
let statements: string[];

/** Every kind of row, keyed by what it is; `true` = the app made it. */
const KINDS: Record<string, boolean> = {
  "slot-p1": true, // a programme's outline
  "od-1": true, // an on-demand session
  "doc-studio": true, // a Studio workout (a coach-designed one is one too)
  "doc-template": true, // a template's workout
  "cw-prop1-0-0": true, // the thread coach's session, never on the watch
  "cw-prop1-1-0": true, // the thread coach's session, on the watch (its address now COROS's)
  "imp-yoga": false, // an imported yoga session
  "imp-eased": false, // an imported session the coach eased
};

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  let prefs;
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  const now = nowInstant();
  const row = (id: string, over: Partial<typeof plannedWorkouts.$inferInsert>) => ({
    id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Evening session", category: "yoga", sport: "yoga",
    originalPlanDate: today, lastVerifiedCorosDate: "", effectiveDate: today, effectiveTime: "18:00", completionState: "scheduled",
    sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, createdAt: now, updatedAt: now,
    ...over,
  });
  const day = (n: number) => addDays(today, n);
  // One row a statement: a row binds some twenty values, and D1 takes 100.
  for (const r of [
    row("slot-p1", { planId: "p1", origin: "program", contentState: "outline", effectiveDate: day(1), originalPlanDate: day(1) }),
    row("od-1", { planId: "p1", origin: "on_demand", contentState: "built", effectiveDate: day(1), originalPlanDate: day(1) }),
    row("doc-studio", { planId: "studio-p", origin: "studio", contentState: "outline", effectiveDate: day(2), originalPlanDate: day(2) }),
    row("doc-template", { planId: "studio-p", origin: "template", contentState: "outline", effectiveDate: day(2), originalPlanDate: day(2) }),
    row("cw-prop1-0-0", { planId: "adhoc-yoga-user0001", sourceContentFingerprint: "coach-1a2b", effectiveDate: day(3), originalPlanDate: day(3) }),
    row("cw-prop1-1-0", { planId: "adhoc-yoga-user0001", sourceWorkoutId: "8000001:21", sourceIdInPlan: "21", lastVerifiedCorosDate: day(3), corosSyncState: "synced", effectiveDate: day(3), originalPlanDate: day(3) }),
    row("imp-yoga", { sourceWorkoutId: "plan-1:7", sourceIdInPlan: "7", lastVerifiedCorosDate: day(4), corosSyncState: "synced", effectiveDate: day(4), originalPlanDate: day(4) }),
    row("imp-eased", { sourceWorkoutId: "plan-1:8", sourceIdInPlan: "8", lastVerifiedCorosDate: day(4), corosSyncState: "synced", effectiveDate: day(4), originalPlanDate: day(4), structuredJson: { exercises: [] } }),
  ]) await db.insert(plannedWorkouts).values(r);
});

/** The request, its body and how many statements it made. */
async function get<T>(path: string): Promise<{ body: T; count: number }> {
  const app = mountRoutes(db, "/api/plan", planRoutes);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  statements.length = 0;
  const res = await app.request(path, { headers: { Cookie: cookie } }, { FIXTURE_MODE: "1" } as never);
  expect(res.status, path).toBe(200);
  const count = statements.length;
  console.info(`[budget] GET ${path.split("?")[0]}: ${count} statements`);
  return { body: (await res.json()) as T, count };
}

type Dto = { id: string; appMade?: boolean };
const made = (ws: readonly Dto[]) => Object.fromEntries(ws.map((w) => [w.id, w.appMade === true]));
const shape = (ws: readonly Dto[]) => ws.every((w) => w.appMade === undefined || w.appMade === true);

describe("appMade on the workout row", () => {
  it("the Plan's workouts: every row the app made says so, the imports say nothing — 8 statements, as before", async () => {
    const { body, count } = await get<{ workouts: Dto[] }>(`/api/plan/workouts?start=${today}&end=${addDays(today, 6)}`);
    expect(made(body.workouts)).toEqual(KINDS);
    expect(shape(body.workouts)).toBe(true);
    expect(count).toBe(STATEMENTS.workouts);
  });

  it("Today: the next workout and the days ahead carry it — as many statements as before", async () => {
    const { body, count } = await get<{ upcoming: Dto[]; nextWorkout: Dto | null }>("/api/plan/today");
    expect(made(body.upcoming)).toEqual(KINDS);
    expect(body.nextWorkout?.appMade).toBe(true);
    expect(count).toBe(STATEMENTS.today);
  });

  it("the week: its rows carry it — as many statements as before", async () => {
    // The week that holds tomorrow's rows, not today's: on a Sunday every seeded row (today +1 to +4) is next week.
    const { body, count } = await get<{ workouts?: Dto[]; days?: Array<{ workouts: Dto[] }> }>(`/api/plan/week?start=${startOfIsoWeek(addDays(today, 1))}`);
    const rows = body.workouts ?? body.days?.flatMap((d) => d.workouts) ?? [];
    const inWeek = Object.keys(KINDS).filter((id) => rows.some((w) => w.id === id));
    expect(inWeek.length).toBeGreaterThan(0);
    for (const id of inWeek) expect(rows.find((w) => w.id === id)!.appMade === true, id).toBe(KINDS[id]);
    expect(count).toBe(STATEMENTS.week);
  });

  it("one workout's sheet: the thread coach's row says so, an import says nothing — as many statements as before", async () => {
    const coach = await get<{ workout: Dto }>("/api/plan/workouts/cw-prop1-1-0");
    const imported = await get<{ workout: Dto }>("/api/plan/workouts/imp-yoga");
    expect([coach.count, imported.count]).toEqual([STATEMENTS.detail, STATEMENTS.detail]);
    expect(coach.body.workout.appMade).toBe(true);
    expect("appMade" in imported.body.workout).toBe(false);
  });
});

/** Each route's statements for this account, measured on the code before `appMade` existed. */
const STATEMENTS = { workouts: 8, today: 19, week: 11, detail: 11 };
