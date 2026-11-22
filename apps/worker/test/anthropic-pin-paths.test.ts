/**
 * EVERY PATH THAT CAN CARRY LIFEOS'S DAY FRAME INTO A MODEL IS ANTHROPIC'S ONLY (R1.5; DESIGN-3 §3.12.4; the routing and
 * its clients: anthropic-pin.test.ts). The frame reaches a model directly in its turn's opening; text that turn writes
 * reaches later calls through the conversation and the coach's memory. So:
 *  - a framed turn: every call of its tree — the main run's steps, its reviewer's and its designers' — is pinned;
 *  - a later turn of its conversation is pinned (it reads that turn's words), and so is a later one of a pinned turn's;
 *  - memory a pinned call writes is marked (`provenance.frame`), and any call whose input holds a marked item is pinned:
 *    a run whose core holds it, or the moment a run recalls it; the wake; an activity's read;
 *  - a pinned wake's thread messages are marked (`refs.frame`), and a later wake whose thread holds one is pinned.
 * A call with none of these is routed exactly as before: no request asks for the pin. Synthetic data, test accounts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { enqueueCoachReads, processCoachReads } from "../src/services/coach-reads.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { wake } from "../src/services/coach-wake.js";
import { designContextBuilder } from "../src/services/design-context.js";
import type { DayFrame } from "../src/services/design-frame.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, untilDone } from "./helpers.js";

const { coachMemory, coachMessages, coachReads, activities } = schema;
const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", AI_GATEWAY_API_KEY: "test-key" } as Env;

let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

const frame = (): DayFrame =>
  ({
    days: [TODAY],
    energy: "low",
    free: { [TODAY]: [{ from: "17:30", to: "19:30" }] },
    dayEnd: "23:00",
    load: { [TODAY]: "full" },
    coverage: { [TODAY]: { planAsOf: NOW.toISOString(), calendarAsOf: NOW.toISOString(), drafted: false } },
    consent: "2026-11-19.1",
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
const propose = () => use("propose_workout", { doc: calmDoc({ title: "Calm hips" }), target: { kind: "new", date: TODAY } });
const finish = () => use("finish", { summary: "A calm hips session, ready to approve." });

/** A scripted model: each turn in order, and every request it was sent. */
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
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      return out.result.status !== "active";
    },
    { max: 60, what: "drive" },
  );
}

/** A run of the athlete's, framed or not, driven through a proposal, its review and a finish: every request it sent. */
async function aTurn(userId: string, o: { frame?: boolean; conversationId?: string | null; extra?: MessagesResult[] } = {}) {
  const run = await createRun(
    db,
    userId,
    { scope: { kind: "now" }, request: "Something calm for the hips.", ...(o.conversationId !== undefined ? { conversationId: o.conversationId } : {}), ...(o.frame ? { lifeos: { deviceId: "d-1", frame: frame() } } : {}) },
    NOW,
  );
  const { deps, requests } = scripted([...(o.extra ?? []), turn([propose()]), turn([use("submit_review", verdict)]), turn([finish()])]);
  await drive(userId, run.run.id, deps);
  return { runId: run.run.id, requests };
}

const pinned = (rs: MessagesRequest[]) => rs.map((r) => r.anthropicOnly === true);

describe("a framed turn, and what it writes (R1.5)", () => {
  it("every call of a framed turn's tree — its steps and its reviewer's — is Anthropic's only", async () => {
    const { userId } = await seedRichAthlete(db);
    const { requests } = await aTurn(userId, { frame: true });
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(pinned(requests)).toEqual(requests.map(() => true));
  });

  it("a turn without one, in a conversation without one, is routed as before: no request asks for the pin", async () => {
    const { userId } = await seedRichAthlete(db);
    const { requests } = await aTurn(userId, { conversationId: null });
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((r) => !("anthropicOnly" in r))).toBe(true);
  });

  it("a later turn of a framed conversation is pinned, frame or not — and a turn of a new conversation is not", async () => {
    const { userId } = await seedRichAthlete(db);
    const first = await aTurn(userId, { frame: true });
    const later = await aTurn(userId, { conversationId: first.runId });
    expect(pinned(later.requests)).toEqual(later.requests.map(() => true));
    // And a turn after that one (pinned, never framed itself): its words are frame-derived too.
    const third = await aTurn(userId, { conversationId: first.runId });
    expect(pinned(third.requests)).toEqual(third.requests.map(() => true));
    const fresh = await aTurn(userId, { conversationId: null });
    expect(fresh.requests.every((r) => !("anthropicOnly" in r))).toBe(true);
  });

  it("memory a framed turn writes is marked; a later run whose core holds it is pinned", async () => {
    const { userId } = await seedRichAthlete(db);
    const framed = await aTurn(userId, { frame: true, extra: [turn([use("remember", { kind: "fact", body: "Evenings are the athlete's free time on weekdays.", confidence: "inferred", evidence: ["the day's free window"] })])] });
    const item = (await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).find((m) => m.body.startsWith("Evenings are the athlete"));
    expect((item!.provenance as { frame?: unknown; runId?: unknown }).frame).toBe(true);
    expect((item!.provenance as { runId?: unknown }).runId).toBe(framed.runId);
    const later = await aTurn(userId, { conversationId: null });
    expect(pinned(later.requests)).toEqual(later.requests.map(() => true));
  });

  it("an unframed turn's memory is not marked, and recalling a marked note pins the run from that call on", async () => {
    const { userId } = await seedRichAthlete(db);
    const plain = await aTurn(userId, { conversationId: null, extra: [turn([use("remember", { kind: "fact", body: "Likes a long warm-up.", confidence: "inferred", evidence: ["said so"] })])] });
    expect(plain.requests.every((r) => !("anthropicOnly" in r))).toBe(true);
    const mine = (await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).find((m) => m.body === "Likes a long warm-up.");
    expect((mine!.provenance as { frame?: unknown }).frame).toBeUndefined();
    // A note (beyond the core) a framed turn wrote.
    await db.insert(coachMemory).values({
      id: newId(), userId, kind: "note", body: "Tuesday evening is free.", confidence: "inferred", learnedAt: nowInstant(), expiresAt: addDays(TODAY, 5), active: true,
      provenance: { source: "coach_inference", runId: "framed-run", role: "main", at: nowInstant(), frame: true } as never,
    } as typeof coachMemory.$inferInsert);
    const recalled = await aTurn(userId, { conversationId: null, extra: [turn([use("recall_memory", { query: "Tuesday" })])] });
    // The first call recalled it (sent unpinned: it held nothing marked yet); every call after carried it, pinned.
    expect(pinned(recalled.requests)).toEqual(recalled.requests.map((_, i) => i > 0));
  });
});

// ── The wake and the activity reads (chat completions) ───────────────────────────────────────────────────────────────

/** A gateway that answers each body in turn as a chat completion, and the requests' bodies. */
function chatGateway(contents: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    const content = contents.shift();
    if (content === undefined) throw new Error("no more scripted responses");
    const body = { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}
const ONLY = { gateway: { only: ["anthropic"] } };
const ORDER = { gateway: { order: ["anthropic"] } };
const markedNote = (on: Db, userId: string, today: string) =>
  on.insert(coachMemory).values({
    id: newId(), userId, kind: "note", body: "Evenings are free.", confidence: "inferred", learnedAt: nowInstant(), expiresAt: addDays(today, 5), active: true,
    provenance: { source: "coach_inference", runId: "framed-run", role: "main", at: nowInstant(), frame: true } as never,
  } as typeof coachMemory.$inferInsert);

describe("the wake and the activity reads (R1.5)", () => {
  const briefing = (memoryOps: unknown[] = []) => ({ briefing: "Easy day — keep it light.", proposals: [], question: null, memoryOps });

  it("a wake whose memory holds a marked item is pinned; its briefing and memory are marked; the next wake reads them, pinned", async () => {
    const wdb = makeTestDb();
    const { userId, prefs } = await makeTestUser(wdb);
    const today = todayInZone(prefs.timezone);
    // Unmarked: routed as before.
    const before = chatGateway([briefing()]);
    await wake(wdb, env, userId, prefs, { kind: "manual" }, before.fetchImpl);
    expect(before.bodies[0]!.providerOptions).toEqual(ORDER);
    // A marked item: pinned, and what it writes is marked.
    await markedNote(wdb, userId, today);
    const g = chatGateway([{ ...briefing([{ op: "add", kind: "note", text: "Keep evenings easy.", expiresAt: addDays(today, 3) }]), briefing: "Evenings stay easy this week." }]);
    await wake(wdb, env, userId, prefs, { kind: "manual" }, g.fetchImpl);
    expect(g.bodies[0]!.providerOptions).toEqual(ONLY);
    const added = (await wdb.select().from(coachMemory).where(eq(coachMemory.userId, userId))).find((m) => m.body === "Keep evenings easy.")!;
    expect((added.provenance as { frame?: unknown }).frame).toBe(true);
    const [said] = await wdb.select().from(coachMessages).where(eq(coachMessages.body, "Evenings stay easy this week."));
    expect((said!.refs as { frame?: unknown }).frame).toBe(true);
    const [unmarked] = await wdb.select().from(coachMessages).where(eq(coachMessages.body, "Easy day — keep it light."));
    expect((unmarked!.refs as { frame?: unknown } | null)?.frame).toBeUndefined();
    // Every memory item gone: the thread's marked briefing still pins the next wake.
    await wdb.update(coachMemory).set({ active: false }).where(eq(coachMemory.userId, userId));
    const next = chatGateway([briefing()]);
    await wake(wdb, env, userId, prefs, { kind: "manual" }, next.fetchImpl);
    expect(next.bodies[0]!.providerOptions).toEqual(ONLY);
  });

  it("an activity's read whose package holds a marked item is pinned; one without, routed as before", async () => {
    const rdb = makeTestDb();
    const { userId, prefs } = await makeTestUser(rdb);
    const today = todayInZone(prefs.timezone);
    const read = { glance: "Steady and easy.", body: "A steady easy run.", flags: [] };
    const queue = async (id: string) => {
      const day = addDays(today, -1);
      await rdb.insert(activities).values({
        id, userId, startTime: `${day}T15:00:00Z`, startTimeLocal: `${day}T07:00:00`, sport: "run", durationSeconds: 1800, distanceMeters: 5000,
        sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
      } as typeof activities.$inferInsert);
      await enqueueCoachReads(rdb, userId, today);
    };
    await queue("a-plain");
    const plain = chatGateway([read]);
    await processCoachReads(rdb, env, userId, prefs, { fetchImpl: plain.fetchImpl });
    expect(plain.bodies[0]!.providerOptions).toEqual(ORDER);
    await markedNote(rdb, userId, today);
    await queue("a-marked");
    const g = chatGateway([read]);
    await processCoachReads(rdb, env, userId, prefs, { fetchImpl: g.fetchImpl });
    expect(g.bodies[0]!.providerOptions).toEqual(ONLY);
    expect((await rdb.select().from(coachReads).where(eq(coachReads.userId, userId))).map((r) => r.status)).toEqual(["done", "done"]);
  });
});
