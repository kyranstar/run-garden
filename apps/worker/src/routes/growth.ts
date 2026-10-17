/**
 * `GET /api/growth/body?period=month|season` — Growth's body map (the new shape §7; services/growth-body.ts): how much
 * each area of the figure was worked over the last 30 or 90 days, what carried the period, the area gone quiet and the
 * period's longest holds. No period reads the month; one it does not know is refused (400 `bad_period`).
 *
 * Signed in; the session's statement and GROWTH_BODY_STATEMENTS (two). Growth is the app's own place, not the coach's:
 * it answers with the coach designer off too.
 */
import { Hono } from "hono";
import { GROWTH_PERIODS, type GrowthPeriod } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { growthBody } from "../services/growth-body.js";

export const growthRoutes = new Hono<AppContext>();
growthRoutes.use("*", requireUser);

const isPeriod = (v: string): v is GrowthPeriod => (GROWTH_PERIODS as readonly string[]).includes(v);

growthRoutes.get("/body", async (c) => {
  const asked = c.req.query("period") ?? "month";
  if (!isPeriod(asked)) return c.json({ error: "bad_period", periods: GROWTH_PERIODS }, 400);
  return c.json(await growthBody(c.get("db"), c.get("userId"), new Date(), asked));
});
