/**
 * WHAT THE REVIEW NEEDS OF THE HISTORY, AT START (Phase 2b Task 7; spec §2b "Review and save").
 *
 * The review runs on the phone after the last step — offline, where the history is not — and shows what the session
 * achieved (`Records.forSession`) and the core lifts it topped out (graduation offers). Both read the whole history.
 * So when the athlete starts (online, ruling 2b-R1) the player fetches this once and keeps it on the device:
 *
 *   records     `Records.baseline`: the history folded down to what one more session — on the build's day, playing only
 *               the build's moves and alternatives — can read (bests for those moves, the weeks it touches, the
 *               milestone counters). The review folds the session played onto it: the same answer as the whole
 *               history (packages/session-engine/test/records-baseline.test.ts).
 *   graduation  the program's block (when it is still the build's) and, per core lift the build plays, the newest
 *               logged entries progression reads (`Hist.TRIM.progressionEntries`, ties kept), ids made canonical;
 *               plus the harder moves those lifts graduate to, which the build's slice may not carry.
 *   prefs       the saved 👍 / 👎 / "not for me" of the build's moves, so the review's toggles start from them.
 *
 * Both are worked out in the database as summaries (ruling 2b-R11; below): the same statements and a bounded number of
 * rows from the first session to the thousandth (review-basis-summary.test.ts).
 *
 * A read: nothing is written. 404 for a slot that is not this user's; 409 `not_built` before there is a build.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { exercisePrefs, plannedWorkouts, programs } from "@rg/database";
import { addDays, adaptiveConfigSchema, isLocalDate, startOfIsoWeek, type WeightUnit } from "@rg/domain";
import { EXERCISES, type EngineData, type ExerciseRecord } from "@rg/exercise-library";
import { Hist, Lib, Records, type Block, type HistorySession, type RecordsState } from "@rg/session-engine";
import { activeProfileIds } from "./condition-views.js";
import { chunkIds, type Db } from "./db.js";
import { loadProgramState, loadSessionsById } from "./engine-inputs.js";
import { engineDataFor, loadSession, NotBuiltError, SessionNotFoundError, type ExerciseSlice } from "./session-build.js";
import { PENDING_HASH } from "./watch-sets.js";

export interface ReviewBasis {
  workoutId: string;
  buildId: string;
  records: RecordsState;
  graduation: {
    block: Block | null;
    /** Only the block's lifts' newest logged entries, ids canonical. */
    sessions: HistorySession[];
    unit: WeightUnit;
  };
  /** Saved ratings and "not for me" of the build's moves. */
  prefs: { ratings: Record<string, number>; excluded: string[] };
  /** Harder moves the block's lifts may graduate to that the build's own slice does not carry. */
  exercises: Record<string, ExerciseSlice>;
}

const isProgression = (e: HistorySession["entries"][number] | null | undefined): boolean =>
  Boolean(e && e.id && e.format !== "ladder" && e.format !== "circuit" && (e.sets || []).some(Boolean));

/**
 * The sessions progression reads for these lifts: per lift, the sessions holding its newest logged entries (ties at the
 * cut kept), with only the lifts' entries, under their canonical ids. In the history's order.
 */
export function graduationSessions(data: EngineData, history: readonly HistorySession[], lifts: readonly string[], keepPerLift: number): HistorySession[] {
  const wanted = new Set(lifts.map((id) => Hist.canonical(data, id)));
  const keep = new Set<HistorySession>();
  for (const lift of wanted) {
    const holding = history.filter((s) => (s.entries || []).some((e) => isProgression(e) && Hist.canonical(data, e.id) === lift));
    const keys = holding.map((s) => String(s.startedAt || s.date)).sort((a, b) => b.localeCompare(a));
    const cut = keys[Math.min(keepPerLift, keys.length) - 1];
    if (cut === undefined) continue;
    for (const s of holding) if (String(s.startedAt || s.date) >= cut) keep.add(s);
  }
  return history
    .filter((s) => keep.has(s))
    .map((s) => ({
      ...s,
      done: [],
      entries: (s.entries || [])
        .filter((e) => isProgression(e) && wanted.has(Hist.canonical(data, e.id)))
        .map((e) => ({ ...e, id: Hist.canonical(data, e.id) })),
    }));
}

// ── The summary in SQL (ruling 2b-R11; the 2a-R6 `BuildHistory` way) ──────────────────────────────────────────────
//
// `Records.baseline` folds the whole history; what the next session can read of that fold is small, and the database
// works it out: one query answers the records state, and the graduation basis is the newest few sessions per lift,
// picked in SQL and read by id. The Worker maps a bounded number of rows however long the history grows.
//
// The SQL mirrors `toWire` + `historyFromPerformed` + the fold (packages/session-engine/src/records.ts):
//  - an entry is the sets with one entry index, named by its first set's exercise id, format and implement; it is
//    history only with a done set, and its sets are its done ones; a weight is one only when it is > 0 in lb or kg
//    (kg = lb × 0.45359237, the domain's `toKg`, so SQLite's doubles are JavaScript's);
//  - the fold's order: a session's start time, else its date, then the history's own order (date, start, id);
//  - bests (ladders and circuits say nothing about them): the fold raises a move's best weight only past the best
//    by more than 0.05 kg, so the best is set by a session that raised the move's heaviest weight so far — and the
//    last such session that raised it by more than 0.05 kg starts a chain the fold settles alone: the query returns
//    that chain (a few rows: near-equal weights), each with the most reps within 0.05 kg of it from then on;
//  - weeks: counts and streaks (consecutive weeks at the goal) of the week before the build's day and later; the
//    longest streak ever (what `goal-weeks-N` was awarded for); the moves of those weeks (their core families);
//  - calm: per profile, the calm sessions in a row now and the longest run ever; a session's check is its own last
//    pre (else its slot's pre-check that day) and its own last post, as `toHistory` attaches them;
//  - the bell: the heaviest kettlebell weight, and each session that raised it by more than 0.05 kg after the first
//    (a `bell-N` award); blocks: the highest number, and each one that rose (a `block-N` award).
// Order: SQLite compares start times by bytes, the engine by `localeCompare` — they disagree only on two times equal to
// the minute written differently (engine-inputs.ts), which no fold here can tell apart in practice.

/** Rows of the records query: `kind` says what `a`, `n`, `x`, `v`, `u` and `y` hold. */
interface RecordsRow {
  kind: "chain" | "bare" | "hold" | "touched" | "count" | "block" | "blockrise" | "bell" | "bellaward" | "week" | "streak" | "beststreak" | "family" | "calmnow" | "calmbest";
  a: string | null;
  n: number | null;
  x: number | null;
  v: number | null;
  u: string | null;
  y: number | null;
}

const KG = `CASE WHEN ps.load_value > 0 AND ps.load_unit = 'kg' THEN ps.load_value WHEN ps.load_value > 0 AND ps.load_unit = 'lb' THEN ps.load_value * 0.45359237 END`;

function recordsRows(db: Db, userId: string, opts: { keep: Array<[string, string]>; calm: string[]; from: string; weeklyGoal: number }): Promise<RecordsRow[]> {
  const same = Records.STEPS.sameKg;
  return db.all(sql`
    WITH
    s AS (
      SELECT id, local_date, started_at, workout_id, block_number, moves_done,
             ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(started_at, ''), local_date), local_date, started_at, id) AS ord
      FROM performed_sessions WHERE user_id = ${userId} AND payload_hash <> ${PENDING_HASH}
    ),
    e AS (
      -- Entries with a done set. With exactly one MIN() in the query, SQLite takes the bare columns from the row holding
      -- it: the entry's first set (its exercise, format and implement, as toWire reads them).
      SELECT ps.performed_session_id AS sid, ps.entry_index AS ei, ps.exercise_id AS ex, ps.format AS fmt, ps.implement AS impl,
             MIN(ps.set_index) AS first_set
      FROM s JOIN performed_sets ps ON ps.performed_session_id = s.id
      GROUP BY ps.performed_session_id, ps.entry_index
      HAVING SUM(ps.done) > 0
    ),
    k AS (SELECT json_extract(value, '$[0]') AS raw, json_extract(value, '$[1]') AS canon FROM json_each(${JSON.stringify(opts.keep)})),
    ds AS (
      -- The build's moves' done sets that count for bests, under their canonical ids.
      SELECT e.sid, k.canon, ps.entry_index AS ei, ps.set_index AS si, ps.reps, ps.seconds AS secs,
             ps.load_value AS v, ps.load_unit AS u, ${sql.raw(KG)} AS kg
      FROM e JOIN k ON k.raw = e.ex
      JOIN performed_sets ps ON ps.performed_session_id = e.sid AND ps.entry_index = e.ei AND ps.done = 1
      WHERE e.fmt IS NULL OR e.fmt NOT IN ('ladder', 'circuit')
    ),
    top AS (SELECT ds.canon, ds.sid, s.ord, MAX(ds.kg) AS x FROM ds JOIN s ON s.id = ds.sid GROUP BY ds.canon, ds.sid),
    rises AS (
      SELECT canon, sid, ord, x, prev FROM (
        SELECT canon, sid, ord, x, MAX(x) OVER (PARTITION BY canon ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev
        FROM top
      ) WHERE x IS NOT NULL AND (prev IS NULL OR x > prev)
    ),
    chain AS (
      SELECT r.* FROM rises r
      JOIN (SELECT canon, MAX(ord) AS from_ord FROM rises WHERE prev IS NULL OR x > prev + ${same} GROUP BY canon) c
        ON c.canon = r.canon AND r.ord >= c.from_ord
    ),
    touched AS (
      SELECT sid, ex AS raw FROM e WHERE ex <> ''
      UNION
      SELECT s.id, json_extract(j.value, '$.exerciseId') FROM s, json_each(s.moves_done) j
      WHERE COALESCE(json_extract(j.value, '$.exerciseId'), '') <> ''
    ),
    wk AS (SELECT id AS sid, date(local_date, 'weekday 0', '-6 days') AS week FROM s),
    wc AS (SELECT week, COUNT(*) AS c FROM wk WHERE week IS NOT NULL GROUP BY week),
    goal AS (SELECT week, CAST(julianday(week) AS INTEGER) / 7 - ROW_NUMBER() OVER (ORDER BY week) AS island FROM wc WHERE c >= ${opts.weeklyGoal}),
    streak AS (SELECT week, island, ROW_NUMBER() OVER (PARTITION BY island ORDER BY week) AS n FROM goal),
    bells AS (
      SELECT sid, ord, x, MAX(x) OVER (ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev FROM (
        SELECT e.sid, s.ord, MAX(${sql.raw(KG)}) AS x
        FROM e JOIN s ON s.id = e.sid
        JOIN performed_sets ps ON ps.performed_session_id = e.sid AND ps.entry_index = e.ei AND ps.done = 1
        WHERE e.ex <> '' AND LOWER(COALESCE(e.impl, '')) = 'kettlebell'
        GROUP BY e.sid
      ) WHERE x IS NOT NULL
    ),
    blocks AS (
      SELECT block_number AS b, MAX(block_number) OVER (ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev
      FROM s WHERE block_number IS NOT NULL
    ),
    cp AS (SELECT value AS pid FROM json_each(${JSON.stringify(opts.calm)})),
    own AS (
      SELECT performed_session_id AS sid, profile_id AS pid, kind, value,
             ROW_NUMBER() OVER (PARTITION BY performed_session_id, profile_id, kind ORDER BY at DESC, id DESC) AS rn
      FROM condition_checks WHERE user_id = ${userId} AND kind IN ('pre', 'post') AND performed_session_id IS NOT NULL
    ),
    sheet AS (
      SELECT workout_id AS wid, local_date AS d, profile_id AS pid, value,
             ROW_NUMBER() OVER (PARTITION BY workout_id, local_date, profile_id ORDER BY at DESC, id DESC) AS rn
      FROM condition_checks WHERE user_id = ${userId} AND kind = 'pre' AND performed_session_id IS NULL AND workout_id IS NOT NULL
    ),
    calmed AS (
      SELECT pid, ord, calm, SUM(1 - calm) OVER (PARTITION BY pid ORDER BY ord ROWS UNBOUNDED PRECEDING) AS grp FROM (
        SELECT cp.pid, s.ord,
               CASE WHEN q.value IS NOT NULL AND (CASE WHEN o.sid IS NOT NULL THEN o.value ELSE h.value END) IS NOT NULL
                         AND q.value <= (CASE WHEN o.sid IS NOT NULL THEN o.value ELSE h.value END) THEN 1 ELSE 0 END AS calm
        FROM s CROSS JOIN cp
        LEFT JOIN own o ON o.sid = s.id AND o.pid = cp.pid AND o.kind = 'pre' AND o.rn = 1
        LEFT JOIN own q ON q.sid = s.id AND q.pid = cp.pid AND q.kind = 'post' AND q.rn = 1
        LEFT JOIN sheet h ON s.workout_id IS NOT NULL AND h.wid = s.workout_id AND h.d = s.local_date AND h.pid = cp.pid AND h.rn = 1
      )
    ),
    runs AS (SELECT pid, grp, SUM(calm) AS len FROM calmed GROUP BY pid, grp)
    SELECT 'chain' AS kind, t.canon AS a, t.ord AS n, t.x AS x,
           f.v AS v, f.u AS u,
           (SELECT MAX(d2.reps) FROM ds d2 JOIN s s2 ON s2.id = d2.sid
             WHERE d2.canon = t.canon AND d2.kg IS NOT NULL AND ABS(d2.kg - t.x) < ${same} AND s2.ord >= t.ord) AS y
    FROM chain t
    JOIN (SELECT sid, canon, v, u, kg, ROW_NUMBER() OVER (PARTITION BY sid, canon, kg ORDER BY ei, si) AS rn FROM ds WHERE kg IS NOT NULL) f
      ON f.sid = t.sid AND f.canon = t.canon AND f.kg = t.x AND f.rn = 1
    UNION ALL SELECT 'bare', canon, NULL, NULL, NULL, NULL, MAX(reps) FROM ds WHERE kg IS NULL GROUP BY canon
    UNION ALL SELECT 'hold', canon, NULL, NULL, NULL, NULL, MAX(secs) FROM ds WHERE secs > 0 GROUP BY canon
    UNION ALL SELECT DISTINCT 'touched', k.canon, NULL, NULL, NULL, NULL, NULL FROM k JOIN touched t ON t.raw = k.raw
    UNION ALL SELECT 'count', NULL, COUNT(*), NULL, NULL, NULL, NULL FROM s
    UNION ALL SELECT 'block', NULL, MAX(block_number), NULL, NULL, NULL, NULL FROM s
    UNION ALL SELECT DISTINCT 'blockrise', NULL, b, NULL, NULL, NULL, NULL FROM blocks WHERE prev IS NOT NULL AND b > prev
    UNION ALL SELECT 'bell', NULL, NULL, MAX(x), NULL, NULL, NULL FROM bells
    UNION ALL SELECT 'bellaward', NULL, NULL, x, NULL, NULL, NULL FROM bells WHERE prev IS NOT NULL AND x > prev + ${same}
    UNION ALL SELECT 'week', week, c, NULL, NULL, NULL, NULL FROM wc WHERE week >= ${opts.from}
    UNION ALL SELECT 'streak', week, n, NULL, NULL, NULL, NULL FROM streak WHERE week >= ${opts.from}
    UNION ALL SELECT 'beststreak', NULL, MAX(len), NULL, NULL, NULL, NULL FROM (SELECT COUNT(*) AS len FROM goal GROUP BY island)
    UNION ALL SELECT DISTINCT 'family', wk.week, NULL, NULL, NULL, t.raw, NULL FROM touched t JOIN wk ON wk.sid = t.sid WHERE wk.week >= ${opts.from}
    UNION ALL SELECT 'calmnow', r.pid, r.len, NULL, NULL, NULL, NULL FROM runs r WHERE r.grp = (SELECT MAX(grp) FROM calmed c WHERE c.pid = r.pid)
    UNION ALL SELECT 'calmbest', pid, MAX(len), NULL, NULL, NULL, NULL FROM runs GROUP BY pid
  `) as Promise<RecordsRow[]>;
}

/** The raw ids history may name each of `ids` by (its own and the legacy ids the library maps to it), as [raw, canonical]. */
function rawIds(data: EngineData, ids: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const canon of new Set(ids.map((id) => Hist.canonical(data, id)))) {
    const ex = Lib.get(data, canon);
    for (const raw of new Set([canon, ...(ex?.legacyIds ?? [])])) if (Hist.canonical(data, raw) === canon) out.push([raw, canon]);
  }
  return out;
}

/**
 * `Records.baseline(data, loadHistory(db, userId), opts)` — computed in the database (ruling 2b-R11): the same state, but
 * that `awarded` leaves out the `all-core-<week>` milestones of weeks before the one before `date` (no session on
 * `date` can award one of those again). records-baseline + review-basis-summary tests hold the equality.
 */
export async function recordsBaseline(
  db: Db,
  userId: string,
  data: EngineData,
  opts: { ids: readonly string[]; date: string; weeklyGoal: number },
): Promise<RecordsState> {
  const { ids, date, weeklyGoal } = opts;
  const state: RecordsState = {
    weeklyGoal, awarded: [], bests: {}, weekCounts: {}, weekStreaks: {}, weekFamilies: {}, calm: {}, count: 0, topBlock: null, heaviestBellKg: null,
  };
  const calmProfiles = data.profiles.active.filter((p) => p.calmStreakLabel);
  const from = isLocalDate(date) ? addDays(startOfIsoWeek(date), -7) : null;
  const rows = await recordsRows(db, userId, { keep: rawIds(data, ids), calm: calmProfiles.map((p) => p.id), from: from ?? "9999-12-31", weeklyGoal });
  const of = (kind: RecordsRow["kind"]) => rows.filter((r) => r.kind === kind);
  const one = (kind: RecordsRow["kind"]) => of(kind)[0];

  state.count = Number(one("count")?.n ?? 0);
  if (state.count === 0) return state;
  const { sessions: sessionSteps, goalWeeks, calm: calmSteps, sameKg } = Records.STEPS;
  const awarded = new Set<string>();
  for (const n of sessionSteps) if (n <= state.count) awarded.add(`sessions-${n}`);

  // Bests: every move of the build any session touched; its weight settled by the fold over its chain.
  const touched = new Set(of("touched").map((r) => r.a!));
  for (const canon of [...touched].sort()) state.bests[canon] = { kg: null, w: null, reps: null, secs: null };
  const chains = new Map<string, RecordsRow[]>();
  for (const r of of("chain")) chains.set(r.a!, [...(chains.get(r.a!) ?? []), r]);
  for (const [canon, chain] of chains) {
    const best = state.bests[canon];
    if (!best) continue;
    let at: RecordsRow | null = null;
    for (const r of chain.sort((x, y) => Number(x.n) - Number(y.n))) if (at === null || Number(r.x) > Number(at.x) + sameKg) at = r;
    if (!at) continue;
    best.kg = Number(at.x);
    best.w = { v: Number(at.v), u: at.u === "kg" ? "kg" : "lb" };
    best.reps = at.y === null ? null : Number(at.y);
  }
  for (const r of of("bare")) {
    const best = state.bests[r.a!];
    if (best && best.kg === null && r.y !== null) best.reps = Number(r.y);
  }
  for (const r of of("hold")) {
    const best = state.bests[r.a!];
    const ex = Lib.get(data, r.a!);
    // Only holds and carries have a longest time (an unknown id counts any logged seconds), as the fold says.
    if (best && r.y !== null && (!ex || ex.dose.type === "time" || ex.dose.type === "carry")) best.secs = Number(r.y);
  }

  // Blocks and the bell.
  const block = one("block")?.n;
  state.topBlock = block === null || block === undefined ? null : Number(block);
  for (const r of of("blockrise")) awarded.add(`block-${Number(r.n) - 1}`);
  const bell = one("bell")?.x;
  state.heaviestBellKg = bell === null || bell === undefined ? null : Number(bell);
  for (const r of of("bellaward")) awarded.add(`bell-${Math.round(Number(r.x))}`);

  // The weeks the next session can touch, and the longest run at the goal ever.
  for (const r of of("week")) {
    state.weekCounts[r.a!] = Number(r.n);
    state.weekFamilies[r.a!] = [];
  }
  for (const r of of("streak")) state.weekStreaks[r.a!] = Number(r.n);
  const longest = Number(one("beststreak")?.n ?? 0);
  for (const n of goalWeeks) if (n <= longest) awarded.add(`goal-weeks-${n}`);
  const families = new Map<string, Set<string>>();
  for (const r of of("family")) {
    const f = Lib.coreFamilyOf(data, Lib.get(data, r.u!));
    if (!f) continue;
    families.set(r.a!, (families.get(r.a!) ?? new Set()).add(f));
  }
  for (const week of Object.keys(state.weekFamilies)) {
    const seen = families.get(week) ?? new Set<string>();
    state.weekFamilies[week] = [...seen].sort();
    if (data.coreFamilies.every((f) => seen.has(f.id))) awarded.add(`all-core-${week}`);
  }

  // Calm runs, per profile: now, and the longest ever.
  calmProfiles.forEach((p, i) => {
    state.calm[p.id] = Number(of("calmnow").find((r) => r.a === p.id)?.n ?? 0);
    const best = Number(of("calmbest").find((r) => r.a === p.id)?.n ?? 0);
    for (const n of calmSteps) if (n <= best) awarded.add(i === 0 ? `calm-${n}` : `calm-${p.id}-${n}`);
  });

  state.awarded = [...awarded].sort();
  return state;
}

/** Sessions to rank beyond each lift's newest `keepPerLift`: a tie at the cut, or two start times ordered apart. */
const GRADUATION_SLACK = 2;

/**
 * `graduationSessions(data, loadHistory(db, userId), lifts, keepPerLift)` — from the database (ruling 2b-R11): per lift
 * the sessions holding its newest progression entries (ranked by start, ties sharing a rank, a little slack), read by
 * id and handed to `graduationSessions`, which picks exactly as over the whole history.
 */
export async function loadGraduationSessions(
  db: Db,
  userId: string,
  data: EngineData,
  lifts: readonly string[],
  keepPerLift: number,
): Promise<HistorySession[]> {
  if (lifts.length === 0) return [];
  const rows = (await db.all(sql`
    WITH
    s AS (
      SELECT id, COALESCE(NULLIF(started_at, ''), local_date) AS w
      FROM performed_sessions WHERE user_id = ${userId} AND payload_hash <> ${PENDING_HASH}
    ),
    e AS (
      SELECT ps.performed_session_id AS sid, ps.entry_index AS ei, ps.exercise_id AS ex, ps.format AS fmt, MIN(ps.set_index) AS first_set
      FROM s JOIN performed_sets ps ON ps.performed_session_id = s.id
      GROUP BY ps.performed_session_id, ps.entry_index
      HAVING SUM(ps.done) > 0
    ),
    k AS (SELECT json_extract(value, '$[0]') AS raw, json_extract(value, '$[1]') AS canon FROM json_each(${JSON.stringify(rawIds(data, lifts))})),
    held AS (
      SELECT DISTINCT e.sid, k.canon, s.w FROM e JOIN k ON k.raw = e.ex JOIN s ON s.id = e.sid
      WHERE e.ex <> '' AND (e.fmt IS NULL OR e.fmt NOT IN ('ladder', 'circuit'))
    )
    SELECT DISTINCT sid FROM (SELECT sid, RANK() OVER (PARTITION BY canon ORDER BY w DESC) AS rk FROM held)
    WHERE rk <= ${keepPerLift + GRADUATION_SLACK}
  `)) as Array<{ sid: string }>;
  return graduationSessions(data, await loadSessionsById(db, userId, rows.map((r) => r.sid)), lifts, keepPerLift);
}

const sliceOf = (ex: ExerciseRecord): ExerciseSlice => {
  const { providers: _providers, ...rest } = ex;
  return rest;
};

export async function reviewBasis(db: Db, userId: string, workoutId: string, ctx: { today: string; unit: WeightUnit }): Promise<ReviewBasis> {
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const build = session.build;
  if (!build) throw new NotBuiltError();
  const [slot] = await db
    .select({ planId: plannedWorkouts.planId })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!slot) throw new SessionNotFoundError();
  const [program] = slot.planId
    ? await db.select({ config: programs.config }).from(programs).where(eq(programs.id, slot.planId)).limit(1)
    : [];
  const parsed = adaptiveConfigSchema.safeParse(program?.config ?? {});
  const weeklyGoal = parsed.success ? parsed.data.weeklyGoal : 4;

  const data = engineDataFor(await activeProfileIds(db, userId), []);
  const ids = [...new Set([...build.items.map((i) => i.exerciseId), ...Object.values(build.alternatives).flat().map((a) => a.id)])];
  // A summary, never the whole history (ruling 2b-R11): its cost does not grow with the account's sessions.
  const records = await recordsBaseline(db, userId, data, { ids, date: build.date, weeklyGoal });

  let block = slot.planId ? await loadProgramState(db, slot.planId) : null;
  if (block && build.blockRef && block.id !== build.blockRef) block = null;
  const lifts = block ? Object.values(block.core).filter((id): id is string => !!id && ids.includes(id)) : [];
  const sessions = await loadGraduationSessions(db, userId, data, lifts, Hist.TRIM.progressionEntries);
  const exercises: Record<string, ExerciseSlice> = {};
  for (const lift of lifts) {
    const ex = EXERCISES.find((e) => e.id === lift);
    for (const h of ex?.harder ?? []) {
      const harder = EXERCISES.find((e) => e.id === h);
      if (harder && !build.exercises[harder.id]) exercises[harder.id] = sliceOf(harder);
    }
  }

  const prefRows = [];
  for (const batch of chunkIds(ids)) {
    prefRows.push(
      ...(await db
        .select({ exerciseId: exercisePrefs.exerciseId, rating: exercisePrefs.rating, excluded: exercisePrefs.excluded })
        .from(exercisePrefs)
        .where(and(eq(exercisePrefs.userId, userId), inArray(exercisePrefs.exerciseId, batch)))),
    );
  }
  const ratings: Record<string, number> = {};
  const excluded: string[] = [];
  for (const r of prefRows) {
    if (r.rating) ratings[r.exerciseId] = r.rating;
    if (r.excluded) excluded.push(r.exerciseId);
  }

  return {
    workoutId,
    buildId: build.buildId,
    records,
    graduation: { block, sessions, unit: ctx.unit },
    prefs: { ratings, excluded: excluded.sort() },
    exercises,
  };
}
