/**
 * NATIVE DEVICE SIGN-IN (the LifeOS migration's SLICE-CONTRACT revision 2, §10): a phone paired from signed-in laptop
 * web holds a device token, `rgd_` and 32 random bytes, in its Keychain. The Worker keeps only the token's SHA-256
 * (`native_devices.id`), and the pairing code only as an HMAC (`native_pairings`).
 */
import { and, asc, eq, gt, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { nativeDevices, nativePairings, nativePairLimits, users } from "@rg/database";
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

/**
 * PAIRING'S RATE CONTROLS (kit v0.5). The code's own PAIRING_MAX_TRIES bounds guesses at one live code; these bound the
 * rest — guesses with no code live or of codes that don't exist, minting again and again, and wrong check numbers:
 *
 *  - REDEEM (unauthenticated): at most PAIR_FAILS_PER_IP failed attempts from one client and PAIR_FAILS_GLOBAL in all —
 *    one owner, one deployment — per fixed PAIR_WINDOW_MS window (so up to twice that across a window's edge). A client is
 *    its `CF-Connecting-IP` (which Cloudflare's edge sets), an IPv6 one its /64, kept only as an HMAC under SESSION_SECRET.
 *    Past either bound, every redeem gets the same 401 `pair_failed`, the right code included, and is not evaluated — the
 *    live code's tries are untouched — until the window ends, and for at least PAIR_COOL_OFF_MS: tripping a bound on
 *    purpose never buys a new allowance early (review F1). A new code from the laptop lifts every redeem throttle at
 *    once: the owner's recovery is Pair again.
 *  - MINT (cookie): MINTS_PER_WINDOW codes per account per MINT_WINDOW_MS, then 429 `too_many_codes` for MINT_COOL_OFF_MS.
 *  - CONFIRM (cookie): the CONFIRM_MAX_WRONG-th wrong check number revokes the pending phone (`check_failed`).
 */
export const PAIR_WINDOW_MS = 10 * 60_000;
export const PAIR_FAILS_PER_IP = 3;
export const PAIR_FAILS_GLOBAL = 10;
export const PAIR_COOL_OFF_MS = 2 * 60_000;
export const MINT_WINDOW_MS = 10 * 60_000;
export const MINTS_PER_WINDOW = 5;
export const MINT_COOL_OFF_MS = 10 * 60_000;
export const CONFIRM_MAX_WRONG = 3;

const DAY_MS = 86_400_000;
const at = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();

/** The client key's HMAC label (under SESSION_SECRET): a key, never the address, and not recoverable without the secret. */
const CLIENT_LABEL = "run-garden native pairing client v2";
const GLOBAL_REDEEM_KEY = "redeem:global";
const REDEEM_KEYS = "redeem:%";

interface Bound {
  limit: number;
  windowMs: number;
  coolOffMs: number;
}
const PER_IP: Bound = { limit: PAIR_FAILS_PER_IP, windowMs: PAIR_WINDOW_MS, coolOffMs: PAIR_COOL_OFF_MS };
const GLOBAL: Bound = { limit: PAIR_FAILS_GLOBAL, windowMs: PAIR_WINDOW_MS, coolOffMs: PAIR_COOL_OFF_MS };
const MINTS: Bound = { limit: MINTS_PER_WINDOW, windowMs: MINT_WINDOW_MS, coolOffMs: MINT_COOL_OFF_MS };

/**
 * Count one attempt against `key`, BEFORE it is evaluated, in ONE statement (an upsert … RETURNING): however many
 * requests arrive at once, at most `limit` are allowed per window. Throttled: unchanged, refused (attempts during it
 * don't extend it). Throttle over, or the window past: a fresh window, this attempt its first. Otherwise one more; the
 * one past `limit` is refused and throttles the key until the WINDOW's end — the row's `expires_at`, which is its window
 * start plus the window while it counts — and for at least the cool-off (review F1: ending at the cool-off gave a new
 * allowance every cool-off). Answers whether this attempt may go on, and until when it may not.
 */
async function countAttempt(db: Db, key: string, now: string, b: Bound): Promise<{ allowed: boolean; blockedUntil: string | null }> {
  const t = nativePairLimits;
  const windowFrom = at(now, -b.windowMs);
  const coolUntil = at(now, b.coolOffMs);
  const windowEnd = at(now, b.windowMs);
  const blocked = sql`(${t.blockedUntil} is not null and ${t.blockedUntil} > ${now})`;
  const fresh = sql`(${t.blockedUntil} is not null or ${t.windowStart} <= ${windowFrom})`;
  const crosses = sql`(${t.count} + 1 > ${b.limit})`;
  /** The throttle's end: the window's (`expires_at` while it counts), and not before the cool-off's. */
  const throttleEnd = sql`max(${t.expiresAt}, ${coolUntil})`;
  const [row] = await db
    .insert(t)
    .values({ key, windowStart: now, count: 1, blockedUntil: null, expiresAt: windowEnd })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        windowStart: sql`case when ${blocked} then ${t.windowStart} when ${fresh} then ${now} else ${t.windowStart} end`,
        count: sql`case when ${blocked} then ${t.count} when ${fresh} then 1 else ${t.count} + 1 end`,
        blockedUntil: sql`case when ${blocked} then ${t.blockedUntil} when ${fresh} then null when ${crosses} then ${throttleEnd} else null end`,
        expiresAt: sql`case when ${blocked} then ${t.expiresAt} when ${fresh} then ${windowEnd} when ${crosses} then ${throttleEnd} else ${t.expiresAt} end`,
      },
    })
    .returning({ blockedUntil: t.blockedUntil });
  const blockedUntil = row?.blockedUntil ?? null;
  return { allowed: !(blockedUntil !== null && blockedUntil > now), blockedUntil };
}

/** Whether `key` is throttled now: a read, writing nothing (the global bound's first look, review F3). */
async function throttledNow(db: Db, key: string, now: string): Promise<boolean> {
  const t = nativePairLimits;
  const [row] = await db.select({ blockedUntil: t.blockedUntil }).from(t).where(eq(t.key, key)).limit(1);
  return row?.blockedUntil != null && row.blockedUntil > now;
}

/** A success gives its attempt back (only outside a cool-off): the bounds count failures. */
async function refundAttempt(db: Db, key: string): Promise<void> {
  const t = nativePairLimits;
  await db
    .update(t)
    .set({ count: sql`${t.count} - 1` })
    .where(and(eq(t.key, key), isNull(t.blockedUntil), gt(t.count, 0)));
}

/**
 * The network a client address counts as (review F3): an IPv4 address as it is; an IPv6 one by its /64 — one subscriber's
 * allocation, so a client can't step around its bound by changing the address's low bits — however it is written
 * (compressed or not, any case, bracketed, with a zone); an IPv4-mapped IPv6 address as its IPv4. Anything that doesn't
 * parse counts as itself.
 */
export function clientNetwork(address: string): string {
  let a = address.trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.includes("]") ? a.indexOf("]") : undefined);
  if (a.includes("%")) a = a.slice(0, a.indexOf("%"));
  if (!a.includes(":")) return a;
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const last = halves.length === 2 ? tail : head;
  if (last.length > 0 && last[last.length - 1]!.includes(".")) {
    const octets = last.pop()!.split(".").map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255))) return a;
    last.push(((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return a;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  const full = groups.map((g) => g.padStart(4, "0"));
  if (full.slice(0, 5).every((g) => g === "0000") && full[5] === "ffff") {
    const hi = parseInt(full[6]!, 16);
    const lo = parseInt(full[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${full.slice(0, 4).join(":")}::/64`;
}

/**
 * The client's key: an HMAC of its network under SESSION_SECRET, labelled (review F4: an unkeyed hash of an IPv4
 * address can be reversed by trying all 2^32). Null when the worker can't see an address.
 */
async function clientKey(secret: string, clientIp: string | null | undefined): Promise<string | null> {
  const address = (clientIp ?? "").trim();
  return address ? `redeem:ip:${await hmacSha256Hex(secret, `${CLIENT_LABEL}\n${clientNetwork(address)}`)}` : null;
}

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

/**
 * Minting (laptop web): a new code for the account, replacing (burning) any code it had, in one statement — at most
 * MINTS_PER_WINDOW per MINT_WINDOW_MS, counted before anything is written; past it, nothing changes and the answer says
 * when to try again. A new code also lifts every redeem throttle: the owner's recovery is one action, Pair again. That
 * gives a guesser nothing — it can't mint (cookie only, and bounded here), and each code still takes at most
 * PAIRING_MAX_TRIES wrong guesses in its PAIRING_CODE_TTL_MS.
 */
export async function mintPairing(
  db: Db,
  env: Env,
  userId: string,
  now: string,
): Promise<{ code: string; expiresAt: string } | { refused: true; retryAfterSeconds: number }> {
  const mints = await countAttempt(db, `mint:${userId}`, now, MINTS);
  if (!mints.allowed) {
    return { refused: true, retryAfterSeconds: Math.ceil((Date.parse(mints.blockedUntil!) - Date.parse(now)) / 1000) };
  }
  const code = newPairingCode();
  const codeHmac = await pairingCodeHmac(env.SESSION_SECRET, userId, code);
  const expiresAt = at(now, PAIRING_CODE_TTL_MS);
  const fresh = { codeHmac, createdAt: now, expiresAt, tries: 0, usedAt: null };
  await db.insert(nativePairings).values({ userId, ...fresh }).onConflictDoUpdate({ target: nativePairings.userId, set: fresh });
  await db.delete(nativePairLimits).where(like(nativePairLimits.key, REDEEM_KEYS));
  return { code, expiresAt };
}

/**
 * Redeeming (the phone, unauthenticated): ONE conditional UPDATE … RETURNING on the owner's live code — unused, unexpired,
 * under its tries. In the same statement a match marks it used and a miss counts one try, so however many requests arrive
 * at once, a code is used once and takes at most PAIRING_MAX_TRIES wrong guesses. A pending device is made only when the
 * UPDATE hands its row back marked used. Null for every failure alike: no owner, no live code, a wrong one — or a
 * throttled client.
 *
 * Before any of that, the attempt is counted, and past a bound it is not evaluated at all — the code's tries are
 * untouched — and answers null like any miss:
 *  1. the global bound, read only: while it throttles, nothing is written, not even for a new client (review F3);
 *  2. the client's count (`clientIp`, when the worker can see one), one atomic upsert;
 *  3. the global count, one atomic upsert; when it refuses, the client's count is given back — an attempt the deployment
 *     refused is not the client's (review F2).
 * A success gives both counts back.
 *
 * THE ANSWER'S TIME IS NOT THE MISS'S (review F6, a known limit): a throttled attempt skips the HMAC and the UPDATE, so
 * it answers measurably sooner than an evaluated miss, with the same bytes. That tells a caller only that it is being
 * throttled — never anything about the code.
 */
export async function redeemPairing(
  db: Db,
  env: Env,
  input: { code: string; label: string },
  now: string,
  clientIp?: string | null,
): Promise<{ token: string; check: string; confirmBy: string } | null> {
  if (await throttledNow(db, GLOBAL_REDEEM_KEY, now)) return null;
  const client = await clientKey(env.SESSION_SECRET, clientIp);
  if (client && !(await countAttempt(db, client, now, PER_IP)).allowed) return null;
  if (!(await countAttempt(db, GLOBAL_REDEEM_KEY, now, GLOBAL)).allowed) {
    if (client) await refundAttempt(db, client);
    return null;
  }
  const paired = await redeemCounted(db, env, input, now);
  if (paired) {
    if (client) await refundAttempt(db, client);
    await refundAttempt(db, GLOBAL_REDEEM_KEY);
  }
  return paired;
}

/** The redemption itself, once the attempt is counted and allowed. */
async function redeemCounted(
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

export type ConfirmOutcome =
  | { ok: true; expiresAt: string }
  | { ok: false; error: "not_found" | "not_pending" | "confirm_expired" | "check_mismatch"; revoked?: true };

/**
 * The owner's Confirm (laptop web): a pending device of theirs, within its window, with its check number → active. ONE
 * conditional UPDATE … RETURNING decides it and counts it: the right number activates the phone; a wrong one counts a
 * try, and the CONFIRM_MAX_WRONG-th revokes the phone (`check_failed`) in that same statement. Once it is not pending no
 * further number is evaluated, so however many arrive at once, at most CONFIRM_MAX_WRONG are tried: a laptop can't be
 * walked through the 10,000 numbers.
 *
 * WHO CAN SEND A WRONG NUMBER (review F7): Confirm is cookie only and names the device by its 64-hex id, and the laptop's
 * own Settings sends the number it lists. So a wrong number comes only from a client holding the owner's cookie and that
 * id; nobody else can revoke the owner's pending phone this way. The bound is defense in depth.
 */
export async function confirmDevice(db: Db, userId: string, id: string, check: string, now: string): Promise<ConfirmOutcome> {
  const expiresAt = at(now, NATIVE_DEVICE_LIFETIME_DAYS * DAY_MS);
  const d = nativeDevices;
  const right = sql`(${d.checkNumber} = ${check})`;
  const lastWrong = sql`(${d.checkTries} + 1 >= ${CONFIRM_MAX_WRONG})`;
  const [decided] = await db
    .update(d)
    .set({
      state: sql`case when ${right} then 'active' when ${lastWrong} then 'revoked' else ${d.state} end`,
      confirmedAt: sql`case when ${right} then ${now} else ${d.confirmedAt} end`,
      expiresAt: sql`case when ${right} then ${expiresAt} else ${d.expiresAt} end`,
      checkTries: sql`case when ${right} then ${d.checkTries} else ${d.checkTries} + 1 end`,
      revokedAt: sql`case when ${right} then ${d.revokedAt} when ${lastWrong} then ${now} else ${d.revokedAt} end`,
      revokedReason: sql`case when ${right} then ${d.revokedReason} when ${lastWrong} then 'check_failed' else ${d.revokedReason} end`,
    })
    .where(and(eq(d.id, id), eq(d.userId, userId), eq(d.state, "pending"), gt(d.expiresAt, now)))
    .returning({ state: d.state });
  if (decided?.state === "active") return { ok: true, expiresAt };
  if (decided?.state === "revoked") return { ok: false, error: "check_mismatch", revoked: true };
  if (decided) return { ok: false, error: "check_mismatch" };
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

/** Why a device was revoked. `check_failed` is set by `confirmDevice` itself, in the statement that counts the try. */
export type RevokeReason = "owner" | "owner_all" | "sign_out";

/**
 * Revoke one device of the account: true when this revoked it, false when it already was, null when it isn't theirs.
 *
 * WHAT A REVOKE STOPS, AND WHAT IT DOESN'T (here and in `revokeAllDevices`). Revocation applies at the authorization
 * boundary: `requireUser`'s device branch (auth/middleware.ts `requireDevice`), which reads the device's row ONCE, before
 * the route's handler runs. Every request whose read comes after this UPDATE committed is refused 401 `device_revoked`
 * (D1 has no read replicas here, so that read sees the commit). A request whose read came before it is already
 * authorized: its handler runs to its end, and whatever it writes — a build, a start, a performed session — lands and
 * stays. Nothing is cancelled or undone after the fact; a save that landed is undone only as any save is (by hand).
 */
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

/** Devices, codes and rate-control counters past their expiry, in any state: gone (the half-hourly cron, beside `purgeExpiredSessions`). */
export async function purgeExpiredNativeRows(db: Db): Promise<void> {
  const now = nowInstant();
  await db.delete(nativeDevices).where(lt(nativeDevices.expiresAt, now));
  await db.delete(nativePairings).where(lt(nativePairings.expiresAt, now));
  await db.delete(nativePairLimits).where(lt(nativePairLimits.expiresAt, now));
}
