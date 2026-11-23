/**
 * THE CARD NAMES EACH HELD-BACK DATE AND ITS REASON, THE MODEL IS TOLD THE SAME, AND A COURSE'S QUIET DAYS ARE SETTABLE
 * (R1.7; r1-7/BRIEF.md "Build" 1–3).
 *
 * On 23 Nov the owner asked for TRE every 2 weeks on Mondays, from today. The card read "Next TRE Mon 23 Nov, then Mon 21 Dec"
 * and nothing said why 7 Dec was missing: the race's quiet days (a 10K time trial, Sat 12 Dec). Here the same change runs
 * through change_plan on a course a race holds back (the made-up course of `course-fixture.ts`, as R1.6 read every course)
 * and on the real TRE, which R1.7 doesn't hold back:
 *  - the card says "Not Mon 7 Dec: the week before your 10K time trial is kept quiet" (a pause: "TRE is paused until …"),
 *    at most two such lines, then "+N more"; Next stays the next real sessions;
 *  - the tool's result carries each held-back date with its reason code and the card's words;
 *  - `quietDaysBeforeRace` (0–21) changes through change_plan on a course a race holds back, and the card says the change
 *    ("Quiet before a race: 7 days → none"); a calm course or a programme is refused, in words.
 *
 * Under a faked `Date` on fixed days; synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, courseConfigSchema, newId, type CourseConfig, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { changePlan } from "../src/services/design-tools/change-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import type { PlanChangeOp } from "../src/services/proposal-kinds.js";
import { placeSlots } from "../src/services/program-slots.js";
import { planRoutes } from "../src/routes/plans.js";
import { conversationBlock, conversationRows, namedConversationSql } from "../src/services/coach-conversation.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";

const { athleteProfiles, coachProposals, coachRuns, plannedWorkouts, programs } = schema;

const RACE = "2026-12-12";
const MON23 = "2026-11-23";
/** Mon 23 Nov, 09:00 in Los Angeles. */
const NOW = "2026-11-23T17:00:00.000Z";

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { raceDate: RACE }));
});
afterEach(() => vi.useRealTimers());

/** The athlete's race, as their profile's events name it. */
const nameTheRace = (label: string, start = RACE) =>
  db.insert(athleteProfiles).values({ id: userId, userId, events: [{ id: "ev1", label, kind: "race", start, priority: "A", taper: true }], updatedAt: NOW });

async function seedCourse(course: string, config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course, weekdays: [0, 4], time: "19:30", ...config }), onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  });
  await placeSlots(db, userId, id, MON23, prefs, NOW);
  return id;
}

async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "TRE every 2 weeks on Mondays, from today", status: "active",
    state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW,
  });
  return { db, env: {} as Env, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(NOW), toolUseId: `toolu_${newId()}` };
}

async function call(p: string, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; op?: PlanChangeOp & { proposalId: string }; runId: string }> {
  const ctx = await mainRun();
  const res = await changePlan.run(ctx, { planId: p, why: "Every two weeks, as you asked.", ...input });
  if (isToolErr(res)) return { res, runId: ctx.run.id };
  const proposalId = designProposalId(ctx.run.id);
  const [prop] = await db.select().from(coachProposals).where(eq(coachProposals.id, proposalId));
  return { res, op: { ...(prop!.ops as PlanChangeOp[])[0]!, proposalId }, runId: ctx.run.id };
}
const ok = async (p: string, input: Record<string, unknown>) => {
  const { res, op, runId } = await call(p, input);
  if (isToolErr(res)) throw new Error(`refused ${res.error}: ${res.why}`);
  return { data: res.data as Record<string, unknown>, op: op!, runId };
};
const refused = async (p: string, input: Record<string, unknown>) => {
  const { res } = await call(p, input);
  if (!isToolErr(res)) throw new Error("not refused");
  return res;
};

const TODAYS_ASK = { days: ["Mon"], everyWeeks: 2, from: MON23 };

describe("the card names each held-back date and its reason", () => {
  it("today's exchange, on a course a race holds back: Next 23 Nov then 21 Dec, and 'Not Mon 7 Dec: …' says why", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id);
    const { op } = await ok(p, TODAYS_ASK);
    expect(op.lines).toEqual([
      "Days Mon · Fri → Mon",
      "Every week → Every 2 weeks",
      "Next TRE Mon 23 Nov, then Mon 21 Dec",
      "Not Mon 7 Dec: the week before your 10K time trial is kept quiet",
      "Taken off: Fri 27 Nov · Mon 30 Nov · Fri 4 Dec",
    ]);
    // The card's computed lines, kept apart for the approve's recheck (m1).
    expect(op.preview).toEqual(op.lines.slice(2));
  });

  it("the real TRE (calm): Next 23 Nov, then 7 Dec, and nothing held back", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse("tre");
    const { op, data } = await ok(p, TODAYS_ASK);
    expect(op.lines).toContain("Next TRE Mon 23 Nov, then Mon 7 Dec");
    expect(op.lines.some((l) => l.startsWith("Not "))).toBe(false);
    expect(data.heldBack).toBeUndefined();
  });

  it("the race's name: its race session's title when the events don't name it, else 'your race'", async () => {
    const p = await seedCourse(INTRO_COURSE.id);
    expect((await ok(p, TODAYS_ASK)).op.lines).toContain("Not Mon 7 Dec: the week before your race is kept quiet");
    const race = `race-${newId()}`;
    await db.insert(plannedWorkouts).values({
      id: race, userId, planId: "loose", sourceWorkoutId: race, title: "Hackney 10K", category: "race", sport: "run", originalPlanDate: RACE, lastVerifiedCorosDate: "",
      effectiveDate: RACE, effectiveTime: "09:00", sourceContentFingerprint: "x", fallbackEstimatedDurationSeconds: 3000, calendarBlockDurationSeconds: 3000,
      origin: "coros", contentState: "outline", completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
    });
    expect((await ok(p, TODAYS_ASK)).op.lines).toContain("Not Mon 7 Dec: the week before your Hackney 10K is kept quiet");
    // An event of another kind, or a race on another day, names nothing: the session's title stands.
    await db.insert(athleteProfiles).values({
      id: userId, userId, updatedAt: NOW,
      events: [{ id: "e1", label: "Lisbon", kind: "trip", start: RACE, priority: "B", taper: false }, { id: "e2", label: "Spring half", kind: "race", start: "2027-04-04", priority: "A", taper: true }],
    });
    expect((await ok(p, TODAYS_ASK)).op.lines).toContain("Not Mon 7 Dec: the week before your Hackney 10K is kept quiet");
  });

  it("a pause: 'Not Mon 7 Dec: TRE is paused until Thu 10 Dec'", async () => {
    const p = await seedCourse("tre", {}, { pausedUntil: "2026-12-10" });
    const { op } = await ok(p, { ...TODAYS_ASK, from: "2026-12-07" });
    expect(op.lines).toContain("Not Mon 7 Dec: TRE is paused until Thu 10 Dec");
    // Next stays the next real sessions.
    expect(op.lines).toContain("Next TRE Mon 21 Dec, then Mon 4 Jan");
  });

  it("at most two such lines, then '+N more'", async () => {
    await nameTheRace("10K time trial");
    // Every weekday: Mon 7 – Fri 11 Dec are quiet, and Sat 12 Dec isn't one of its days.
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0, 1, 2, 3, 4], placementWeeksAhead: 3 });
    const { op } = await ok(p, { time: "07:30" });
    expect(op.lines.filter((l) => l.startsWith("Not ") || l.startsWith("+"))).toEqual([
      "Not Mon 7 Dec: the week before your 10K time trial is kept quiet",
      "Not Tue 8 Dec: the week before your 10K time trial is kept quiet",
      "+3 more",
    ]);
  });

  it("race day: 'Not Sat 12 Dec: it's the day of your 10K time trial', even for TRE", async () => {
    await nameTheRace("The 10K time trial");
    const p = await seedCourse("tre", { weekdays: [5], placementWeeksAhead: 3 });
    const { op } = await ok(p, { time: "08:00" });
    expect(op.lines).toContain("Not Sat 12 Dec: it's the day of your 10K time trial");
  });

  it("quiet days of another length say so: 'the 10 days before …', 'the two weeks before …'", async () => {
    await nameTheRace("10K time trial");
    const ten = await seedCourse(INTRO_COURSE.id, { weekdays: [0], quietDaysBeforeRace: 10, placementWeeksAhead: 3 });
    expect((await ok(ten, { time: "07:30" })).op.lines).toContain("Not Mon 7 Dec: the 10 days before your 10K time trial are kept quiet");
    const fortnight = await seedCourse(INTRO_COURSE.id, { weekdays: [0], quietDaysBeforeRace: 14, placementWeeksAhead: 3 });
    expect((await ok(fortnight, { time: "07:30" })).op.lines).toContain("Not Mon 30 Nov: the two weeks before your 10K time trial are kept quiet");
  });
});

describe("the model is told the same truth", () => {
  it("change_plan's result carries each held-back date, its reason code and the card's words", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id);
    const { data } = await ok(p, TODAYS_ASK);
    expect(data.heldBack).toEqual([{ date: "2026-12-07", reason: "race_quiet", line: "Not Mon 7 Dec: the week before your 10K time trial is kept quiet" }]);
    expect(data.lines).toContain("Not Mon 7 Dec: the week before your 10K time trial is kept quiet");
    expect(data.heldBackMore).toBeUndefined();
  });

  it("a later turn sees what the card said: its lines, in the conversation block", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id);
    const { runId, op } = await ok(p, TODAYS_ASK);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, op.proposalId));
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, runId));
    const block = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, runId), { limit: 6 }), new Date(NOW))!;
    expect(block).toContain(
      `    The card's lines: ${markUntrusted("main coach", "Days Mon · Fri → Mon; Every week → Every 2 weeks; Next TRE Mon 23 Nov, then Mon 21 Dec; Not Mon 7 Dec: the week before your 10K time trial is kept quiet; Taken off: Fri 27 Nov · Mon 30 Nov · Fri 4 Dec")}`,
    );
  });

  it("past six, the rest are counted", async () => {
    // Every day but Saturday, paused through Thu 3 Dec: ten dates paused (23–27 and 29 Nov – 3 Dec), then the race's quiet days
    // hold Sun 6 and Mon 7 – Fri 11 Dec: sixteen, the first six told (all paused), ten counted.
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0, 1, 2, 3, 4, 6], placementWeeksAhead: 1 }, { pausedUntil: "2026-12-03" });
    const { data } = await ok(p, { time: "07:30" });
    const told = data.heldBack as Array<{ date: string; reason: string }>;
    expect(told.map((h) => h.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-29"]);
    expect(told.every((h) => h.reason === "paused")).toBe(true);
    expect(data.heldBackMore).toBe(10);
  });
});

describe("a course's quiet days, through change_plan", () => {
  it("none on a course a race holds back: 'Quiet before a race: 7 days → none', and 7 Dec comes back on approval", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], everyWeeks: 2, cadenceFrom: MON23 });
    const { op } = await ok(p, { quietDaysBeforeRace: 0, why: "TRE doesn't tire you: no need to keep it off race week." });
    expect(op.change).toEqual({ quietDaysBeforeRace: 0 });
    expect(op.base).toEqual({ quietDaysBeforeRace: 7 });
    expect(op.title).toBe("TRE: new quiet days");
    expect(op.lines).toEqual(["Quiet before a race: 7 days → none", "Next TRE Mon 23 Nov, then Mon 7 Dec"]);

    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, op.proposalId));
    const [pending] = await db.select().from(coachProposals).where(eq(coachProposals.id, op.proposalId));
    const ans = await approveDesignOps(db, userId, pending as never, { opIds: [op.id] }, { today: MON23, now: NOW, prefs }, Number.POSITIVE_INFINITY);
    expect(ans.status, JSON.stringify(ans)).toBe("approved");
    const [row] = await db.select().from(programs).where(eq(programs.id, p));
    expect(row!.config).toMatchObject({ quietDaysBeforeRace: 0 });
    // Placed in the approve's own request: 7 Dec is on.
    const live = await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, p), isNull(plannedWorkouts.archivedAt)));
    expect(live.map((r) => r.effectiveDate).sort()).toEqual([MON23, "2026-12-07"]);
  });

  it("a longer window: 'Quiet before a race: 7 days → 10 days', and the card says what it holds back", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 3 });
    const { op } = await ok(p, { quietDaysBeforeRace: 10 });
    expect(op.lines.slice(0, 2)).toEqual(["Quiet before a race: 7 days → 10 days", "Next TRE Mon 23 Nov, then Mon 30 Nov"]);
    expect(op.lines).toContain("Not Mon 7 Dec: the 10 days before your 10K time trial are kept quiet");
  });

  it("one day: 'Quiet before a race: 7 days → 1 day'", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0] });
    expect((await ok(p, { quietDaysBeforeRace: 1 })).op.lines[0]).toBe("Quiet before a race: 7 days → 1 day");
  });

  it("out of 0–21: refused before anything is read", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0] });
    for (const n of [22, -1]) {
      const r = await refused(p, { quietDaysBeforeRace: n });
      expect(r.error).toBe("invalid_input");
      expect(r.why).toBe("quietDaysBeforeRace: 0 to 21 days");
    }
  });

  it("on a calm course: refused, saying a race doesn't hold it back, and how to keep it off race week", async () => {
    const p = await seedCourse("tre", { weekdays: [0] });
    const r = await refused(p, { quietDaysBeforeRace: 7 });
    expect(r).toEqual({
      error: "invalid_input",
      why: "quietDaysBeforeRace: TRE isn't held back before a race: its sessions carry no training load",
      fix: "Leave quietDaysBeforeRace out. To keep it off race week, pause it (pausedUntil).",
    });
  });

  it("on a programme: refused", async () => {
    const id = newId();
    await db.insert(programs).values({
      id, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    const r = await refused(id, { quietDaysBeforeRace: 3 });
    expect(r.error).toBe("invalid_input");
    expect(r.why).toBe("quietDaysBeforeRace: quiet days before a race are set on a course alone");
  });

  it("the same quiet days: no_change", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0] });
    const r = await refused(p, { quietDaysBeforeRace: 7 });
    expect(r.error).toBe("no_change");
    expect(r.why).toBe("TRE already has those quiet days.");
  });
});

// ── m1 (r1-6/FOLLOWUPS.md 1): an approve builds the card's dates again; changed, it asks once more ──────────────────────────

/** The athlete taps Approve on the card, at `now` on `today`. */
async function approveCard(op: PlanChangeOp & { proposalId: string }, today: string, now: string) {
  await db.update(coachProposals).set({ status: "pending" }).where(and(eq(coachProposals.id, op.proposalId), eq(coachProposals.status, "unreviewed")));
  const [pending] = await db.select().from(coachProposals).where(eq(coachProposals.id, op.proposalId));
  return approveDesignOps(db, userId, pending as never, { opIds: [op.id] }, { today, now, prefs: await loadPreferences(db, userId) }, Number.POSITIVE_INFINITY);
}
const opNow = async (op: PlanChangeOp & { proposalId: string }) => {
  const [prop] = await db.select().from(coachProposals).where(eq(coachProposals.id, op.proposalId));
  return (prop!.ops as PlanChangeOp[]).find((o) => o.id === op.id)! as PlanChangeOp & { outcome?: { status: string } };
};
const timeOf = async (p: string) => ((await db.select().from(programs).where(eq(programs.id, p)))[0]!.config as { time: string }).time;

describe("an approve builds the card's dates again (m1)", () => {
  it("the race moved since: nothing is applied, the card shows the new dates, and the next approve applies them", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 3 });
    const { op } = await ok(p, { time: "07:30" });
    expect(op.preview).toEqual(["Next TRE Mon 23 Nov, then Mon 30 Nov", "Not Mon 7 Dec: the week before your 10K time trial is kept quiet"]);
    // The race is moved a week on before the athlete approves.
    await savePreferences(db, userId, { ...prefs, raceDate: "2026-12-19" });
    await db.update(athleteProfiles).set({ events: [{ id: "ev1", label: "10K time trial", kind: "race", start: "2026-12-19", priority: "A", taper: true }] }).where(eq(athleteProfiles.userId, userId));

    const first = await approveCard(op, MON23, NOW);
    expect(first.status).toBe("pending");
    // 14 Dec, placed while the race was the 12th, now falls in its quiet days: approving would take it off, and the card says so.
    const nowLines = ["Next TRE Mon 23 Nov, then Mon 30 Nov", "Not Mon 14 Dec: the week before your 10K time trial is kept quiet", "Taken off: Mon 14 Dec"];
    expect(first.refreshed).toEqual([{ opId: op.id, lines: ["Time 19:30 → 07:30", ...nowLines] }]);
    expect(first.refused).toEqual([]);
    expect(await timeOf(p)).toBe("19:30");
    const shown = await opNow(op);
    expect(shown.lines).toEqual(first.refreshed![0]!.lines);
    expect(shown.preview).toEqual(nowLines);
    expect(shown.outcome).toBeUndefined();

    const second = await approveCard(op, MON23, NOW);
    expect(second.status).toBe("approved");
    expect(second.refreshed).toBeUndefined();
    expect(await timeOf(p)).toBe("07:30");
  });

  it("a day later, after a session was done: the next sessions are said again", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 3 });
    const { op } = await ok(p, { time: "07:30" });
    // Mon 23 Nov's session is done; the athlete approves on Tuesday.
    await db.update(plannedWorkouts).set({ completionState: "completed", origin: "studio", courseSession: 1 }).where(and(eq(plannedWorkouts.planId, p), eq(plannedWorkouts.effectiveDate, MON23)));
    const tue = "2026-11-24T17:00:00.000Z";
    vi.setSystemTime(new Date(tue));
    const first = await approveCard(op, "2026-11-24", tue);
    expect(first.refreshed?.[0]?.lines).toContain("Next TRE Mon 30 Nov, then Mon 14 Dec");
    expect(await timeOf(p)).toBe("19:30");
    expect((await approveCard(op, "2026-11-24", tue)).status).toBe("approved");
  });

  it("nothing moved: applied at the first approve, as before", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 3 });
    const { op } = await ok(p, { time: "07:30" });
    const ans = await approveCard(op, MON23, NOW);
    expect(ans.status).toBe("approved");
    expect(ans.refreshed).toBeUndefined();
  });

  it("a card stored before R1.7 (no preview, the old words): its dates are said again in today's words, then applied", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0, 4], placementWeeksAhead: 2 });
    const { op } = await ok(p, TODAYS_ASK);
    const old = { ...op, lines: op.lines.map((l) => l.replace("Taken off:", "Comes off:")) } as PlanChangeOp & { preview?: string[] };
    delete old.preview;
    const { proposalId: _p, ...stored } = old as PlanChangeOp & { proposalId: string };
    await db.update(coachProposals).set({ ops: [stored] }).where(eq(coachProposals.id, op.proposalId));
    const first = await approveCard(op, MON23, NOW);
    expect(first.refreshed?.[0]?.lines).toEqual(op.lines);
    expect((await approveCard(op, MON23, NOW)).status).toBe("approved");
  });

  it("a card stored before R1.7 whose dates still read the same: applied at once", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 3 }, {});
    await db.update(programs).set({ config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30", placementWeeksAhead: 3, quietDaysBeforeRace: 0 }) }).where(eq(programs.id, p));
    const { op } = await ok(p, { time: "07:30" });
    expect(op.preview).toEqual(["Next TRE Mon 23 Nov, then Mon 30 Nov"]);
    const { proposalId: _p, preview: _v, ...stored } = op;
    await db.update(coachProposals).set({ ops: [stored] }).where(eq(coachProposals.id, op.proposalId));
    expect((await approveCard(op, MON23, NOW)).status).toBe("approved");
  });
});

// ── PATCH /api/plans/:id: the same setting, and the held-back dates in its answer ─────────────────────────────────────────

const routeEnv = (): Env =>
  ({
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret", TOKEN_ENCRYPTION_KEY: "test-token-encryption-key", ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret",
  }) as Env;

async function patch(p: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const res = await mountRoutes(db, "/api/plans", planRoutes).request(`/api/plans/${p}`, { method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }, routeEnv());
  const text = await res.text();
  if (res.status >= 500) throw new Error(`${res.status}: ${text}`);
  return { status: res.status, json: JSON.parse(text) as Record<string, any> };
}

describe("PATCH /api/plans/:id", () => {
  it("a new time on a course a race holds back answers the dates held back, with the reason code and the card's words", async () => {
    await nameTheRace("10K time trial");
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], everyWeeks: 2, cadenceFrom: MON23 });
    const { status, json } = await patch(p, { time: "07:30" });
    expect(status).toBe(200);
    expect(json.heldBack).toEqual([{ date: "2026-12-07", reason: "race_quiet", line: "Not Mon 7 Dec: the week before your 10K time trial is kept quiet" }]);
  });

  it("quietDaysBeforeRace 0: written, placed in the request (7 Dec on), and nothing held back", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], everyWeeks: 2, cadenceFrom: MON23 });
    const { status, json } = await patch(p, { quietDaysBeforeRace: 0 });
    expect(status).toBe(200);
    expect(json.heldBack).toBeUndefined();
    const [row] = await db.select().from(programs).where(eq(programs.id, p));
    expect(row!.config).toMatchObject({ quietDaysBeforeRace: 0 });
    const live = await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, p), isNull(plannedWorkouts.archivedAt)));
    expect(live.map((r) => r.effectiveDate).sort()).toEqual([MON23, "2026-12-07"]);
  });

  it("refused: on a calm course, on a programme, and past 21", async () => {
    const tre = await seedCourse("tre", { weekdays: [0] });
    expect(await patch(tre, { quietDaysBeforeRace: 3 })).toEqual({
      status: 422,
      json: { error: "invalid_plan", issues: [{ path: ["quietDaysBeforeRace"], message: "this course isn't held back before a race: its sessions carry no training load" }] },
    });
    const id = newId();
    await db.insert(programs).values({
      id, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    expect((await patch(id, { quietDaysBeforeRace: 3 })).json.issues).toEqual([{ path: ["quietDaysBeforeRace"], message: "quiet days before a race are set on a course alone" }]);
    const intro = await seedCourse(INTRO_COURSE.id, { weekdays: [0] });
    expect((await patch(intro, { quietDaysBeforeRace: 22 })).status).toBe(422);
  });
});
