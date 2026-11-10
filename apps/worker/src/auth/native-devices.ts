/**
 * NATIVE DEVICE SIGN-IN (the LifeOS migration's SLICE-CONTRACT revision 2, §10): a phone paired from signed-in laptop
 * web holds a device token, `rgd_` and 32 random bytes, in its Keychain. The Worker keeps only the token's SHA-256
 * (`native_devices.id`), and the pairing code only as an HMAC (`native_pairings`).
 */
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { nativeDevices, nativePairings, users } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "../services/db.js";
import { hmacSha256Hex, randomToken, sha256Hex } from "./crypto.js";
import { DEVICE_SCOPE } from "./device-scope.js";

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

/** A pairing code lives 5 minutes, and 5 wrong tries burn it (§10.1). */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_TRIES = 5;
/** A redeemed phone waits this long for the owner's Confirm on the laptop; unconfirmed, it is expired, then purged. */
export const PENDING_CONFIRM_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
const at = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();

/** Crockford's base32: no I, L, O or U. 8 characters carry 40 bits. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The HMAC's and the check number's labels: what each digest is of, so neither can stand in for the other. */
const PAIRING_LABEL = "run-garden native pairing code v1";
const CHECK_LABEL = "run-garden native check number v1";

/** A fresh code: 5 random bytes as 8 Crockford characters. */
export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  let out = "";
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Math.floor(value / 32 ** i) % 32];
  return out;
}

/** A code as the phone's owner typed it, as Crockford reads it: case, spaces and hyphens ignored; I and L are 1, O is 0. */
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

/** The stored form of the account's code: an HMAC under SESSION_SECRET, labelled and bound to the account. */
export const pairingCodeHmac = (secret: string, userId: string, code: string): Promise<string> =>
  hmacSha256Hex(secret, `${PAIRING_LABEL}\n${userId}\n${code}`);

/** The 4 digits a device id shows on both screens before Confirm; the phone derives them from its own token's hash. */
export async function checkNumberOf(deviceId: string): Promise<string> {
  const digest = await sha256Hex(`${CHECK_LABEL}\n${deviceId}`);
  return String(parseInt(digest.slice(0, 8), 16) % 10_000).padStart(4, "0");
}

/** The owner's account (ALLOWED_GOOGLE_EMAIL), or null. */
async function ownerIdOf(db: Db, env: Env): Promise<string | null> {
  const owner = (env.ALLOWED_GOOGLE_EMAIL ?? "").trim().toLowerCase();
  if (!owner) return null;
  const [row] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${owner}`).limit(1);
  return row?.id ?? null;
}

/** Minting (laptop web): a new code for the account, replacing (burning) any code it had, in one statement. */
export async function mintPairing(db: Db, env: Env, userId: string, now: string): Promise<{ code: string; expiresAt: string }> {
  const code = newPairingCode();
  const codeHmac = await pairingCodeHmac(env.SESSION_SECRET, userId, code);
  const expiresAt = at(now, PAIRING_CODE_TTL_MS);
  const fresh = { codeHmac, createdAt: now, expiresAt, tries: 0, usedAt: null };
  await db.insert(nativePairings).values({ userId, ...fresh }).onConflictDoUpdate({ target: nativePairings.userId, set: fresh });
  return { code, expiresAt };
}

/**
 * Redeeming (the phone, unauthenticated): ONE conditional UPDATE … RETURNING on the owner's live code — unused, unexpired,
 * under its tries. In the same statement a match marks it used and a miss counts one try, so however many requests arrive
 * at once, a code is used once and takes at most PAIRING_MAX_TRIES wrong guesses. A pending device is made only when the
 * UPDATE hands its row back marked used. Null for every failure alike: no owner, no live code, a wrong one.
 */
export async function redeemPairing(
  db: Db,
  env: Env,
  input: { code: string; label: string },
  now: string,
): Promise<{ token: string; check: string; confirmBy: string } | null> {
  const owner = await ownerIdOf(db, env);
  if (!owner) return null;
  const hmac = await pairingCodeHmac(env.SESSION_SECRET, owner, normalizeCode(input.code));
  const matches = sql`${nativePairings.codeHmac} = ${hmac}`;
  const [claimed] = await db
    .update(nativePairings)
    .set({
      usedAt: sql`case when ${matches} then ${now} else null end`,
      tries: sql`${nativePairings.tries} + case when ${matches} then 0 else 1 end`,
    })
    .where(
      and(
        eq(nativePairings.userId, owner),
        isNull(nativePairings.usedAt),
        gt(nativePairings.expiresAt, now),
        lt(nativePairings.tries, PAIRING_MAX_TRIES),
      ),
    )
    .returning({ usedAt: nativePairings.usedAt });
  if (!claimed?.usedAt) return null;
  const token = `rgd_${randomToken(32)}`;
  const id = await sha256Hex(token);
  const check = await checkNumberOf(id);
  const confirmBy = at(now, PENDING_CONFIRM_MS);
  await db.insert(nativeDevices).values({
    id,
    userId: owner,
    scope: DEVICE_SCOPE,
    label: input.label,
    state: "pending",
    checkNumber: check,
    createdAt: now,
    expiresAt: confirmBy,
  });
  return { token, check, confirmBy };
}

export type ConfirmOutcome = { ok: true; expiresAt: string } | { ok: false; error: "not_found" | "not_pending" | "confirm_expired" | "check_mismatch" };

/** The owner's Confirm (laptop web): a pending device of theirs, within its window, with its check number → active. */
export async function confirmDevice(db: Db, userId: string, id: string, check: string, now: string): Promise<ConfirmOutcome> {
  const expiresAt = at(now, NATIVE_DEVICE_LIFETIME_DAYS * DAY_MS);
  const [done] = await db
    .update(nativeDevices)
    .set({ state: "active", confirmedAt: now, expiresAt })
    .where(
      and(
        eq(nativeDevices.id, id),
        eq(nativeDevices.userId, userId),
        eq(nativeDevices.state, "pending"),
        gt(nativeDevices.expiresAt, now),
        eq(nativeDevices.checkNumber, check),
      ),
    )
    .returning({ id: nativeDevices.id });
  if (done) return { ok: true, expiresAt };
  const [row] = await db
    .select({ state: nativeDevices.state, expiresAt: nativeDevices.expiresAt })
    .from(nativeDevices)
    .where(and(eq(nativeDevices.id, id), eq(nativeDevices.userId, userId)));
  if (!row) return { ok: false, error: "not_found" };
  if (row.state !== "pending") return { ok: false, error: "not_pending" };
  if (row.expiresAt <= now) return { ok: false, error: "confirm_expired" };
  return { ok: false, error: "check_mismatch" };
}

export interface DeviceListItem {
  id: string;
  label: string;
  state: "pending" | "active";
  /** The check number, while pending (what the owner compares before Confirm). */
  check: string | null;
  createdAt: string;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
  /** Active and expiring within NATIVE_DEVICE_WARN_DAYS: re-pair soon. */
  expiresSoon: boolean;
}

/** Settings → Devices: the account's pending and active devices, live; never a revoked or expired one. */
export async function listDevices(db: Db, userId: string, now: string): Promise<DeviceListItem[]> {
  const rows = await db
    .select()
    .from(nativeDevices)
    .where(and(eq(nativeDevices.userId, userId), ne(nativeDevices.state, "revoked"), gt(nativeDevices.expiresAt, now)))
    .orderBy(asc(nativeDevices.createdAt), asc(nativeDevices.id));
  const warnFrom = at(now, NATIVE_DEVICE_WARN_DAYS * DAY_MS);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    state: r.state === "active" ? "active" : "pending",
    check: r.state === "pending" ? r.checkNumber : null,
    createdAt: r.createdAt,
    confirmedAt: r.confirmedAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    expiresSoon: r.state === "active" && r.expiresAt <= warnFrom,
  }));
}

export type RevokeReason = "owner" | "owner_all" | "sign_out";

/** Revoke one device of the account: true when this revoked it, false when it already was, null when it isn't theirs. */
export async function revokeDevice(db: Db, userId: string, id: string, now: string, reason: RevokeReason): Promise<boolean | null> {
  const [done] = await db
    .update(nativeDevices)
    .set({ state: "revoked", revokedAt: now, revokedReason: reason })
    .where(and(eq(nativeDevices.id, id), eq(nativeDevices.userId, userId), ne(nativeDevices.state, "revoked")))
    .returning({ id: nativeDevices.id });
  if (done) return true;
  const [row] = await db.select({ id: nativeDevices.id }).from(nativeDevices).where(and(eq(nativeDevices.id, id), eq(nativeDevices.userId, userId)));
  return row ? false : null;
}

/** Revoke all (the instant kill from the laptop): every device of the account not revoked yet. How many it revoked. */
export async function revokeAllDevices(db: Db, userId: string, now: string): Promise<number> {
  const done = await db
    .update(nativeDevices)
    .set({ state: "revoked", revokedAt: now, revokedReason: "owner_all" })
    .where(and(eq(nativeDevices.userId, userId), ne(nativeDevices.state, "revoked")))
    .returning({ id: nativeDevices.id });
  return done.length;
}

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
