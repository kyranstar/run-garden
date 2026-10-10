/**
 * THE EXERCISE LIBRARY AS THE ATHLETE BROWSES IT (Phase 2 spec §2c "Library API"; plan Task 1).
 *
 *   listLibrary      slim rows, filtered and ranked by `searchLibrary` (the package's pure search, shared with the
 *                    Studio): text, movement, body area, role, gear, purpose, tag, theme, muscle, contraction,
 *                    position, laterality, difficulty, a place's gear, and "safe for every switched-on profile", best
 *                    match first, cut to `limit`. Each row carries the card line, purposes, contraction, tags, primary
 *                    muscles, the day the athlete last did it and how many sessions did it in 30 days (logged sets and
 *                    played-only moves alike), its safety per switched-on profile, the athlete's rating, "not for
 *                    me", pin, whether it came from their saves, and the gear the default place lacks for it; plus
 *                    what each wishlist item would unlock at the default place
 *   libraryItem      one record whole (how-to, dose, notes for switched-on profiles, easier/harder by name, where a
 *                    saved move came from) with the athlete's last five entries and best set
 *   setExercisePrefs `{rating?, excluded?, pinned?}` → `exercise_prefs`, the row the review save writes
 *                    (`${userId}:${exerciseId}`), changing only the fields sent
 *
 * The library's own data never carries provenance (it is public); a saved move's links live in `exercise_provenance`,
 * the account's own, and only the detail returns them. No payload carries `providers` internals.
 *
 * Safety, per switched-on profile: `never` when the profile allows the move in no mode even on its calmest day,
 * `safe` when it is also safe on a flare day (`flareSafe`), else `care` (allowed with limits — a mode, a calm check).
 * The profile's whole-record rule (`allowRecord`, e.g. the jaw profile's plyometric gate) counts: a move it refuses in
 * every mode reads `never`; one it allows only on a calm, answered check reads `care`, never `safe`.
 * "Unlocks": a move the default place's gear cannot do now, that the gear would make doable, that the athlete has not
 * set aside and that no switched-on profile rules out.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { exercisePrefs, exerciseProvenance, locations, performedSessions, performedSets } from "@rg/database";
import { addDays, todayInZone, toKg, type Weight } from "@rg/domain";
import {
  bestDay,
  EQUIPMENT,
  EQUIPMENT_IDS,
  EXERCISES,
  hasEquipment,
  LOCATION_PRESETS,
  MODE_IDS,
  profileById,
  recordFlareSafe,
  searchLibrary,
  type LibraryFilters,
  type ConditionProfile,
  type EquipmentId,
  type ExerciseRecord,
} from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import { activeProfileIds } from "./condition-views.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, type Db } from "./db.js";
import { RestoreInProgressError } from "./programs.js";
import { PENDING_HASH } from "./watch-sets.js";

export type Safety = "safe" | "care" | "never";

export interface LibraryQuery extends LibraryFilters {
  q?: string;
  /** A place id of this user's, or one of the library's presets. */
  location?: string;
  /** Only moves safe on a flare day for every switched-on profile. */
  safe?: boolean;
  /** Rows to return (default 50, at most 200); `matched` on the list says how many matched. */
  limit?: number;
}

export const DEFAULT_LIBRARY_LIMIT = 50;
export const MAX_LIBRARY_LIMIT = 200;

export interface LibraryRow {
  id: string;
  name: string;
  family: string;
  patterns: readonly string[];
  regions: readonly string[];
  roles: readonly string[];
  equipment: { all: readonly string[]; oneOf: readonly string[] };
  difficulty: number;
  /** The card line. */
  summary: string;
  purposes: readonly string[];
  contraction: readonly string[];
  tags: readonly string[];
  primaryMuscles: readonly string[];
  /** The latest day this athlete did the move (settled sessions), or null. */
  lastDoneOn: string | null;
  /** Sessions with the move in the last 30 days. */
  timesDone30d: number;
  safety: Record<string, Safety>;
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  saved: boolean;
  /** The gear the default place lacks for this move (any one of `oneOf`); null when it can be done there now. */
  unlocksWith: { all: EquipmentId[]; oneOf: EquipmentId[] } | null;
}

export interface LibraryList {
  /** Moves in the library (before filters). */
  total: number;
  /** Moves that matched the filters (before the limit). */
  matched: number;
  items: LibraryRow[];
  /** The place `unlocksWith` and the wishlist are judged at: the default place (the library's Home before any). */
  place: { id: string; name: string };
  /** The switched-on profiles, labelled by the profile. */
  profiles: Array<{ profileId: string; label: string }>;
  /** Each wishlist item the vocabulary knows, with how many moves it would unlock at the default place. */
  wishlist: Array<{ equipmentId: EquipmentId; label: string; unlocks: number }>;
}

export interface ExercisePrefsView {
  exerciseId: string;
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  introducedOn: string | null;
}

export interface HistoryEntryView {
  date: string;
  sessionId: string;
  implement: string | null;
  perSide: boolean;
  format: string | null;
  sets: Array<{ w: Weight | null; reps: number | null; secs: number | null; side: string | null; flags: string[] }>;
}

export interface BestSet {
  w: Weight | null;
  reps: number | null;
  secs: number | null;
}

export interface LibraryItem {
  id: string;
  name: string;
  family: string;
  patterns: readonly string[];
  regions: readonly string[];
  roles: readonly string[];
  equipment: { all: readonly string[]; oneOf: readonly string[] };
  position: string;
  laterality: string;
  load: string;
  dose: ExerciseRecord["dose"];
  difficulty: number;
  tags: readonly string[];
  /** The how-to, without the per-profile notes (those are `conditionNotes`, for switched-on profiles only). */
  text: Omit<ExerciseRecord["text"], "conditions">;
  conditionNotes: Array<{ profileId: string; label: string; note: string }>;
  safety: Record<string, Safety>;
  easier: Array<{ id: string; name: string }>;
  harder: Array<{ id: string; name: string }>;
  prefs: ExercisePrefsView;
  saved: boolean;
  /** Where a saved move came from — the account's own links. */
  provenance: Array<{ sourceType: string; url: string | null; creator: string | null }>;
  history: { last: HistoryEntryView[]; best: BestSet | null };
}

export class LibraryItemNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

export class UnknownPlaceError extends Error {
  constructor() {
    super("unknown_location");
  }
}

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
/** Every id a move has gone by (renames keep history) → its current id. */
const canonicalId = new Map(EXERCISES.flatMap((e) => [e.id, ...e.legacyIds].map((i) => [i, e.id] as const)));
export const libraryHas = (id: string): boolean => byId.has(id);

/** A profile's verdict on a move (see the header). An unrated move reads as `never`: it fails closed. */
export function safetyFor(profile: ConditionProfile, ex: ExerciseRecord): Safety {
  const a = ex.conditions[profile.id];
  if (!a || profile.never(a)) return "never";
  const calm = bestDay(profile);
  const someMode = MODE_IDS.some(
    (mode) => profile.fitsMode(a, mode) && ex.patterns.every((p) => profile.allowPattern(p, mode, calm)) && (profile.allowRecord?.(ex, mode, calm) ?? true),
  );
  if (!someMode) return "never";
  // The library's one flare-safe verdict: a move the record rule refuses on a flare day is never "safe", whatever its
  // ratings read.
  return recordFlareSafe(profile, ex) ? "safe" : "care";
}

const safetyOf = (profiles: readonly ConditionProfile[], ex: ExerciseRecord): Record<string, Safety> =>
  Object.fromEntries(profiles.map((p) => [p.id, safetyFor(p, ex)]));

/** The default place's id, name and gear: the marked default, else the first set up, else the library's Home. */
async function defaultPlace(db: Db, userId: string): Promise<{ id: string; name: string; equipment: string[] }> {
  const [row] = await db
    .select({ id: locations.id, name: locations.name, equipment: locations.equipment })
    .from(locations)
    .where(eq(locations.userId, userId))
    .orderBy(desc(locations.isDefault), asc(locations.createdAt), asc(locations.id))
    .limit(1);
  if (row) return { id: row.id, name: row.name, equipment: [...row.equipment] };
  const home = LOCATION_PRESETS.find((l) => l.id === "home")!;
  return { id: home.id, name: home.name, equipment: [...home.equipment] };
}

/** A place's gear by id: one of this user's places, or one of the library's presets. */
async function placeEquipment(db: Db, userId: string, id: string): Promise<string[]> {
  const [row] = await db
    .select({ equipment: locations.equipment })
    .from(locations)
    .where(and(eq(locations.userId, userId), eq(locations.id, id)))
    .limit(1);
  if (row) return [...row.equipment];
  const preset = LOCATION_PRESETS.find((l) => l.id === id);
  if (preset) return [...preset.equipment];
  throw new UnknownPlaceError();
}

function missingGear(ex: ExerciseRecord, have: readonly string[]): LibraryRow["unlocksWith"] {
  if (hasEquipment(ex, have)) return null;
  const set = new Set(have);
  const oneOfMet = ex.equipment.oneOf.length === 0 || ex.equipment.oneOf.some((i) => set.has(i));
  return {
    all: ex.equipment.all.filter((i) => !set.has(i)),
    oneOf: oneOfMet ? [] : [...ex.equipment.oneOf],
  };
}

const ratingOf = (v: number | null | undefined): 1 | -1 | null => (v == null || v === 0 ? null : v > 0 ? 1 : -1);

const SAFETY_RANK: Record<Safety, number> = { safe: 0, care: 1, never: 2 };

/**
 * Per move: the latest settled day and the sessions in the last 30 days, from ONE compound read: the logged sets (done
 * ones) and the moves a session reached (`moves_done`, which also holds played-only moves such as mobility and
 * breathing). A move logged and played in one session counts once.
 */
async function doneStats(db: Db, userId: string, since: string): Promise<Map<string, { last: string; n30: number }>> {
  const rows = (await db.all(sql`
    select exercise_id as exerciseId, max(day) as last, count(distinct case when day >= ${since} then sid end) as n30
    from (
      select ${performedSets.exerciseId} as exercise_id, ${performedSessions.localDate} as day, ${performedSessions.id} as sid
      from ${performedSets} inner join ${performedSessions} on ${performedSessions.id} = ${performedSets.performedSessionId}
      where ${performedSessions.userId} = ${userId} and ${performedSessions.payloadHash} != ${PENDING_HASH} and ${performedSets.done} = 1
      union all
      select case when m.type = 'object' then json_extract(m.value, '$.exerciseId') end, ${performedSessions.localDate}, ${performedSessions.id}
      from ${performedSessions},
        json_each(case when json_valid(${performedSessions.movesDone}) then ${performedSessions.movesDone} else '[]' end) as m
      where ${performedSessions.userId} = ${userId} and ${performedSessions.payloadHash} != ${PENDING_HASH}
    )
    where exercise_id is not null
    group by exercise_id`)) as Array<{ exerciseId: string; last: string; n30: number }>;
  const out = new Map<string, { last: string; n30: number }>();
  for (const r of rows) {
    const id = canonicalId.get(r.exerciseId) ?? r.exerciseId;
    const cur = out.get(id);
    out.set(id, { last: cur && cur.last > r.last ? cur.last : r.last, n30: (cur?.n30 ?? 0) + Number(r.n30) });
  }
  return out;
}

export async function listLibrary(db: Db, userId: string, query: LibraryQuery): Promise<LibraryList> {
  const [active, prefRows, savedRows, place, userPrefs] = await Promise.all([
    activeProfileIds(db, userId),
    db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId)),
    db.select({ exerciseId: exerciseProvenance.exerciseId }).from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId)),
    defaultPlace(db, userId),
    loadPreferences(db, userId),
  ]);
  const at = query.location ? await placeEquipment(db, userId, query.location) : null;
  const profiles = active.map(profileById);
  const prefs = new Map(prefRows.map((r) => [r.exerciseId, r]));
  const saved = new Set(savedRows.map((r) => r.exerciseId));
  const done = await doneStats(db, userId, addDays(todayInZone(userPrefs.timezone), -29));

  const safeOf = new Map(EXERCISES.map((ex) => [ex.id, safetyOf(profiles, ex)]));
  const { q, location: _location, safe, limit, ...filters } = query;
  const matches = searchLibrary(EXERCISES, q ?? "", filters, {
    accepts: (ex) => (!at || hasEquipment(ex, at)) && (!safe || Object.values(safeOf.get(ex.id)!).every((s) => s === "safe")),
    fit: (ex) => Math.max(0, ...Object.values(safeOf.get(ex.id)!).map((s) => SAFETY_RANK[s])),
  });

  const rows: LibraryRow[] = matches.slice(0, Math.min(limit ?? DEFAULT_LIBRARY_LIMIT, MAX_LIBRARY_LIMIT)).map((ex) => {
    const p = prefs.get(ex.id);
    const d = done.get(ex.id);
    return {
      id: ex.id,
      name: ex.name,
      family: ex.family,
      patterns: ex.patterns,
      regions: ex.regions,
      roles: ex.roles,
      equipment: { all: ex.equipment.all, oneOf: ex.equipment.oneOf },
      difficulty: ex.difficulty,
      summary: ex.text.summary,
      purposes: ex.purposes,
      contraction: ex.contraction,
      tags: ex.tags,
      primaryMuscles: ex.muscles.primary,
      lastDoneOn: d?.last ?? null,
      timesDone30d: d?.n30 ?? 0,
      safety: safeOf.get(ex.id)!,
      rating: ratingOf(p?.rating),
      excluded: p?.excluded ?? false,
      pinned: p?.pinned ?? false,
      saved: saved.has(ex.id),
      unlocksWith: missingGear(ex, place.equipment),
    };
  });

  const known = new Set<string>(EQUIPMENT_IDS);
  const excluded = new Set(prefRows.filter((r) => r.excluded).map((r) => r.exerciseId));
  const wishlist = [...new Set(userPrefs.equipmentWishlist)]
    .filter((id): id is EquipmentId => known.has(id))
    .map((equipmentId) => ({
      equipmentId,
      label: EQUIPMENT[equipmentId],
      unlocks: EXERCISES.filter(
        (ex) =>
          !hasEquipment(ex, place.equipment) &&
          hasEquipment(ex, [...place.equipment, equipmentId]) &&
          !excluded.has(ex.id) &&
          profiles.every((p) => safetyFor(p, ex) !== "never"),
      ).length,
    }));

  return {
    total: EXERCISES.length,
    matched: matches.length,
    items: rows,
    place: { id: place.id, name: place.name },
    profiles: profiles.map((p) => ({ profileId: p.id, label: p.label })),
    wishlist,
  };
}

/** The best set over these entries, as the records judge it: the heaviest weight (most reps there), else the most reps;
 * the longest hold for a held or carried move. Ladders and circuits say nothing about bests. */
function bestOf(ex: ExerciseRecord, entries: readonly HistoryEntryView[]): BestSet | null {
  const sets = entries.filter((e) => e.format !== "ladder" && e.format !== "circuit").flatMap((e) => e.sets);
  if (sets.length === 0) return null;
  const loaded = sets.filter((s): s is typeof s & { w: Weight } => s.w !== null && s.w.v > 0);
  let w: Weight | null = null;
  let reps: number | null = null;
  if (loaded.length > 0) {
    const topKg = Math.max(...loaded.map((s) => toKg(s.w)));
    const atTop = loaded.filter((s) => Math.abs(toKg(s.w) - topKg) < 0.05);
    const most = [...atTop].sort((a, b) => (b.reps ?? -1) - (a.reps ?? -1))[0]!;
    w = most.w;
    reps = most.reps;
  } else {
    const withReps = sets.filter((s) => s.reps != null);
    reps = withReps.length ? Math.max(...withReps.map((s) => s.reps!)) : null;
  }
  const timed = ex.dose.type === "time" || ex.dose.type === "carry";
  const held = sets.filter((s) => (s.secs ?? 0) > 0);
  const secs = timed && held.length ? Math.max(...held.map((s) => s.secs!)) : null;
  if (w === null && reps === null && secs === null) return null;
  return { w, reps, secs };
}

/** Every entry of this move (and its legacy ids) in the user's settled sessions, newest first. */
async function entriesOf(db: Db, userId: string, ex: ExerciseRecord): Promise<HistoryEntryView[]> {
  const ids = [ex.id, ...ex.legacyIds];
  const rows = (
    await Promise.all(
      chunkIds(ids).map((chunk) =>
        db
          .select({
            sessionId: performedSessions.id,
            date: performedSessions.localDate,
            startedAt: performedSessions.startedAt,
            entryIndex: performedSets.entryIndex,
            setIndex: performedSets.setIndex,
            implement: performedSets.implement,
            perSide: performedSets.perSide,
            format: performedSets.format,
            side: performedSets.side,
            reps: performedSets.reps,
            seconds: performedSets.seconds,
            loadValue: performedSets.loadValue,
            loadUnit: performedSets.loadUnit,
            flags: performedSets.flags,
          })
          .from(performedSets)
          .innerJoin(performedSessions, eq(performedSessions.id, performedSets.performedSessionId))
          .where(
            and(
              eq(performedSessions.userId, userId),
              ne(performedSessions.payloadHash, PENDING_HASH),
              eq(performedSets.done, true),
              inArray(performedSets.exerciseId, chunk),
            ),
          ),
      ),
    )
  ).flat();
  const groups = new Map<string, { at: string; view: HistoryEntryView; sets: Array<{ i: number; set: HistoryEntryView["sets"][number] }> }>();
  for (const r of rows) {
    const key = `${r.sessionId}\u0000${r.entryIndex}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        at: `${r.date}\u0000${r.startedAt ?? ""}\u0000${r.sessionId}\u0000${String(r.entryIndex).padStart(4, "0")}`,
        view: { date: r.date, sessionId: r.sessionId, implement: r.implement, perSide: r.perSide, format: r.format, sets: [] },
        sets: [],
      };
      groups.set(key, g);
    }
    const unit = r.loadUnit === "lb" || r.loadUnit === "kg" ? r.loadUnit : null;
    const w: Weight | null = r.loadValue !== null && r.loadValue > 0 && unit ? { v: r.loadValue, u: unit } : null;
    g.sets.push({ i: r.setIndex, set: { w, reps: r.reps, secs: r.seconds, side: r.side, flags: [...(r.flags ?? [])] } });
  }
  return [...groups.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((g) => ({ ...g.view, sets: g.sets.sort((x, y) => x.i - y.i).map((s) => s.set) }));
}

const named = (ids: readonly string[]) =>
  ids.flatMap((id) => {
    const ex = byId.get(id);
    return ex ? [{ id, name: ex.name }] : [];
  });

export async function libraryItem(db: Db, userId: string, id: string): Promise<LibraryItem> {
  const ex = byId.get(id);
  if (!ex) throw new LibraryItemNotFoundError();
  const [active, [pref], provenance, entries] = await Promise.all([
    activeProfileIds(db, userId),
    db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, userId), eq(exercisePrefs.exerciseId, id))).limit(1),
    db
      .select({ sourceType: exerciseProvenance.sourceType, url: exerciseProvenance.url, creator: exerciseProvenance.creator })
      .from(exerciseProvenance)
      .where(and(eq(exerciseProvenance.userId, userId), eq(exerciseProvenance.exerciseId, id)))
      .orderBy(asc(exerciseProvenance.createdAt), asc(exerciseProvenance.id)),
    entriesOf(db, userId, ex),
  ]);
  const profiles = active.map(profileById);
  const { conditions: notes, ...text } = ex.text;
  return {
    id: ex.id,
    name: ex.name,
    family: ex.family,
    patterns: ex.patterns,
    regions: ex.regions,
    roles: ex.roles,
    equipment: { all: ex.equipment.all, oneOf: ex.equipment.oneOf },
    position: ex.position,
    laterality: ex.laterality,
    load: ex.load,
    dose: ex.dose,
    difficulty: ex.difficulty,
    tags: ex.tags,
    text,
    conditionNotes: profiles.flatMap((p) => (notes[p.id] ? [{ profileId: p.id, label: p.label, note: notes[p.id]! }] : [])),
    safety: safetyOf(profiles, ex),
    easier: named(ex.easier),
    harder: named(ex.harder),
    prefs: {
      exerciseId: ex.id,
      rating: ratingOf(pref?.rating),
      excluded: pref?.excluded ?? false,
      pinned: pref?.pinned ?? false,
      introducedOn: pref?.introducedOn ?? null,
    },
    saved: provenance.length > 0,
    provenance,
    history: { last: entries.slice(0, 5), best: bestOf(ex, entries) },
  };
}

export interface PrefsPatch {
  rating?: 1 | -1 | null;
  excluded?: boolean;
  pinned?: boolean;
}

/**
 * The athlete's rating, "not for me" and pin for one move — the `exercise_prefs` row the review save also writes
 * (`${userId}:${exerciseId}`), with the same meaning. Only the fields sent change; a new row starts unrated, not set
 * aside, unpinned and not yet introduced. The flags are independent, as the save leaves them: the engine puts "not
 * for me" before a pin. Refused while a restore is replacing the account.
 */
export async function setExercisePrefs(db: Db, userId: string, exerciseId: string, patch: PrefsPatch, now: string): Promise<ExercisePrefsView> {
  if (!byId.has(exerciseId)) throw new LibraryItemNotFoundError();
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  const set: Partial<typeof exercisePrefs.$inferInsert> = { updatedAt: now };
  if (patch.rating !== undefined) set.rating = patch.rating;
  if (patch.excluded !== undefined) set.excluded = patch.excluded;
  if (patch.pinned !== undefined) set.pinned = patch.pinned;
  await db
    .insert(exercisePrefs)
    .values({
      id: `${userId}:${exerciseId}`,
      userId,
      exerciseId,
      rating: patch.rating ?? null,
      excluded: patch.excluded ?? false,
      pinned: patch.pinned ?? false,
      introducedOn: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: exercisePrefs.id, set });
  const [row] = await db.select().from(exercisePrefs).where(eq(exercisePrefs.id, `${userId}:${exerciseId}`)).limit(1);
  return {
    exerciseId,
    rating: ratingOf(row?.rating),
    excluded: row?.excluded ?? false,
    pinned: row?.pinned ?? false,
    introducedOn: row?.introducedOn ?? null,
  };
}
