import type { MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { AppContext } from "./middleware.js";
import type { Env } from "../env.js";
import { sha256Hex } from "./crypto.js";
import { restoreInProgress } from "../services/account-state.js";

/** Equal-length hex strings, compared without an early exit. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A machine endpoint's door: `Authorization: Bearer <token>`, its SHA-256 compared in constant time with a Worker
 * secret (`secretOf` names which). Without the secret the endpoint doesn't exist (404 `not_found`); a missing or wrong
 * token is 401 `unauthenticated`. No cookie is read. The caller is the owner (`ALLOWED_GOOGLE_EMAIL`): `userId` is set
 * for the handler. While a restore is replacing the account it is 503 (the callers read 5xx as "try again later").
 */
export function bearerGuard(secretOf: (env: Env) => string | undefined): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const expected = secretOf(c.env)?.trim().toLowerCase();
    if (!expected) return c.json({ error: "not_found" }, 404);
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token || !sameHex(await sha256Hex(token), expected)) return c.json({ error: "unauthenticated" }, 401);
    const db = c.get("db");
    const owner = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${c.env.ALLOWED_GOOGLE_EMAIL.trim().toLowerCase()}`)
      .get();
    if (!owner) return c.json({ error: "not_found" }, 404);
    if (await restoreInProgress(db, owner.id)) return c.json({ error: "restore_in_progress" }, 503);
    c.set("userId", owner.id);
    await next();
  };
}
