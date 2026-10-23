/**
 * Settings -> Saves, the owner's side of the saved-posts import (`/api/my-saves/*`): what the import did (`GET /status`)
 * and the owner's word on one post (`POST /posts/:id/override`: process anyway, skip, or keep as a reference). The
 * session cookie, and 404 unless `SAVES_IMPORT` is on (so the app hides the section while the feature is off).
 */
import { Hono } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { savesImportEnabled } from "../env.js";
import { overridePost, savesStatus } from "../services/saves-ledger.js";

const overrideSchema = z.object({ action: z.enum(["process", "skip", "reference"]) }).strict();

export const mySavesRoutes = new Hono<AppContext>();

mySavesRoutes.use("*", async (c, next) => {
  if (!savesImportEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  await next();
});
mySavesRoutes.use("*", requireUser);

mySavesRoutes.get("/status", async (c) => c.json(await savesStatus(c.get("db"), c.get("userId"), nowInstant())));

mySavesRoutes.post("/posts/:id/override", async (c) => {
  const parsed = overrideSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const result = await overridePost(c.get("db"), c.get("userId"), { id: c.req.param("id") }, parsed.data.action, nowInstant());
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "conflict") return c.json({ error: "not_overridable" }, 409);
  return c.json({ ok: true });
});
