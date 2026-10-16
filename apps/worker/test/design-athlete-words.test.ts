/**
 * THE ATHLETE'S WORDS ON THE TRAIL AND THE CARD (fix wave 3B, B-I3, B-I4, B-M8, B-M9). Every line the server writes for
 * the athlete — a tool's line on the trail, a stop's or a set's line, the suggestion's own lines, the receipt — says it
 * in plain words: no ISO date (a day is "Sat 16 May", a span "Wed 13 – Wed 20 May": @rg/domain `dayLabel`,
 * `dayRangeLabel`), and none of the machinery's words — designer, reviewer, op, proposal, validator, a run in the
 * coach's sense. A refused call is no alarm: the trail says "Adjusted the draft." and the refusal rides in the payload
 * (design-act-loop.test.ts). The receipt names the workout once. "This week" is "the next 7 days".
 *
 * On the made-up athlete of design-read-fixture.ts and its fixed clock. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { LINES, REVIEWER_LINES } from "../src/services/coach-runs.js";
import { approveDesignOps, type DesignedOp } from "../src/services/design-approve.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { designerStopLine, settleSet, type DesignerEnd } from "../src/services/design-orchestrate.js";
import { DROPPED_LINE, NOTE_NOT_DONE, NOTE_UNREADABLE, pastDayLine, STOPPED_NOTES, unavailableWhy } from "../src/services/design-review.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { planSet } from "../src/services/design-tools/plan-set.js";
import { isToolErr, type SetHooks, type ToolContext, type ToolOk } from "../src/services/design-tools/types.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb } from "./helpers.js";

const ENV = {} as Env;
let db: Db;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  rich = await seedRichAthlete(db);
});

/** No ISO date, and none of the machinery's words. */
function expectPlain(line: string, what = line): void {
  expect(line, what).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(line, what).not.toMatch(/\b(designers?|reviewers?|reviewing model|ops?|proposals?|propose|proposed|validator'?s?)\b/i);
  expect(line, what).not.toMatch(/\b(this run|the run|run's|sub-run|main run)\b/i);
}

const ctx = (scope: ToolContext["run"]["scope"] = { kind: "now" }, set?: SetHooks): ToolContext => ({
  db,
  env: ENV,
  userId: rich.userId,
  run: { id: "run-words", role: "main", scope, parentId: null, rehearsal: false },
  now: NOW,
  toolUseId: "toolu_words",
  ...(set ? { set } : {}),
});

describe("the read tools' lines on the trail", () => {
  it("name days and spans as the app does, never as ISO dates or with internal words", async () => {
    const inputs: Record<string, unknown> = {
      read_plan: { from: TODAY, to: day(-7) },
      list_workouts: { from: day(30), to: day(-30) },
      get_workout: { id: rich.todayDocId },
      read_history: { from: day(14), to: TODAY },
      read_balance: { from: day(28), to: TODAY },
      read_day: { date: day(-2) },
      read_answers: { since: day(10) },
      get_exercise: { id: "gobletSquat" },
      search_library: { query: "squat" },
    };
    const lines = new Map<string, string>();
    for (const tool of READ_TOOLS) {
      const r = await tool.run(ctx(), inputs[tool.name] ?? {});
      if (isToolErr(r)) throw new Error(`${tool.name} refused: ${r.why}`);
      lines.set(tool.name, (r as ToolOk).summary!);
      expectPlain((r as ToolOk).summary!, tool.name);
    }
    expect(lines.get("read_plan")).toMatch(/^Read \d+ planned workouts?, Wed 13 – Wed 20 May$/);
    expect(lines.get("read_day")).toMatch(/^Read Fri 15 May — /);
    expect(lines.get("read_balance")).toMatch(/, Wed 15 Apr – Wed 13 May$/);
    expect(lines.get("read_answers")).toMatch(/since Sun 3 May$/);
    expect(lines.get("get_workout")).toMatch(/^Read the workout on Wed 13 May/);
    expect(lines.get("read_proposals")).toMatch(/suggestions?/);
  });

  it("a span with nothing in it, and a recall that has nothing more, say so plainly", async () => {
    const plan = READ_TOOLS.find((t) => t.name === "read_plan")!;
    const empty = (await plan.run(ctx(), { from: day(-60), to: day(-62) })) as ToolOk;
    expect(empty.summary).toBe("Nothing planned, Sun 12 – Tue 14 Jul");
    const recall = READ_TOOLS.find((t) => t.name === "recall_memory")!;
    const nothing = (await recall.run(ctx(), { query: "nothing of the sort is remembered here" })) as ToolOk;
    expect(nothing.summary).toBe("That's everything the coach remembers.");
  });
});

describe("plan_set's line", () => {
  it("says a workout for each day, the days as the app names them", async () => {
    const hooks: SetHooks = {
      rounds: () => [],
      start: async (designers) => designers.map((d) => d.runId),
      budget: () => ({ ceilingMicros: 6_000_000, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }),
      started: () => false,
      keyLine: () => undefined,
    };
    const brief = (key: string, date: string) => ({ key, date, purpose: "Hips and trunk.", emphasis: "Control.", constraints: "Thirty minutes.", why: "Away from the runs." });
    const r = await planSet.run(ctx({ kind: "week" }, hooks), { briefs: [brief("thu", day(-1)), brief("mon", day(-5))] });
    if (isToolErr(r)) throw new Error(r.why);
    expect(r.summary).toBe("Planned 2 workouts — a workout for each day: Thu 14 May, Mon 18 May");
    expectPlain(r.summary!);
  });
});

describe("a set's outcome", () => {
  const round = (date: string) => ({
    toolUseId: "toolu_plan",
    redo: false,
    briefs: [{ key: "sat", date, purpose: "p", emphasis: "e", constraints: "c", why: "w" }],
    designers: [{ key: "sat", runId: "d-sat" }],
  });
  const settle = async (end: Partial<DesignerEnd>) =>
    settleSet(db, rich.userId, {
      proposalId: "dp-nothing-here",
      round: round(day(-3)),
      keyLines: [],
      designers: [{ key: "sat", runId: "d-sat", status: "finished", error: null, final: null, ...end }],
      redoLeft: 1,
      budget: { ceilingMicros: 6_000_000, spentMicros: 1_000_000 },
    });

  it("a day with no workout: the coach couldn't fit one there (B-I3's own words), no machinery named", async () => {
    const out = await settle({});
    expect(out.keyLines).toEqual([{ key: "sat", line: "The coach couldn't fit a workout on Sat 16 May." }]);
    expect(out.line).toBe("The set is designed: 0 workouts, 1 left out.");
    expectPlain(out.line);
  });

  it("every way a day can be left out reads plainly", async () => {
    const ends: Array<Partial<DesignerEnd>> = [
      { status: "missing" },
      { status: "stopped_cap", error: "run_ceiling", ceilingMicros: 700_000 },
      { status: "stopped_cap", error: "step_cap" },
      { status: "stopped_cap", error: "state_cap" },
      { status: "stopped_cap", error: "weekly_cap" },
      { status: "stopped_cap", error: null },
      { status: "expired" },
      { status: "cancelled" },
      ...["retries", "refusal", "internal", "no_key", "kept_stopping", null, "gateway_500"].map((error) => ({ status: "failed", error })),
    ];
    for (const end of ends) {
      const out = await settle(end);
      for (const k of out.keyLines ?? []) {
        expect(k.line, JSON.stringify(end)).toMatch(/^No workout on Sat 16 May: /);
        expectPlain(k.line, JSON.stringify(end));
      }
    }
    for (const error of ["step_cap", "state_cap", "retries", "refusal", "internal", null]) expectPlain(designerStopLine(error));
  });
});

describe("the loop's own lines, a stop's notes and a review's", () => {
  it("say what happened in plain words", () => {
    for (const [k, line] of Object.entries(LINES)) expectPlain(line, `LINES.${k}`);
    for (const [k, line] of Object.entries(REVIEWER_LINES)) expectPlain(line, `REVIEWER_LINES.${k}`);
    for (const [k, line] of Object.entries(STOPPED_NOTES)) expectPlain(line, `STOPPED_NOTES.${k}`);
    for (const line of [NOTE_UNREADABLE, NOTE_NOT_DONE, DROPPED_LINE]) expectPlain(line);
    for (const error of ["retries", "refusal", "internal", "no_key", "not_started", "state_cap", "kept_stopping", null, "gateway_500"]) {
      expectPlain(`The review couldn't finish: ${unavailableWhy(error)}.`, String(error));
    }
    expect(LINES.nothingProposed).toBe("Nothing was suggested.");
    expect(NOTE_UNREADABLE).toBe("The review could not be read; the app's own checks stand.");
  });

  it("a day gone before it could be suggested names its day as the app does", () => {
    const op = { kind: "doc_workout", doc: calmDoc({ title: "Saturday" }), date: day(-3) } as never;
    expect(pastDayLine([op])).toBe("Its day passed before it could be suggested, so left out: “Saturday” (Sat 16 May).");
  });
});

describe("the next 7 days", () => {
  it("is what the set's opening context calls the week", async () => {
    const built = await buildDesignContext(db, ENV, rich.userId, { id: "run-week", role: "main", scope: { kind: "week" }, request: "Plan ahead.", parentId: null }, NOW);
    expect(built.header).toContain("Scope: the next 7 days — workouts from");
    expect(built.header).not.toMatch(/this week/i);
  });
});

describe("the receipt names the workout once (B-M8)", () => {
  it("one workout: its title, then its day and minutes", async () => {
    const mainId = "run-receipt-main";
    const designerId = "run-receipt-d1";
    for (const [id, role, parentId] of [[mainId, "main", null], [designerId, "designer", mainId]] as const) {
      await db.insert(schema.coachRuns).values({
        id, userId: rich.userId, parentId, role, scope: { kind: "week" }, request: "Plan ahead.", status: "active", state: null, steps: 0, costUsd: 0,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      });
    }
    const proposed = await proposeWorkout.run(
      { db, env: ENV, userId: rich.userId, run: { id: designerId, role: "designer", scope: { kind: "week" }, parentId: mainId, rehearsal: false }, now: NOW, toolUseId: "toolu_receipt" },
      { doc: calmDoc({ title: "Hips and back, gently" }), target: { kind: "new", date: day(-3) } },
    );
    if (isToolErr(proposed)) throw new Error(proposed.why);
    const id = designProposalId(mainId);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    const ops = (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: { scores: { intent: 4 }, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [] } }));
    await db.update(schema.coachProposals).set({ status: "pending", ops }).where(eq(schema.coachProposals.id, id));
    const prefs = await loadPreferences(db, rich.userId);
    await approveDesignOps(db, rich.userId, { ...p!, status: "pending", ops }, {}, { today: TODAY, now: NOW.toISOString(), prefs }, Number.POSITIVE_INFINITY);
    const [receipt] = await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, rich.userId));
    expect(receipt!.body).toMatch(/^✓ approved — Hips and back, gently: Sat 16 May · \d+ min$/);
  });
});
