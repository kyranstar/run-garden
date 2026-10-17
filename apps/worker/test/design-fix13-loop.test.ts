/**
 * TASK 13'S FIX WAVE, THE LOOP (stream S1): how a run ends and what its trail says after the live suite.
 *
 *  - R3: a last-turn finish is never lost to its length — and a tool refused on the run's last call ends the run as a
 *    finish in words does (the proposal promoted, the model's words or the standard line), never as a stop.
 *  - §2.1: the last turn's note states the line's cap in words; a long finish line is clipped where the athlete reads it
 *    and kept whole in the event's payload.
 *
 * The real registry, the real opening context and the real loop, driven by one scripted model shared by every run of
 * the tree. No key, no network. Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, dayLabel } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { answerRun, createRun, LAST_TURN_NOTE, LINES, readRunState, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { athleteText } from "../src/services/design-prose.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_l${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

function scripted(turns: MessagesResult[]) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

async function drive(userId: string, runId: string, deps: RunDeps) {
  const all: Array<{ status: string }> = [];
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: 60, what: "drive" },
  );
  return all;
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [],
  improvements: [],
});
const propose = (title: string) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date: TODAY } });
const submit = (v: unknown) => use("submit_review", v);

/** A now run whose step cap is `maxCalls` model calls (its state changed as a lowered setting would). */
async function nowRun(userId: string, maxCalls: number): Promise<string> {
  const id = (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  const state = readRunState(row!.state)!;
  state.settings.maxCalls = maxCalls;
  await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
  return id;
}

async function trail(runId: string) {
  return db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq);
}
async function proposalOf(runId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[] } : undefined;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}

describe("the trail's lines (§2.13, M2) and each call's usage (M5)", () => {
  it("a refused finish, ask or read writes no athlete line — its refusal kept in the event; a refused draft is 'Adjusted the draft.'", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 12);
    const { deps } = scripted([
      t(use("search_library", { nonsense: true })),
      t(use("ask_athlete", { questions: [{ text: "Gym?", chips: [{ label: "Yes", value: 3 }], why: "Sets the gear." }] })),
      t(use("propose_workout", { doc: { title: "Broken" }, target: { kind: "new", date: TODAY } })),
      t(propose("Calm hips")),
      t(submit(verdict(4))),
      t(use("finish", { summary: "Done.", extra: true })),
      t(use("finish", { summary: "Calm hips is ready." })),
    ]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    const events = await trail(runId);
    const refused = events.filter((e) => (e.payload as { ok?: unknown } | null)?.ok === false);
    expect(refused.map((e) => [(e.payload as { tool: string }).tool, e.summary])).toEqual([
      ["search_library", ""],
      ["ask_athlete", ""],
      ["propose_workout", "Adjusted the draft."],
      ["finish", ""],
    ]);
    for (const e of refused) expect(e.payload).toMatchObject({ refusal: { error: expect.any(String), why: expect.any(String) } });
    expect(events.at(-1)!.summary).toBe("Calm hips is ready.");
  });

  it("every model call's usage rides on its step's first event — input, cache read and write, output — and is no line of its own", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 12);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(use("finish", { summary: "Calm hips is ready." }))]);
    await drive(userId, runId, deps);
    const withUsage = (await trail(runId)).filter((e) => (e.payload as { usage?: unknown } | null)?.usage !== undefined);
    expect(withUsage).toHaveLength(requests.length);
    for (const e of withUsage) {
      expect((e.payload as { usage: unknown }).usage).toEqual({ input: 100, cacheRead: 60, cacheWrite: 50, output: 40 });
      expect(e.summary).not.toBe("");
    }
  });

  it("a set's designer opens with the brief's day; a refused plan is 'Adjusted the plan.'", async () => {
    const { userId } = await seedRichAthlete(db);
    const mainId = (await createRun(db, userId, { scope: { kind: "week" }, request: "Plan my week." }, NOW)).run.id;
    const brief = (key: string, date: string) => ({ key, date, purpose: "Hips.", emphasis: "Control.", constraints: "Home.", why: "Spaced out.", sameDayWhy: "A short one." });
    const day = addDays(TODAY, 1);
    const { deps } = scripted([
      t(use("plan_set", { briefs: [brief("a", addDays(TODAY, -3))] })),
      t(use("plan_set", { briefs: [brief("a", day)] })),
      t(use("propose_workout", { doc: calmDoc({ title: "Day hips" }), target: { kind: "new", date: day } })),
      t(submit(verdict(4))),
      t(use("finish", {})),
      t(use("finish", { summary: "One workout for the week." })),
    ]);
    expect((await drive(userId, mainId, deps)).at(-1)!.status).toBe("finished");
    const lines = (await trail(mainId)).map((e) => e.summary);
    expect(lines).toContain("Adjusted the plan.");
    expect(lines).toContain(`Read the brief for ${dayLabel(day)}.`);
    expect(lines).toContain("Designed “Day hips”.");
  });
});

describe("R3: the last turn never loses a finished design", () => {
  it("a last-turn finish of 500 characters ends the run finished: the proposal pending, the line clipped at a sentence, the whole kept", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const long = `${"Calm hips at home, slow holds first and the trunk after. ".repeat(8)}Enjoy it.`.slice(0, 500);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(use("finish", { summary: long }))]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    // The finish was the run's last call, told so — with the line's cap in words.
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain(LAST_TURN_NOTE);
    expect(LAST_TURN_NOTE).toContain("at most about 45 words (300 characters)");
    expect(await runRow(runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    expect((await proposalOf(runId))!.status).toBe("pending");
    const last = (await trail(runId)).at(-1)!;
    expect(last.summary.length).toBeLessThanOrEqual(300);
    expect(last.summary).toMatch(/\.$/);
    expect(long.startsWith(last.summary)).toBe(true);
    expect(last.payload).toMatchObject({ proposalId: designProposalId(runId), text: long });
  });

  it("a tool refused on the last call ends the run as a finish in words would — the model's words, the proposal promoted — never a stop", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const refused = turn([use("propose_workout", { doc: { title: "Broken" }, target: { kind: "new", date: TODAY } })], "Calm hips is ready for you.");
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), refused]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect(await runRow(runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    expect((await proposalOf(runId))!.status).toBe("pending");
    const lines = (await trail(runId)).map((e) => e.summary);
    expect(lines).not.toContain(LINES.stepCap);
    expect(lines.at(-1)).toBe("Calm hips is ready for you.");
  });

  it("a refused finish's own words are the line when it carried them", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const refused = turn([use("finish", { summary: "Calm hips is waiting for you.", extra: true })], "");
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), refused]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect((await trail(runId)).at(-1)!.summary).toBe("Calm hips is waiting for you.");
    expect((await proposalOf(runId))!.status).toBe("pending");
  });
});

// ── Round 2 (the whole-wave review) ─────────────────────────────────────────────────────────────────────────────────

describe("round 2: the trail in the athlete's words (I1), an honest last line (Minor 1), usage never in the way (Minor 5)", () => {
  it("a turn's words reach the trail in the athlete's words: no library id, tool name or 'validator'", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 12);
    const leaky = "Swapping deadBug for the bridge — the validator flagged mode_limits after read_balance.";
    const { deps } = scripted([turn([use("read_day", {})], leaky), t(use("finish", { summary: "Calm hips is ready." }))]);
    await drive(userId, runId, deps);
    const line = (await trail(runId)).find((e) => e.summary.startsWith("Swapping"))!;
    expect(line.summary).toBe(athleteText(leaky));
    expect(line.summary).not.toMatch(/deadBug|validator|mode_limits|read_balance/);
  });

});
