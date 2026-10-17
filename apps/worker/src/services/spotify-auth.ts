/**
 * The music dock's Spotify connection (2026-10-17): Authorization Code with PKCE, run by the Worker.
 *
 * Why the Worker and not the page: on iOS a standalone web app may open the login in Safari, whose storage is not the
 * app's, and locally the callback lands on 127.0.0.1 while the app runs on localhost (Spotify allows http only on a
 * loopback IP). Neither callback can see a cookie the app set. So nothing the callback needs is kept in the browser:
 *
 *  - the `state` is signed (SESSION_SECRET, HMAC-SHA-256, as the restore's checks are) and names the athlete, a random
 *    nonce and an expiry ten minutes out — the callback is bound to the athlete who started it by the state alone;
 *  - the PKCE verifier is derived from the nonce with the same secret (HMAC), so it never leaves the server and needs
 *    no storage: the authorize URL carries only its S256 challenge.
 *
 * Tokens are kept encrypted (TOKEN_ENCRYPTION_KEY, AES-GCM, as the Google and COROS connections are) in
 * `provider_connections` with provider "spotify" — no migration, the table is generic. The client gets a short-lived
 * access token from `/api/music/spotify/token`, refreshed here when near expiry (`grant_type=refresh_token` with the
 * client id; PKCE needs no secret); a rotated refresh token is kept; `invalid_grant` marks the row and answers
 * "reconnect". No token is ever logged.
 */
import { and, eq } from "drizzle-orm";
import { providerConnections } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { b64urlDecode, b64urlEncode, decryptSecret, encryptSecret, randomToken } from "../auth/crypto.js";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_PROVIDER = "spotify";
/** Read the player and the devices, control playback, read the athlete's playlists, build the private Minecraft one. */
export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-modify-private",
];
/** How long a login may take, from the app to Spotify and back. */
export const SPOTIFY_STATE_TTL_MS = 10 * 60_000;
/** An access token with less than this left is refreshed before it is handed out (Spotify's last an hour). */
export const SPOTIFY_REFRESH_MARGIN_MS = 5 * 60_000;
export const SPOTIFY_CALLBACK_PATH = "/api/music/spotify/callback";
/** The local Worker, as Spotify allows it: the loopback IP over http (`localhost` is refused). */
export const SPOTIFY_LOCAL_ORIGIN = "http://127.0.0.1:8787";

/** The owner's Client ID, or null while the feature is dark (empty, unset or blank). */
export function spotifyClientId(env: Env): string | null {
  const id = env.SPOTIFY_CLIENT_ID?.trim();
  return id ? id : null;
}

/** Production's redirect URI is built from APP_URL; anything not https is local, and local is the loopback IP. */
export function spotifyRedirectUri(env: Env): string {
  const origin = env.APP_URL.startsWith("https://") ? env.APP_URL.replace(/\/+$/, "") : SPOTIFY_LOCAL_ORIGIN;
  return `${origin}${SPOTIFY_CALLBACK_PATH}`;
}

// ── The state and the verifier ───────────────────────────────────────────────

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface StateClaims {
  v: 1;
  k: "spotify";
  /** The athlete who started the login. */
  u: string;
  /** The nonce the verifier is derived from. */
  n: string;
  /** Expiry, epoch ms. */
  exp: number;
}

/** The PKCE verifier for a nonce: 43 base64url characters, derivable only with the secret. */
export async function pkceVerifier(secret: string, nonce: string): Promise<string> {
  return hmac(secret, `spotify-pkce.${nonce}`);
}

/** S256: base64url(SHA-256(verifier)), unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

export async function signSpotifyState(secret: string, userId: string, now: number): Promise<{ state: string; nonce: string }> {
  const nonce = randomToken(18);
  const claims: StateClaims = { v: 1, k: "spotify", u: userId, n: nonce, exp: now + SPOTIFY_STATE_TTL_MS };
  const body = b64urlEncode(enc.encode(JSON.stringify(claims)));
  return { state: `${body}.${await hmac(secret, body)}`, nonce };
}

/** The athlete and nonce a state names — or null when it is missing, malformed, not ours, or out of date. */
export async function verifySpotifyState(secret: string, state: string | undefined, now: number): Promise<{ userId: string; nonce: string } | null> {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts as [string, string];
  if (!timingSafeEqual(sig, await hmac(secret, body))) return null;
  let claims: Partial<StateClaims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Partial<StateClaims>;
  } catch {
    return null;
  }
  if (claims.v !== 1 || claims.k !== "spotify" || typeof claims.u !== "string" || typeof claims.n !== "string") return null;
  if (typeof claims.exp !== "number" || !(now <= claims.exp)) return null;
  return { userId: claims.u, nonce: claims.n };
}

/** Spotify's authorize URL for this athlete: the client id, the scopes, a signed state and the S256 challenge. */
export async function spotifyAuthorizeUrl(env: Env, clientId: string, userId: string, now: number): Promise<string> {
  const { state, nonce } = await signSpotifyState(env.SESSION_SECRET, userId, now);
  const challenge = await pkceChallenge(await pkceVerifier(env.SESSION_SECRET, nonce));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: spotifyRedirectUri(env),
    scope: SPOTIFY_SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params}`;
}

// ── The token endpoint ───────────────────────────────────────────────────────

interface TokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

export interface SpotifyTokens {
  accessToken: string;
  /** Present on the code exchange; on a refresh only when Spotify rotated it. */
  refreshToken: string | null;
  expiresInSec: number;
  scope: string | null;
}

type TokenAnswer = { ok: true; tokens: SpotifyTokens } | { ok: false; invalidGrant: boolean; status: number };

async function postToken(fetchImpl: typeof fetch, form: Record<string, string>): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    return { ok: false, invalidGrant: false, status: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as TokenBody;
  if (!res.ok) return { ok: false, invalidGrant: body.error === "invalid_grant", status: res.status };
  if (typeof body.access_token !== "string" || !body.access_token) return { ok: false, invalidGrant: false, status: res.status };
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      expiresInSec: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600,
      scope: typeof body.scope === "string" ? body.scope : null,
    },
  };
}

/** The code exchange: the code, the redirect URI it was issued for, the client id and the verifier. No secret. */
export async function exchangeSpotifyCode(fetchImpl: typeof fetch, env: Env, clientId: string, code: string, verifier: string): Promise<SpotifyTokens | null> {
  const answer = await postToken(fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: spotifyRedirectUri(env),
    client_id: clientId,
    code_verifier: verifier,
  });
  // A connection without a refresh token would be "reconnect" within the hour: refuse it now.
  return answer.ok && answer.tokens.refreshToken ? answer.tokens : null;
}

// ── The row ──────────────────────────────────────────────────────────────────

type SpotifyRow = typeof providerConnections.$inferSelect;

export async function loadSpotifyRow(db: Db, userId: string): Promise<SpotifyRow | undefined> {
  return (
    await db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, SPOTIFY_PROVIDER)))
      .limit(1)
  )[0];
}

/** The connection as the dock reads it: connected, needs a new consent, or none. */
export function spotifyConnectionOf(row: Pick<SpotifyRow, "status" | "encryptedRefreshToken"> | undefined): "connected" | "reconnect" | "not_connected" {
  if (!row) return "not_connected";
  return row.status === "connected" && row.encryptedRefreshToken ? "connected" : "reconnect";
}

/** Keep a fresh connection's tokens, encrypted: one upsert on (user, provider). */
export async function storeSpotifyTokens(db: Db, env: Env, userId: string, tokens: SpotifyTokens, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  const values = {
    status: "connected",
    encryptedAccessToken: await encryptSecret(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: await encryptSecret(tokens.refreshToken ?? "", env.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: new Date(now + tokens.expiresInSec * 1000).toISOString(),
    scope: tokens.scope,
    updatedAt: at,
    lastErrorCategory: null,
  };
  await db
    .insert(providerConnections)
    .values({ id: newId(), userId, provider: SPOTIFY_PROVIDER, createdAt: at, ...values })
    .onConflictDoUpdate({ target: [providerConnections.userId, providerConnections.provider], set: values });
}

export type SpotifyTokenAnswer =
  | { connected: true; accessToken: string; expiresAt: string }
  | { connected: false; reason: "not_connected" | "reconnect" }
  | { unavailable: true };

async function fresh(row: SpotifyRow, env: Env, now: number): Promise<SpotifyTokenAnswer | null> {
  const expiresAt = Date.parse(row.accessTokenExpiresAt ?? "");
  if (!row.encryptedAccessToken || !(expiresAt - now > SPOTIFY_REFRESH_MARGIN_MS)) return null;
  return { connected: true, accessToken: await decryptSecret(row.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY), expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * An access token for the client: the stored one while it has more than the margin left; else a refresh, keeping a
 * rotated refresh token. Each write is guarded by the refresh token it read, so a slower request never puts back a
 * token another request already rotated away; and an `invalid_grant` that crossed such a rotation answers the other
 * request's token instead of "reconnect".
 */
export async function spotifyAccessToken(
  db: Db,
  env: Env,
  clientId: string,
  userId: string,
  fetchImpl: typeof fetch,
  now: number,
  /** Refresh whatever the time left: the page saw Spotify refuse the stored token (a 401). */
  force = false,
): Promise<SpotifyTokenAnswer> {
  const row = await loadSpotifyRow(db, userId);
  const state = spotifyConnectionOf(row);
  if (state !== "connected" || !row) return { connected: false, reason: state === "connected" ? "not_connected" : state };
  const stored = force ? null : await fresh(row, env, now);
  if (stored) return stored;

  const answer = await postToken(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: await decryptSecret(row.encryptedRefreshToken!, env.TOKEN_ENCRYPTION_KEY),
    client_id: clientId,
  });
  const sameToken = and(eq(providerConnections.id, row.id), eq(providerConnections.encryptedRefreshToken, row.encryptedRefreshToken!));
  if (!answer.ok) {
    if (!answer.invalidGrant) {
      console.warn("spotify refresh failed", answer.status);
      return { unavailable: true };
    }
    const again = await loadSpotifyRow(db, userId);
    if (again && again.encryptedRefreshToken !== row.encryptedRefreshToken && spotifyConnectionOf(again) === "connected") {
      const theirs = await fresh(again, env, now);
      if (theirs) return theirs;
    }
    await db
      .update(providerConnections)
      .set({ status: "error", lastErrorCategory: "reconnect", updatedAt: new Date(now).toISOString() })
      .where(sameToken);
    return { connected: false, reason: "reconnect" };
  }
  const expiresAt = new Date(now + answer.tokens.expiresInSec * 1000).toISOString();
  await db
    .update(providerConnections)
    .set({
      encryptedAccessToken: await encryptSecret(answer.tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
      ...(answer.tokens.refreshToken ? { encryptedRefreshToken: await encryptSecret(answer.tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY) } : {}),
      accessTokenExpiresAt: expiresAt,
      ...(answer.tokens.scope !== null ? { scope: answer.tokens.scope } : {}),
      updatedAt: new Date(now).toISOString(),
    })
    .where(sameToken);
  return { connected: true, accessToken: answer.tokens.accessToken, expiresAt };
}

export async function disconnectSpotify(db: Db, userId: string): Promise<void> {
  await db
    .delete(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, SPOTIFY_PROVIDER)));
}
