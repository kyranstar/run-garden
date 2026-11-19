/**
 * WHO THE LIFEOS QA ACCOUNT IS (the phone QA harness, kit v0.16; services/qa-account.ts): a leaf, so the sign-in code
 * (native-devices.ts, middleware.ts, token.ts) and the crons can name it without importing the account's services.
 *
 * `lifeos-qa@invalid`: `.invalid` is reserved (RFC 2606) — no mailbox, no Google account, never a verified address — so
 * Google sign-in, which needs Google's verified assertion of `ALLOWED_GOOGLE_EMAIL`, can never open it. Where the owner's
 * own address would be the QA address (`qaPossible` false), no account is the QA account.
 */
import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { users } from "@rg/database";
import type { Env } from "../env.js";

/**
 * The QA account's email. Lower case, and stored exactly so (`createQaUser` writes this constant, and nothing else writes
 * it). ONE PREDICATE, EXACT, EVERYWHERE (the review's N-1): `isQaAddress` in code and `users.email = QA_EMAIL` in SQL
 * (`notQaAccount`, the purge, the reads). A variant row — another case, spaces — is no account's QA account: it neither signs
 * in with the switches off nor escapes the crons.
 */
export const QA_EMAIL = "lifeos-qa@invalid";

/** This stored address is the QA account's: exactly `QA_EMAIL`, as SQL's `users.email = QA_EMAIL` matches it. */
export const isQaAddress = (email: string | null | undefined): boolean => email === QA_EMAIL;

/**
 * A WHERE condition: the account in `userId` is not the QA account — one subquery in the statement it guards, so no read
 * is added. The provider boundary's (a connection read for a client or a write's presence) and the crons' (an account or a
 * programme picked for work). Unconditional: an account at the QA address is never anyone's real account (no sign-in can
 * reach it), so it never has a provider, whatever the configuration.
 */
export const notQaAccount = (userId: SQLiteColumn | SQL): SQL =>
  sql`${userId} not in (select ${users.id} from ${users} where ${users.email} = ${QA_EMAIL})`;

/**
 * The Worker's switches as the QA account's phone requests see them (auth/middleware.ts `requireDevice`): every switch that
 * reaches a provider or a model off — the watch, the coach designer and its alarm, plan drafts, the thread coach, AI, COROS
 * MCP, music and saves. The plan's own rules are unchanged (a move is a move); only what leaves run-garden is gone.
 */
export function qaEnv<E extends Env>(env: E): E {
  return {
    ...env,
    WATCH_PUSH_ENABLED: undefined,
    COACH_DESIGNER: undefined,
    COACH_STEP_ALARM: undefined,
    COACH_RUN_STEPPER: undefined,
    PLAN_DRAFTS: undefined,
    THREAD_COACH: undefined,
    AI_GATEWAY_API_KEY: undefined,
    // Harmless with no key, and gone too (the review's question 4): no model URL of any kind.
    FIXTURE_MODEL_URL: undefined,
    COROS_MCP_URL: undefined,
    COROS_MCP_TOKEN: undefined,
    SPOTIFY_CLIENT_ID: undefined,
    SAVES_IMPORT: undefined,
    IMPORT_ENABLED: undefined,
  };
}

const norm = (email: string | null | undefined): string => (email ?? "").trim().toLowerCase();

/** The QA account can exist here: an owner is configured, and the owner's address is not the QA address. */
export const qaPossible = (env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined): boolean => {
  const owner = norm(env?.ALLOWED_GOOGLE_EMAIL);
  return owner !== "" && owner !== QA_EMAIL;
};

/** This email is the QA account's (and the QA account can exist here). */
export const isQaEmail = (email: string | null | undefined, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined): boolean =>
  qaPossible(env) && isQaAddress(email);
