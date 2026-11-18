/**
 * WHO THE LIFEOS QA ACCOUNT IS (the phone QA harness, kit v0.16; services/qa-account.ts): a leaf, so the sign-in code
 * (native-devices.ts, middleware.ts, token.ts) and the crons can name it without importing the account's services.
 *
 * `lifeos-qa@invalid`: `.invalid` is reserved (RFC 2606) — no mailbox, no Google account, never a verified address — so
 * Google sign-in, which needs Google's verified assertion of `ALLOWED_GOOGLE_EMAIL`, can never open it. Where the owner's
 * own address would be the QA address (`qaPossible` false), no account is the QA account.
 */
import type { Env } from "../env.js";

/** The QA account's email. Lower case, and stored exactly so. */
export const QA_EMAIL = "lifeos-qa@invalid";

const norm = (email: string | null | undefined): string => (email ?? "").trim().toLowerCase();

/** The QA account can exist here: an owner is configured, and the owner's address is not the QA address. */
export const qaPossible = (env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined): boolean => {
  const owner = norm(env?.ALLOWED_GOOGLE_EMAIL);
  return owner !== "" && owner !== QA_EMAIL;
};

/** This email is the QA account's (and the QA account can exist here). */
export const isQaEmail = (email: string | null | undefined, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined): boolean =>
  qaPossible(env) && norm(email) === QA_EMAIL;
