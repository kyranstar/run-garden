/**
 * A DESIGNED WORKOUT'S PROPOSAL ON THE COACH'S ROUTES (Stage 3 spec §8; Task 8) — the coach designer's proposals share
 * `coach_proposals` with the thread coach's, and its approve and decline paths (routes/coach.ts hands a proposal holding
 * a `doc_workout` op here). Inert with the coach designer off (`COACH_DESIGNER`, or staging): approve and decline
 * answer 409 `not_yet` as they did before this task, and the draft is a 404 — nothing a designed proposal holds is
 * ever applied.
 *
 *   POST /api/coach/proposals/:id/approve  { opIds? } → { ok, status, applied, changed, refused, settled, remaining,
 *        coachDrain? } every op named (none: all) — the workouts through the Studio's create / revise path, the changes
 *        to sessions already on the plan through the thread coach's applier (Task 8b) — within one request's budget; the
 *        rest come back in `remaining`: call again with `{ opIds: remaining }` until it is empty. The request that ends
 *        it hands the calendar one bounded sync step, in the room its ops left (Task 9). A change another approve is
 *        applying (its claim under two minutes old — Task 8b's recovery rule) is never applied twice: it is named in
 *        `inFlight`, the others approved as usual; only when every op named is in flight (nothing else answered) is it
 *        409 { error: "in_flight", opIds, status, applied: [], changed: [], refused: [], settled: [], remaining: [] }
 *                                          { edit: { opId, doc, date?, time? } } → the same, for that op alone, with
 *        the athlete's version of its draft (Edit before approve); refused as a Studio save is (422 `invalid_doc` with
 *        every issue, `past_date`, `run_unsupported`; 409 `stale_revision` with `rev`, `not_editable`; 404), nothing
 *        recorded
 *   POST /api/coach/proposals/:id/decline  { opIds?, reason? } → { ok, status, declined, settled, inFlight? }: a change
 *        an approve is applying is never declined — it is named in `inFlight`, the others declined as usual, the status
 *        as their ops say; only when every op named is in flight (nothing declined, nothing changed) is it 409
 *        { error: "in_flight", opIds, status, declined: [], settled: [] }
 *   GET  /api/coach/proposals/:id/ops/:opId/draft → the op's document as the builder loads one (`doc`, `derived`,
 *        `rev: null`) with its `target`, `date`, `time`, `outcome` and the proposal's `status`
 *   GET  /api/coach/proposals/:id (routes/coach.ts) → for a designed proposal, also its manifest: the workouts' `lines`
 *        and its changes to sessions already on the plan (`changes`, Task 8b) — a change has no draft (404) — and, for a
 *        set's (a week or the next N), `context`: the plan's other sessions in its days (Task 13's fix wave, §2.9)
 *
 * 400 `unknown_op` (an op id the proposal doesn't hold) and `bad_request`; 409 `not_pending` with the status (a
 * proposal no longer the athlete's: expired — its day passed, as a thread proposal's — declined, approved, or never
 * shown), and `proposal_changed` (another request wrote it first: nothing lost, call again). services/design-approve.ts
 * has the rules.
 */
import type { Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { coachProposals } from "@rg/database";
import { isLocalDate, nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { waitUntilSafe } from "../services/wait-until.js";
import {
  approveDesignOps,
  calendarOpsFitting,
  declineDesignOps,
  designDraft,
  designedOps,
  NotOpenError,
  planStarted,
  ProposalChangedError,
  UnknownOpError,
  type DesignProposalRow,
} from "../services/design-approve.js";
import { docWorkoutLines, manifestReads, planChangeLines, planStructureLines, setContextSql } from "../services/design-manifest.js";
import { designProposalId } from "../services/design-tools/propose.js";
import { dayRowsSql, placedTimes } from "../services/design-placement.js";
import { clockIn, PastTimeError } from "../services/design-time.js";
import type { Db } from "../services/db.js";
import { refusal } from "./workouts.js";

type C = Context<AppContext>;

const OP_ID = z.string().min(1).max(200);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isLocalDate, "not a calendar date");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** A designed set holds at most a week's workouts; a request names no more than that, twice over. */
const OPS_MAX = 20;

const approveSchema = z
  .object({
    opIds: z.array(OP_ID).min(1).max(OPS_MAX).optional(),
    edit: z.object({ opId: OP_ID, doc: z.record(z.string(), z.unknown()), date: DATE.optional(), time: TIME.nullable().optional() }).strict().optional(),
  })
  .strict()
  .refine((b) => !(b.opIds && b.edit), "opIds or edit, not both");

const declineSchema = z
  .object({ opIds: z.array(OP_ID).min(1).max(OPS_MAX).optional(), reason: z.string().max(2000).optional() })
  .strict();

/** The body as JSON: none at all is `{}` (the thread panel's decline sends none); anything unreadable is null. */
async function bodyOf(c: C): Promise<unknown> {
  const text = await c.req.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function failed(c: C, e: unknown): Response {
  if (e instanceof NotOpenError) return c.json({ error: "not_pending", status: e.status }, 409);
  if (e instanceof UnknownOpError) return c.json({ error: "unknown_op", opIds: e.opIds }, 400);
  if (e instanceof ProposalChangedError) return c.json({ error: "proposal_changed" }, 409);
  // Edit before approve at a time today gone by (the polish round, 6): refused as a save is, in plain words.
  if (e instanceof PastTimeError) return c.json({ error: e.code, why: e.why }, 422);
  // Edit before approve: the athlete's version refused as a Studio save is.
  return refusal(c, e);
}

/**
 * `POST …/approve` for a designed proposal (`p`, read by the caller). A pending one whose day has passed is expired
 * first, by the caller's own sweep (`expire`), and answered as a thread proposal is.
 */
export async function approveDesigned(c: C, p: DesignProposalRow & { expiresAt: string }, expire: (today: string) => Promise<unknown>): Promise<Response> {
  if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_yet" }, 409);
  const parsed = approveSchema.safeParse(await bodyOf(c));
  if (!parsed.success) return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  // A whole plan change that has started is never expired under the athlete: the approve finishes it (§8 §5).
  if (p.status === "pending" && p.expiresAt < today && !(Array.isArray(p.ops) && p.ops.some(planStarted))) {
    await expire(today);
    return c.json({ error: "not_pending", status: "expired" }, 409);
  }
  try {
    const meter = { left: 0 };
    const answer = await approveDesignOps(db, userId, p, parsed.data, { today, now: nowInstant(), prefs }, undefined, meter);
    // A change another approve is applying is left to it (Task 8b's recovery rule): 409 only when nothing else was named.
    const { inFlight, ...rest } = answer;
    const nothingElse = [rest.applied, rest.changed, rest.refused, rest.settled, rest.remaining, rest.planned ?? []].every((xs) => xs.length === 0);
    if (inFlight && nothingElse) return c.json({ error: "in_flight", opIds: inFlight, ...rest }, 409);
    // The calendar follows the plan, as after a Studio save (Task 9): once the approve is over and this request wrote
    // something, one bounded step in the room its declared costs left — none when the chunk was full (the half-hourly
    // reconcile books what this leaves).
    const maxOps = calendarOpsFitting(meter.left);
    if (answer.remaining.length === 0 && (answer.applied.length > 0 || answer.changed.length > 0 || (answer.planned?.length ?? 0) > 0) && maxOps > 0) {
      waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps }).catch(() => undefined));
    }
    return c.json({ ok: true, ...answer });
  } catch (e) {
    return failed(c, e);
  }
}

/** `POST …/decline` for a designed proposal. */
export async function declineDesigned(c: C, p: DesignProposalRow): Promise<Response> {
  if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_yet" }, 409);
  const parsed = declineSchema.safeParse(await bodyOf(c));
  if (!parsed.success) return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  try {
    const answer = await declineDesignOps(c.get("db"), c.get("userId"), p, parsed.data, nowInstant());
    // A change an approve is applying is never declined (Task 8b's fix round, 1). The others are declined as usual: 200,
    // the change named in flight. Only when every op named is in flight — nothing declined, nothing changed — is it 409.
    const { inFlight, ...rest } = answer;
    if (inFlight && rest.declined.length === 0 && rest.settled.length === 0) return c.json({ error: "in_flight", opIds: inFlight, ...rest }, 409);
    return c.json({ ok: true, ...answer });
  } catch (e) {
    return failed(c, e);
  }
}

/** `GET …/ops/:opId/draft`. */
export async function designedDraft(c: C): Promise<Response> {
  if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const [p] = await c
    .get("db")
    .select({ id: coachProposals.id, status: coachProposals.status, ops: coachProposals.ops })
    .from(coachProposals)
    .where(and(eq(coachProposals.id, c.req.param("id")!), eq(coachProposals.userId, c.get("userId"))))
    .limit(1);
  const draft = p ? designDraft(p, c.req.param("opId")!) : null;
  if (!draft) return c.json({ error: "not_found" }, 404);
  return c.json(draft);
}

/** A designed proposal's manifest, for its one-proposal read: the workouts' lines (one statement, the places' names and
 * the athlete's settings — each line's time is the one an approve now would use, B-I1 — none for a proposal of changes
 * alone) and the changes' (none). */
export async function designedLines(c: C, ops: unknown, proposalId: string) {
  if (!coachDesignerEnabled(c.env)) return undefined;
  return designedManifest(c.get("db"), c.get("userId"), proposalId, ops, new Date());
}

/**
 * A designed proposal's manifest as the athlete reads it at `now`: each workout's line — its time where the approve will
 * put it, the day's other sessions and the proposal's own changes weighed (design-placement.ts `placedTimes`, B-I1) —
 * and each change's; and, for a set's (a `week` or `next_n` run's), `context`: the plan's other sessions in the set's
 * days (Task 13's fix wave, §2.9 — "plan my week" showed three workouts and nothing of the other days). One statement:
 * the places' names, the athlete's settings, the plan's rows the times are placed among and a set's context (none for a
 * proposal of changes alone).
 */
export async function designedManifest(db: Db, userId: string, proposalId: string, ops: unknown, now: Date) {
  const all = Array.isArray(ops) ? (ops as unknown[]) : [];
  const workouts = designedOps(ops);
  // A whole plan change's lines are its own (§8 §5): computed when it was proposed, no read.
  const plans = planStructureLines(all);
  const withPlans = plans.length > 0 ? { plans } : {};
  if (workouts.length === 0) return { lines: [], changes: planChangeLines(all), ...withPlans };
  const prefix = designProposalId("");
  const runId = proposalId.startsWith(prefix) ? proposalId.slice(prefix.length) : null;
  const reads = await manifestReads(db, userId, dayRowsSql(userId, all), setContextSql(userId, runId, all));
  const today = clockIn(reads.prefs.timezone, now).date;
  const placed = await placedTimes(userId, proposalId, all, reads.dayRows, { now, today, prefs: reads.prefs });
  return {
    // A designed run's card (§8 §3): its steps with the athlete's threshold, and whether an approve sends it to the watch.
    lines: docWorkoutLines(workouts, reads.placeName, { now, prefs: reads.prefs, placed }, { thresholdSecPerKm: reads.thresholdSecPerKm, corosWritesEnabled: reads.prefs.corosWritesEnabled === true }),
    changes: planChangeLines(all),
    ...withPlans,
    ...(reads.context ? { context: reads.context } : {}),
  };
}
