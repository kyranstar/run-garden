/**
 * Objective changes approved (audit fixes, 2026-11-06, E6; principles §2.8 — nothing changes without the athlete's tap):
 * an `objective_change` op is applied ONLY at Approve, each in one atomic write gated on the value the coach read —
 * refused `stale` (nothing written) when the athlete changed it since, recorded applied with nothing written when it is
 * already so; declined like any designed op. The op's outcome is its log — before, after, why, when — read back by
 * read_proposals, the conversation and the thread's receipt. The card shows each change before → after. Synthetic data
 * only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { designedManifest } from "../src/routes/design-proposals.js";
import { coachRoutes } from "../src/routes/coach.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { cardsOf, conversationBlock, conversationRows, namedConversationSql } from "../src/services/coach-conversation.js";
import { APPROVE_FIXED, DECLINE_COST } from "../src/services/design-approve.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { OBJECTIVE_CHANGES_FIXED, objectiveChangeCostOf } from "../src/services/objective-changes.js";
import { createObjective, getObjective, listObjectives, updateObjective } from "../src/services/objectives.js";
import { isObjectiveChangeOp, type ObjectiveChangeOp } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachMessages, coachProposals, coachRuns, keyResults } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const WALL_SIT = { label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" };
const WHY = "Your wall sit is at 45 s of 120 s with half the time gone: 90 s by 1 Dec is the honest target.";

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
  statements = 0;
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

async function objective() {
  const o = await createObjective(db, userId, { title: "Strong legs for the ski trip", keyResults: [WALL_SIT] }, NOW.toISOString());
  return { objectiveId: o.id, krId: o.keyResults[0]!.id };
}

/** A run that proposed `changes` (each propose_objective's input), made pending as a finish makes it. */
async function proposed(changes: Array<Record<string, unknown>>): Promise<{ id: string; ctx: ToolContext }> {
  const runId = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id: runId, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "My legs goal feels out of reach.", status: "finished", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  const ctx: ToolContext = { db, env: makeEnv(), userId, run: { id: runId, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: "toolu_0" };
  const tool = ACT_TOOLS.find((t) => t.name === "propose_objective")!;
  for (const [i, c] of changes.entries()) {
    const r = await tool.run({ ...ctx, toolUseId: `toolu_obj_${i}` }, { why: WHY, basis: "stand", ...c });
    if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  }
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(runId)));
  return { id: designProposalId(runId), ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, makeEnv(), executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements };
}
/** Its objective changes are applied only when named — the card's own Approve names them (E6 review): by default, all of them. */
const approve = async (id: string, body?: unknown) => invoke("POST", `/api/coach/proposals/${id}/approve`, body ?? { opIds: (await opsOf(id)).map((o) => o.id) });
const decline = async (id: string, body?: unknown) => invoke("POST", `/api/coach/proposals/${id}/decline`, body ?? { opIds: (await opsOf(id)).map((o) => o.id) });
const opsOf = async (id: string) => ((await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!.ops as unknown[]).filter(isObjectiveChangeOp) as Array<ObjectiveChangeOp & { outcome?: any }>;

describe("an objective change approved", () => {
  it("retarget: the key result's target written, the op applied with its log — within its declared cost; the receipt names it", async () => {
    const { objectiveId, krId } = await objective();
    const { id } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    // Shown, not applied.
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.status).toBe("approved");
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    const [op] = await opsOf(id);
    expect(op).toMatchObject({ before: 120, after: 90, why: WHY, basis: "stand", outcome: { status: "applied", at: NOW.toISOString() } });
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + OBJECTIVE_CHANGES_FIXED + objectiveChangeCostOf(op!));
    const [msg] = await db.select().from(coachMessages).where(eq(coachMessages.userId, userId));
    expect(msg!.body).toContain("1 change to your objectives");
  });

  it("never by an approve or decline that names nothing (another card's whole-suggestion tap): left open, unchanged (E6 review)", async () => {
    const { objectiveId, krId } = await objective();
    const { id } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    const all = await approve(id, {});
    expect(all.status).toBe(200);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
    expect((await opsOf(id))[0]!.outcome).toBeUndefined();
    expect((await decline(id, {})).status).toBe(200);
    expect((await opsOf(id))[0]!.outcome).toBeUndefined();
    // Named, it applies.
    expect((await approve(id)).json.status).toBe("approved");
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
  });

  it("stale: the athlete changed the target since — refused, nothing written; asked again, still refused", async () => {
    const { objectiveId, krId } = await objective();
    const { id } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    await updateObjective(db, userId, objectiveId, { keyResults: [{ id: krId, ...WALL_SIT, target: 100 }] }, NOW.toISOString());
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(res.json.refused).toEqual([{ opId: `obj-retarget-${krId}`, error: "stale", why: expect.stringContaining("changed since") }]);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(100);
  });

  it("approved twice (a double tap, a crash after the write): no second write", async () => {
    const { krId } = await objective();
    const { id } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    // The write landed but its outcome didn't (a crash): the next approve finds it made.
    await db.update(keyResults).set({ target: 90 }).where(eq(keyResults.id, krId));
    const res = await approve(id);
    expect(res.json.status).toBe("approved");
    expect((await opsOf(id))[0]!.outcome).toMatchObject({ status: "applied" });
  });

  it("each kind applies: a re-date, a key result added, a key result retired, an objective done, an objective added", async () => {
    const { objectiveId, krId } = await objective();
    const other = await createObjective(db, userId, { title: "Zorbex mobility", keyResults: [] }, NOW.toISOString());
    const { id } = await proposed([
      { change: "redate", keyResultId: krId, dueDate: "2027-01-15" },
      { change: "add_key_result", objectiveId, keyResult: { label: "Zorbex side plank", measure: { kind: "hold_max", libraryIds: ["sidePlank"] }, target: 60 } },
      { change: "retire", objectiveId: other.id, status: "dropped" },
      { change: "add_objective", objective: { title: "Zorbex balance", keyResults: [{ label: "Zorbex single-leg stand", measure: { kind: "hold_max", libraryIds: ["sidePlank"] }, target: 45 }] } },
    ]);
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.status).toBe("approved");
    const legs = await getObjective(db, userId, objectiveId);
    expect(legs.keyResults.map((k) => [k.label, k.target, k.dueDate, k.position])).toEqual([["Zorbex wall sit", 120, "2027-01-15", 0], ["Zorbex side plank", 60, null, 1]]);
    expect((await getObjective(db, userId, other.id)).status).toBe("dropped");
    const balance = (await listObjectives(db, userId)).find((o) => o.title === "Zorbex balance")!;
    expect(balance).toMatchObject({ status: "active", keyResults: [{ label: "Zorbex single-leg stand", target: 45, unit: "s" }] });
    // Approved again (its outcomes lost to a crash): each is found made — no duplicate objective, no second key result.
    await db.update(coachProposals).set({ status: "pending", ops: (await opsOf(id)).map(({ outcome: _o, ...op }) => op) }).where(eq(coachProposals.id, id));
    expect((await approve(id)).json.status).toBe("approved");
    expect((await listObjectives(db, userId)).filter((o) => o.title === "Zorbex balance")).toHaveLength(1);
    expect((await getObjective(db, userId, objectiveId)).keyResults).toHaveLength(2);
  });

  it("retire a key result: its row gone, its words kept in the op", async () => {
    const { objectiveId, krId } = await objective();
    const { id } = await proposed([{ change: "retire", keyResultId: krId }]);
    expect((await approve(id)).json.status).toBe("approved");
    expect((await getObjective(db, userId, objectiveId)).keyResults).toEqual([]);
    expect((await opsOf(id))[0]).toMatchObject({ before: { label: "Zorbex wall sit", target: 120, dueDate: "2026-12-01" }, outcome: { status: "applied" } });
  });

  it("declined: nothing changes, within the decline's cost", async () => {
    const { objectiveId, krId } = await objective();
    const { id } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    const res = await decline(id);
    expect(res.status).toBe(200);
    expect(res.total).toBeLessThanOrEqual(DECLINE_COST);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
    expect((await opsOf(id))[0]!.outcome).toMatchObject({ status: "declined" });
  });
});

describe("an objective change, as every reader shows it", () => {
  it("the conversation's card (its own, before → after), the block for the next turn, read_proposals and the suggestion's read", async () => {
    const { krId } = await objective();
    const { id, ctx } = await proposed([{ change: "retarget", keyResultId: krId, target: 90 }]);
    const [op] = await opsOf(id);
    const cards = cardsOf(null, { id, title: "x", status: "pending", ops: [{ kind: "objective_change", opId: op!.id, fixLine: op!.line } as never] }, "2026-10-21");
    expect(cards).toEqual([{ kind: "objectives", proposalId: id, status: "pending", title: "A change to your objectives", summary: "1 change", lines: ["Zorbex wall sit: target 120 s → 90 s"] }]);
    const block = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, ctx.run.id), { limit: 6 }), NOW)!;
    expect(block).toContain(`Suggested 1 change to the athlete's objectives (id ${id}) — still open`);
    expect(block).toContain(`<untrusted from="main coach">Zorbex wall sit: target 120 s → 90 s</untrusted> — still open`);
    const r = await readProposals.run({ db, env: makeEnv(), userId, run: { id: "r", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW }, {});
    if (isToolErr(r)) throw new Error(r.why);
    const ops = (r.data as { proposals: Array<{ ops: Array<Record<string, unknown>> }> }).proposals[0]!.ops;
    expect(ops.find((o) => o.kind === "objective_change")).toMatchObject({
      opId: op!.id, line: { untrusted: true, text: "Zorbex wall sit: target 120 s → 90 s" }, why: { untrusted: true, text: WHY }, basis: "stand",
    });
    const manifest = (await designedManifest(db, userId, id, await opsOf(id), NOW)) as { objectives?: unknown[] };
    expect(manifest.objectives).toEqual([{ opId: op!.id, change: "retarget", title: "Strong legs for the ski trip", line: op!.line, why: WHY, basis: "stand", outcome: null }]);
  });
});
