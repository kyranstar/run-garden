import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  connectCoros,
  corosConnectionStatus,
  disconnectCoros,
} from "../services/coros-connection.js";

/**
 * Cloud COROS connection surface (cloud-direct spec §1). The password's MD5
 * arrives pre-hashed from the browser; a live login verifies before anything
 * is stored. COROS rejections are 200s with a status the settings card can
 * speak — they're expected states, not server errors.
 */

export const corosRoutes = new Hono<AppContext>();
corosRoutes.use("*", requireUser);

const connectSchema = z.object({
  email: z.string().email().max(200),
  pwdMd5: z.string().regex(/^[0-9a-f]{32}$/),
  region: z.enum(["us", "eu", "cn"]).default("us"),
});

corosRoutes.post("/connect", async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const result = await connectCoros(c.get("db"), c.env, c.get("userId"), parsed.data);
  return c.json(result);
});

corosRoutes.delete("/connect", async (c) => {
  await disconnectCoros(c.get("db"), c.get("userId"));
  return c.json({ ok: true });
});

corosRoutes.get("/status", async (c) => {
  return c.json(await corosConnectionStatus(c.get("db"), c.get("userId")));
});
