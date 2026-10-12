/**
 * `/api/templates` — the athlete's saved workout templates (Stage 2 spec §9–§10; services/workout-templates.ts).
 *
 *   GET    /           {templates}: pinned first, then the most recently used, then by name
 *   POST   /           {name, doc, pinned?} → 201 {template, warnings}
 *   PUT    /:id        {name?, doc?, pinned?} → {template, warnings}
 *   DELETE /:id        → {ok}
 *   POST   /:id/use    → {template, doc}: its uses bumped; the document stamped `basedOn: template`
 *
 * 422 `invalid_template` (the body), `invalid_doc` with every issue (an error in the document, checked with no day);
 * 409 `too_many`; 409 `stale_revision` with the template's `updatedAt` for a PUT whose `baseUpdatedAt` (the version the
 * write was built on) is no longer the template's — as a workout's stale `baseRev` is; 404 for a template that is not this account's; 423 while a restore is replacing the account
 * (`requireUser`). User-scoped throughout.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { nowInstant } from "@rg/domain";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { DocInvalidError } from "../services/doc-workouts.js";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  StaleTemplateError,
  TemplateNotFoundError,
  TooManyTemplatesError,
  updateTemplate,
  useTemplate,
} from "../services/workout-templates.js";

export const templateRoutes = new Hono<AppContext>();
templateRoutes.use("*", requireUser);

const name = z.string().trim().min(1).max(80);
const doc = z.record(z.string(), z.unknown());
const createSchema = z.object({ name, doc, pinned: z.boolean().optional() }).strict();
const updateSchema = z
  .object({ name: name.optional(), doc: doc.optional(), pinned: z.boolean().optional(), baseUpdatedAt: z.string().min(1).max(40).optional() })
  .strict();

function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof DocInvalidError) return c.json({ error: "invalid_doc", issues: e.issues }, 422);
  if (e instanceof TemplateNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof TooManyTemplatesError) return c.json({ error: "too_many" }, 409);
  if (e instanceof StaleTemplateError) return c.json({ error: "stale_revision", updatedAt: e.updatedAt }, 409);
  throw e;
}

templateRoutes.get("/", async (c) => c.json({ templates: await listTemplates(c.get("db"), c.get("userId")) }));

templateRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_template", issues: parsed.error.issues }, 422);
  try {
    return c.json(await createTemplate(c.get("db"), c.get("userId"), parsed.data, nowInstant()), 201);
  } catch (e) {
    return refusal(c, e);
  }
});

templateRoutes.put("/:id", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_template", issues: parsed.error.issues }, 422);
  try {
    return c.json(await updateTemplate(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data, nowInstant()));
  } catch (e) {
    return refusal(c, e);
  }
});

templateRoutes.delete("/:id", async (c) => {
  try {
    await deleteTemplate(c.get("db"), c.get("userId"), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return refusal(c, e);
  }
});

templateRoutes.post("/:id/use", async (c) => {
  try {
    return c.json(await useTemplate(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant()));
  } catch (e) {
    return refusal(c, e);
  }
});
