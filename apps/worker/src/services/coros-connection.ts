import { and, eq } from "drizzle-orm";
import { providerConnections } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { CorosApiError, CorosClient, type CorosRegion } from "@rg/coros";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { Env } from "../env.js";
import type { Db } from "./db.js";

/**
 * The cloud COROS connection (cloud-direct spec §1): one provider_connections
 * row per user, provider "coros". The durable credential is the password's
 * MD5 (hashed in the BROWSER — plaintext never exists server-side), stored
 * AES-GCM-encrypted in encryptedRefreshToken; the ~24h session token is
 * cached in encryptedAccessToken and renewed at 20h. Nothing secret is ever
 * logged or returned by any DTO here.
 */

const PROVIDER = "coros" as const;
/** Renew before COROS's ~24h TTL bites. */
const TOKEN_TTL_MS = 20 * 3600 * 1000;

export interface CorosConnectResult {
  status: "connected" | "bad_credentials" | "login_failed";
  /** COROS envelope result code on login_failed (e.g. "1031") — safe to
   * surface; distinguishes "COROS answered with an error" from "unreachable". */
  code?: string;
}

type ConnRow = typeof providerConnections.$inferSelect;

async function connRow(db: Db, userId: string): Promise<ConnRow | undefined> {
  return (
    await db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, PROVIDER)))
      .limit(1)
  )[0];
}

export async function connectCoros(
  db: Db,
  env: Env,
  userId: string,
  input: { email: string; pwdMd5: string; region: CorosRegion },
  fetchImpl: typeof fetch = fetch,
): Promise<CorosConnectResult> {
  const client = new CorosClient({ region: input.region, fetchImpl });
  let corosUserId: string;
  try {
    ({ userId: corosUserId } = await client.loginWithHash(input.email, input.pwdMd5));
  } catch (e) {
    if (e instanceof CorosApiError) {
      // Result code + category only — never the email or hash.
      console.error("coros connect: login rejected", { category: e.category, code: e.resultCode });
      if (e.category === "bad_credentials") return { status: "bad_credentials" };
      return { status: "login_failed", code: e.resultCode };
    }
    console.error("coros connect: login unreachable", String(e).slice(0, 200));
    return { status: "login_failed" };
  }

  const now = nowInstant();
  const existing = await connRow(db, userId);
  const values = {
    status: "connected",
    encryptedRefreshToken: await encryptSecret(input.pwdMd5, env.TOKEN_ENCRYPTION_KEY),
    encryptedAccessToken: client.sessionToken
      ? await encryptSecret(client.sessionToken, env.TOKEN_ENCRYPTION_KEY)
      : null,
    accessTokenExpiresAt: new Date(Date.parse(now) + TOKEN_TTL_MS).toISOString(),
    externalAccountId: corosUserId,
    meta: { ...(existing?.meta ?? {}), email: input.email, region: input.region },
    lastErrorCategory: null,
    updatedAt: now,
  };
  if (existing) {
    await db.update(providerConnections).set(values).where(eq(providerConnections.id, existing.id));
  } else {
    await db.insert(providerConnections).values({
      id: newId(),
      userId,
      provider: PROVIDER,
      createdAt: now,
      lastSyncAt: null,
      scope: null,
      ...values,
    });
  }
  return { status: "connected" };
}

export async function disconnectCoros(db: Db, userId: string): Promise<void> {
  const existing = await connRow(db, userId);
  if (!existing) return;
  await db
    .update(providerConnections)
    .set({
      status: "disconnected",
      encryptedRefreshToken: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      lastErrorCategory: null,
      updatedAt: nowInstant(),
    })
    .where(eq(providerConnections.id, existing.id));
}

async function markError(db: Db, rowId: string, category: string): Promise<void> {
  await db
    .update(providerConnections)
    .set({ status: "error", lastErrorCategory: category, updatedAt: nowInstant() })
    .where(eq(providerConnections.id, rowId));
}

/**
 * An authed client, or null (no connection, disconnected, or credentials
 * rejected). Reuses the cached session token when fresh; logs in (and
 * persists the renewed token) when stale. A 1030 during renewal flips the
 * row to error/bad_credentials — no retries until the password is updated
 * (never hammer a failing login).
 */
export async function corosClient(
  db: Db,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CorosClient | null> {
  const row = await connRow(db, userId);
  if (!row || row.status === "disconnected" || !row.encryptedRefreshToken) return null;
  if (row.status === "error" && row.lastErrorCategory === "bad_credentials") return null;

  const meta = (row.meta ?? {}) as { email?: string; region?: CorosRegion };
  const email = meta.email;
  const region: CorosRegion = meta.region ?? "us";
  if (!email || !row.externalAccountId) return null;

  const pwdMd5 = await decryptSecret(row.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  const client = new CorosClient({ region, fetchImpl });

  const tokenFresh =
    row.encryptedAccessToken && row.accessTokenExpiresAt && row.accessTokenExpiresAt > nowInstant();
  if (tokenFresh) {
    client.resumeSession({
      accessToken: await decryptSecret(row.encryptedAccessToken!, env.TOKEN_ENCRYPTION_KEY),
      userId: row.externalAccountId,
      email,
      pwdMd5,
    });
    return client;
  }

  try {
    await client.loginWithHash(email, pwdMd5);
  } catch (e) {
    if (e instanceof CorosApiError && e.category === "bad_credentials") {
      await markError(db, row.id, "bad_credentials");
    } else {
      await markError(db, row.id, "login_failed");
    }
    return null;
  }
  const now = nowInstant();
  await db
    .update(providerConnections)
    .set({
      status: "connected",
      encryptedAccessToken: client.sessionToken
        ? await encryptSecret(client.sessionToken, env.TOKEN_ENCRYPTION_KEY)
        : null,
      accessTokenExpiresAt: new Date(Date.parse(now) + TOKEN_TTL_MS).toISOString(),
      lastErrorCategory: null,
      updatedAt: now,
    })
    .where(eq(providerConnections.id, row.id));
  return client;
}

export interface CorosConnectionStatus {
  connected: boolean;
  status: string | null;
  lastSyncAt: string | null;
  lastErrorCategory: string | null;
  email: string | null;
  region: string | null;
}

export async function corosConnectionStatus(db: Db, userId: string): Promise<CorosConnectionStatus> {
  const row = await connRow(db, userId);
  if (!row || row.status === "disconnected") {
    return { connected: false, status: row?.status ?? null, lastSyncAt: null, lastErrorCategory: null, email: null, region: null };
  }
  const meta = (row.meta ?? {}) as { email?: string; region?: string };
  return {
    connected: row.status === "connected",
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    lastErrorCategory: row.lastErrorCategory,
    email: meta.email ?? null,
    region: meta.region ?? null,
  };
}

/** Stamp a successful pull (read-now / cron) for the sync line's "X ago". */
export async function touchCorosSync(db: Db, userId: string): Promise<void> {
  const row = await connRow(db, userId);
  if (!row) return;
  await db
    .update(providerConnections)
    .set({ lastSyncAt: nowInstant(), lastErrorCategory: null, status: "connected", updatedAt: nowInstant() })
    .where(eq(providerConnections.id, row.id));
}
