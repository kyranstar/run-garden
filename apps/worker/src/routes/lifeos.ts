/**
 * LifeOS, the owner's habit app, reads the plan: each day's planned sessions, rest days, and which sessions were
 * done (so its "Train as planned" habit follows run-garden). A read-only machine endpoint, not a browser one:
 *
 * - Auth is `Authorization: Bearer <token>`, its SHA-256 compared in constant time with the Worker secret
 *   `LIFEOS_TOKEN_SHA256`. The token is made on the owner's Mac and lives only there and on the phone; Cloudflare
 *   holds its hash. Without the secret the endpoint doesn't exist (404); a wrong or missing token is 401.
 * - The plan is the owner's (`ALLOWED_GOOGLE_EMAIL`) — or, with the LifeOS QA account's plan token (auth/qa-tokens.ts), the QA
 *   account's, for LifeOS QA on the phone (the phone QA harness). GET only; nothing is written; no cookie is read.
 *
 * The read itself is the phone's days' (services/plan-days.ts, DESIGN-2c §7.1): one query of the rows and one of their
 * standing matches, mapped here to v1 exactly as before, so this read and `/api/native/days` can't drift.
 */
import { Hono } from "hono";
import { daysBetween, isLocalDate } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { bearerGuard } from "../auth/token.js";
import { matchesOfRows, planDaysV1, readPlanRows } from "../services/plan-days.js";

export type { LifeosDay, LifeosSession } from "../services/plan-days.js";

/** At most this many days per request. */
export const LIFEOS_MAX_DAYS = 31;

/** The bearer door (auth/token.ts): 404 without the secret, 401 on a bad token, 503 during a restore. */
export const requireLifeosToken = bearerGuard((env) => env.LIFEOS_TOKEN_SHA256, { qaPlan: true });

export const lifeosRoutes = new Hono<AppContext>();

lifeosRoutes.use("*", requireLifeosToken);

lifeosRoutes.get("/plan", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isLocalDate(from) || !isLocalDate(to) || to < from || daysBetween(from, to) + 1 > LIFEOS_MAX_DAYS) {
    return c.json({ error: "bad_range" }, 400);
  }
  const db = c.get("db");
  const ownerId = c.get("userId");
  const rows = await readPlanRows(db, ownerId, from, to);
  const days = planDaysV1(rows, await matchesOfRows(db, ownerId, rows), from, to);
  c.header("Cache-Control", "no-store");
  return c.json({ version: 1, days });
});
