/**
 * COACH EVERYWHERE, PHASE A2 — a follow-up replaces what it changes. A run asked from one of the coach's own suggestions
 * (`focus: { kind: "proposal" }`) that ends with a suggestion supersedes the one it was asked from — in the finish's own
 * supersede statement (design-orchestrate.ts `supersedeOlderPlans`, no statement more), with the reason "Changed: <the
 * athlete's words, clipped>" — so the athlete sees one current suggestion. Only while that suggestion is still open
 * (pending, nothing approved): approved or declined meanwhile, nothing is superseded and the new one stands alone. A set's
 * suggestion is never a focus (the create refuses it: coach-focus.test.ts). No model call is added.
 *
 * The real registry, opening context and loop, driven by a scripted model; no key, no network. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { FOLLOW_UP_WORDS_MAX, followUpOf, followUpReason, SUPERSEDED_REASON, supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
let statements = 0;

beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_fu${++seq}`, name, input });
const turn = (...uses: ContentBlock[]): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: "Working on it." }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});

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

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = () => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, 4])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [],
  improvements: [],
});
const propose = (title: string, date: string) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date } });
/** A now run's whole life: its draft, its review, its finish. */
const designed = (title: string, date: string): MessagesResult[] => [
  turn(propose(title, date)),
  turn(use("submit_review", verdict())),
  turn(use("finish", { summary: `${title}, ready.` })),
];

async function drive(userId: string, runId: string, deps: RunDeps, from: number) {
  let last = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + (from + i) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return last !== "active";
    },
    { max: 40, what: "drive" },
  );
  return last;
}

async function proposalOf(runId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as Array<DocWorkoutOp & { outcome?: Record<string, unknown> }> } : undefined;
}

/** A finished now run and its pending suggestion, "Calm hips" today. */
async function firstSuggestion(userId: string, at: number): Promise<string> {
  const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm." }, new Date(NOW.getTime() + at * 1000))).run.id;
  expect(await drive(userId, runId, scripted(designed("Calm hips", TODAY)).deps, at + 1)).toBe("finished");
  expect((await proposalOf(runId))!.status).toBe("pending");
  return runId;
}

/** A follow-up run from that suggestion, with the athlete's words; its draft "Calm hips, shorter" on `date`. */
async function followUp(userId: string, firstId: string, words: string, date: string, at: number) {
  const created = await createRun(db, userId, { focus: { kind: "proposal", id: designProposalId(firstId) }, request: words }, new Date(NOW.getTime() + at * 1000));
  const { deps, requests } = scripted(designed("Calm hips, shorter", date));
  const status = await drive(userId, created.run.id, deps, at + 1);
  return { runId: created.run.id, status, requests };
}

describe("a follow-up supersedes the suggestion it changes", () => {
  it("open (pending): superseded by the new one, with the athlete's words — even on another day, which the session rule wouldn't cover", async () => {
    const a = await seedRichAthlete(db);
    const first = await firstSuggestion(a.userId, 0);
    // Tomorrow: no "covers" (another date), so only the follow-up's own supersede can close it.
    const fu = await followUp(a.userId, first, "Make it 15 minutes, tomorrow instead", day(-1), 100);
    expect(fu.status).toBe("finished");
    const next = (await proposalOf(fu.runId))!;
    expect(next.status).toBe("pending");
    const old = (await proposalOf(first))!;
    expect(old).toMatchObject({ status: "superseded", supersededBy: designProposalId(fu.runId), resolvedAt: expect.any(String) });
    expect(old.ops[0]!.outcome).toEqual({
      status: "superseded",
      at: expect.any(String),
      reason: "Changed: Make it 15 minutes, tomorrow instead",
      by: designProposalId(fu.runId),
    });
    // The run took the suggestion's own scope (now), and its opening message named what it was asked from.
    const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, fu.runId));
    expect(row!.scope).toEqual({ kind: "now" });
    const opening = JSON.stringify(fu.requests[0]!.messages[0]);
    expect(opening).toContain(`The athlete asked from: your suggestion (id ${designProposalId(first)}), pending`);
    // The reviewer's opening carries no focus block: a sub-run's never does.
    const reviewer = fu.requests.find((r) => JSON.stringify(r.system).includes("# Your role: the independent reviewer"))!;
    expect(JSON.stringify(reviewer.messages[0])).not.toContain("The athlete asked from:");
  });

  it("the same session's day and time: superseded once, with the follow-up's reason — never the session rule's", async () => {
    const a = await seedRichAthlete(db);
    const first = await firstSuggestion(a.userId, 200);
    const fu = await followUp(a.userId, first, "Less on the hips", TODAY, 300);
    expect(fu.status).toBe("finished");
    const old = (await proposalOf(first))!;
    expect(old.status).toBe("superseded");
    expect(old.ops[0]!.outcome).toMatchObject({ status: "superseded", reason: "Changed: Less on the hips" });
    expect(old.ops[0]!.outcome!.reason).not.toBe(SUPERSEDED_REASON);
  });

  it("approved or declined meanwhile: nothing superseded — the new suggestion stands alone", async () => {
    for (const decided of ["approved", "declined"] as const) {
      const a = await seedRichAthlete(db);
      const first = await firstSuggestion(a.userId, 400);
      const p = (await proposalOf(first))!;
      // As the decision writes it (design-approve.ts): the op's outcome and the proposal's status.
      const outcome = decided === "approved" ? { status: "applied", at: NOW.toISOString(), workoutId: "w-x", rev: 1 } : { status: "declined", at: NOW.toISOString() };
      await db
        .update(schema.coachProposals)
        .set({ status: decided, resolvedAt: NOW.toISOString(), ops: p.ops.map((o) => ({ ...o, outcome })) })
        .where(eq(schema.coachProposals.id, designProposalId(first)));
      const before = (await proposalOf(first))!;
      const fu = await followUp(a.userId, first, "Shorter", day(-1), 500);
      expect(fu.status, decided).toBe("finished");
      expect((await proposalOf(fu.runId))!.status, decided).toBe("pending");
      expect(await proposalOf(first), decided).toEqual(before);
    }
  });

  it("a follow-up that stops with what was reviewed (the AI refuses its next call) supersedes it too", async () => {
    const a = await seedRichAthlete(db);
    const first = await firstSuggestion(a.userId, 1200);
    const created = await createRun(db, a.userId, { focus: { kind: "proposal", id: designProposalId(first) }, request: "Gentler" }, new Date(NOW.getTime() + 1_300_000));
    const refused = { ok: false, kind: "rejected", reason: "invalid_request", status: 400 } as MessagesResult;
    const { deps } = scripted([turn(propose("Calm hips, gentler", day(-1))), turn(use("submit_review", verdict())), refused]);
    const status = await drive(a.userId, created.run.id, deps, 1301);
    expect(status).toBe("failed");
    expect((await proposalOf(created.run.id))!.status).toBe("pending");
    const old = (await proposalOf(first))!;
    expect(old.status).toBe("superseded");
    expect(old.ops[0]!.outcome).toMatchObject({ reason: "Changed: Gentler", by: designProposalId(created.run.id) });
  });

  it("a run asked from anything else supersedes only by the session rule, as before", async () => {
    const a = await seedRichAthlete(db);
    const first = await firstSuggestion(a.userId, 600);
    const created = await createRun(db, a.userId, { scope: { kind: "now" }, request: "Shorter", focus: { kind: "move", id: "gobletSquat" } }, new Date(NOW.getTime() + 700_000));
    expect(await drive(a.userId, created.run.id, scripted(designed("Calm hips, shorter", day(-1))).deps, 701)).toBe("finished");
    expect((await proposalOf(first))!.status).toBe("pending");
  });

  it("no statement more: the finish's step costs what a finish without a focus costs (pinned)", async () => {
    const cost = async (focused: boolean, at: number) => {
      const a = await seedRichAthlete(db);
      const first = await firstSuggestion(a.userId, at);
      const created = await createRun(
        db,
        a.userId,
        focused ? { focus: { kind: "proposal", id: designProposalId(first) }, request: "Shorter" } : { scope: { kind: "now" }, request: "Shorter" },
        new Date(NOW.getTime() + (at + 100) * 1000),
      );
      const { deps } = scripted(designed("Calm hips, shorter", day(-1)));
      const counts: number[] = [];
      await untilDone(
        async (i) => {
          statements = 0;
          const out = await runStep(db, env, created.run.id, a.userId, new Date(NOW.getTime() + (at + 101 + i) * 1000), deps);
          counts.push(statements);
          return out.kind === "ok" && out.result.status !== "active";
        },
        { max: 40, what: "cost" },
      );
      return { last: counts.at(-1)!, first, runId: created.run.id };
    };
    const plain = await cost(false, 800);
    const follow = await cost(true, 1000);
    expect(follow.last).toBe(plain.last);
    // …and the follow-up's did supersede, the plain one's didn't (another day).
    expect((await proposalOf(follow.first))!.status).toBe("superseded");
    expect((await proposalOf(plain.first))!.status).toBe("pending");
  });
});

describe("the supersede's one statement, with a follow-up's suggestion", () => {
  const op = (date: string, outcome?: Record<string, unknown>) => ({
    kind: "doc_workout",
    date,
    target: { kind: "new", date },
    doc: calmDoc(),
    by: { runId: `r-${date}` },
    ...(outcome ? { outcome } : {}),
  });
  const row = (id: string, userId: string, status: string, createdAt: string, ops: unknown[]) => ({
    id, userId, planId: null, title: id, evidence: "", rationale: "", flags: [], ops, status, createdAt, expiresAt: day(-5),
  });

  it("supersedes the focus while it is pending — every open op, with the reason — and nothing else it wouldn't have", async () => {
    const a = await seedRichAthlete(db);
    const b = await seedRichAthlete(db);
    const T1 = new Date(NOW.getTime() - 3_600_000).toISOString();
    const T2 = NOW.toISOString();
    const refused = { status: "refused", at: T1, error: "past_time", why: "gone" };
    const ids = { neu: `n-${a.userId}`, focus: `f-${a.userId}`, partial: `p-${a.userId}`, theirs: `t-${b.userId}` };
    await db.insert(schema.coachProposals).values([
      row(ids.neu, a.userId, "pending", T2, [op(day(-3))]),
      // One op open, one refused at approval (still open), one declined (decided: left alone).
      row(ids.focus, a.userId, "pending", T1, [op(day(-1)), op(day(-2), refused), op(day(-4), { status: "declined", at: T1 })]),
      row(ids.partial, a.userId, "partially_approved", T1, [op(day(-1)), op(day(-2), { status: "applied", at: T1, workoutId: "w", rev: 1 })]),
      row(ids.theirs, b.userId, "pending", T1, [op(day(-1))]),
    ]);
    const before = new Map((await db.select().from(schema.coachProposals)).map((p) => [p.id, p]));
    const at = new Date(NOW.getTime() + 60_000).toISOString();
    for (const focused of [ids.partial, ids.theirs]) {
      statements = 0;
      expect(await supersedeOlderPlans(db, a.userId, ids.neu, at, { id: focused, reason: "Changed: x" }), focused).toBe(0);
      expect(statements).toBe(1);
    }
    statements = 0;
    expect(await supersedeOlderPlans(db, a.userId, ids.neu, at, { id: ids.focus, reason: "Changed: shorter" })).toBe(1);
    expect(statements).toBe(1);
    const after = new Map((await db.select().from(schema.coachProposals)).map((p) => [p.id, p]));
    const changed = { status: "superseded", at, reason: "Changed: shorter", by: ids.neu };
    expect((after.get(ids.focus)!.ops as Array<{ outcome?: unknown }>).map((o) => o.outcome)).toEqual([changed, changed, { status: "declined", at: T1 }]);
    expect(after.get(ids.focus)).toMatchObject({ status: "superseded", supersededBy: ids.neu, resolvedAt: at });
    for (const id of [ids.neu, ids.partial, ids.theirs]) expect(after.get(id), id).toEqual(before.get(id));
  });

  it("a set's suggestion is never superseded as a focus, even past the create's refusal (the review, minor 4)", async () => {
    const a = await seedRichAthlete(db);
    const T1 = new Date(NOW.getTime() - 3_600_000).toISOString();
    for (const [i, scope] of ([{ kind: "week" }, { kind: "next_n", n: 3 }, { kind: "now" }] as const).entries()) {
      const runId = `set-${i}-${a.userId}`;
      await db.insert(schema.coachRuns).values({
        id: runId, userId: a.userId, parentId: null, role: "main", scope, request: "x", status: "finished", state: null, steps: 1, costUsd: 0,
        createdAt: T1, updatedAt: T1, finishedAt: T1,
      });
      const focus = `dp-${runId}`;
      const neu = `n-${i}-${a.userId}`;
      await db.insert(schema.coachProposals).values([
        row(focus, a.userId, "pending", T1, [op(day(-1))]),
        row(neu, a.userId, "pending", NOW.toISOString(), [op(day(-3))]),
      ]);
      const changed = await supersedeOlderPlans(db, a.userId, neu, NOW.toISOString(), { id: focus, reason: "Changed: x" });
      // Only a single suggestion (a now run's here) is a follow-up's to replace.
      expect(changed, scope.kind).toBe(scope.kind === "now" ? 1 : 0);
    }
  });

  it("a new suggestion not (yet) pending supersedes nothing, its focus included", async () => {
    const a = await seedRichAthlete(db);
    const T1 = new Date(NOW.getTime() - 3_600_000).toISOString();
    await db.insert(schema.coachProposals).values([
      row(`u-${a.userId}`, a.userId, "unreviewed", NOW.toISOString(), [op(day(-3))]),
      row(`g-${a.userId}`, a.userId, "pending", T1, [op(day(-1))]),
    ]);
    expect(await supersedeOlderPlans(db, a.userId, `u-${a.userId}`, NOW.toISOString(), { id: `g-${a.userId}`, reason: "Changed: x" })).toBe(0);
    expect((await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, `g-${a.userId}`)))[0]!.status).toBe("pending");
  });

  it("only a suggestion's focus is a follow-up: any other kind changes no suggestion", () => {
    expect(followUpOf({ kind: "proposal", id: "dp-r1" }, "Shorter")).toEqual({ id: "dp-r1", reason: "Changed: Shorter" });
    for (const kind of ["workout", "day", "session", "activity", "objective", "move"]) expect(followUpOf({ kind, id: "dp-r1" }, "Shorter"), kind).toBeNull();
    expect(followUpOf(undefined, "Shorter")).toBeNull();
  });

  it("the reason: the athlete's words after 'Changed: ', clipped where they read it; no words, 'Changed.'", () => {
    expect(followUpReason("Make it shorter")).toBe("Changed: Make it shorter");
    expect(followUpReason("  ")).toBe("Changed.");
    expect(followUpReason(null)).toBe("Changed.");
    const long = followUpReason(`${"Swap the bridges for something kinder to the back ".repeat(6)}please`);
    expect(long.startsWith("Changed: Swap the bridges")).toBe(true);
    expect(long.length).toBeLessThanOrEqual("Changed: ".length + FOLLOW_UP_WORDS_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});
