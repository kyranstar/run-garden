/**
 * NATIVE DEVICE SIGN-IN (the LifeOS migration's SLICE-CONTRACT revision 2, §10): a phone paired from signed-in laptop
 * web holds a device token, `rgd_` and 32 random bytes, in its Keychain. The Worker keeps only the token's SHA-256
 * (`native_devices.id`), and the pairing code only as an HMAC (`native_pairings`).
 */
import { lt } from "drizzle-orm";
import { nativeDevices, nativePairings } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "../services/db.js";

/** Devices and codes past their expiry, in any state: gone (the half-hourly cron, beside `purgeExpiredSessions`). */
export async function purgeExpiredNativeRows(db: Db): Promise<void> {
  const now = nowInstant();
  await db.delete(nativeDevices).where(lt(nativeDevices.expiresAt, now));
  await db.delete(nativePairings).where(lt(nativePairings.expiresAt, now));
}
