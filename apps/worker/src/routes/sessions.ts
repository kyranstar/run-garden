/**
 * `/api/sessions` — a program slot's session, built on its day (Phase 2 spec §2a "Build API") — and
 * `/api/conditions` — the day's condition check (the Today chip).
 *
 *   GET    /api/sessions/:workoutId          the slot, its current build (or none), its day's checks, the lock
 *   GET    /api/sessions/:workoutId/state    {workoutId, contentState}: the slot's state alone (Today's Continue check)
 *   GET    /api/sessions/:workoutId/current  {buildId, current, locked, lockedBy}: is that build still the day's? (no build made)
 *   GET    /api/sessions/:workoutId/review-basis  what the review reads of the history, fetched at Start (a read)
 *   POST   /api/sessions/:workoutId/build    {checks?, overrides?, swaps?} → build, or the stored build when the
 *                                            inputs are unchanged; a day ahead is a preview
 *   POST   /api/sessions/:workoutId/start    {buildId} → lock that build, while it is still the day's; idempotent
 *   POST   /api/sessions/:workoutId/unstart  the player's Discard: back to built, the build unlocked; idempotent
 *   GET    /api/sessions/:workoutId/watch-preview   the steps as the watch will hold them (Phase 3)
 *   POST   /api/sessions/:workoutId/send-to-watch   {buildId, digest} → lock the build (it stays `built`), queue its push
 *   POST   /api/sessions/:workoutId/keep-off-watch  Keep off my watch: the copy off, `watch_off` set (the mirror leaves it off)
 *   POST   /api/sessions/:workoutId/put-on-watch    Put on my watch: `watch_off` cleared, the session owed to the mirror
 *   POST   /api/sessions/:workoutId/take-off-watch  for ONE RELEASE (an older client's Take off): answers as keep-off-watch
 *   POST   /api/sessions/:workoutId/retry-watch     Retry: the session's failed push queued again now (a provisional copy's
 *                                                  as it was; a day build's as Send's Retry), no digest
 *   GET    /api/sessions/:workoutId/watch-review    the quick review after a watch session: its basis (Phase 3)
 *   PUT    /api/sessions/performed/:id       a performed session from the player's outbox, saved exactly once (the app's,
 *                                            or a watch review — `source: "watch_review"`)
 *   POST   /api/conditions/checks            {profileId, value, feelingOff} → the day's check
 *
 * 404 for a slot that is not this user's live app session (a programme's, an on-demand, a Studio or a template row);
 * 409 `not_today` (a day gone, or Start on a day ahead), 409 `locked` with the locked session, 409 `not_built`, 409
 * `stale` with the fresh session (Start named a build the day's inputs no longer make); 422 for an invalid body or a
 * profile that is not switched on. Everything engine-shaped lives in `services/session-build.ts`. A restore in
 * progress is refused (423) by `requireUser` before any write runs.
 *
 * A DOCUMENT WORKOUT (a Studio or template row, Stage 2 spec §10) builds from its document, not the engine: the build
 * carries `fromDoc` (its revision, the day's swaps, what is still blocked). Start and Send re-gate it with the day's
 * reading: 409 `gated` with the validator's `issues` when a move the day keeps out has no alternate to stand in (a
 * swap the reading makes comes back first as `stale`, so the athlete sees it before it locks); 409 `no_document` when
 * its stored document cannot be read; 409 `too_large` with the issue when it is too large to build (a build, a preview,
 * or Start's fresh build).
 *
 * THE WATCH (Phase 3, spec §4, §6). Every session response carries `watch` — null while the switch
 * (`WATCH_PUSH_ENABLED`) is off, so nothing about the watch renders — through one helper, `withWatch`. Off, the three
 * watch routes answer 404, and a PUT of a watch review (`source: "watch_review"`) answers 422, as every session but the
 * app's own did before Phase 3 (audit 3-B S-5). Send answers 409 with the reason it is not offered (`not_today`, `not_built`, `done`,
 * `precheck`, `writes_off`, `not_connected`, `too_long`, `empty`, `taking_off`, `already_sent`), `stale` with the
 * fresh session, or `stale_preview` with the fresh preview (the payload is not the one the athlete was shown). Keep off
 * answers 409 `done` for a session done or otherwise resolved (its copy stays).
 */
import { Hono, type Context } from "hono";
import { z, type ZodError } from "zod";
import { eq } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { nowInstant, sessionModeSchema, todayInZone } from "@rg/domain";
import { watchPushEnabled } from "../env.js";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import {
  buildSessionOutcome,
  DocTooLargeRefusal,
  GatedError,
  loadSession,
  loadSessionState,
  NoDocumentError,
  NotBuiltError,
  NotTodayError,
  PerformedExistsError,
  recordCheck,
  RestoringError,
  sessionCurrency,
  SessionLockedError,
  SessionNotFoundError,
  StaleBuildError,
  startSessionOutcome,
  UnknownProfileError,
  unstartSession,
  type SessionResponse,
} from "../services/session-build.js";
import {
  keepOffWatch,
  putOnWatch,
  retryWatch,
  sendToWatch,
  StalePreviewError,
  watchPreview,
  watchStateOf,
  WatchUnavailableError,
} from "../services/watch-push.js";
import { executeCloudJobs } from "../services/coros-write-cloud.js";
import { queuedWatchJobs } from "../services/jobs.js";
import { mirrorTakesTurn } from "../services/mirror.js";
import { InvalidSaveError, savePerformedSession } from "../services/session-save.js";
import { reviewBasis } from "../services/session-review-basis.js";
import { watchReviewBasis } from "../services/session-watch-review.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { removeAbandonedStartNow } from "../services/doc-workouts.js";

export const sessionRoutes = new Hono<AppContext>();
sessionRoutes.use("*", requireUser);

export const conditionRoutes = new Hono<AppContext>();
conditionRoutes.use("*", requireUser);

const profileId = z.string().min(1).max(60);
const exerciseId = z.string().min(1).max(200);
const checkValue = z.number().int().min(0).max(10).nullable();

const buildSchema = z
  .object({
    checks: z.record(profileId, z.object({ pre: checkValue, feelingOff: z.boolean().default(false) }).strict()).optional(),
    overrides: z
      .object({
        mode: sessionModeSchema.optional(),
        theme: z.string().min(1).max(60).optional(),
        minutes: z.number().int().min(10).max(90).optional(),
        locationId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    swaps: z
      .record(
        z.string().min(1).max(60),
        z.object({ from: exerciseId.nullable().optional(), to: exerciseId.nullable().optional() }).strict().nullable(),
      )
      .refine((s) => Object.keys(s).length <= 100, { message: "too many swaps" })
      .optional(),
  })
  .strict();

/** Start names the build the athlete was shown (audit I3). */
const startSchema = z.object({ buildId: z.string().min(1).max(200) }).strict();

const checkSchema = z
  .object({ profileId, value: checkValue, feelingOff: z.boolean().default(false) })
  .strict();

const invalid = (c: Context<AppContext>, error: ZodError) => c.json({ error: "invalid_build", issues: error.issues }, 422);

/**
 * THE ONE PLACE a session response gets its `watch` (Phase 3): null while the switch is off, else the state the sheet
 * shows. Every route that answers with a session — and every refusal that carries one — goes through here.
 */
async function withWatch(c: Context<AppContext>, session: SessionResponse): Promise<SessionResponse> {
  if (!watchPushEnabled(c.env)) return { ...session, watch: null };
  const db = c.get("db");
  const userId = c.get("userId");
  const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, session.workoutId)).limit(1);
  if (!row || row.userId !== userId) return { ...session, watch: null };
  return { ...session, watch: await watchStateOf(db, c.env, userId, row, session, await loadPreferences(db, userId)) };
}

/** The errors every session route shares, as responses; anything else is rethrown. */
async function refusal(c: Context<AppContext>, e: unknown): Promise<Response> {
  if (e instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof NotTodayError) return c.json({ error: "not_today", date: e.date, today: e.today }, 409);
  if (e instanceof SessionLockedError) return c.json({ error: "locked", session: await withWatch(c, e.session) }, 409);
  if (e instanceof NotBuiltError) return c.json({ error: "not_built" }, 409);
  if (e instanceof GatedError) return c.json({ error: "gated", issues: e.issues }, 409);
  if (e instanceof NoDocumentError) return c.json({ error: "no_document" }, 409);
  if (e instanceof DocTooLargeRefusal) return c.json({ error: "too_large", issues: e.issues }, 409);
  if (e instanceof UnknownProfileError) return c.json({ error: "unknown_profile" }, 422);
  throw e;
}

sessionRoutes.get("/:workoutId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await withWatch(c, await loadSession(db, userId, c.req.param("workoutId"), todayInZone(prefs.timezone))));
  } catch (e) {
    return refusal(c, e);
  }
});

/** The slot's content state alone: Today's check before Continue on a session left in progress (ruling 2b-R18). */
sessionRoutes.get("/:workoutId/state", async (c) => {
  try {
    return c.json(await loadSessionState(c.get("db"), c.get("userId"), c.req.param("workoutId")));
  } catch (e) {
    return refusal(c, e);
  }
});

/** Whether the build the slot shows is still the one its day's inputs make (Start would lock it as it is). */
sessionRoutes.get("/:workoutId/current", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    // With the env: a lock held only for the watch, while the mirror follows the slot, is current only while the day's
    // inputs still make its build (`sessionCurrency`).
    return c.json(await sessionCurrency(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant(), prefs, env: c.env }));
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * What the player's review needs of the history — the records baseline, the graduation basis, the build's moves'
 * saved prefs — fetched once at Start and kept on the device, so the review works offline (session-review-basis.ts).
 */
sessionRoutes.get("/:workoutId/review-basis", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await reviewBasis(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), unit: prefs.weightUnit }));
  } catch (e) {
    return refusal(c, e);
  }
});

sessionRoutes.post("/:workoutId/build", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // No body is an empty request: "build with what the day already holds".
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_build", issues: [{ message: "invalid JSON" }] }, 422);
    }
  }
  const parsed = buildSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  try {
    // With the env, the day's build goes to the mirror (the watch mirrors the plan §3.3): handed over, replaced or pushed.
    const { session, calendarChanged } = await buildSessionOutcome(db, userId, c.req.param("workoutId"), parsed.data, { today, now, prefs, env: c.env });
    // A new build of the day renames and resizes the row: the calendar picks it up through the existing
    // reconciler. A stored build returned unchanged (or a preview) changed nothing it shows.
    if (calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
    return c.json(await withWatch(c, session));
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * The player's Discard (ruling 2b-R9): a started slot back to `built`, its build unlocked — Today offers Start again.
 * 200 with the session (also when it was built already); 409 `performed` once a performed session exists for it; 404
 * for a slot that is not this user's; 423 while a restore runs. A workout started at once (Start now) with nothing
 * logged was never planned: it is removed (`removeAbandonedStartNow`), and the answer says `removed: true`.
 */
sessionRoutes.post("/:workoutId/unstart", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    const now = nowInstant();
    const session = await withWatch(c, await unstartSession(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now }));
    if (await removeAbandonedStartNow(db, userId, c.req.param("workoutId"), { now, prefs })) return c.json({ ...session, removed: true });
    return c.json(session);
  } catch (e) {
    if (e instanceof PerformedExistsError) return c.json({ error: "performed" }, 409);
    if (e instanceof RestoringError) return c.json({ error: "restore_in_progress" }, 423);
    return refusal(c, e);
  }
});

sessionRoutes.post("/:workoutId/start", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_start", issues: parsed.error.issues }, 422);
  try {
    const { session, calendarChanged } = await startSessionOutcome(db, userId, c.req.param("workoutId"), parsed.data.buildId, nowInstant(), c.env);
    // An outline again took the build's title and length as Start locked it (U4): the calendar picks that up.
    if (calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
    return c.json(await withWatch(c, session));
  } catch (e) {
    if (e instanceof StaleBuildError) {
      if (e.calendarChanged) waitUntilSafe(c, syncCalendar(db, c.env, userId));
      return c.json({ error: "stale", session: await withWatch(c, e.session) }, 409);
    }
    return refusal(c, e);
  }
});

// ── The watch (Phase 3) ──────────────────────────────────────────────────────────────────────────────────────

/** Off, the watch routes do not exist. */
const switchedOff = (c: Context<AppContext>): Response | null => (watchPushEnabled(c.env) ? null : c.json({ error: "not_found" }, 404));

/** Send names the build and the preview the athlete saw: `digest` is that preview's (audit W-2 / W-8). */
const sendSchema = z.object({ buildId: z.string().min(1).max(200), digest: z.string().min(1).max(200) }).strict();

/** The steps as the watch will hold them, read off the program the push would write; the stamp it would carry. */
sessionRoutes.get("/:workoutId/watch-preview", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await watchPreview(db, c.env, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant(), prefs }));
  } catch (e) {
    if (e instanceof WatchUnavailableError) return c.json({ error: e.reason }, 409);
    return refusal(c, e);
  }
});

/**
 * Lock the build the athlete previewed and queue its push. NO LANE RUNS IN THIS REQUEST (ruling 3-R11: the Workers
 * Free budget): the client follows up with `POST /api/sessions/watch/drain`, its own invocation; the hourly lane is
 * the fallback. The answer carries its `watch` state (`sending`). `{buildId, digest}`: the digest of the preview the
 * athlete saw; 409 `{error: "stale_preview", preview}` when the payload Send would queue is not that one (nothing
 * written — show `preview`, and Send names its digest).
 */
sessionRoutes.post("/:workoutId/send-to-watch", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = sendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_send", issues: parsed.error.issues }, 422);
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(
      await sendToWatch(
        db,
        c.env,
        userId,
        c.req.param("workoutId"),
        parsed.data.buildId,
        { today: todayInZone(prefs.timezone), now: nowInstant(), prefs },
        { digest: parsed.data.digest },
      ),
    );
  } catch (e) {
    if (e instanceof WatchUnavailableError) return c.json({ error: e.reason }, 409);
    if (e instanceof StalePreviewError) return c.json({ error: "stale_preview", preview: e.preview }, 409);
    // No calendar sync here, even when the fresh build changed the slot's block (re-review B-N2, ruling 3-R11): a
    // whole-account sync in Send's own invocation took it to 45 combined with the calendar settled and 69 with this
    // half-hour's inserts pending. The block's change is the half-hourly reconcile's, like any build's.
    if (e instanceof StaleBuildError) return c.json({ error: "stale", session: await withWatch(c, e.session) }, 409);
    if (e instanceof RestoringError) return c.json({ error: "restore_in_progress" }, 423);
    return refusal(c, e);
  }
});

/**
 * KEEP OFF MY WATCH (the watch mirrors the plan §3.6): the session's copy comes off the watch (or never reaches it) and
 * the row is kept off (`watch_off`), which the mirror honours until Put on (`keepOffWatch`). 409 `done` for a session
 * done or otherwise resolved: its copy stays. Idempotent. No lane runs in this request (ruling 3-R11): the client
 * follows up with the drain.
 */
async function keepOff(c: Context<AppContext>): Promise<Response> {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    const session = await keepOffWatch(db, userId, c.req.param("workoutId")!, { today: todayInZone(prefs.timezone), now: nowInstant(), prefs });
    return c.json(await withWatch(c, session));
  } catch (e) {
    if (e instanceof WatchUnavailableError) return c.json({ error: e.reason }, 409);
    return refusal(c, e);
  }
}

sessionRoutes.post("/:workoutId/keep-off-watch", keepOff);

/**
 * The old Take off, kept for ONE RELEASE so a client cached from before Keep off still works (its PWA precache): it
 * answers as Keep off — the copy off AND kept off, since the mirror would otherwise put it straight back. Retire it in
 * the release after the one that ships Keep off.
 */
sessionRoutes.post("/:workoutId/take-off-watch", keepOff);

/**
 * PUT ON MY WATCH (§3.6): `watch_off` cleared and the session owed to the mirror again (`putOnWatch`) — the drain or the
 * sweep makes its copy; nothing is queued here. Idempotent.
 */
sessionRoutes.post("/:workoutId/put-on-watch", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    const session = await putOnWatch(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant(), prefs });
    return c.json(await withWatch(c, session));
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * RETRY (the watch mirrors the plan §3.9, M6): the session's failed push queued again now — a provisional copy's as it
 * was (its stamp kept), a day build's as Send's Retry (`retryWatch`). No body, no digest; nothing failed → the session as
 * it stands. 409 `{error: reason}` as Send's (`writes_off`, `not_connected`, `done`, `not_today`, `gated`, …), `stale`
 * with the fresh session; 423 while a restore runs. No lane runs in this request (ruling 3-R11): the client drains.
 */
sessionRoutes.post("/:workoutId/retry-watch", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    const session = await retryWatch(db, c.env, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), now: nowInstant(), prefs });
    return c.json(await withWatch(c, session));
  } catch (e) {
    if (e instanceof WatchUnavailableError) return c.json({ error: e.reason }, 409);
    if (e instanceof StalePreviewError) return c.json({ error: "stale_preview", preview: e.preview }, 409);
    if (e instanceof StaleBuildError) return c.json({ error: "stale", session: await withWatch(c, e.session) }, 409);
    if (e instanceof RestoringError) return c.json({ error: "restore_in_progress" }, 423);
    return refusal(c, e);
  }
});

/**
 * The quick review after a watch session (Task 9, spec §5): the watch's logged sets paired with the locked build, the
 * activity's times, the post-check's profiles. 404 while the switch is off, and whenever the review is not offered.
 */
sessionRoutes.get("/:workoutId/watch-review", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json(await watchReviewBasis(db, userId, c.req.param("workoutId"), { today: todayInZone(prefs.timezone), unit: prefs.weightUnit }));
  } catch (e) {
    return refusal(c, e);
  }
});

/**
 * `POST /api/sessions/watch/drain`: ONE watch job in a request of its own (ruling 3-R11; the watch mirrors the plan
 * §3.7, A5 — a push drain measures ≈31–34 of the invocation's 45, the mirror's record ≤15: never two). The mirror's turn
 * first (`mirrorTakesTurn`: a session owed, or a window session whose copy is not current — the sweep makes its one
 * record and queues its push); when it had nothing to make, the oldest of this user's queued watch jobs (a push — a
 * provisional copy's too — a sent build's unpush, an adopted row's held copy's delete) runs. Coach work and older jobs
 * of other kinds are left to the lanes that run them. The app calls it after every change that queues watch work and
 * again while `pending` (the account's queued watch jobs, one COUNT) is above 0 (`drainWatchUntilIdle`). A sweep that
 * throws is logged and answered `{ran: false}` with nothing drained (the request's room may be spent). 404 while the
 * switch is off. `{ran, pending}`.
 */
sessionRoutes.post("/watch/drain", async (c) => {
  const off = switchedOff(c);
  if (off) return off;
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  let ran: boolean;
  try {
    ran = await mirrorTakesTurn(db, c.env, userId, prefs, { today: todayInZone(prefs.timezone), now: nowInstant(), prefs });
  } catch (e) {
    // The sweep threw — perhaps at its last write, with most of the room spent: no job runs in this request (a push
    // drain on top would break 45). Nothing ran; the client stops its chain, and the hourly drains (and records it).
    console.error(`watch drain: the mirror sweep failed — ${e instanceof Error ? e.message : "unknown"}`);
    return c.json({ ran: false, pending: await queuedWatchJobs(db, userId) });
  }
  if (!ran) ran = (await executeCloudJobs(db, c.env, userId, prefs, { cap: 1, watchOnly: true })).executed > 0;
  return c.json({ ran, pending: await queuedWatchJobs(db, userId) });
});

/**
 * The player's outbox delivers a performed session here, as often as it needs (services/session-save.ts): 200
 * `{status:"saved", …}` or `{status:"same_payload"}`; 409 `{error:"conflict"}` for the same session with other edits;
 * 409 `{error:"slot_done"}` for another session of a slot whose app session is saved already (ruling 2b-R18);
 * 404 for a slot that is not this user's; 422 `invalid_save`; 503 `busy` while the same session is being saved (the
 * outbox retries); 423 while a restore runs (`requireUser`, or the save's own check).
 */
sessionRoutes.put("/performed/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid_save", issues: [{ message: "invalid JSON" }] }, 422);
  }
  const prefs = await loadPreferences(db, userId);
  try {
    const outcome = await savePerformedSession(db, userId, c.req.param("id"), body, {
      now: nowInstant(),
      prefs,
      watchReviews: watchPushEnabled(c.env),
    });
    if (outcome.status === "conflict") return c.json({ error: "conflict" }, 409);
    if (outcome.status === "slot_done") return c.json({ error: "slot_done" }, 409);
    if (outcome.status === "busy") return c.json({ error: "busy" }, 503);
    if (outcome.status === "restoring") return c.json({ error: "restore_in_progress" }, 423);
    return c.json(outcome);
  } catch (e) {
    if (e instanceof InvalidSaveError) return c.json({ error: "invalid_save", issues: e.issues }, 422);
    return refusal(c, e);
  }
});

conditionRoutes.post("/checks", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = checkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_check", issues: parsed.error.issues }, 422);
  const prefs = await loadPreferences(db, userId);
  try {
    const check = await recordCheck(db, userId, parsed.data, { today: todayInZone(prefs.timezone), now: nowInstant() });
    return c.json({ check });
  } catch (e) {
    if (e instanceof UnknownProfileError) return c.json({ error: "unknown_profile" }, 422);
    throw e;
  }
});
