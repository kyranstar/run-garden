import { and, eq } from "drizzle-orm";
import { providerConnections } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { RawStravaActivity } from "@rg/providers";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { Env } from "../env.js";
import type { Db } from "./db.js";

/**
 * Strava READ-ONLY client. This app never uploads, creates, edits, or deletes
 * Strava activities — there are intentionally no write methods here.
 *
 * Base URL is configurable for Strava's announced 2027-06-01 migration to
 * www.api-v3.strava.com; auth always uses the Bearer header (never query params).
 */

function apiBase(env: Env): string {
  return env.STRAVA_API_BASE ?? "https://www.strava.com/api/v3";
}

export async function stravaAuthorizeUrl(env: Env, state: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID ?? "",
    redirect_uri: `${env.APP_URL}/api/strava/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:read_all",
    state,
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  athlete?: { id: number };
}

export async function exchangeStravaCode(env: Env, code: string): Promise<StravaTokens> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID ?? "",
      client_secret: env.STRAVA_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`strava_token_exchange_failed_${res.status}`);
  return (await res.json()) as StravaTokens;
}

export interface StravaClient {
  listActivities(afterEpoch: number, perPage?: number): Promise<RawStravaActivity[]>;
  getActivity(id: string): Promise<RawStravaActivity | null>;
  getLaps(id: string): Promise<Array<Record<string, unknown>>>;
}

export async function stravaClient(db: Db, env: Env, userId: string): Promise<StravaClient | null> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "strava")))
    .limit(1);
  const conn = rows[0];
  if (!conn || conn.status === "disconnected" || !conn.encryptedRefreshToken) return null;

  let accessToken: string | null =
    conn.encryptedAccessToken && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt > nowInstant()
      ? await decryptSecret(conn.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY)
      : null;

  const ensureToken = async (): Promise<string> => {
    if (accessToken) return accessToken;
    const refresh = await decryptSecret(conn.encryptedRefreshToken!, env.TOKEN_ENCRYPTION_KEY);
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID ?? "",
        client_secret: env.STRAVA_CLIENT_SECRET ?? "",
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      await db
        .update(providerConnections)
        .set({ status: "error", lastErrorCategory: `token_refresh_${res.status}`, updatedAt: nowInstant() })
        .where(eq(providerConnections.id, conn.id));
      throw new Error(`strava_token_refresh_failed_${res.status}`);
    }
    const tokens = (await res.json()) as StravaTokens;
    accessToken = tokens.access_token;
    // Strava rotates refresh tokens — always persist the newest one.
    await db
      .update(providerConnections)
      .set({
        encryptedAccessToken: await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY),
        encryptedRefreshToken: await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        accessTokenExpiresAt: new Date((tokens.expires_at - 60) * 1000).toISOString(),
        status: "connected",
        lastErrorCategory: null,
        updatedAt: nowInstant(),
      })
      .where(eq(providerConnections.id, conn.id));
    return accessToken;
  };

  const call = async (path: string, retried = false): Promise<Response> => {
    const token = await ensureToken();
    const res = await fetch(`${apiBase(env)}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !retried) {
      accessToken = null;
      return call(path, true);
    }
    return res;
  };

  return {
    async listActivities(afterEpoch, perPage = 50) {
      const res = await call(`/athlete/activities?after=${afterEpoch}&per_page=${perPage}`);
      if (!res.ok) throw new Error(`strava_list_${res.status}`);
      return (await res.json()) as RawStravaActivity[];
    },
    async getActivity(id) {
      const res = await call(`/activities/${id}?include_all_efforts=false`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`strava_get_${res.status}`);
      return (await res.json()) as RawStravaActivity;
    },
    async getLaps(id) {
      const res = await call(`/activities/${id}/laps`);
      if (!res.ok) return [];
      return (await res.json()) as Array<Record<string, unknown>>;
    },
  };
}
