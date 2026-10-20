/**
 * A THREAD PROPOSAL THAT SHAPES A PLAN, APPROVED A CHUNK A REQUEST (§8 §4, 2026-10-18).
 *
 * The thread coach's approve applied a proposal whole: a seven-session `createPlan` measured 68 statements against the
 * free plan's 50 an invocation, so a whole plan died part way, and the retry began again at op 0. A proposal holding
 * a structural op (`isStructuralOp`) is now approved in order, op by op, each request within the budget:
 *
 *  · a structural op runs through `applyStructuralChunk` (coach-apply.ts) for the room the request has left; its
 *    `progress` is stored on the op (`ops[i].progress`) until it is done (`{ step: "done", summary }`) or refused
 *    (`{ step: "refused", reason }`, said in the receipt as the applier's shortfalls are);
 *  · a run of the thread's other ops between them (a skip, a move…) goes through `applyOps` as it always did — whole,
 *    under its own indices' ids, never overwriting a before-state already captured — in a request of its own;
 *  · the request answers `{ ok, remaining: true }` while anything is left, the proposal still `pending` with where it
 *    got to; the client asks again (`api.coachApprove`). The request that finishes approves the proposal and writes
 *    the receipt, the garden's replay, the calendar's step in whatever room is left, and `coachDrain`.
 *
 * A proposal part-applied is the athlete's already: its next approve resumes it whatever the date, and the expiry
 * sweep leaves it alone (`structuralStarted`). A proposal of the thread's other ops alone is approved as before.
 *
 * Synthetic budgets are pinned in thread-approve-budget.test.ts.
 */
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { coachProposals } from "@rg/database";
import { nowInstant, type CoachOp, type UserPreferences } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import {
  applyOps,
  applyStructuralChunk,
  isStructuralOp,
  STRUCTURAL_MIN_BUDGET,
  type StructuralProgress,
} from "../services/coach-apply.js";
import { syncCalendar } from "../services/calendar-sync.js";
import { coachDrainQueued } from "../services/coros-write-cloud.js";
import { calendarOpsFitting } from "../services/design-approve.js";
import { REQUEST_GARDEN_STEP, resimulateFrom } from "../services/garden-sync.js";
import { isDesignedProposal } from "../services/proposal-kinds.js";
import { waitUntilSafe } from "../services/wait-until.js";

type C = Context<AppContext>;

/** A thread op as stored: the op, and where its apply got to once one began. */
type StoredOp = CoachOp & { progress?: StructuralProgress };

/** A request's statements at most (the suites' budget for the free plan's 50). */
export const REQUEST_BUDGET = 45;
/**
 * What every request of a structural approve costs beside its chunks: the session (2), the proposal, the
 * preferences, and the proposal written (where it got to, or approved) — and the request that finishes, its receipt
 * and the watch's check (`coachDrain`). Measured in thread-approve-budget.test.ts.
 */
export const THREAD_APPROVE_FIXED = 2 + 1 + 1 + 1;
export const THREAD_APPROVE_FINISH = 1 + 1;
/** The statements a request's chunks may spend. */
export const THREAD_CHUNK_BUDGET = REQUEST_BUDGET - THREAD_APPROVE_FIXED - THREAD_APPROVE_FINISH;

/** Whether a thread proposal is part-applied: one of its ops began (or finished) its apply. A designed proposal's ops
 * keep their own record (`outcome`, design-approve.ts) and are never this. */
export const structuralStarted = (ops: unknown): boolean =>
  Array.isArray(ops) &&
  !isDesignedProposal(ops) &&
  ops.some((o) => !!o && typeof o === "object" && "progress" in o && !!(o as StoredOp).progress);

const finished = (o: StoredOp) => o.progress?.step === "done" || o.progress?.step === "refused";

/** A sentence said inside the receipt's line: "That plan isn't there…." → "that plan isn't there…". */
const inLine = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");

/** The op as the appliers read it: without its stored progress. */
function bare(o: StoredOp): CoachOp {
  const { progress: _progress, ...op } = o;
  return op as CoachOp;
}

export async function approveStructural(
  c: C,
  p: typeof coachProposals.$inferSelect,
  prefs: UserPreferences,
  receipt: (body: string) => Promise<void>,
): Promise<Response> {
  const db = c.get("db");
  const userId = c.get("userId");
  const now = new Date();
  const ops: StoredOp[] = (p.ops as StoredOp[]).map((o) => ({ ...o }));
  let spent = 0;
  let resimFrom: string | null = null;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (finished(op)) continue;
    if (!isStructuralOp(op)) {
      // The thread's other ops, in a request of their own: the run of them from here, through the applier whole.
      if (spent > 0) break;
      let end = i;
      while (end < ops.length && !isStructuralOp(ops[end]!) && !finished(ops[end]!)) end++;
      const applied = await applyOps(db, userId, prefs, p.id, ops.map(bare), {
        only: (n) => n >= i && n < end,
        priorRefs: p.appliedRefs,
      });
      for (let n = i; n < end; n++) {
        ops[n] = { ...ops[n]!, progress: { step: "done", done: 0, ...(n === i && applied.missed.length > 0 ? { missed: applied.missed } : {}) } };
      }
      resimFrom = applied.resimFrom;
      spent = THREAD_CHUNK_BUDGET;
      break;
    }
    if (spent > 0 && THREAD_CHUNK_BUDGET - spent < STRUCTURAL_MIN_BUDGET) break;
    const r = await applyStructuralChunk(db, {
      userId,
      proposalId: p.id,
      opIndex: i,
      op: bare(op),
      progress: op.progress ?? null,
      budget: THREAD_CHUNK_BUDGET - spent,
      now,
      prefs,
    });
    spent += r.spent;
    if (r.status === "more") {
      ops[i] = { ...op, progress: r.progress };
      break;
    }
    ops[i] = {
      ...op,
      progress: r.status === "done" ? { step: "done", done: 0, summary: r.summary } : { step: "refused", done: 0, reason: r.reason },
    };
  }
  // The garden forgets what a run of the thread's other ops resolved, in the request that ran it.
  const resim = async () => {
    if (resimFrom) await resimulateFrom(db, userId, resimFrom, prefs, new Date(), REQUEST_GARDEN_STEP).catch(() => undefined);
  };

  if (!ops.every(finished)) {
    // Where it got to, for the next request — still pending, so the card asks again; never over a decision made since.
    await db
      .update(coachProposals)
      .set({ ops })
      .where(and(eq(coachProposals.id, p.id), eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")));
    await resim();
    return c.json({ ok: true, remaining: true });
  }

  // Approved only while still pending (review-1): a decline that landed during this request stands — no approved
  // over it, and no ✓ receipt beside its own.
  const approved = await db
    .update(coachProposals)
    .set({ ops, status: "approved", resolvedAt: nowInstant() })
    .where(and(eq(coachProposals.id, p.id), eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")))
    .returning({ id: coachProposals.id });
  if (approved.length === 0) {
    const [now] = await db
      .select({ status: coachProposals.status })
      .from(coachProposals)
      .where(and(eq(coachProposals.id, p.id), eq(coachProposals.userId, userId)))
      .limit(1);
    return c.json({ error: "not_pending", status: now?.status ?? "not_found" }, 409);
  }
  // COMMITTED (as the whole approve's rule, 2026-10-10): nothing below turns an applied proposal into an error.
  const missed = ops.flatMap((o) => {
    const pr = o.progress!;
    if (pr.step === "refused") return [inLine(String(pr.reason))];
    return Array.isArray(pr.missed) ? (pr.missed as string[]) : [];
  });
  const shortfall = missed.length > 0 ? ` · ${missed.join("; ")}` : "";
  await receipt(`✓ approved — ${p.title}${shortfall}`).catch((e: unknown) =>
    console.error(`approve ${p.id}: applied, but the receipt failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  await resim();
  // The calendar follows the plan in the room this request left; the half-hourly reconcile books the rest.
  const calendarOps = calendarOpsFitting(THREAD_CHUNK_BUDGET - spent);
  if (calendarOps > 0) waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps: calendarOps }).catch(() => undefined));
  const coachDrain = await coachDrainQueued(db, userId).catch(() => false);
  return c.json({
    ok: true,
    applied: { created: [], updated: [], archived: [], missed, resimFrom },
    summaries: ops.flatMap((o) => (o.progress?.step === "done" && typeof o.progress.summary === "string" ? [o.progress.summary] : [])),
    ...(coachDrain ? { coachDrain: true } : {}),
  });
}

/** The receipt a plan's retire writes once it is done: a Retire's own. */
export const RETIRED_RECEIPT = "Plan retired — completed history stays.";
/** The one receipt of a training line's "Stop this plan", written by its last phase's retire (`stop=last`). */
export const STOPPED_RECEIPT = "Plan stopped — completed history stays.";

/**
 * The Plan's Retire, a slice a request (§8 §4): its plan's future sessions archived as many as fit, `remaining`
 * until none is left, then the plan retired and the receipt written (`words`; none when null — a Stop's phase before its
 * last). Nothing is stored between requests — each one re-reads what is still scheduled — so a Retire left part way is
 * finished by the next tap.
 */
export const RETIRE_FIXED = 2 + 1;
export const RETIRE_FINISH = 1;
export const RETIRE_CHUNK_BUDGET = REQUEST_BUDGET - RETIRE_FIXED - RETIRE_FINISH;

export async function retireInChunks(
  c: C,
  planId: string,
  prefs: UserPreferences,
  receipt: (body: string) => Promise<void>,
  words: string | null = RETIRED_RECEIPT,
): Promise<Response> {
  const db = c.get("db");
  const userId = c.get("userId");
  const r = await applyStructuralChunk(db, {
    userId,
    proposalId: `retire-${planId}`,
    opIndex: 0,
    op: { kind: "retirePlan", planId },
    progress: null,
    budget: RETIRE_CHUNK_BUDGET,
    now: new Date(),
    prefs,
  });
  // A tap on "retire" against a plan that is not there is a 404, not a receipt saying it was retired.
  if (r.status === "refused") return c.json({ error: "not_found" }, 404);
  if (r.status === "more") return c.json({ ok: true, remaining: true });
  if (words !== null) await receipt(words);
  return c.json({ ok: true });
}
