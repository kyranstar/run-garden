/**
 * The coach's decisions on each post's trail (import trail phase 3, Task 6; design 2026-11-05 §8.3, §4): when the card
 * is shown, each line about a move writes "the coach suggested it" on every post of its batch that names the move, and
 * each post the run read "the coach read this post" (at the read's own time); approved, declined or replaced, each line
 * writes that too — in the write that decides it. Corrections are suggested the same way. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { DECLINE_COST, MOVE_PINS_FIXED } from "../src/services/design-approve.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { makeTestDb, makeTestUser, mountRoutes, wholeSuggestion } from "./helpers.js";

const { coachProposals, coachRuns, importEvents } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const READ_AT = "2026-10-21T07:55:00.000Z";
const SAVED_AT = "2026-10-20T17:00:00.000Z";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: "k", ALLOWED_GOOGLE_EMAIL: "a@b.c", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key", COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (statements += 1) });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const LIFT = savedMoveDraft("Zorbex hip lift", { quotes: [{ field: "purpose", text: "for stiff hips after easy runs", at: 72, from: "transcript", check: "verified" }] });
const NOD = savedMoveDraft("Zorbex neck nod", { regions: ["neck"] });

/** Post 0: the lift, the goblet squat, the nod. Post 1: the lift again. */
async function batch() {
  const seeded = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ draft: LIFT }, { library: "gobletSquat" }, { draft: NOD }] }, { moves: [{ draft: LIFT }] }] });
  const [lift, , nod] = seeded.moveIds[0]!;
  return { batchId: seeded.batchId, p0: seeded.postIds[0]!, p1: seeded.postIds[1]!, lift: lift!, nod: nod! };
}

async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Fit the new moves from my saves.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

const tool = (name: string) => ACT_TOOLS.find((t) => t.name === name)!;
const lines = (b: Awaited<ReturnType<typeof batch>>) => [
  { moveId: b.lift, text: "She says it's for stiff hips after easy runs.", cites: ["q1.1"] },
  { moveId: b.nod, text: "Your neck care covers it.", cites: ["history"] },
];

/** A fit's card, shown: pin_moves after a read, then promoted as a finish promotes it (pending, then the supersede). */
async function shown(b: Awaited<ReturnType<typeof batch>>, input: Record<string, unknown> = {}): Promise<{ id: string; ctx: ToolContext }> {
  const ctx = await mainRun();
  await readSavesInRun(db, ctx, {}, READ_AT);
  const r = await tool("pin_moves").run(ctx, { batchId: b.batchId, pin: [b.lift], title: "One in", why: "The lift fills the hip work.", lines: lines(b), ...input });
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  const id = designProposalId(ctx.run.id);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
  await supersedeOlderPlans(db, userId, id, new Date().toISOString(), null, undefined, { saves: true });
  return { id, ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  body = await wholeSuggestion(db, path, body);
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, makeEnv(), executionCtx as never);
  await Promise.all(pending);
  return { status: res.status, total: statements };
}

const coachEvents = async (postId: string) =>
  (await db.select().from(importEvents).where(and(eq(importEvents.userId, userId), eq(importEvents.postId, postId), eq(importEvents.stage, "coach")))).map((e) => ({
    source: e.source, moveId: e.moveId, summary: e.summary, at: e.at, proposalId: e.proposalId,
  }));

describe("the coach's decisions on each post's trail", () => {
  it("shown: each line suggested on every post naming its move, each post read at the read's time; approved, each line approved — the account's line is the latest", async () => {
    const b = await batch();
    const { id } = await shown(b);
    // REBASED 2026-11-06 (audit fixes, E4): the words say what was decided — "Coach: put in — where · dose — why",
    // "Coach: leave out — why" — and where is the tool's (E7).
    const suggestedLift = "Coach: put in — joins your rotation · 6–10 reps — She says it's for stiff hips after easy runs.";
    const suggestedNod = "Coach: leave out — Your neck care covers it.";
    expect((await coachEvents(b.p0)).sort((x, y) => x.summary.localeCompare(y.summary))).toEqual([
      { source: "coach", moveId: null, summary: "The coach read this post", at: READ_AT, proposalId: id },
      { source: "coach", moveId: b.lift, summary: suggestedLift, at: NOW.toISOString(), proposalId: id },
      { source: "coach", moveId: b.nod, summary: suggestedNod, at: NOW.toISOString(), proposalId: id },
    ].sort((x, y) => x.summary.localeCompare(y.summary)));
    // The lift is in the second post too.
    expect((await coachEvents(b.p1)).map((e) => e.summary).sort()).toEqual(["The coach read this post", suggestedLift].sort());

    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.status).toBe(200);
    const after = await coachEvents(b.p0);
    expect(after.filter((e) => e.source === "owner").map((e) => [e.moveId, e.summary])).toEqual(
      expect.arrayContaining([
        [b.lift, "You approved: put in — joins your rotation · 6–10 reps"],
        [b.nod, "You approved: leave out"],
      ]),
    );
    // The trail's account takes each move's latest coach step (trail-model.ts): the owner's approval, last, by its time.
    const trail = (await readPostTrail(db, userId, b.p0))!;
    const latest = new Map<string, string>();
    for (const e of trail.events.filter((x) => x.stage === "coach")) latest.set(e.moveId ?? e.id, e.summary);
    expect(latest.get(b.lift)).toMatch(/^You approved: put in /);
    expect(latest.get(b.nod)).toBe("You approved: leave out");
  });

  it("declined: each line says not now, in the decline's own write", async () => {
    const b = await batch();
    const { id } = await shown(b);
    const res = await invoke("POST", `/api/coach/proposals/${id}/decline`, {});
    expect(res.status).toBe(200);
    expect(res.total).toBeLessThanOrEqual(DECLINE_COST);
    expect((await coachEvents(b.p0)).filter((e) => e.source === "owner").map((e) => e.summary).sort()).toEqual([
      "You said not now: put in — joins your rotation · 6–10 reps",
      "You said not now: leave out",
    ].sort());
  });

  it("replaced by a newer card naming the same move: the older card's lines say so", async () => {
    const b = await batch();
    const { id: older } = await shown(b);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const { id: newer } = await shown(b);
    expect(newer).not.toBe(older);
    const replaced = (await coachEvents(b.p0)).filter((e) => e.summary.startsWith("Replaced by a newer suggestion"));
    expect(replaced.map((e) => [e.proposalId, e.moveId])).toEqual(expect.arrayContaining([[older, b.lift], [older, b.nod]]));
    // The controller's fix pass, E13: the newer card's own lines come after the older's "replaced" at the same moment —
    // so the trail's latest word on each move is the newer card's suggestion, never "Replaced".
    const trail = await readPostTrail(db, userId, b.p0);
    const latest = new Map<string, { summary: string; proposalId: string | null }>();
    for (const e of trail!.events) if (e.stage === "coach" && e.moveId) latest.set(e.moveId, { summary: e.summary, proposalId: e.proposalId ?? null });
    for (const moveId of [b.lift, b.nod]) {
      expect(latest.get(moveId)!.summary, moveId).toMatch(/^Coach: /);
      expect(latest.get(moveId)!.proposalId, moveId).toBe(newer);
    }
  });

  it("a card with no batch writes nothing on any trail", async () => {
    const b = await batch();
    const ctx = await mainRun();
    const r = await tool("pin_moves").run(ctx, { pin: ["gobletSquat"], title: "Squats stay", summary: "One move kept", why: "Legs.", lines: [{ moveId: "gobletSquat", text: "Your legs need it." }] });
    if (isToolErr(r)) throw new Error(r.why);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    await supersedeOlderPlans(db, userId, id, new Date().toISOString(), null, undefined, { saves: true });
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, {})).status).toBe(200);
    expect(await coachEvents(b.p0)).toEqual([]);
  });

  it("a card stored before lines had decisions still writes its words", async () => {
    const b = await batch();
    const { id } = await shown(b);
    const ops = (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!.ops as Array<Record<string, unknown>>;
    const plain = ops.map((o) => (o.kind === "move_pins" ? { ...o, lines: [{ moveId: b.lift, name: "Zorbex hip lift", text: "In rotation." }] } : o));
    await db.update(coachProposals).set({ ops: plain }).where(eq(coachProposals.id, id));
    expect((await invoke("POST", `/api/coach/proposals/${id}/approve`, {})).status).toBe(200);
    expect((await coachEvents(b.p0)).filter((e) => e.source === "owner").map((e) => e.summary)).toEqual(["You approved: In rotation."]);
  });

  it("a correction shown is suggested on each post it touches", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx, {}, READ_AT);
    const r = await tool("correct_import").run(ctx, { target: "move", targetId: b.lift, field: "name", after: "Zorbex hip raise", why: "The caption names it so.", basis: "evidence", cites: ["history"] });
    if (isToolErr(r)) throw new Error(r.why);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    await supersedeOlderPlans(db, userId, id, new Date().toISOString(), null, undefined, { saves: true });
    for (const post of [b.p0, b.p1]) {
      expect((await coachEvents(post)).map((e) => e.summary)).toContain("The coach suggested a correction — Name of Zorbex hip lift: Zorbex hip raise (was Zorbex hip lift)");
    }
  });

  it("the costs: the pins' fixed part holds their trail write, the decline its own, and the supersede one statement more", async () => {
    expect(MOVE_PINS_FIXED).toBe(4);
    expect(DECLINE_COST).toBe(8);
    const b = await batch();
    const { id } = await shown(b);
    statements = 0;
    await supersedeOlderPlans(db, userId, id, new Date().toISOString(), null, undefined, { saves: true });
    // The supersede's update and the coach's trail (nothing to release: no older card).
    expect(statements).toBe(2);
  });
});
