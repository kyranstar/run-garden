import { and, eq } from "drizzle-orm";
import { providerConnections } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { GoogleEventResource } from "@rg/calendar";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { refreshGoogleToken } from "../auth/google.js";
import type { Env } from "../env.js";
import type { Db } from "./db.js";

const API = "https://www.googleapis.com/calendar/v3";

export class GoogleAuthError extends Error {
  constructor(public status: number) {
    super(`google_api_${status}`);
  }
}

export interface GoogleCalendarClient {
  listCalendars(): Promise<
    Array<{ id: string; summary: string; primary?: boolean; accessRole?: string; timeZone?: string }>
  >;
  createCalendar(summary: string, timeZone: string): Promise<{ id: string }>;
  listEvents(
    calendarId: string,
    opts: { syncToken?: string; timeMin?: string; timeMax?: string },
  ): Promise<{ items: unknown[]; nextSyncToken?: string; fullSyncRequired?: boolean }>;
  insertEvent(calendarId: string, resource: GoogleEventResource): Promise<{ id: string }>;
  patchEvent(calendarId: string, eventId: string, resource: Partial<GoogleEventResource>): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  freeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<Array<{ start: string; end: string }>>;
}

/** Returns a client bound to the user's stored (encrypted) Google tokens. */
export async function googleCalendarClient(
  db: Db,
  env: Env,
  userId: string,
): Promise<GoogleCalendarClient | null> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "google_calendar")))
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
    let tokens: Awaited<ReturnType<typeof refreshGoogleToken>>;
    try {
      tokens = await refreshGoogleToken(env, refresh);
    } catch (e) {
      // A dead refresh token (Google "Testing"-mode tokens expire after 7
      // days) previously failed here invisibly, forever — 187 consecutive
      // silent cron errors while Settings said "Connected". Park the row so
      // the UI can say "reconnect".
      await db
        .update(providerConnections)
        .set({ status: "error", lastErrorCategory: "token_expired", updatedAt: nowInstant() })
        .where(eq(providerConnections.id, conn.id));
      throw e;
    }
    accessToken = tokens.access_token;
    await db
      .update(providerConnections)
      .set({
        encryptedAccessToken: await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY),
        accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
        updatedAt: nowInstant(),
        status: "connected",
        lastErrorCategory: null,
      })
      .where(eq(providerConnections.id, conn.id));
    return accessToken;
  };

  const call = async (path: string, init: RequestInit = {}, retried = false): Promise<Response> => {
    const token = await ensureToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.status === 401 && !retried) {
      accessToken = null;
      return call(path, init, true);
    }
    return res;
  };

  return {
    async listCalendars() {
      const res = await call("/users/me/calendarList?minAccessRole=writer");
      if (!res.ok) throw new GoogleAuthError(res.status);
      const body = (await res.json()) as {
        items?: Array<{
          id: string;
          summary: string;
          primary?: boolean;
          accessRole?: string;
          timeZone?: string;
        }>;
      };
      return body.items ?? [];
    },
    async createCalendar(summary, timeZone) {
      const res = await call("/calendars", {
        method: "POST",
        body: JSON.stringify({ summary, timeZone }),
      });
      if (!res.ok) throw new GoogleAuthError(res.status);
      return (await res.json()) as { id: string };
    },
    async listEvents(calendarId, opts) {
      const params = new URLSearchParams({ maxResults: "250", singleEvents: "true", showDeleted: "true" });
      if (opts.syncToken) params.set("syncToken", opts.syncToken);
      else {
        if (opts.timeMin) params.set("timeMin", opts.timeMin);
        if (opts.timeMax) params.set("timeMax", opts.timeMax);
      }
      const items: unknown[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        if (pageToken) params.set("pageToken", pageToken);
        const res = await call(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
        if (res.status === 410) return { items: [], fullSyncRequired: true };
        if (!res.ok) throw new GoogleAuthError(res.status);
        const body = (await res.json()) as {
          items?: unknown[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        items.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
        nextSyncToken = body.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return { items, nextSyncToken };
    },
    async insertEvent(calendarId, resource) {
      const res = await call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: "POST",
        body: JSON.stringify(resource),
      });
      if (!res.ok) throw new GoogleAuthError(res.status);
      return (await res.json()) as { id: string };
    },
    async patchEvent(calendarId, eventId, resource) {
      const res = await call(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", body: JSON.stringify(resource) },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new GoogleAuthError(res.status);
    },
    async deleteEvent(calendarId, eventId) {
      const res = await call(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new GoogleAuthError(res.status);
    },
    async freeBusy(calendarIds, timeMin, timeMax) {
      const res = await call("/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin, timeMax, items: calendarIds.map((id) => ({ id })) }),
      });
      if (!res.ok) throw new GoogleAuthError(res.status);
      const body = (await res.json()) as {
        calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
      };
      const busy: Array<{ start: string; end: string }> = [];
      for (const cal of Object.values(body.calendars ?? {})) busy.push(...(cal.busy ?? []));
      return busy.sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}
