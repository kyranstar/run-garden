import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { deviceHandshakes, providerConnections } from "@rg/database";
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
  clearSessionCookie,
  createSession,
  destroySession,
  findOrCreateUser,
  SESSION_COOKIE,
  sessionCookie,
} from "../auth/sessions.js";

export const authRoutes = new Hono<AppContext>();

/** Start sign-in. mode=calendar requests Calendar scopes + offline access. */
authRoutes.get("/google/start", async (c) => {
  const mode = c.req.query("mode") ?? "signin";
  const handshakeId = c.req.query("handshake");
  const url = await startGoogleAuth(c.get("db"), c.env, {
    scopes: mode === "calendar" ? GOOGLE_SCOPES_CALENDAR : GOOGLE_SCOPES_SIGNIN,
    offline: mode === "calendar",
    redirectTo: c.req.query("redirect") ?? "/",
    deviceHandshakeId: handshakeId,
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

  // Single-user gate: only the configured Google account may enter.
  if (!emailAllowed(c.env, identity.email)) {
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

  // Desktop pairing: approve the pending handshake for this user.
  if (stored.deviceHandshakeId) {
    await db
      .update(deviceHandshakes)
      .set({ status: "approved", approvedUserId: userId })
      .where(and(eq(deviceHandshakes.id, stored.deviceHandshakeId), eq(deviceHandshakes.status, "pending")));
  }

  const token = await createSession(db, userId, c.req.header("user-agent"));
  const secure = c.env.APP_URL.startsWith("https");
  c.header("Set-Cookie", sessionCookie(token, secure));

  if (stored.deviceHandshakeId) {
    return c.html(
      `<html><body style="font-family:system-ui;padding:3rem;max-width:28rem;margin:auto">
        <h2>Desktop connected</h2>
        <p>You can close this window and return to the desktop app.</p>
      </body></html>`,
    );
  }
  return c.redirect(stored.redirectTo ?? "/");
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
