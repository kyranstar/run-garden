/**
 * ONCE SWITCH A HAS BEEN ON, EVERY COACH MODEL CALL OF THE ACCOUNT IS ANTHROPIC'S ONLY (R1.5 fix round 1; the review's F1;
 * device-sharing.ts `sharesDaySql`; the routing and its clients: anthropic-pin.test.ts). LifeOS's day frame — and whatever
 * the coach writes after reading it: a workout's name, a proposal, a receipt, a memory, a read — can be anywhere in the
 * account, so the account is pinned, not the text:
 *  - an account that never turned A on: every call routed exactly as before (`order`, no `anthropicOnly`);
 *  - once on: every call — a run's every step, its reviewer's, a new conversation's, a replay, the wake, an activity's read,
 *    the Studio's plan — is `only: ["anthropic"]`, and stays so after A is turned off;
 *  - another account's switch pins nothing here; a phone that only ever said off pins nothing;
 *  - the review's probe: a framed turn's workout reaches the wake, a new conversation, the plan and a matched read — all pinned.
 * Synthetic data, test accounts, scripted model, no network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { enqueueCoachReads, ensureRead, processCoachReads } from "../src/services/coach-reads.js";
import { REPLAY_CONFIRM, replayRun, type ReplayDeps } from "../src/services/coach-replay.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { wake } from "../src/services/coach-wake.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { designContextBuilder } from "../src/services/design-context.js";
import type { DayFrame } from "../src/services/design-frame.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { setSharing } from "../src/services/device-sharing.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { editPlan, generatePlan } from "../src/services/studio-llm.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const { activities, coachProposals } = schema;
const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", AI_GATEWAY_API_KEY: "test-key" } as Env;
const ONLY = { gateway: { only: ["anthropic"] } };
const ORDER = { gateway: { order: ["anthropic"] } };
const VERSION = "2026-11-19.1";

let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

/** Each account's own phone: `native_device_sharing` is keyed by the device id alone, and a live switch pins its account. */
const phoneOf = (userId: string) => `d-${userId}`;
/** The phone's own switch (`PUT /api/native/sharing`'s service): its row and its audit row, in one batch. */
const switchA = (userId: string, on: boolean, deviceId = phoneOf(userId)) => setSharing(db, userId, deviceId, { toTraining: on, disclosureVersion: VERSION }, nowInstant());

const frame = (): DayFrame =>
  ({
    days: [TODAY],
    energy: "low",
    free: { [TODAY]: [{ from: "17:30", to: "19:30" }] },
    dayEnd: "23:00",
    load: { [TODAY]: "full" },
    coverage: { [TODAY]: { planAsOf: NOW.toISOString(), calendarAsOf: NOW.toISOString(), drafted: false } },
    consent: VERSION,
  }) as DayFrame;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_pin${++seq}`, name, input });
const turn = (uses: ContentBlock[], text = "Working on it."): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});
const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = { scores: Object.fromEntries(DIMS.map((d) => [d, 4])), notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: fine.`])), mustFix: [], improvements: [] };

/** A run driven through a proposal, its review and a finish: every request it sent (its reviewer's among them). */
async function aTurn(userId: string, o: { title?: string; framed?: boolean; rehearsal?: boolean } = {}) {
  const run = await createRun(
    db,
    userId,
    {
      scope: { kind: "now" },
      request: "Something calm for the hips.",
      conversationId: null,
      ...(o.rehearsal ? { rehearsal: true } : {}),
      ...(o.framed ? { lifeos: { deviceId: phoneOf(userId), frame: frame() } } : {}),
    },
    NOW,
  );
  const requests: MessagesRequest[] = [];
  const turns: MessagesResult[] = [
    turn([use("propose_workout", { doc: calmDoc({ title: o.title ?? "Calm hips" }), target: { kind: "new", date: TODAY } })]),
    turn([use("submit_review", verdict)]),
    turn([use("finish", { summary: "A calm hips session, ready to approve." })]),
  ];
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
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, run.run.id, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      return out.result.status !== "active";
    },
    { max: 60, what: "drive" },
  );
  return { runId: run.run.id, requests };
}

/** A gateway answering each content in turn as a chat completion (or refusing every call), and the bodies it was sent. */
function chatGateway(contents: unknown[], status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (status !== 200) return new Response("bad request", { status });
    const content = contents.shift();
    if (content === undefined) throw new Error("no more scripted responses");
    const body = { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}
const briefing = { briefing: "Noted.", proposals: [], question: null, memoryOps: [] };
const read = { glance: "Steady and easy.", body: "A steady easy run.", flags: [] };

/** The wake's request: its routing and its text. */
async function wakeRouting(userId: string) {
  const g = chatGateway([briefing]);
  await wake(db, env, userId, await loadPreferences(db, userId), { kind: "manual" }, g.fetchImpl);
  return { routing: g.bodies[0]!.providerOptions, text: JSON.stringify(g.bodies[0]!.messages) };
}
/** An activity's reads' routings: the queue's (a run yesterday, enqueued and read), then one asked for on the page. */
async function readRouting(userId: string) {
  const prefs = await loadPreferences(db, userId);
  const day = addDays(todayInZone(prefs.timezone), -1);
  const run = async () => {
    const id = `act-${newId().slice(0, 8)}`;
    await db.insert(activities).values({
      id, userId, startTime: `${day}T15:00:00Z`, startTimeLocal: `${day}T07:00:00`, sport: "run", durationSeconds: 1800,
      distanceMeters: 5000, sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
    } as typeof activities.$inferInsert);
    return id;
  };
  await run();
  await enqueueCoachReads(db, userId, todayInZone(prefs.timezone));
  const queued = chatGateway([read]);
  await processCoachReads(db, env, userId, prefs, { fetchImpl: queued.fetchImpl });
  const asked = chatGateway([read]);
  await ensureRead(db, env, userId, prefs, await run(), { fetchImpl: asked.fetchImpl });
  expect(asked.bodies.length).toBeGreaterThan(0);
  return [queued.bodies[0]!.providerOptions, asked.bodies[0]!.providerOptions];
}
/** A replay of a finished run's finish: the routing of the body it sends. */
async function replayRouting(userId: string, runId: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const deps: ReplayDeps = {
    send: async (_env, call) => {
      bodies.push(JSON.parse(call.body) as Record<string, unknown>);
      return turn([use("finish", { summary: "Replayed." })]);
    },
    tools: allTools(),
  };
  const out = await replayRun(db, env, userId, { confirm: REPLAY_CONFIRM, runId, variants: [{ id: "a" }] }, deps, () => new Date(NOW.getTime() + 600_000));
  expect(bodies.length, JSON.stringify(out)).toBeGreaterThan(0);
  return bodies[0]!.providerOptions;
}
/** The Studio's plan calls' routings — a plan made, a major revise, a small edit (its gateway refuses: the bodies count). */
async function studioRouting(userId: string) {
  const brief: PlanBrief = { goal: "strength", durationWeeks: 2, sessionsPerWeek: 1, preferredDays: [1], sessionMinutes: 45, equipment: "full gym", constraints: "", notes: "", startDate: "2026-09-07" };
  const catalog = [{ id: "sq-1", name: "Back Squat" }];
  const exercise = { originId: "sq-1", name: "Back Squat", sets: 3, reps: 8, weight: { type: "kg", value: 60 }, restSeconds: 90 };
  const plan = { name: "Plan", brief, weeks: [0, 1].map(() => ({ sessions: [{ title: "Full Body", weekday: 1, exercises: [exercise] }] })) } as unknown as LiftingPlan;
  const routings: unknown[] = [];
  for (const send of [
    (f: typeof fetch) => generatePlan(env, db, userId, brief, catalog, f),
    (f: typeof fetch) => editPlan(env, db, userId, plan, "add more volume", true, catalog, f),
    (f: typeof fetch) => editPlan(env, db, userId, plan, "rename it", false, catalog, f),
  ]) {
    // Its first answer doesn't validate, so it asks once more (its validation retry, a call of its own); that one is refused.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      if (bodies.length > 1) return new Response("bad request", { status: 400 });
      const body = { choices: [{ message: { content: JSON.stringify({ nothing: "valid" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await send(fetchImpl);
    expect(bodies).toHaveLength(2);
    routings.push(...bodies.map((b) => b.providerOptions));
  }
  return routings;
}

describe("an account that never turned switch A on: routed exactly as before (R1.5)", () => {
  it("a run (its steps and its reviewer's), the wake, an activity's read, a replay and the Studio's plan: order, no pin", async () => {
    const { userId } = await seedRichAthlete(db);
    const { runId, requests } = await aTurn(userId);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((r) => !("anthropicOnly" in r))).toBe(true);
    expect((await wakeRouting(userId)).routing).toEqual(ORDER);
    expect(await readRouting(userId)).toEqual([ORDER, ORDER]);
    expect(await replayRouting(userId, runId)).toEqual(ORDER);
    expect(await studioRouting(userId)).toEqual(Array(6).fill(ORDER));
    const rehearsal = await aTurn(userId, { rehearsal: true });
    expect(rehearsal.requests.every((r) => !("anthropicOnly" in r))).toBe(true);
  }, 30_000);

  it("a phone that only ever said off pins nothing; another account's switch pins nothing here", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, false);
    const other = await seedRichAthlete(db);
    await switchA(other.userId, true);
    const { requests } = await aTurn(userId);
    expect(requests.every((r) => !("anthropicOnly" in r))).toBe(true);
    expect((await wakeRouting(userId)).routing).toEqual(ORDER);
  }, 30_000);

  // The review's F3: a run's pin is its account's, or its own frame's — never another tree's live runs'.
  it("a rehearsal run beside a live framed run, on an account whose switch was never on, is routed as before", async () => {
    const { userId } = await seedRichAthlete(db);
    // A framed run left live (asked, never stepped), the switch never on: no route allows it, but no tree's pin spreads.
    await createRun(db, userId, { scope: { kind: "now" }, request: "Today's run, easier.", lifeos: { deviceId: phoneOf(userId), frame: frame() } }, NOW);
    const { requests } = await aTurn(userId, { rehearsal: true });
    expect(requests.every((r) => !("anthropicOnly" in r))).toBe(true);
  }, 30_000);
});

describe("once switch A has been on: every coach call of the account is Anthropic's only (R1.5 fix round 1)", () => {
  it("a new conversation's run (its steps and its reviewer's), the wake, an activity's read, a replay and the Studio's plan", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    const { runId, requests } = await aTurn(userId);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.map((r) => r.anthropicOnly)).toEqual(requests.map(() => true));
    expect((await wakeRouting(userId)).routing).toEqual(ONLY);
    expect(await readRouting(userId)).toEqual([ONLY, ONLY]);
    expect(await replayRouting(userId, runId)).toEqual(ONLY);
    expect(await studioRouting(userId)).toEqual(Array(6).fill(ONLY));
    // A rehearsal (the live scenario suite, its own lane and week) is the account's coach too.
    const rehearsal = await aTurn(userId, { rehearsal: true });
    expect(rehearsal.requests.map((r) => r.anthropicOnly)).toEqual(rehearsal.requests.map(() => true));
  }, 30_000);

  it("turning A off never unpins: what was derived stays in the account", async () => {
    const { userId } = await seedRichAthlete(db);
    await switchA(userId, true);
    await switchA(userId, false);
    const { requests } = await aTurn(userId);
    expect(requests.map((r) => r.anthropicOnly)).toEqual(requests.map(() => true));
    expect((await wakeRouting(userId)).routing).toEqual(ONLY);
    expect(await readRouting(userId)).toEqual([ONLY, ONLY]);
  }, 30_000);

  // The review's probe (review-leak-probe.test.ts), with the switch turned on first, as the route requires before a frame.
  it("the review's probe: a framed turn's workout reaches the wake, a new conversation, the plan and a read — all pinned", async () => {
    const { userId } = await seedRichAthlete(db);
    const prefs = await loadPreferences(db, userId);
    const TITLE = "Easy 25 for a low-energy full day";
    await switchA(userId, true);
    const framed = await aTurn(userId, { framed: true, title: TITLE });
    expect(framed.requests.every((r) => r.anthropicOnly === true)).toBe(true);
    // The wake lists the pending proposal by title: pinned.
    const w1 = await wakeRouting(userId);
    expect([w1.text.includes(TITLE), w1.routing]).toEqual([true, ONLY]);
    // A new conversation's opening lists the open suggestion by title: pinned.
    const later = await aTurn(userId);
    expect(later.requests.every((r) => r.anthropicOnly === true)).toBe(true);
    // Approved: the plan and the thread's receipt hold the title, and the wake reading them is pinned.
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(framed.runId)));
    await approveDesignOps(db, userId, { ...p!, ops: p!.ops as never } as never, {}, { today: TODAY, now: NOW.toISOString(), prefs } as never, Number.POSITIVE_INFINITY);
    const w2 = await wakeRouting(userId);
    expect([w2.text.includes(TITLE), w2.routing]).toEqual([true, ONLY]);
    // An activity's reads: pinned.
    expect(await readRouting(userId)).toEqual([ONLY, ONLY]);
  }, 30_000);
});
