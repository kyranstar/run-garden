/**
 * THE MOVES IN ROTATION, CHANGED BY THE COACH (saved-posts import, Task 18): pin_moves stores one `move_pins` op — the
 * moves to pin and unpin, the saves batch it fits in, and the coach's own words for the card — refusing an id that isn't
 * a move the athlete is offered (a move still waiting in an unsaved batch, an archived or merged one, an unknown id) and
 * anything during a restore. Approved, the pins are written in one batched upsert a twenty ids (the engine pool then
 * holds a pinned personal move) and the batch is marked fitted in; an id archived since is skipped with a line, never
 * refused. Every reader of designed proposals tolerates the kind — the conversation's card and block, the manifest,
 * read_proposals, the cover rule, the Coach button's current run, decline — and the prompt carries the integration
 * guidance. A Wednesday morning in UTC (Date faked). Synthetic data only (example.com, made-up names).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES } from "@rg/exercise-library";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { forgetAccountLibrary, loadAccountLibrary } from "../src/services/account-library.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { conversationBlock, conversationRows, namedConversationSql, readConversation } from "../src/services/coach-conversation.js";
import { currentRun, endedLine } from "../src/services/coach-runs.js";
import { markUntrusted, PROMPT_TOOL_NAMES, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { APPROVE_FIXED, MOVE_PINS_FIXED, movePinsCostOf, REQUEST_BUDGET, type DesignedPinsOp } from "../src/services/design-approve.js";
import { designedManifest } from "../src/routes/design-proposals.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { proposalFields } from "../src/services/design-review.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { pinsId } from "../src/services/proposal-kinds.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { accountState, coachMessages, coachProposals, coachRuns, exercisePrefs, personalMoves, saveBatches } = schema;
/** A Wednesday morning in UTC. */
const NOW = new Date("2026-10-21T08:00:00.000Z");
const TODAY = "2026-10-21";
const SAVED_AT = "2026-10-20T17:00:00.000Z";

const tool = () => ACT_TOOLS.find((t) => t.name === "pin_moves")!;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key",
    COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;
/** A test's own look at each statement's SQL, while it is set. */
let watch: ((sql: string) => unknown) | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = 0;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (q) => {
      statements += 1;
      watch?.(q);
    },
  });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});

afterEach(() => {
  watch = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = savedMoveDraft("Zorbex hip circle");
const B = savedMoveDraft("Zorbex neck nod", { regions: ["neck"], summary: "A small nod, chin tucked." });
const GOBLET = EXERCISES.find((e) => e.id === "gobletSquat")!;
const DEAD_BUG = EXERCISES.find((e) => e.id === "deadBug")!;

/** A saved batch of one routine post: A, the library's goblet squat, B — and A's and B's ids. */
async function batch(owner = userId, status: "saved" | "released" = "saved") {
  const seeded = await seedSavedBatch(db, owner, { savedAt: SAVED_AT, status, posts: [{ moves: [{ draft: A }, { library: "gobletSquat" }, { draft: B }] }] });
  const [a, , b] = seeded.moveIds[0]!;
  return { batchId: seeded.batchId, a: a!, b: b! };
}

/** A main run and its tool context. */
async function mainRun(request = "Fit the new moves from my saves into my training."): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request, status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

const WORDS = {
  title: "Two saved moves into your rotation",
  summary: "Hip circle and goblet squats in; the neck nod waits",
  lines: [
    "Zorbex hip circle — in rotation: it opens the hips your Thursday runs tighten.",
    "Goblet squat — in rotation: your strength days lack a squat.",
    "Zorbex neck nod — left in your library: your neck care already covers it.",
  ],
  why: "Two of the new moves serve your hips and legs; the third repeats your care.",
};

async function pins(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await tool().run(ctx, { ...WORDS, ...input });
  return { res, count: statements };
}

const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const opOf = async (id: string) => ((await proposalOf(id)).ops as unknown[]).find((o) => (o as { kind?: string }).kind === "move_pins") as DesignedPinsOp;

/** Pins proposed and made pending, as the finish makes them. */
async function proposed(input: Record<string, unknown>): Promise<{ id: string; ctx: ToolContext }> {
  const ctx = await mainRun();
  ok((await pins(ctx, input)).res);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
  return { id: designProposalId(ctx.run.id), ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements };
}

/** Approve until nothing remains: each request's answer and cost. */
async function approveAll(id: string, opIds?: string[]) {
  const answers: Array<Record<string, any>> = [];
  const costs: number[] = [];
  let remaining: string[] | null = opIds ?? null;
  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    answers.push(res.json);
    costs.push(res.total);
    remaining = res.json.remaining as string[];
    if (remaining.length === 0) break;
  }
  return { answers, costs };
}

const pinnedIds = async (owner = userId): Promise<string[]> =>
  (await db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, owner), eq(exercisePrefs.pinned, true)))).map((r) => r.exerciseId).sort();
const fittedAt = async (batchId: string) => (await db.select().from(saveBatches).where(eq(saveBatches.id, batchId)))[0]!.fittedAt;

describe("pin_moves: the coach keeps a saved move in rotation", () => {
  it("stores one move_pins op — the moves, the batch, the coach's words, today — in two statements; nothing pinned yet", async () => {
    const { batchId, a } = await batch();
    const ctx = await mainRun();
    const { res, count } = await pins(ctx, { pin: [a, "gobletSquat"], batchId });
    const stored = ok(res);
    expect(tool().statementCost).toBe(2);
    expect(count).toBe(2);
    expect(tool().roles).toEqual(["main"]);
    const id = designProposalId(ctx.run.id);
    expect(stored.data).toMatchObject({ stored: true, proposalId: id, opId: pinsId(ctx.run.id), pin: [a, "gobletSquat"], unpin: [], batchId });
    const op = await opOf(id);
    expect(op).toMatchObject({
      kind: "move_pins",
      id: pinsId(ctx.run.id),
      pin: [a, "gobletSquat"],
      unpin: [],
      batchId,
      why: WORDS.why,
      title: WORDS.title,
      summary: WORDS.summary,
      lines: WORDS.lines,
      date: TODAY,
      toolUseId: ctx.toolUseId,
    });
    expect(pinsId("run-1")).toBe("pins-run-1");
    // Named by its own title; it waits PLAN_EXPIRY_DAYS for the athlete, as a programme change does.
    expect(proposalFields((await proposalOf(id)).ops as unknown[])).toMatchObject({ title: WORDS.title, rationale: WORDS.why, expiresAt: "2026-10-24" });
    expect(await pinnedIds()).toEqual([]);
    expect(await fittedAt(batchId)).toBeNull();
  });

  it("refuses an id that isn't a move the athlete is offered — pending, archived, merged, unknown — a batch not theirs or not saved, and anything during a restore: nothing stored", async () => {
    const { batchId, a, b } = await batch();
    const other = (await makeTestUser(db, { timezone: "UTC" })).userId;
    const theirs = await batch(other);
    const released = await batch(userId, "released");
    // A move waiting in a batch not yet saved; one archived; one merged into another.
    await db.update(personalMoves).set({ status: "pending" }).where(eq(personalMoves.id, released.a));
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, b));
    await db.update(personalMoves).set({ status: "merged", mergedInto: a }).where(eq(personalMoves.id, released.b));
    const ctx = await mainRun();
    const refusal = async (input: Record<string, unknown>, c: ToolContext = ctx) => {
      const { res } = await pins(c, input);
      if (!isToolErr(res)) throw new Error(`stored: ${JSON.stringify(input)}`);
      return `${res.error}: ${res.why}`;
    };
    expect(await refusal({ pin: [released.a] })).toMatch(/^not_a_move: /);
    expect(await refusal({ pin: [a, b] })).toMatch(new RegExp(`^not_a_move: "${b}"`));
    expect(await refusal({ unpin: [released.b] })).toMatch(/^not_a_move: /);
    expect(await refusal({ pin: ["noSuchMove"] })).toMatch(/^not_a_move: "noSuchMove"/);
    // Another account's personal move reads as one nobody has.
    expect(await refusal({ pin: [theirs.a] })).toMatch(/^not_a_move: /);
    expect(await refusal({ pin: [a], unpin: [a] })).toMatch(/^invalid_input: .*both pin and unpin/);
    expect(await refusal({})).toMatch(/^invalid_input: No move to pin or unpin/);
    expect(await refusal({ pin: [], unpin: [] })).toMatch(/^invalid_input: No move to pin or unpin/);
    expect(await refusal({ pin: EXERCISES.slice(0, 21).map((e) => e.id) })).toMatch(/^invalid_input: /);
    expect(await refusal({ pin: [a], lines: [] })).toMatch(/^invalid_input: /);
    // A batch of another account's, one not saved, one nobody has: the same words.
    const batchWords = async (id: string) => (await refusal({ pin: [a], batchId: id })).replace(id, "X");
    expect(await batchWords("batch-nobody-has")).toMatch(/^bad_batch: /);
    expect(await batchWords(theirs.batchId)).toBe(await batchWords("batch-nobody-has"));
    expect(await batchWords(released.batchId)).toBe(await batchWords("batch-nobody-has"));
    // A designer's run may not.
    const designer: ToolContext = { ...ctx, run: { ...ctx.run, role: "designer", parentId: ctx.run.id } };
    expect(await refusal({ pin: [a] }, designer)).toMatch(/^not_for_role: /);
    // A restore under way.
    await db.insert(accountState).values({ userId, restoreId: "restore-1", updatedAt: NOW.toISOString() });
    expect(await refusal({ pin: [a], batchId })).toMatch(/^restoring: /);
    expect(await db.select().from(coachProposals)).toEqual([]);
  });

  it("a second call replaces the first; a replay of a call answers what it stored; one already with the athlete is refused", async () => {
    const { batchId, a } = await batch();
    const ctx = await mainRun();
    const first = { ...ctx, toolUseId: "toolu_first" };
    ok((await pins(first, { pin: [a], batchId })).res);
    ok((await pins({ ...ctx, toolUseId: "toolu_second" }, { pin: [a, "gobletSquat"], unpin: ["deadBug"], batchId })).res);
    const ops = (await proposalOf(designProposalId(ctx.run.id))).ops as DesignedPinsOp[];
    expect(ops.map((o) => [o.id, o.pin, o.unpin])).toEqual([[pinsId(ctx.run.id), [a, "gobletSquat"], ["deadBug"]]]);
    expect(ops[0]!.replaces).toEqual(["toolu_first"]);
    const replay = ok((await pins(first, { pin: [a], batchId })).res);
    expect(replay.data).toMatchObject({ superseded: true });
    const again = ok((await pins({ ...ctx, toolUseId: "toolu_second" }, { pin: [a], batchId })).res);
    expect(again.data).toMatchObject({ stored: true, pin: [a, "gobletSquat"] });
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    const { res } = await pins({ ...ctx, toolUseId: "toolu_third" }, { pin: [a] });
    expect(isToolErr(res) && res.error).toBe("proposal_pending");
  });
});

describe("approving the moves in rotation", () => {
  it("pins two moves — the engine pool then holds the personal one — marks the batch fitted in, writes one receipt; asked again, settled", async () => {
    const { batchId, a, b } = await batch();
    const { id } = await proposed({ pin: [a, "gobletSquat"], batchId });
    forgetAccountLibrary(db, userId);
    expect((await loadAccountLibrary(db, userId)).engine.some((e) => e.id === a)).toBe(false);
    const { answers, costs } = await approveAll(id);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ status: "approved", refused: [], remaining: [], pinned: [{ opId: pinsId(id.slice(3)), summary: "2 moves kept in rotation" }] });
    // Measured, exactly what it declares: the approve's own part (the session and its restore check, the proposal, the
    // preferences, the plan read, the proposal's write, the receipt) and the op's — the library and pins read, one
    // upsert, the batch marked.
    expect(movePinsCostOf({ pin: [a, "gobletSquat"], unpin: [] })).toBe(3);
    expect(costs).toEqual([APPROVE_FIXED + 3]);
    expect(await pinnedIds()).toEqual([a, "gobletSquat"].sort());
    forgetAccountLibrary(db, userId);
    const library = await loadAccountLibrary(db, userId);
    expect(library.engine.some((e) => e.id === a)).toBe(true);
    // The other new move stays offered, out of the engine's pool.
    expect(library.engine.some((e) => e.id === b)).toBe(false);
    expect(library.offered.some((e) => e.id === b)).toBe(true);
    expect(await fittedAt(batchId)).toBe(NOW.toISOString());
    expect((await opOf(id)).outcome).toEqual({ status: "applied", at: NOW.toISOString(), pinned: [a, "gobletSquat"], unpinned: [], lines: [] });
    const receipts = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")));
    expect(receipts.map((r) => r.body)).toEqual([`✓ approved — ${WORDS.title}: 2 moves kept in rotation`]);
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.json).toMatchObject({ status: "approved", settled: [{ opId: pinsId(id.slice(3)), outcome: "applied" }], remaining: [] });
  });

  it("an unpin takes a move out of rotation; an id archived since is skipped with a line, an unpin of a move not in rotation is a line, a batch no longer saved is not marked", async () => {
    const { batchId, a, b } = await batch();
    await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ library: "gobletSquat" }] }], pinned: ["gobletSquat"] });
    const { id } = await proposed({ pin: [a, b], unpin: ["gobletSquat", "deadBug"], batchId });
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, b));
    await db.update(saveBatches).set({ status: "dismissed" }).where(eq(saveBatches.id, batchId));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)).toMatchObject({ status: "approved", refused: [] });
    expect((await opOf(id)).outcome).toEqual({
      status: "applied",
      at: NOW.toISOString(),
      pinned: [a],
      unpinned: ["gobletSquat"],
      lines: ["Zorbex neck nod — not in your library any more, skipped", `${DEAD_BUG.name} — wasn't in rotation`, "Its saves batch is no longer saved — not marked fitted in"],
    });
    expect(await pinnedIds()).toEqual([a]);
    expect(await fittedAt(batchId)).toBeNull();
    expect(GOBLET.name).toBeTruthy();
  });

  it("refused, never for a skip: a batch that is another account's — nothing written, the op still open", async () => {
    const { a } = await batch();
    const other = (await makeTestUser(db, { timezone: "UTC" })).userId;
    const theirs = await batch(other);
    const { id } = await proposed({ pin: [a] });
    // The op as stored names another account's batch (nothing the tool writes: a tampered row).
    const op = await opOf(id);
    await db.update(coachProposals).set({ ops: [{ ...op, batchId: theirs.batchId }] }).where(eq(coachProposals.id, id));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)!.refused).toEqual([{ opId: op.id, error: "bad_batch", why: "That saves batch isn't the athlete's." }]);
    expect(await pinnedIds()).toEqual([]);
    expect(await fittedAt(theirs.batchId)).toBeNull();
    expect((await proposalOf(id)).status).toBe("pending");
  });

  it("refused when the account's library can't be read — nothing written, the op still open", async () => {
    const { a } = await batch();
    const { id } = await proposed({ pin: [a] });
    watch = (q) => {
      if (q.includes("pm_lib") && q.includes("pinned_now")) throw new Error("D1_ERROR: the read failed");
    };
    const { answers } = await approveAll(id);
    watch = null;
    expect(answers.at(-1)!.refused).toEqual([{ opId: (await opOf(id)).id, error: "library_unreadable", why: "The athlete's library couldn't be read just now — try again." }]);
    expect(await pinnedIds()).toEqual([]);
    expect((await proposalOf(id)).status).toBe("pending");
  });

  it("its declared cost: two, and one a twenty ids; forty ids in one request within 45, measured exactly", async () => {
    expect(MOVE_PINS_FIXED).toBe(2);
    expect(movePinsCostOf({ pin: ["x"], unpin: [] })).toBe(3);
    expect(movePinsCostOf({ pin: Array.from({ length: 20 }, (_, i) => `p${i}`), unpin: [] })).toBe(3);
    expect(movePinsCostOf({ pin: Array.from({ length: 20 }, (_, i) => `p${i}`), unpin: ["u"] })).toBe(4);
    const ids = EXERCISES.slice(0, 40).map((e) => e.id);
    // The twenty to unpin are pinned already.
    await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ library: ids[20]! }] }], pinned: ids.slice(20) });
    const { id } = await proposed({ pin: ids.slice(0, 20), unpin: ids.slice(20) });
    const { answers, costs } = await approveAll(id);
    expect(answers.at(-1)!.status).toBe("approved");
    // The approve's own, the read and two upserts (no batch to mark: none named) — within what it declares (four).
    expect(costs).toEqual([APPROVE_FIXED + 3]);
    expect(costs[0]!).toBeLessThanOrEqual(APPROVE_FIXED + movePinsCostOf({ pin: ids.slice(0, 20), unpin: ids.slice(20) }));
    expect(costs[0]!).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(await pinnedIds()).toEqual(ids.slice(0, 20).sort());
  });

  it("Not now declines it; nothing pinned, the batch not marked", async () => {
    const { batchId, a } = await batch();
    const { id } = await proposed({ pin: [a], batchId });
    const decline = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [pinsId(id.slice(3))] });
    expect(decline.json).toMatchObject({ status: "declined", declined: [pinsId(id.slice(3))] });
    expect(await pinnedIds()).toEqual([]);
    expect(await fittedAt(batchId)).toBeNull();
    expect((await opOf(id)).outcome?.status).toBe("declined");
  });
});

describe("every reader tolerates the moves in rotation", () => {
  it("the conversation: one card — kind pins, its op, its lines — and the block's line for the model", async () => {
    const { batchId, a } = await batch();
    const { ctx } = await proposed({ pin: [a], batchId });
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, ctx.run.id));
    const conv = await readConversation(db, userId, NOW, { endedLine });
    const cards = conv.turns.at(-1)!.cards;
    expect(cards.map((c) => [c.kind, c.opId, c.title, c.summary])).toEqual([["pins", pinsId(ctx.run.id), WORDS.title, WORDS.summary]]);
    expect(cards[0]!.lines).toEqual(WORDS.lines);
    const block = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, ctx.run.id), { limit: 6 }), NOW)!;
    expect(block).toContain(
      `Suggested moves to keep in rotation (id ${designProposalId(ctx.run.id)}): ${markUntrusted("main coach", WORDS.title)} · ${markUntrusted("main coach", WORDS.summary)} — still open`,
    );
  });

  it("the manifest's pins part, read_proposals, and the Coach button's current run", async () => {
    const { batchId, a } = await batch();
    const { id, ctx } = await proposed({ pin: [a], unpin: ["deadBug"], batchId });
    const manifest = await designedManifest(db, userId, id, (await proposalOf(id)).ops, NOW);
    expect(manifest).toMatchObject({
      lines: [],
      changes: [],
      pins: [{ opId: pinsId(ctx.run.id), title: WORDS.title, summary: WORDS.summary, lines: WORDS.lines, why: WORDS.why, pin: [a], unpin: ["deadBug"], issues: [], outcome: null }],
    });
    const read = ok(await readProposals.run(ctx, {}));
    const text = JSON.stringify(read.data);
    expect(text).toContain('"kind":"move_pins"');
    expect(text).toContain(JSON.stringify({ untrusted: true, text: WORDS.title }).slice(1, -1));
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, ctx.run.id));
    const current = await currentRun(db, userId, NOW);
    expect(current?.run.id).toBe(ctx.run.id);
    expect(current?.proposal?.id).toBe(id);
  });

  it("the cover rule: a newer suggestion naming one of an older's moves supersedes it; one naming none leaves it", async () => {
    const { a, b } = await batch();
    const older = await proposed({ pin: [a, "gobletSquat"] });
    const apart = await proposed({ pin: ["deadBug"] });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const newer = await proposed({ pin: [b], unpin: [a] });
    await supersedeOlderPlans(db, userId, newer.id, new Date().toISOString());
    expect((await proposalOf(older.id)).status).toBe("superseded");
    expect((await opOf(older.id)).outcome?.status).toBe("superseded");
    expect((await proposalOf(apart.id)).status).toBe("pending");
    expect((await opOf(apart.id)).outcome).toBeUndefined();
  });
});

describe("the prompt", () => {
  it("names pin_moves in one acting line and carries the integration guidance, word for word, in one paragraph", () => {
    expect(PROMPT_TOOL_NAMES).toContain("pin_moves");
    const acting = SHARED_PROMPT.slice(SHARED_PROMPT.indexOf("Acting:\n"), SHARED_PROMPT.indexOf("Reading results:\n"));
    expect(acting.split("\n").filter((l) => l.startsWith("- pin_moves:"))).toHaveLength(1);
    const guidance =
      "When the athlete asks to fit in moves from their saves, place them inside what they already do — revise upcoming workouts, keep a move in rotation with pin_moves, change the programme only if the week needs it — rather than adding sessions. Respect the week's load, their objectives and their conditions. One line per placement saying why. Ask at most two questions first, only when the answer changes the plan.";
    const selectivity =
      "Not every saved move belongs. Take the ones that serve the athlete's objectives, conditions and the week's load; leave the rest in their library and say in one line each why. When a post says when or why to do a move, carry that into the notes of the workout you revise, so the reason travels with the session.";
    expect(SHARED_PROMPT).toContain(`${guidance} ${selectivity}`);
    expect(SHARED_PROMPT).toContain("# Integrating saved moves\n");
  });
});
