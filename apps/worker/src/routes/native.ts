/**
 * `/api/native` — native device sign-in (the LifeOS migration's SLICE-CONTRACT revision 2, §10). Not `/api/devices/*`:
 * that is the deleted desktop bridge's 410.
 *
 * Laptop web, the session cookie only (a device token is refused 403 `out_of_scope` by `requireUser`'s list, and again
 * here):
 *   POST /pairings                  mint the account's one pairing code (a new one burns the old): {code, expiresAt}
 *   GET  /devices                   {enabled, devices}: the pending and active devices, live
 *   POST /devices/:id/confirm       {check} → the pending device active, for NATIVE_DEVICE_LIFETIME_DAYS
 *   POST /devices/:id/revoke        that device revoked, at once
 *   POST /devices/revoke-all        every device of the account revoked (the instant kill)
 *
 * The phone:
 *   POST /pair                      unauthenticated, {code, label} → {token, check, state: "pending", confirmBy}; every
 *                                   failure alike is 401 `pair_failed`
 *   POST /sign-out                  its device token: its own row revoked
 *   GET  /me                        {userId, device: {label, expiresAt}} (§10.4, trimmed on the server)
 *   GET  /today                     {today, sessions}: the day's training rows only (§10.4)
 *
 * The kill switch (`NATIVE_DEVICES`, a secret): unless it is "1", minting, redeeming and confirming are 404 — the
 * device list and revocation answer either way, so the owner can always see and stop a device.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { and, eq, isNull, ne } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { nowInstant, todayInZone } from "@rg/domain";
import { nativeDevicesEnabled } from "../env.js";
import { loadPreferences } from "../services/calendar-sync.js";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import {
  confirmDevice,
  isOwnerEmail,
  listDevices,
  mintPairing,
  redeemPairing,
  revokeAllDevices,
  revokeDevice,
} from "../auth/native-devices.js";

export const nativeRoutes = new Hono<AppContext>();

/** Pairing exists only while the switch is on. */
const pairingOn: MiddlewareHandler<AppContext> = async (c, next) =>
  nativeDevicesEnabled(c.env) ? next() : c.json({ error: "not_found" }, 404);

/** Device management is the laptop's: a request a device token signed in never reaches it. */
const cookieOnly: MiddlewareHandler<AppContext> = async (c, next) =>
  c.get("device") ? c.json({ error: "out_of_scope" }, 403) : next();

/** A label the phone names itself by: 1 to 60 characters, no control characters. */
const labelOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const label = v.trim();
  // eslint-disable-next-line no-control-regex
  return label.length >= 1 && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
};

nativeRoutes.post("/pairings", pairingOn, requireUser, cookieOnly, async (c) => {
  if (!isOwnerEmail(c.get("userEmail"), c.env)) return c.json({ error: "not_owner" }, 403);
  const minted = await mintPairing(c.get("db"), c.env, c.get("userId"), nowInstant());
  c.header("Cache-Control", "no-store");
  return c.json(minted);
});

nativeRoutes.post("/pair", pairingOn, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; label?: unknown } | null;
  const label = labelOf(body?.label);
  if (!body || typeof body.code !== "string" || body.code.length > 64 || !label) return c.json({ error: "invalid_pair" }, 400);
  const paired = await redeemPairing(c.get("db"), c.env, { code: body.code, label }, nowInstant());
  c.header("Cache-Control", "no-store");
  if (!paired) return c.json({ error: "pair_failed" }, 401);
  return c.json({ token: paired.token, check: paired.check, state: "pending", confirmBy: paired.confirmBy });
});

nativeRoutes.get("/devices", requireUser, cookieOnly, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ enabled: nativeDevicesEnabled(c.env), devices: await listDevices(c.get("db"), c.get("userId"), nowInstant()) });
});

nativeRoutes.post("/devices/revoke-all", requireUser, cookieOnly, async (c) => {
  return c.json({ ok: true, revoked: await revokeAllDevices(c.get("db"), c.get("userId"), nowInstant()) });
});

nativeRoutes.post("/devices/:id/confirm", pairingOn, requireUser, cookieOnly, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { check?: unknown } | null;
  if (typeof body?.check !== "string" || !/^\d{4}$/.test(body.check)) return c.json({ error: "invalid_confirm" }, 400);
  const outcome = await confirmDevice(c.get("db"), c.get("userId"), c.req.param("id"), body.check, nowInstant());
  if (outcome.ok) return c.json({ ok: true, expiresAt: outcome.expiresAt });
  return c.json({ error: outcome.error }, outcome.error === "not_found" ? 404 : 409);
});

nativeRoutes.post("/devices/:id/revoke", requireUser, cookieOnly, async (c) => {
  const revoked = await revokeDevice(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant(), "owner");
  if (revoked === null) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, revoked });
});

/**
 * The phone's account read (§10.4), in place of `/api/auth/me`: who it is signed in as, and its own label and expiry.
 * No email, connections or restore state. A cookie gets `device: null`.
 */
nativeRoutes.get("/me", requireUser, async (c) => {
  const device = c.get("device");
  return c.json({ userId: c.get("userId"), device: device ? { label: device.label, expiresAt: device.expiresAt } : null });
});

/** A planned time, `HH:MM`. */
const TIME = /^\d{2}:\d{2}$/;

/**
 * The phone's day (§10.4), in place of `/api/plan/today`: only the day's training rows — id, title, sport, category,
 * date, time and state (`completionState`) — on the account's own clock. Rest rows and removed rows are not training;
 * no sleep, readiness, coach text, garden, email or connections, none of which is read. Timed rows by time, then untimed.
 */
nativeRoutes.get("/today", requireUser, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  const rows = await db
    .select({
      id: plannedWorkouts.id,
      title: plannedWorkouts.title,
      sport: plannedWorkouts.sport,
      category: plannedWorkouts.category,
      date: plannedWorkouts.effectiveDate,
      time: plannedWorkouts.effectiveTime,
      state: plannedWorkouts.completionState,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
        ne(plannedWorkouts.category, "rest"),
      ),
    );
  const sessions = rows
    .map((r) => ({ ...r, time: TIME.test(r.time) ? r.time : null }))
    .sort((a, b) => (a.time === null) !== (b.time === null) ? (a.time === null ? 1 : -1) : (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
  return c.json({ today, sessions });
});

nativeRoutes.post("/sign-out", requireUser, async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 400);
  await revokeDevice(c.get("db"), c.get("userId"), device.id, nowInstant(), "sign_out");
  return c.json({ ok: true });
});
