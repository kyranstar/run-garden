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

