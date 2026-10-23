/**
 * The saved-posts import's machine door: the browser extension tells the Worker which saved posts it found and asks which
 * to fetch media for. Behind `SAVES_IMPORT` (404 otherwise) and a bearer token whose SHA-256 is the Worker secret
 * `SAVES_TOKEN_SHA256` (auth/token.ts). Never reads the session cookie, so index.ts exempts `/api/saves/` from the
 * origin guard (the extension's Origin is chrome-extension://...). Site-neutral: the source name arrives as data.
 */
import { Hono } from "hono";
import { z } from "zod";
import { checkReportSchema, postSubmitSchema, SAVE_SOURCE_RE } from "@rg/saves";
import { nowInstant } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { bearerGuard } from "../auth/token.js";
import { savesImportEnabled } from "../env.js";
import { freshKeys, KNOWN_MAX_KEYS, recordCheck, savedPostId, savesStatus, upsertPost, workList } from "../services/saves-ledger.js";
import { filterPost } from "../services/saves-filter.js";
import { markTooLarge, readRelayRequest, relayExtract } from "../services/saves-relay.js";

const knownSchema = z
  .object({ source: z.string().regex(SAVE_SOURCE_RE), keys: z.array(z.string().min(1).max(64)).max(KNOWN_MAX_KEYS) })
  .strict();

export const savesRoutes = new Hono<AppContext>();

savesRoutes.use("*", async (c, next) => {
  if (!savesImportEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  await next();
});
savesRoutes.use("*", bearerGuard((env) => env.SAVES_TOKEN_SHA256));

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schemaOf: T) {
  const raw = await c.req.json().catch(() => undefined);
  return schemaOf.safeParse(raw);
}

savesRoutes.post("/checks", async (c) => {
  const parsed = await body(c, checkReportSchema);
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  // Task 8 adds the batch assembly here, on `finish`.
  await recordCheck(c.get("db"), c.get("userId"), parsed.data, nowInstant());
  return c.json({ ok: true });
});

savesRoutes.post("/known", async (c) => {
  const parsed = await body(c, knownSchema);
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const fresh = await freshKeys(c.get("db"), c.get("userId"), parsed.data.source, parsed.data.keys);
  return c.json({ fresh });
});

savesRoutes.post("/posts", async (c) => {
  const parsed = await body(c, postSubmitSchema);
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const db = c.get("db");
  const now = nowInstant();
  const row = await upsertPost(db, c.get("userId"), parsed.data, now);
  // Only a post the ledger just made (`seen`) is filtered; a known one answers as it stands.
  if (row.status !== "seen") {
    return c.json({
      status: row.status,
      ...(row.filterVerdict ? { verdict: row.filterVerdict } : {}),
      ...(row.filterReason ? { reason: row.filterReason } : {}),
    });
  }
  const out = await filterPost(db, c.env, c.get("userId"), { ...row, cover: parsed.data.cover }, now, fetch);
  return c.json({
    status: out.status,
    ...(out.verdict ? { verdict: out.verdict } : {}),
    ...(out.reason ? { reason: out.reason } : {}),
    ...(out.errorCode ? { errorCode: out.errorCode } : {}),
  });
});

savesRoutes.get("/work", async (c) => c.json({ keys: await workList(c.get("db"), c.get("userId"), nowInstant()) }));

savesRoutes.get("/status", async (c) => c.json(await savesStatus(c.get("db"), c.get("userId"), nowInstant())));

/**
 * The extraction relay: the body is the gateway JSON the extension built, and this route NEVER reads it (no `c.req.json()`,
 * no `.text()`): the stream goes straight to the gateway (saves-relay.ts). Checks that need only headers come first.
 */
savesRoutes.post("/posts/:key/extract", async (c) => {
  const source = c.req.query("source") ?? "";
  if (!SAVE_SOURCE_RE.test(source)) return c.json({ error: "invalid", issues: ["source"] }, 400);
  const asked = readRelayRequest(c.req.raw, c.env);
  const userId = c.get("userId");
  if (!asked.ok) {
    // The Worker's own 413: the post is marked so `/work` stops handing it out (it would be re-downloaded every check).
    if (asked.status === 413) {
      const id = await savedPostId(userId, source, c.req.param("key"));
      await markTooLarge(c.get("db"), userId, id, nowInstant());
    }
    return c.json({ error: asked.error }, asked.status);
  }
  const out = await relayExtract(
    c.get("db"),
    c.env,
    userId,
    { id: await savedPostId(userId, source, c.req.param("key")) },
    c.req.raw,
    new Date(nowInstant()),
    fetch,
  );
  if (out.ok) return c.json({ status: "extracted", moves: out.extraction.moves.length, kind: out.extraction.kind });
  if (out.status === 404) return c.json({ error: "not_found" }, 404);
  if (out.status === 409) return c.json({ error: "conflict" }, 409);
  const http = out.code === "too_large" ? 413 : out.code === "budget_paused" ? 429 : 502;
  return c.json({ error: out.code, ...(out.issues ? { issues: out.issues } : {}) }, http);
});
