/**
 * THE LIFEOS QA RUN'S TOKENS (the phone QA harness, kit v0.16; services/qa-account.ts): stateless, HMAC-SHA-256 under
 * `SESSION_SECRET`, each labelled with what it is and bound to the QA account's id — so a purge and a new QA account retire
 * them, and neither can ever name another account. A leaf beside qa-identity.ts, so the plan door (token.ts) can read them
 * without the account's services.
 *
 *  - THE PLAN TOKEN: 64 hex, the shape LifeOS's plan connection already takes. `/api/lifeos/plan`'s door accepts it beside
 *    the owner's own token and reads the QA account's plan with it — read only, the QA account's only, while it exists.
 *  - THE HARNESS TOKEN: `rgq_<qaId>_<exp>_<mac>`, at most `HARNESS_TOKEN_MAX_MS`: `/api/qa/run/*` (routes/qa.ts) — the QA
 *    account's state, a fresh code, its purge and the zero-row check — for `scripts/phone-qa.sh`.
 */
import { eq } from "drizzle-orm";
import { users } from "@rg/database";
import type { Env } from "../env.js";
import type { Db } from "../services/db.js";
import { hmacSha256Hex } from "./crypto.js";
import { QA_EMAIL, qaPossible } from "./qa-identity.js";

/** Equal-length hex strings, compared without an early exit (as token.ts `sameHex`). */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The longest a harness token lives (a run is minutes; a build and an install, a few more). */
export const HARNESS_TOKEN_MAX_MS = 6 * 3_600_000;
const PLAN_LABEL = "run-garden lifeos qa plan token v1";
const HARNESS_LABEL = "run-garden lifeos qa harness token v1";
const HARNESS_TOKEN = /^rgq_([0-9a-f-]{36})_(\d{10})_([0-9a-f]{64})$/;

/** The QA account's id, or null when there is none. One read. */
export async function qaUserIdOf(db: Db): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, QA_EMAIL)).limit(1);
  return row?.id ?? null;
}

/** The QA account's plan token: 64 hex; read only, its plan only. */
export const qaPlanToken = (env: Pick<Env, "SESSION_SECRET">, qaUserId: string): Promise<string> =>
  hmacSha256Hex(env.SESSION_SECRET, `${PLAN_LABEL}\n${qaUserId}`);

/** The harness token for `qaUserId`, good until `expiresAtMs` (whole seconds). */
export async function qaHarnessToken(env: Pick<Env, "SESSION_SECRET">, qaUserId: string, expiresAtMs: number): Promise<string> {
  const exp = Math.floor(expiresAtMs / 1000);
  return `rgq_${qaUserId}_${exp}_${await hmacSha256Hex(env.SESSION_SECRET, `${HARNESS_LABEL}\n${qaUserId}\n${exp}`)}`;
}

/** A well-formed, live, genuine harness token's account id, or null. Says nothing about whether that account still exists. */
export async function verifyHarnessToken(
  env: Pick<Env, "SESSION_SECRET" | "ALLOWED_GOOGLE_EMAIL">,
  token: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  if (!qaPossible(env)) return null;
  const m = HARNESS_TOKEN.exec(token);
  if (!m) return null;
  const [, userId, expText, mac] = m as unknown as [string, string, string, string];
  const exp = Number(expText) * 1000;
  if (!(exp > nowMs) || exp > nowMs + HARNESS_TOKEN_MAX_MS + 60_000) return null;
  const expected = await hmacSha256Hex(env.SESSION_SECRET, `${HARNESS_LABEL}\n${userId}\n${expText}`);
  return sameHex(mac, expected) ? userId : null;
}

/** The account a plan token reads: the QA account's id when `token` is its plan token, else null. Reads only when it could be. */
export async function qaPlanTokenAccount(db: Db, env: Pick<Env, "SESSION_SECRET" | "ALLOWED_GOOGLE_EMAIL">, token: string): Promise<string | null> {
  if (!qaPossible(env) || !/^[0-9a-f]{64}$/.test(token)) return null;
  const qaId = await qaUserIdOf(db);
  if (!qaId) return null;
  return sameHex(token, await qaPlanToken(env, qaId)) ? qaId : null;
}
