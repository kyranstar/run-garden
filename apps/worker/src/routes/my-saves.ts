/**
 * The owner's side of the saved-posts import (`/api/my-saves/*`). The session cookie, and 404 unless `SAVES_IMPORT` is on
 * (so the app hides it all while the feature is off).
 *
 * Settings -> Saves:
 *   GET  /status                                   what the import did
 *   POST /posts/:id/override {action}              process anyway, skip, or keep as a reference
 *
 * The one path (the saves flow redesigned, 2026-10-26; services/saves-review.ts; spec §3.2, §4, §12.1, §12.3):
 *   GET  /open                                     the open batch the Today card, the coach's chip and its saves card
 *                                                  are about → `{open}` (OpenSavesDto: id, counts, groups, the card's
 *                                                  line, fitting), `{open: null}` when none; with none open and new
 *                                                  moves waiting it cuts the next batch first (never while held)
 *   POST /batches/:id/fit {choices?}               "Fit them in" / "Fit these in": the batch saved with the owner's
 *                                                  choices ({moveId: include | skip}; a new move left out is the coach's
 *                                                  call; no `choices` — the one-tap fit — keeps the stored ones) and its
 *                                                  fit started → FitAnswerDto `{batchId, request, moves,
 *                                                  links}`; 409 `fitting` while its fit is at work (the hour), 409
 *                                                  `batch_open` while another batch is open, 409 `already_fitted`, 409
 *                                                  `not_released` (held or superseded), 409 `empty` (every row removed)
 *   POST /batches/:id/dismiss                      "not now": put aside, never saved → `{ok}`; 409 `not_open` unless
 *                                                  it is open and not fitting
 *   POST /batches/:id/fit/cancel                   the fit's run could not start: the fit cleared at once → `{ok}`
 *
 * "From your saves", the review (services/saves-review.ts; the Studio's `/studio/saves/:batchId`):
 *   GET  /batches[?held=1]                         released and saved batches (held too with ?held=1), newest first,
 *                                                  each with its counts → `{batches}`
 *   GET  /batches/:id                              → `{batch, rows}`: each row New or Linked to …, Check this, the post
 *   POST /batches/:id/save                         "Save these" → `{moves, links}` (saveBatch: only the kept rows; the
 *                                                  move sheet's, beside the fit)
 *   PUT  /moves/:id  {name?, text?, dose?, conditions?}   edit a pending or active move → `{record}`;
 *                                                  422 `invalid_record` with the validator's issues
 *   POST /post-moves/:id/rematch {to}              "Same as…" (a library move or an active move of the account's) or
 *                                                  null, "Not this move" → `{ok, move}`
 *   POST /post-moves/:id/remove                    the row is left out of the save
 *   POST /batches {theme, postIds}                 the bootstrap: a themed held batch of those posts' rows (in no batch, or
 *                                                  in a held one) → 201; at most 100 posts
 *   POST /batches/:id/release                      a held batch released, with its notice → `{batch}`; 409
 *                                                  `batch_open` while another batch of the account's is open (one at a
 *                                                  time), 409 `nothing_to_release` when every row was removed
 *
 * 404 `not_found` for a batch, row or move that isn't this account's (and for a re-match target that is neither a
 * library move nor an active move of the account's); 409 for a row that is no longer pending, a release of a batch that
 * isn't held, a batch with nothing to gather; 422 `invalid` for a body outside its shape; 423 while a restore runs
 * (`requireUser`). D1 statements per call are pinned in test/my-saves-review.test.ts and test/my-saves-fit.test.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { createBatchSchema, fitSchema, personalMovePatchSchema, rematchSchema } from "@rg/saves";
import { savesImportEnabled } from "../env.js";
import { overridePost, savesStatus } from "../services/saves-ledger.js";
import { saveBatch } from "../services/saves-batches.js";
import {
  batchDetail, cancelFit, createHeldBatch, dismissBatch, editPersonalMove, fitBatch, listBatches, readOpenBatch, rematchLink,
  releaseBatch, removeLink,
} from "../services/saves-review.js";

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

const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> => c.req.json().catch(() => undefined);
const notFound = { error: "not_found" } as const;

mySavesRoutes.get("/open", async (c) => c.json(await readOpenBatch(c.get("db"), c.env, c.get("userId"), nowInstant())));

mySavesRoutes.post("/batches/:id/fit", async (c) => {
  const parsed = fitSchema.safeParse(await body(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const out = await fitBatch(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data.choices, nowInstant());
  if (out.kind === "not_found") return c.json(notFound, 404);
  if (out.kind === "conflict") return c.json({ error: out.error }, 409);
  return c.json(out.answer);
});

mySavesRoutes.post("/batches/:id/dismiss", async (c) => {
  const out = await dismissBatch(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant());
  if (out === "not_found") return c.json(notFound, 404);
  if (out === "conflict") return c.json({ error: "not_open" }, 409);
  return c.json({ ok: true });
});

mySavesRoutes.post("/batches/:id/fit/cancel", async (c) => {
  const out = await cancelFit(c.get("db"), c.get("userId"), c.req.param("id"));
  return out === "not_found" ? c.json(notFound, 404) : c.json({ ok: true });
});

mySavesRoutes.get("/batches", async (c) =>
  c.json(await listBatches(c.get("db"), c.get("userId"), { held: c.req.query("held") === "1" }, nowInstant())),
);

mySavesRoutes.post("/batches", async (c) => {
  const parsed = createBatchSchema.safeParse(await body(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const batch = await createHeldBatch(c.get("db"), c.get("userId"), parsed.data, nowInstant());
  if (!batch) return c.json({ error: "nothing_to_batch" }, 409);
  return c.json({ batch }, 201);
});

mySavesRoutes.get("/batches/:id", async (c) => {
  const detail = await batchDetail(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant());
  return detail ? c.json(detail) : c.json(notFound, 404);
});

mySavesRoutes.post("/batches/:id/save", async (c) => {
  const saved = await saveBatch(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant());
  return saved ? c.json(saved) : c.json(notFound, 404);
});

mySavesRoutes.post("/batches/:id/release", async (c) => {
  const out = await releaseBatch(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant());
  if (out === "not_found") return c.json(notFound, 404);
  if (out === "conflict") return c.json({ error: "not_held" }, 409);
  if (out === "batch_open") return c.json({ error: "batch_open" }, 409);
  if (out === "nothing_to_release") return c.json({ error: "nothing_to_release" }, 409);
  return c.json({ batch: out });
});

mySavesRoutes.put("/moves/:id", async (c) => {
  const parsed = personalMovePatchSchema.safeParse(await body(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const out = await editPersonalMove(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data, nowInstant());
  if (out.kind === "not_found") return c.json(notFound, 404);
  if (out.kind === "invalid") return c.json({ error: "invalid_record", issues: out.issues }, 422);
  return c.json({ record: out.record });
});

mySavesRoutes.post("/post-moves/:id/rematch", async (c) => {
  const parsed = rematchSchema.safeParse(await body(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 422);
  const out = await rematchLink(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data.to, nowInstant());
  if (out.kind === "not_found" || out.kind === "target_not_found") return c.json(notFound, 404);
  if (out.kind === "conflict") return c.json({ error: out.error }, 409);
  if (out.kind === "invalid") return c.json({ error: "invalid_record", issues: out.issues }, 422);
  return c.json({ ok: true, move: { id: out.moveId, kind: out.moveKind } });
});

mySavesRoutes.post("/post-moves/:id/remove", async (c) => {
  const out = await removeLink(c.get("db"), c.get("userId"), c.req.param("id"));
  if (out === "not_found") return c.json(notFound, 404);
  if (out === "conflict") return c.json({ error: "not_pending" }, 409);
  return c.json({ ok: true });
});
