/**
 * `/api/plans` (plans with a purpose, Stage 1): the plans the account has, and the edit of a plan's purpose, brief and
 * ending. A phase is not a plan, and the one-off bucket is not one. All names are made up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plans.js";
import { programRoutes } from "../src/routes/programs.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import { readNudges } from "../src/services/coach-nudges.js";
import { planLastDaySql } from "../src/services/plan-ending.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachPlans, programs, programVersions } = schema;
const NOW = "2026-10-05T12:00:00.000Z";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

let db: Db;
let statements: string[];
let userId: string;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

const call = (method: string, path: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, "/api/plans", planRoutes).request(
    path,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );

async function plan(id: string, kind: string, extra: Partial<typeof programs.$inferInsert> = {}) {
  await db.insert(programs).values({
    id,
    userId,
    kind,
    name: `Plan ${id}`,
    status: "active",
    disciplines: ["strength"],
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });
}

async function phase(id: string, programId: string | null, startDate = "2026-10-05", endDate = "2026-10-18") {
  await db.insert(coachPlans).values({
    id,
    userId,
    discipline: "run",
    name: `Block ${id}`,
    status: "active",
    startDate,
    endDate,
    raceDate: null,
    stampPrefix: id,
    programId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

type Summary = {
  id: string;
  kind: string;
  lineKey: string | null;
  listedAs: string | null;
  purpose: string | null;
  onEnd: string | null;
  status: string;
  course: unknown;
  prompt: unknown;
};
const listed = async () => ((await (await call("GET", "/api/plans")).json()) as { plans: Summary[] }).plans;
const rowOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;

describe("GET /api/plans", () => {
  it("lists a coach plan with its line's key, a programme and a course, and neither a phase nor the one-off bucket", async () => {
    await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask", purpose: "Build the base" });
    await phase("blk-1", "plan-a", "2025-10-05", "2025-10-18");
    await phase("blk-2", "plan-a", "2025-10-19", "2025-11-01");
    await plan("prog-1", "adaptive", { onEnd: "continue" });
    await plan("course-1", "course", { onEnd: "finish" });
    await plan("bucket", "studio", { onEnd: null });

    const plans = await listed();
    expect(plans.map((p) => p.id).sort()).toEqual(["course-1", "plan-a", "prog-1"]);
    const coach = plans.find((p) => p.id === "plan-a")!;
    expect(coach.lineKey).toMatch(/\S/);
    expect(coach).toMatchObject({ purpose: "Build the base", onEnd: "ask", listedAs: null, course: null, prompt: null, status: "active" });
    // A programme and a course are listed as themselves, and have no line.
    expect(plans.find((p) => p.id === "prog-1")).toMatchObject({ kind: "adaptive", listedAs: "prog-1", lineKey: null });
    expect(plans.find((p) => p.id === "course-1")).toMatchObject({ kind: "course", listedAs: "course-1", lineKey: null });
  });

  it("a Studio coach plan is listed as its studio plan's id", async () => {
    await plan("container-1", "coach", { source: { studioPlanId: "studio-xyz" } });
    expect((await listed())[0]).toMatchObject({ id: "container-1", listedAs: "studio-xyz", lineKey: null });
  });

  it("another account's plans never appear", async () => {
    const { userId: other } = await makeTestUser(db);
    await db.insert(programs).values({ id: "theirs", userId: other, kind: "course", name: "Theirs", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    expect(await listed()).toEqual([]);
  });

  it("reads the plans and the phases once each, beside the session and the preferences", async () => {
    await plan("plan-a", "coach");
    await phase("blk-1", "plan-a");
    await plan("prog-1", "adaptive");
    statements.length = 0;
    await call("GET", "/api/plans");
    const reads = statements.filter((s) => /from "(programs|coach_plans)"/i.test(s));
    expect(reads.length).toBe(2);
    expect(statements.length).toBeLessThanOrEqual(6);
  });

  describe("prompt: one rule with the chip (planPrompt), on the plan's row", () => {
    // The athlete's today in the test account is read from the route's clock, so dates here are days from it.
    const today = todayInZone("America/Los_Angeles");
    const ahead = (n: number) => addDays(today, n);
    const promptOf = async (id: string) => (await listed()).find((p) => p.id === id)!.prompt;
    const WORDS = (days: number) => ({ kind: "whats_next", label: "Plan what comes after my running plan", request: `Plan what comes after my running plan — it ends in ${days} days.` });

    it("a coach plan that asks, its last block ending in 12 days: the chip's own words", async () => {
      await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("blk-1", "plan-a", ahead(-20), ahead(12));
      expect(await promptOf("plan-a")).toEqual(WORDS(12));
    });

    it("the row and the chip send the same request, by the same rule", async () => {
      await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("blk-1", "plan-a", ahead(-20), ahead(12));
      const prefs = await loadPreferences(db, userId);
      const chip = (await readNudges(db, userId, prefs, today, new Date())).find((n) => n.id === "ending:blk-1");
      const row = (await promptOf("plan-a")) as { label: string; request: string };
      expect(chip).toBeDefined();
      expect({ label: row.label, request: row.request }).toEqual({ label: chip!.label, request: chip!.request });
    });

    it("22 days out, a plan that finishes, a stopped one, and a paused one: none", async () => {
      await plan("far", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("b-far", "far", ahead(-20), ahead(22));
      await plan("fin", "coach", { disciplines: ["run"], onEnd: "finish" });
      await phase("b-fin", "fin", ahead(-20), ahead(12));
      await plan("stopped", "coach", { disciplines: ["run"], onEnd: "ask", status: "retired" });
      await phase("b-stopped", "stopped", ahead(-20), ahead(12));
      await plan("paused", "coach", { disciplines: ["run"], onEnd: "ask", pausedUntil: ahead(3) });
      await phase("b-paused", "paused", ahead(-20), ahead(12));
      for (const id of ["far", "fin", "stopped", "paused"]) expect(await promptOf(id), id).toBeNull();
    });

    it("a phase following on, or an outline week still ahead, is no ending", async () => {
      await plan("follow", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("f-1", "follow", ahead(-20), ahead(5));
      await phase("f-2", "follow", ahead(6), ahead(60));
      await plan("outline", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("o-1", "outline", ahead(-20), ahead(12));
      await db.insert(schema.coachPlanWeeks).values({ id: "ow", planId: "o-1", weekStart: addDays(startOfIsoWeek(today), 7 * 6), state: "shape", shape: { volumeTarget: "x", keySessions: [] } });
      expect(await promptOf("follow")).toBeNull();
      expect(await promptOf("outline")).toBeNull();
    });

    it("only what is still to come counts toward the plan's last day: a stopped block, a firm week and an archived session past the end do not", async () => {
      await plan("quiet", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("q-live", "quiet", ahead(-20), ahead(12));
      // A block of the plan the athlete stopped, whose dates ran on.
      await phase("q-stopped", "quiet", ahead(-20), ahead(70));
      await db.update(schema.coachPlans).set({ status: "retired" }).where(eq(schema.coachPlans.id, "q-stopped"));
      await db.insert(schema.coachPlanWeeks).values({ id: "q-stopped-w", planId: "q-stopped", weekStart: ahead(60), state: "shape", shape: null });
      // A firm week is a week with its sessions, not an outline: past the block's end it is not read as one.
      await db.insert(schema.coachPlanWeeks).values({ id: "q-firm", planId: "q-live", weekStart: ahead(50), state: "firm", shape: null });
      // A session taken off the calendar.
      await db.insert(schema.plannedWorkouts).values({
        id: "pw-gone", userId, planId: "quiet", sourceWorkoutId: "s2", title: "T", category: "easy", sport: "run", originalPlanDate: ahead(45), lastVerifiedCorosDate: ahead(45),
        effectiveDate: ahead(45), effectiveTime: "07:00", completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, archivedAt: NOW, createdAt: NOW, updatedAt: NOW,
      });
      expect(await promptOf("quiet")).toEqual(WORDS(12));
    });

    const session = (id: string, planId: string, date: string, state = "scheduled", archivedAt: string | null = null) =>
      db.insert(schema.plannedWorkouts).values({
        id, userId, planId, sourceWorkoutId: id, title: "T", category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date,
        effectiveDate: date, effectiveTime: "07:00", completionState: state, sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, archivedAt, createdAt: NOW, updatedAt: NOW,
      });

    it("a session filed under one of the plan's blocks, past the block's end, means the plan isn't ending; one skipped, missed or done does not", async () => {
      await plan("filed", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("filed-b", "filed", ahead(-20), ahead(12));
      await session("late", "filed-b", ahead(40));
      expect(await promptOf("filed")).toBeNull();
      for (const state of ["skipped", "missed", "completed"]) {
        await db.delete(schema.plannedWorkouts);
        await session("late", "filed-b", ahead(40), state);
        expect(await promptOf("filed"), state).toEqual(WORDS(12));
      }
      await db.delete(schema.plannedWorkouts);
      await session("late", "filed-b", ahead(40), "unresolved");
      expect(await promptOf("filed"), "unresolved").toBeNull();
    });

    it("an outline week that begins inside its block reaches no further than the block: ends in 12 days, not 16", async () => {
      await plan("clip", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("clip-b", "clip", ahead(-20), ahead(12));
      await db.insert(schema.coachPlanWeeks).values({ id: "clip-w", planId: "clip-b", weekStart: ahead(10), state: "shape", shape: null });
      expect(await promptOf("clip")).toEqual(WORDS(12));
    });

    it("a plan that has run out (its blocks swept to completed) still asks for 21 days, in plain words; a Past row too", async () => {
      await plan("ran", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("ran-b", "ran", ahead(-40), ahead(-3));
      await db.update(schema.coachPlans).set({ status: "completed" }).where(eq(schema.coachPlans.id, "ran-b"));
      expect(await promptOf("ran")).toEqual({ kind: "whats_next", label: "Plan what comes after my running plan", request: "Plan what comes after my running plan — it ended 3 days ago." });
      await db.update(schema.coachPlans).set({ endDate: ahead(-22) }).where(eq(schema.coachPlans.id, "ran-b"));
      expect(await promptOf("ran")).toBeNull();
      // A block ended yesterday, not yet swept, with this week's outline: it ended yesterday, not "in 2 days".
      await db.update(schema.coachPlans).set({ status: "active", endDate: ahead(-1) }).where(eq(schema.coachPlans.id, "ran-b"));
      await db.insert(schema.coachPlanWeeks).values({ id: "ran-w", planId: "ran-b", weekStart: ahead(-3), state: "shape", shape: null });
      expect(await promptOf("ran")).toMatchObject({ request: "Plan what comes after my running plan — it ended yesterday." });
    });

    it("a new phase after a plan ran out ends the asking", async () => {
      await plan("again", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("again-1", "again", ahead(-40), ahead(-3));
      await db.update(schema.coachPlans).set({ status: "completed" }).where(eq(schema.coachPlans.id, "again-1"));
      expect(await promptOf("again")).not.toBeNull();
      await phase("again-2", "again", ahead(-2), ahead(60));
      expect(await promptOf("again")).toBeNull();
    });

    it("a stopped plan that ran out, and one that finishes, ask nothing", async () => {
      await plan("s-ran", "coach", { disciplines: ["run"], onEnd: "ask", status: "retired" });
      await phase("s-ran-b", "s-ran", ahead(-40), ahead(-3));
      await plan("f-ran", "coach", { disciplines: ["run"], onEnd: "finish" });
      await phase("f-ran-b", "f-ran", ahead(-40), ahead(-3));
      expect(await promptOf("s-ran")).toBeNull();
      expect(await promptOf("f-ran")).toBeNull();
    });

    it("a plan of run and lift blocks is called by its name on the row, as on the chip", async () => {
      await plan("duo", "coach", { disciplines: ["run"], onEnd: "ask", name: "Zorbex duo" });
      await phase("duo-1", "duo", ahead(-20), ahead(12));
      await db.insert(schema.coachPlans).values({ id: "duo-2", userId, discipline: "lift", name: "Lift block", status: "active", startDate: ahead(-20), endDate: ahead(12), raceDate: null, stampPrefix: "duo-2", programId: "duo", createdAt: NOW, updatedAt: NOW });
      const row = (await promptOf("duo")) as { label: string; request: string };
      expect(row.label).toBe("Plan what comes after Zorbex duo");
      const chip = (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).find((n) => n.id.startsWith("ending:"));
      expect({ label: row.label, request: row.request }).toEqual({ label: chip!.label, request: chip!.request });
    });

    it("a COROS plan and a Studio-held plan ask on the chip as on the row", async () => {
      await plan("coros", "coros_import", { disciplines: ["run"], onEnd: "ask" });
      await session("c1", "coros", ahead(9));
      await plan("held", "coach", { disciplines: ["strength"], onEnd: "continue", source: { studioPlanId: "studio-x" } });
      await session("h1", "held", ahead(20));
      const chips = (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).filter((n) => n.id.startsWith("ending:"));
      const rows = (await listed()).filter((p) => p.prompt).map((p) => (p.prompt as { request: string }).request).sort();
      expect(rows).toEqual(["Plan what comes after my lifting plan — it ends in 20 days.", "Plan what comes after my running plan — it ends in 9 days."]);
      // The chip offers the soonest; the row of the other is its own.
      expect(chips.map((c) => c.request)).toEqual(["Plan what comes after my running plan — it ends in 9 days."]);
    });

    it("ended means a date already past: a skipped or archived session ahead leaves a run-out plan run out, on the row and the chip", async () => {
      const chipFor = async () => (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).filter((n) => n.id.startsWith("ending:")).map((n) => n.request);
      await plan("done", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("done-b", "done", ahead(-40), ahead(-3));
      await db.update(schema.coachPlans).set({ status: "completed" }).where(eq(schema.coachPlans.id, "done-b"));
      await session("done-skip", "done-b", ahead(30), "skipped");
      expect(await promptOf("done")).toMatchObject({ request: "Plan what comes after my running plan — it ended 3 days ago." });
      expect(await chipFor()).toEqual(["Plan what comes after my running plan — it ended 3 days ago."]);
      // A COROS plan done at -4 with one skipped at +5 says it ended, not "ends in 5 days".
      await db.delete(schema.coachPlans);
      await db.delete(schema.plannedWorkouts);
      await db.delete(schema.programs);
      await plan("coros", "coros_import", { disciplines: ["run"], onEnd: "ask" });
      await session("c-done", "coros", ahead(-4), "completed");
      await session("c-skip", "coros", ahead(5), "skipped");
      expect(await promptOf("coros")).toMatchObject({ request: "Plan what comes after my running plan — it ended 4 days ago." });
      expect(await chipFor()).toEqual(["Plan what comes after my running plan — it ended 4 days ago."]);
      // Only an archived session ahead, at +10 or +400: nothing readable, nothing asked.
      await db.delete(schema.plannedWorkouts);
      await session("a10", "coros", ahead(10), "scheduled", NOW);
      await session("a400", "coros", ahead(400), "scheduled", NOW);
      expect(await promptOf("coros")).toBeNull();
      expect(await chipFor()).toEqual([]);
    });

    it("a plan that continues on its own asks while its last day is ahead, and says nothing once it has run out: the row and the chip agree (P1)", async () => {
      const chipFor = async () => (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).filter((n) => n.id.startsWith("ending:")).map((n) => n.request);
      await plan("held", "coach", { disciplines: ["strength"], onEnd: "continue", source: { studioPlanId: "studio-x" } });
      await session("h-ahead", "held", ahead(5));
      expect(await promptOf("held")).toMatchObject({ request: "Plan what comes after my lifting plan — it ends in 5 days." });
      expect(await chipFor()).toEqual(["Plan what comes after my lifting plan — it ends in 5 days."]);
      await db.delete(schema.plannedWorkouts);
      await session("h-past", "held", ahead(-3), "completed");
      expect(await promptOf("held")).toBeNull();
      expect(await chipFor()).toEqual([]);
    });

    it("a running plan of the same sport with a later last day ends an older run-out prompt, as a following phase does; another sport's does not", async () => {
      const chipFor = async () => (await readNudges(db, userId, await loadPreferences(db, userId), today, new Date())).filter((n) => n.id.startsWith("ending:")).map((n) => n.id);
      await plan("old", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("old-b", "old", ahead(-40), ahead(-3));
      await db.update(schema.coachPlans).set({ status: "completed" }).where(eq(schema.coachPlans.id, "old-b"));
      expect(await promptOf("old")).not.toBeNull();
      // A running plan of another sport, ending far off: the old one still asks.
      await plan("lift", "coach", { disciplines: ["strength"], onEnd: "continue" });
      await db.insert(schema.coachPlans).values({ id: "lift-b", userId, discipline: "lift", name: "Lift block", status: "active", startDate: ahead(-5), endDate: ahead(60), raceDate: null, stampPrefix: "lift-b", programId: "lift", createdAt: NOW, updatedAt: NOW });
      expect(await promptOf("old")).not.toBeNull();
      expect(await chipFor()).toEqual(["ending:old-b"]);
      // A running plan of the same sport, ending later: the old one stops asking.
      await plan("new", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("new-b", "new", ahead(-2), ahead(60));
      expect(await promptOf("old")).toBeNull();
      expect(await chipFor()).toEqual([]);
      // A stopped one doesn't count as following.
      await db.update(schema.programs).set({ status: "retired" }).where(eq(schema.programs.id, "new"));
      expect(await promptOf("old")).not.toBeNull();
      expect(await chipFor()).toEqual(["ending:old-b"]);
    });

    it("only a plan still running follows another: one that ran out later doesn't end an older one's question, nor does a plan of several sports end another's", async () => {
      await plan("older", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("older-b", "older", ahead(-50), ahead(-10));
      await plan("newer", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("newer-b", "newer", ahead(-30), ahead(-3));
      await db.update(schema.coachPlans).set({ status: "completed" }).where(sql`${schema.coachPlans.id} in ('older-b', 'newer-b')`);
      expect(await promptOf("older")).toMatchObject({ request: "Plan what comes after my running plan — it ended 10 days ago." });
      expect(await promptOf("newer")).toMatchObject({ request: "Plan what comes after my running plan — it ended 3 days ago." });
      // Plans of several sports have no one sport to follow in.
      await db.delete(schema.coachPlans);
      await db.delete(schema.programs);
      for (const [id, end, status] of [["duo-old", ahead(-3), "completed"], ["duo-new", ahead(60), "active"]] as const) {
        await plan(id, "coach", { disciplines: ["run"], onEnd: "ask", name: `Zorbex ${id}` });
        await phase(`${id}-r`, id, ahead(-70), end);
        await db.insert(schema.coachPlans).values({ id: `${id}-l`, userId, discipline: "lift", name: "Lift", status, startDate: ahead(-70), endDate: end, raceDate: null, stampPrefix: `${id}-l`, programId: id, createdAt: NOW, updatedAt: NOW });
        await db.update(schema.coachPlans).set({ status }).where(eq(schema.coachPlans.id, `${id}-r`));
      }
      expect(await promptOf("duo-old")).not.toBeNull();
    });

    it("a plan's last day walks its own sessions by the plan, never the athlete's whole history (query plan)", async () => {
      const lines = ((await db.all(sql`explain query plan select ${planLastDaySql(today)} as d from programs where programs.user_id = ${userId}`)) as Array<{ detail: string }>).map((r) => r.detail.trim());
      const pwLines = lines.filter((l) => /^(SEARCH|SCAN) pw\b/.test(l));
      // Four reads of the sessions (live and run out, each by the plan and by its blocks), every one by (user, plan).
      expect(pwLines).toHaveLength(4);
      for (const l of pwLines) expect(l, l).toMatch(/USING INDEX planned_workouts_source_unique \(user_id=\? AND plan_id=\?\)/);
    });

    it("an outline week reaches to its sixth day after the week's start: that day, 21 days out, still asks; the next does not", async () => {
      for (const [id, weekStart] of [["ow-in", ahead(15)], ["ow-out", ahead(16)]] as const) {
        await plan(id, "coach", { disciplines: ["run"], onEnd: "ask" });
        await phase(`${id}-b`, id, ahead(-20), ahead(2));
        await db.insert(schema.coachPlanWeeks).values({ id: `${id}-w`, planId: `${id}-b`, weekStart, state: "shape", shape: null });
      }
      expect(await promptOf("ow-in")).toEqual(WORDS(21));
      expect(await promptOf("ow-out")).toBeNull();
    });

    it("a COROS plan that asks takes its last session from its rows; a course and a programme never prompt", async () => {
      await plan("coros", "coros_import", { disciplines: ["run"], onEnd: "ask" });
      await db.insert(schema.plannedWorkouts).values({
        id: "pw-last", userId, planId: "coros", sourceWorkoutId: "s1", title: "T", category: "easy", sport: "run", originalPlanDate: ahead(9), lastVerifiedCorosDate: ahead(9),
        effectiveDate: ahead(9), effectiveTime: "07:00", completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, createdAt: NOW, updatedAt: NOW,
      });
      await plan("course-1", "course", { onEnd: "continue" });
      await plan("prog-1", "adaptive", { onEnd: "continue" });
      expect(await promptOf("coros")).toEqual(WORDS(9));
      expect(await promptOf("course-1")).toBeNull();
      expect(await promptOf("prog-1")).toBeNull();
    });

    it("a plan of more than one sport has no sport to be called by: its own name stands in", async () => {
      await plan("mixed", "coach", { disciplines: ["run", "strength"], onEnd: "ask", name: "Zorbex mix" });
      await phase("mixed-1", "mixed", ahead(-20), ahead(4));
      await db.insert(schema.coachPlans).values({ id: "mixed-2", userId, discipline: "lift", name: "Lift block", status: "active", startDate: ahead(-20), endDate: ahead(4), raceDate: null, stampPrefix: "mixed-2", programId: "mixed", createdAt: NOW, updatedAt: NOW });
      expect(await promptOf("mixed")).toEqual({ kind: "whats_next", label: "Plan what comes after Zorbex mix", request: "Plan what comes after Zorbex mix — it ends in 4 days." });
    });

    it("a plan with no purpose or brief yet still prompts, and the date is never stored on the plan", async () => {
      await plan("bare", "coach", { disciplines: ["run"], onEnd: "ask", purpose: null, brief: null });
      await phase("bare-1", "bare", ahead(-20), ahead(3));
      expect(await promptOf("bare")).toMatchObject({ kind: "whats_next", request: "Plan what comes after my running plan — it ends in 3 days." });
      const row = await rowOf("bare");
      expect(row.startDate).toBeNull();
      expect(row.endDate).toBeNull();
    });

    it("the list still reads the plans and the phases once each: the last day rides in the plans read", async () => {
      await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask" });
      await phase("blk-1", "plan-a", ahead(-20), ahead(12));
      await db.insert(schema.coachPlanWeeks).values({ id: "ow2", planId: "blk-1", weekStart: ahead(1), state: "shape", shape: null });
      statements.length = 0;
      await call("GET", "/api/plans");
      expect(statements.filter((s) => /from "(programs|coach_plans)"/i.test(s)).length).toBe(2);
      expect(statements.length).toBeLessThanOrEqual(6);
      // Only a coach or COROS plan's row works out a last day: a programme's and a course's cost nothing for it.
      const plansRead = statements.find((s) => /from "programs"/i.test(s))!;
      expect(plansRead).toMatch(/case when programs\.kind in \('coach', 'coros_import'\) then coalesce\(/);
    });
  });

  it("/api/programs still answers the adaptive programme alone", async () => {
    await plan("prog-1", "adaptive", { onEnd: "continue" });
    await plan("course-1", "course");
    await plan("plan-a", "coach");
    const res = await mountRoutes(db, "/api/programs", programRoutes).request("/api/programs", { headers: { Cookie: cookie } }, makeEnv());
    const body = (await res.json()) as { programs: Array<{ id: string }> };
    expect(body.programs.map((p) => p.id)).toEqual(["prog-1"]);
  });
});

describe("PATCH /api/plans/:id", () => {
  it("writes the fields and records a version each time", async () => {
    await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask" });
    const res = await call("PATCH", "/api/plans/plan-a", { purpose: "Be ready", brief: "Keep easy days easy", onEnd: "finish", objectiveIds: ["o1"], pausedUntil: "2099-01-01" });
    expect(res.status).toBe(200);
    expect(await rowOf("plan-a")).toMatchObject({ purpose: "Be ready", brief: "Keep easy days easy", onEnd: "finish", objectiveIds: ["o1"], pausedUntil: "2099-01-01" });
    const versions = await db.select().from(programVersions).where(eq(programVersions.programId, "plan-a"));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.versionNum).toBe(1);
    expect(versions[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0]!.summary).toMatchObject({ changed: expect.arrayContaining(["purpose", "onEnd"]) });
    expect(((await res.json()) as { plan: Summary }).plan).toMatchObject({ id: "plan-a", purpose: "Be ready", onEnd: "finish" });

    await call("PATCH", "/api/plans/plan-a", { purpose: "Be readier" });
    const next = await db.select().from(programVersions).where(eq(programVersions.programId, "plan-a"));
    expect(next.map((v) => v.versionNum).sort()).toEqual([1, 2]);
  });

  it("an empty patch writes nothing and records no version", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", {})).status).toBe(200);
    expect(await db.select().from(programVersions)).toEqual([]);
  });

  it("a course cannot ask: 422 with the words, and nothing changes", async () => {
    await plan("course-1", "course", { onEnd: "continue" });
    const res = await call("PATCH", "/api/plans/course-1", { onEnd: "ask" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/ask/);
    expect((await rowOf("course-1")).onEnd).toBe("continue");
    expect(await db.select().from(programVersions)).toEqual([]);
  });

  it("another account's plan is 404", async () => {
    const { userId: other } = await makeTestUser(db);
    await db.insert(programs).values({ id: "theirs", userId: other, kind: "coach", name: "Theirs", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    expect((await call("PATCH", "/api/plans/theirs", { purpose: "Mine now" })).status).toBe(404);
    expect((await rowOf("theirs")).purpose).toBeNull();
  });

  it("the one-off bucket is not a plan: 404", async () => {
    await plan("bucket", "studio");
    expect((await call("PATCH", "/api/plans/bucket", { purpose: "x" })).status).toBe(404);
  });

  it("a purpose of 201 characters is 422; 200 is fine", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { purpose: "x".repeat(201) })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { purpose: "x".repeat(200) })).status).toBe(200);
  });

  it("a brief of 1,001 characters is 422; 1,000 is fine", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { brief: "x".repeat(1001) })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { brief: "x".repeat(1000) })).status).toBe(200);
  });

  it("a pause date in the past or not a date is 422, and null clears a pause", async () => {
    await plan("plan-a", "coach", { pausedUntil: "2099-01-01" });
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: "2000-01-01" })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: "not a date" })).status).toBe(422);
    expect((await rowOf("plan-a")).pausedUntil).toBe("2099-01-01");
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: null })).status).toBe(200);
    expect((await rowOf("plan-a")).pausedUntil).toBeNull();
  });

  it("easeNext merges into a course's config; any other kind is 422", async () => {
    await plan("course-1", "course", { onEnd: "continue", config: { course: "c", weekdays: [1, 3], time: "07:00", quietDaysBeforeRace: 7, placementWeeksAhead: 2, easeNext: false } });
    expect((await call("PATCH", "/api/plans/course-1", { easeNext: true })).status).toBe(200);
    expect((await rowOf("course-1")).config).toMatchObject({ course: "c", weekdays: [1, 3], time: "07:00", easeNext: true });
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { easeNext: true })).status).toBe(422);
  });

  it("an unknown key is 422", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { name: "Renamed" })).status).toBe(422);
  });

  it("applyPlanPatch lands the row and its version inside ONE transaction, and says what changed", async () => {
    let inTx = false;
    let txCalls = 0;
    const writes: Array<{ inTx: boolean }> = [];
    const rec = makeTestDb({ boundVariableCap: 100, onStatement: (s) => isWrite(s) && writes.push({ inTx }) });
    const { userId: u } = await makeTestUser(rec);
    await rec.insert(programs).values({ id: "p", userId: u, kind: "coach", name: "P", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    const handle = rec as unknown as { transaction: (run: () => void) => void };
    const real = handle.transaction.bind(rec);
    handle.transaction = (run) => {
      txCalls += 1;
      real(() => {
        inTx = true;
        try {
          run();
        } finally {
          inTx = false;
        }
      });
    };
    writes.length = 0;
    expect(await applyPlanPatch(rec, u, "p", { purpose: "Hello" }, NOW)).toEqual({ ok: true, changed: ["purpose"] });
    expect(txCalls).toBe(1);
    expect(writes).toEqual([{ inTx: true }, { inTx: true }]);
    expect(await applyPlanPatch(rec, u, "nope", { purpose: "Hello" }, NOW)).toEqual({ ok: false, error: "not_found" });
  });

  it("an archived plan is not a plan: 404, and nothing is written", async () => {
    await plan("old", "coach", { archivedAt: NOW });
    expect((await call("PATCH", "/api/plans/old", { purpose: "Back" })).status).toBe(404);
    expect((await rowOf("old")).purpose).toBeNull();
    expect(await db.select().from(programVersions)).toEqual([]);
  });
});
