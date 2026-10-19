/**
 * A COACH PLAN'S RACE DAY CAN CHANGE (stream G, 2026-10-19). A race is cancelled or moved, and the plan still named it:
 * the coach's "needs you" chip asked to get ready for race day, and nothing in the app could change a coach plan's race.
 *
 * `POST /api/coach/plans/:id/race { raceDate: "YYYY-MM-DD" | null }` — the athlete's own coach block only (another
 * athlete's, a loose `adhoc-` bucket, none: 404); a real day, on or after the plan's first (400 in words otherwise);
 * `null` is no race. It writes `coach_plans.race_date` and nothing of Settings; the plan's own still-scheduled race rows
 * on the old day stop claiming to be the race (category → quality — their title, dates and watch/calendar copies as
 * they were). The same answer twice writes nothing. Everything that reads a plan's race reads it again: the chips, the
 * plan's detail, read_plans.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, dayLabel, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { readNudges } from "../src/services/coach-nudges.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { isToolErr } from "../src/services/design-tools/types.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: "k",
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

const app = () => mountRoutes(db, "/api/coach", coachRoutes);
const setRace = (planId: string, body: unknown) =>
  app().request(
    `/api/coach/plans/${planId}/race`,
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
const getJson = async <T>(path: string): Promise<T> => (await (await app().request(path, { headers: { Cookie: cookie } }, env)).json()) as T;

async function seedPlan(o: { id: string; owner?: string; start?: string; end?: string; raceDate?: string | null; status?: string }): Promise<void> {
  await db.insert(schema.coachPlans).values({
    id: o.id,
    userId: o.owner ?? userId,
    discipline: "run",
    name: "Autumn 10K",
    status: o.status ?? "active",
    startDate: o.start ?? addDays(today, -14),
    endDate: o.end ?? addDays(today, 28),
    raceDate: o.raceDate ?? null,
    stampPrefix: "Autumn 10K",
    createdAt: nowInstant(),
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function seedSession(o: { id: string; planId: string; date: string; category?: string; state?: string; archived?: boolean; owner?: string }): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id: o.id,
    userId: o.owner ?? userId,
    planId: o.planId,
    sourceWorkoutId: `src-${o.id}`,
    title: "Autumn 10K race",
    category: o.category ?? "race",
    sport: "run",
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: "09:00",
    completionState: o.state ?? "scheduled",
    resolutionDate: (o.state ?? "scheduled") === "scheduled" ? null : o.date,
    archivedAt: o.archived ? nowInstant() : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

const planRow = async (id: string) => (await db.select().from(schema.coachPlans).where(eq(schema.coachPlans.id, id)))[0]!;
const sessionRow = async (id: string) => (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, id)))[0]!;

describe("POST /api/coach/plans/:id/race", () => {
  it("moves the race: the plan's own race session on the old day becomes a quality session, nothing else of it changes", async () => {
    const was = addDays(today, 10);
    const moved = addDays(today, 24);
    await seedPlan({ id: "cp1", raceDate: was });
    await seedSession({ id: "race", planId: "cp1", date: was });
    const before = await sessionRow("race");

    const res = await setRace("cp1", { raceDate: moved });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, raceDate: moved, demoted: 1 });
    expect((await planRow("cp1")).raceDate).toBe(moved);
    const after = await sessionRow("race");
    expect(after.category).toBe("quality");
    expect(after.updatedAt).not.toBe(before.updatedAt);
    // Its title, its days and its copies on the watch and the calendar are as they were.
    expect({ ...after, category: before.category, updatedAt: before.updatedAt }).toEqual(before);
  });

  it("null is no race: the plan names none, and its race session stops claiming to be the race", async () => {
    const was = addDays(today, 10);
    await seedPlan({ id: "cp1", raceDate: was });
    await seedSession({ id: "race", planId: "cp1", date: was });
    const res = await setRace("cp1", { raceDate: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, raceDate: null, demoted: 1 });
    expect((await planRow("cp1")).raceDate).toBeNull();
    expect((await sessionRow("race")).category).toBe("quality");
  });

  it("only the plan's own race sessions still to come on the old day: never another plan's, another day's, a done one or an archived one", async () => {
    const was = addDays(today, 10);
    await seedPlan({ id: "cp1", raceDate: was });
    await seedPlan({ id: "cp2", raceDate: was });
    await seedSession({ id: "own", planId: "cp1", date: was });
    await seedSession({ id: "other-plan", planId: "cp2", date: was });
    await seedSession({ id: "other-day", planId: "cp1", date: addDays(was, 1) });
    await seedSession({ id: "done", planId: "cp1", date: was, state: "completed" });
    await seedSession({ id: "archived", planId: "cp1", date: was, archived: true });
    await seedSession({ id: "tempo", planId: "cp1", date: was, category: "long" });
    expect(await (await setRace("cp1", { raceDate: null })).json()).toMatchObject({ demoted: 1 });
    expect((await sessionRow("own")).category).toBe("quality");
    for (const id of ["other-plan", "other-day", "done", "archived"]) expect((await sessionRow(id)).category, id).toBe("race");
    expect((await sessionRow("tempo")).category).toBe("long");
    expect((await planRow("cp2")).raceDate).toBe(was);
  });

  it("a race set where there was none demotes nothing", async () => {
    await seedPlan({ id: "cp1" });
    await seedSession({ id: "race", planId: "cp1", date: addDays(today, 10) });
    expect(await (await setRace("cp1", { raceDate: addDays(today, 10) })).json()).toEqual({ ok: true, raceDate: addDays(today, 10), demoted: 0 });
    expect((await sessionRow("race")).category).toBe("race");
  });

  it("never touches Settings' race day", async () => {
    const stated = addDays(today, 30);
    await savePreferences(db, userId, { ...prefs, raceDate: stated });
    await seedPlan({ id: "cp1", raceDate: addDays(today, 10) });
    statements.length = 0;
    expect((await setRace("cp1", { raceDate: null })).status).toBe(200);
    expect((await loadPreferences(db, userId)).raceDate).toBe(stated);
    expect((await setRace("cp1", { raceDate: addDays(today, 12) })).status).toBe(200);
    expect((await loadPreferences(db, userId)).raceDate).toBe(stated);
    expect(statements.filter(isWrite).some((s) => /user_preferences/.test(s))).toBe(false);
  });

  it("the same answer twice writes nothing the second time", async () => {
    const was = addDays(today, 10);
    await seedPlan({ id: "cp1", raceDate: was });
    await seedSession({ id: "race", planId: "cp1", date: was });
    expect((await setRace("cp1", { raceDate: null })).status).toBe(200);
    statements.length = 0;
    const again = await setRace("cp1", { raceDate: null });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, raceDate: null, demoted: 0 });
    expect(statements.filter(isWrite)).toEqual([]);

    expect((await setRace("cp1", { raceDate: addDays(today, 20) })).status).toBe(200);
    statements.length = 0;
    expect(await (await setRace("cp1", { raceDate: addDays(today, 20) })).json()).toEqual({ ok: true, raceDate: addDays(today, 20), demoted: 0 });
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("another athlete's plan, a loose bucket and no plan at all are a 404, and nothing changes", async () => {
    const other = (await makeTestUser(db)).userId;
    const was = addDays(today, 10);
    await seedPlan({ id: "theirs", owner: other, raceDate: was });
    await seedSession({ id: "their-race", planId: "theirs", date: was, owner: other });
    const bucket = `adhoc-run-${userId.slice(0, 8)}`;
    await seedPlan({ id: bucket, raceDate: was });
    statements.length = 0;
    for (const id of ["theirs", bucket, "cp-none"]) {
      const res = await setRace(id, { raceDate: null });
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "not_found" });
    }
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await planRow("theirs")).raceDate).toBe(was);
    expect((await planRow(bucket)).raceDate).toBe(was);
    expect((await sessionRow("their-race")).category).toBe("race");
  });

  it("a day that isn't one, or a race before the plan starts, is refused in words", async () => {
    const start = addDays(today, 7);
    await seedPlan({ id: "cp1", start, end: addDays(start, 27), raceDate: addDays(start, 27) });
    for (const raceDate of ["2026-02-30", "next Friday", "2026-10-23T09:00", 20261023]) {
      const res = await setRace("cp1", { raceDate });
      expect(res.status, String(raceDate)).toBe(400);
      expect(await res.json(), String(raceDate)).toEqual({ error: "bad_date", why: "That isn't a day. Pick one from the calendar, or No race." });
    }
    for (const body of [{}, { race: null }, null]) {
      const res = await setRace("cp1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toEqual({ error: "bad_date", why: "That isn't a day. Pick one from the calendar, or No race." });
    }
    const early = await setRace("cp1", { raceDate: addDays(start, -1) });
    expect(early.status).toBe(400);
    // "Mon 26 Oct": the plan's first day, as the coach's lines name a day.
    expect(await early.json()).toEqual({ error: "bad_date", why: `Race day can't be before the plan starts, ${dayLabel(start)}.` });
    expect((await planRow("cp1")).raceDate).toBe(addDays(start, 27));
    // Its first day, any day of it, and any day after it are fine.
    for (const raceDate of [start, addDays(start, 10), addDays(start, 60)]) {
      expect((await setRace("cp1", { raceDate })).status, raceDate).toBe(200);
      expect((await planRow("cp1")).raceDate).toBe(raceDate);
    }
  });

  it("costs the sign-in's two statements and three more at most: a read, the demotion, the write", async () => {
    const was = addDays(today, 10);
    await seedPlan({ id: "cp1", raceDate: was });
    await seedSession({ id: "race", planId: "cp1", date: was });
    statements.length = 0;
    expect((await setRace("cp1", { raceDate: addDays(today, 12) })).status).toBe(200);
    expect(statements.length).toBe(5);
    expect(statements.filter(isWrite)).toHaveLength(2);
    // A first race: nothing to demote.
    await seedPlan({ id: "cp2" });
    statements.length = 0;
    expect((await setRace("cp2", { raceDate: addDays(today, 12) })).status).toBe(200);
    expect(statements.length).toBe(4);
    // The same answer: the read alone.
    statements.length = 0;
    expect((await setRace("cp2", { raceDate: addDays(today, 12) })).status).toBe(200);
    expect(statements.length).toBe(3);
  });
});

describe("everything that reads a plan's race reads it again", () => {
  const raceChips = async () => (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).filter((n) => n.id.startsWith("race:"));

  it("the race chip stops once the plan's race is cleared; a race moved inside 21 days brings it back", async () => {
    await seedPlan({ id: "cp1", raceDate: addDays(today, 10) });
    expect((await raceChips()).map((n) => n.id)).toEqual([`race:${addDays(today, 10)}`]);
    await setRace("cp1", { raceDate: null });
    expect(await raceChips()).toEqual([]);
    await setRace("cp1", { raceDate: addDays(today, 30) });
    expect(await raceChips()).toEqual([]);
    await setRace("cp1", { raceDate: addDays(today, 16) });
    expect(await raceChips()).toEqual([
      { id: `race:${addDays(today, 16)}`, label: "Get me ready for race day", request: "My race is in 16 days. Get me ready for race day." },
    ]);
  });

  it("the plan's detail and the plans list say its own race; their race day still falls back to Settings'", async () => {
    await savePreferences(db, userId, { ...prefs, raceDate: addDays(today, 40) });
    await seedPlan({ id: "cp1", raceDate: addDays(today, 10) });
    type Plan = { id: string; raceDate: string | null; planRaceDate?: string | null };
    const detail = async () => (await getJson<{ plan: Plan }>("/api/coach/plans/cp1/detail")).plan;
    const listed = async () => (await getJson<{ plans: Plan[] }>("/api/coach/plans")).plans.find((p) => p.id === "cp1")!;
    expect(await detail()).toMatchObject({ raceDate: addDays(today, 10), planRaceDate: addDays(today, 10) });
    expect(await listed()).toMatchObject({ raceDate: addDays(today, 10), planRaceDate: addDays(today, 10) });
    await setRace("cp1", { raceDate: null });
    expect(await detail()).toMatchObject({ raceDate: addDays(today, 40), planRaceDate: null });
    expect(await listed()).toMatchObject({ raceDate: addDays(today, 40), planRaceDate: null });
    await setRace("cp1", { raceDate: addDays(today, 12) });
    expect(await detail()).toMatchObject({ raceDate: addDays(today, 12), planRaceDate: addDays(today, 12) });
  });

  it("read_plans gives the coach the plan's race as it is now", async () => {
    await seedPlan({ id: "cp1", raceDate: addDays(today, 10) });
    const coachSees = async () => {
      const res = await readPlans.run(
        { db, env, userId, run: { id: "run-g", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date() },
        {},
      );
      if (isToolErr(res)) throw new Error(res.why);
      return (res.data as { plans: Array<{ id: string; raceDate?: string }> }).plans.find((p) => p.id === "cp1")!;
    };
    expect((await coachSees()).raceDate).toBe(addDays(today, 10));
    await setRace("cp1", { raceDate: null });
    expect(await coachSees()).not.toHaveProperty("raceDate");
    await setRace("cp1", { raceDate: addDays(today, 18) });
    expect((await coachSees()).raceDate).toBe(addDays(today, 18));
  });
});
