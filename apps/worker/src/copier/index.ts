/**
 * The staging copier Worker (Phase 0 Task 13) — a SEPARATE, TEMPORARY Worker
 * (`wrangler.copier.toml`, name `rg-staging-copier`) bound to production's D1
 * as SRC and staging's as DST. It is deployed for one rehearsal, with the
 * owner's OK, and deleted straight after (docs/STAGING.md).
 *
 * Three routes, all POST, all requiring the `x-copier-key` header to equal
 * the COPIER_KEY secret and `?dst=run-garden-db-staging` to confirm where the
 * writes go (it must also match the DST_NAME var):
 *
 *   POST /step    copy the next page(s); progress lives in DST, so just call
 *                 again until `finished`. `maxRows` (default 200, ≤ 500) sizes
 *                 a step; `restart=1` empties DST's copied tables first.
 *   POST /verify  per-table sha-256 + row counts on both sides
 *                 (`tables=a,b` for a subset).
 *   POST /scrub   null every credential column, delete sessions and OAuth
 *                 handshakes in DST; answers what remains (all zero).
 *
 * No answer carries a row: progress, counts and hashes only. A failure
 * answers with the error's kind, never its text.
 */
import { Hono } from "hono";
import { makeDb, type Db } from "../services/db.js";
import {
  clearCopy,
  COPY_TABLES,
  copyFinished,
  copyStep,
  guardBindings,
  initialCopyState,
  isCopyTable,
  loadCopyState,
  saveCopyState,
  scrubSecrets,
  secretsRemaining,
  STAGING_DB_NAME,
  verifyCopy,
  type CopyState,
} from "./copy.js";

export interface CopierEnv {
  /** Production's D1 — only ever read. */
  SRC: D1Database;
  /** Staging's D1 — the only database written. */
  DST: D1Database;
  /** Secret, set per rehearsal through stdin. */
  COPIER_KEY?: string;
  /** Var: the DST database's name, which `?dst=` must repeat. */
  DST_NAME?: string;
}

type CopierContext = { Bindings: CopierEnv };

export const DEFAULT_MAX_ROWS = 200;
/** Keeps one step well inside D1's 1,000 queries per invocation even at one
 * row per insert statement. */
export const MAX_ROWS_CAP = 500;
/** A key shorter than this is treated as unset. */
const MIN_KEY_LENGTH = 16;

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Constant-time: both sides are hashed to 32 bytes first, so neither the
 * length nor the first differing byte shows in the timing. */
async function keyMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function maxRowsOf(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_MAX_ROWS;
  return Math.min(MAX_ROWS_CAP, Math.max(1, Math.floor(n)));
}

function progress(state: CopyState, before: number) {
  return {
    finished: copyFinished(state),
    table: state.table,
    tablesDone: state.done.length,
    tables: COPY_TABLES.length,
    rowsThisStep: state.rows - before,
    rowsTotal: state.rows,
  };
}

export function copierApp(open: (env: CopierEnv) => { src: Db; dst: Db }): Hono<CopierContext> {
  const app = new Hono<CopierContext>();

  app.use("*", async (c, next) => {
    const expected = c.env.COPIER_KEY ?? "";
    const given = c.req.header("x-copier-key") ?? "";
    if (expected.length < MIN_KEY_LENGTH || !(await keyMatches(given, expected))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (c.env.DST_NAME !== STAGING_DB_NAME || c.req.query("dst") !== STAGING_DB_NAME) {
      return c.json({ error: "dst_not_confirmed" }, 400);
    }
    await next();
  });

  app.post("/step", async (c) => {
    const { src, dst } = open(c.env);
    const refusal = await guardBindings(src, dst, { prepare: true });
    if (refusal) return c.json({ error: refusal }, 409);
    if (c.req.query("restart") === "1") await clearCopy(dst);
    const state = (await loadCopyState(dst)) ?? initialCopyState();
    if (copyFinished(state)) return c.json(progress(state, state.rows));
    const next = await copyStep(src, dst, state, { maxRows: maxRowsOf(c.req.query("maxRows")) });
    await saveCopyState(dst, next);
    return c.json(progress(next, state.rows));
  });

  app.post("/verify", async (c) => {
    const { src, dst } = open(c.env);
    const refusal = await guardBindings(src, dst, { prepare: false });
    if (refusal) return c.json({ error: refusal }, 409);
    const raw = c.req.query("tables");
    const tables = raw ? raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : undefined;
    if (tables) {
      const bad = tables.findIndex((t) => !isCopyTable(t));
      if (bad >= 0) return c.json({ error: "unknown_table", index: bad }, 400);
    }
    const checks = await verifyCopy(src, dst, { tables });
    const state = await loadCopyState(dst);
    return c.json({
      ok: checks.every((t) => t.ok),
      copyFinished: state ? copyFinished(state) : false,
      tables: checks,
    });
  });

  app.post("/scrub", async (c) => {
    const { src, dst } = open(c.env);
    const refusal = await guardBindings(src, dst, { prepare: false });
    if (refusal) return c.json({ error: refusal }, 409);
    await scrubSecrets(dst);
    const remaining = await secretsRemaining(dst);
    return c.json({
      ok: remaining.secrets === 0 && remaining.sessions === 0 && remaining.oauthStates === 0,
      remaining,
    });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // The kind only: an error's text can quote what it failed on.
  app.onError((e, c) => {
    console.error(`copier failed: ${e.name}`);
    return c.json({ error: "copier_failed", kind: e.name }, 500);
  });

  return app;
}

const app = copierApp((env) => ({ src: makeDb(env.SRC), dst: makeDb(env.DST) }));

export default {
  fetch(req: Request, env: CopierEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(req, env, ctx);
  },
};
