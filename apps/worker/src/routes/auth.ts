import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { providerConnections } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  consumeOauthState,
  decodeIdToken,
  emailAllowed,
  exchangeGoogleCode,
  GOOGLE_SCOPES_CALENDAR,
  GOOGLE_SCOPES_SIGNIN,
  startGoogleAuth,
} from "../auth/google.js";
import { encryptSecret } from "../auth/crypto.js";
import {
  completeCorosMcpAuth,
  consumeCorosMcpState,
  disconnectCorosMcp,
  probeMcpTool,
  startCorosMcpAuth,
  syncCorosMcpSleep,
} from "../services/coros-mcp.js";
import { loadPreferences } from "../services/calendar-sync.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  findOrCreateUser,
  SESSION_COOKIE,
  sessionCookie,
} from "../auth/sessions.js";

export const authRoutes = new Hono<AppContext>();

/**
 * Only same-app paths survive as a post-login redirect: exactly one leading
 * "/" — protocol-relative "//host" and anything with a scheme are
 * attacker-suppliable off-site targets — and no backslashes (browsers
 * normalize "/\host" to "//host") or CR/LF. Anything else falls back to "/".
 * Applied at store time (start) AND at redirect time (callback), so a stale
 * pre-validation row in oauth_states can't redirect off-site either.
 */
function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || value.includes("\r") || value.includes("\n")) return "/";
  return value;
}

/** Start sign-in. mode=calendar requests Calendar scopes + offline access. */
authRoutes.get("/google/start", async (c) => {
  const mode = c.req.query("mode") ?? "signin";
  const url = await startGoogleAuth(c.get("db"), c.env, {
    scopes: mode === "calendar" ? GOOGLE_SCOPES_CALENDAR : GOOGLE_SCOPES_SIGNIN,
    offline: mode === "calendar",
    redirectTo: safeRedirectPath(c.req.query("redirect")),
  });
  return c.redirect(url);
});

authRoutes.get("/google/callback", async (c) => {
  const db = c.get("db");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const stored = await consumeOauthState(db, state);
  if (!stored) return c.text("Invalid or expired state", 400);

  const tokens = await exchangeGoogleCode(c.env, code, stored.codeVerifier);
  const identity = decodeIdToken(tokens.id_token ?? "");

  // Single-user gate: only the configured Google account may enter — and only
  // when Google itself asserts the address is verified.
  if (!emailAllowed(c.env, identity)) {
    return c.html(
      `<html><body style="font-family:system-ui;padding:3rem;max-width:28rem;margin:auto">
        <h2>This account can't be used</h2>
        <p>This is a private, single-user application. Sign in with the configured Google account.</p>
      </body></html>`,
      403,
    );
  }

  const userId = await findOrCreateUser(db, identity.email!, identity.sub ?? "", identity.name);
  const now = nowInstant();

  // Store Calendar tokens when this was a calendar-scope connection.
  if (tokens.refresh_token) {
    const existing = await db
      .select()
      .from(providerConnections)
      .where(
        and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "google_calendar")),
      )
      .limit(1);
    const values = {
      status: "connected" as const,
      encryptedAccessToken: await encryptSecret(tokens.access_token, c.env.TOKEN_ENCRYPTION_KEY),
      encryptedRefreshToken: await encryptSecret(tokens.refresh_token, c.env.TOKEN_ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
      scope: tokens.scope ?? null,
      externalAccountId: identity.email ?? null,
      updatedAt: now,
      lastErrorCategory: null,
    };
    if (existing[0]) {
      await db.update(providerConnections).set(values).where(eq(providerConnections.id, existing[0].id));
    } else {
      await db.insert(providerConnections).values({
        id: newId(),
        userId,
        provider: "google_calendar",
        createdAt: now,
        ...values,
      });
    }
  }

  const token = await createSession(db, userId, c.req.header("user-agent"));
  const secure = c.env.APP_URL.startsWith("https");
  c.header("Set-Cookie", sessionCookie(token, secure));

  return c.redirect(safeRedirectPath(stored.redirectTo));
});

/**
 * The official COROS sleep connection (sleep/recovery phase 2): OAuth against
 * the athlete's own COROS account via the first-party MCP server. Start and
 * callback both ride the session cookie — this connects an existing signed-in
 * user, unlike google/callback's sign-in duty.
 */
authRoutes.get("/coros-mcp/start", requireUser, async (c) => {
  try {
    const url = await startCorosMcpAuth(
      c.get("db"),
      c.env,
      c.get("userId"),
      safeRedirectPath(c.req.query("redirect")),
    );
    return c.redirect(url);
  } catch (e) {
    console.error("coros-mcp start failed", String(e).slice(0, 200));
    return c.redirect(`${c.env.APP_URL}/settings?corosSleep=error`);
  }
});

authRoutes.get("/coros-mcp/callback", requireUser, async (c) => {
  const db = c.get("db");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);
  const stored = await consumeCorosMcpState(db, state);
  if (!stored) return c.text("Invalid or expired state", 400);
  const ok = await completeCorosMcpAuth(db, c.env, c.get("userId"), code, stored.codeVerifier);
  const dest = safeRedirectPath(stored.redirectTo);
  if (!ok) return c.redirect(`${c.env.APP_URL}${dest}?corosSleep=error`);
  // First pull right away — the athlete should see last night, not a
  // "connected, come back tomorrow" shrug. Best-effort; the sweep covers it.
  const prefs = await loadPreferences(db, c.get("userId"));
  c.executionCtx.waitUntil(
    syncCorosMcpSleep(db, c.env, c.get("userId"), prefs.timezone).catch(() => undefined),
  );
  return c.redirect(`${c.env.APP_URL}${dest}?corosSleep=connected`);
});

authRoutes.post("/coros-mcp/disconnect", requireUser, async (c) => {
  await disconnectCorosMcp(c.get("db"), c.env, c.get("userId"));
  return c.json({ ok: true });
});

/** Re-run the sleep pull on demand (the cron throttle doesn't apply) and
 * report the outcome — the athlete's own diagnosis surface for a connection
 * that says sync stopped. */
authRoutes.post("/coros-mcp/sync-now", requireUser, async (c) => {
  const db = c.get("db");
  const prefs = await loadPreferences(db, c.get("userId"));
  const result = await syncCorosMcpSleep(db, c.env, c.get("userId"), prefs.timezone);
  return c.json(result);
});

/** The user's own connection diagnostics: status + the values-redacted shape
 * skeleton stored on the last tool failure. With ?probe=<tool>, one masked
 * (digits → #) look at what a whitelisted health tool returns for THIS
 * account. Their row, their data, their eyes only. */
authRoutes.get("/coros-mcp/debug", requireUser, async (c) => {
  const db = c.get("db");
  const probe = c.req.query("probe");
  if (probe) {
    const prefs = await loadPreferences(db, c.get("userId"));
    const days = Number(c.req.query("days") ?? 3);
    const result = await probeMcpTool(db, c.env, c.get("userId"), probe, days, prefs.timezone);
    return c.json(result);
  }
  const row = (
    await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.userId, c.get("userId")))
  ).find((r) => r.provider === "coros_mcp");
  if (!row) return c.json({ error: "not_connected" }, 404);
  const meta = (row.meta ?? {}) as { lastToolError?: string; issuer?: string };
  return c.json({
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    lastErrorCategory: row.lastErrorCategory,
    issuer: meta.issuer ?? null,
    lastToolError: meta.lastToolError ?? null,
  });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c.get("db"), getCookie(c, SESSION_COOKIE));
  c.header("Set-Cookie", clearSessionCookie(c.env.APP_URL.startsWith("https")));
  return c.json({ ok: true });
});

authRoutes.get("/me", requireUser, async (c) => {
  const db = c.get("db");
  const connections = await db
    .select({
      provider: providerConnections.provider,
      status: providerConnections.status,
      lastSyncAt: providerConnections.lastSyncAt,
      lastErrorCategory: providerConnections.lastErrorCategory,
    })
    .from(providerConnections)
    .where(eq(providerConnections.userId, c.get("userId")));
  return c.json({
    userId: c.get("userId"),
    email: c.get("userEmail"),
    connections,
    fixtureMode: c.env.FIXTURE_MODE === "1",
  });
});
