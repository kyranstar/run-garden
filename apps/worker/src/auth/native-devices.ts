/**
 * NATIVE DEVICE SIGN-IN (the LifeOS migration's SLICE-CONTRACT revision 2, §10): a phone paired from signed-in laptop
 * web holds a device token, `rgd_` and 32 random bytes, in its Keychain. The Worker keeps only the token's SHA-256
 * (`native_devices.id`), and the pairing code only as an HMAC (`native_pairings`).
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { nativeDevices, nativePairings, users } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "../services/db.js";
import { sha256Hex } from "./crypto.js";

/**
 * OWNER'S CHOICE, open (SLICE-CONTRACT §9 question 1): how long a confirmed device works before the owner re-pairs it
 * from the laptop. The default, 30 days, as a browser session (`sessions.ts`); warned 7 days ahead.
 */
export const NATIVE_DEVICE_LIFETIME_DAYS = 30;
export const NATIVE_DEVICE_WARN_DAYS = 7;

/**
 * OWNER'S CHOICE, open (SLICE-CONTRACT §9 question 2): what a device's Build and Start do beyond the plan — the watch
 * mirror's hand-over (a COROS push while `WATCH_PUSH_ENABLED`) and the Calendar resync. The default: AS ON THE WEB, the
 * same route handlers with nothing suppressed. This is the only value the code implements; suppressing them for devices
 * would be a change of its own, made when the owner chooses it.
 */
export const DEVICE_PROVIDER_EFFECTS = "as_on_web" as const;

/** Last use is written at most this often. */
export const LAST_USED_EVERY_MS = 3_600_000;

/** `rgd_` and 32 random bytes, base64url (43 characters). */
const DEVICE_TOKEN = /^rgd_[A-Za-z0-9_-]{43}$/;

/** Whether this Authorization header is a device token's: `Bearer rgd_…` (the scheme in any case). */
export function isDeviceBearer(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^(\S+)[ \t]+rgd_/.exec(header);
  return !!m && m[1]!.toLowerCase() === "bearer";
}

/** The device token in this header, or null when it is not one well-formed token. */
export function deviceTokenOf(header: string | undefined): string | null {
  const m = /^(\S+)[ \t]+(\S+)$/.exec(header ?? "");
  if (!m || m[1]!.toLowerCase() !== "bearer") return null;
  return DEVICE_TOKEN.test(m[2]!) ? m[2]! : null;
}

export interface ResolvedDevice {
  id: string;
  userId: string;
  email: string;
  scope: string;
  label: string;
  state: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** The device this token names, with its account's email (one read), or null. */
export async function findDevice(db: Db, token: string): Promise<ResolvedDevice | null> {
  const id = await sha256Hex(token);
  const [row] = await db
    .select({
      id: nativeDevices.id,
      userId: nativeDevices.userId,
      email: users.email,
      scope: nativeDevices.scope,
      label: nativeDevices.label,
      state: nativeDevices.state,
      expiresAt: nativeDevices.expiresAt,
      lastUsedAt: nativeDevices.lastUsedAt,
    })
    .from(nativeDevices)
    .innerJoin(users, eq(users.id, nativeDevices.userId))
    .where(eq(nativeDevices.id, id))
    .limit(1);
  return row ?? null;
}

/** The account is the owner's: its email is ALLOWED_GOOGLE_EMAIL, as the bearer door checks (token.ts). */
export const isOwnerEmail = (email: string, env: Env): boolean => {
  const owner = (env.ALLOWED_GOOGLE_EMAIL ?? "").trim().toLowerCase();
  return owner !== "" && email.trim().toLowerCase() === owner;
};

/** Last use, written at most hourly: one guarded UPDATE when the stamp is older than LAST_USED_EVERY_MS, else nothing. */
export async function touchDevice(db: Db, device: Pick<ResolvedDevice, "id" | "lastUsedAt">, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - LAST_USED_EVERY_MS).toISOString();
  if (device.lastUsedAt !== null && device.lastUsedAt > cutoff) return;
  await db
    .update(nativeDevices)
    .set({ lastUsedAt: now })
    .where(and(eq(nativeDevices.id, device.id), or(isNull(nativeDevices.lastUsedAt), sql`${nativeDevices.lastUsedAt} <= ${cutoff}`)));
}

/** Devices and codes past their expiry, in any state: gone (the half-hourly cron, beside `purgeExpiredSessions`). */
export async function purgeExpiredNativeRows(db: Db): Promise<void> {
  const now = nowInstant();
  await db.delete(nativeDevices).where(lt(nativeDevices.expiresAt, now));
  await db.delete(nativePairings).where(lt(nativePairings.expiresAt, now));
}
