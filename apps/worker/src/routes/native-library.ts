/**
 * THE PHONE'S LIBRARY (R1, 3a; the LifeOS migration's DESIGN-3 §3.5, pairs 1–5): the owner's saved workouts and the move
 * library, read trimmed, and a saved workout put on the plan with a take-back receipt. Behind `requireUser`, so a device
 * reaches these only on `training-v5`'s list (auth/device-scope.ts) and the laptop's cookie reaches them as the owner.
 *
 *   GET  /api/native/templates              → { templates: [{ id, name, minutes, discipline, pinned, uses, lastUsedAt,
 *                                              updatedAt }] } — pinned first, then by last use; no documents
 *   GET  /api/native/templates/:id          → { id, name, doc, derived, minutes, discipline, moves } (404 not_found) —
 *                                              `moves` (R1.1): *What's in it*, [{ exerciseId, name, dose }] exactly as
 *                                              `/sessions/:id/ahead` reads a document's (session-build.ts `docMoves`);
 *                                              null, as `derived`, when the document no longer reads
 *   GET  /api/native/library?q&family&region&equipment&limit&cursor
 *                                           → { items: [DeviceLibraryRow], matched, next } — `limit` 1–100 (default 50),
 *                                              `cursor` the next page's offset; 400 bad_query
 *   GET  /api/native/library/:id            → DeviceLibraryItem (404 not_found)
 *   POST /api/native/templates/:id/place    { date, time?, clientId } → { workoutId, receiptId, date, time, repeated? }
 *        (201; 200 for a resent clientId: the same row and the same receipt — looked up FIRST, R1.1: before the template,
 *        the day, the time or the document is judged, so a resend whose answer was lost is answered whatever changed
 *        since) — or, once that place is off the plan (archived: taken back, or removed on the laptop), 422 `{error:
 *        "taken_back", why, workoutId, receiptId}` (R1.2), never `repeated`. The template's document, stamped
 *        `basedOn: {kind: "template", id}`, through the Studio's own `createDocWorkout` — validated for that day, its
 *        watch copy owed and its calendar booked as a Studio save's — with the template's use counted and the take-back
 *        receipt IN THE SAME BATCH (services/take-back.ts). 422 invalid_doc with its issues (nothing written, no receipt),
 *        422 past_date, past_time, no_time_today, 404 not_found, 400 bad_place. From a phone, its session's watch copy is
 *        made before it answers (R1.2 item 7), and sent by the phone's read of the receipt straight after; its calendar step
 *        takes the room left, none beside the copy (the half-hourly run books it).
 *
 * TRIMMED (DESIGN-3 §3.5): a move's row and its page carry one verdict for the switched-on profiles together — `ok`,
 * `caution` or `never` — and never a profile's name, its notes, the account's saved-post links or its corrections. Every read
 * is `no-store` and answers 503 `{error: "restore_in_progress", retryable: true}` while a restore replaces the account,
 * before any read of its rows; the place is a write, 423 at the gate.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { plannedWorkouts, workoutTemplates } from "@rg/database";
import { isLocalDate, nowInstant, parseStoredWorkoutDoc, todayInZone, type WorkoutDoc } from "@rg/domain";
import { deriveDoc } from "@rg/workout";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { watchPushEnabled } from "../env.js";
import { libraryForDocs, loadAccountLibrary } from "../services/account-library.js";
import { restoreInProgress } from "../services/account-state.js";
import { loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { createDocWorkout, keyedRowId } from "../services/doc-workouts.js";
import { calendarOpsFitting, REQUEST_BUDGET } from "../services/design-approve.js";
import { DEVICE_RECORD_COST, deviceWatchRecord } from "../services/device-watch.js";
import { approveTimeOf } from "../services/design-time.js";
import { LibraryItemNotFoundError, libraryItem, listLibrary, MAX_LIBRARY_LIMIT, type LibraryItem, type LibraryRow, type Safety } from "../services/library-view.js";
import { docMoves, type AheadMove } from "../services/session-build.js";
import { madeByOf, receiptExpiry, receiptIdOf, receiptInsert } from "../services/take-back.js";
import { listTemplates } from "../services/workout-templates.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { refusal } from "./workouts.js";

export const nativeLibraryRoutes = new Hono<AppContext>();

type C = Context<AppContext>;

/** A read during a restore: refused before any of the account's rows is read, retryable (the phone keeps what it shows). */
const restoring = (c: C) => c.json({ error: "restore_in_progress", retryable: true }, 503);

/** One verdict for every switched-on profile together: `never` if any rules the move out, `caution` if any limits it. */
export type Verdict = "ok" | "caution" | "never";
export const verdictOf = (safety: Readonly<Record<string, Safety>>): Verdict => {
  const all = Object.values(safety);
  return all.includes("never") ? "never" : all.includes("care") ? "caution" : "ok";
};

/** A move's row as the phone reads it: EXACTLY these keys (native-library.test.ts pins them). */
export interface DeviceLibraryRow {
  id: string;
  name: string;
  family: string;
  regions: readonly string[];
  equipment: { all: readonly string[]; oneOf: readonly string[] };
  difficulty: number;
  summary: string;
  lastDoneOn: string | null;
  pinned: boolean;
  excluded: boolean;
  verdict: Verdict;
}

export const deviceLibraryRow = (r: LibraryRow): DeviceLibraryRow => ({
  id: r.id,
  name: r.name,
  family: r.family,
  regions: r.regions,
  equipment: { all: r.equipment.all, oneOf: r.equipment.oneOf },
  difficulty: r.difficulty,
  summary: r.summary,
  lastDoneOn: r.lastDoneOn,
  pinned: r.pinned,
  excluded: r.excluded,
  verdict: verdictOf(r.safety),
});

/** A move's page as the phone reads it: the how-to and the dose, its easier and harder steps, one verdict — EXACTLY these keys. */
export interface DeviceLibraryItem {
  id: string;
  name: string;
  family: string;
  regions: readonly string[];
  equipment: { all: readonly string[]; oneOf: readonly string[] };
  position: string;
  laterality: string;
  load: string;
  dose: LibraryItem["dose"];
  difficulty: number;
  text: { summary: string; setup: readonly string[]; steps: readonly string[]; focus: readonly string[]; mistakes: readonly string[]; breathing: string; why: string };
  easier: Array<{ id: string; name: string }>;
  harder: Array<{ id: string; name: string }>;
  pinned: boolean;
  excluded: boolean;
  verdict: Verdict;
}

export const deviceLibraryItem = (m: LibraryItem): DeviceLibraryItem => ({
  id: m.id,
  name: m.name,
  family: m.family,
  regions: m.regions,
  equipment: { all: m.equipment.all, oneOf: m.equipment.oneOf },
  position: m.position,
  laterality: m.laterality,
  load: m.load,
  dose: m.dose,
  difficulty: m.difficulty,
  text: { summary: m.text.summary, setup: m.text.setup, steps: m.text.steps, focus: m.text.focus, mistakes: m.text.mistakes, breathing: m.text.breathing, why: m.text.why },
  easier: m.easier,
  harder: m.harder,
  pinned: m.prefs.pinned,
  excluded: m.prefs.excluded,
  verdict: verdictOf(m.safety),
});

/**
 * One move of a saved workout's *What's in it* as the phone reads it (R1.1; 3a's review ARCHITECTURE 3): EXACTLY these keys
 * (native-templates.test.ts pins them) — the shape `/sessions/:id/ahead` gives a document session's moves, from the same
 * renderer (`docMoves`), so the phone's one decoder and view read both. Its words are the library's name for a move (an own
 * move's from `personal_moves`), a free move's own name and a dose in words: nothing a v5 phone doesn't already read, as a
 * move's own page and a session's `/ahead` give them (R1.2, the R1.1 review's minor 2). Never a move's why, cue or
 * progression, an alternate's why or the document's notes.
 */
export interface DeviceMove {
  exerciseId: string | null;
  name: string;
  dose: string;
}
export const DEVICE_MOVE_KEYS = ["dose", "exerciseId", "name"] as const satisfies ReadonlyArray<keyof DeviceMove>;

export const deviceMove = (m: AheadMove): DeviceMove => ({ exerciseId: m.exerciseId, name: m.name, dose: m.dose });

/** A page of the phone's move list: 1–100 rows, 50 unless asked. */
export const DEVICE_LIBRARY_DEFAULT = 50;
export const DEVICE_LIBRARY_MAX = 100;

nativeLibraryRoutes.get("/templates", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const templates = await listTemplates(db, userId);
  return c.json({
    templates: templates.map((t) => ({ id: t.id, name: t.name, minutes: t.minutes, discipline: t.discipline, pinned: t.pinned, uses: t.uses, lastUsedAt: t.lastUsedAt, updatedAt: t.updatedAt })),
  });
});

/** The account's template, its document parsed (null when it no longer reads), or undefined when it isn't theirs. */
async function templateOf(c: C, id: string): Promise<{ id: string; name: string; doc: WorkoutDoc | null } | undefined> {
  const [row] = await c
    .get("db")
    .select({ id: workoutTemplates.id, name: workoutTemplates.name, doc: workoutTemplates.doc })
    .from(workoutTemplates)
    .where(and(eq(workoutTemplates.id, id), eq(workoutTemplates.userId, c.get("userId"))))
    .limit(1);
  return row ? { id: row.id, name: row.name, doc: parseStoredWorkoutDoc(row.doc) } : undefined;
}

nativeLibraryRoutes.get("/templates/:id", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const t = await templateOf(c, c.req.param("id")!);
  if (!t) return c.json({ error: "not_found" }, 404);
  // The library the document's moves are named and derived in: the account's own moves with the catalog, as `previewAhead`.
  const library = t.doc ? (await libraryForDocs(db, userId, [t.doc])).all : null;
  const derived = t.doc && library ? deriveDoc(t.doc, library) : null;
  // Never a condition's name (review A NIT 2): `conditionMax` is keyed by profile; the library's verdicts say what is safe.
  const { conditionMax: _byProfile, ...shown } = (derived ?? {}) as NonNullable<typeof derived>;
  const moves = t.doc && library ? docMoves(t.doc, library).map(deviceMove) : null;
  return c.json({ id: t.id, name: t.name, doc: t.doc, derived: derived ? shown : null, minutes: derived?.estimatedMinutes ?? null, discipline: derived?.discipline ?? null, moves });
});

const word = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const libraryQuery = z
  .object({
    // eslint-disable-next-line no-control-regex
    q: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
    family: word.optional(),
    region: word.optional(),
    equipment: word.optional(),
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine((n) => n >= 1 && n <= DEVICE_LIBRARY_MAX).optional(),
    cursor: z.string().regex(/^\d{1,4}$/).transform(Number).optional(),
  })
  .strict();

nativeLibraryRoutes.get("/library", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = libraryQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "bad_query" }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  const { q, family, region, equipment, limit = DEVICE_LIBRARY_DEFAULT, cursor = 0 } = parsed.data;
  const list = await listLibrary(db, userId, { ...(q ? { q } : {}), ...(region ? { region } : {}), ...(equipment ? { equipment } : {}), limit: MAX_LIBRARY_LIMIT });
  const matches = family ? list.items.filter((r) => r.family === family) : list.items;
  const page = matches.slice(cursor, cursor + limit);
  return c.json({ items: page.map(deviceLibraryRow), matched: matches.length, next: cursor + limit < matches.length ? String(cursor + limit) : null });
});

nativeLibraryRoutes.get("/library/:id", requireUser, async (c) => {
  c.header("Cache-Control", "no-store");
  const db = c.get("db");
  const userId = c.get("userId");
  if (await restoreInProgress(db, userId)) return restoring(c);
  try {
    return c.json(deviceLibraryItem(await libraryItem(db, userId, c.req.param("id")!)));
  } catch (e) {
    if (e instanceof LibraryItemNotFoundError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
});

const placeSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isLocalDate),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
    clientId: z.string().min(1).max(100),
  })
  .strict();

/**
 * What a first place declares of its request (an upper bound, its sign-in included; measured 19 at a time and 21 untimed,
 * the collision pass of a light day included): the room its record and its calendar step share (R1.2 re-check, MAJOR-A).
 * An untimed place adds a statement for each row its collision pass re-times (`retimed`; R1.3, the re-check's NIT-3).
 */
export const PLACE_COST = 24;

/**
 * THE MOST ROWS A PLACE'S COLLISION PASS MAY RE-TIME AND STILL MAKE THE WATCH COPY ITSELF (R1.4). The installed phone
 * (LifeOS `f83daf9f`, `receiptsToRead`) reads a placed receipt ONCE, so a copy left to that read is made there and its push
 * waits for the hourly run or the laptop. So the place's record gives way only where it truly wouldn't fit. Measured, an
 * untimed place with its record costs 35–39 + N statements and fetches for N rows re-timed, by path: 35 + N for tomorrow
 * with a plain template; +1 each for today before its window (the pass runs on today), a template holding a jump (the
 * day's jumps read), an active condition profile, and the device's hourly stamp landing on the place — 39 + N on that
 * dearest path (R1.4 fix round 1; the review's MAJOR-1: 6 rows 45, 7 rows 46). So the bound is the budget less the
 * dearest path: 6. (The declared figures, `PLACE_COST` + N + `DEVICE_RECORD_COST`, are 43 + N, and gave way from 3 rows:
 * R1.3's O2.) Past it, the copy is the read's, and its push the hourly's or the laptop's.
 */
export const PLACE_WITH_RECORD_DEAREST = 39;
export const RECORD_BESIDE_RETIMED_MAX = REQUEST_BUDGET - PLACE_WITH_RECORD_DEAREST;

/** The template's use, counted in the place's own batch: a resent clientId writes no batch, so it counts once. */
const useCounted = (c: C, id: string) => (w: { now: string }) => [
  c
    .get("db")
    .update(workoutTemplates)
    .set({ uses: sql`${workoutTemplates.uses} + 1`, lastUsedAt: w.now })
    .where(and(eq(workoutTemplates.id, id), eq(workoutTemplates.userId, c.get("userId")))),
];

/** Why a resend whose place has left the plan since is refused (R1.2): what happened, in words, as the other refusals. */
export const TAKEN_BACK_WHY = "It was put on your plan, then taken off it.";

/** What a resend is answered: the place as it now stands, or — off the plan since — `taken_back`. */
type PlacedBefore =
  | { status: 200; answer: { workoutId: string; receiptId: string; date: string; time: string; repeated: true } }
  | { status: 422; answer: { error: "taken_back"; why: string; workoutId: string; receiptId: string } };

/**
 * IDEMPOTENT FIRST (R1.1; 3a's review RELIABILITY 3): the place this clientId already made, answered as R1 answers a
 * resend — the same row and the same receipt, the row's day and time as it now stands, `repeated` — or null. Read before
 * anything about the template, the day, the time or the document is judged, so a resend whose first answer was lost is
 * answered whatever changed since: the template deleted or no longer readable, the day or the time gone. The key is the
 * account and the phone's clientId (`place:<clientId>`, C12) — the row's own id, so the body beside it is never judged
 * again: a resend naming another day, time or template under the same clientId is answered the original (R1's rule).
 * OFF THE PLAN SINCE (R1.2, the R1.1 review's minor 3): a row archived since — taken back on the laptop or by another
 * request, or removed there — is answered 422 `taken_back` with its ids and why, never `repeated`, which would say it is
 * still on the plan. 422 because the installed phone (LifeOS `f83daf9f`, `placeAnswered`) reads any 422 as the place
 * refused, its code kept as a word, and offers no take-back for it; a 409 or 410 would stop its delivery and hold the
 * placement unsent for good. Writes nothing. One statement.
 */
async function placedBefore(c: C, clientId: string): Promise<PlacedBefore | null> {
  const userId = c.get("userId");
  const [row] = await c
    .get("db")
    .select({ id: plannedWorkouts.id, date: plannedWorkouts.effectiveDate, time: plannedWorkouts.effectiveTime, archivedAt: plannedWorkouts.archivedAt })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, await keyedRowId(userId, `place:${clientId}`)), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!row) return null;
  const receiptId = await receiptIdOf(userId, "place", clientId);
  if (row.archivedAt) return { status: 422, answer: { error: "taken_back", why: TAKEN_BACK_WHY, workoutId: row.id, receiptId } };
  return { status: 200, answer: { workoutId: row.id, receiptId, date: row.date, time: row.time, repeated: true } };
}

nativeLibraryRoutes.post("/templates/:id/place", requireUser, async (c) => {
  const parsed = placeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_place", issues: parsed.error.issues }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const { date, clientId } = parsed.data;
  const before = await placedBefore(c, clientId);
  if (before) return c.json(before.answer, before.status);
  const t = await templateOf(c, c.req.param("id")!);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (!t.doc) return c.json({ error: "invalid_doc", issues: [{ path: "", code: "unreadable", message: "This saved workout can't be read.", severity: "error" }] }, 422);
  const prefs = await loadPreferences(db, userId);
  const now = nowInstant();
  const ctx = { today: todayInZone(prefs.timezone), now, prefs };
  // NEVER IN THE PAST (review B-8), as an approve places a new workout (design-time.ts `approveTimeOf`): today, a time
  // already gone is 422 `past_time`; untimed after its window, the next quarter hour, pinned — or 422 `no_time_today`. A
  // resend of a place made before its time went never reaches here (`placedBefore`).
  const placed = approveTimeOf({ date, ...(parsed.data.time ? { time: parsed.data.time } : {}) }, deriveDoc(t.doc, (await loadAccountLibrary(db, userId)).all).category, { now: new Date(now), prefs });
  if ("refused" in placed) return c.json({ error: placed.code, why: placed.refused }, 422);
  const time = placed.pinned ? placed.time : null;
  const receiptId = await receiptIdOf(userId, "place", clientId);
  const insert = receiptInsert(db, {
    id: receiptId,
    userId,
    source: "place",
    sourceKey: clientId,
    madeBy: madeByOf(c.get("device")),
    op: "create",
    // A place is a group of its own: it goes back alone.
    groupId: receiptId,
    dependsOn: [],
    preState: null,
    // What a Studio save queues: its calendar event, and its watch copy (owed) when COROS writes are on.
    effects: [{ provider: "calendar" }, ...(prefs.corosWritesEnabled ? [{ provider: "watch" as const }] : [])],
    expiresAt: receiptExpiry(now, date, prefs.timezone),
  });
  try {
    const made = await createDocWorkout(
      db,
      userId,
      // The phone's key in a namespace of its own: a place never meets a Studio save's key.
      { date, time: time ?? null, doc: { ...t.doc, basedOn: { kind: "template", id: t.id } }, clientId: `place:${clientId}` },
      ctx,
      {},
      { alsoInBatch: (w) => [...useCounted(c, t.id)(w), ...insert(w)], settleId: receiptId },
    );
    const answer = { workoutId: made.workout.id, receiptId, date: made.workout.date, time: made.workout.time };
    if (made.repeated) return c.json({ ...answer, repeated: true }, 200);
    // THE WATCH FOLLOWS (R1.2 item 7): a phone has no drain of its own, so its place makes its session's copy (the mirror's
    // record, its push queued) BEFORE it answers — the phone's read of the receipt, straight after, finds the push queued
    // and sends it, never racing a record still under way (the re-check's MAJOR-B). The laptop's own drain does both for
    // a place it makes. A failed record is left to the read's own step, or the hourly's.
    // A record runs only for a phone, with the watch switch and COROS writes on (`deviceWatchRecord`'s own conditions), and
    // beside a collision pass that leaves it room (`RECORD_BESIDE_RETIMED_MAX`, measured): past that it gives way, and the
    // phone's read of the receipt, straight after, makes it (its step; the R1.3 review's O2) — its push then waits for the
    // hourly or the laptop, as the installed phone reads a placed receipt once (R1.4).
    const records =
      !!c.get("device") && watchPushEnabled(c.env) && prefs.corosWritesEnabled && (made.retimed ?? 0) <= RECORD_BESIDE_RETIMED_MAX;
    if (records) await deviceWatchRecord(db, c.env, userId, made.workout.id, prefs).catch(() => false);
    // The calendar follows, as after a Studio save — in the room the request has left (the re-check's MAJOR-A): beside a
    // phone's record none is left, so its event waits for the half-hourly run; the reconcile books what any step leaves.
    // No record, no room held for one (the re-check's NIT-2): the place books its event itself. Its cost counts each row
    // its collision pass re-timed, one statement a row (NIT-3: `PLACE_COST` is a light day's): a crowded day books none.
    const ops = calendarOpsFitting(REQUEST_BUDGET - PLACE_COST - (made.retimed ?? 0) - (records ? DEVICE_RECORD_COST : 0));
    if (ops > 0) waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps: ops }).catch(() => undefined));
    return c.json(answer, 201);
  } catch (e) {
    return refusal(c, e);
  }
});
