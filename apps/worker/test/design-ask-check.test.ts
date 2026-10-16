/**
 * ASKING FOR TODAY'S CONDITION CHECK (Stage 3 fix wave 3A, A8) — AND A SET'S DESIGNERS DON'T ASK (A9).
 *
 *  - ask_athlete takes `{ check: "condition", why }` in place of questions: no wording of the model's — the app shows
 *    its own condition check — and the run waits (`waiting_athlete`), its question event carrying `{ check, why }`.
 *  - `POST /:id/answer { conditionCheckId }` answers it: a `condition_checks` row of the athlete's, dated their today,
 *    saved at or after the question. The run resumes with a result telling the coach the check was logged, to validate
 *    again. A check from another day, or from before the question, is a 400; another athlete's (or none) a 404; words,
 *    or a check for an ordinary question, a 400; a skip works as for any question. Seven statements, pinned.
 *  - A designer whose run is a set's can't ask: the tool refuses, teaching it to decide and say what it assumed.
 *
 * The real registry and opening context, a scripted model. No key, no network. Synthetic data only: the made-up
 * athlete of design-read-fixture.ts.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { CHECK_LOGGED, createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { askAthlete, CHECK_ASKED, SET_DESIGNER_ASKS } from "../src/services/design-tools/ask.js";
import { allTools } from "../src/services/design-tools/index.js";
import type { ToolContext } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
import { seedRichAthlete, TZ } from "./design-read-fixture.js";
import { makeEnv } from "./doc-workout-fixture.js";
import { makeTestDb, mountRoutes } from "./helpers.js";

const ON = { ...makeEnv(), COACH_DESIGNER: "1" } as Env;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_ck${++seq}`, name, input });
function turn(uses: ContentBlock[]): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: "Working on it." }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
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

const WHY = "Overhead pressing needs today's jaw reading.";
const askCheck = () => use("ask_athlete", { check: "condition", why: WHY });

/** An athlete, signed in, with a now run that has asked for today's condition check — on the real clock (the answer
 * route reads it). */
async function asked() {
  let statements = 0;
  const db: Db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  const a = await seedRichAthlete(db);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, a.userId)}`;
  const call = askCheck();
  const { deps, requests } = scripted([t(call), t(use("finish", { summary: "Done." }))]);
  const start = new Date();
  const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "A press if the jaw allows." }, start)).run.id;
  await runStep(db, ON, runId, a.userId, start, deps); // context
  const askedAt = new Date(start.getTime() + 1_000);
  await runStep(db, ON, runId, a.userId, askedAt, deps); // the ask
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => deps));
  const answer = async (body: unknown) => {
    statements = 0;
    const res = await app.request(`/api/coach/runs/${runId}/answer`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, ON);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown>, cost: statements };
  };
  const logCheck = async (o: { userId?: string; localDate?: string; at?: Date } = {}) => {
    const id = newId();
    const at = o.at ?? new Date(Math.max(Date.now(), askedAt.getTime() + 2_000));
    await db.insert(schema.conditionChecks).values({
      id,
      userId: o.userId ?? a.userId,
      profileId: "tmj",
      kind: "daily",
      value: 2,
      feelingOff: false,
      localDate: o.localDate ?? todayInZone(TZ, at),
      at: at.toISOString(),
    });
    return id;
  };
  const step = (ms: number) => runStep(db, ON, runId, a.userId, new Date(askedAt.getTime() + ms), deps);
  return { db, a, runId, call, requests, answer, logCheck, step, askedAt };
}

const runRow = async (db: Db, id: string) => (await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id)))[0]!;

describe("ask_athlete for today's condition check (A8)", () => {
  it("the run waits on it; the question event carries { check, why } and no wording of the model's", async () => {
    const s = await asked();
    expect((await runRow(s.db, s.runId)).status).toBe("waiting_athlete");
    const [question] = await s.db
      .select()
      .from(schema.coachRunEvents)
      .where(and(eq(schema.coachRunEvents.runId, s.runId), eq(schema.coachRunEvents.kind, "question")));
    expect(question).toMatchObject({ summary: CHECK_ASKED, payload: { tool: "ask_athlete", data: { check: "condition", why: WHY } } });
  });

  it("answered with a check logged today after the question: the run resumes, told to validate again — seven statements", async () => {
    const s = await asked();
    const id = await s.logCheck();
    const res = await s.answer({ conditionCheckId: id });
    expect(res.status).toBe(200);
    expect((await runRow(s.db, s.runId)).status).toBe("active");
    // The route's two, the tree, the check, the claim, the run's write, the line.
    expect(res.cost).toBe(7);
    const out = await s.step(60_000);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    const sent = s.requests.at(-1)!.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const result = sent.find((b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === (s.call as { id: string }).id) as ToolResultBlock;
    expect(JSON.parse(result.content as string)).toEqual({ checkLogged: true, note: CHECK_LOGGED });
    expect(CHECK_LOGGED).toBe("The athlete logged today's condition check. Validate again.");
    const lines = (await s.db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, s.runId))).map((e) => e.summary);
    expect(lines).toContain("You logged today's condition check.");
  });

  it("a check from yesterday, or from before the question, is refused 400 — and the run still waits", async () => {
    const s = await asked();
    const yesterday = await s.logCheck({ localDate: todayInZone(TZ, new Date(Date.now() - 86_400_000)) });
    const early = await s.logCheck({ at: new Date(s.askedAt.getTime() - 60_000), localDate: todayInZone(TZ, s.askedAt) });
    const old = await s.answer({ conditionCheckId: yesterday });
    expect(old).toMatchObject({ status: 400, body: { error: "bad_answer", why: "That check is from another day: log today's." } });
    const before = await s.answer({ conditionCheckId: early });
    expect(before).toMatchObject({ status: 400, body: { error: "bad_answer", why: "That check was logged before the coach asked: log a new one." } });
    expect((await runRow(s.db, s.runId)).status).toBe("waiting_athlete");
  });

  it("another athlete's check, or none, is a 404", async () => {
    const s = await asked();
    const other = await seedRichAthlete(s.db);
    const theirs = await s.logCheck({ userId: other.userId });
    expect(await s.answer({ conditionCheckId: theirs })).toMatchObject({ status: 404, body: { error: "check_not_found" } });
    expect(await s.answer({ conditionCheckId: "no-such-check" })).toMatchObject({ status: 404, body: { error: "check_not_found" } });
    expect((await runRow(s.db, s.runId)).status).toBe("waiting_athlete");
  });

  it("words for a check, or a check for a question, are refused 400; a skip goes on without the check", async () => {
    const s = await asked();
    expect(await s.answer({ answers: ["My jaw is fine."] })).toMatchObject({ status: 400, body: { error: "bad_answer" } });
    expect(await s.answer({ conditionCheckId: 7 })).toMatchObject({ status: 400, body: { error: "bad_check" } });
    const skipped = await s.answer({ dismissed: true });
    expect(skipped.status).toBe(200);
    await s.step(60_000);
    const sent = s.requests.at(-1)!.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const result = sent.find((b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === (s.call as { id: string }).id) as ToolResultBlock;
    expect(JSON.parse(result.content as string)).toMatchObject({ dismissed: true, note: expect.stringContaining("stay closed") });
  });

  it("a check for an ordinary question is refused", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, a.userId)}`;
    const { deps } = scripted([t(use("ask_athlete", { questions: [{ text: "How long?", chips: ["20 min", "40 min"], why: "Sets the length." }] }))]);
    const now = new Date();
    const runId = (await createRun(db, a.userId, { scope: { kind: "now" }, request: "Something short." }, now)).run.id;
    await runStep(db, ON, runId, a.userId, now, deps);
    await runStep(db, ON, runId, a.userId, new Date(now.getTime() + 1000), deps);
    const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => deps));
    const res = await app.request(`/api/coach/runs/${runId}/answer`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ conditionCheckId: "c1" }) }, ON);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_answer", why: "The coach asked a question, not for a condition check." });
  });

  it("the tool's input: the check form takes only a why; its description names it and the role limits", async () => {
    const db = makeTestDb();
    const a = await seedRichAthlete(db);
    const ctx = { db, env: ON, userId: a.userId, run: { id: "r", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: "u" } as unknown as ToolContext;
    expect(await askAthlete.run(ctx, { check: "condition", why: WHY })).toEqual({ data: { check: "condition", why: WHY }, summary: CHECK_ASKED });
    expect(await askAthlete.run(ctx, { check: "condition", why: WHY, questions: [] })).toMatchObject({ error: "invalid_input" });
    expect(await askAthlete.run(ctx, { check: "soreness", why: WHY })).toMatchObject({ error: "invalid_input" });
    expect(await askAthlete.run(ctx, { check: "condition" })).toMatchObject({ error: "invalid_input" });
    expect(askAthlete.description).toContain('{ check: "condition", why }');
    expect(askAthlete.description).toMatch(/never a set's designer/);
    expect(askAthlete.description).toMatch(/logs the check in the app, then you validate again/);
  });
});

describe("a set's designers don't ask (A9)", () => {
  const ctxOf = (db: Db, userId: string, role: "main" | "designer", parentId: string | null, scope: { kind: string; n?: number }) =>
    ({ db, env: ON, userId, run: { id: "r", role, scope, parentId, rehearsal: false }, now: new Date(), toolUseId: "u" }) as unknown as ToolContext;

  it("a set's designer is refused, for questions and the check alike, with what to do instead; the set's main coach may ask", async () => {
    const db = makeTestDb();
    const a = await seedRichAthlete(db);
    const q = { questions: [{ text: "Gym or home?", chips: ["Gym", "Home"], why: "Sets the gear." }] };
    for (const scope of [{ kind: "week" }, { kind: "next_n", n: 3 }]) {
      for (const input of [q, { check: "condition", why: WHY }]) {
        const refused = await askAthlete.run(ctxOf(db, a.userId, "designer", "main-run", scope), input);
        expect(refused).toEqual({ error: "set_designer_cannot_ask", why: SET_DESIGNER_ASKS.why, fix: SET_DESIGNER_ASKS.fix });
      }
      expect(await askAthlete.run(ctxOf(db, a.userId, "main", null, scope), { check: "condition", why: WHY })).toMatchObject({ data: { check: "condition" } });
    }
    expect(SET_DESIGNER_ASKS).toEqual({
      why: "In a set the main coach asks.",
      fix: "Design on your best judgement and say what you assumed in the document's notes.",
    });
  });

  it("in a running set, the designer's ask is answered with the refusal and the set never waits on the athlete", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const now = new Date();
    const mainId = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week." }, now)).run.id;
    const date = todayInZone(TZ, new Date(now.getTime() + 86_400_000));
    const designerAsk = use("ask_athlete", { questions: [{ text: "Gym or home?", chips: ["Gym", "Home"], why: "Sets the gear." }] });
    const { deps, requests } = scripted([
      t(use("plan_set", { briefs: [{ key: "a", date, purpose: "Hips.", emphasis: "Control.", constraints: "30 minutes.", why: "Recovery.", sameDayWhy: "Beside the day's plan." }] })),
      t(designerAsk),
      t(use("finish", { summary: "Nothing proposed: no answer." })),
      t(use("finish", { summary: "No set this time." })),
    ]);
    const statuses: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = await runStep(db, ON, mainId, a.userId, new Date(now.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(out.kind);
      statuses.push(out.result.status);
      if (out.result.status !== "active") break;
    }
    expect(statuses).not.toContain("waiting_athlete");
    expect(statuses.at(-1)).toBe("finished");
    const sent = requests.flatMap((r) => r.messages).flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const result = sent.find((b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === (designerAsk as { id: string }).id) as ToolResultBlock;
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content as string)).toEqual({ error: "set_designer_cannot_ask", ...SET_DESIGNER_ASKS });
  });
});
