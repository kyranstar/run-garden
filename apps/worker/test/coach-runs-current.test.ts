/**
 * `GET /api/coach/runs/current` (Stage 3 Task 9): what the Studio shows when it opens — the athlete's newest live main
 * run; else the newest main run that is over whose design proposal still has an open op (pending, or partially
 * approved with an op undecided or refused); else nothing. Never a rehearsal's run, never a sub-run, never another
 * athlete's. Its last 50 events come with it, in order, and the proposal it holds open (its id, status and flags).
 *
 * Also the run's own figures the run view shows: the set's estimate (`RunState.estimate`, Task 7) and the run's ceiling.
 *
 * Gated with every other run route (a 404 with the coach designer off), and within the free plan's budget: pinned.
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { CURRENT_RUN_EVENTS, CURRENT_RUN_STATEMENTS, newRunState, ROUTE_OVERHEAD, type RunDeps } from "../src/services/coach-runs.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...extra,
  } as Env;
}
const ON = makeEnv({ COACH_DESIGNER: "1" });
const OFF = makeEnv();

const deps = (): RunDeps => ({
  callModel: async () => {
    throw new Error("no model call here");
  },
  buildContext: { statementCost: 0, build: async () => ({ system: [], header: "" }) },
  tools: [],
});

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

async function current(env: Env = ON, as = cookie) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps));
  statements = 0;
  const res = await app.request("/api/coach/runs/current", { headers: { Cookie: as } }, env);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements };
}

let clock = Date.parse("2026-10-14T08:00:00.000Z");
const stamp = () => new Date((clock += 60_000)).toISOString();

/** A main run (or a sub-run, with `parentId`) as the loop leaves it. */
async function run(o: {
  status: string;
  who?: string;
  parentId?: string | null;
  rehearsal?: boolean;
  scope?: { kind: "now" | "later_today" | "week" | "next_n"; n?: number };
  estimateMicros?: number;
  error?: string | null;
}): Promise<string> {
  const id = `run-${Math.random().toString(36).slice(2, 10)}`;
  const scope = o.scope ?? { kind: "now" as const };
  const state = newRunState(o.parentId ? "designer" : "main", scope, { rehearsal: o.rehearsal === true, timezone: "UTC" });
  if (o.estimateMicros !== undefined) {
    state.estimate = { micros: o.estimateMicros, workouts: 3, perWorkoutMicros: 700_000, mainMicros: 400_000, basis: { designer: "default", main: "default" }, samples: { designers: 0, mains: 0 } };
  }
  const at = stamp();
  await db.insert(schema.coachRuns).values({
    id,
    userId: o.who ?? userId,
    parentId: o.parentId ?? null,
    role: o.parentId ? "designer" : "main",
    scope,
    request: "hips, please",
    status: o.status,
    state: JSON.stringify(state),
    steps: 2,
    costUsd: 0.21,
    error: o.error ?? null,
    createdAt: at,
    updatedAt: at,
    finishedAt: ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"].includes(o.status) ? null : at,
  });
  return id;
}

/** The run's design proposal, with ops each undecided (`null`) or with an outcome's status. */
async function proposal(runId: string, status: string, outcomes: Array<string | null>, flags: string[] = []): Promise<string> {
  const id = designProposalId(runId);
  const ops = outcomes.map((o, i) => ({
    kind: "doc_workout",
    target: { kind: "new", date: "2026-10-16" },
    date: "2026-10-16",
    doc: { title: `Workout ${i + 1}` },
    review: null,
    issues: [],
    derived: {},
    by: { runId: `${runId}-d${i}`, role: "designer" },
    toolUseId: `toolu_${i}`,
    at: stamp(),
    ...(o === null ? {} : { outcome: o === "refused" ? { status: "refused", at: stamp(), error: "past_date", why: "Fri 16 Oct has passed." } : { status: o, at: stamp() } }),
  }));
  await db.insert(schema.coachProposals).values({
    id,
    userId,
    title: "Hips",
    evidence: "",
    rationale: "",
    flags,
    ops,
    status,
    createdAt: stamp(),
    expiresAt: "2026-10-20",
  });
  return id;
}

async function events(runId: string, n: number, who = userId): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await db.insert(schema.coachRunEvents).values({ id: `${runId}:${i}`, userId: who, runId, seq: i, kind: "note", summary: `Line ${i}`, payload: { n: i }, at: stamp() });
  }
}

describe("GET /api/coach/runs/current", () => {
  it("is a 404 with the coach designer off, signed in or not", async () => {
    await run({ status: "active" });
    expect((await current(OFF)).status).toBe(404);
    expect((await current(OFF, "")).status).toBe(404);
  });

  it("answers no run when the athlete has none to show", async () => {
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run: null });
  });

  it("answers the newest live main run, its last events in order, and no proposal", async () => {
    const older = await run({ status: "finished" });
    await proposal(older, "pending", [null]);
    const live = await run({ status: "waiting_athlete" });
    await events(live, 3);
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: live, role: "main", status: "waiting_athlete", request: "hips, please", costUsd: 0.21 });
    expect(res.body.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(res.body.events[0]).toMatchObject({ kind: "note", summary: "Line 1", payload: { n: 1 } });
    expect(res.body.proposal).toBeNull();
  });

  it("with no live run, answers the newest finished run whose proposal is still open — with its id, status and flags", async () => {
    const decided = await run({ status: "finished" });
    await proposal(decided, "approved", ["applied"]);
    const stopped = await run({ status: "stopped_cap", error: "run_ceiling" });
    const pid = await proposal(stopped, "pending", [null, null], ["The coach stopped at this design's spending limit; this is what had been reviewed by then."]);
    const res = await current();
    expect(res.body.run).toMatchObject({ id: stopped, status: "stopped_cap", error: "run_ceiling" });
    expect(res.body.proposal).toEqual({
      id: pid,
      status: "pending",
      flags: ["The coach stopped at this design's spending limit; this is what had been reviewed by then."],
    });
  });

  it("a partially approved proposal counts while an op is undecided or refused, and not once every op is decided", async () => {
    const partly = await run({ status: "finished" });
    await proposal(partly, "partially_approved", ["applied", null]);
    expect((await current()).body.run.id).toBe(partly);
    await db.delete(schema.coachProposals);
    await proposal(partly, "partially_approved", ["applied", "refused"]);
    expect((await current()).body.run.id).toBe(partly);
    await db.delete(schema.coachProposals);
    await proposal(partly, "partially_approved", ["applied", "declined"]);
    expect((await current()).body).toEqual({ run: null });
    // A change an approve is applying (Task 8b) is still the athlete's: Approve asked again finishes it.
    await db.delete(schema.coachProposals);
    await proposal(partly, "partially_approved", ["applied", "applying"]);
    expect((await current()).body.run.id).toBe(partly);
  });

  it("an expired, declined, superseded or cancelled proposal is not open", async () => {
    for (const status of ["expired", "declined", "superseded", "cancelled", "unreviewed"]) {
      await db.delete(schema.coachProposals);
      await db.delete(schema.coachRuns);
      const r = await run({ status: "finished" });
      await proposal(r, status, [null]);
      expect((await current()).body, status).toEqual({ run: null });
    }
  });

  it("the newest of two finished runs with open proposals; a live run before either", async () => {
    const a = await run({ status: "finished" });
    await proposal(a, "pending", [null]);
    const b = await run({ status: "failed", error: "gateway_402" });
    await proposal(b, "pending", [null]);
    expect((await current()).body.run.id).toBe(b);
    const live = await run({ status: "active" });
    expect((await current()).body.run.id).toBe(live);
  });

  it("a live run comes first even when a run over with an open suggestion is newer", async () => {
    const live = await run({ status: "waiting_athlete" });
    const newer = await run({ status: "finished" });
    await proposal(newer, "pending", [null]);
    expect((await current()).body.run.id).toBe(live);
  });

  it("a live run's suggestion not yet the athlete's (unreviewed while it works) is no proposal", async () => {
    const live = await run({ status: "active" });
    await proposal(live, "unreviewed", [null]);
    const res = await current();
    expect(res.body.run.id).toBe(live);
    expect(res.body.proposal).toBeNull();
  });

  it("never a rehearsal: neither its live run nor its proposal", async () => {
    const live = await run({ status: "active", rehearsal: true });
    expect((await current()).body).toEqual({ run: null });
    await db.update(schema.coachRuns).set({ status: "finished" });
    await proposal(live, "pending", [null]);
    expect((await current()).body).toEqual({ run: null });
  });

  it("never a sub-run, nor another athlete's run", async () => {
    const { userId: other } = await makeTestUser(db);
    await run({ status: "active", who: other });
    const finished = await run({ status: "finished" });
    await run({ status: "active", parentId: finished });
    expect((await current()).body).toEqual({ run: null });
  });

  it(`answers the last ${CURRENT_RUN_EVENTS} events, oldest first`, async () => {
    const live = await run({ status: "active" });
    await events(live, CURRENT_RUN_EVENTS + 10);
    const seqs = (await current()).body.events.map((e: { seq: number }) => e.seq);
    expect(seqs).toHaveLength(CURRENT_RUN_EVENTS);
    expect(seqs[0]).toBe(11);
    expect(seqs.at(-1)).toBe(CURRENT_RUN_EVENTS + 10);
  });

  it("costs its pinned statements: the session, then the pick, the tree and the events", async () => {
    const live = await run({ status: "active", scope: { kind: "week" } });
    await run({ status: "active", parentId: live });
    await events(live, 60);
    const res = await current();
    expect(res.status).toBe(200);
    expect(CURRENT_RUN_STATEMENTS).toBe(3);
    // The session is the route's own (requireUser: one statement here, within ROUTE_OVERHEAD); the read is 3, and the
    // pick alone when there is no run to show.
    const none = await db.delete(schema.coachRuns).then(() => current());
    expect(res.cost - none.cost).toBe(CURRENT_RUN_STATEMENTS - 1);
    expect(none.cost).toBe(1 + 1);
    expect(res.cost).toBe(1 + CURRENT_RUN_STATEMENTS);
    expect(res.cost).toBeLessThanOrEqual(ROUTE_OVERHEAD + CURRENT_RUN_STATEMENTS);
  });
});

describe("the run's figures", () => {
  it("a set carries its estimate once planned, and its ceiling — dollars, for the run view", async () => {
    const id = await run({ status: "active", scope: { kind: "week" }, estimateMicros: 4_234_567 });
    const res = await current();
    expect(res.body.run).toMatchObject({ id, estimateUsd: 4.234567, ceilingUsd: 6 });
  });

  it("before its plan a set has no estimate; a run for now has its own ceiling", async () => {
    const id = await run({ status: "active", scope: { kind: "week" } });
    expect((await current()).body.run).toMatchObject({ id, estimateUsd: null, ceilingUsd: 6 });
    await db.delete(schema.coachRuns);
    const now = await run({ status: "active" });
    expect((await current()).body.run).toMatchObject({ id: now, estimateUsd: null, ceilingUsd: 1.5 });
  });

  it("a new run's answer carries its ceiling", async () => {
    const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps));
    const res = await app.request("/api/coach/runs", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ scope: { kind: "week" } }) }, ON);
    expect(((await res.json()) as { run: unknown }).run).toMatchObject({ status: "active", estimateUsd: null, ceilingUsd: 6 });
  });

  it("a run's own read carries them too", async () => {
    const id = await run({ status: "waiting_set", scope: { kind: "next_n", n: 3 }, estimateMicros: 2_500_000 });
    const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps));
    const res = await app.request(`/api/coach/runs/${id}?afterSeq=0`, { headers: { Cookie: cookie } }, ON);
    expect(((await res.json()) as { run: unknown }).run).toMatchObject({ estimateUsd: 2.5, ceilingUsd: 6 });
  });
});
