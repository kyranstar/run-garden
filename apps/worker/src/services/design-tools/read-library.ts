/**
 * search_library(query, filters) and get_exercise(id) — the exercise library (Stage 3 spec §4; principles §4, §6.2).
 *
 *  - search_library: the coach's search (`agentSearch`, @rg/exercise-library, beside the Studio's `searchLibrary`:
 *    the moves with every word in the Studio's order, then — roles, patterns and themes counting as words — those with
 *    some of the words, most first, each naming the words it has; fix wave 13, I2) over the whole library, with the
 *    vocabulary filters (the schema offers only the values some move uses; any vocabulary value still reads), a
 *    place's gear, and "fits today". A zero says what emptied it: a word no move says, a value no move uses (with the
 *    gear the moves do use), filters that match nothing together, or the place, today's reading or the set-aside
 *    moves turning every match away. Each move, slim (about 200 bytes, I3(c)): what it is in one line (patterns ·
 *    purposes · contraction · primary muscles), dose range, gear, difficulty, how it fits today with the reason only
 *    when it isn't plain (the library's one `fitToday` rule, the Studio's too: every switched-on profile against
 *    today's reading — fits even on a flare day · with care, within the profile's limits · not today), the athlete's
 *    history with it in one line (how often in 30 days, when last, whether done cleanly — `isDoneCleanly`, the
 *    validator's unlock rule, over `doneStats`) only when there is some, their rating and pin; its card line only with
 *    `withSummary`. Moves the athlete set aside ("not for me") are left out and counted. A move they saved from outside
 *    has its name marked. A page that fits, paged by position (the library does not change during a run). Two
 *    statements.
 *  - get_exercise: one record — dose, notes for the switched-on profiles, safety and today's fit, easier and harder by
 *    name; the how-to text only with `howTo` — with the athlete's history: their rating, pin and set-aside, how many
 *    sessions, the last five sessions' sets, and their best. Three statements: the athlete with the account's library,
 *    what the athlete has of the move beside its last sessions' sets, and the done tally.
 *
 * THE ACCOUNT'S LIBRARY (saved-posts import, Task 13): search runs over what the athlete is offered (the public library
 * and their active personal moves; an archived one is never offered); get_exercise reads any move the account's library
 * resolves, an archived one too (Review Focus 4). A personal move is marked `yours` — with its links in get_exercise (each
 * with its note, spec §17: what the post says the move is for, marked), and `archived` when it is — and its words (a model's, from the athlete's saves) are marked untrusted. The library rides in
 * the athlete's statement (`personalMovesSql`), so it costs none. The schema's offered values stay the public library's.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { exercisePrefs, exerciseProvenance, performedSessions, performedSets } from "@rg/database";
import { addDays } from "@rg/domain";
import {
  agentSearch,
  CONTRACTIONS,
  EQUIPMENT_IDS,
  EXERCISES,
  FIT_RANK,
  fitToday,
  hasEquipment,
  isDoneCleanly,
  LATERALITY,
  MUSCLES,
  offeredValues,
  PATTERNS,
  POSITIONS,
  PURPOSES,
  REGIONS,
  ROLES,
  TAGS,
  THEMES,
  type ExerciseRecord,
  type LibraryFilters,
  type SearchFacet,
} from "@rg/exercise-library";
import { isPersonalId } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { accountLibraryFrom, personalMovesSql, UNCHECKED_RATINGS } from "../account-library.js";
import { namedFromRow, ownPlaceSql } from "../default-place.js";
import { doneStats, safetyFor, type DoneStat } from "../library-view.js";
import { PENDING_HASH } from "../watch-sets.js";
import type { DesignTool } from "./types.js";
import { PLACE_WORDS } from "./act-common.js";
import {
  answer,
  CURSOR_SCHEMA,
  cursorField,
  encodeCursor,
  isErr,
  jsonList,
  limitField,
  limitSchema,
  offsetCursor,
  pagedAnswer,
  parsedArray,
  parsedJson,
  parseInput,
  plural,
  READ_ROLES,
  readAthlete,
  refuse,
  relativeDay,
  untrusted,
  weightWords,
  untrustedOrNull,
  type Athlete,
} from "./read-common.js";
import { movesOf, sessionRows, sessionsOnce, setRows } from "./read-sessions.js";

/** Today's fit for the athlete: the library's one rule (`fitToday`, the Studio's list reads it too). */
const fitFor = (rec: ExerciseRecord, athlete: Pick<Athlete, "profiles" | "readings">) => fitToday(rec, athlete.profiles, athlete.readings);

const DOSE_UNIT: Record<ExerciseRecord["dose"]["type"], string> = { reps: "reps", time: "s", breaths: "breaths", carry: "s carried" };

/** The record's dose as a range: "5–8 reps, 2–4 sets", "30–45 s". */
function doseWords(dose: ExerciseRecord["dose"]): string {
  const [lo, hi] = dose.range;
  const sets = dose.sets ? `, ${dose.sets[0] === dose.sets[1] ? dose.sets[0] : `${dose.sets[0]}–${dose.sets[1]}`} sets` : "";
  return `${lo === hi ? lo : `${lo}–${hi}`} ${DOSE_UNIT[dose.type]}${sets}`;
}

// ── The athlete's own marks on moves ────────────────────────────────────────────────────────────────────────────────

interface Pref {
  rating: 1 | -1 | null;
  pinned: boolean;
  excluded: boolean;
  introducedOn: string | null;
}

const PREFS_SQL = (userId: string) =>
  sql`(select json_group_array(json_object('id', ${exercisePrefs.exerciseId}, 'rating', ${exercisePrefs.rating}, 'pinned', ${exercisePrefs.pinned},
      'excluded', ${exercisePrefs.excluded}, 'introducedOn', ${exercisePrefs.introducedOn}))
      from ${exercisePrefs} where ${exercisePrefs.userId} = ${userId})`;
const SAVED_SQL = (userId: string) =>
  sql`(select json_group_array(distinct ${exerciseProvenance.exerciseId}) from ${exerciseProvenance} where ${exerciseProvenance.userId} = ${userId})`;

function prefsOf(raw: unknown): Map<string, Pref> {
  return new Map(
    parsedArray(raw).flatMap((r) => {
      const x = r as Record<string, unknown>;
      if (typeof x.id !== "string") return [];
      const rating = typeof x.rating === "number" && x.rating !== 0 ? (x.rating > 0 ? 1 : -1) : null;
      return [[x.id, { rating, pinned: x.pinned === 1, excluded: x.excluded === 1, introducedOn: typeof x.introducedOn === "string" ? x.introducedOn : null }] as const];
    }),
  );
}

const gearWords = (ex: ExerciseRecord): string | null => {
  const parts = [...ex.equipment.all, ...(ex.equipment.oneOf.length ? [ex.equipment.oneOf.join(" or ")] : [])];
  return parts.length ? parts.join(", ") : null;
};

/** A move's name: the library's own words, marked when the athlete saved the move from outside (a personal move always). */
const nameOf = (ex: ExerciseRecord, saved: ReadonlySet<string>) => (saved.has(ex.id) || isPersonalId(ex.id) ? untrusted(ex.name) : ex.name);
/** A personal move's own words — a model's, from the athlete's saves — marked; the library's as they are. */
const wordsOf = (ex: ExerciseRecord, text: string) => (isPersonalId(ex.id) && text.trim() !== "" ? untrusted(text) : text);
/** Every string in a personal move's how-to marked (a list, item by item); the library's as it is. */
const howToOf = (ex: ExerciseRecord, howTo: Omit<ExerciseRecord["text"], "conditions">) =>
  isPersonalId(ex.id)
    ? Object.fromEntries(Object.entries(howTo).map(([k, v]) => [k, Array.isArray(v) ? v.map((t: string) => wordsOf(ex, t)) : typeof v === "string" ? wordsOf(ex, v) : v]))
    : howTo;

// ── search_library ──────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]];

// Every vocabulary value still reads — an older call, a guess — and one no move uses answers teachably (agentSearch's
// `empty`); the schema the model is shown offers only the values some move uses.
const filters = z
  .object({
    pattern: z.enum(PATTERNS).optional(),
    region: z.enum(REGIONS).optional(),
    role: z.enum(ROLES).optional(),
    equipment: z.enum(EQUIPMENT_IDS).optional(),
    purpose: z.enum(PURPOSES).optional(),
    tag: z.enum(TAGS).optional(),
    theme: z.enum(THEME_IDS).optional(),
    muscle: z.enum(MUSCLES).optional(),
    contraction: z.enum(CONTRACTIONS).optional(),
    position: z.enum(POSITIONS).optional(),
    laterality: z.enum(LATERALITY).optional(),
    maxDifficulty: z.number().int().min(1).max(5).optional(),
    place: z.string().min(1).max(120).optional(),
    fitToday: z.boolean().optional(),
  })
  .strict();
const searchInput = z
  .object({
    query: z.string().max(80).optional(),
    filters: filters.optional(),
    withSummary: z.boolean().optional(),
    limit: limitField(MAX_LIMIT).optional(),
    cursor: cursorField.optional(),
  })
  .strict();

/** A facet's values as the model is offered them: only those some move uses (never one that can only answer nothing). */
const offered = (facet: SearchFacet) => ({ type: "string", enum: offeredValues(EXERCISES, facet) });

/** What a move is, in one short line: its patterns · purposes · contraction · primary muscles. */
const isWords = (ex: ExerciseRecord): string => [ex.patterns, ex.purposes, ex.contraction, ex.muscles.primary].map((l) => l.join(", ")).join(" · ");

/** The athlete's history with a move, in one short line: "15× in 30 d, last yesterday, cleanly". */
function doneWords(d: DoneStat | undefined, cleanly: boolean, today: string): string | null {
  if (!d?.last) return null;
  return `${d.n30}× in 30 d, last ${relativeDay(d.last, today)}, ${cleanly ? "cleanly" : "not cleanly yet"}`;
}

export const searchLibraryTool: DesignTool = {
  name: "search_library",
  description:
    "Search the library, best match first: the moves with every word, then those with some (each lists its words in matched). Each move: what it is, dose, gear, difficulty, fit today when not plain, the athlete's history. A zero says why.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words: names, muscles, regions, purposes, roles, patterns, tags — up to 8 count. Empty: every move." },
      filters: {
        type: "object",
        properties: {
          pattern: offered("pattern"),
          region: offered("region"),
          role: offered("role"),
          equipment: offered("equipment"),
          purpose: offered("purpose"),
          tag: offered("tag"),
          theme: offered("theme"),
          muscle: offered("muscle"),
          contraction: offered("contraction"),
          position: offered("position"),
          laterality: offered("laterality"),
          maxDifficulty: { type: "integer", minimum: 1, maximum: 5 },
          place: { type: "string", description: `Only moves its gear allows: a place id (read_profile), ${PLACE_WORDS}.` },
          fitToday: { type: "boolean", description: "Only moves today's condition readings allow." },
        },
        additionalProperties: false,
      },
      withSummary: { type: "boolean", description: "Also each move's one-line card text. Default: without (get_exercise has it)." },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
  // Measured (design-cpu-bench gate 8, round 2): an 8-word search, fit today, 30 rows — scaled p50 0.55–0.61 ms, p95
  // 0.84–1.05. Declared at about its p95, so a queued step packs four (1d.q: five at 0.8 measured 4.2–4.8 of its 5 ms).
  cpuWeight: 1,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(searchInput, raw, "optionally query, filters (the listed vocabulary), limit and cursor");
    if (isErr(p)) return p;
    const offset = offsetCursor(p.cursor);
    if (isErr(offset)) return offset;
    const f = p.filters ?? {};
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      movePrefs: PREFS_SQL(ctx.userId),
      saved: SAVED_SQL(ctx.userId),
      library: personalMovesSql(ctx.userId),
      ...(f.place ? { place: ownPlaceSql(ctx.userId, f.place) } : {}),
    });
    const library = await accountLibraryFrom(ctx.db, ctx.userId, extra.library);
    // A place's gear by the one rule validate_workout reads it by (default-place.ts).
    let gear: string[] | null = null;
    if (f.place) {
      const place = namedFromRow(f.place, extra.place);
      if (!place) {
        return refuse("unknown_place", `No place with id ${JSON.stringify(f.place)}.`, `Use a place id from read_profile, or ${PLACE_WORDS}.`);
      }
      gear = place.equipment;
    }
    const prefs = prefsOf(extra.movePrefs);
    const saved = new Set(parsedArray(extra.saved).filter((x): x is string => typeof x === "string"));
    const done = await doneStats(ctx.db, ctx.userId, addDays(athlete.today, -29), athlete.today, library.all);

    const fits = new Map<string, ReturnType<typeof fitFor>>();
    const fitOf = (ex: ExerciseRecord) => {
      if (!fits.has(ex.id)) fits.set(ex.id, fitFor(ex, athlete));
      return fits.get(ex.id)!;
    };
    const { place: _place, fitToday: onlyFit, ...vocab } = f;
    const libFilters: LibraryFilters = vocab;
    const passes = (ex: ExerciseRecord) => (!gear || hasEquipment(ex, gear)) && (!onlyFit || fitOf(ex)?.state !== "not");
    const ctxOf = (keepSetAside: boolean) => ({
      accepts: (ex: ExerciseRecord) => passes(ex) && (keepSetAside || !prefs.get(ex.id)?.excluded),
      fit: (ex: ExerciseRecord) => FIT_RANK[fitOf(ex)?.state ?? "fits"],
      boost: (id: string) => {
        const pr = prefs.get(id);
        return pr ? (pr.pinned ? 2 : 0) + (pr.rating ?? 0) : 0;
      },
    });
    const query = p.query ?? "";
    // What the athlete is offered: an archived personal move is never found.
    const found = agentSearch(library.offered, query, libFilters, ctxOf(false));
    const matches = found.hits;
    const setAside = library.offered.filter((ex) => prefs.get(ex.id)?.excluded);
    // Only how many: no diagnosis of a zero (round 3, R2-M1).
    const setAsideHidden = setAside.length ? agentSearch(setAside, query, libFilters, ctxOf(true), { explain: false }).hits.length : 0;
    const limit = p.limit ?? DEFAULT_LIMIT;
    const missing: string[] = [...athlete.missing];
    if (matches.length === 0) {
      if (found.turnedAway > 0) {
        const by = [...(f.place ? ["the place's gear"] : []), ...(onlyFit ? ["today's condition reading"] : []), "the moves the athlete set aside"];
        missing.push(`${plural(found.turnedAway, "move")} match, but none fits ${by.join(" or ")}`);
      } else {
        missing.push(...found.empty);
      }
    }
    // Paged by position: the library and the athlete's marks on it do not change during a run.
    return pagedAnswer({
      source: "the exercise library, today's condition checks and the athlete's logged sets and exercise preferences",
      now: ctx.now,
      missing,
      rows: matches.slice(offset, offset + limit + 1),
      limit,
      // Slim (fix wave 13, I3(c)): about 200 bytes a move that fits — the card line only when asked, today's fit only
      // when it isn't plain, the history only when there is some.
      render: ({ record: ex, matched }) => {
        const d = done.get(ex.id);
        const pr = prefs.get(ex.id);
        const fit = fitOf(ex);
        const gear = gearWords(ex);
        const history = doneWords(d, isDoneCleanly(d ? { lastDate: d.last, logged: d.logged, flags: d.flags } : null, athlete.profiles), athlete.today);
        return {
          id: ex.id,
          name: nameOf(ex, saved),
          ...(isPersonalId(ex.id) ? { yours: true } : {}),
          is: isWords(ex),
          dose: doseWords(ex.dose),
          ...(gear ? { gear } : {}),
          difficulty: ex.difficulty,
          ...(fit && fit.state !== "fits" ? { fit: fit.state, fitWhy: fit.reason } : {}),
          ...(history ? { done: history } : {}),
          ...(pr?.rating ? { rating: pr.rating } : {}),
          ...(pr?.pinned ? { pinned: true } : {}),
          ...(matched ? { matched } : {}),
          ...(p.withSummary ? { summary: wordsOf(ex, ex.text.summary) } : {}),
        };
      },
      cursorOf: (_h, i) => encodeCursor([offset + i]),
      // Past MAX_QUERY_WORDS a word is left out, never searched (round 2, C1): said back, so the coach can search again.
      data: (moves) => ({
        query,
        matched: matches.length,
        ...(found.words.length > 1 ? { allWords: found.allWords } : {}),
        ...(found.dropped.length ? { wordsLeftOut: found.dropped } : {}),
        setAsideHidden,
        moves,
      }),
      summary: () => `Searched the library${query ? ` for "${query}"` : ""} — ${plural(matches.length, "move")}`,
    });
  },
};

// ── get_exercise ────────────────────────────────────────────────────────────────────────────────────────────────────

const RECENT_SESSIONS = 5;
/** Sessions read for the recent list: room for a watch copy of a session the athlete also logged. */
const RECENT_READ = 8;

const exerciseInput = z.object({ id: z.string().min(1).max(80), howTo: z.boolean().optional() }).strict();

export const getExercise: DesignTool = {
  name: "get_exercise",
  description:
    "One move whole — a library id or a saved move's own — dose, condition notes, safety and today's fit, easier and harder moves, its saved-post links and notes, the athlete's history and best; its how-to only when asked.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "A library id from search_library, or a saved move's from read_saves." },
      howTo: { type: "boolean", description: "Also the how-to: setup, steps, focus, mistakes, breathing, why. Default: the one-line summary only." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  statementCost: 3,
  cpuWeight: 0.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(exerciseInput, raw, "a library id, and optionally howTo");
    if (isErr(p)) return p;
    // ONE: the athlete, with the account's library — a personal move's record is the account's own, an archived one too.
    const { athlete, extra: read } = await readAthlete(ctx.db, ctx.userId, ctx.now, { library: personalMovesSql(ctx.userId) });
    const library = await accountLibraryFrom(ctx.db, ctx.userId, read.library);
    const ex = makeLibraryIndex(library.all)(p.id);
    if (!ex) return refuse("not_found", `The library has no move with id ${JSON.stringify(p.id)}.`, "Use an id from search_library.");
    const own = isPersonalId(ex.id);
    const ids = jsonList([ex.id, ...ex.legacyIds]);
    const s = performedSessions;
    const x = performedSets;
    const mine = sql`${s.userId} = ${ctx.userId} and ${s.payloadHash} != ${PENDING_HASH} and ${x.done} = 1 and ${x.exerciseId} in ${ids}`;
    // TWO: what the athlete has of the move — their marks, its links, totals and heaviest set, one row — beside its last
    // sessions' sets (a row each; none, and the one row stands alone).
    const rows = (await ctx.db.all(sql`
      select k.movePrefs as movePrefs, k.links as links, k.totals as totals, k.heaviest as heaviest, rs.*
      from (select
        (select json_group_array(json_object('id', ${exercisePrefs.exerciseId}, 'rating', ${exercisePrefs.rating}, 'pinned', ${exercisePrefs.pinned},
          'excluded', ${exercisePrefs.excluded}, 'introducedOn', ${exercisePrefs.introducedOn}))
          from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId} and ${exercisePrefs.exerciseId} = ${ex.id}) as movePrefs,
        (select json_group_array(json_object('url', url, 'creator', creator, 'note', note)) from (
          select ${exerciseProvenance.url} as url, ${exerciseProvenance.creator} as creator, ${exerciseProvenance.note} as note from ${exerciseProvenance}
          where ${exerciseProvenance.userId} = ${ctx.userId} and ${exerciseProvenance.exerciseId} in ${ids}
          order by ${exerciseProvenance.createdAt}, ${exerciseProvenance.id})) as links,
        (select json_object('sessions', count(distinct ${s.id}), 'last', max(${s.localDate}), 'reps', max(${x.reps}), 'secs', max(${x.seconds}))
          from ${x} join ${s} on ${s.id} = ${x.performedSessionId} where ${mine}) as totals,
        (select json_object('v', ${x.loadValue}, 'u', ${x.loadUnit}, 'r', ${x.reps})
          from ${x} join ${s} on ${s.id} = ${x.performedSessionId} where ${mine} and ${x.loadKg} > 0
          order by ${x.loadKg} desc, ${x.reps} desc limit 1) as heaviest) k
      left join (
        select ${s.id} as id, ${s.localDate} as date, ${s.startedAt} as startedAt, ${s.activityId} as activityId, ${s.source} as source,
               ${s.createdAt} as createdAt, ${x.entryIndex} as e, ${x.setIndex} as i, ${x.exerciseId} as ex, ${x.reps} as r, ${x.seconds} as sec,
               ${x.loadValue} as v, ${x.loadUnit} as u, ${x.side} as side, ${x.perSide} as ps, ${x.flags} as f
        from ${x} join ${s} on ${s.id} = ${x.performedSessionId}
        where ${mine} and ${s.id} in (
          select recent.id from performed_sessions recent
          where recent.user_id = ${ctx.userId} and recent.payload_hash != ${PENDING_HASH} and exists (
            select 1 from performed_sets logged where logged.performed_session_id = recent.id and logged.done = 1 and logged.exercise_id in ${ids})
          order by recent.local_date desc, recent.started_at desc limit ${RECENT_READ})) rs on 1 = 1`)) as Array<Record<string, unknown>>;
    const extra = rows[0] ?? {};
    const recentRows = rows.filter((r) => typeof r.id === "string");
    // THREE: the done tally, its old ids (a merged move's too) the move's own.
    const done = await doneStats(ctx.db, ctx.userId, addDays(athlete.today, -29), athlete.today, library.all);

    // A row per set: each session once.
    const sessionOnce = [...new Map(recentRows.map((r) => [r.id, { ...r, movesDone: "[]" }])).values()];
    const sessions = sessionsOnce(sessionRows(sessionOnce))
      .sort((a, b) => `${b.date} ${b.startedAt ?? ""}`.localeCompare(`${a.date} ${a.startedAt ?? ""}`))
      .slice(0, RECENT_SESSIONS);
    const sets = setRows(recentRows.map((r) => ({ ...r, s: r.id })));
    const recent = sessions.map((sess) => `${sess.date} ${movesOf(sets.filter((st) => st.session === sess.id), athlete.prefs.weightUnit).map((m) => m.words).join("; ")}`);

    const pref = prefsOf(extra.movePrefs).get(ex.id);
    // A link's note (spec §17): what the post says the move is for, or when to do it — a model's reading, marked.
    const links = parsedArray(extra.links).flatMap((l) => {
      const x = l as { url?: unknown; creator?: unknown; note?: unknown } | null;
      return x ? [{ url: untrustedOrNull(x.url), creator: untrustedOrNull(x.creator), note: untrustedOrNull(x.note) }] : [];
    });
    const savedMove = links.length > 0;
    // Archived: resolved for its history, never offered.
    const archived = own && makeLibraryIndex(library.offered)(ex.id)?.id !== ex.id;
    const totals = (parsedJson(extra.totals) ?? {}) as { sessions?: number; last?: string | null; reps?: number | null; secs?: number | null };
    const heaviest = parsedJson(extra.heaviest) as { v?: number; u?: string; r?: number | null } | null;
    const best: string[] = [];
    const heaviestWords = heaviest?.v ? weightWords(heaviest.v, heaviest.u, athlete.prefs.weightUnit) : null;
    if (heaviestWords) best.push(`heaviest ${heaviestWords}${heaviest?.r ? ` × ${heaviest.r}` : ""}`);
    else if (totals.reps) best.push(`most reps ${totals.reps}`);
    if ((ex.dose.type === "time" || ex.dose.type === "carry") && totals.secs) best.push(`longest ${totals.secs} s`);
    const d = done.get(ex.id);
    const fit = fitFor(ex, athlete);
    // A saved move the athlete never edited: its ratings — and every verdict built on them — are the post's reading as a
    // model rated it from the video, said as such (coach-context audit I6; principles §2.9, weak evidence named weak).
    const unchecked = own && library.unchecked.has(ex.id);
    const rated = (words: string): string => (unchecked ? `${words} (rated from the post)` : words);
    const { conditions: notes, ...howTo } = ex.text;
    const find = makeLibraryIndex(library.all);
    const named = (list: readonly string[]) =>
      list.flatMap((id) => {
        const step = find(id);
        return step ? [{ id: step.id, name: nameOf(step, new Set()) }] : [];
      });

    const missing: string[] = [...athlete.missing];
    if (!totals.sessions) missing.push("the athlete has not logged this move");
    return answer({
      source: "the exercise library, today's condition checks and the athlete's logged sets and exercise preferences",
      now: ctx.now,
      missing,
      data: {
        id: ex.id,
        name: savedMove || own ? untrusted(ex.name) : ex.name,
        family: ex.family,
        patterns: ex.patterns,
        regions: ex.regions,
        roles: ex.roles,
        purposes: ex.purposes,
        contraction: ex.contraction,
        muscles: ex.muscles,
        equipment: ex.equipment,
        position: ex.position,
        laterality: ex.laterality,
        load: ex.load,
        dose: ex.dose,
        difficulty: ex.difficulty,
        tags: ex.tags,
        safety: Object.fromEntries(athlete.profiles.map((pr) => [pr.id, rated(safetyFor(pr, ex))])),
        ...(fit ? { fit: fit.state, fitWhy: unchecked ? `Rated from the post: ${fit.reason}` : fit.reason } : {}),
        ...(unchecked ? { ratings: UNCHECKED_RATINGS } : {}),
        summary: wordsOf(ex, ex.text.summary),
        conditionNotes: athlete.profiles.flatMap((pr) => (notes[pr.id] ? [{ profile: pr.label, note: wordsOf(ex, notes[pr.id]!) }] : [])),
        easier: named(ex.easier),
        harder: named(ex.harder),
        yours: {
          // The athlete's own move (from their saves), and whether it is archived (never offered); the links to the posts it
          // was saved from — any move's, a library move's too (the curated links and the ones Save wrote), marked.
          ...(own ? { own: true, ...(archived ? { archived: true } : {}) } : {}),
          ...(own || links.length > 0 ? { links } : {}),
          rating: pref?.rating ?? null,
          pinned: pref?.pinned ?? false,
          setAside: pref?.excluded ?? false,
          saved: savedMove,
          introducedOn: pref?.introducedOn ?? null,
          sessions: totals.sessions ?? 0,
          lastDone: totals.last ?? null,
          done30d: d?.n30 ?? 0,
          doneCleanly: isDoneCleanly(d ? { lastDate: d.last, logged: d.logged, flags: d.flags } : null, athlete.profiles),
          best: best.length ? best.join("; ") : null,
          recent,
        },
        ...(p.howTo ? { howTo: howToOf(ex, howTo) } : {}),
      },
      summary: `Read ${ex.name}${totals.sessions ? ` and ${plural(totals.sessions, "session")} of history` : ""}`,
    });
  },
};
