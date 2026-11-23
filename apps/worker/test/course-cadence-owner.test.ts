/**
 * THE OWNER'S REAL TRE CHANGE, AND WHERE A RHYTHM COUNTS FROM (R1.6 fix round 2; RECHECK.md, FIX2-RULINGS.md). Adopted from the
 * re-check's probes (scratchpad/r1-6-recheck/zz-recheck-r16.test.ts), with the rulings' expectations.
 *
 *  - A course's skip or removal on a weekday it no longer holds is no session of its week: the owner's Fri 27 Nov skip no longer
 *    fills the Monday-only week of 23 Nov, so the clean-up keeps Mon 23 Nov. A done or moved slot still counts.
 *  - With no `from`, a rhythm counts from (a) this week while it still holds one of the plan's sessions to come, else (b) the
 *    week of the plan's latest done session of its own, else (c) the week of its next held day.
 *  - The card names the next two sessions and any placed session the change takes off.
 *
 * Through change_plan and its approve, on a realistic account, on a made-up course (`course-fixture.ts`), under a faked `Date`.
 * Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, courseConfigSchema, newId, type CourseConfig, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import type { Db } from "../src/services/db.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { changePlan, comesOffLine, courseNextLine } from "../src/services/design-tools/change-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import type { PlanChangeOp } from "../src/services/proposal-kinds.js";
import { placeSlots, previewPlacement, slotId } from "../src/services/program-slots.js";
import { isWrite, makeTestDb } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";

const { coachProposals, coachRuns, plannedWorkouts, programs } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[] = [];

async function setup(nowIso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(nowIso));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  const account = await seedRealisticAccount(db);
  userId = account.userId;
  prefs = await loadPreferences(db, userId);
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const env = (): Env => ({ ...makeRealisticEnv(), COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" }) as Env;
const liveRows = async (p: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).filter((r) => r.archivedAt === null);
const live = async (p: string) => (await liveRows(p)).map((r) => `${r.effectiveDate}:${r.completionState}`).sort();
const configOf = async (p: string) => (await db.select().from(programs).where(eq(programs.id, p)))[0]!.config as Record<string, unknown>;
/** 12:00 in Los Angeles on a date. */
const noon = (d: string) => `${d}T20:00:00.000Z`;

async function course(now: string, today: string, config: Partial<CourseConfig> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30", ...config }),
    onEnd: "continue", createdAt: now, updatedAt: now, archivedAt: null,
  });
  await placeSlots(db, userId, id, today, prefs, now);
  return id;
}

async function mainRun(now: string): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Can we change TRE to be like every two weeks please", status: "active",
    state: null, steps: 0, costUsd: 0, createdAt: now, updatedAt: now,
  });
  return { db, env: env(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(now), toolUseId: `toolu_${newId()}` };
}

/** A course session done: written as its number, then completed (what `courseSessionsDone` counts). */
const markDone = (id: string) => db.update(plannedWorkouts).set({ completionState: "completed", origin: "studio", courseSession: 1 }).where(eq(plannedWorkouts.id, id));
const markSkipped = (id: string, resolution: string) =>
  db.update(plannedWorkouts).set({ completionState: "skipped", sanctionedBy: "coach", resolutionDate: resolution }).where(eq(plannedWorkouts.id, id));

/** A change_plan call's op, with the proposal it sits in. */
type Proposed = PlanChangeOp & { proposalId: string };

async function propose(p: string, now: string, input: Record<string, unknown>): Promise<Proposed> {
  const ctx = await mainRun(now);
  const res = await changePlan.run(ctx, { planId: p, why: "Every two weeks, as you asked.", ...input });
  if (isToolErr(res)) throw new Error(`refused ${res.error}: ${res.why}`);
  const proposalId = designProposalId(ctx.run.id);
  const [prop] = await db.select().from(coachProposals).where(eq(coachProposals.id, proposalId));
  return { ...(prop!.ops as PlanChangeOp[])[0]!, proposalId };
}

/** The athlete approves the card; then the hourly pass runs, as it would within the hour. */
async function approve(op: Proposed, now: string, today: string) {
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, op.proposalId));
  const [pending] = await db.select().from(coachProposals).where(eq(coachProposals.id, op.proposalId));
  const ans = await approveDesignOps(db, userId, pending as never, { opIds: [op.id] }, { today, now, prefs }, Number.POSITIVE_INFINITY);
  expect(ans.status, JSON.stringify(ans)).toBe("approved");
  await placeSlots(db, userId, op.planId, today, prefs, now);
}

// ── The owner's state (RECHECK.md, from DEBUG-tre-cadence) ──────────────────────────────────────────────────────────────

const MON16 = "2026-11-16T17:00:00.000Z"; // Mon 16 Nov 09:00 LA
const SUN22 = "2026-11-22T20:00:00.000Z"; // Sun 22 Nov 12:00 LA
const MON23_0800 = "2026-11-23T16:00:00.000Z"; // Mon 23 Nov 08:00 LA

/**
 * TRE on Mondays and Fridays at 19:30: Mon 16 Nov done; Fri 20 Nov moved to Sun 22 Nov, then skipped; Fri 27 Nov, Mon 30 Nov and
 * Fri 4 Dec skipped (the coach's three, agreed on Sun 22 Nov); Mon 23 Nov placed.
 */
async function ownerState(): Promise<string> {
  await setup(MON16);
  const p = await course(MON16, "2026-11-16");
  await markDone(slotId(p, "2026-11-16"));
  await db.update(plannedWorkouts).set({ effectiveDate: "2026-11-22", completionState: "skipped", resolutionDate: "2026-11-22" }).where(eq(plannedWorkouts.id, slotId(p, "2026-11-20")));
  vi.setSystemTime(new Date(SUN22));
  await placeSlots(db, userId, p, "2026-11-22", prefs, SUN22);
  for (const d of ["2026-11-27", "2026-11-30", "2026-12-04"]) await markSkipped(slotId(p, d), "2026-11-22");
  await placeSlots(db, userId, p, "2026-11-22", prefs, SUN22);
  return p;
}

describe("the owner's clean-up, approved on Sun 22 Nov (fix round 2, ruling 1)", () => {
  it("{days: [Mon], everyWeeks: 2, from: 23 Nov}: Mon 23 Nov stays, Mon 7 Dec is next, nothing skipped is listed, and a second pass writes nothing", async () => {
    const p = await ownerState();
    expect((await live(p)).filter((d) => d >= "2026-11-22")).toEqual([
      "2026-11-22:skipped", "2026-11-23:scheduled", "2026-11-27:skipped", "2026-11-30:skipped", "2026-12-04:skipped",
    ]);
    const op = await propose(p, SUN22, { days: ["Mon"], everyWeeks: 2, from: "2026-11-23" });
    expect(op.change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-11-23" });
    // Next: 23 Nov, then 7 Dec. Nothing placed comes off: the Fridays and the 30th are skipped already.
    expect(op.lines).toEqual(["Days Mon · Fri → Mon", "Every week → Every 2 weeks", "Next TRE Mon 23 Nov, then Mon 7 Dec"]);
    await approve(op, SUN22, "2026-11-22");
    expect(await live(p)).toContain("2026-11-23:scheduled");
    expect((await liveRows(p)).filter((r) => r.completionState === "scheduled").map((r) => r.effectiveDate)).toEqual(["2026-11-23"]);
    statements.length = 0;
    expect(await placeSlots(db, userId, p, "2026-11-22", prefs, SUN22)).toEqual({ placed: [], archived: [] });
    expect(statements.filter(isWrite)).toEqual([]);
    // Monday's pass: 7 Dec, the next, comes on; nothing between.
    vi.setSystemTime(new Date(MON23_0800));
    await placeSlots(db, userId, p, "2026-11-23", prefs, MON23_0800);
    expect((await liveRows(p)).filter((r) => r.completionState === "scheduled").map((r) => r.effectiveDate).sort()).toEqual(["2026-11-23", "2026-12-07"]);
  });

  it("the same with no from on the Sunday: it counts from the last done (16 Nov), and the card says Mon 23 Nov comes off", async () => {
    const p = await ownerState();
    const op = await propose(p, SUN22, { days: ["Mon"], everyWeeks: 2 });
    expect(op.change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-11-16" });
    expect(op.lines).toEqual(["Days Mon · Fri → Mon", "Every week → Every 2 weeks", "Next TRE Mon 14 Dec, then Mon 28 Dec", "Comes off: Mon 23 Nov"]);
  });

  it("the same with no from on Monday 23 Nov before the session: 23 Nov, then 7 Dec", async () => {
    const p = await ownerState();
    vi.setSystemTime(new Date(MON23_0800));
    await placeSlots(db, userId, p, "2026-11-23", prefs, MON23_0800);
    const op = await propose(p, MON23_0800, { days: ["Mon"], everyWeeks: 2 });
    expect(op.change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-11-23" });
    expect(op.lines).toContain("Next TRE Mon 23 Nov, then Mon 7 Dec");
    await approve(op, MON23_0800, "2026-11-23");
    expect((await liveRows(p)).filter((r) => r.completionState === "scheduled").map((r) => r.effectiveDate).sort()).toEqual(["2026-11-23", "2026-12-07"]);
  });

  it("with Fri 27 Nov put back first, the clean-up keeps 23 Nov too, and Fri 27 comes off", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16");
    await markDone(slotId(p, "2026-11-16"));
    vi.setSystemTime(new Date(SUN22));
    await placeSlots(db, userId, p, "2026-11-22", prefs, SUN22);
    for (const d of ["2026-11-30", "2026-12-04"]) await markSkipped(slotId(p, d), "2026-11-22");
    const op = await propose(p, SUN22, { days: ["Mon"], everyWeeks: 2, from: "2026-11-23" });
    expect(op.lines).toContain("Comes off: Fri 27 Nov");
    await approve(op, SUN22, "2026-11-22");
    expect((await liveRows(p)).filter((r) => r.completionState === "scheduled" && r.effectiveDate >= "2026-11-22").map((r) => r.effectiveDate)).toEqual(["2026-11-23"]);
  });
});

describe("what still counts toward a course's week (fix round 2, ruling 1)", () => {
  const MON = "2026-10-05";
  const day = (w: number, d: number) => addDays(MON, 7 * w + d);
  const sched = async (p: string) => (await liveRows(p)).filter((r) => r.completionState === "scheduled").map((r) => r.effectiveDate).sort();
  const toFriOnly = (p: string) => db.update(programs).set({ config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [4], time: "19:30", placementWeeksAhead: 1 }) }).where(eq(programs.id, p));

  it("a skip on a dropped day doesn't fill the week: Tuesday's skip leaves Friday's session on", async () => {
    await setup(noon(day(0, 0)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [1, 4], placementWeeksAhead: 1 });
    await markSkipped(slotId(p, day(0, 1)), day(0, 0));
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 0), prefs, noon(day(0, 0)));
    expect(await sched(p)).toEqual([day(0, 4), day(1, 4)]);
  });

  it("so does Thursday's, the day before the one kept: the weekday is read Monday-first", async () => {
    await setup(noon(day(0, 0)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [3, 4], placementWeeksAhead: 1 });
    await markSkipped(slotId(p, day(0, 3)), day(0, 0));
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 0), prefs, noon(day(0, 0)));
    expect(await sched(p)).toEqual([day(0, 4), day(1, 4)]);
  });

  it("a skip on a day it still holds keeps counting: with a session of its own done on Wednesday, the week is full", async () => {
    // Mondays and Fridays; Monday skipped, and a session pointed at the course done on Wednesday (its own id, its number set).
    // Rule 1 as ever: two of two, so Friday's outline comes off. The skip is never overridden.
    await setup(noon(day(0, 0)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [0, 4], placementWeeksAhead: 1 });
    await markSkipped(slotId(p, day(0, 0)), day(0, 0));
    await rowOn(p, day(0, 2), { completionState: "completed", courseSession: 1 });
    const thu = day(0, 3);
    vi.setSystemTime(new Date(noon(thu)));
    await placeSlots(db, userId, p, thu, prefs, noon(thu));
    expect((await sched(p)).filter((d) => d <= day(0, 6))).toEqual([]);
  });

  it("a removed slot on a dropped day doesn't either", async () => {
    await setup(noon(day(0, 0)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [1, 4], placementWeeksAhead: 1 });
    await db.update(plannedWorkouts).set({ archivedAt: noon(day(0, 0)), archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, slotId(p, day(0, 1))));
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 0), prefs, noon(day(0, 0)));
    expect(await sched(p)).toEqual([day(0, 4), day(1, 4)]);
  });

  it("a session done on a dropped day still counts: the athlete did this week's", async () => {
    await setup(noon(day(0, 2)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [1, 4], placementWeeksAhead: 1 });
    await markDone(slotId(p, day(0, 1)));
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 2), prefs, noon(day(0, 2)));
    expect(await sched(p)).toEqual([day(1, 4)]);
  });

  it("today's session on a dropped day, still on the plan, still counts: it stays, and is this week's", async () => {
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [1, 4], placementWeeksAhead: 1 });
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 1), prefs, noon(day(0, 1)));
    expect(await sched(p)).toEqual([day(0, 1), day(1, 4)]);
  });

  it("a programme's skip still counts wherever it is: its days are preferences, and it falls back on the week's others", async () => {
    await setup(noon(day(0, 0)));
    const id = newId();
    await db.insert(programs).values({
      id, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 1, preferredDays: [1], placementWeeksAhead: 1 }), createdAt: noon(day(0, 0)), updatedAt: noon(day(0, 0)), archivedAt: null,
    });
    await placeSlots(db, userId, id, day(0, 0), prefs, noon(day(0, 0)));
    await markSkipped(slotId(id, day(1, 1)), day(0, 0));
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 1, preferredDays: [3], placementWeeksAhead: 1 }) }).where(eq(programs.id, id));
    await placeSlots(db, userId, id, day(0, 0), prefs, noon(day(0, 0)));
    expect(await sched(id)).toEqual([day(0, 3)]);
  });

  it("a slot moved off a dropped day still counts, skipped since or not: the athlete chose that day", async () => {
    await setup(noon(day(0, 0)));
    const p = await course(noon(day(0, 0)), day(0, 0), { weekdays: [1, 4], placementWeeksAhead: 1 });
    await db.update(plannedWorkouts).set({ effectiveDate: day(0, 2), completionState: "skipped", resolutionDate: day(0, 0) }).where(eq(plannedWorkouts.id, slotId(p, day(0, 1))));
    await toFriOnly(p);
    await placeSlots(db, userId, p, day(0, 0), prefs, noon(day(0, 0)));
    expect(await sched(p)).toEqual([day(1, 4)]);
  });
});

// ── Where a new rhythm counts from with no `from` (fix round 2, ruling 2) ─────────────────────────────────────────────────

describe("the default anchor, through change_plan and its approve", () => {
  it("(a) Mon 23 Nov 08:00, today's session to do, last done 16 Nov: 23 Nov, then 7 Dec", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0] });
    await markDone(slotId(p, "2026-11-16"));
    vi.setSystemTime(new Date(MON23_0800));
    await placeSlots(db, userId, p, "2026-11-23", prefs, MON23_0800);
    const op = await propose(p, MON23_0800, { everyWeeks: 2 });
    expect(op.change).toEqual({ everyWeeks: 2, cadenceFrom: "2026-11-23" });
    await approve(op, MON23_0800, "2026-11-23");
    expect((await live(p)).filter((d) => d >= "2026-11-23")).toEqual(["2026-11-23:scheduled", "2026-12-07:scheduled"]);
  });

  it("(b) every 2 → every 3 on 9 Dec, 7 Dec done: the next is 28 Dec, three weeks after it", async () => {
    const dec7 = "2026-12-07";
    const dec9 = "2026-12-09";
    await setup(noon(dec7));
    const p = await course(noon(dec7), dec7, { weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-11-23" });
    await markDone(slotId(p, dec7));
    vi.setSystemTime(new Date(noon(dec9)));
    const op = await propose(p, noon(dec9), { everyWeeks: 3 });
    expect(op.change).toEqual({ everyWeeks: 3, cadenceFrom: dec7 });
    await approve(op, noon(dec9), dec9);
    expect((await live(p)).filter((d) => d > dec9)).toEqual(["2026-12-28:scheduled"]);
  });

  it("(c) nothing done, asked on Sun 22 Nov: 23 Nov, then 7 Dec", async () => {
    await setup(SUN22);
    const p = await course(SUN22, "2026-11-22", { weekdays: [0] });
    const op = await propose(p, SUN22, { everyWeeks: 2 });
    expect(op.change).toEqual({ everyWeeks: 2, cadenceFrom: "2026-11-23" });
    expect(op.lines).toEqual(["Every week → Every 2 weeks", "Next TRE Mon 23 Nov, then Mon 7 Dec", "Comes off: Mon 30 Nov"]);
    await approve(op, SUN22, "2026-11-22");
    expect((await live(p)).filter((d) => d >= "2026-11-22")).toEqual(["2026-11-23:scheduled"]);
  });
});

/**
 * The anchor each of the plan's two editors would store, from the same rows: change_plan's card (stored nowhere), then
 * PATCH /api/plans/:id's write.
 */
async function anchors(p: string, now: string, today: string, everyWeeks: number, weekdays?: number[]): Promise<[unknown, unknown]> {
  const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const op = await propose(p, now, { everyWeeks, ...(weekdays ? { days: weekdays.map((d) => DAY[d]) } : {}) });
  expect((await applyPlanPatch(db, userId, p, { everyWeeks, ...(weekdays ? { weekdays } : {}) }, now, today)).ok).toBe(true);
  return [op.change.cadenceFrom, (await configOf(p)).cadenceFrom];
}

/** A row under the plan that isn't a slot: a course session written on `date`, or (`courseSession` null) a coach-filed workout. */
async function rowOn(p: string, date: string, set: { completionState: string; courseSession: number | null; archivedAt?: string }) {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: p, sourceWorkoutId: id, title: "Extra", category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "19:30", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
    origin: "studio", contentState: "outline", createdAt: noon(date), updatedAt: noon(date), ...set,
  });
}

describe("the default anchor, the same through change_plan and PATCH /api/plans/:id", () => {
  it("(a) asked on Mon 23 Nov at 20:00, today's still to do (the UTC day is already Tuesday): this week", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0] });
    await markDone(slotId(p, "2026-11-16"));
    const late = "2026-11-24T04:00:00.000Z";
    vi.setSystemTime(new Date(late));
    await placeSlots(db, userId, p, "2026-11-23", prefs, late);
    expect(await anchors(p, late, "2026-11-23", 2)).toEqual(["2026-11-23", "2026-11-23"]);
  });

  it("(a) a session skipped this week isn't one to come, nor are next week's: it counts from the last done", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0, 3] });
    await markDone(slotId(p, "2026-11-16"));
    const wed = "2026-11-25";
    vi.setSystemTime(new Date(noon(wed)));
    await placeSlots(db, userId, p, wed, prefs, noon(wed));
    await markSkipped(slotId(p, "2026-11-26"), wed);
    await markSkipped(slotId(p, "2026-11-23"), wed);
    expect((await live(p)).filter((d) => d > wed)).toContain("2026-11-30:scheduled");
    expect(await anchors(p, noon(wed), wed, 2)).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(a) nor is one removed, or one left on a day gone by: it counts from the last done", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0, 3] });
    await markDone(slotId(p, "2026-11-16"));
    const fri = "2026-11-27";
    vi.setSystemTime(new Date(noon(fri)));
    await placeSlots(db, userId, p, fri, prefs, noon(fri));
    // Monday's never marked, still on the plan; Thursday's removed; and a session written for Saturday, removed.
    await db.update(plannedWorkouts).set({ archivedAt: noon(fri), archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, slotId(p, "2026-11-26")));
    await rowOn(p, "2026-11-28", { completionState: "scheduled", courseSession: 2, archivedAt: noon(fri) });
    expect(await anchors(p, noon(fri), fri, 2)).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(a) nor is yesterday's left unmarked, asked at noon the next day: it counts from the last done", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0, 3] });
    await markDone(slotId(p, "2026-11-16"));
    const tue = "2026-11-24";
    vi.setSystemTime(new Date(noon(tue)));
    await placeSlots(db, userId, p, tue, prefs, noon(tue));
    await markSkipped(slotId(p, "2026-11-26"), tue);
    expect((await live(p)).filter((d) => d.startsWith("2026-11-23"))).toEqual(["2026-11-23:scheduled"]);
    expect(await anchors(p, noon(tue), tue, 2)).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(a) a workout the coach filed under the plan, to come this week, isn't one of its sessions", async () => {
    const wed = "2026-10-07";
    await setup(noon(wed));
    const p = await course(noon(wed), wed, { weekdays: [0] });
    await rowOn(p, "2026-10-09", { completionState: "scheduled", courseSession: null });
    // Nothing of its own to come this week (Monday's gone) and none done: (c), the week of its next Monday.
    expect(await anchors(p, noon(wed), wed, 2)).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("(a) a Sunday's session, asked on the Monday before it: this week, not the week of the last done", async () => {
    const SUN15 = "2026-11-15";
    await setup(noon(SUN15));
    const p = await course(noon(SUN15), SUN15, { weekdays: [6] });
    await markDone(slotId(p, SUN15));
    const mon = "2026-11-16";
    vi.setSystemTime(new Date(noon(mon)));
    await placeSlots(db, userId, p, mon, prefs, noon(mon));
    expect(await anchors(p, noon(mon), mon, 2)).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(b) the owner's state on the Sunday: the last done of its own sessions, never a skip", async () => {
    const p = await ownerState();
    expect(await anchors(p, SUN22, "2026-11-22", 2, [0])).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(b) a session written, then skipped, isn't one done (RECHECK X3, X4)", async () => {
    await setup(MON16);
    const p = await course(MON16, "2026-11-16", { weekdays: [0] });
    await markDone(slotId(p, "2026-11-16"));
    await db.update(plannedWorkouts).set({ origin: "studio", courseSession: 2, completionState: "skipped", resolutionDate: "2026-11-23" }).where(eq(plannedWorkouts.id, slotId(p, "2026-11-23")));
    const wed = "2026-11-25";
    vi.setSystemTime(new Date(noon(wed)));
    expect(await anchors(p, noon(wed), wed, 2)).toEqual(["2026-11-16", "2026-11-16"]);
  });

  it("(b) a workout the coach filed under the plan, done, isn't one of its sessions (RECHECK MINOR 3)", async () => {
    const wed = "2026-10-07";
    await setup(noon(wed));
    const p = await course(noon(wed), wed, { weekdays: [0] });
    await rowOn(p, "2026-10-01", { completionState: "completed", courseSession: null });
    // Nothing of its own done, nothing to come this week (Monday's gone): (c), the week of its next Monday.
    expect(await anchors(p, noon(wed), wed, 2)).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("(c) nothing done, asked on Sun 22 Nov: the week of its next day, so 23 Nov", async () => {
    await setup(SUN22);
    const p = await course(SUN22, "2026-11-22", { weekdays: [0] });
    expect(await anchors(p, SUN22, "2026-11-22", 2)).toEqual(["2026-11-23", "2026-11-23"]);
  });

  it("(c) by the days it will have: Mondays made Fridays on a Wednesday, this week's Friday", async () => {
    const wed = "2026-11-25";
    await setup(noon(wed));
    const p = await course(noon(wed), wed, { weekdays: [0] });
    expect(await anchors(p, noon(wed), wed, 2, [4])).toEqual(["2026-11-23", "2026-11-23"]);
  });
});

// ── The card's lines (fix round 2, ruling 4) and the preview's dates ───────────────────────────────────────────────────

describe("the card says the next two and what comes off", () => {
  const MON = "2026-11-23";
  const day = (w: number, d: number) => addDays(MON, 7 * w + d);

  it("past three coming off, the rest are counted", async () => {
    await setup(noon(MON));
    const p = await course(noon(MON), MON, { weekdays: [0, 2, 4] });
    const op = await propose(p, noon(MON), { days: ["Mon"], everyWeeks: 2 });
    expect(op.lines).toContain(`Comes off: Wed 25 Nov · Fri 27 Nov · Mon 30 Nov +4 more`);
  });

  it("the next two are in date order, a far outline kept from a wider window among them", async () => {
    // Every 4 weeks from 23 Nov, placed on Tue 24 Nov: only 21 Dec is ahead. Paused through Sun 13 Dec, made weekly: the far
    // 21 Dec stays (past the new two-week window, still wanted), and 14 Dec, the first past the pause, comes before it.
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [0], everyWeeks: 4, cadenceFrom: MON });
    expect((await live(p)).filter((d) => d > day(0, 1))).toEqual([`${day(4, 0)}:scheduled`]);
    await db.update(programs).set({ pausedUntil: day(2, 6) }).where(eq(programs.id, p));
    const op = await propose(p, noon(day(0, 1)), { everyWeeks: 1 });
    expect(op.lines).toContain(`Next TRE Mon 14 Dec, then Mon 21 Dec`);
  });

  it("the preview's dates past its window never repeat one it already holds", async () => {
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [0], everyWeeks: 4, cadenceFrom: MON });
    const program = { id: p, kind: "course" as const, status: "active", disciplines: ["yoga"], pausedUntil: null };
    const config = courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30", everyWeeks: 2, cadenceFrom: MON });
    const preview = await previewPlacement(db, userId, program, config, day(0, 1), prefs, noon(day(0, 1)));
    expect(preview.after).toEqual([day(2, 0), day(4, 0)]);
    expect(preview.beyond).toEqual([day(6, 0), day(8, 0), day(10, 0)]);
    expect(preview.off).toEqual([]);
  });

  it("a session the athlete moved onto a day past the window is named once", async () => {
    // Every 2 weeks from 23 Nov, placed on Tue 24 Nov: 7 Dec. The athlete moves it to Mon 21 Dec, the next on-week's day,
    // past the window. A new time: next 21 Dec (his), then 4 Jan — not 21 Dec twice.
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [0], everyWeeks: 2, cadenceFrom: MON });
    await db.update(plannedWorkouts).set({ effectiveDate: day(4, 0) }).where(eq(plannedWorkouts.id, slotId(p, day(2, 0))));
    const op = await propose(p, noon(day(0, 1)), { time: "07:30" });
    expect(op.lines).toEqual(["Time 19:30 → 07:30", "Next TRE Mon 21 Dec, then Mon 4 Jan"]);
  });

  it("a day the athlete skipped ahead isn't a next session, past the window too", async () => {
    // Mondays, four weeks ahead, placed on Tue 24 Nov; 21 Dec skipped ahead; the window made two weeks. Every 2 weeks from 23 Nov:
    // 7 Dec, then not the skipped 21 Dec but 4 Jan; 30 Nov and 14 Dec come off.
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [0], placementWeeksAhead: 4 });
    await markSkipped(slotId(p, day(4, 0)), day(0, 1));
    await db.update(programs).set({ config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30" }) }).where(eq(programs.id, p));
    const op = await propose(p, noon(day(0, 1)), { everyWeeks: 2, from: MON });
    expect(op.lines).toEqual(["Every week → Every 2 weeks", "Next TRE Mon 7 Dec, then Mon 4 Jan", "Comes off: Mon 30 Nov · Mon 14 Dec"]);
  });

  it("a day placement took off itself is free again, past the window too", async () => {
    // Every 2 weeks from 23 Nov, four weeks ahead: 30 Nov and 14 Dec retracted. The window made two weeks, the rhythm moved a
    // week on: 30 Nov comes back, and 14 Dec, past the window, is the next after it.
    await setup(noon(day(0, 1)));
    const p = await course(noon(day(0, 1)), day(0, 1), { weekdays: [0], placementWeeksAhead: 4 });
    expect((await applyPlanPatch(db, userId, p, { everyWeeks: 2, cadenceFrom: MON }, noon(day(0, 1)), day(0, 1))).ok).toBe(true);
    await placeSlots(db, userId, p, day(0, 1), prefs, noon(day(0, 1)));
    expect((await live(p)).filter((d) => d > day(0, 1))).toEqual([`${day(2, 0)}:scheduled`, `${day(4, 0)}:scheduled`]);
    await db.update(programs).set({ config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30", everyWeeks: 2, cadenceFrom: MON }) }).where(eq(programs.id, p));
    const op = await propose(p, noon(day(0, 1)), { everyWeeks: 2, from: day(1, 0) });
    expect(op.lines).toEqual(["Every 2 weeks, counted from Mon 30 Nov", "Next TRE Mon 30 Nov, then Mon 14 Dec", "Comes off: Mon 7 Dec · Mon 21 Dec"]);
  });
});

describe("the card's lines, as words", () => {
  it("Next: the first two, or the one; none, no line", () => {
    expect(courseNextLine("TRE", ["2026-11-23", "2026-12-07", "2026-12-21"])).toBe("Next TRE Mon 23 Nov, then Mon 7 Dec");
    expect(courseNextLine("TRE", ["2026-11-23"])).toBe("Next TRE Mon 23 Nov");
    expect(courseNextLine("TRE", [])).toBeNull();
  });
  it("Comes off: three by name, the rest counted; none, no line", () => {
    expect(comesOffLine(["2026-11-30"])).toBe("Comes off: Mon 30 Nov");
    expect(comesOffLine(["2026-11-25", "2026-11-27", "2026-11-30"])).toBe("Comes off: Wed 25 Nov · Fri 27 Nov · Mon 30 Nov");
    expect(comesOffLine(["2026-11-25", "2026-11-27", "2026-11-30", "2026-12-02"])).toBe("Comes off: Wed 25 Nov · Fri 27 Nov · Mon 30 Nov +1 more");
    expect(comesOffLine([])).toBeNull();
  });
});
