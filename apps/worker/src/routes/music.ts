/**
 * `/api/music` — the music dock (2026-10-17): the Spotify connection (services/spotify-auth.ts) and the dock's
 * shortcuts (`music` in the preferences). The dock itself talks to Spotify from the page (packages/ui/src/music).
 *
 * Dark until the owner's Client ID arrives: a plain 404 for every path here while `SPOTIFY_CLIENT_ID` is empty, signed
 * in or not; the dock then draws nothing. Set, every route signs in first — except the callback, which Spotify sends
 * to whichever browser finished the login, and which is bound to the athlete by its signed state instead.
 *
 *   GET    /                    → { connected, reason?, music }   the dock's read (session, connection, preferences:
 *                                                                  three statements)
 *   PUT    /          { music } → { music }                       the shortcuts, whole (session, restore marker, one
 *                                                                  write: three statements)
 *   GET    /spotify/login       → 302 Spotify's authorize URL    (the session: one statement)
 *   GET    /spotify/callback    → 302 /?music=connected | error   (the restore marker, one upsert; one fetch)
 *   GET    /spotify/token       → { connected: true, accessToken, expiresAt } | { connected: false, reason }
 *                                 (session, row: two statements; near expiry — or with ?fresh=1, after Spotify refused
 *                                 the token — a refresh: the claim, one fetch, the write; a request that finds a
 *                                 refresh under way reads the row again a few times instead)
 *   DELETE /spotify             → { ok }                          (session, restore marker, one delete)
 *
 * Fixture mode (the fixture stack; never production): the login connects a fixture account without leaving the
 * machine, the token names the fixture API (`apiBase`), and `/fixture/v1/*` answers as Spotify would
 * (services/spotify-fixture.ts).
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { userPreferences } from "@rg/database";
import { musicPreferencesSchema, userPreferencesSchema } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { fixtureModeEnabled } from "../env.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { restoreInProgress } from "../services/account-state.js";
import {
  disconnectSpotify,
  exchangeSpotifyCode,
  loadSpotifyRow,
  pkceVerifier,
  spotifyAccessToken,
  spotifyAuthorizeUrl,
  spotifyClientId,
  spotifyConnectionOf,
  storeSpotifyTokens,
  verifySpotifyState,
} from "../services/spotify-auth.js";
import { FIXTURE_SPOTIFY_API_BASE, FIXTURE_SPOTIFY_TOKENS, spotifyFixtureApi } from "../services/spotify-fixture.js";

export interface MusicDeps {
  /** Spotify's token endpoint is reached through this (tests fake it). */
  fetch?: typeof fetch;
  now?: () => number;
  /** A request waiting for another's refresh waits through this (tests step it). */
  sleep?: (ms: number) => Promise<void>;
  /** The token endpoint's deadline (tests shorten it). */
  tokenTimeoutMs?: number;
  /** Where a refresh is kept alive past the response (default: the request's own `executionCtx.waitUntil`). */
  waitUntil?: (work: Promise<unknown>) => void;
}

export function makeMusicRoutes(deps: MusicDeps = {}): Hono<AppContext> {
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const r = new Hono<AppContext>();

  // Dark: nothing here exists until the owner's Client ID is set.
  r.use("*", async (c, next) => {
    if (!spotifyClientId(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });

  /** Back into the app, where the dock opens and says how it went. */
  const backToApp = (appUrl: string, outcome: "connected" | "error") => `${appUrl.replace(/\/+$/, "")}/?music=${outcome}`;

  r.get("/spotify/callback", async (c) => {
    const at = now();
    const bound = await verifySpotifyState(c.env.SESSION_SECRET, c.req.query("state"), at);
    if (!bound) return c.text("This Spotify sign-in has expired. Start it again from Run Garden.", 400);
    const code = c.req.query("code");
    if (c.req.query("error") || !code) return c.redirect(backToApp(c.env.APP_URL, "error"), 302);
    const db = c.get("db");
    // A restore replacing the account freezes every other write (ruling B2) — this one too.
    if (await restoreInProgress(db, bound.userId)) return c.redirect(backToApp(c.env.APP_URL, "error"), 302);
    const tokens = await exchangeSpotifyCode(fetchImpl, c.env, spotifyClientId(c.env)!, code, await pkceVerifier(c.env.SESSION_SECRET, bound.nonce));
    if (!tokens) {
      console.warn("spotify code exchange failed");
      return c.redirect(backToApp(c.env.APP_URL, "error"), 302);
    }
    await storeSpotifyTokens(db, c.env, bound.userId, tokens, at);
    return c.redirect(backToApp(c.env.APP_URL, "connected"), 302);
  });

  // The fixture API: fixture mode only, a bearer token rather than the session (as Spotify's own API).
  r.use("/fixture/*", async (c, next) => {
    if (!fixtureModeEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    await next();
  });
  r.route("/fixture/v1", spotifyFixtureApi);

  r.use("*", requireUser);

  r.get("/", async (c) => {
    const db = c.get("db");
    const userId = c.get("userId");
    const state = spotifyConnectionOf(await loadSpotifyRow(db, userId));
    const prefs = await loadPreferences(db, userId);
    return c.json({
      connected: state === "connected",
      ...(state === "reconnect" ? { reason: "reconnect" } : {}),
      music: prefs.music ?? musicPreferencesSchema.parse({}),
    });
  });

  r.put("/", async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = musicPreferencesSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_music", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    const userId = c.get("userId");
    const at = new Date(now()).toISOString();
    const music = JSON.stringify(parsed.data);
    // One statement: only `music` changes, whatever else the preferences hold (as Settings → Coach writes `coach`).
    const [row] = (await c.get("db").all(sql`
      INSERT INTO ${userPreferences} (user_id, prefs, updated_at) VALUES (${userId}, json_object('music', json(${music})), ${at})
      ON CONFLICT (user_id) DO UPDATE SET prefs = json_set(prefs, '$.music', json(${music})), updated_at = ${at}
      RETURNING prefs
    `)) as Array<{ prefs: string }>;
    const stored = userPreferencesSchema.safeParse(row ? JSON.parse(row.prefs) : {});
    return c.json({ music: (stored.success ? stored.data.music : undefined) ?? parsed.data });
  });

  r.get("/spotify/login", async (c) => {
    if (fixtureModeEnabled(c.env)) {
      await storeSpotifyTokens(c.get("db"), c.env, c.get("userId"), FIXTURE_SPOTIFY_TOKENS, now());
      return c.redirect(backToApp(c.env.APP_URL, "connected"), 302);
    }
    return c.redirect(await spotifyAuthorizeUrl(c.env, spotifyClientId(c.env)!, c.get("userId"), now()), 302);
  });

  r.get("/spotify/token", async (c) => {
    c.header("Cache-Control", "no-store");
    const force = c.req.query("fresh") === "1" && !fixtureModeEnabled(c.env);
    const keepAlive =
      deps.waitUntil ??
      ((work: Promise<unknown>) => {
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          /* no execution context (a host without one): the request carries it */
        }
      });
    const answer = await spotifyAccessToken(c.get("db"), c.env, spotifyClientId(c.env)!, c.get("userId"), fetchImpl, now(), {
      force,
      waitUntil: keepAlive,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.tokenTimeoutMs !== undefined ? { tokenTimeoutMs: deps.tokenTimeoutMs } : {}),
    });
    if ("unavailable" in answer) return c.json({ error: "spotify_unavailable" }, 502);
    if (answer.connected && fixtureModeEnabled(c.env)) return c.json({ ...answer, apiBase: FIXTURE_SPOTIFY_API_BASE });
    return c.json(answer);
  });

  r.delete("/spotify", async (c) => {
    await disconnectSpotify(c.get("db"), c.get("userId"));
    return c.json({ ok: true });
  });

  return r;
}

export const musicRoutes = makeMusicRoutes();
