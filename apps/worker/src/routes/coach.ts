import { Hono } from "hono";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  activities,
  coachLocks,
  coachMemory,
  coachMessages,
  coachReads,
  coachPlanWeeks,
  coachPlans,
  coachProposals,
  coachQuestions,
  coachRuns,
  llmUsage,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  humanizeWorkoutTitle,
  looksLikeCodeTitle,
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  type CoachOp,
  type LiftingPlan,
} from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { threadCoachEnabled } from "../env.js";
import { restoreInProgress } from "../services/account-state.js";
import { loadOutOfCredits, type OutOfCredits } from "../services/ai-credits.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { recordReplayFrom, REQUEST_GARDEN_STEP, resimulateFrom, unseenCompletions } from "../services/garden-sync.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { ensureRead } from "../services/coach-reads.js";
import { LLM_BUDGET } from "../services/llm.js";
import { COACH_DRAIN_KINDS, coachDrainQueued, executeCloudJobs } from "../services/coros-write-cloud.js";
import { exerciseNameMap, resolveExerciseName } from "../services/exercise-catalog.js";
import { liftProgressions, liftWeekSummary, runProgressions } from "../services/plan-progressions.js";
import { loggedTopKgByWeek } from "../services/logged-sets.js";
import { applyOps, isStructuralOp } from "../services/coach-apply.js";
import { approveStructural, retireInChunks, structuralStarted } from "./thread-structural.js";
import { evaluateTriggers, pendingTriggers } from "../services/coach-triggers.js";
import { coachBlockAdherence, isLoosePlan, plansEndedOn } from "../services/coach-plans.js";
import {
  openWakeIsFresh,
  recordAthleteMessage,
  wake,
  WAKE_LOCK_STALE_MINUTES,
  type WakeResult,
} from "../services/coach-wake.js";
import { chunkIds, type Db } from "../services/db.js";
import { plannedRowColumns } from "../services/planned-columns.js";
import { isDesignedProposal } from "../services/proposal-kinds.js";
import { expiryOfClaims, SWEEP_REJUDGES } from "../services/design-approve.js";
import { studioPlanEnd, studioPlanRetired } from "../services/studio-push.js";
import { approveDesigned, declineDesigned, designedDraft, designedLines } from "./design-proposals.js";
import { EARLIEST_ZONE, liveMemoryWhere, MEMORY_PIN_CAP, memoryHistoryWhere, REHEARSAL_MEMORY } from "../services/memory-core.js";
import { LIVE_STATUSES } from "../services/coach-runs.js";
import { designProposalId } from "../services/design-tools/propose.js";

/**
 * The coach's HTTP surface (Plan A Tasks A7+A9). Proposals are STATE with a
 * strict lifecycle: pending is the only actionable status, everything else
 * is inert history — approve/decline 409 anything stale, and the expiry
 * sweep (cron + inline on state reads) closes what the calendar outran.
 */

export const coachRoutes = new Hono<AppContext>();

/** What `/message` answers a cached old client with while the thread coach has stepped back (§8 §6): a receipt. */
export const THREAD_COACH_STEPPED_BACK = "Your coach is now behind the Coach button.";
coachRoutes.use("*", requireUser);

async function receipt(
  db: Db,
  userId: string,
  body: string,
  proposalId?: string,
): Promise<void> {
  await db.insert(coachMessages).values({
    id: newId(),
    userId,
    role: "receipt",
    body,
    refs: proposalId ? { proposalId } : {},
    at: nowInstant(),
  });
}

/** Auto-expire questions nobody answered for 72h (audit finding 9): a
 * stale question pins its chips above the composer forever AND blocks the
 * coach from asking anything new (`hasOpen`). Expiry writes a receipt so
 * the disappearance is explained. */
export async function sweepStaleQuestions(db: Db, userId: string, now: string): Promise<number> {
  const cutoff = new Date(Date.parse(now) - 72 * 3600 * 1000).toISOString();
  const stale = await db
    .select()
    .from(coachQuestions)
    .where(
      and(eq(coachQuestions.userId, userId), isNull(coachQuestions.answeredAt), lt(coachQuestions.askedAt, cutoff)),
    );
  for (const q of stale) {
    await db.update(coachQuestions).set({ answeredAt: now }).where(eq(coachQuestions.id, q.id));
    await receipt(db, userId, `Question expired — ask me anytime: ${q.body}`);
  }
  return stale.length;
}

/** Expire pending proposals whose day passed or TTL lapsed (spec §3) — and a design's proposal still unreviewed
 * (Stage 3 Task 6), silently: the athlete never saw it, so there is nothing to say. An unreviewed one is expired only
 * once its run is over (fix wave 3A, A10): a set still being designed across local midnight keeps its proposal, which
 * its next designer proposes into; the run itself proposes what was reviewed, or closes it, when it ends.
 *
 * A designed proposal's claims (Task 8b's recovery rule, design-approve.ts `expiryOfClaims`): one an approve is applying
 * now is never expired under it; one whose approve died is judged again on the plan first — made, recorded applied; not,
 * released — SWEEP_REJUDGES a sweep (REJUDGE_COST each), the rest waiting for the next. Its expiry is guarded by the ops
 * it read too: a claim written between the read and the write wins. A thread proposal holds no claim: nothing changes. */
export async function sweepExpiredProposals(db: Db, userId: string, today: string): Promise<number> {
  const runLive = sql`exists (select 1 from ${coachRuns} r where r.user_id = ${userId} and r.parent_id is null
    and ${coachProposals.id} = ${designProposalId("")} || r.id
    and r.status in (${sql.join(LIVE_STATUSES.map((s) => sql`${s}`), sql`, `)}))`;
  const stale = await db
    .select()
    .from(coachProposals)
    .where(
      and(
        eq(coachProposals.userId, userId),
        or(eq(coachProposals.status, "pending"), and(eq(coachProposals.status, "unreviewed"), sql`not ${runLive}`)),
        lt(coachProposals.expiresAt, today),
      ),
    );
  const now = nowInstant();
  const room = { rejudges: SWEEP_REJUDGES };
  let expired = 0;
  for (const p of stale) {
    // A plan part-applied is never expired under the athlete: its next approve finishes it (§8 §4).
    if (structuralStarted(p.ops)) continue;
    const claims = await expiryOfClaims(db, userId, p, today, now, room);
    if (!claims) continue;
    // Guarded: a proposal another request settled meanwhile is not expired, and gets no receipt.
    const changed = await db
      .update(coachProposals)
      .set({ status: "expired", resolvedAt: now, ...(claims.ops ? { ops: claims.ops } : {}) })
      .where(
        and(
          eq(coachProposals.id, p.id),
          eq(coachProposals.status, p.status),
          isDesignedProposal(p.ops) ? sql`${coachProposals.ops} = ${JSON.stringify(p.ops)}` : undefined,
        ),
      )
      .returning({ id: coachProposals.id });
    if (changed.length === 0) continue;
    expired += 1;
    if (claims.replayFrom !== null) await recordReplayFrom(db, userId, claims.replayFrom).catch(() => undefined);
    if (p.status === "pending") await receipt(db, userId, `Expired — the moment passed: ${p.title}`, p.id);
  }
  return expired;
}

coachRoutes.get("/state", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  // The thread coach has stepped back (§8 §6, `THREAD_COACH` off): this read still sweeps and lists what it left — its
  // pending proposals stay approvable until they expire, its question answerable — but it marks no trigger, advises no
  // wake, and is never "thinking": a cached old client polling it starts nothing and waits on nothing.
  const threadCoach = threadCoachEnabled(c.env);
  // A restore is replacing the account (ruling B9): the read answers, but it
  // expires, sweeps and marks nothing — a trigger evaluated against a
  // half-restored account would recommend a paid wake on a false signal.
  if (!(await restoreInProgress(db, userId))) {
    await sweepExpiredProposals(db, userId, today);
    await sweepStaleQuestions(db, userId, nowInstant());
    if (threadCoach) await evaluateTriggers(db, userId, prefs, today).catch(() => []);
  }

  const before = c.req.query("before");
  const msgs = await db
    .select()
    .from(coachMessages)
    .where(
      before
        ? and(eq(coachMessages.userId, userId), lt(coachMessages.at, before))
        : eq(coachMessages.userId, userId),
    )
    .orderBy(desc(coachMessages.at))
    .limit(30);
  const pending = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")))
    .orderBy(coachProposals.expiresAt);
  // EVERY PROPOSAL THIS PAGE OF THE THREAD REFERS TO.
  //
  // A receipt carrying `refs.proposalId` IS a settled proposal — the worker
  // attaches that ref to exactly the receipts that end one (approve, decline,
  // expiry, supersede, and now a rejection that could not be applied) and to
  // no other receipt. The panel renders those as settled cards with the
  // manifest one tap away… but only while the tab that saw them live is still
  // open, because this route used to return pending rows and nothing else. On
  // reload, "what it did" degraded to a title.
  //
  // That mattered a little for an approved proposal and a lot for a rejected
  // one, whose whole point is that the draft survives as something the athlete
  // can open and read. So: resolve the ids the returned messages actually
  // name. Chunked because D1 caps bound variables, and status-blind on purpose
  // — a rejected row is inert everywhere that matters (approve/decline 409
  // anything not pending, and the expiry sweep above only touches pending).
  //
  // Capped at the NEWEST few, because this endpoint polls every 3s while a
  // wake is running and a proposal's `ops` is the largest JSON the coach
  // produces. Older settled cards keep the title-only rendering they have
  // always had; nobody scrolls back thirty messages during a wake.
  const settledIds = [
    ...new Set(
      msgs // newest first, before the reverse below
        .filter((m) => m.role === "receipt")
        .map((m) => m.refs.proposalId)
        .filter((id): id is string => !!id),
    ),
  ].slice(0, 12);
  const settled = [];
  for (const ids of chunkIds(settledIds)) {
    settled.push(
      ...(await db
        .select()
        .from(coachProposals)
        .where(and(eq(coachProposals.userId, userId), inArray(coachProposals.id, ids)))),
    );
  }
  const [openQuestion] = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.userId, userId), isNull(coachQuestions.answeredAt)))
    .limit(1);
  // Live memory only (memory-core.ts): never a rehearsal run's, never an item a newer one superseded.
  const memoryRows = await db.select().from(coachMemory).where(liveMemoryWhere(userId, today));
  const [lastCoach] = await db
    .select()
    .from(coachMessages)
    .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach")))
    .orderBy(desc(coachMessages.at))
    .limit(1);
  const signals = await threadSignals(db, userId, threadCoach);

  // A designed proposal (Stage 3) is approved on its own surface, never as a thread card: both lists leave it out — one
  // of changes alone too (Task 8b) — so nothing here ever renders a `doc_workout` or `plan_adjust` op.
  return c.json({
    messages: [...msgs].reverse(),
    pendingProposals: pending.filter((p) => !isDesignedProposal(p.ops)),
    settledProposals: settled.filter((p) => !isDesignedProposal(p.ops)),
    openQuestion: openQuestion ?? null,
    memoryCount: memoryRows.length,
    lastCoachAt: lastCoach?.at ?? null,
    ...signals,
  });
});

/**
 * What `/state` says of the thread coach's own doings: whether a Plan visit should wake it, whether it is thinking, and
 * whether its AI account is out of credits.
 *
 * Stepped back (`on` false, §8 §6): it advises no wake and is never out of credits — that line's Retry would ask a coach
 * that answers no one — and it is thinking only while a wake still holds its lock (one in flight across the switch).
 * Never over an old unanswered mark: nothing will answer it now, and an old client would show "thinking" for five
 * minutes about nothing.
 */
async function threadSignals(
  db: Db,
  userId: string,
  on: boolean,
): Promise<{ wakeAdvised: boolean; coachThinking: boolean; outOfCredits: OutOfCredits | null }> {
  // "Coach is thinking" must survive navigation (user report 2026-08-12) —
  // and, since 2026-08-17, it is what the client watches INSTEAD of the
  // wake's own response, which it no longer waits for. Either way the truth
  // comes from the server: a live wake lock, or a still-unanswered message.
  //
  // Same window as the lock's own takeover (`WAKE_LOCK_STALE_MINUTES`), and
  // the holder heartbeats: a wake that is genuinely alive keeps saying so
  // however long it thinks, and a wake whose isolate died stops claiming to
  // think within one window rather than misreporting for ten minutes.
  const [wakeLock] = await db
    .select({ claimedAt: coachLocks.claimedAt })
    .from(coachLocks)
    .where(and(eq(coachLocks.userId, userId), eq(coachLocks.kind, "wake")))
    .limit(1);
  const lockFresh =
    !!wakeLock && Date.now() - Date.parse(wakeLock.claimedAt) < WAKE_LOCK_STALE_MINUTES * 60_000;
  if (!on) return { wakeAdvised: false, coachThinking: lockFresh, outOfCredits: null };

  const triggers = await pendingTriggers(db, userId);
  // Shares the wake pipeline's own "would an open wake be redundant?" check,
  // and passes the TRIGGERS rather than their count: which kind is pending is
  // the whole question. An unanswered message always earns a wake; an ambient
  // signal has to outlive the quiet window after the last briefing, because
  // otherwise a page visit minutes after a full briefing bills another Opus
  // call to say the same thing (live, 2026-08-17 — see
  // AMBIENT_TRIGGER_QUIET_MINUTES). A recent failed/resting attempt still
  // wins over both.
  const wakeAdvised = !(await openWakeIsFresh(db, userId, triggers));
  const pendingReply = triggers.some(
    (t) => t.kind === "unanswered_message" && Date.now() - Date.parse(t.firedAt) < 5 * 60_000,
  );
  // THE AI ACCOUNT IS OUT OF CREDITS (owner report 2026-10-09). A 402 ends a
  // wake in a second and leaves the reply owed, so `pendingReply` alone said
  // "thinking" for five minutes about nothing — and the screen had nothing else
  // to say. The record (ai-credits.ts) is what it says instead; a wake actually
  // running (`lockFresh`) still reads as thinking, which is right while it is
  // the call that finds out the credits are back.
  const outOfCredits = await loadOutOfCredits(db, userId);
  return { wakeAdvised, coachThinking: lockFresh || (pendingReply && !outOfCredits), outOfCredits };
}

/**
 * What the coach actually costs, by kind, over the same rolling 7 days the
 * budget cutoff uses.
 *
 * `llm_usage` has recorded every call since launch and nothing ever read it
 * back, which is the only reason a per-page-visit wake could bill $0.33 twice
 * in fourteen minutes without anyone noticing. Deliberately NOT folded into
 * `/coach/state`: that endpoint polls every three seconds while the coach is
 * thinking, and an aggregate nobody is watching does not belong on a hot
 * path. This is a separate, on-demand read — one grouped query, no joins.
 *
 * `spentMicros` is the same figure `llmBudgetStatus` gates on, so the totals
 * here and the "coach is resting" cutoff can never disagree.
 */
coachRoutes.get("/spend", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await db
    .select({
      kind: llmUsage.kind,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${llmUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${llmUsage.outputTokens})`,
      costMicros: sql<number>`sum(${llmUsage.costMicros})`,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)))
    .groupBy(llmUsage.kind);
  const byKind = rows
    .map((r) => ({
      kind: r.kind,
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      costMicros: Number(r.costMicros ?? 0),
    }))
    .sort((a, b) => b.costMicros - a.costMicros);
  const spentMicros = byKind.reduce((sum, r) => sum + r.costMicros, 0);
  return c.json({
    since,
    spentMicros,
    // Dollars alongside micros so a human reading the raw JSON doesn't have
    // to divide by a million to know whether to worry.
    spentUsd: Math.round(spentMicros / 10_000) / 100,
    warnMicros: LLM_BUDGET.warnMicros,
    cutoffMicros: LLM_BUDGET.cutoffMicros,
    byKind,
  });
});

/**
 * A WAKE IS AWAITED INSIDE ITS REQUEST — and the CLIENT is what gets
 * decoupled (2026-08-17, second attempt).
 *
 * The first attempt handed the wake to `waitUntil` so that a client abort
 * could not cut the thinking short. Prod answered inside one wake:
 *
 *   waitUntil() tasks did not complete within the allowed time after
 *   invocation end and have been cancelled.
 *
 * Zero coach messages, zero `llm_usage` rows, the trigger still unconsumed:
 * the detached task was killed before the first model call even came back,
 * so the persist-early invariant never got the chance to fire. Post-response
 * execution is not somewhere work the athlete is waiting on can live.
 *
 * The same forensics exonerate the synchronous handler. Its `finally` ran
 * (`coach_locks` was empty afterwards) and one of its D1 writes landed 42s
 * AFTER the client's own 320s abort had already fired. The runtime was never
 * the constraint — the client's timeout was, and coupling the two made the
 * athlete's patience the ceiling on the coaching.
 *
 * So the wake goes back inside the request, and the client stops depending
 * on the response: `api-client` sends these with no deadline at all, and the
 * UI drives its "thinking" state from `/coach/state`'s `coachThinking` (live
 * wake lock, or a message still awaiting its reply) polled every 3s. A fetch
 * that never resolves is then merely uninteresting.
 *
 * What does NOT change: the athlete's words and the awaiting-reply trigger
 * are persisted before the wake starts thinking (`recordAthleteMessage`),
 * which is what makes the reply survive the tab closing; and the wake still
 * persists its briefing the first moment one parses.
 */
coachRoutes.post("/wake", async (c) => {
  // Stepped back (§8 §6): a cached old client's Plan visit or Check in starts nothing — "skipped", as a wake with
  // nothing to say answers, before a statement is read.
  if (!threadCoachEnabled(c.env)) return c.json({ status: "skipped" } satisfies WakeResult);
  const db = c.get("db");
  const userId = c.get("userId");
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const prefs = await loadPreferences(db, userId);
  // force = the user's own "Check in" button: bypasses the skip rule (a
  // fresh briefing doesn't matter — they asked), never the budget gate.
  const result = await wake(db, c.env, userId, prefs, { kind: force ? "manual" : "open" });
  return c.json(result);
});

/**
 * Peek at a CACHED read (System 2): the dashboard's expanded session shows
 * an existing read automatically, and a read that doesn't exist stays a
 * deliberate, visibly-priced tap (the POST below). This never generates,
 * never claims a ledger row, and spends nothing.
 */
coachRoutes.get("/analyze/:activityId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const [existing] = await db
    .select()
    .from(coachReads)
    .where(
      and(eq(coachReads.userId, userId), eq(coachReads.activityId, c.req.param("activityId"))),
    )
    .limit(1);
  if (!existing || existing.status !== "done") return c.json({ read: null });
  return c.json({
    read: {
      id: existing.id,
      glance: existing.glance ?? "",
      body: existing.body ?? "",
      flags: existing.flags,
      at: existing.completedAt ?? existing.createdAt,
    },
  });
});

coachRoutes.post("/analyze/:activityId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const prefs = await loadPreferences(db, userId);
  // Read-through on the perception ledger (rework spec §2): the ledger is
  // the single source of truth, so a user tap and the ambient pipeline can
  // never double-read the same effort.
  const r = await ensureRead(db, c.env, userId, prefs, c.req.param("activityId"), {
    force: force === true,
  });
  if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
  if (r.status === "working") return c.json({ status: "working" }, 202);
  if (r.status === "resting") {
    return c.json({ error: "resting", detail: "Weekly coach budget reached — try next week." }, 429);
  }
  if (r.status === "ai_disabled") return c.json({ error: "ai_disabled" }, 503);
  if (r.status === "out_of_credits") return c.json({ error: "out_of_credits" }, 402);
  if (r.status === "error" || !r.read) return c.json({ error: "llm_error" }, 502);
  return c.json({ read: r.read, cached: r.cached === true });
});

coachRoutes.post("/message", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { body } = await c.req.json<{ body?: string }>().catch(() => ({ body: undefined }));
  if (!body || typeof body !== "string" || body.length > 4000) {
    return c.json({ error: "bad_request" }, 400);
  }
  if (!threadCoachEnabled(c.env)) {
    // Stepped back (§8 §6): a cached old client's message (its Extend, its Wind down, its chat) is kept, and answered
    // with where the coach is now — no wake, and no awaiting-reply mark, which nothing would ever answer and which an
    // old client reads as "thinking" for five minutes. One statement, both rows; the receipt a millisecond after the
    // words, so the thread reads them in that order.
    const at = Date.now();
    await db.insert(coachMessages).values([
      { id: newId(), userId, role: "user", body, refs: {}, at: new Date(at).toISOString() },
      { id: newId(), userId, role: "receipt", body: THREAD_COACH_STEPPED_BACK, refs: {}, at: new Date(at + 1).toISOString() },
    ]);
    return c.json({ status: "skipped" } satisfies WakeResult);
  }
  const prefs = await loadPreferences(db, userId);
  // The words and the awaiting-reply trigger land BEFORE anything that can
  // fail, so a client that never sees this request finish still sees its own
  // message in the thread and still gets the reply on the next open.
  await recordAthleteMessage(db, userId, body);
  const result = await wake(db, c.env, userId, prefs, { kind: "message", body, recorded: true });
  return c.json(result);
});

coachRoutes.post("/proposals/:id/approve", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [p] = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.id, id), eq(coachProposals.userId, userId)))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  // A designed proposal is approved op by op — its workouts through the Studio's create and revise path (Stage 3 Task
  // 8), its changes through the applier one op each (Task 8b) — never as a whole thread proposal's CoachOps.
  if (isDesignedProposal(p.ops)) return approveDesigned(c, p, (today) => sweepExpiredProposals(db, userId, today));
  if (p.status !== "pending") return c.json({ error: "not_pending", status: p.status }, 409);

  const prefs = await loadPreferences(db, userId);
  // A PROPOSAL WHOSE MOMENT HAS PASSED IS NOT APPROVABLE, whether or not a
  // sweep has run yet (audit 1, coach finding 2). `expiresAt` is capped at the
  // first day the ops touch, and the sweep only runs on state reads and the
  // hourly job — so a page left open overnight could approve yesterday's "skip
  // today's tempo" against a session that has since been run. Expiring it here
  // is the same sweep, with the same receipt; the 409 is the one every other
  // stale tap already gets. (Together with `applyOps`'s per-op state guard this
  // re-asserts the wake's fatal checks at the tap: nothing an op names can be
  // dated before today, and nothing resolved since the wake is touched.)
  const today = todayInZone(prefs.timezone);
  // …but a plan part-applied (§8 §4) is the athlete's already: its next approve finishes it, whatever the date.
  if (p.expiresAt < today && !structuralStarted(p.ops)) {
    await sweepExpiredProposals(db, userId, today);
    return c.json({ error: "not_pending", status: "expired" }, 409);
  }
  // A proposal that shapes a plan is approved a chunk a request, answering `remaining` until done (thread-structural.ts).
  if ((p.ops as CoachOp[]).some(isStructuralOp)) return approveStructural(c, p, prefs, (body) => receipt(db, userId, body, p.id));
  const applied = await applyOps(db, userId, prefs, p.id, p.ops as CoachOp[]);
  await db
    .update(coachProposals)
    .set({ status: "approved", resolvedAt: nowInstant() })
    .where(eq(coachProposals.id, id));
  // COMMITTED. From here on the answer is success whatever else goes wrong (2026-10-10): the owner's approve applied
  // and the client was told it had failed, so the second tap met 409 not_pending. Nothing below may turn an applied
  // proposal into an error.
  //
  // The receipt tells the truth about what the apply could not do. An op that
  // promised a change and made none used to be invisible here: the athlete
  // read "✓ approved" and believed their plan had changed.
  const shortfall = applied.missed.length > 0 ? ` · ${applied.missed.join("; ")}` : "";
  await receipt(db, userId, `✓ approved — ${p.title}${shortfall}`, p.id).catch((e: unknown) =>
    console.error(`approve ${p.id}: applied, but the receipt failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  // Same aftermath as the athlete's own edits: the garden forgets what the
  // ops resolved/archived/restored, and the calendar follows the plan — one bounded step of it in this request
  // (CALENDAR_OPS_PER_REQUEST); the half-hourly reconcile books whatever it left.
  if (applied.resimFrom) await resimulateFrom(db, userId, applied.resimFrom, prefs, new Date(), REQUEST_GARDEN_STEP).catch(() => undefined);
  waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps: CALENDAR_OPS_PER_REQUEST }).catch(() => undefined));
  // THE WATCH WRITES RUN IN A REQUEST OF THEIR OWN (ruling 3-R11). This route used to run the whole cloud lane (cap 3)
  // in its own invocation: one strength rewrite on top of the approve measured 65 D1 statements + fetches against the
  // free plan's 50 per invocation. Now it answers `coachDrain` and the client drains (`POST /api/coach/drain`, one job
  // a request); the hourly lane runs whatever no client drained.
  const coachDrain = await coachDrainQueued(db, userId).catch(() => false);
  return c.json({ ok: true, applied, ...(coachDrain ? { coachDrain: true } : {}) });
});

/**
 * `POST /api/coach/drain`: run at most ONE queued coach watch write — a session's create, rewrite or unpush, or a
 * coach move's COROS date move (`COACH_DRAIN_KINDS`) — in a request of its own (ruling 3-R11). The client calls it
 * after an approve, or the sync banner's Retry, answers `coachDrain`, and again while it answers `executed: 1`.
 * Reads and program pushes are left to the lanes that run them. `{executed}`.
 */
coachRoutes.post("/drain", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const { executed } = await executeCloudJobs(db, c.env, userId, prefs, { cap: 1, onlyKinds: COACH_DRAIN_KINDS });
  return c.json({ executed });
});

/**
 * One proposal's status — what the card reads after a tap whose answer never came back (a dropped connection, a
 * 5xx), before it says anything: the approve may well have applied. A designed proposal answers its manifest too: the
 * workouts' `lines` and the changes' (`changes`), each with how its op ended (Stage 3 Tasks 8, 8b). 404 `not_found`.
 */
coachRoutes.get("/proposals/:id", async (c) => {
  const [p] = await c
    .get("db")
    .select({ id: coachProposals.id, status: coachProposals.status, resolvedAt: coachProposals.resolvedAt, ops: coachProposals.ops })
    .from(coachProposals)
    .where(and(eq(coachProposals.id, c.req.param("id")), eq(coachProposals.userId, c.get("userId"))))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  const { ops, ...status } = p;
  const manifest = isDesignedProposal(ops) ? await designedLines(c, ops, p.id) : undefined;
  return c.json(manifest ? { ...status, ...manifest } : status);
});

/** A designed workout's draft, for Edit before approve (Stage 3 Task 8; routes/design-proposals.ts). */
coachRoutes.get("/proposals/:id/ops/:opId/draft", designedDraft);

coachRoutes.post("/proposals/:id/decline", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [p] = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.id, id), eq(coachProposals.userId, userId)))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  // Declined op by op too (Stage 3 Task 8), with the athlete's reason kept for the coach.
  if (isDesignedProposal(p.ops)) return declineDesigned(c, p);
  if (p.status !== "pending") return c.json({ error: "not_pending", status: p.status }, 409);
  await db
    .update(coachProposals)
    .set({ status: "declined", resolvedAt: nowInstant() })
    .where(eq(coachProposals.id, id));
  await receipt(db, userId, `Left as planned — ${p.title}`, p.id);
  return c.json({ ok: true });
});

coachRoutes.post("/questions/:id/answer", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const { answer } = await c.req.json<{ answer?: string }>().catch(() => ({ answer: undefined }));
  if (!answer || answer.length > 500) return c.json({ error: "bad_request" }, 400);
  const [q] = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.id, id), eq(coachQuestions.userId, userId)))
    .limit(1);
  if (!q) return c.json({ error: "not_found" }, 404);
  if (q.answeredAt) return c.json({ error: "already_answered" }, 409);
  const now = nowInstant();
  const memoryId = newId();
  await db.insert(coachMemory).values({
    id: memoryId,
    userId,
    kind: "fact",
    body: `${q.body} → ${answer}`,
    provenance: { source: "question", messageId: q.id, at: now },
    learnedAt: now,
    active: true,
  });
  await db
    .update(coachQuestions)
    .set({ answeredAt: now, memoryId })
    .where(eq(coachQuestions.id, id));
  // Stepped back (§8 §6): the answer is kept as the fact above, and wakes no one.
  if (!threadCoachEnabled(c.env)) return c.json({ ok: true, memoryId, wake: { status: "skipped" } satisfies WakeResult });
  // The answer continues the conversation like any message.
  const prefs = await loadPreferences(db, userId);
  await recordAthleteMessage(db, userId, answer);
  const result = await wake(db, c.env, userId, prefs, { kind: "message", body: answer, recorded: true });
  return c.json({ ok: true, memoryId, wake: result });
});

coachRoutes.post("/questions/:id/dismiss", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const [q] = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.id, c.req.param("id")), eq(coachQuestions.userId, userId)))
    .limit(1);
  if (!q) return c.json({ error: "not_found" }, 404);
  if (!q.answeredAt) {
    await db.update(coachQuestions).set({ answeredAt: nowInstant() }).where(eq(coachQuestions.id, q.id));
  }
  return c.json({ ok: true });
});

coachRoutes.get("/memory", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Live memory only (memory-core.ts): never a rehearsal run's, never an item a newer one superseded. This read has no
  // timezone (loading one would be a statement more), so an expiry is judged against the earliest local date anywhere
  // now (UTC−12): an item still live somewhere is listed, and the hourly sweep retires one that lapsed in the
  // athlete's own zone (`sweepUserProposals`), as it always has.
  // Memory v2 (Stage 3 Task 10): the same read also brings the superseded history (`memoryHistoryWhere`), which the list
  // shows under the item that replaced it — only chains whose newest item is live (fix wave 3B, A-M4); `memory` stays
  // exactly the live items, as before.
  const today = todayInZone(EARLIEST_ZONE);
  const rows = await db
    .select()
    .from(coachMemory)
    .where(or(liveMemoryWhere(userId, today), memoryHistoryWhere(userId, today)))
    .orderBy(desc(coachMemory.learnedAt));
  return c.json({ memory: rows.filter((r) => r.supersededBy === null), history: rows.filter((r) => r.supersededBy !== null) });
});

/** A memory item's words, at most (an edit; the coach's own `remember` keeps the same). */
const MEMORY_BODY_MAX = 300;

/**
 * Edit, pin or confirm one of the athlete's live items (memory v2, Stage 3 Task 10): `{ body?, pinned?, confirm? }`, at
 * least one. `confirm: true` makes the coach's inference the athlete's confirmed item (what they said stays theirs). A
 * pin past MEMORY_PIN_CAP live pinned items is refused (409). Only their own live item — never another athlete's, a
 * superseded or deleted one, or a rehearsal's (404). One guarded write; a refusal reads once more to say which.
 */
coachRoutes.patch("/memory/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const raw = (await c.req.json().catch(() => null)) as { body?: unknown; pinned?: unknown; confirm?: unknown } | null;
  const body = raw?.body;
  const pinned = raw?.pinned;
  const confirm = raw?.confirm;
  if (
    !raw ||
    (body === undefined && pinned === undefined && confirm === undefined) ||
    (body !== undefined && (typeof body !== "string" || !body || body.length > MEMORY_BODY_MAX)) ||
    (pinned !== undefined && typeof pinned !== "boolean") ||
    (confirm !== undefined && confirm !== true)
  ) {
    return c.json({ error: "bad_request" }, 400);
  }
  const m = coachMemory;
  const live = liveMemoryWhere(userId, todayInZone(EARLIEST_ZONE));
  // A new pin only while the live pinned items are under the cap (an item already pinned is no new pin).
  const roomToPin =
    pinned === true
      ? sql`(${m.pinned} = 1 or (select count(*) from ${m} where ${and(live, eq(m.pinned, true))}) < ${MEMORY_PIN_CAP})`
      : sql`1 = 1`;
  const [item] = await db
    .update(m)
    .set({
      ...(typeof body === "string" ? { body } : {}),
      ...(typeof pinned === "boolean" ? { pinned } : {}),
      ...(confirm === true ? { confidence: sql`case when ${m.confidence} = 'inferred' then 'confirmed' else ${m.confidence} end` } : {}),
      updatedAt: nowInstant(),
    })
    .where(and(eq(m.id, id), eq(m.userId, userId), eq(m.active, true), isNull(m.supersededBy), sql`not ${REHEARSAL_MEMORY}`, roomToPin))
    .returning();
  if (item) return c.json({ ok: true, item });
  // Which refusal: the item is no live item of theirs, or the pins are full.
  const [mine] = await db
    .select({ id: m.id })
    .from(m)
    .where(and(eq(m.id, id), eq(m.userId, userId), eq(m.active, true), isNull(m.supersededBy), sql`not ${REHEARSAL_MEMORY}`))
    .limit(1);
  if (!mine) return c.json({ error: "not_found" }, 404);
  return c.json({ error: "pin_cap", max: MEMORY_PIN_CAP, why: `You can pin up to ${MEMORY_PIN_CAP}. Unpin one first.` }, 409);
});

coachRoutes.delete("/memory/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Immediate and total (spec §5): the next dossier simply lacks the item.
  await db
    .update(coachMemory)
    .set({ active: false })
    .where(and(eq(coachMemory.id, c.req.param("id")), eq(coachMemory.userId, userId)));
  return c.json({ ok: true });
});

coachRoutes.get("/plans", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const rows = await db.select().from(coachPlans).where(eq(coachPlans.userId, userId));
  // Studio-authored lifting plans are real plans this app created and wrote
  // to COROS — "Manage plans" claiming "no plans" while one is live on the
  // watch reads as a lie. They carry source:"studio" so the UI renders them
  // with Studio affordances instead of coach ones.
  // Newest studio plan only: generate keeps full history and each replace
  // retires the previous plan's COROS sessions — listing superseded rows as
  // live would be the same lie pointed the other way.
  //
  // And only while something of it is (or was) on the watch: the generator's
  // screens are retired (Stage 2), so a draft it never pushed is nothing the
  // athlete can act on, and listing it hid the lifting intake card. One that
  // was retired leaves the list; one past its last day reads as completed.
  const today = todayInZone(prefs.timezone);
  const studio = (
    await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
      .orderBy(desc(studioPlans.createdAt))
      .limit(1)
  )[0];
  const studioEntries = [];
  // Its pushes' statuses: one row each (a plan's sessions, not more).
  const pushStatuses = studio
    ? (
        await db
          .select({ status: studioPlanPushes.status })
          .from(studioPlanPushes)
          .where(eq(studioPlanPushes.planId, studio.id))
      ).map((p) => p.status)
    : [];
  if (studio && pushStatuses.some((s) => s !== "deleted") && !(await studioPlanRetired(db, userId, studio.id))) {
    // Real span from the brief the plan was generated with — createdAt-based
    // dates rendered "wk 1/1 · ends <creation day>" for a 16-week plan that
    // hadn't even started (2026-08-12 audit finding 6).
    const brief = studio.brief as { startDate?: string } | null;
    const start = brief?.startDate ?? studio.createdAt.slice(0, 10);
    const end = studioPlanEnd(studio);
    // "Written to COROS" only when a push has actually materialized there —
    // generate and push are separate actions.
    const status: "active" | "draft" | "completed" =
      end < today ? "completed" : pushStatuses.includes("verified") ? "active" : "draft";
    studioEntries.push({
      id: studio.id,
      discipline: "lift" as const,
      name: ((studio.plan as { name?: string })?.name ?? "Lifting plan"),
      status,
      startDate: start,
      endDate: end,
      raceDate: prefs.raceDate,
      source: "studio" as const,
    });
  }

  // The imported COROS plan IS the user's running plan — a page that shows
  // its 35 workouts while the run slot claims "no plan" denies reality
  // (audit finding 6). Read-only card: the app doesn't author these.
  const corosPlans = await db
    .select()
    .from(trainingPlans)
    .where(
      and(
        eq(trainingPlans.userId, userId),
        eq(trainingPlans.status, "active"),
        eq(trainingPlans.provider, "coros"),
      ),
    );
  const corosEntries = [];
  if (corosPlans.length > 0) {
    const owned = await db
      .select({
        planId: plannedWorkouts.planId,
        sport: plannedWorkouts.sport,
        date: plannedWorkouts.effectiveDate,
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          isNull(plannedWorkouts.archivedAt),
          inArray(
            plannedWorkouts.planId,
            corosPlans.map((p) => p.id),
          ),
        ),
      );
    for (const p of corosPlans) {
      const mine = owned.filter((w) => w.planId === p.id);
      const runs = mine.filter((w) => w.sport === "run");
      // A RUN card only for the plan that is actually the running plan:
      // majority-run and still holding future run work. (The strength
      // container the studio pushes into also lives in training_plans and
      // owns a couple of stray runs — it must not masquerade as one.)
      const futureRun = runs.some((w) => w.date >= today);
      if (!futureRun || runs.length * 2 < mine.length) continue;
      const dates = mine.map((w) => w.date).sort();
      // COROS containers often carry NULL spans and code names — derive the
      // span from the workouts themselves and never render a bare code.
      const name = !p.name || p.name === "COROS plan" || looksLikeCodeTitle(p.name)
        ? "COROS running plan"
        : p.name;
      corosEntries.push({
        id: p.id,
        discipline: "run" as const,
        name,
        status: "active" as const,
        startDate: p.startDate ?? dates[0]!,
        endDate: p.endDate ?? dates[dates.length - 1]!,
        raceDate: prefs.raceDate,
        source: "coros" as const,
      });
    }
  }

  // `kind` is what stops a container of loose sessions from being drawn as a
  // training block. It is derived, not stored, so the two "Coach one-offs"
  // rows already in production classify correctly with no data repair.
  const looseCounts = new Map<string, { sessions: number; done: number; first: string; last: string }>();
  const looseIds = rows.filter((r) => isLoosePlan(r)).map((r) => r.id);
  if (looseIds.length > 0) {
    const held = await db
      .select({
        planId: plannedWorkouts.planId,
        date: plannedWorkouts.effectiveDate,
        state: plannedWorkouts.completionState,
        category: plannedWorkouts.category,
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          inArray(plannedWorkouts.planId, looseIds),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
    for (const w of held) {
      if (w.category === "rest") continue;
      const agg = looseCounts.get(w.planId) ?? { sessions: 0, done: 0, first: w.date, last: w.date };
      agg.sessions += 1;
      if (w.state === "completed") agg.done += 1;
      if (w.date < agg.first) agg.first = w.date;
      if (w.date > agg.last) agg.last = w.date;
      looseCounts.set(w.planId, agg);
    }
  }

  return c.json({
    plans: [
      ...rows.map((r) => {
        const loose = isLoosePlan(r);
        const held = looseCounts.get(r.id);
        return {
          ...r,
          raceDate: r.raceDate ?? prefs.raceDate,
          source: "coach" as const,
          kind: (loose ? "loose" : "block") as "loose" | "block",
          // A bucket reports what it HOLDS. Its row dates only say where its
          // one-offs happened to fall, so the contents are the truth and the
          // card renders from these instead of from a week counter.
          holds: loose
            ? {
                sessions: held?.sessions ?? 0,
                done: held?.done ?? 0,
                firstDate: held?.first ?? null,
                lastDate: held?.last ?? null,
              }
            : undefined,
        };
      }),
      ...studioEntries.map((e) => ({ ...e, kind: "block" as const })),
      ...corosEntries.map((e) => ({ ...e, kind: "block" as const })),
    ],
  });
});

/** Plan detail: weeks (firm/shape), prescribed progressions with series,
 * session counts (rework spec §4). Accepts coach- and studio-plan ids. */
coachRoutes.get("/plans/:id/detail", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const thisMonday = startOfIsoWeek(today);
  const weekIndexOf = (planW1: string, date: string): number =>
    Math.floor((Date.parse(startOfIsoWeek(date)) - Date.parse(planW1)) / (7 * 86_400_000)) + 1;

  const [cp] = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.id, id), eq(coachPlans.userId, userId)))
    .limit(1);
  if (cp) {
    // A loose-session bucket has no planned duration, so it has no weeks: the
    // loop below is skipped entirely rather than manufacturing a "week 1 of 1"
    // out of the day its one one-off happens to land on.
    const loose = isLoosePlan(cp);
    const planW1 = startOfIsoWeek(cp.startDate);
    const weekTotal = loose ? 0 : weekIndexOf(planW1, cp.endDate);
    const currentWeek =
      !loose && thisMonday >= planW1 && weekIndexOf(planW1, today) <= weekTotal
        ? weekIndexOf(planW1, today)
        : null;

    const shapeRows = await db.select().from(coachPlanWeeks).where(eq(coachPlanWeeks.planId, cp.id));
    const shapeByWeek = new Map(shapeRows.map((w) => [w.weekStart, w]));
    const workouts = await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.planId, cp.id),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
    const matches = workouts.length
      ? await db
          .select()
          .from(workoutCompletionMatches)
          .where(and(isNull(workoutCompletionMatches.undoneAt)))
      : [];
    const matchByWorkout = new Map(matches.map((m) => [m.workoutId, m]));
    const actIds = [...new Set(matches.map((m) => m.activityId))];
    const actRows = actIds.length ? await db.select().from(activities).where(eq(activities.userId, userId)) : [];
    const actById = new Map(actRows.map((a) => [a.id, a]));

    const weeks = [];
    const facts = [];
    for (let i = 1; i <= weekTotal; i++) {
      const weekStart = addDays(planW1, (i - 1) * 7);
      const weekEnd = addDays(weekStart, 6);
      const inWeek = workouts.filter((w) => w.effectiveDate >= weekStart && w.effectiveDate <= weekEnd);
      const nonRest = inWeek.filter((w) => w.category !== "rest");
      const shape = shapeByWeek.get(weekStart);
      const state: "firm" | "shape" = shape?.state === "shape" ? "shape" : "firm";
      const done = weekEnd < today && nonRest.length > 0 && nonRest.every((w) => w.completionState === "completed");
      const longRunMeters = nonRest.reduce<number | null>(
        (m, w) => (w.expectedDistanceMeters ? Math.max(m ?? 0, w.expectedDistanceMeters) : m),
        null,
      );
      const plannedSeconds = nonRest.reduce(
        (s, w) => s + (w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 0),
        0,
      );
      let actualSeconds: number | null = null;
      for (const w of nonRest) {
        const m = matchByWorkout.get(w.id);
        const a = m ? actById.get(m.activityId) : undefined;
        if (a) actualSeconds = (actualSeconds ?? 0) + a.durationSeconds;
      }
      // COROS structured names are frequently opaque codes ("T1004") — the
      // weeks list speaks category words instead when the title is one.
      const keyTitles = nonRest
        .filter((w) => w.category === "long" || w.category === "quality" || w.sport === "strength")
        .map((w) => humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype))
        .slice(0, 2);
      const summary =
        state === "shape"
          ? (shape?.shape?.volumeTarget ?? "outline — the coach firms this up as it approaches")
          : keyTitles.length
            ? keyTitles.join(" · ")
            : nonRest.length
              ? `${nonRest.length} sessions`
              : "quiet week";
      weeks.push({
        weekStart,
        index: i,
        state,
        volumeTarget: shape?.shape?.volumeTarget ?? null,
        keySessions: shape?.shape?.keySessions ?? [],
        summary,
        done,
        current: currentWeek === i,
      });
      facts.push({ week: i, longRunMeters, plannedSeconds, actualSeconds, done });
    }

    // Coach-authored lift plans keep their structure (spec §5) — graph it.
    let progressions;
    if (cp.discipline === "lift") {
      // The actual exercise name, every place (round 3): code-named
      // exercises resolve through the COROS catalog before anything graphs
      // or summarizes them.
      const catalog = await exerciseNameMap(db);
      const liftWeeks = weeks.map((wk) => ({
        sessions: workouts
          .filter(
            (w) =>
              w.effectiveDate >= wk.weekStart &&
              w.effectiveDate <= addDays(wk.weekStart, 6) &&
              w.structuredJson?.exercises,
          )
          .map((w) => ({
            title: w.title,
            weekday: 1,
            exercises: (
              (w.structuredJson?.exercises ?? []) as LiftingPlan["weeks"][number]["sessions"][number]["exercises"]
            ).map((ex) => ({
              ...ex,
              // Coach exercises carry no originId when the athlete's catalog
              // has no match (2026-08-16). liftProgressions groups BY
              // originId, so a shared `undefined` would merge every
              // off-catalog movement into one bogus series — the name is
              // the identity when the catalog has none.
              originId: ex.originId ?? `name:${ex.name.trim().toLowerCase()}`,
              weight: ex.weight ?? { type: "bodyweight" },
              name: resolveExerciseName(ex.name, ex.originId, catalog),
            })),
          })),
      }));
      const doneWeeks = new Set(facts.filter((f) => f.done).map((f) => f.week));
      // What was actually lifted, per week (watch or app sets, Phase 2a+).
      const loggedTopKg = await loggedTopKgByWeek(db, userId, {
        weekOne: planW1,
        weeks: weekTotal,
        originIds: liftWeeks.flatMap((wk) => wk.sessions.flatMap((s) => s.exercises.map((ex) => ex.originId))),
      });
      progressions = liftProgressions({ weeks: liftWeeks }, doneWeeks, currentWeek, 3, loggedTopKg);
    } else {
      progressions = runProgressions(facts, currentWeek);
    }

    const nonRestAll = workouts.filter((w) => w.category !== "rest");
    // A bucket's adherence is over what it HOLDS. Measured over its row dates
    // it would score a single day, because a bucket's dates say where its
    // first one-off fell, not what it contains.
    const dates = nonRestAll.map((w) => w.effectiveDate).sort();
    const adh = await coachBlockAdherence(
      db,
      userId,
      cp.id,
      loose ? (dates[0] ?? cp.startDate) : cp.startDate,
      loose ? (dates.at(-1) ?? cp.endDate) : cp.endDate,
      unseenCompletions,
    );
    return c.json({
      plan: {
        ...cp,
        raceDate: cp.raceDate ?? prefs.raceDate,
        source: "coach" as const,
        kind: (loose ? "loose" : "block") as "loose" | "block",
      },
      weeks,
      progressions,
      sessions: {
        planned: nonRestAll.length,
        done: nonRestAll.filter((w) => w.completionState === "completed").length,
      },
      adherencePct: adh === null ? null : Math.round(adh * 100),
    });
  }

  const [tp] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)))
    .limit(1);
  if (tp) {
    // Imported COROS plan (user nit, 2026-08-12): the card must OPEN — weeks
    // and run progressions derive from its planned workouts exactly like a
    // coach plan's, minus shape rows (an imported week is always concrete).
    const workouts = await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.planId, tp.id),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
    if (workouts.length === 0) return c.json({ error: "not_found" }, 404);
    const dates = workouts.map((w) => w.effectiveDate).sort();
    const startDate = tp.startDate ?? dates[0]!;
    const endDate = tp.endDate ?? dates[dates.length - 1]!;
    const planW1 = startOfIsoWeek(startDate);
    const weekTotal = Math.max(1, weekIndexOf(planW1, endDate));
    const currentWeek =
      thisMonday >= planW1 && weekIndexOf(planW1, today) <= weekTotal
        ? weekIndexOf(planW1, today)
        : null;

    const matches = await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(isNull(workoutCompletionMatches.undoneAt)));
    const matchByWorkout = new Map(matches.map((m) => [m.workoutId, m]));
    const actRows = await db.select().from(activities).where(eq(activities.userId, userId));
    const actById = new Map(actRows.map((a) => [a.id, a]));

    const weeks = [];
    const facts = [];
    for (let i = 1; i <= weekTotal; i++) {
      const weekStart = addDays(planW1, (i - 1) * 7);
      const weekEnd = addDays(weekStart, 6);
      const inWeek = workouts.filter((w) => w.effectiveDate >= weekStart && w.effectiveDate <= weekEnd);
      const nonRest = inWeek.filter((w) => w.category !== "rest");
      const done = weekEnd < today && nonRest.length > 0 && nonRest.every((w) => w.completionState === "completed");
      const longRunMeters = nonRest.reduce<number | null>(
        (m, w) => (w.expectedDistanceMeters ? Math.max(m ?? 0, w.expectedDistanceMeters) : m),
        null,
      );
      const plannedSeconds = nonRest.reduce(
        (acc, w) => acc + (w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 0),
        0,
      );
      let actualSeconds: number | null = null;
      for (const w of nonRest) {
        const m = matchByWorkout.get(w.id);
        const a = m ? actById.get(m.activityId) : undefined;
        if (a) actualSeconds = (actualSeconds ?? 0) + a.durationSeconds;
      }
      const keyTitles = nonRest
        .filter((w) => w.category === "long" || w.category === "quality" || w.sport === "strength")
        .map((w) => humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype))
        .slice(0, 2);
      const summary = keyTitles.length
        ? keyTitles.join(" · ")
        : nonRest.length
          ? `${nonRest.length} sessions`
          : "quiet week";
      weeks.push({
        weekStart,
        index: i,
        state: "firm" as const,
        volumeTarget: null,
        keySessions: [],
        summary,
        done,
        current: currentWeek === i,
      });
      facts.push({ week: i, longRunMeters, plannedSeconds, actualSeconds, done });
    }

    const nonRestAll = workouts.filter((w) => w.category !== "rest");
    return c.json({
      plan: {
        id: tp.id,
        discipline: "run" as const,
        name: !tp.name || tp.name === "COROS plan" || looksLikeCodeTitle(tp.name) ? "COROS running plan" : tp.name,
        status: "active" as const,
        startDate,
        endDate,
        raceDate: prefs.raceDate,
        source: "coros" as const,
      },
      weeks,
      progressions: runProgressions(facts, currentWeek),
      sessions: {
        planned: nonRestAll.length,
        done: nonRestAll.filter((w) => w.completionState === "completed").length,
      },
      adherencePct: null,
    });
  }

  const [sp] = await db
    .select()
    .from(studioPlans)
    .where(and(eq(studioPlans.id, id), eq(studioPlans.userId, userId)))
    .limit(1);
  if (sp) {
    // Same rule as the coach branch: real exercise names before graphing.
    const catalog = await exerciseNameMap(db);
    const raw = sp.plan as LiftingPlan;
    const plan: LiftingPlan = {
      ...raw,
      weeks: raw.weeks.map((wk) => ({
        ...wk,
        sessions: wk.sessions.map((s) => ({
          ...s,
          exercises: s.exercises.map((ex) => ({
            ...ex,
            name: resolveExerciseName(ex.name, ex.originId, catalog),
          })),
        })),
      })),
    };
    const planW1 = startOfIsoWeek(plan.brief.startDate);
    const weekTotal = plan.brief.durationWeeks;
    // The plan list's rule, from the brief the plan was made with (`studioPlanEnd`).
    const endDate = studioPlanEnd(sp);
    const currentWeek =
      thisMonday >= planW1 && weekIndexOf(planW1, today) <= weekTotal
        ? weekIndexOf(planW1, today)
        : null;

    const pushes = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, sp.id));
    // A push materializes on COROS and comes back as a planned workout keyed
    // `${corosPlanId}:${idInPlan}` — that row's completionState is the truth.
    const keys = pushes
      .filter((p) => p.corosPlanId && p.corosIdInPlan)
      .map((p) => ({ push: p, key: `${p.corosPlanId}:${p.corosIdInPlan}` }));
    const linked = keys.length
      ? await db
          .select(plannedRowColumns())
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt)))
      : [];
    const bySourceId = new Map(linked.map((w) => [w.sourceWorkoutId, w]));
    const doneWeeks = new Set<number>();
    const pushesByWeek = new Map<number, { total: number; completed: number }>();
    for (const { push, key } of keys) {
      const week = weekIndexOf(planW1, push.corosHappenDay ?? push.happenDay);
      const entry = pushesByWeek.get(week) ?? { total: 0, completed: 0 };
      entry.total += 1;
      if (bySourceId.get(key)?.completionState === "completed") entry.completed += 1;
      pushesByWeek.set(week, entry);
    }
    for (const [week, entry] of pushesByWeek) {
      if (entry.total > 0 && entry.completed === entry.total) doneWeeks.add(week);
    }

    // What was actually lifted, per week (watch or app sets, Phase 2a+).
    const loggedTopKg = await loggedTopKgByWeek(db, userId, {
      weekOne: planW1,
      weeks: weekTotal,
      originIds: plan.weeks.flatMap((wk) => wk.sessions.flatMap((s) => s.exercises.map((ex) => ex.originId))),
    });
    const progressions = liftProgressions(plan, doneWeeks, currentWeek, 3, loggedTopKg);
    const weeks = Array.from({ length: weekTotal }, (_, i) => ({
      weekStart: addDays(planW1, i * 7),
      index: i + 1,
      state: "firm" as const,
      volumeTarget: null,
      keySessions: [],
      summary: liftWeekSummary(plan, i + 1, prefs.weightUnit),
      done: doneWeeks.has(i + 1),
      current: currentWeek === i + 1,
    }));

    const [pushed] = pushes.filter((p) => p.status === "verified").slice(0, 1);
    // The list's words for it: retired by the athlete, over once its last day has passed, active while on the watch.
    const status: "active" | "draft" | "completed" | "retired" = (await studioPlanRetired(db, userId, sp.id))
      ? "retired"
      : endDate < today
        ? "completed"
        : pushed
          ? "active"
          : "draft";
    const duePushes = keys.filter(({ push }) => (push.corosHappenDay ?? push.happenDay) <= today);
    const doneCount = duePushes.filter(({ key }) => bySourceId.get(key)?.completionState === "completed").length;
    return c.json({
      plan: {
        id: sp.id,
        discipline: "lift" as const,
        name: plan.name ?? "Lifting plan",
        status,
        startDate: plan.brief.startDate,
        endDate,
        raceDate: prefs.raceDate,
        source: "studio" as const,
      },
      weeks,
      progressions,
      sessions: {
        planned: plan.weeks.reduce((s, w) => s + w.sessions.length, 0),
        done: keys.filter(({ key }) => bySourceId.get(key)?.completionState === "completed").length,
      },
      adherencePct: duePushes.length > 0 ? Math.round((doneCount / duePushes.length) * 100) : null,
    });
  }

  return c.json({ error: "not_found" }, 404);
});

coachRoutes.post("/plans/:id/rename", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  if (!name || name.length > 60) return c.json({ error: "bad_request" }, 400);
  await db
    .update(coachPlans)
    .set({ name, updatedAt: nowInstant() })
    .where(and(eq(coachPlans.id, c.req.param("id")), eq(coachPlans.userId, userId)));
  return c.json({ ok: true });
});

coachRoutes.post("/plans/:id/retire", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  // A slice a request, `remaining` until the plan is retired (§8 §4; thread-structural.ts).
  return retireInChunks(c, c.req.param("id"), prefs, (body) => receipt(db, userId, body));
});

/** Expiry sweep for the hourly cron (all users handled by the caller). */
export async function sweepUserProposals(db: Db, userId: string, timezone: string): Promise<void> {
  await sweepExpiredProposals(db, userId, todayInZone(timezone)).catch(() => 0);
  // Coached plans past their final day flip to completed, with a receipt
  // carrying the block's adherence (fairness spec §4).
  const today = todayInZone(timezone);
  const ended = (
    await db
      .select()
      .from(coachPlans)
      .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"), lt(coachPlans.endDate, today)))
  )
    // A bucket of one-offs never "completes": its last date is the last
    // session someone put in it, not a finish line. Left in, this cron said
    // "Block complete: Coach one-offs — 100% adherence" the morning after a
    // single one-off, then said it again after the next one (the next apply
    // flips the row back to active).
    .filter((p) => !isLoosePlan(p));
  for (const p of ended) {
    await db
      .update(coachPlans)
      .set({ status: "completed", updatedAt: nowInstant() })
      .where(eq(coachPlans.id, p.id));
    const adh = await coachBlockAdherence(db, userId, p.id, p.startDate, p.endDate, unseenCompletions);
    await receipt(
      db,
      userId,
      `Block complete: ${p.name}${adh !== null ? ` — ${Math.round(adh * 100)}% adherence` : ""}`,
    );
  }
  // Expire lapsed time-boxed memory notes with a receipt (spec §5).
  const lapsed = await db
    .select()
    .from(coachMemory)
    .where(
      and(
        eq(coachMemory.userId, userId),
        eq(coachMemory.active, true),
        lt(coachMemory.expiresAt, addDays(today, 0)),
      ),
    );
  for (const m of lapsed) {
    await db.update(coachMemory).set({ active: false }).where(eq(coachMemory.id, m.id));
    await receipt(db, userId, `Note expired: ${m.body}`);
  }
}
