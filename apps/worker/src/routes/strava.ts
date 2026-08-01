import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { oauthStates, providerConnections, webhookEvents } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { normalizeStravaActivity, type RawStravaActivity } from "@rg/providers";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { encryptSecret, randomToken } from "../auth/crypto.js";
import { exchangeStravaCode, stravaAuthorizeUrl, stravaClient } from "../services/strava.js";
import { ingestActivities } from "../services/completion.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { resimulateFrom } from "../services/garden-sync.js";
import { recordSyncError } from "../services/reconcile-daily.js";

/**
 * Strava is READ-ONLY: OAuth with activity:read_all, webhook as a fast
 * completion signal, activity fetches. Nothing is ever uploaded, created,
 * edited, or forwarded to Strava.
 */
export const stravaRoutes = new Hono<AppContext>();

stravaRoutes.get("/connect", requireUser, async (c) => {
  if (!c.env.STRAVA_CLIENT_ID) return c.json({ error: "strava_not_configured" }, 501);
  const state = randomToken(24);
  await c.get("db").insert(oauthStates).values({
    state,
    provider: "strava",
    createdAt: nowInstant(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return c.redirect(await stravaAuthorizeUrl(c.env, state));
});

stravaRoutes.get("/callback", async (c) => {
  const db = c.get("db");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code/state", 400);
  const stored = await db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (!stored[0] || stored[0].provider !== "strava" || stored[0].expiresAt < nowInstant()) {
    return c.text("Invalid state", 400);
  }
  // Single user: attach to the sole user (the app rejects other Google accounts).
  const { users } = await import("@rg/database");
  const user = (await db.select().from(users).limit(1))[0];
  if (!user) return c.text("No user", 400);

  const tokens = await exchangeStravaCode(c.env, code);
  const now = nowInstant();
  const existing = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, user.id), eq(providerConnections.provider, "strava")))
    .limit(1);
  const values = {
    status: "connected" as const,
    encryptedAccessToken: await encryptSecret(tokens.access_token, c.env.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: await encryptSecret(tokens.refresh_token, c.env.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: new Date((tokens.expires_at - 60) * 1000).toISOString(),
    externalAccountId: tokens.athlete ? String(tokens.athlete.id) : null,
    updatedAt: now,
    lastErrorCategory: null,
  };
  if (existing[0]) {
    await db.update(providerConnections).set(values).where(eq(providerConnections.id, existing[0].id));
  } else {
    await db
      .insert(providerConnections)
      .values({ id: newId(), userId: user.id, provider: "strava", createdAt: now, ...values });
  }
  return c.redirect("/settings?connected=strava");
});

stravaRoutes.post("/disconnect", requireUser, async (c) => {
  await c
    .get("db")
    .update(providerConnections)
    .set({
      status: "disconnected",
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      updatedAt: nowInstant(),
    })
    .where(
      and(
        eq(providerConnections.userId, c.get("userId")),
        eq(providerConnections.provider, "strava"),
      ),
    );
  return c.json({ ok: true });
});

/** Webhook validation (subscription creation echo). */
stravaRoutes.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === c.env.STRAVA_WEBHOOK_VERIFY_TOKEN && challenge) {
    return c.json({ "hub.challenge": challenge });
  }
  return c.json({ error: "verification_failed" }, 403);
});

interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  event_time: number;
  updates?: Record<string, string>;
}

/** Webhook events: must respond fast; processing is idempotent. */
stravaRoutes.post("/webhook", async (c) => {
  const db = c.get("db");
  const event = (await c.req.json()) as StravaWebhookEvent;
  const dedupeId = `strava:${event.object_type}:${event.object_id}:${event.aspect_type}:${event.event_time}`;

  const existing = await db.select().from(webhookEvents).where(eq(webhookEvents.id, dedupeId)).limit(1);
  if (existing[0]) return c.json({ ok: true, duplicate: true });

  await db.insert(webhookEvents).values({
    id: dedupeId,
    provider: "strava",
    receivedAt: nowInstant(),
    objectType: event.object_type,
    objectId: String(event.object_id),
    aspect: event.aspect_type,
    payload: event as unknown as Record<string, unknown>,
    status: "pending",
  });

  // Process inline but never block the 200 beyond Strava's 2s budget.
  c.executionCtx.waitUntil(processStravaWebhook(db, c.env, dedupeId, event));
  return c.json({ ok: true });
});

async function processStravaWebhook(
  db: import("../services/db.js").Db,
  env: import("../env.js").Env,
  dedupeId: string,
  event: StravaWebhookEvent,
): Promise<void> {
  const now = nowInstant();
  try {
    if (event.object_type !== "activity" || event.aspect_type === "delete") {
      await db.update(webhookEvents).set({ status: "ignored", processedAt: now }).where(eq(webhookEvents.id, dedupeId));
      return;
    }
    const { users } = await import("@rg/database");
    const user = (await db.select().from(users).limit(1))[0];
    if (!user) return;
    const client = await stravaClient(db, env, user.id);
    if (!client) {
      await db.update(webhookEvents).set({ status: "ignored", processedAt: now }).where(eq(webhookEvents.id, dedupeId));
      return;
    }
    const raw = await client.getActivity(String(event.object_id));
    if (!raw) {
      await db.update(webhookEvents).set({ status: "ignored", processedAt: now }).where(eq(webhookEvents.id, dedupeId));
      return;
    }
    const normalized = normalizeStravaActivity(raw as RawStravaActivity);
    const stats = await ingestActivities(db, { userId: user.id, sources: [normalized] });
    const prefs = await loadPreferences(db, user.id);
    const earliest = stats.affectedDates[0];
    if (earliest) await resimulateFrom(db, user.id, earliest, prefs);
    await db.update(webhookEvents).set({ status: "processed", processedAt: nowInstant() }).where(eq(webhookEvents.id, dedupeId));
  } catch (e) {
    await db
      .update(webhookEvents)
      .set({ status: "error", processedAt: nowInstant() })
      .where(eq(webhookEvents.id, dedupeId));
    await recordSyncError(db, {
      provider: "strava",
      operation: "webhook",
      category: "webhook_processing_failed",
      message: e instanceof Error ? e.message : "unknown",
    });
  }
}
