import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import { makeDb, type Db } from "../services/db.js";
import { restoreInProgress } from "../services/account-state.js";
import { resolveSession, SESSION_COOKIE } from "./sessions.js";
import { deviceSigningMessage, sha256Hex, verifyEd25519 } from "./crypto.js";

export interface AppContext {
  Bindings: Env;
  Variables: {
    db: Db;
    userId: string;
    userEmail: string;
    /**
     * Test-only seam: when set, `/api/studio` routes pass this instead of the
     * global `fetch` into `generatePlan`/`editPlan`'s own optional trailing
     * `fetchImpl` parameter, so a route test can script an exact gateway
     * response (e.g. a major-edit reply with a mutated `brief`) without a
     * live network call. Never set by any production code path — omitted,
     * every real request falls back to the global `fetch`, identical to
     * before this existed.
     */
    llmFetch?: typeof fetch;
  };
}

export async function withDb(c: Context<AppContext>, next: Next): Promise<void | Response> {
  c.set("db", makeDb(c.env.DB));
  await next();
}

/**
 * Requests that still go through while a restore is replacing the account:
 * the restore itself, deleting everything, signing in/out, and the app-open
 * COROS pull (which answers "restoring" and writes nothing).
 */
const OPEN_WHILE_RESTORING = [
  /^\/api\/settings\/restore\//,
  /^\/api\/settings\/delete-all$/,
  /^\/api\/auth\//,
  /^\/api\/(coros|sync)\/read-now$/,
];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Browser-session authentication (cookie).
 *
 * Also the one place every route module passes through, so it is where a
 * restore in progress (ruling B2) freezes the account against every OTHER
 * write — a second tab or the phone moving a session, approving a proposal,
 * saving settings — with 423. GET requests still read. */
export async function requireUser(c: Context<AppContext>, next: Next): Promise<void | Response> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c.get("db"), token);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", session.userId);
  c.set("userEmail", session.email);
  if (
    MUTATING.has(c.req.method) &&
    !OPEN_WHILE_RESTORING.some((re) => re.test(c.req.path)) &&
    (await restoreInProgress(c.get("db"), session.userId))
  ) {
    return c.json({ error: "restore_in_progress" }, 423);
  }
  await next();
}


