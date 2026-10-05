/**
 * `GET /api/plan/today` reads only what it shows of a slot's builds (audit 2a M6): the three view fields, the version,
 * the lock and the build's date — never the whole stored payload (100+ KB each) — and only the account's own builds.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0" } as unknown as Env;

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

const today = () => todayInZone(prefs.timezone);

async function slot(id: string, state = "built"): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "prog-1", sourceWorkoutId: id, title: "Garden program", category: "yoga", sport: "yoga",
    originalPlanDate: today(), lastVerifiedCorosDate: "", effectiveDate: today(), effectiveTime: "18:00",
    sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, corosSyncState: "calendar_only",
    origin: "program", contentState: state, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

async function build(o: { id: string; owner?: string; workoutId: string; version: number; date: string; mode: string; minutes: number; theme: string | null; locked?: boolean }) {
  await db.insert(schema.sessionBuilds).values({
    id: o.id, userId: o.owner ?? userId, workoutId: o.workoutId, version: o.version, engineVersion: "e", inputsHash: `h${o.version}`,
    payload: {
      build: { date: o.date, mode: o.mode, minutes: o.minutes, steps: [{ kind: "timed", seconds: 60 }] },
      view: { mode: o.mode, minutes: o.minutes, theme: o.theme ? { id: o.theme.toLowerCase(), name: o.theme } : null },
    },
    lockedAt: o.locked ? nowInstant() : null,
    createdAt: nowInstant(),
  });
}

type Today = { todaySessions: Array<{ workout: { id: string }; build: { mode: string; theme: string | null; minutes: number } | null }> };
const getToday = async () =>
  (await (await mountRoutes(db, "/api/plan", planRoutes).request("/api/plan/today", { headers: { Cookie: cookie } }, env)).json()) as Today;

describe("GET /today — the builds it reads (audit M6)", () => {
  it("summarises the current build from three fields of its payload, never reading the whole payload", async () => {
    await slot("s-1");
    await build({ id: "b1", workoutId: "s-1", version: 1, date: today(), mode: "build", minutes: 20, theme: null });
    await build({ id: "b2", workoutId: "s-1", version: 2, date: today(), mode: "consistent", minutes: 35, theme: "Hinge" });
    statements.length = 0;
    const body = await getToday();
    expect(body.todaySessions.map((s) => [s.workout.id, s.build])).toEqual([["s-1", { mode: "consistent", theme: "Hinge", minutes: 35 }]]);
    const reads = statements.filter((s) => s.includes('"session_builds"'));
    expect(reads).toHaveLength(1);
    // The payload column appears only inside json_extract(...), never as a selected column.
    const count = (needle: string) => reads[0]!.split(needle).length - 1;
    expect(count('"session_builds"."payload"')).toBeGreaterThan(0);
    expect(count('json_extract("session_builds"."payload"')).toBe(count('"session_builds"."payload"'));
  });

  it("the locked build wins; a build for another day (a preview) is not today's", async () => {
    await slot("s-locked", "started");
    await build({ id: "l1", workoutId: "s-locked", version: 1, date: today(), mode: "recovery", minutes: 25, theme: "Rest", locked: true });
    await build({ id: "l2", workoutId: "s-locked", version: 2, date: today(), mode: "build", minutes: 40, theme: null });
    await slot("s-outline", "outline");
    await build({ id: "p0", workoutId: "s-outline", version: 0, date: "2000-01-01", mode: "build", minutes: 40, theme: null });
    const body = await getToday();
    const byId = Object.fromEntries(body.todaySessions.map((s) => [s.workout.id, s.build]));
    expect(byId["s-locked"]).toEqual({ mode: "recovery", theme: "Rest", minutes: 25 });
    expect(byId["s-outline"]).toBeNull();
  });

  it("only the account's own builds: a build row naming the slot under another account is never read", async () => {
    await slot("s-mine");
    await build({ id: "mine", workoutId: "s-mine", version: 1, date: today(), mode: "consistent", minutes: 30, theme: "Hinge" });
    const { userId: other } = await makeTestUser(db);
    await build({ id: "theirs", owner: other, workoutId: "s-mine", version: 2, date: today(), mode: "build", minutes: 90, theme: null });
    const body = await getToday();
    expect(body.todaySessions.map((s) => s.build)).toEqual([{ mode: "consistent", theme: "Hinge", minutes: 30 }]);
  });
});
