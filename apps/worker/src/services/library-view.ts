/**
 * THE EXERCISE LIBRARY AS THE ATHLETE BROWSES IT (Phase 2 spec §2c "Library API"; plan Task 1).
 *
 *   listLibrary      slim rows, filtered and ranked by `searchLibrary` (the package's pure search, shared with the
 *                    Studio): text, movement, body area, role, gear, purpose, tag, theme, muscle, contraction,
 *                    position, laterality, difficulty, a place's gear, and "safe for every switched-on profile", best
 *                    match first, cut to `limit`. Each row carries the card line, purposes, contraction, tags, primary
 *                    muscles, the day the athlete last did it and how many sessions did it in 30 days (logged sets and
 *                    played-only moves alike), whether they have done it CLEANLY (`doneCleanly`: the library's one
 *                    rule for what unlocks the next rung, `isDoneCleanly`, over the same tally the engine and the
 *                    document validator read), its safety per switched-on profile, the athlete's rating, "not for
 *                    me", pin, whether it came from their saves, and the gear the default place lacks for it; plus
 *                    what each wishlist item would unlock at the default place
 *   libraryItem      one record whole (how-to, dose, notes for switched-on profiles, easier/harder by name, where a
 *                    saved move came from) with the athlete's last five entries and best set
 *   setExercisePrefs `{rating?, excluded?, pinned?}` → `exercise_prefs`, the row the review save writes
 *                    (`${userId}:${exerciseId}`), changing only the fields sent
 *   listPersonalMoves the owner's own moves (saved-posts import): each active and archived one whole, with its links
 *
 * THE ACCOUNT'S LIBRARY (saved-posts import, Task 13; account-library.ts): the list searches what the athlete is offered
 * (`offered`: the public library and their active personal moves); one move reads by any id the account's library
 * resolves (`all`: an archived move too, a merged one as its target); a say on a move is taken for a public move or an
 * active personal one — an archived move is never offered, so it is never pinned anew.
 *
 * The library's own data never carries provenance (it is public); a saved move's links live in `exercise_provenance`,
 * the account's own, and only the detail returns them. No payload carries `providers` internals.
 *
 * Safety, per switched-on profile: `never` when the profile allows the move in no mode even on its calmest day,
 * `safe` when it is also safe on a flare day (`flareSafe`), else `care` (allowed with limits — a mode, the day's reading).
 * The profile's whole-record rule (`allowRecord`, e.g. the jaw profile's plyometric gate) counts: a move it refuses in
 * every mode reads `never`; one it allows only on a calm, answered check reads `care`, never `safe`.
 * "Unlocks": a move the default place's gear cannot do now, that the gear would make doable, that the athlete has not
 * set aside and that no switched-on profile rules out.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { exercisePrefs, exerciseProvenance, performedSessions, performedSets } from "@rg/database";
import { addDays, todayInZone, toKg, type Weight } from "@rg/domain";
import {
  bestDay,
  EQUIPMENT,
  EQUIPMENT_IDS,
  EXERCISES,
  hasEquipment,
  isDoneCleanly,
  MODE_IDS,
  profileById,
  recordFlareSafe,
  searchLibrary,
  type LibraryFilters,
  type ConditionProfile,
  type EquipmentId,
  type ExerciseRecord,
} from "@rg/exercise-library";
import { isPersonalId } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { forgetAccountLibrary, loadAccountLibrary } from "./account-library.js";
import { restoreInProgress } from "./account-state.js";
import { activeProfileIds } from "./condition-views.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, type Db } from "./db.js";
import { defaultPlace as sharedDefaultPlace, namedPlace } from "./default-place.js";
import { RestoreInProgressError } from "./programs.js";
import { PENDING_HASH } from "./watch-sets.js";

export type Safety = "safe" | "care" | "never";

export interface LibraryQuery extends LibraryFilters {
  q?: string;
  /** A place id of this user's, or one of the library's presets. */
  location?: string;
  /** Only moves safe on a flare day for every switched-on profile. */
  safe?: boolean;
  /** Rows to return (default 50, at most 500); `matched` on the list says how many matched. */
  limit?: number;
}

export const DEFAULT_LIBRARY_LIMIT = 50;
/**
 * The most rows one list returns: the Studio reads the athlete's say on every move it offers in ONE read, and what it
 * offers is the public library (175 moves) and the athlete's active own moves (up to ~300).
 */
export const MAX_LIBRARY_LIMIT = 500;

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
  /**
   * Done cleanly (`isDoneCleanly` over its tally, legacy ids merged): done, and logged at least once without each
   * switched-on profile's set flag (a rung only ever done clenched unlocks nothing). The Studio's builder reads it as the
   * validator's `DayContext.done`, so a jump past the frontier is noted there as it is on the server.
   */
  doneCleanly: boolean;
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

/** A public move by its own id (never an old one): what a say on a move was always taken for. */
const publicMove = new Map(EXERCISES.map((e) => [e.id, e]));

/** A profile's verdict on a move (see the header). An unrated move reads as `never`: it fails closed. */
export function safetyFor(profile: ConditionProfile, ex: ExerciseRecord): Safety {
  const a = ex.conditions[profile.id];
  if (!a || profile.never(a)) return "never";
  const calm = bestDay(profile);
  const someMode = MODE_IDS.some(
    (mode) => profile.fitsMode(a, mode, ex) && ex.patterns.every((p) => profile.allowPattern(p, mode, calm)) && (profile.allowRecord?.(ex, mode, calm) ?? true),
  );
  if (!someMode) return "never";
  // The library's one flare-safe verdict: a move the record rule refuses on a flare day is never "safe", whatever its
  // ratings read.
  return recordFlareSafe(profile, ex) ? "safe" : "care";
}

const safetyOf = (profiles: readonly ConditionProfile[], ex: ExerciseRecord): Record<string, Safety> =>
  Object.fromEntries(profiles.map((p) => [p.id, safetyFor(p, ex)]));

/** The default place's id, name and gear (default-place.ts: the one rule every reader shares). */
async function defaultPlace(db: Db, userId: string): Promise<{ id: string; name: string; equipment: string[] }> {
  const p = await sharedDefaultPlace(db, userId);
  return { id: p.id, name: p.name, equipment: p.equipment };
}

/** A place's gear by id: one of this user's places, a library preset, or "No equipment" (default-place.ts). */
async function placeEquipment(db: Db, userId: string, id: string): Promise<string[]> {
  const p = await namedPlace(db, userId, id);
  if (!p) throw new UnknownPlaceError();
  return p.equipment;
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

/** What one move's settled work says: its last day, its sessions in 30 days, and the tally `isDoneCleanly` reads. */
export interface DoneStat {
  last: string | null;
  n30: number;
  /** Logged entries (an entry index with a done set), up to today. */
  logged: number;
  /** Logged entries carrying each flag, up to today. */
  flags: Record<string, number>;
}

/**
 * Per move, from ONE compound read:
 *  - the latest settled day and the sessions in the last 30 days, from the logged sets (done ones) and the moves a
 *    session reached (`moves_done`, which also holds played-only moves such as mobility and breathing) — a move logged
 *    and played in one session counts once;
 *  - the tally `isDoneCleanly` reads, exactly as the engine's history summary counts it (`historyRows`,
 *    engine-inputs.ts): an entry is the sets with one entry index, named by its first set, and it counts only with a
 *    done set; `logged` is the entries up to today, each flag the entries any of whose sets carries it.
 * Legacy ids are merged into the move they now are, in `library` (the account's `all`: a merged personal move's into its
 * target; the public library's by default). Shared with a document workout's build (session-build.ts), which reads the
 * jumps done cleanly from it (`doneCleanlyOf`) for the frontier its ⇄ honours.
 */
export async function doneStats(
  db: Db,
  userId: string,
  since: string,
  today: string,
  library: readonly ExerciseRecord[] = EXERCISES,
): Promise<Map<string, DoneStat>> {
  const rows = (await db.all(sql`
    with e as (
      -- Logged entries (with a done set). With exactly one MIN() in a query, SQLite takes the bare columns from the
      -- row holding the minimum: the entry's first set.
      select ${performedSets.performedSessionId} as sid, ${performedSets.entryIndex} as ei, ${performedSets.exerciseId} as ex,
             ${performedSessions.localDate} as day, min(${performedSets.setIndex}) as first_set
      from ${performedSets} inner join ${performedSessions} on ${performedSessions.id} = ${performedSets.performedSessionId}
      where ${performedSessions.userId} = ${userId} and ${performedSessions.payloadHash} != ${PENDING_HASH}
      group by ${performedSets.performedSessionId}, ${performedSets.entryIndex}
      having sum(${performedSets.done}) > 0
    ),
    work as (
      select ${performedSets.exerciseId} as exercise_id, ${performedSessions.localDate} as day, ${performedSessions.id} as sid
      from ${performedSets} inner join ${performedSessions} on ${performedSessions.id} = ${performedSets.performedSessionId}
      where ${performedSessions.userId} = ${userId} and ${performedSessions.payloadHash} != ${PENDING_HASH} and ${performedSets.done} = 1
      union all
      select case when m.type = 'object' then json_extract(m.value, '$.exerciseId') end, ${performedSessions.localDate}, ${performedSessions.id}
      from ${performedSessions},
        json_each(case when json_valid(${performedSessions.movesDone}) then ${performedSessions.movesDone} else '[]' end) as m
      where ${performedSessions.userId} = ${userId} and ${performedSessions.payloadHash} != ${PENDING_HASH}
    )
    select 'done' as kind, exercise_id as exerciseId, max(day) as last, count(distinct case when day >= ${since} then sid end) as n, null as flag
    from work where exercise_id is not null group by exercise_id
    union all
    select 'logged', ex, null, count(*), null from e where ex <> '' and day <= ${today} group by ex
    union all
    select 'flag', ex, null, count(*), flag from (
      select distinct e.sid, e.ei, e.ex, e.day, j.value as flag
      from e join ${performedSets} ps on ps.performed_session_id = e.sid and ps.entry_index = e.ei,
        json_each(case when json_valid(ps.flags) then ps.flags else '[]' end) as j
    ) where ex <> '' and day <= ${today} group by ex, flag`)) as Array<{
    kind: "done" | "logged" | "flag";
    exerciseId: string;
    last: string | null;
    n: number;
    flag: string | null;
  }>;
  const out = new Map<string, DoneStat>();
  const find = makeLibraryIndex(library);
  for (const r of rows) {
    const id = find(r.exerciseId)?.id ?? r.exerciseId;
    const cur = out.get(id) ?? { last: null, n30: 0, logged: 0, flags: {} };
    if (r.kind === "done") {
      if (r.last && (!cur.last || r.last > cur.last)) cur.last = r.last;
      cur.n30 += Number(r.n);
    } else if (r.kind === "logged") cur.logged += Number(r.n);
    else if (r.flag) cur.flags[r.flag] = (cur.flags[r.flag] ?? 0) + Number(r.n);
    out.set(id, cur);
  }
  return out;
}

/** The moves among `ids` done cleanly (`isDoneCleanly`, the engine's unlock rule), by `doneStats`' tally. */
export function doneCleanlyOf(stats: ReadonlyMap<string, DoneStat>, profiles: readonly ConditionProfile[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const d = stats.get(id);
    if (d && isDoneCleanly({ lastDate: d.last, logged: d.logged, flags: d.flags }, profiles)) out.add(id);
  }
  return out;
}

export async function listLibrary(db: Db, userId: string, query: LibraryQuery): Promise<LibraryList> {
  const [active, prefRows, savedRows, place, userPrefs, library] = await Promise.all([
    activeProfileIds(db, userId),
    db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId)),
    db.select({ exerciseId: exerciseProvenance.exerciseId }).from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId)),
    defaultPlace(db, userId),
    loadPreferences(db, userId),
    loadAccountLibrary(db, userId),
  ]);
  // What the athlete may be offered: the public library and their active personal moves (an archived one never).
  const offered = library.offered;
  const at = query.location ? await placeEquipment(db, userId, query.location) : null;
  const profiles = active.map(profileById);
  const prefs = new Map(prefRows.map((r) => [r.exerciseId, r]));
  const saved = new Set(savedRows.map((r) => r.exerciseId));
  const today = todayInZone(userPrefs.timezone);
  const done = await doneStats(db, userId, addDays(today, -29), today, library.all);

  const safeOf = new Map(offered.map((ex) => [ex.id, safetyOf(profiles, ex)]));
  const { q, location: _location, safe, limit, ...filters } = query;
  const matches = searchLibrary(offered, q ?? "", filters, {
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
      doneCleanly: isDoneCleanly(d ? { lastDate: d.last, logged: d.logged, flags: d.flags } : null, profiles),
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
      unlocks: offered.filter(
        (ex) =>
          !hasEquipment(ex, place.equipment) &&
          hasEquipment(ex, [...place.equipment, equipmentId]) &&
          !excluded.has(ex.id) &&
          profiles.every((p) => safetyFor(p, ex) !== "never"),
      ).length,
    }));

  return {
    total: offered.length,
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

/** The moves `ids` name that the library resolves, by name (an easier or harder step it no longer has is left out). */
const named = (find: (id: string) => ExerciseRecord | undefined, ids: readonly string[]) =>
  ids.flatMap((id) => {
    const ex = find(id);
    return ex ? [{ id, name: ex.name }] : [];
  });

/** One move whole, by its id in the account's library (`all`: an archived personal move too); a pending one is not here. */
export async function libraryItem(db: Db, userId: string, id: string): Promise<LibraryItem> {
  const library = await loadAccountLibrary(db, userId);
  const find = makeLibraryIndex(library.all);
  // A move by its own id (an old one is not this read's), the public library's or the account's own.
  const ex = find(id);
  if (!ex || ex.id !== id) throw new LibraryItemNotFoundError();
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
    easier: named(find, ex.easier),
    harder: named(find, ex.harder),
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
 *
 * Taken for a public move or an ACTIVE personal move of the account (by its own id): an unknown, pending, archived or
 * merged one is `LibraryItemNotFoundError` — an archived move is never offered, so it is never pinned anew. A personal
 * id reads the account's library (one statement); a public one none.
 */
export async function setExercisePrefs(db: Db, userId: string, exerciseId: string, patch: PrefsPatch, now: string): Promise<ExercisePrefsView> {
  if (!publicMove.has(exerciseId)) {
    if (!isPersonalId(exerciseId)) throw new LibraryItemNotFoundError();
    const offered = makeLibraryIndex((await loadAccountLibrary(db, userId)).offered);
    if (offered(exerciseId)?.id !== exerciseId) throw new LibraryItemNotFoundError();
  }
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
  // A pin decides the engine's pool of personal moves: a later read in this request reads it.
  forgetAccountLibrary(db, userId);
  const [row] = await db.select().from(exercisePrefs).where(eq(exercisePrefs.id, `${userId}:${exerciseId}`)).limit(1);
  return {
    exerciseId,
    rating: ratingOf(row?.rating),
    excluded: row?.excluded ?? false,
    pinned: row?.pinned ?? false,
    introducedOn: row?.introducedOn ?? null,
  };
}

/** One of the owner's own moves (`GET /api/library/personal`): its record whole, whether it is offered, its links. */
export interface PersonalMoveView {
  record: ExerciseRecord;
  status: "active" | "archived";
  /** The saved posts it came from — its own, and those of any move merged into it — oldest first. */
  links: Array<{ url: string | null; creator: string | null }>;
}

/** A move merged into another (`GET /api/library/personal`): its id, and the move that answers for it now. */
export interface MergedMoveView {
  id: string;
  /** Its final target: an active or archived move of the account's, or a public move. */
  into: string;
}

/**
 * The account's merged moves and their final targets, as the library reads them: each merged id is among its target's
 * `legacyIds` in `all` (a personal target's, or — merged into a public move — the public record's there).
 */
function mergedOf(all: readonly ExerciseRecord[]): MergedMoveView[] {
  const out: MergedMoveView[] = [];
  for (const r of all) for (const id of r.legacyIds) if (id !== r.id && isPersonalId(id)) out.push({ id, into: r.id });
  return out;
}

/**
 * The owner's own moves (saved-posts import): every active and archived one — never a pending one (the review's) nor
 * a merged one (its target stands for it, with its links) — by name; and each merged move with the move that answers
 * for it (`merged`), so the device resolves a merged id as the Worker does, a move merged into a public one too. Two
 * statements: the account's library (`loadAccountLibrary`, which holds the records), then their links
 * (`exercise_provenance`, one bound list of ids).
 */
export async function listPersonalMoves(db: Db, userId: string): Promise<{ moves: PersonalMoveView[]; merged: MergedMoveView[] }> {
  const library = await loadAccountLibrary(db, userId);
  const merged = library.personalHash ? mergedOf(library.all) : [];
  const mine = library.all.filter((r) => isPersonalId(r.id));
  if (mine.length === 0) return { moves: [], merged };
  const offered = new Set(library.offered.filter((r) => isPersonalId(r.id)).map((r) => r.id));
  const ids = mine.flatMap((r) => [r.id, ...r.legacyIds]);
  const rows = (await db.all(sql`
    select ${exerciseProvenance.exerciseId} as exerciseId, ${exerciseProvenance.url} as url, ${exerciseProvenance.creator} as creator
    from ${exerciseProvenance}
    where ${exerciseProvenance.userId} = ${userId} and ${exerciseProvenance.exerciseId} in (select value from json_each(${JSON.stringify(ids)}))
    order by ${exerciseProvenance.createdAt}, ${exerciseProvenance.id}`)) as Array<{ exerciseId: string; url: string | null; creator: string | null }>;
  const find = makeLibraryIndex(library.all);
  const links = new Map<string, PersonalMoveView["links"]>();
  for (const r of rows) {
    const id = find(r.exerciseId)?.id ?? r.exerciseId;
    links.set(id, [...(links.get(id) ?? []), { url: r.url, creator: r.creator }]);
  }
  const moves = mine
    .map((record): PersonalMoveView => ({ record, status: offered.has(record.id) ? "active" : "archived", links: links.get(record.id) ?? [] }))
    .sort((a, b) => a.record.name.localeCompare(b.record.name, "en", { sensitivity: "base" }) || a.record.id.localeCompare(b.record.id));
  return { moves, merged };
}
