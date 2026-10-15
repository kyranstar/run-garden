/**
 * search_library(query, filters) and get_exercise(id) — the exercise library (Stage 3 spec §4; principles §4, §6.2).
 *
 *  - search_library: the Studio's own search (`searchLibrary`, @rg/exercise-library: text tiers, then condition fit,
 *    then the athlete's lean) over the whole library, with the vocabulary filters, a place's gear, and "fits today".
 *    Each move: its card line, patterns, purposes, contraction, primary muscles, dose range, gear, difficulty, how it
 *    fits today with the reason (the library's one `fitToday` rule, the Studio's too: every switched-on profile
 *    against today's reading — fits even on a flare day · with care, within the profile's limits · not today), when
 *    the athlete last did it, how often in 30 days, whether they have done it cleanly (`isDoneCleanly`, the
 *    validator's unlock rule, over `doneStats`), and their rating and pin. Moves the athlete set aside ("not for me")
 *    are left out and counted. A move they saved from outside has its name marked. A page that fits, paged by
 *    position (the library does not change during a run). Two statements.
 *  - get_exercise: one record — dose, notes for the switched-on profiles, safety and today's fit, easier and harder by
 *    name; the how-to text only with `howTo` — with the athlete's history: their rating, pin and set-aside, how many
 *    sessions, the last five sessions' sets, and their best. Three statements.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { exercisePrefs, exerciseProvenance, performedSessions, performedSets } from "@rg/database";
import { addDays } from "@rg/domain";
import {
  CONTRACTIONS,
  EQUIPMENT_IDS,
  EXERCISES,
  FIT_RANK,
  fitToday,
  hasEquipment,
  isDoneCleanly,
  LATERALITY,
  MUSCLES,
  PATTERNS,
  POSITIONS,
  PURPOSES,
  REGIONS,
  ROLES,
  searchLibrary,
  TAGS,
  THEMES,
  type ExerciseRecord,
  type LibraryFilters,
} from "@rg/exercise-library";
import { namedFromRow, ownPlaceSql } from "../default-place.js";
import { doneStats, safetyFor } from "../library-view.js";
import { PENDING_HASH } from "../watch-sets.js";
import type { DesignTool } from "./types.js";
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
  untrusted,
  weightWords,
  type Athlete,
} from "./read-common.js";
import { movesOf, sessionRows, sessionsOnce, setRows } from "./read-sessions.js";

const byId = new Map(EXERCISES.map((e) => [e.id, e]));

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

/** A move's name: the library's own words, marked when the athlete saved the move from outside. */
const nameOf = (ex: ExerciseRecord, saved: ReadonlySet<string>) => (saved.has(ex.id) ? untrusted(ex.name) : ex.name);

// ── search_library ──────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]];

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
  .object({ query: z.string().max(80).optional(), filters: filters.optional(), limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() })
  .strict();

const enumSchema = (values: readonly string[]) => ({ type: "string", enum: [...values] });

export const searchLibraryTool: DesignTool = {
  name: "search_library",
  description:
    "Search the exercise library by text and filters, best match first: each move with patterns, purposes, contraction, muscles, dose range, gear, today's fit and the athlete's history with it. Pages by position.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words: a name, muscle, region, purpose or tag. Empty: every move." },
      filters: {
        type: "object",
        properties: {
          pattern: enumSchema(PATTERNS),
          region: enumSchema(REGIONS),
          role: enumSchema(ROLES),
          equipment: enumSchema(EQUIPMENT_IDS),
          purpose: enumSchema(PURPOSES),
          tag: enumSchema(TAGS),
          theme: enumSchema(THEME_IDS),
          muscle: enumSchema(MUSCLES),
          contraction: enumSchema(CONTRACTIONS),
          position: enumSchema(POSITIONS),
          laterality: enumSchema(LATERALITY),
          maxDifficulty: { type: "integer", minimum: 1, maximum: 5 },
          place: { type: "string", description: "A place id (read_profile), home, gym, mat, or \"none\" for no equipment: only moves its gear allows." },
          fitToday: { type: "boolean", description: "Only moves today's condition readings allow." },
        },
        additionalProperties: false,
      },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
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
      ...(f.place ? { place: ownPlaceSql(ctx.userId, f.place) } : {}),
    });
    // A place's gear by the one rule validate_workout reads it by (default-place.ts).
    let gear: string[] | null = null;
    if (f.place) {
      const place = namedFromRow(f.place, extra.place);
      if (!place) {
        return refuse("unknown_place", `No place with id ${JSON.stringify(f.place)}.`, 'Use a place id from read_profile, home, gym or mat, or "none" for no equipment.');
      }
      gear = place.equipment;
    }
    const prefs = prefsOf(extra.movePrefs);
    const saved = new Set(parsedArray(extra.saved).filter((x): x is string => typeof x === "string"));
    const done = await doneStats(ctx.db, ctx.userId, addDays(athlete.today, -29), athlete.today);

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
    const matches = searchLibrary(EXERCISES, query, libFilters, ctxOf(false));
    const setAside = EXERCISES.filter((ex) => prefs.get(ex.id)?.excluded);
    const setAsideHidden = setAside.length ? searchLibrary(setAside, query, libFilters, ctxOf(true)).length : 0;
    const limit = p.limit ?? DEFAULT_LIMIT;
    const missing: string[] = [...athlete.missing];
    if (matches.length === 0) missing.push(`no move matches${query ? ` "${query}"` : ""} with these filters`);
    // Paged by position: the library and the athlete's marks on it do not change during a run.
    return pagedAnswer({
      source: "the exercise library, today's condition checks and the athlete's logged sets and exercise preferences",
      now: ctx.now,
      missing,
      rows: matches.slice(offset, offset + limit + 1),
      limit,
      render: (ex) => {
        const d = done.get(ex.id);
        const pr = prefs.get(ex.id);
        const fit = fitOf(ex);
        return {
          id: ex.id,
          name: nameOf(ex, saved),
          summary: ex.text.summary,
          patterns: ex.patterns,
          purposes: ex.purposes,
          contraction: ex.contraction,
          muscles: ex.muscles.primary,
          dose: doseWords(ex.dose),
          gear: gearWords(ex),
          difficulty: ex.difficulty,
          ...(fit ? { fit: fit.state, fitWhy: fit.reason } : {}),
          lastDone: d?.last ?? null,
          done30d: d?.n30 ?? 0,
          doneCleanly: isDoneCleanly(d ? { lastDate: d.last, logged: d.logged, flags: d.flags } : null, athlete.profiles),
          ...(pr?.rating ? { rating: pr.rating } : {}),
          ...(pr?.pinned ? { pinned: true } : {}),
        };
      },
      cursorOf: (_ex, i) => encodeCursor([offset + i]),
      data: (moves) => ({ query, matched: matches.length, setAsideHidden, moves }),
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
    "One library move whole — dose, condition notes, safety and today's fit, easier and harder moves — with the athlete's history and best; its how-to text only when asked.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "A library id from search_library." },
      howTo: { type: "boolean", description: "Also the how-to: setup, steps, focus, mistakes, breathing, why. Default: the one-line summary only." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  statementCost: 3,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(exerciseInput, raw, "a library id, and optionally howTo");
    if (isErr(p)) return p;
    const ex = byId.get(p.id) ?? EXERCISES.find((e) => e.legacyIds.includes(p.id));
    if (!ex) return refuse("not_found", `The library has no move with id ${JSON.stringify(p.id)}.`, "Use an id from search_library.");
    const ids = jsonList([ex.id, ...ex.legacyIds]);
    const s = performedSessions;
    const x = performedSets;
    const mine = sql`${s.userId} = ${ctx.userId} and ${s.payloadHash} != ${PENDING_HASH} and ${x.done} = 1 and ${x.exerciseId} in ${ids}`;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      movePrefs: sql`(select json_group_array(json_object('id', ${exercisePrefs.exerciseId}, 'rating', ${exercisePrefs.rating}, 'pinned', ${exercisePrefs.pinned},
          'excluded', ${exercisePrefs.excluded}, 'introducedOn', ${exercisePrefs.introducedOn}))
          from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId} and ${exercisePrefs.exerciseId} = ${ex.id})`,
      saved: sql`(select count(*) from ${exerciseProvenance} where ${exerciseProvenance.userId} = ${ctx.userId} and ${exerciseProvenance.exerciseId} in ${ids})`,
      totals: sql`(select json_object('sessions', count(distinct ${s.id}), 'last', max(${s.localDate}), 'reps', max(${x.reps}), 'secs', max(${x.seconds}))
          from ${x} join ${s} on ${s.id} = ${x.performedSessionId} where ${mine})`,
      heaviest: sql`(select json_object('v', ${x.loadValue}, 'u', ${x.loadUnit}, 'r', ${x.reps})
          from ${x} join ${s} on ${s.id} = ${x.performedSessionId} where ${mine} and ${x.loadKg} > 0
          order by ${x.loadKg} desc, ${x.reps} desc limit 1)`,
    });
    const recentRows = (await ctx.db.all(sql`
      select ${s.id} as id, ${s.localDate} as date, ${s.startedAt} as startedAt, ${s.activityId} as activityId, ${s.source} as source,
             ${s.createdAt} as createdAt, ${x.entryIndex} as e, ${x.setIndex} as i, ${x.exerciseId} as ex, ${x.reps} as r, ${x.seconds} as sec,
             ${x.loadValue} as v, ${x.loadUnit} as u, ${x.side} as side, ${x.perSide} as ps, ${x.flags} as f
      from ${x} join ${s} on ${s.id} = ${x.performedSessionId}
      where ${mine} and ${s.id} in (
        select recent.id from performed_sessions recent
        where recent.user_id = ${ctx.userId} and recent.payload_hash != ${PENDING_HASH} and exists (
          select 1 from performed_sets logged where logged.performed_session_id = recent.id and logged.done = 1 and logged.exercise_id in ${ids})
        order by recent.local_date desc, recent.started_at desc limit ${RECENT_READ})`)) as Array<Record<string, unknown>>;
    const done = await doneStats(ctx.db, ctx.userId, addDays(athlete.today, -29), athlete.today);

    // A row per set: each session once.
    const sessionOnce = [...new Map(recentRows.map((r) => [r.id, { ...r, movesDone: "[]" }])).values()];
    const sessions = sessionsOnce(sessionRows(sessionOnce))
      .sort((a, b) => `${b.date} ${b.startedAt ?? ""}`.localeCompare(`${a.date} ${a.startedAt ?? ""}`))
      .slice(0, RECENT_SESSIONS);
    const sets = setRows(recentRows.map((r) => ({ ...r, s: r.id })));
    const recent = sessions.map((sess) => `${sess.date} ${movesOf(sets.filter((st) => st.session === sess.id), athlete.prefs.weightUnit).map((m) => m.words).join("; ")}`);

    const pref = prefsOf(extra.movePrefs).get(ex.id);
    const savedMove = Number(extra.saved) > 0;
    const totals = (parsedJson(extra.totals) ?? {}) as { sessions?: number; last?: string | null; reps?: number | null; secs?: number | null };
    const heaviest = parsedJson(extra.heaviest) as { v?: number; u?: string; r?: number | null } | null;
    const best: string[] = [];
    const heaviestWords = heaviest?.v ? weightWords(heaviest.v, heaviest.u, athlete.prefs.weightUnit) : null;
    if (heaviestWords) best.push(`heaviest ${heaviestWords}${heaviest?.r ? ` × ${heaviest.r}` : ""}`);
    else if (totals.reps) best.push(`most reps ${totals.reps}`);
    if ((ex.dose.type === "time" || ex.dose.type === "carry") && totals.secs) best.push(`longest ${totals.secs} s`);
    const d = done.get(ex.id);
    const fit = fitFor(ex, athlete);
    const { conditions: notes, ...howTo } = ex.text;
    const named = (list: readonly string[]) => list.flatMap((id) => (byId.has(id) ? [{ id, name: byId.get(id)!.name }] : []));

    const missing: string[] = [...athlete.missing];
    if (!totals.sessions) missing.push("the athlete has not logged this move");
    return answer({
      source: "the exercise library, today's condition checks and the athlete's logged sets and exercise preferences",
      now: ctx.now,
      missing,
      data: {
        id: ex.id,
        name: savedMove ? untrusted(ex.name) : ex.name,
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
        safety: Object.fromEntries(athlete.profiles.map((pr) => [pr.id, safetyFor(pr, ex)])),
        ...(fit ? { fit: fit.state, fitWhy: fit.reason } : {}),
        summary: ex.text.summary,
        conditionNotes: athlete.profiles.flatMap((pr) => (notes[pr.id] ? [{ profile: pr.label, note: notes[pr.id] }] : [])),
        easier: named(ex.easier),
        harder: named(ex.harder),
        yours: {
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
        ...(p.howTo ? { howTo } : {}),
      },
      summary: `Read ${ex.name}${totals.sessions ? ` and ${plural(totals.sessions, "session")} of history` : ""}`,
    });
  },
};
