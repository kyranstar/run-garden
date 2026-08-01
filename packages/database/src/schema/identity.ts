import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  googleSub: text("google_sub").unique(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha-256 of the session token; the raw token lives only in the cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(), // google | strava | coros_mcp
  codeVerifier: text("code_verifier"),
  redirectTo: text("redirect_to"),
  /** For desktop sign-in: the device registration handshake id. */
  deviceHandshakeId: text("device_handshake_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(), // google_calendar | strava | coros_mcp
    status: text("status").notNull().default("connected"), // connected | error | disconnected
    /** AES-GCM encrypted, base64url; never stored in plaintext. */
    encryptedAccessToken: text("encrypted_access_token"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    accessTokenExpiresAt: text("access_token_expires_at"),
    scope: text("scope"),
    externalAccountId: text("external_account_id"),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSyncAt: text("last_sync_at"),
    lastErrorCategory: text("last_error_category"),
  },
  (t) => [uniqueIndex("provider_conn_unique").on(t.userId, t.provider)],
);

export const desktopDevices = sqliteTable("desktop_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  /** Ed25519 public key, base64url raw. */
  publicKey: text("public_key").notNull(),
  platform: text("platform").notNull(),
  appVersion: text("app_version").notNull(),
  bridgeVersion: text("bridge_version"),
  capabilities: text("capabilities", { mode: "json" }).$type<Record<string, boolean>>(),
  bridgePaused: integer("bridge_paused", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const deviceHandshakes = sqliteTable("device_handshakes", {
  /** Short-lived pairing code flow for desktop registration. */
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  deviceName: text("device_name").notNull(),
  platform: text("platform").notNull(),
  appVersion: text("app_version").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | claimed | expired
  approvedUserId: text("approved_user_id"),
  deviceId: text("device_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  prefs: text("prefs", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: text("updated_at").notNull(),
});
