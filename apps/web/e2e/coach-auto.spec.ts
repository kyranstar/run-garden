import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH, A CONVERSATION — THE SERVER END TO END (the new shape §5, stream A): runs asked with no scope (auto) on the
 * scripted model, one conversation, read back. Everything but the model is the real worker: the create's conversation,
 * the step alarm, the opening context with the conversation so far, the loop, the reviewer, a set's designers, the
 * proposal and `GET /api/coach/conversation`.
 *
 *  1. an auto run that answers in words (`auto_answer`): finished, no suggestion; the conversation's line is the answer;
 *  2. a reply in the same conversation that designs one workout for right now (`auto_design`): a workout card;
 *  3. a reply that plans a set (`auto_set`): plan_set raises the run's ceiling to a set's; a set card.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-auto --workers=1
 *
 * The stand-in model is switched to each journey's script (`POST /use/<name>`) and back after. The API alone: the
 * conversation's sheet is the UI's (stream C). One project is enough: the journeys share the fixture account.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];

async function model(path: string): Promise<void> {
  await fetch(`${MODEL}${path}`, { method: "POST" });
}

async function signIn(request: APIRequestContext, baseURL: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

/** Nothing of an earlier journey's left: no live run, no open suggestion. */
async function clearTheCoach(request: APIRequestContext, baseURL: string | undefined) {
  for (let i = 0; i < 6; i++) {
    const current = (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { id: string; status: string } | null;
      proposal?: { id: string; status?: string } | null;
      alsoOpen?: Array<{ proposalId: string }>;
    };
    for (const a of current.alsoOpen ?? []) await request.post(`${baseURL}/api/coach/proposals/${a.proposalId}/decline`, { data: {} });
    if (!current.run) return;
    if (LIVE.includes(current.run.status)) {
      await request.post(`${baseURL}/api/coach/runs/${current.run.id}/cancel`, { data: {} });
    } else if (current.proposal && ["pending", "partially_approved"].includes(current.proposal.status ?? "")) {
      await request.post(`${baseURL}/api/coach/proposals/${current.proposal.id}/decline`, { data: {} });
    } else return;
  }
}

interface RunDto {
  id: string;
  status: string;
  scope: { kind: string };
  conversationId: string;
  ceilingUsd: number | null;
  estimateUsd: number | null;
}

/** Ask with no scope, in `conversationId` (null: a new one), and let the run's alarm step it to its end. */
async function ask(request: APIRequestContext, baseURL: string | undefined, words: string, conversationId: string | null): Promise<RunDto> {
  const created = await request.post(`${baseURL}/api/coach/runs`, { data: { request: words, conversationId } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = (await created.json()) as { run: RunDto; existing: boolean; conversationId: string };
  expect(body.existing).toBe(false);
  expect(body.run.scope).toEqual({ kind: "auto" });
  expect(body.conversationId).toBe(body.run.conversationId);
  const id = body.run.id;
  await request.post(`${baseURL}/api/coach/runs/${id}/step?afterSeq=0`);
  for (let i = 0; i < 240; i++) {
    const read = (await (await request.get(`${baseURL}/api/coach/runs/${id}?afterSeq=0`)).json()) as { run: RunDto };
    if (!LIVE.includes(read.run.status)) return read.run;
    // The alarm steps it; a word now and then keeps its lease (and re-arms a step that is due).
    if (i % 10 === 9) await request.post(`${baseURL}/api/coach/runs/${id}/step?afterSeq=0`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`run ${id} still live after two minutes`);
}

interface ConversationDto {
  id: string | null;
  startedAt: string | null;
  turns: Array<{ runId: string; words: string | null; status: string; line: string | null; cards: Array<{ kind: string; proposalId: string; title: string; summary: string; status: string }> }>;
}
const conversation = async (request: APIRequestContext, baseURL: string | undefined, id?: string): Promise<ConversationDto> =>
  (await (await request.get(`${baseURL}/api/coach/conversation${id ? `?id=${id}` : ""}`)).json()) as ConversationDto;

test("auto runs in one conversation: an answer in words, then one workout for right now, then a set — read back as the conversation", async ({ context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the journeys share the fixture account: one project is enough");
  test.setTimeout(300_000);
  const request = context.request;
  await signIn(request, baseURL);
  await clearTheCoach(request, baseURL);
  try {
    // 1. A question, answered in words: nothing suggested.
    await model("/use/auto_answer");
    const answered = await ask(request, baseURL, "How are my holds going?", null);
    expect(answered.status).toBe("finished");
    expect(answered.conversationId).toBe(answered.id);
    let conv = await conversation(request, baseURL);
    expect(conv.id).toBe(answered.id);
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0]).toMatchObject({ runId: answered.id, words: "How are my holds going?", status: "finished", cards: [] });
    expect(conv.turns[0]!.line).toContain("Your holds have grown steadily");

    // 2. A reply in the same conversation: one workout for right now.
    await model("/use/auto_design");
    const designed = await ask(request, baseURL, "Something short for right now.", conv.id);
    expect(designed.status).toBe("finished");
    expect(designed.conversationId).toBe(answered.id);
    expect(designed.ceilingUsd).toBe(1.5);
    conv = await conversation(request, baseURL);
    expect(conv.turns.map((t) => t.runId)).toEqual([answered.id, designed.id]);
    const [card] = conv.turns[1]!.cards;
    expect(card).toMatchObject({ kind: "workout", title: "Hips and back, gently", status: "pending" });
    expect(card!.summary).toMatch(/^Today · Now · \d+ min · Maintain$/);
    await request.post(`${baseURL}/api/coach/proposals/${card!.proposalId}/decline`, { data: {} });

    // 3. A stretch of days: plan_set raises the run to a set's ceiling, its designers design each day.
    await model("/use/auto_set");
    const planned = await ask(request, baseURL, "Plan two short sessions this week around my runs.", conv.id);
    expect(planned.status).toBe("finished");
    expect(planned.ceilingUsd).toBe(6);
    expect(planned.estimateUsd).not.toBeNull();
    conv = await conversation(request, baseURL, planned.id);
    expect(conv.id).toBe(answered.id);
    expect(conv.turns.map((t) => t.runId)).toEqual([answered.id, designed.id, planned.id]);
    const set = conv.turns[2]!.cards;
    expect(set).toEqual([expect.objectContaining({ kind: "set", status: "pending", summary: expect.stringMatching(/^2 workouts · /) })]);
    expect(conv.turns[2]!.line).toBe("Two short sessions, spaced around your runs.");
    await request.post(`${baseURL}/api/coach/proposals/${set[0]!.proposalId}/decline`, { data: {} });
  } finally {
    await model("/use/");
    await clearTheCoach(request, baseURL);
  }
});
