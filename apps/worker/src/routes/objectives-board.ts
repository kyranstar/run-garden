/**
 * `GET /api/objectives/board` — the objectives board's one read (Stage 3 Task 11; services/objectives-board.ts):
 * every objective with its key results measured, each one's best ever, the workouts that served it, its streak of weeks
 * and the coach's latest line, in OBJECTIVE_BOARD_STATEMENTS at most however many objectives there are.
 *
 * The board belongs to the coach stage: a plain 404 unless `COACH_DESIGNER = "1"` or this is staging, signed in or
 * not; then the session is checked. Mounted ahead of `/api/objectives` in index.ts, whose routes are unchanged.
 */
import { Hono } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import { objectiveBoard } from "../services/objectives-board.js";

export const objectiveBoardRoutes = new Hono<AppContext>();

objectiveBoardRoutes.use("*", async (c, next) => {
  if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  await next();
});
objectiveBoardRoutes.use("*", requireUser);

objectiveBoardRoutes.get("/", async (c) => c.json(await objectiveBoard(c.get("db"), c.get("userId"))));
