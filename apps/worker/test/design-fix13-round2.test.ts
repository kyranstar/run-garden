/**
 * TASK 13'S FIX WAVE, ROUND 2 (stream S1), the tools: what the whole-wave review found in them.
 *
 *  - I1: the athlete reads the finish line and the question in plain words — a library id becomes its move's name, a tool
 *    name or "validator" the app's words (design-prose.ts `athleteText`).
 *  - Minor 8: adjust_plan's `why` and a skip's `reason`, and drop_workout's `reason`, are free text the athlete reads:
 *    accepted up to four times their caps and clipped, refused past that in words.
 *  - U's need: record_answer's receipt says until when its Undo is offered (`undo.expiresAt`, the latest fresh day).
 *
 * Called directly with the loop's context. Synthetic data only: the made-up athlete of design-read-fixture.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { athleteText } from "../src/services/design-prose.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { askAthlete } from "../src/services/design-tools/ask.js";
import { dropWorkout } from "../src/services/design-tools/drop-workout.js";
import { finish } from "../src/services/design-tools/finish.js";
import { recordAnswer } from "../src/services/design-tools/record-answer.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const ENV = {} as Env;
let db: Db;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  rich = await seedRichAthlete(db);
});

let seq = 0;
async function mainRun(request = "My calves are sore, something easy at home."): Promise<ToolContext["run"]> {
  const id = `run-${++seq}-${newId().slice(0, 8)}`;
  await db.insert(schema.coachRuns).values({
    id, userId: rich.userId, parentId: null, role: "main", scope: { kind: "now" }, request,
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false };
}
const ctxOf = (run: ToolContext["run"]): ToolContext => ({ db, env: ENV, userId: rich.userId, run, now: NOW, toolUseId: `toolu_r2${++seq}` });
const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const err = (r: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.data).slice(0, 300)}`);
  return r;
};

/** Words that leak the coach's machinery: a library id, a tool's name, "validator". */
const LEAKY = "Swapped deadBug for the bridge — the validator flagged mode_limits after read_balance.";
const leaks = (text: string) => [/deadBug/, /validator/i, /mode_limits/, /read_balance/].filter((r) => r.test(text)).map(String);

describe("I1: what the athlete reads, in their words", () => {
  it("the main coach's finish line", async () => {
    const out = ok(await finish.run(ctxOf(await mainRun()), { summary: LEAKY }));
    expect(leaks(out.summary!)).toEqual([]);
    expect(out.summary).toBe(athleteText(LEAKY));
  });

  it("a question's words and its why — its chips stay as given, so the answer still maps to them", async () => {
    const out = ok(
      await askAthlete.run(ctxOf(await mainRun()), {
        questions: [{ text: "Keep the deadBug, or does the validator's note on mode_limits matter more?", chips: ["Keep it", "Swap it"], why: LEAKY }],
      }),
    );
    const q = (out.data as { questions: Array<{ text: string; why: string; chips: string[] }> }).questions[0]!;
    expect(leaks(q.text)).toEqual([]);
    expect(leaks(q.why)).toEqual([]);
    expect(q.chips).toEqual(["Keep it", "Swap it"]);
    expect(leaks(out.summary!)).toEqual([]);
    const check = ok(await askAthlete.run(ctxOf(await mainRun()), { check: "condition", why: LEAKY }));
    expect(leaks((check.data as { why: string }).why)).toEqual([]);
  });
});

describe("Minor 8: a change's words are soft-capped", () => {
  const long = (n: number) => `${"Today's reading is high, so the evening session comes off and a short relief session takes its place. ".repeat(12)}`.slice(0, n);

  it("adjust_plan: a why and a skip's reason over their caps are kept, clipped where the athlete reads them", async () => {
    const run = await mainRun();
    const out = ok(await adjustPlan.run(ctxOf(run), { workoutId: rich.outlineToday, change: { kind: "skip", reason: long(500) }, why: long(700) }));
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, `dp-${run.id}`));
    const op = (p!.ops as Array<{ kind: string; why: string; op: { reason?: string } }>).find((o) => o.kind === "plan_adjust")!;
    expect(op.why.length).toBeLessThanOrEqual(300);
    expect(op.op.reason!.length).toBeLessThanOrEqual(200);
    expect(op.why).toMatch(/\.$/);
    expect(out.summary).toBeDefined();
  });

  it("adjust_plan: past four times its cap, refused with the length in words", async () => {
    const e = err(await adjustPlan.run(ctxOf(await mainRun()), { workoutId: rich.outlineToday, change: { kind: "skip", reason: "x".repeat(900) }, why: "Rest it." }));
    expect(e.why).toContain("change.reason is 900 characters; at most 200 — about 30 words");
    const w = err(await adjustPlan.run(ctxOf(await mainRun()), { workoutId: rich.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "y".repeat(1_300) }));
    expect(w.why).toContain("why is 1,300 characters; at most 300 — about 45 words");
  });
});

describe("Minor 8: drop_workout's reason is soft-capped", () => {
  async function setWithOne(): Promise<{ ctx: ToolContext; opId: string }> {
    const id = `run-${++seq}-${newId().slice(0, 8)}`;
    await db.insert(schema.coachRuns).values({
      id, userId: rich.userId, parentId: null, role: "main", scope: { kind: "week" }, request: "Plan my week.",
      status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const opId = `ds-${id}-a`;
    const op = { kind: "doc_workout", target: { kind: "new", date: TODAY }, date: TODAY, doc: { title: "Calm hips" }, review: null, issues: [], derived: {}, by: { runId: opId, role: "designer" }, toolUseId: "t1", at: NOW.toISOString() };
    await db.insert(schema.coachProposals).values({ id: `dp-${id}`, userId: rich.userId, title: "Calm hips", evidence: "", rationale: "", flags: [], ops: [op], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: TODAY });
    const round = { toolUseId: "t0", redo: false, briefs: [], designers: [{ key: "a", runId: opId }] };
    const set = { rounds: () => [round], budget: () => ({ ceilingMicros: 6_000_000, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }), keyLine: () => undefined, started: () => false, start: async () => [] };
    return { ctx: { ...ctxOf({ id, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }), set } as ToolContext, opId };
  }

  it("a reason over its cap is kept, clipped where the athlete reads it; past four times it, refused in words", async () => {
    const reason = `${"The long run sits the next morning, so the legs need the evening off. ".repeat(6)}`.trim();
    expect(reason.length).toBeGreaterThan(200);
    const { ctx, opId } = await setWithOne();
    const out = ok(await dropWorkout.run(ctx, { opId, reason }));
    const said = out.summary!.split("): ")[1]!;
    expect(said.length).toBeLessThanOrEqual(200);
    expect(reason.startsWith(said)).toBe(true);
    const again = await setWithOne();
    const e = err(await dropWorkout.run(again.ctx, { opId: again.opId, reason: "z".repeat(801) }));
    expect(e.why).toContain("reason is 801 characters; at most 200 — about 30 words");
  });
});

