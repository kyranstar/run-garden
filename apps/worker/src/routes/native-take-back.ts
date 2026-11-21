/**
 * TAKE-BACK (R1; the LifeOS migration's DESIGN-3 §3.4.3, §3.5 pairs 6–7): one route for places and approvals, bound to
 * their receipts (services/take-back.ts). Behind `requireUser`: a `training-v5` device or the laptop's cookie, the account's
 * own receipts only — a phone's, only those it made (its places and approves: `made_by`); the laptop's, any.
 *
 *   POST /api/native/take-back  { receiptIds: [1–12], requestId } → { requestId, outcomes: [per receipt, in the order named],
 *        remaining } — 200 whatever each receipt's outcome: `taken_back` (with what the providers still have to do, read
 *        live), `already_taken_back`, `not_found` (not a receipt of this account's, or not this phone's), or `refused` with
 *        its reason and words (expired, past, executed, ineligible, cant_restore, has_dependents, group_incomplete,
 *        changed_since with how it stands now — `{date, time, state, archived, title, minutes}` — group_refused,
 *        not_attempted). `remaining`: named and eligible, left for the next request (the statement budget):
 *        send them again with the same requestId. 400 bad_take_back for a body outside its shape. With anything taken
 *        back, the calendar follows in the same request, in the room the take-back left (R1.2 item 7).
 *   GET  /api/native/receipts/:id → { id, source, op, workoutId, status, createdAt, expiresAt, takenBackAt, compensation }
 *        — the receipt as it stands and the providers' work, live (`no-store`; 404 not_found; 503 during a restore). A
 *        phone's read then runs that session's next watch step, after it answers (R1.2 item 7: services/device-watch.ts).
 *        A PHONE'S READ IS MUTATION-CAPABLE, though a GET (R1.3; the lead's v0.22 ruling): that step can write the session's
 *        copy and its push, or send a queued push or delete to COROS. LifeOS sends it only from its delivery, in the
 *        foreground, straight after a place or take-back and while its watch work is pending — never as a background or
 *        passive read. A check reads as the laptop (its cookie): that read runs no step, writes nothing and sends nothing.
 */
import { Hono } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { TAKE_BACK_MAX } from "../auth/device-scope.js";
import { restoreInProgress } from "../services/account-state.js";
import { syncCalendar } from "../services/calendar-sync.js";
import { calendarOpsFitting } from "../services/design-approve.js";
import { deviceWatchStep } from "../services/device-watch.js";
import { madeByOf, receiptStatus, takeBack } from "../services/take-back.js";
import { waitUntilSafe } from "../services/wait-until.js";

export const nativeTakeBackRoutes = new Hono<AppContext>();

const id = z.string().min(1).max(100);
const takeBackSchema = z
  .object({
    receiptIds: z.array(id).min(1).max(TAKE_BACK_MAX).refine((ids) => new Set(ids).size === ids.length, "a receipt named twice"),
    requestId: id,
  })
  .strict();

nativeTakeBackRoutes.post("/take-back", requireUser, async (c) => {
  const parsed = takeBackSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_take_back", issues: parsed.error.issues }, 400);
  const meter = { left: 0 };
  const answer = await takeBack(c.get("db"), c.env, c.get("userId"), { ...parsed.data, madeBy: madeByOf(c.get("device")) }, nowInstant(), meter);
  // The calendar follows in this request, as after the laptop's remove (R1.2 item 7) — in the room the take-back left
  // (`calendarOpsFitting`, as an approve's; the re-check's MAJOR-A): one receipt leaves room for one op, a grouped
  // take-back none, and the half-hourly run books what it leaves. The watch's delete never fits beside it (24 + ≈26 of
  // 45): the phone's read of the receipt, straight after, runs it.
  const ops = calendarOpsFitting(meter.left);
  if (ops > 0 && answer.outcomes.some((o) => o.outcome === "taken_back")) {
    waitUntilSafe(c, syncCalendar(c.get("db"), c.env, c.get("userId"), { maxOps: ops }).catch(() => undefined));
  }
  return c.json(answer);
});

nativeTakeBackRoutes.get("/receipts/:id", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return c.json({ error: "restore_in_progress", retryable: true }, 503);
  const r = await receiptStatus(db, userId, c.req.param("id")!, madeByOf(c.get("device")));
  if (!r) return c.json({ error: "not_found" }, 404);
  // THE WATCH FOLLOWS (R1.2 item 7): a phone's delivery reads a receipt straight after each place and each take-back, and
  // while its watch work is pending. That read runs its session's next watch step, one, after it answers
  // (services/device-watch.ts). The answer is the receipt as it stood; the next read says what the step did. So a phone's
  // read is mutation-capable (R1.3): never a passive check's. The laptop's runs no step.
  if (c.get("device")) waitUntilSafe(c, deviceWatchStep(db, c.env, userId, r.workoutId));
  return c.json(r);
});
