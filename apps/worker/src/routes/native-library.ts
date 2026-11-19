/**
 * THE PHONE'S LIBRARY (R1, 3a; the LifeOS migration's DESIGN-3 §3.5, pairs 1–5): the owner's saved workouts and the move
 * library, read trimmed, and a saved workout put on the plan with a take-back receipt. Behind `requireUser`, so a device
 * reaches these only on `training-v5`'s list (auth/device-scope.ts) and the laptop's cookie reaches them as the owner.
 *
 *   GET  /api/native/templates              → { templates: [{ id, name, minutes, discipline, pinned, uses, lastUsedAt,
 *                                              updatedAt }] } — pinned first, then by last use; no documents
 *   GET  /api/native/templates/:id          → { id, name, doc, derived, minutes, discipline } (404 not_found)
 *   GET  /api/native/library?q&family&region&equipment&limit&cursor
 *                                           → { items: [DeviceLibraryRow], matched, next } — `limit` 1–100 (default 50),
 *                                              `cursor` the next page's offset; 400 bad_query
 *   GET  /api/native/library/:id            → DeviceLibraryItem (404 not_found)
 *   POST /api/native/templates/:id/place    { date, time?, clientId } → { workoutId, receiptId, date, time, repeated? }
 *        (201; 200 for a resent clientId: the same row and the same receipt). The template's document, stamped
 *        `basedOn: {kind: "template", id}`, through the Studio's own `createDocWorkout` — validated for that day, its
 *        watch copy owed and its calendar booked as a Studio save's — with the template's use counted and the take-back
 *        receipt IN THE SAME BATCH (services/take-back.ts). 422 invalid_doc with its issues (nothing written, no receipt),
 *        422 past_date, 404 not_found, 400 bad_place.
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
import { libraryForDocs, loadAccountLibrary } from "../services/account-library.js";
import { restoreInProgress } from "../services/account-state.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { createDocWorkout, keyedRowId } from "../services/doc-workouts.js";
import { approveTimeOf } from "../services/design-time.js";
import { LibraryItemNotFoundError, libraryItem, listLibrary, MAX_LIBRARY_LIMIT, type LibraryItem, type LibraryRow, type Safety } from "../services/library-view.js";
import { madeByOf, receiptExpiry, receiptIdOf, receiptInsert, receiptSettle } from "../services/take-back.js";
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
  const derived = t.doc ? deriveDoc(t.doc, (await libraryForDocs(db, userId, [t.doc])).all) : null;
  // Never a condition's name (review A NIT 2): `conditionMax` is keyed by profile; the library's verdicts say what is safe.
  const { conditionMax: _byProfile, ...shown } = (derived ?? {}) as NonNullable<typeof derived>;
  return c.json({ id: t.id, name: t.name, doc: t.doc, derived: derived ? shown : null, minutes: derived?.estimatedMinutes ?? null, discipline: derived?.discipline ?? null });
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

/** The template's use, counted in the place's own batch: a resent clientId writes no batch, so it counts once. */
const useCounted = (c: C, id: string) => (w: { now: string }) => [
  c
    .get("db")
    .update(workoutTemplates)
    .set({ uses: sql`${workoutTemplates.uses} + 1`, lastUsedAt: w.now })
    .where(and(eq(workoutTemplates.id, id), eq(workoutTemplates.userId, c.get("userId")))),
];

nativeLibraryRoutes.post("/templates/:id/place", requireUser, async (c) => {
  const parsed = placeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_place", issues: parsed.error.issues }, 400);
  const db = c.get("db");
  const userId = c.get("userId");
  const t = await templateOf(c, c.req.param("id")!);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (!t.doc) return c.json({ error: "invalid_doc", issues: [{ path: "", code: "unreadable", message: "This saved workout can't be read.", severity: "error" }] }, 422);
  const prefs = await loadPreferences(db, userId);
  const now = nowInstant();
  const ctx = { today: todayInZone(prefs.timezone), now, prefs };
  const { date, clientId } = parsed.data;
  // NEVER IN THE PAST (review B-8), as an approve places a new workout (design-time.ts `approveTimeOf`): today, a time
  // already gone is 422 `past_time`; untimed after its window, the next quarter hour, pinned — or 422 `no_time_today`. A
  // resend of a place made before its time went is answered as it was (its row is there: `repeated`).
  const placed = approveTimeOf({ date, ...(parsed.data.time ? { time: parsed.data.time } : {}) }, deriveDoc(t.doc, (await loadAccountLibrary(db, userId)).all).category, { now: new Date(now), prefs });
  if ("refused" in placed) {
    const [made] = await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(and(eq(plannedWorkouts.id, await keyedRowId(userId, `place:${clientId}`)), eq(plannedWorkouts.userId, userId))).limit(1);
    if (!made) return c.json({ error: placed.code, why: placed.refused }, 422);
  }
  const time = "refused" in placed ? (parsed.data.time ?? null) : placed.pinned ? placed.time : null;
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
      { alsoInBatch: (w) => [...useCounted(c, t.id)(w), ...insert(w)], afterPlaced: receiptSettle(db, { id: receiptId, userId }) },
    );
    const answer = { workoutId: made.workout.id, receiptId, date: made.workout.date, time: made.workout.time };
    if (made.repeated) return c.json({ ...answer, repeated: true }, 200);
    // The calendar follows, as after a Studio save: one bounded step now, the reconcile books what it leaves.
    waitUntilSafe(c, syncCalendar(db, c.env, userId, { maxOps: CALENDAR_OPS_PER_REQUEST }).catch(() => undefined));
    return c.json(answer, 201);
  } catch (e) {
    return refusal(c, e);
  }
});
