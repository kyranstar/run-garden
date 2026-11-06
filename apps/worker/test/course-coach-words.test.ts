/**
 * WHAT THE COACH IS TOLD IT CAN DO WITH A COURSE'S OUTLINE. A programme's outline says pin_moves and change_programme; a
 * course has no pool for pin_moves to reach and change_programme refuses one, so a course's says what works: change_plan to
 * ease the next session or pause the plan, adjust_plan to skip or move this one, or a new workout. The coach reads it in
 * the opening context, in read_plan, read_plans and get_workout, and in propose_workout's refusal; and read_plans gives it
 * the plan's id, which change_plan takes. A programme's outline says what it always said.
 *
 * Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { COURSE_OUTLINE_WORDS, courseConfigSchema, newId, REVISABILITY_WORDS } from "@rg/domain";
import { COURSES } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { ACT_TOOLS, READ_TOOLS } from "../src/services/design-tools/index.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { day, NOW, seedOtherAthlete, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const { coachRuns, plannedWorkouts, programs } = schema;
const ENV = {} as Env;
const PLAN = "course-plan-invented";

let db: Db;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
/** A course's outline today. */
let outline: string;

const NO_COURSE_WORDS = /pin_moves|change_programme/;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  rich = await seedRichAthlete(db);
  const at = NOW.toISOString();
  await db.insert(programs).values({
    id: PLAN, userId: rich.userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], onEnd: "continue", purpose: "Rest the legs",
    config: courseConfigSchema.parse({ course: "intro", weekdays: [0], time: "19:30" }), createdAt: at, updatedAt: at,
  });
  outline = `slot-${PLAN}-${TODAY}`;
  await db.insert(plannedWorkouts).values({
    id: outline, userId: rich.userId, planId: PLAN, sourceWorkoutId: outline, title: "Evening practice", category: "yoga", sport: "yoga", originalPlanDate: TODAY, lastVerifiedCorosDate: "",
    effectiveDate: TODAY, effectiveTime: "19:30", sourceContentFingerprint: "program", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
    origin: "program", contentState: "outline", completionState: "scheduled", createdAt: at, updatedAt: at,
  });
});

const COURSE_WORDS = { no: COURSE_OUTLINE_WORDS.why, instead: COURSE_OUTLINE_WORDS.instead };
const PROGRAMME_WORDS = { no: REVISABILITY_WORDS.programme.why, instead: REVISABILITY_WORDS.programme.instead };

let seq = 0;
async function ctx(): Promise<ToolContext> {
  const id = `run-words-${++seq}`;
  const at = NOW.toISOString();
  await db.insert(coachRuns).values({ id, userId: rich.userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Something for this.", status: "active", state: null, steps: 0, costUsd: 0, createdAt: at, updatedAt: at });
  return { db, env: ENV, userId: rich.userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${seq}` };
}
const read = async (name: string, input: unknown): Promise<any> => {
  const res = (await READ_TOOLS.find((t) => t.name === name)!.run(await ctx(), input)) as ToolOk | ToolErr;
  if (isToolErr(res)) throw new Error(res.why);
  return res.data;
};

describe("the words themselves", () => {
  it("say what a course's outline can do, name no course and neither tool that can't", () => {
    expect(`${COURSE_OUTLINE_WORDS.why} ${COURSE_OUTLINE_WORDS.instead}`).not.toMatch(NO_COURSE_WORDS);
    expect(COURSE_OUTLINE_WORDS.instead).toMatch(/change_plan/);
    expect(COURSE_OUTLINE_WORDS.instead).toMatch(/adjust_plan/);
    expect(COURSE_OUTLINE_WORDS.instead).toMatch(/new workout/);
    const names = Object.values(COURSES).flatMap((c) => [c.id, c.name]);
    expect(names.length).toBeGreaterThan(0);
    expect(`${COURSE_OUTLINE_WORDS.why} ${COURSE_OUTLINE_WORDS.instead}`).not.toMatch(new RegExp(`\\b(${names.join("|")})\\b`, "i"));
  });
});

describe("the opening context", () => {
  it("a course's outline says change_plan and adjust_plan; a programme's still says what it did", async () => {
    const { header } = await buildDesignContext(db, ENV, rich.userId, { id: "run-open", role: "main", scope: { kind: "now" }, request: "Something.", parentId: null }, NOW);
    const line = header.split("\n").find((l) => l.startsWith("Today's plan:"))!;
    expect(line).toContain("19:30 yoga or mobility, programme session (about 11 min), not revisable (course) — change_plan to ease or pause, adjust_plan to skip or move, or a new workout");
    expect(line).toContain("07:00 strength, programme session (about 35 min)");
    expect(line).toMatch(/07:00 strength[^;]*not revisable \(programme\) — pin_moves, change_programme, or a new workout/);
  });

  it("a plan's words reach the focus block too", async () => {
    const { header } = await buildDesignContext(db, ENV, rich.userId, { id: "run-focus", role: "main", scope: { kind: "now" }, request: "Something.", parentId: null, focus: { kind: "workout", id: outline } }, NOW);
    const block = header.slice(header.indexOf("The athlete asked from:"));
    expect(block.split("\n")[0]).toContain("not revisable (course) — change_plan");
  });
});

describe("read_plan", () => {
  it("a course's outline carries the course's words; a programme's its own", async () => {
    const data = await read("read_plan", { from: TODAY, to: TODAY, limit: 50 });
    const of = (id: string) => data.workouts.find((p: { id: string }) => p.id === id);
    expect(of(outline).revisable).toEqual(COURSE_WORDS);
    expect(of(rich.outlineToday).revisable).toEqual(PROGRAMME_WORDS);
  });

  it("read_day too", async () => {
    const data = await read("read_day", { date: TODAY });
    expect(JSON.stringify(data)).toContain(COURSE_OUTLINE_WORDS.instead);
  });
});

describe("get_workout", () => {
  it("a course's outline carries the course's words", async () => {
    expect((await read("get_workout", { id: outline })).revisable).toEqual(COURSE_WORDS);
  });

  it("a programme's outline its own", async () => {
    expect((await read("get_workout", { id: rich.outlineToday })).revisable).toEqual(PROGRAMME_WORDS);
  });
});

describe("read_plans", () => {
  const plans = async (): Promise<any[]> => ((await readPlans.run(await ctx(), {})) as ToolOk & { data: { plans: any[] } }).data.plans;

  it("lists the course: its id for change_plan, what it says of itself, and what may change", async () => {
    const course = (await plans()).find((p) => p.id === PLAN);
    expect(course).toMatchObject({ kind: "course", status: "active", planId: PLAN, onEnd: "continue", coachMayChange: false });
    expect(course.why).toMatch(/change_plan/);
    expect(course.why).toMatch(/adjust_plan/);
    expect(course.why).not.toMatch(NO_COURSE_WORDS);
    expect(course.next[0]).toMatchObject({ id: outline, revisable: COURSE_WORDS });
  });

  it("leaves out a course that's stopped", async () => {
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, PLAN));
    expect((await plans()).find((p) => p.id === PLAN)).toBeUndefined();
    await db.update(programs).set({ status: "active" }).where(eq(programs.id, PLAN));
  });

  it("leaves out one that's archived, as the list does", async () => {
    await db.update(programs).set({ archivedAt: NOW.toISOString() }).where(eq(programs.id, PLAN));
    expect((await plans()).find((p) => p.id === PLAN)).toBeUndefined();
    await db.update(programs).set({ archivedAt: null }).where(eq(programs.id, PLAN));
  });

  it("change_plan takes the id it gives", async () => {
    const c = await ctx();
    const res = (await ACT_TOOLS.find((t) => t.name === "change_plan")!.run(c, { planId: PLAN, easeNext: true, why: "A hard week: ease the next one." })) as ToolOk | ToolErr;
    expect(isToolErr(res) ? res.why : "stored").toBe("stored");
  });
});

describe("propose_workout's refusal", () => {
  const refusal = async (workoutId: string) => {
    const c = await ctx();
    const res = (await ACT_TOOLS.find((t) => t.name === "propose_workout")!.run(c, { doc: studioDoc(), target: { kind: "revise", workoutId, baseRev: 0 } })) as ToolOk | ToolErr;
    if (!isToolErr(res)) throw new Error("expected a refusal");
    return res;
  };

  it("a course's outline: the course's words, as its fix", async () => {
    expect(await refusal(outline)).toEqual({ error: "not_editable", why: COURSE_OUTLINE_WORDS.why, fix: COURSE_OUTLINE_WORDS.instead });
  });

  it("a programme's: its own", async () => {
    expect(await refusal(rich.outlineToday)).toEqual({ error: "not_editable", why: REVISABILITY_WORDS.programme.why, fix: REVISABILITY_WORDS.programme.instead });
  });
});

describe("what isn't a course's outline", () => {
  it("a course's written session isn't one: it's revisable", async () => {
    const id = newId();
    const at = NOW.toISOString();
    await db.insert(plannedWorkouts).values({
      id, userId: rich.userId, planId: PLAN, sourceWorkoutId: id, title: "Written", category: "yoga", sport: "yoga", originalPlanDate: day(-2), lastVerifiedCorosDate: "", effectiveDate: day(-2), effectiveTime: "19:30",
      sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900, origin: "studio", contentState: "outline", completionState: "scheduled", courseSession: 1,
      workoutDoc: JSON.stringify(studioDoc()), workoutDocRev: 1, createdAt: at, updatedAt: at,
    });
    expect((await read("get_workout", { id })).revisable).toBe(true);
    await db.delete(plannedWorkouts).where(and(eq(plannedWorkouts.id, id), eq(plannedWorkouts.userId, rich.userId)));
  });

  it("another account's course of the same id doesn't make a row a course's: the plan is looked for in the row's own account", async () => {
    const other = await seedOtherAthlete(db);
    const at = NOW.toISOString();
    await db.insert(programs).values({ id: "shared-plan-id", userId: other.userId, kind: "course", name: "Theirs", status: "active", disciplines: ["yoga"], config: {}, createdAt: at, updatedAt: at });
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId: rich.userId, planId: "shared-plan-id", sourceWorkoutId: id, title: "Mine", category: "strength", sport: "strength", originalPlanDate: TODAY, lastVerifiedCorosDate: "", effectiveDate: TODAY, effectiveTime: "06:00",
      sourceContentFingerprint: "program", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900, origin: "program", contentState: "outline", completionState: "scheduled", createdAt: at, updatedAt: at,
    });
    expect((await read("get_workout", { id })).revisable).toEqual(PROGRAMME_WORDS);
    const { header } = await buildDesignContext(db, ENV, rich.userId, { id: "run-open-2", role: "main", scope: { kind: "now" }, request: "Something.", parentId: null }, NOW);
    expect(header.split("\n").find((l) => l.startsWith("Today's plan:"))).toMatch(/06:00 strength[^;]*not revisable \(programme\)/);
    await db.delete(plannedWorkouts).where(eq(plannedWorkouts.id, id));
  });
});
