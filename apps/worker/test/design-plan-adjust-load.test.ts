/**
 * A PLAN CHANGE CARRIES ITS LOAD (the safety audit, 2026-11-06, S4). The prompt says code counts the load and shows it
 * beside Approve; for a designed run it did (the validator's `run_hard_close`, `run_long_share`, `run_volume_jump`), but
 * adjust_plan's changes were never judged: a quality run moved beside another, a long run lengthened past the week's
 * share, a skipped tempo put back the day after a hard leg day — all approved with no word of it.
 *
 * Now a change that can add load — a move, a length made longer, a restore — reads the running around the session's day
 * after the change in the statement adjust_plan already runs (no statement more), and the validator's own rules
 * (@rg/workout `runLoadNotes`) put each breach among the change's issues, beside Approve. A change that only takes load
 * away (a skip, a remove, an ease, a swap, a shorter length) reads nothing more and carries none. A move inside its week
 * changes no week's total: only its day is judged.
 *
 * The made-up athlete of design-read-fixture.ts on its fixed clock (Wednesday 13 May; runs every third day for the last
 * two months, about 90 minutes a week). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, workoutDocSchema } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import type { PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { day, NOW, seedRichAthlete } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const { plannedWorkouts, coachProposals } = schema;

let db: Db;
let statements = 0;
let userId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (statements += 1) });
  ({ userId } = await seedRichAthlete(db));
});
afterEach(() => vi.useRealTimers());

let seq = 0;
async function mainRun(): Promise<ToolContext> {
  const id = `run-load-${++seq}-${newId().slice(0, 6)}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "now" }, request: "Shuffle my runs this week.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: {} as Env, userId, run: { id, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_load${seq}` };
}

/** A watch-plan session of the athlete's (no document unless a strength one's). */
async function planned(o: { date: string; category: string; minutes: number; title: string; sport?: string; state?: string; doc?: unknown }): Promise<string> {
  const id = `pw-load-${newId().slice(0, 8)}`;
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coros-plan", sourceWorkoutId: id, title: o.title, category: o.category, sport: o.sport ?? "run", originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date, effectiveDate: o.date, effectiveTime: "18:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: o.minutes * 60,
    calendarBlockDurationSeconds: o.minutes * 60, completionState: o.state ?? "scheduled", origin: o.doc ? "studio" : null,
    workoutDoc: o.doc ? JSON.stringify(o.doc) : null, workoutDocRev: o.doc ? 1 : null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return id;
}

async function adjust(ctx: ToolContext, input: unknown): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await adjustPlan.run(ctx, input);
  return { res, count: statements };
}
const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const issuesOf = (r: ToolOk) => (r.data as { issues: Array<{ code: string; message: string }> }).issues;
const storedOp = async (ctx: ToolContext) =>
  ((await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id))))[0]!.ops as PlanAdjustOp[])[0]!;

const WHY = "It fits the week better.";

describe("adjust_plan carries the running load of what it changes (the safety audit, S4)", () => {
  it("a quality run moved the day after another: the 48-hour rule beside Approve, stored on the op — in its two statements", async () => {
    const thursday = await planned({ date: day(-1), category: "quality", minutes: 50, title: "Zorbex intervals" });
    const tempo = await planned({ date: day(-4), category: "quality", minutes: 45, title: "Zorbex tempo" });
    const ctx = await mainRun();
    const { res, count } = await adjust(ctx, { workoutId: tempo, change: { kind: "move", toDate: day(-2) }, why: WHY });
    expect(count).toBe(2);
    const issues = issuesOf(ok(res));
    expect(issues).toEqual([{ code: "run_hard_close", message: "Zorbex intervals is the day before: hard running wants 48 hours from other hard running and hard leg strength." }]);
    expect((await storedOp(ctx)).issues).toEqual(issues);
    expect(thursday).toBeTruthy();
  });

  it("a long run made longer: its share of the week and the week's jump; a move inside its week judges its day alone", async () => {
    const long = await planned({ date: day(-5), category: "long", minutes: 60, title: "Zorbex long run" });
    const ctx = await mainRun();
    const r = ok((await adjust(ctx, { workoutId: long, change: { kind: "adjust", durationMinutes: 150 }, why: WHY })).res);
    const codes = issuesOf(r).map((i) => i.code);
    expect(codes).toContain("run_long_share");
    expect(codes).toContain("run_volume_jump");
    expect(issuesOf(r).find((i) => i.code === "run_volume_jump")!.message).toMatch(/^With this run the week's running comes to \d+ minutes, \d+% over your last four weeks' average of \d+ a week\.$/);
    // Shorter takes load away: nothing to say of it.
    const shorter = await mainRun();
    expect(issuesOf(ok((await adjust(shorter, { workoutId: long, change: { kind: "adjust", durationMinutes: 40 }, why: WHY })).res)).filter((i) => i.code.startsWith("run_"))).toEqual([]);
    // Moved a day, inside its week: the week's total is the same, so no week note.
    const moved = await mainRun();
    expect(issuesOf(ok((await adjust(moved, { workoutId: long, change: { kind: "move", toDate: day(-7) }, why: WHY })).res)).filter((i) => i.code.startsWith("run_"))).toEqual([]);
  });

  it("a skipped tempo put back beside hard leg strength: the 48-hour rule", async () => {
    const legs = workoutDocSchema.parse({
      version: 1, title: "Zorbex leg day", intent: { summary: "Heavy legs.", goals: ["strength"], focus: [], effort: "develop" },
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 4, reps: 6, restSec: 90 } },
        { kind: "exercise", libraryId: "rdl", dose: { sets: 4, reps: 6, restSec: 90 } },
      ] }],
      source: { kind: "studio" },
    });
    await planned({ date: day(-4), category: "strength", sport: "strength", minutes: 50, title: "Zorbex leg day", doc: legs });
    const tempo = await planned({ date: day(-5), category: "quality", minutes: 45, title: "Zorbex tempo", state: "skipped" });
    const ctx = await mainRun();
    const issues = issuesOf(ok((await adjust(ctx, { workoutId: tempo, change: { kind: "restore" }, why: WHY })).res));
    expect(issues.map((i) => i.message)).toContain("Zorbex leg day is the day before: hard running wants 48 hours from other hard running and hard leg strength.");
  });

  it("a hard leg day moved beside a quality run: the same rule from the other side", async () => {
    const legs = workoutDocSchema.parse({
      version: 1, title: "Zorbex leg day", intent: { summary: "Heavy legs.", goals: ["strength"], focus: [], effort: "develop" },
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 4, reps: 6, restSec: 90 } },
        { kind: "exercise", libraryId: "rdl", dose: { sets: 4, reps: 6, restSec: 90 } },
      ] }],
      source: { kind: "studio" },
    });
    await planned({ date: day(-5), category: "quality", minutes: 45, title: "Zorbex tempo" });
    const legDay = await planned({ date: day(-1), category: "strength", sport: "strength", minutes: 50, title: "Zorbex leg day", doc: legs });
    const ctx = await mainRun();
    const issues = issuesOf(ok((await adjust(ctx, { workoutId: legDay, change: { kind: "move", toDate: day(-4) }, why: WHY })).res));
    expect(issues).toEqual([{ code: "run_hard_close", message: "Zorbex tempo is the day after: hard running wants 48 hours from other hard running and hard leg strength." }]);
  });

  it("a skip takes load away: no load read, no load note", async () => {
    await planned({ date: day(-1), category: "quality", minutes: 50, title: "Zorbex intervals" });
    const tempo = await planned({ date: day(-2), category: "quality", minutes: 45, title: "Zorbex tempo" });
    const ctx = await mainRun();
    const { res, count } = await adjust(ctx, { workoutId: tempo, change: { kind: "skip", reason: "Legs are heavy." }, why: WHY });
    expect(count).toBe(2);
    expect(issuesOf(ok(res)).filter((i) => i.code.startsWith("run_"))).toEqual([]);
  });
});
