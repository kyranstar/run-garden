import { eq, lt } from "drizzle-orm";
import { oauthStates } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "../services/db.js";
import { b64urlEncode, randomToken, sha256Hex } from "./crypto.js";

/**
 * Google OAuth (PKCE + state). Single-user: only ALLOWED_GOOGLE_EMAIL may
 * complete sign-in; every other account is rejected outright.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_SCOPES_SIGNIN = "openid email profile";
/**
 * Minimum Calendar scopes: manage the dedicated calendar we create
 * (calendar.app.created), read the calendar list for "use existing calendar",
 * write events on a user-chosen existing calendar (calendar.events), and read
 * busy intervals (calendar.freebusy).
 */
export const GOOGLE_SCOPES_CALENDAR = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64urlEncode(new Uint8Array(digest)) };
}

export interface StartAuthOptions {
  scopes: string;
  redirectTo?: string;
  /** offline access (refresh token) — needed for Calendar, not for sign-in. */
  offline?: boolean;
}

export async function startGoogleAuth(
  db: Db,
  env: Env,
  opts: StartAuthOptions,
): Promise<string> {
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  await db.insert(oauthStates).values({
    state,
    provider: "google",
    codeVerifier: verifier,
    redirectTo: opts.redirectTo ?? null,
    createdAt: nowInstant(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
    response_type: "code",
    scope: opts.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (opts.offline) {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  return `${AUTH_URL}?${params}`;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
}

export async function consumeOauthState(
  db: Db,
  state: string,
): Promise<{ codeVerifier: string; redirectTo?: string } | null> {
  const rows = await db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
  const row = rows[0];
  if (!row) return null;
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (row.expiresAt < nowInstant()) return null;
  return {
    codeVerifier: row.codeVerifier ?? "",
    redirectTo: row.redirectTo ?? undefined,
  };
}

export async function exchangeGoogleCode(
  env: Env,
  code: string,
  codeVerifier: string,
): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
    }),
  });
  if (!res.ok) throw new Error(`google_token_exchange_failed_${res.status}`);
  return (await res.json()) as GoogleTokens;
}

export async function refreshGoogleToken(env: Env, refreshToken: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google_token_refresh_failed_${res.status}`);
  return (await res.json()) as GoogleTokens;
}

/** Decode the id_token payload (signature verified implicitly by TLS to Google's token endpoint). */
export function decodeIdToken(idToken: string): { email?: string; sub?: string; name?: string } {
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    return JSON.parse(json) as { email?: string; sub?: string; name?: string };
  } catch {
    return {};
  }
}

export async function purgeExpiredStates(db: Db): Promise<void> {
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, nowInstant()));
}

export function emailAllowed(env: Env, email: string | undefined): boolean {
  return !!email && email.toLowerCase() === env.ALLOWED_GOOGLE_EMAIL.toLowerCase();
}

// re-export used by routes
export { sha256Hex };
