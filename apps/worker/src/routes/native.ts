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
 *   POST /devices/:id/grant         {scope} → that ACTIVE device moved to its next scope, in place (kit v0.15): {ok, scope,
 *                                   granted} — `granted: false` when it holds it already; 409 `device_revoked`,
 *                                   `device_expired`, `device_pending`, or `not_next_scope` {scope, next}; 400
 *                                   `invalid_grant`; 404 for a device that isn't the account's
 *   POST /devices/revoke-all        every device of the account revoked (the instant kill)
 *
 * The phone:
 *   POST /pair                      unauthenticated, {code, label} → {token, check, state: "pending", confirmBy}; every
 *                                   failure alike is 401 `pair_failed`
 *   POST /sign-out                  its device token: its own row revoked
 *   GET  /me                        {userId, device: {label, expiresAt, scope}} (§10.4, trimmed on the server)
 *   GET  /today                     {today, sessions}: the day's training rows only (§10.4), each saying whether the phone
 *                                   can open it (`written`) and its document's revision (`docRev`; kit v0.10)
 *
 * The kill switch (`NATIVE_DEVICES`, a secret): unless it is "1", minting, redeeming, confirming and granting are 404 —
 * the device list and revocation answer either way, so the owner can always see and stop a device, and nothing widens one
 * while device sign-in is off.
 *
 * Rate controls (auth/native-devices.ts, kit v0.5): redeeming is bounded per client and in all (past a bound, the same
 * 401 `pair_failed`, never evaluated); minting is bounded per account (429 `too_many_codes` with `retryAfter` seconds);
 * Confirm's wrong check numbers revoke the pending phone at CONFIRM_MAX_WRONG (409 `check_mismatch`, `revoked: true`).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { plannedWorkouts, programs } from "@rg/database";
import { nowInstant, todayInZone } from "@rg/domain";
import { nativeDevicesEnabled } from "../env.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { unwrittenCourseOutline } from "../services/course-sessions.js";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { PAIRING_SCOPE } from "../auth/device-scope.js";
import {
  confirmDevice,
  grantNextScope,
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
  // The owner's own laptop, signed in: told plainly when to try again (MINTS_PER_WINDOW).
  if ("refused" in minted) return c.json({ error: "too_many_codes", retryAfter: minted.retryAfterSeconds }, 429);
  // `scope`: what a phone paired with this code will be able to do, so the laptop says so beside the code.
  return c.json({ ...minted, scope: PAIRING_SCOPE });
});

nativeRoutes.post("/pair", pairingOn, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; label?: unknown } | null;
  const label = labelOf(body?.label);
  if (!body || typeof body.code !== "string" || body.code.length > 64 || !label) return c.json({ error: "invalid_pair" }, 400);
  // The client's address as Cloudflare's edge sets it (a client can't): the per-client bound's key, kept only hashed.
  const paired = await redeemPairing(c.get("db"), c.env, { code: body.code, label }, nowInstant(), c.req.header("cf-connecting-ip"));
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
  // The CONFIRM_MAX_WRONG-th wrong number revoked the phone: the laptop says so, and to pair again.
  return c.json({ error: outcome.error, ...(outcome.revoked ? { revoked: true } : {}) }, outcome.error === "not_found" ? 404 : 409);
});

nativeRoutes.post("/devices/:id/revoke", requireUser, cookieOnly, async (c) => {
  const revoked = await revokeDevice(c.get("db"), c.get("userId"), c.req.param("id"), nowInstant(), "owner");
  if (revoked === null) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, revoked });
});

/**
 * The laptop's grant (kit v0.15): Settings → Devices moves one active phone of the account to its next scope, named in the
 * body — `{scope}` and nothing else — so a resend or a double click grants nothing twice (auth/native-devices.ts
 * `grantNextScope`). Cookie only, and only while device sign-in is on.
 */
nativeRoutes.post("/devices/:id/grant", pairingOn, requireUser, cookieOnly, async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  const scope = typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { scope?: unknown }).scope : undefined;
  if (typeof scope !== "string") return c.json({ error: "invalid_grant" }, 400);
  const outcome = await grantNextScope(c.get("db"), c.get("userId"), c.req.param("id"), scope, nowInstant());
  if (outcome.ok) return c.json({ ok: true, scope: outcome.scope, granted: outcome.granted });
  if (outcome.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (outcome.error === "not_next_scope") return c.json({ error: outcome.error, scope: outcome.scope, next: outcome.next }, 409);
  return c.json({ error: outcome.error }, 409);
});

/**
 * The phone's account read (§10.4), in place of `/api/auth/me`: who it is signed in as, and its own label, expiry and
 * scope — what it may reach NOW (stage 2 DESIGN §5.1, additive; the row's scope as this request read it, so a laptop grant
 * shows here on the next read), so the phone offers only that: a `training-slice-v1` phone plays and saves; a
 * `training-v2` one also moves, skips and puts back; a `training-v3` one also fits a session to the day and records the
 * review's feedback. It informs the phone's UI; every request is judged by the server again. No email, connections or
 * restore state. A cookie gets `device: null`.
 */
nativeRoutes.get("/me", requireUser, async (c) => {
  const device = c.get("device");
  return c.json({ userId: c.get("userId"), device: device ? { label: device.label, expiresAt: device.expiresAt, scope: device.scope } : null });
});

/** A planned time, `HH:MM`. */
const TIME = /^\d{2}:\d{2}$/;

/**
 * The phone's day (§10.4), in place of `/api/plan/today`: only the day's training rows — id, title, sport, category,
 * date, time and state (`completionState`) — on the account's own clock. Rest rows and removed rows are not training;
 * no sleep, readiness, coach text, garden, email or connections, none of which is read. Timed rows by time, then untimed.
 *
 * Two more fields on each row (the phone's read contract, kit v0.10), every other as it was:
 *  - `written`: false only for an UNWRITTEN COURSE OUTLINE (`unwrittenCourseOutline`: a programme's row with nothing on it
 *    whose plan is a course), due today or not — the rows a device's `GET /api/sessions/:id` and its review basis refuse 409
 *    `not_written`, and the only rows a web opening writes. True for every other row: a Studio or template workout, a
 *    course's session already written, an engine programme slot (its opening reads; its build is the sheet's own Build),
 *    an outline whose plan is gone, and a row that is no app session (an import's run, the coach's), which the session
 *    routes answer 404 as before. Advice only: the session routes decide again from the row as it then stands.
 *  - `docRev`: the row's document revision while it holds a document, else null (a revived outline keeps the number its
 *    next write goes past, and holds no document). Read without the document's bytes.
 * One statement still: the plan's kind is joined in.
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
      origin: plannedWorkouts.origin,
      contentState: plannedWorkouts.contentState,
      planKind: programs.kind,
      docRev: sql<number | null>`case when ${plannedWorkouts.workoutDoc} is not null then ${plannedWorkouts.workoutDocRev} end`,
    })
    .from(plannedWorkouts)
    // `courseOf`'s read of the plan: this account's plan by the row's plan id.
    .leftJoin(programs, and(eq(programs.id, plannedWorkouts.planId), eq(programs.userId, plannedWorkouts.userId)))
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
        ne(plannedWorkouts.category, "rest"),
      ),
    );
  const sessions = rows
    .map(({ origin, contentState, planKind, docRev, ...r }) => ({
      ...r,
      time: TIME.test(r.time) ? r.time : null,
      written: !unwrittenCourseOutline({ origin, contentState }, planKind),
      docRev: docRev ?? null,
    }))
    .sort((a, b) => (a.time === null) !== (b.time === null) ? (a.time === null ? 1 : -1) : (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
  return c.json({ today, sessions });
});

nativeRoutes.post("/sign-out", requireUser, async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 400);
  await revokeDevice(c.get("db"), c.get("userId"), device.id, nowInstant(), "sign_out");
  return c.json({ ok: true });
});
