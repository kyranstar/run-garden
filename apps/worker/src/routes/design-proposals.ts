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
 *        rest come back in `remaining`: call again with `{ opIds: remaining }` until it is empty
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
 *        and its changes to sessions already on the plan (`changes`, Task 8b) — a change has no draft (404)
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
import { loadPreferences } from "../services/calendar-sync.js";
import {
  approveDesignOps,
  declineDesignOps,
  designDraft,
  designedOps,
  NotOpenError,
  ProposalChangedError,
  UnknownOpError,
  type DesignProposalRow,
} from "../services/design-approve.js";
import { docWorkoutLines, placeNamer, planChangeLines } from "../services/design-manifest.js";
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
  if (p.status === "pending" && p.expiresAt < today) {
    await expire(today);
    return c.json({ error: "not_pending", status: "expired" }, 409);
  }
  try {
    const answer = await approveDesignOps(db, userId, p, parsed.data, { today, now: nowInstant(), prefs });
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

/** A designed proposal's manifest, for its one-proposal read: the workouts' lines (one statement, the places' names —
 * none for a proposal of changes alone) and the changes' (none). */
export async function designedLines(c: C, ops: unknown) {
  if (!coachDesignerEnabled(c.env)) return undefined;
  const workouts = designedOps(ops);
  return {
    lines: workouts.length > 0 ? docWorkoutLines(workouts, await placeNamer(c.get("db"), c.get("userId"))) : [],
    changes: planChangeLines(Array.isArray(ops) ? ops : []),
  };
}
