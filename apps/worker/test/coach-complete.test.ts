/**
 * INCOMPLETE OUTPUT IS NEVER A PHONE'S TO APPROVE (R1; DESIGN-3 §3.8, §5.3; the lead's v0.20 ruling: "32k is a ceiling, not
 * never truncate… detect incomplete output and never make it approvable").
 *
 * Pinned: a proposal whose main run ended through its finish reads `complete: true`; one whose run stopped — its step cap
 * (every call cut off at the output limit ends there), its ceiling, the week's cap, a failure, a cancel, its window closing —
 * reads `complete: false` with why, and a phone's approve of it is 409 `incomplete`, nothing written; the laptop's approve
 * of it is unchanged (DESIGN-3 §6.1). That cut-off output never becomes an op at all is coach-runs.test.ts's ("an answer
 * cut off at the output limit runs none of its calls"). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { coachRoutes } from "../src/routes/coach.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { coachProposals, coachRuns, plannedWorkouts } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-16";
const REVIEW: OpReview = { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

let w: NativeWorld;
let v5: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(DateTime.fromISO(`${T}T09:00`, { zone: LA }).toUTC().toISO()!));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld([["/api/coach", coachRoutes]], { env: { COACH_DESIGNER: "1" } });
  v5 = (await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" })).token;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One reviewed workout, proposed and pending, its main run then ended as `status` with `error`. */
async function proposalEnded(status: string, error: string | null = null) {
  const main = `run-${newId()}`;
  await w.db.insert(coachRuns).values({ id: main, userId: w.userId, parentId: null, role: "main", scope: { kind: "later_today" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: nowInstant(), updatedAt: nowInstant() });
  const ctx: ToolContext = { db: w.db, env: w.env, userId: w.userId, run: { id: main, role: "main", scope: { kind: "later_today" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  const res = await proposeWorkout.run(ctx, { doc: calmDoc(), target: { kind: "new", date: addDays(T, 1), time: "07:00" } });
  if (isToolErr(res)) throw new Error(res.error);
  const id = designProposalId(main);
  const [p] = await w.db.select().from(coachProposals).where(eq(coachProposals.id, id));
  await w.db.update(coachProposals).set({ status: "pending", ops: (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: REVIEW })) }).where(eq(coachProposals.id, id));
  // A finished run ended through its finish tool, as a real one does (`state.endedBy`, review B-1).
  await w.db.update(coachRuns).set({ status, error, ...(status === "finished" ? { state: JSON.stringify({ v: 1, settings: { ceilingMicros: 1_500_000, maxCalls: 12 }, system: null, messages: [], endedBy: "finish" }) } : {}) }).where(eq(coachRuns.id, main));
  return { id, opId: (p!.ops as DesignedOp[])[0]!.by.runId };
}

const read = (id: string) => w.call("GET", `/api/coach/proposals/${id}`, { bearer: v5 });

describe("complete only when its run finished", () => {
  it("finished: complete, and a phone approves it", async () => {
    const { id, opId } = await proposalEnded("finished");
    const r = await read(id);
    expect([r.json.complete, r.json.missing]).toEqual([true, undefined]);
    const a = await w.call("POST", `/api/coach/proposals/${id}/approve`, { bearer: v5, body: { opIds: [opId], version: r.json.version } });
    expect([a.status, a.json.applied?.length], a.text).toEqual([200, 1]);
  });

  for (const [status, error] of [
    ["stopped_cap", "step_cap"],
    ["stopped_cap", "run_ceiling"],
    ["stopped_cap", "weekly_cap"],
    ["failed", "retries"],
    ["cancelled", null],
    ["expired", null],
  ] as const) {
    it(`${status}${error ? ` (${error})` : ""}: not complete, with why; a phone's approve is 409 incomplete and writes nothing`, async () => {
      const { id, opId } = await proposalEnded(status, error);
      const r = await read(id);
      expect([r.json.complete, r.json.missing?.status, r.json.missing?.error]).toEqual([false, status, error]);
      const a = await w.call("POST", `/api/coach/proposals/${id}/approve`, { bearer: v5, body: { opIds: [opId], version: r.json.version } });
      expect([a.status, a.json.error]).toEqual([409, "incomplete"]);
      expect(a.json.missing).toEqual(r.json.missing);
      expect(await w.db.select().from(plannedWorkouts)).toEqual([]);
    });
  }

  it("the laptop's approve of a stopped run's reviewed workout is unchanged (DESIGN-3 §6.1)", async () => {
    const { id } = await proposalEnded("stopped_cap", "step_cap");
    const a = await w.call("POST", `/api/coach/proposals/${id}/approve`, { body: {} });
    expect([a.status, a.json.applied?.length], a.text).toEqual([200, 1]);
  });
});
