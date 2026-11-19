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
 *   POST /devices/:id/reduce        {scope} → that ACTIVE device moved one rung down, v4 → v3 or v3 → v2, in place (review
 *                                   r-m4: an undo, a rollback without Revoke; never below v2, r2-m2): {ok, scope, reduced}; 409 the
 *                                   device's state, or `not_previous_scope` {scope, previous} (v2 → v1 among them:
 *                                   Revoke stops plan edits); 400 `invalid_reduce`; 404 as the grant. It answers while
 *                                   device sign-in is off, as Revoke does
 *   POST /devices/revoke-all        every device of the account revoked (the instant kill)
 *
 * The phone:
 *   POST /pair                      unauthenticated, {code, label} → {token, check, state: "pending", confirmBy}; every
 *                                   failure alike is 401 `pair_failed`. The LifeOS QA account's code (services/qa-account.ts)
 *                                   answers the same, but its phone is active at once (the owner's QA mint was its
 *                                   consent): its first `/me` says paired
 *   POST /sign-out                  its device token: its own row revoked
 *   GET  /me                        {userId, device: {label, expiresAt, scope}} (§10.4, trimmed on the server)
 *   GET  /today                     {today, sessions}: the day's training rows only (§10.4), each saying whether the phone
 *                                   can open it (`written`) and its document's revision (`docRev`; kit v0.10)
 *   GET  /days?from&to              a `training-v4` phone's days (DESIGN-2c §2.1): at most 14, within today − 90 … + 14
 *   GET  /history?before&limit      …its record (§2.2): a page of whole days, newest first, back one year
 *   GET  /sessions/:id/ahead        …*What's in it* for one session on a later day (§2.3), built in memory, never stored
 *                                   The three write nothing, answer `no-store`, and 503 `restore_in_progress` (retryable)
 *                                   while a restore replaces the account. The cookie reads them too
 *
 * The kill switch (`NATIVE_DEVICES`, a secret): unless it is "1", minting, redeeming, confirming and granting are 404 —
 * the device list, revocation and the step-down answer either way, so the owner can always see, narrow and stop a device,
 * and nothing widens one while device sign-in is off.
 *
 * Rate controls (auth/native-devices.ts, kit v0.5): redeeming is bounded per client and in all (past a bound, the same
 * 401 `pair_failed`, never evaluated); minting is bounded per account (429 `too_many_codes` with `retryAfter` seconds);
 * Confirm's wrong check numbers revoke the pending phone at CONFIRM_MAX_WRONG (409 `check_mismatch`, `revoked: true`).
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { plannedWorkouts, programs } from "@rg/database";
import { addDays, daysBetween, isLocalDate, nowInstant, todayInZone } from "@rg/domain";
import { nativeDevicesEnabled } from "../env.js";
import { restoreInProgress } from "../services/account-state.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { unwrittenCourseOutline } from "../services/course-sessions.js";
import { HISTORY_DAYS, HISTORY_LIMIT_MAX, historyPage } from "../services/history.js";
import { corosReadAt, deviceDays, matchesOfRows, readExtraActivities, readPlanRows, shownRows } from "../services/plan-days.js";
import { DocTooLargeRefusal, NoDocumentError, NotAheadError, previewAhead, SessionNotFoundError } from "../services/session-build.js";
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
  reduceScope,
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
  // Always `pending` on the wire: the phone's contract (LifeOS takes no other answer) is to ask `/me` how it stands, and the
  // LifeOS QA account's phone (services/qa-account.ts), active at once, hears "paired" there on its next read.
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
  const scope = scopeNamed(await c.req.json().catch(() => null));
  if (scope === null) return c.json({ error: "invalid_grant" }, 400);
  const outcome = await grantNextScope(c.get("db"), c.get("userId"), c.req.param("id"), scope, nowInstant());
  if (outcome.ok) return c.json({ ok: true, scope: outcome.scope, granted: outcome.granted });
  if (outcome.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (outcome.error === "not_next_scope") return c.json({ error: outcome.error, scope: outcome.scope, next: outcome.next }, 409);
  return c.json({ error: outcome.error }, 409);
});

/**
 * The laptop's step-down (review r-m4): Settings → Devices moves one active phone of the account one scope down, named in
 * the body — `{scope}` and nothing else (auth/native-devices.ts `reduceScope`). Cookie only. Not behind the switch: like
 * Revoke, the owner can always narrow a phone, and narrowing never widens one.
 */
nativeRoutes.post("/devices/:id/reduce", requireUser, cookieOnly, async (c) => {
  const scope = scopeNamed(await c.req.json().catch(() => null));
  if (scope === null) return c.json({ error: "invalid_reduce" }, 400);
  const outcome = await reduceScope(c.get("db"), c.get("userId"), c.req.param("id"), scope, nowInstant());
  if (outcome.ok) return c.json({ ok: true, scope: outcome.scope, reduced: outcome.reduced });
  if (outcome.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (outcome.error === "not_previous_scope") return c.json({ error: outcome.error, scope: outcome.scope, previous: outcome.previous }, 409);
  return c.json({ error: outcome.error }, 409);
});

/** The scope a grant or a step-down names: a body of exactly `{scope: <string>}`, else null. */
function scopeNamed(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1) return null;
  const scope = (body as { scope?: unknown }).scope;
  return typeof scope === "string" ? scope : null;
}

/**
 * The phone's account read (§10.4), in place of `/api/auth/me`: who it is signed in as, and its own label, expiry and
 * scope — what it may reach NOW (stage 2 DESIGN §5.1, additive; the row's scope as this request read it, so a laptop grant
 * shows here on the next read), so the phone offers only that: a `training-slice-v1` phone plays and saves; a
 * `training-v2` one also moves, skips and puts back; a `training-v3` one also fits a session to the day and records the
 * review's feedback; a `training-v4` one also reads its plan and history. It informs the phone's UI; every request is
 * judged by the server again. No email, connections or
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

// ── Stage 2c's plan reads (kit v0.16, DESIGN-2c §2): a `training-v4` device's, or the cookie's ────────────────────────
//
// Each is a READ: it writes nothing — no outline, build, preview, block, check, garden, reconcile, match, provider job,
// audit or note, and no `waitUntil` at all; the one write is the gate's own last use, at most hourly, as for every device
// request, and nothing moves a device's expiry. Each answers `Cache-Control: no-store`, and 503 while a restore is
// replacing the account (`restoring`): a device's GET otherwise reads during a restore (the gate's 423 is for writes only),
// and a half-restored account must never be read as the plan. The gate holds each to its query rule's shape
// (device-scope.ts); the route checks the values — real dates, the bounds — with 400. Dates are the account's, never the
// phone's.

/**
 * The three reads' answer while a restore replaces the account: 503, `restore_in_progress` (the plan read's own word), and
 * `retryable: true` — the phone keeps what it has and asks again later (the lead's v0.17 ruling). Checked before any read
 * of the account's rows.
 */
const restoring = (c: Context<AppContext>) => c.json({ error: "restore_in_progress", retryable: true }, 503);

/** `/days`: at most this many days a request (§2.1). */
export const DAYS_WINDOW_MAX = 14;
/** `/days`: the earliest day, back from the account's today (LifeOS's 90-day backfill, plus one day for a phone's other day). */
export const DAYS_BACK = 90;
/** `/days`: the latest day, ahead of the account's today (*Coming up*'s 14 days, plus the same day of slack). */
export const DAYS_AHEAD = 14;

/**
 * `GET /days?from&to` (§2.1): the account's days `from`…`to`, each once, in order — its tense against the account's today,
 * whether a rest row is planned, its live training sessions (as stored, with how each was done, its kind, *What's in it*'s
 * basis and what the plan routes would take now) and its extra sessions (a run, lift or yoga session that completed no
 * planned workout, listed on a day gone or today; never as answering a session). `corosReadAt` says how current a day's
 * activities can be. 400 `bad_range` for a malformed window or more than 14 days; 400 `out_of_horizon` `{today, earliest,
 * latest}` outside today − 90 … today + 14 — refused, never clamped, so an answer is always whole.
 *
 * WHAT IT COSTS: 7 statements past nothing — the gate, the restore check, the preferences, the rows (the plan's kind and
 * "under way" joined in), the standing matches of the rows shown (one more for each further chunk of 90), the extras
 * (bounded by `start_time`) and `corosReadAt` (native-days.test.ts).
 */
nativeRoutes.get("/days", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isLocalDate(from) || !isLocalDate(to) || to < from || daysBetween(from, to) + 1 > DAYS_WINDOW_MAX) return c.json({ error: "bad_range" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  const earliest = addDays(today, -DAYS_BACK);
  const latest = addDays(today, DAYS_AHEAD);
  if (from < earliest || to > latest) return c.json({ error: "out_of_horizon", today, earliest, latest }, 400);
  const readAt = nowInstant();
  const [rows, acts, coros] = await Promise.all([readPlanRows(db, userId, from, to), readExtraActivities(db, userId, from, to), corosReadAt(db, userId)]);
  const matches = await matchesOfRows(db, userId, shownRows(rows, from, to));
  return c.json({ version: 1, today, readAt, corosReadAt: coros, days: deviceDays(rows, matches, acts, from, to, today) });
});

/** A page's size as the route takes it: 1–30 (the gate lets 1–99 through). */
const LIMIT = /^[1-9]\d?$/;

/**
 * `GET /history?before&limit` (§2.2, services/history.ts): the account's record, newest first, a page of whole days whose
 * rows reach `limit` (1–30, default 30), dated strictly before `before` (default the account's tomorrow, so today is in it)
 * and no older than a year: app sessions with their sets, moves and note, COROS runs on the plan and off it (`extra`), the
 * standalone tool's imports, and sessions the athlete said were done. `next` is the next page's `before`, null at the end
 * of the year. 400 `bad_range` for a `before` that isn't a date, 400 `bad_limit` for a size outside 1–30, 400
 * `out_of_horizon` `{today, earliest}` for a `before` a year back or more.
 */
nativeRoutes.get("/history", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const asked = c.req.query("before");
  const size = c.req.query("limit");
  if (asked !== undefined && !isLocalDate(asked)) return c.json({ error: "bad_range" }, 400);
  const limit = size === undefined ? HISTORY_LIMIT_MAX : LIMIT.test(size) ? Number(size) : 0;
  if (limit < 1 || limit > HISTORY_LIMIT_MAX) return c.json({ error: "bad_limit" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const earliest = addDays(today, -HISTORY_DAYS);
  const before = asked ?? addDays(today, 1);
  if (before <= earliest) return c.json({ error: "out_of_horizon", today, earliest }, 400);
  const readAt = nowInstant();
  const [page, coros] = await Promise.all([historyPage(db, userId, { before, limit, earliest, unit: prefs.weightUnit }), corosReadAt(db, userId)]);
  return c.json({ version: 1, today, readAt, corosReadAt: coros, rows: page.rows, next: page.next, capped: page.capped });
});

/**
 * `GET /sessions/:id/ahead` (§2.3, session-build.ts `previewAhead`): *What's in it* for one session on a later day — its
 * document, the engine's build of it, its course's next session, or its stages — built in memory, never stored, read only
 * when the person opens its details. 409 `not_ahead` `{date, today}` for a session today or past (today's is the Open
 * path's, a past one History's); 404 `not_found` for a row that isn't the account's, archived, or a rest row; 409
 * `no_document` as Build answers it.
 */
nativeRoutes.get("/sessions/:id/ahead", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  try {
    return c.json(await previewAhead(db, userId, c.req.param("id") ?? "", { today, now: nowInstant(), prefs }));
  } catch (e) {
    if (e instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
    if (e instanceof NotAheadError) return c.json({ error: "not_ahead", date: e.date, today: e.today }, 409);
    if (e instanceof NoDocumentError) return c.json({ error: "no_document" }, 409);
    if (e instanceof DocTooLargeRefusal) return c.json({ error: "too_large" }, 409);
    throw e;
  }
});

nativeRoutes.post("/sign-out", requireUser, async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 400);
  await revokeDevice(c.get("db"), c.get("userId"), device.id, nowInstant(), "sign_out");
  return c.json({ ok: true });
});
