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

/**
 * A paired phone (native device sign-in, migration 0038). `id` is the sha-256 of the device's `rgd_` token; the raw
 * token lives only in the phone's Keychain. `state`: pending (until the owner confirms it on the laptop) → active, or
 * revoked. `expires_at` is the pending window while pending, and the device's lifetime once active.
 */
export const nativeDevices = sqliteTable(
  "native_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** What the token may reach: `training-slice-v1` (worker auth/device-scope.ts). A later slice gets a new scope. */
    scope: text("scope").notNull(),
    /** The phone's own name for itself, as it sent it at pairing. */
    label: text("label").notNull(),
    state: text("state").notNull(), // pending | active | revoked
    /** Four digits derived from `id`, shown on the phone and on the laptop before Confirm. */
    checkNumber: text("check_number").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    confirmedAt: text("confirmed_at"),
    /** Written at most hourly. */
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
    revokedReason: text("revoked_reason"), // owner | owner_all | sign_out | check_failed
    /** Wrong check numbers sent to Confirm (migration 0039); the bound revokes the pending phone. */
    checkTries: integer("check_tries").notNull().default(0),
  },
  (t) => [index("native_devices_user_idx").on(t.userId)],
);

/**
 * Pairing's rate controls (migration 0039): a fixed-window attempt counter per key — `redeem:global`,
 * `redeem:ip:<sha-256 of the client address>`, `mint:<user id>`. `blocked_until` is the cool-off's end, null when none.
 */
export const nativePairLimits = sqliteTable("native_pair_limits", {
  key: text("key").primaryKey(),
  windowStart: text("window_start").notNull(),
  count: integer("count").notNull().default(0),
  blockedUntil: text("blocked_until"),
  /** When the row may be purged: its window's end, or its cool-off's. */
  expiresAt: text("expires_at").notNull(),
});

/** The account's one live pairing code (migration 0038), as an HMAC under SESSION_SECRET; a new code replaces it. */
export const nativePairings = sqliteTable("native_pairings", {
  userId: text("user_id").primaryKey(),
  codeHmac: text("code_hmac").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  /** Wrong codes tried against it; the fifth burns it. */
  tries: integer("tries").notNull().default(0),
  usedAt: text("used_at"),
});

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(), // google | coros_mcp
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
    provider: text("provider").notNull(), // google_calendar | coros_mcp
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

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  prefs: text("prefs", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: text("updated_at").notNull(),
});
