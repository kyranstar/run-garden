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
import { sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { CURRENT_RUN_EVENTS, CURRENT_RUN_STATEMENTS, currentRun, newRunState, ROUTE_OVERHEAD, type RunDeps } from "../src/services/coach-runs.js";
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
/** The athlete's today, by their own zone (the proposals' days are relative to it: no date here goes stale). */
let today: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  let prefs;
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
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

/**
 * The run's design proposal, with ops each undecided (`null`) or with an outcome's status, each dated `dates[i]`
 * (default: tomorrow in the athlete's zone), the proposal expiring on `expiresAt` (default: four days on).
 */
async function proposal(
  runId: string,
  status: string,
  outcomes: Array<string | null>,
  flags: string[] = [],
  o: { dates?: string[]; expiresAt?: string } = {},
): Promise<string> {
  const id = designProposalId(runId);
  const ops = outcomes.map((o2, i) => ({ o2, date: o.dates?.[i] ?? addDays(today, 1) })).map(({ o2: o, date }, i) => ({
    kind: "doc_workout",
    target: { kind: "new", date },
    date,
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
    expiresAt: o.expiresAt ?? addDays(today, 4),
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

  it("an op dated before the athlete's today is no longer theirs to decide; one dated today or later still is", async () => {
    const r = await run({ status: "finished" });
    await proposal(r, "pending", [null], [], { dates: [addDays(today, -1)] });
    expect((await current()).body).toEqual({ run: null });
    await db.delete(schema.coachProposals);
    await proposal(r, "pending", [null, null], [], { dates: [addDays(today, -1), today] });
    expect((await current()).body.run.id).toBe(r);
  });

  it("a pending proposal whose day has passed, not yet swept, is not open", async () => {
    const r = await run({ status: "finished" });
    await proposal(r, "pending", [null], [], { dates: [today], expiresAt: addDays(today, -1) });
    expect((await current()).body).toEqual({ run: null });
  });

  it("the athlete's today is their zone's, not the server's: at 03:00 UTC on the 16th a suggestion for the 15th is still open in Los Angeles", async () => {
    // The test athlete's zone is America/Los_Angeles (helpers.ts): 20:00 on Thu 15 Oct there, Fri 16 Oct in UTC.
    const now = new Date("2026-10-16T03:00:00.000Z");
    const r = await run({ status: "finished" });
    await proposal(r, "pending", [null], [], { dates: ["2026-10-15"], expiresAt: "2026-10-15" });
    const found = await currentRun(db, userId, now);
    expect(found?.run.id).toBe(r);
    expect(found?.proposal?.id).toBe(designProposalId(r));
  });

  it("preferences that can't be read are their defaults: the run is still found", async () => {
    const r = await run({ status: "finished" });
    await proposal(r, "pending", [null], [], { dates: [addDays(today, 2)] });
    await db.run(sql`update user_preferences set prefs = '{not json' where user_id = ${userId}`);
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(r);
  });

  it("a suggestion still open is found behind a newer run whose suggestion has gone by", async () => {
    const older = await run({ status: "finished" });
    await proposal(older, "pending", [null], [], { dates: [addDays(today, 1)] });
    const newer = await run({ status: "finished" });
    await proposal(newer, "pending", [null], [], { dates: [addDays(today, -1)] });
    const res = await current();
    expect(res.body.run.id).toBe(older);
    expect(res.body.proposal.id).toBe(designProposalId(older));
  });

  it("a live run whose suggestion has only past days answers no proposal", async () => {
    const live = await run({ status: "active" });
    await proposal(live, "pending", [null], [], { dates: [addDays(today, -2)] });
    const res = await current();
    expect(res.body.run.id).toBe(live);
    expect(res.body.proposal).toBeNull();
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

  it("a suggestion decided in the last 10 minutes comes back with its run — after a reload the card says what came of it", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    for (const [status, outcomes] of [
      ["approved", ["applied"]],
      ["declined", ["declined"]],
      ["partially_approved", ["applied", "declined"]],
    ] as const) {
      await db.delete(schema.coachProposals);
      await db.delete(schema.coachRuns);
      const r = await run({ status: "finished" });
      const pid = await proposal(r, status, [...outcomes]);
      await db.update(schema.coachProposals).set({ resolvedAt: minutesAgo(9) });
      const found = await currentRun(db, userId, now);
      expect(found?.run.id, status).toBe(r);
      expect(found?.proposal, status).toEqual({ id: pid, status, flags: [] });
      // Ten minutes on, it has had its moment: the Studio opens on the composer.
      await db.update(schema.coachProposals).set({ resolvedAt: minutesAgo(11) });
      expect(await currentRun(db, userId, now), status).toBeNull();
    }
  });

  it("…never a suggestion the athlete didn't decide (superseded, expired), nor a rehearsal's; an open one before a decided one, even a newer one (M6)", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    for (const status of ["superseded", "expired", "cancelled"]) {
      await db.delete(schema.coachProposals);
      await db.delete(schema.coachRuns);
      const r = await run({ status: "finished" });
      await proposal(r, status, ["declined"]);
      await db.update(schema.coachProposals).set({ resolvedAt: recent });
      expect(await currentRun(db, userId, now), status).toBeNull();
    }
    await db.delete(schema.coachProposals);
    await db.delete(schema.coachRuns);
    const rehearsal = await run({ status: "finished", rehearsal: true });
    await proposal(rehearsal, "approved", ["applied"]);
    await db.update(schema.coachProposals).set({ resolvedAt: recent });
    expect(await currentRun(db, userId, now)).toBeNull();

    await db.delete(schema.coachProposals);
    await db.delete(schema.coachRuns);
    const open = await run({ status: "finished" });
    await proposal(open, "pending", [null]);
    const decided = await run({ status: "finished" });
    await proposal(decided, "approved", ["applied"]);
    await db.update(schema.coachProposals).set({ resolvedAt: recent }).where(sql`id = ${designProposalId(decided)}`);
    // The open one is still the athlete's to decide: it comes first, though the decided one is newer.
    expect((await currentRun(db, userId, now))?.run.id).toBe(open);
    // Once it is decided too (declined, now), the newer decided one shows: the newest of the two.
    await db.update(schema.coachProposals).set({ status: "declined", resolvedAt: recent, ops: [] }).where(sql`id = ${designProposalId(open)}`);
    expect((await currentRun(db, userId, now))?.run.id).toBe(decided);
    // A live run still comes first.
    const live = await run({ status: "active" });
    expect((await currentRun(db, userId, now))?.run.id).toBe(live);
  });

  it("a decided suggestion costs the read nothing more: the same pinned statements", async () => {
    const r = await run({ status: "finished" });
    await proposal(r, "approved", ["applied"]);
    await db.update(schema.coachProposals).set({ resolvedAt: new Date(Date.now() - 60_000).toISOString() });
    await events(r, 60);
    const res = await current();
    expect(res.body.run.id).toBe(r);
    expect(res.body.proposal.status).toBe("approved");
    expect(res.cost).toBe(1 + CURRENT_RUN_STATEMENTS);
  });

  it("costs its pinned statements: the session, then the pick, the tree and the events", async () => {
    const live = await run({ status: "active", scope: { kind: "week" } });
    await run({ status: "active", parentId: live });
    await events(live, 60);
    const res = await current();
    expect(res.status).toBe(200);
    expect(CURRENT_RUN_STATEMENTS).toBe(4);
    // The session is the route's own (requireUser: one statement here, within ROUTE_OVERHEAD); the read is 4 — the
    // pick, the tree, the events, the other suggestions still open — and the pick alone when there is no run to show.
    const none = await db.delete(schema.coachRuns).then(() => current());
    expect(res.cost - none.cost).toBe(CURRENT_RUN_STATEMENTS - 1);
    expect(none.cost).toBe(1 + 1);
    expect(res.cost).toBe(1 + CURRENT_RUN_STATEMENTS);
    expect(res.cost).toBeLessThanOrEqual(ROUTE_OVERHEAD + CURRENT_RUN_STATEMENTS);
  });
});

describe("also waiting (Task 13's fix wave, R2): the other suggestions still open", () => {
  /** Another run's open suggestion, as a design proposal: `n` ops for `dates`, the first `time`d (an atNow op's is none). */
  async function other(o: { dates: string[]; time?: string; atNow?: boolean; status?: string; title?: string; id?: string; who?: string; outcome?: string }) {
    const runId = await run({ status: "finished", who: o.who });
    const id = o.id ?? designProposalId(runId);
    const ops = o.dates.map((date, i) => ({
      kind: "doc_workout",
      target: { kind: "new", date, ...(o.atNow ? { atNow: true, notBefore: o.time } : {}) },
      date,
      ...(i === 0 && o.time ? { time: o.time } : {}),
      doc: { title: `${o.title ?? "Other"} ${i + 1}` },
      review: null,
      issues: [],
      derived: {},
      by: { runId: `${runId}-d${i}`, role: "designer" },
      toolUseId: `toolu_${i}`,
      at: stamp(),
      ...(o.outcome ? { outcome: { status: o.outcome, at: stamp() } } : {}),
    }));
    await db.insert(schema.coachProposals).values({
      id, userId: o.who ?? userId, title: o.title ?? "Other", evidence: "", rationale: "", flags: [], ops, status: o.status ?? "pending",
      createdAt: stamp(), expiresAt: addDays(today, 6),
    });
    return id;
  }

  it("lists the other designed suggestions with an open op today or later, newest first — never the one shown", async () => {
    const a = await other({ title: "Calm hips", dates: [today], time: "18:00" });
    const b = await other({ title: "Two days", dates: [addDays(today, 1), addDays(today, 2)] });
    const shown = await run({ status: "finished" });
    await proposal(shown, "pending", [null]);
    const res = await current();
    expect(res.body.run.id).toBe(shown);
    expect(res.body.alsoOpen).toEqual([
      { proposalId: b, title: "Two days", date: addDays(today, 1), time: null, items: 2 },
      { proposalId: a, title: "Calm hips", date: today, time: "18:00", items: 1 },
    ]);
  });

  it("a now suggestion reads as untimed, and says it is a now design (round 2, for U); a live run's own proposal is never listed", async () => {
    const now = await other({ title: "Jaw ease", dates: [today], time: "13:15", atNow: true });
    const timed = await other({ title: "Evening", dates: [today], time: "19:00" });
    const live = await run({ status: "active" });
    await proposal(live, "pending", [null]);
    const res = await current();
    expect(res.body.run.id).toBe(live);
    // `atNow` only when true: a timed row carries no key at all.
    expect(res.body.alsoOpen).toEqual([
      { proposalId: timed, title: "Evening", date: today, time: "19:00", items: 1 },
      { proposalId: now, title: "Jaw ease", date: today, time: null, items: 1, atNow: true },
    ]);
    expect(res.cost).toBe(1 + CURRENT_RUN_STATEMENTS);
  });

  it("never one decided, gone by, a rehearsal's, unreviewed, the thread's own, or another athlete's; at most five", async () => {
    await other({ dates: [today], outcome: "applied" });
    await other({ dates: [addDays(today, -1)] });
    await other({ dates: [today], status: "rehearsal" });
    await other({ dates: [today], status: "unreviewed" });
    await other({ dates: [today], status: "declined" });
    await other({ dates: [today], id: "thread-proposal-1" });
    const { userId: someoneElse } = await makeTestUser(db);
    await other({ dates: [today], who: someoneElse });
    const shown = await run({ status: "active" });
    expect((await current()).body.alsoOpen).toEqual([]);
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await other({ title: `Open ${i}`, dates: [addDays(today, i % 3)] }));
    const res = await current();
    expect(res.body.run.id).toBe(shown);
    expect(res.body.alsoOpen.map((x: { proposalId: string }) => x.proposalId)).toEqual(ids.slice(2).reverse());
    expect(res.cost).toBe(1 + CURRENT_RUN_STATEMENTS);
  });

  it("newer suggestions gone by never crowd out an older one still open", async () => {
    const open = await other({ title: "Still open", dates: [addDays(today, 1)] });
    for (let i = 0; i < 6; i++) await other({ dates: [addDays(today, -1)] });
    await run({ status: "active" });
    expect((await current()).body.alsoOpen.map((x: { proposalId: string }) => x.proposalId)).toEqual([open]);
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
