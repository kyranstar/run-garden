/**
 * TAKE-BACK (R1; the LifeOS migration's DESIGN-3 §3.4.3, §3.5 pairs 6–7): one route for places and approvals, bound to
 * their receipts (services/take-back.ts). Behind `requireUser`: a `training-v5` device or the laptop's cookie, the account's
 * own receipts only.
 *
 *   POST /api/native/take-back  { receiptIds: [1–12], requestId } → { requestId, outcomes: [per receipt, in the order named],
 *        remaining } — 200 whatever each receipt's outcome: `taken_back` (with what the providers still have to do, read
 *        live), `already_taken_back`, `not_found` (not a receipt of this account's), or `refused` with its reason and words
 *        (expired, past, executed, ineligible, has_dependents, group_incomplete, changed_since with how it stands now,
 *        group_refused, not_attempted). `remaining`: named and eligible, left for the next request (the statement budget):
 *        send them again with the same requestId. 400 bad_take_back for a body outside its shape.
 *   GET  /api/native/receipts/:id → { id, source, op, workoutId, status, createdAt, expiresAt, takenBackAt, compensation }
 *        — the receipt as it stands and the providers' work, live (`no-store`; 404 not_found; 503 during a restore).
 */
import { Hono } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { TAKE_BACK_MAX } from "../auth/device-scope.js";
import { restoreInProgress } from "../services/account-state.js";
import { madeByOf, receiptStatus, takeBack } from "../services/take-back.js";

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
  const answer = await takeBack(c.get("db"), c.env, c.get("userId"), { ...parsed.data, madeBy: madeByOf(c.get("device")) }, nowInstant());
  return c.json(answer);
});

nativeTakeBackRoutes.get("/receipts/:id", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return c.json({ error: "restore_in_progress", retryable: true }, 503);
  const r = await receiptStatus(db, userId, c.req.param("id")!);
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});
