/**
 * WHERE THE ATHLETE STANDS (spec 2026-11-05 §7; principles §6.3 as amended by the owner's decision of 2026-11-05, §12:
 * "the coach always needs to be aware of my overall goals, my current plan, and my historical progress as much as
 * possible … proactive about"). A computed, bounded block every main run opens with, and the drift rules the "needs
 * you" chip and the block share — so the coach and the chip never disagree.
 *
 * THE READ. One statement (`standRowsSql`: scalar JSON subqueries, every term scoped to the athlete and bounded by its
 * window on an index — the activities by their UTC start a day either side, the sessions by their local date, the reads
 * through their activities: what it reads never grows with a lifetime of history — a query-plan test pins it) for: the active
 * objectives and their key results; the plan 28 days back and 13 ahead (never archived); the activities of 5 minutes or
 * more in the 4 weeks before today that completed nothing planned; 14 days of wellness and 7 nights of sleep; the newest
 * weekly review; up to 3 flagged activity reads of the last 7 days; live memory beyond the pinned core, counted by kind;
 * the drift conclusions the coach remembered (`provenance.drift`, `provenance.checkBack`); the active plans that haven't
 * ended (a registry row each: name and purpose, never the brief; its end is `planLastDaySql`, the expression the plan's
 * prompt reads); and — when the caller has no
 * account library — the athlete's own moves (`personalMovesSql`). Then the key results' measures
 * (`measureKeyResults`, run labels off), whose cost is `measureStatements` of the measures: `standStatements` in all.
 *
 * THE BLOCK (`standBlock`) words the facts in fixed parts, each capped (three key-result lines, two reads, three items a
 * day, a review's first sentence): objectives current → target by due with pace; planned → done per discipline over the
 * 14 days and the 4 weeks BEFORE today (today's own sessions are in the next 14 days) with missed, skipped (the
 * athlete's own) and not known (unresolved, or past and never resolved) apart; the next 14 days a line a day; one line
 * per active plan, six at most (its name and purpose, each cut at a word — the brief and the ending are read_plans'); readiness
 * with 7 days of values and their trend; the last review's first sentence and the flagged reads; memory beyond the core;
 * drift. Every outside text goes in marked: a key result's label and a plan's name and purpose (the athlete's), a review's and a read's words (the
 * coach's earlier model calls: "coach read").
 *
 * DRIFT (`driftsOf`, §7.2 — the numbers are the builder's call): over the 21 days before today, a discipline with 3 or
 * more planned and under half of them done (`discipline`), or 2 planned and none of it done on or off the plan
 * (`none`); over 14 days, 3 or more sessions missed or not logged (`missed`) — said as "not logged", never as missed; a
 * key result behind schedule by more than a quarter with under half its time left (`key_result`). A drift the coach talked
 * through is held until its check-back day (`remember` with drift and checkBack), then comes back with what was said.
 */
import { sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  activities,
  coachMemory,
  coachReads,
  dailyHealth,
  keyResults,
  objectives,
  performedSessions,
  plannedWorkouts,
  programs,
  sleepRecords,
  weeklyReviews,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  appAuthoredRow,
  dayLabel,
  daysBetween,
  KEY_RESULT_UNITS,
  keyResultMeasureSchema,
  QUALITY_SUBTYPE_LABELS,
  todayInZone,
  type KeyResultMeasure,
  type KeyResultProgress,
  type KeyResultUnit,
  type QualitySubtype,
} from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { accountLibraryFrom, personalMovesSql } from "./account-library.js";
import type { Db } from "./db.js";
import { markUntrusted } from "./design-prompt.js";
import { measureKeyResults, measureStatements } from "./key-result-measures.js";
import { liveMemoryWhere, memoryCoreIds } from "./memory-core.js";
import { buildReadiness, type ReadinessHealthRow } from "./readiness.js";
import { PLAYED_OFFLINE_CALENDAR_STATE, START_NOW_CALENDAR_STATE } from "./doc-workouts.js";
import { planLastDaySql } from "./plan-ending.js";
import { PLAN_KINDS } from "./plan-summaries.js";

// ── Facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Discipline = "runs" | "strength" | "mobility and care" | "yoga";
const DISCIPLINES: readonly Discipline[] = ["runs", "strength", "mobility and care", "yoga"];

export interface StandKeyResult {
  id: string;
  objectiveId: string;
  /** The athlete's words. */
  label: string;
  /** Null when the stored measure no longer reads. */
  measure: KeyResultMeasure | null;
  direction: "up" | "down";
  baseline: number | null;
  target: number | null;
  unit: KeyResultUnit;
  due: string | null;
  /** The athlete's local date it was made: where its pace starts. */
  createdOn: string;
  progress: KeyResultProgress | null;
  /** Past the STAND_KEY_RESULTS_MAX the stand measures: not read here (read_objectives has it). */
  unread?: true;
}

export interface StandObjective {
  id: string;
  keyResults: StandKeyResult[];
}

export interface StandPlanRow {
  id: string;
  date: string;
  time: string;
  category: string;
  origin: string | null;
  state: string;
  sanctionedBy: string | null;
  subtype: string | null;
  sport: string;
  seconds: number;
  /** Started at once (Start now, or played offline and recorded on reconnect: `calendar_sync_state` app_only or
   * app_only_offline): never planned — done, it is work off the plan. */
  startNow?: boolean;
  /** Its discipline, as the read works it out once (`disciplineOf`); absent, worked out when asked. */
  discipline?: Discipline | null;
}

export interface StandFacts {
  today: string;
  /** Active ones, in the athlete's order; each key result in theirs. */
  objectives: StandObjective[];
  /** today − 28 … today + 13, not archived. */
  plan: StandPlanRow[];
  /** Activities of 5 minutes or more, today − 28 … today − 1, that completed nothing planned. */
  unplanned: Array<{ date: string; discipline: Discipline }>;
  /** today − 13 … today, newest first (the readiness builder's window). */
  health: ReadinessHealthRow[];
  /** today − 6 … today, newest first. */
  sleep: Array<{ date: string; seconds: number }>;
  review: { weekStart: string; narrative: string } | null;
  /** Flagged activity reads, today − 6 … today, newest first (3 read at most). */
  reads: Array<{ date: string; sport: string; seconds: number; flags: string[]; glance: string | null }>;
  /** Live items beyond the pinned core, by kind. */
  beyondCore: Record<string, number>;
  /** Live drift conclusions, newest first: what the coach concluded (its words) and until when it holds. */
  conclusions: Array<{ id: string; drift: string; checkBack: string; at: string; body: string }>;
  /** Active plans that haven't ended, oldest first: each one's name and purpose (null while none is set). The brief
   * stays behind read_plans. */
  plans: Array<{ id: string; name: string; purpose: string | null }>;
}

/** The planned window: four weeks back. */
const PAST_DAYS = 28;
/** The days ahead the block lists, today included. */
const AHEAD_DAYS = 14;
const SHORT_DAYS = 14;
const READINESS_DAYS = 14;
const WEEK = 7;
const READS_READ = 3;
const CONCLUSIONS_READ = 10;
/** An activity this short is a fragment (coach-nudges.ts SESSION_MIN_SECONDS). */
const ACTIVITY_MIN_SECONDS = 300;

const RUN_CATEGORIES = new Set(["recovery", "easy", "long", "quality", "race", "unknown"]);

/** A row's discipline: the read's own, worked out once a row (the tallies ask a dozen times over: CPU, 2026-11-06). */
const rowDiscipline = (w: StandPlanRow): Discipline | null => (w.discipline !== undefined ? w.discipline : disciplineOf(w));

/** A planned row's discipline: the app's yoga kind is mobility and care ("yoga is for yoga programs", 2026-10-16). */
export function disciplineOf(w: { category: string; origin: string | null }): Discipline | null {
  if (RUN_CATEGORIES.has(w.category)) return "runs";
  if (w.category === "strength") return "strength";
  if (w.category === "yoga") return appAuthoredRow({ origin: w.origin }) ? "mobility and care" : "yoga";
  return null;
}

/** The plan kinds as SQL literals (constants, so no parameters: the statement binds about seventy already). */
const PLAN_KIND_LIST = sql.raw(PLAN_KINDS.map((k) => `'${k}'`).join(", "));
/** Plans read, at most (the block shows PLANS_LISTED of them and counts the rest). */
const PLANS_READ = 30;

const SPORT_DISCIPLINE: Record<string, Discipline> = { run: "runs", strength: "strength", yoga: "yoga" };

export type StandRows = Record<string, unknown>;

/** The read's one statement (see the module comment). `library`: the athlete's own moves too. */
export function standRowsSql(db: Db, userId: string, today: string, opts: { library: boolean }): SQL {
  const pw = plannedWorkouts;
  const a = activities;
  const h = dailyHealth;
  const s = sleepRecords;
  const m = coachMemory;
  const cr = coachReads;
  const o = objectives;
  const k = keyResults;
  const day = sql`substr(coalesce(${a.startTimeLocal}, ${a.startTime}), 1, 10)`;
  const live = liveMemoryWhere(userId, today);
  return sql`select
    (select json_group_array(json_object('id', ${o.id}, 'sort', ${o.sort}, 'created', ${o.createdAt}))
      from ${o} where ${o.userId} = ${userId} and ${o.status} = 'active') as objectives,
    (select json_group_array(json_object('id', kr.id, 'o', kr.objective_id, 'label', kr.label,
        'measure', case when json_valid(kr.measure) then json(kr.measure) end, 'direction', kr.direction, 'baseline', kr.baseline,
        'target', kr.target, 'unit', kr.unit, 'due', kr.due_date, 'position', kr.position, 'created', kr.created_at))
      from ${k} kr join ${o} ob on ob.id = kr.objective_id and ob.user_id = kr.user_id
      where kr.user_id = ${userId} and ob.status = 'active') as keyResults,
    (select json_group_array(json_array(${pw.id}, ${pw.effectiveDate}, ${pw.effectiveTime}, ${pw.category}, ${pw.origin}, ${pw.completionState},
        ${pw.sanctionedBy}, ${pw.qualitySubtype}, ${pw.sport},
        coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}, ${pw.calendarBlockDurationSeconds}, 0),
        ${pw.calendarSyncState} in (${START_NOW_CALENDAR_STATE}, ${PLAYED_OFFLINE_CALENDAR_STATE})))
      from ${pw} where ${pw.userId} = ${userId} and ${pw.archivedAt} is null
        and ${pw.effectiveDate} between ${addDays(today, -PAST_DAYS)} and ${addDays(today, AHEAD_DAYS - 1)}) as plan,
    (select json_group_array(json_array(${day}, ${a.sport})) from ${a}
      where ${a.userId} = ${userId} and ${a.durationSeconds} >= ${ACTIVITY_MIN_SECONDS}
        and ${a.startTime} >= ${addDays(today, -PAST_DAYS - 1)} and ${a.startTime} < ${addDays(today, 1)}
        and ${day} between ${addDays(today, -PAST_DAYS)} and ${addDays(today, -1)}
        and not exists (select 1 from ${workoutCompletionMatches} where ${workoutCompletionMatches.id} = ${a.completionMatchId}
          and ${workoutCompletionMatches.undoneAt} is null)
        and not exists (select 1 from ${performedSessions} where ${performedSessions.userId} = ${userId}
          and ${performedSessions.localDate} between ${addDays(today, -PAST_DAYS - 1)} and ${today}
          and ${performedSessions.activityId} = ${a.id} and ${performedSessions.workoutId} is not null)) as unplanned,
    (select json_group_array(json_object('date', ${h.date}, 'hrv', ${h.hrv}, 'restingHeartRate', ${h.restingHeartRate},
        'recoveryScore', ${h.recoveryScore}, 'sleepHrvBase', ${h.sleepHrvBase}, 'sleepHrvSd', ${h.sleepHrvSd}))
      from ${h} where ${h.userId} = ${userId} and ${h.date} between ${addDays(today, -(READINESS_DAYS - 1))} and ${today}) as health,
    (select json_group_array(json_array(${s.date}, ${s.durationSeconds})) from ${s}
      where ${s.userId} = ${userId} and ${s.date} between ${addDays(today, -(WEEK - 1))} and ${today}) as sleep,
    (select json_object('weekStart', ${weeklyReviews.weekStart}, 'narrative', ${weeklyReviews.narrative}) from ${weeklyReviews}
      where ${weeklyReviews.userId} = ${userId} and ${weeklyReviews.narrative} is not null
      order by ${weeklyReviews.weekStart} desc limit 1) as review,
    (select json_group_array(json_array(d, sport, seconds, flags, glance)) from (
      select ${day} as d, ${a.sport} as sport, ${a.durationSeconds} as seconds, json(${cr.flags}) as flags, ${cr.glance} as glance
      from ${a} cross join ${cr} on ${cr.userId} = ${a.userId} and ${cr.activityId} = ${a.id}
      where ${a.userId} = ${userId} and ${a.startTime} >= ${addDays(today, -WEEK)} and ${a.startTime} < ${addDays(today, 1)}
        and ${cr.status} = 'done' and json_valid(${cr.flags}) and json_array_length(${cr.flags}) > 0
        and ${day} between ${addDays(today, -(WEEK - 1))} and ${today}
      order by d desc, ${a.startTime} desc limit ${READS_READ})) as reads,
    (select json_group_object(kind, n) from (select ${m.kind} as kind, count(*) as n from ${m}
      where ${live} and ${m.id} not in ${memoryCoreIds(db, userId, today)} group by ${m.kind})) as beyond,
    (select json_group_array(json_array(id, drift, back, at, body)) from (
      select ${m.id} as id, json_extract(${m.provenance}, '$.drift') as drift, json_extract(${m.provenance}, '$.checkBack') as back,
        ${m.learnedAt} as at, ${m.body} as body from ${m}
      where ${live} and json_valid(${m.provenance}) and json_extract(${m.provenance}, '$.drift') is not null
        and json_extract(${m.provenance}, '$.checkBack') is not null
      order by ${m.learnedAt} desc limit ${CONCLUSIONS_READ})) as conclusions,
    (select json_group_array(json_array(id, name, purpose)) from (
      select ${programs.id} as id, ${programs.name} as name, ${programs.purpose} as purpose from ${programs}
      where ${programs.userId} = ${userId} and ${programs.status} = 'active' and ${programs.archivedAt} is null
        and ${programs.kind} in (${PLAN_KIND_LIST}) and coalesce(${programs.endDate}, ${planLastDaySql()}, ${today}) >= ${today}
      order by ${programs.createdAt}, ${programs.id} limit ${PLANS_READ})) as plans,
    ${opts.library ? personalMovesSql(userId) : sql`null`} as library`;
}

/**
 * The statement rendered once an isolate for an athlete's day (CPU, 2026-11-06: composing its ~100 columns and ~70
 * parameters through drizzle was a fifth of what the stand cost a context step): its text and parameters, kept, and
 * sent again as one flat statement — the same text, the same parameters. Any day, athlete or library flag else renders
 * anew; a text whose placeholders don't match its parameters is never kept.
 */
const RENDERED = new Map<string, { strings: TemplateStringsArray; params: unknown[] }>();
const RENDERED_MAX = 8;
const DIALECT = new SQLiteAsyncDialect();

function renderedStandSql(db: Db, userId: string, today: string, opts: { library: boolean }): SQL {
  const key = `${userId}|${today}|${opts.library ? 1 : 0}`;
  let held = RENDERED.get(key);
  if (!held) {
    const q = DIALECT.sqlToQuery(standRowsSql(db, userId, today, opts));
    const parts = q.sql.split("?");
    if (parts.length !== q.params.length + 1) return standRowsSql(db, userId, today, opts);
    if (RENDERED.size >= RENDERED_MAX) RENDERED.clear();
    held = { strings: Object.assign([...parts], { raw: parts }) as unknown as TemplateStringsArray, params: q.params };
    RENDERED.set(key, held);
  }
  return sql(held.strings, ...held.params);
}

/** The read's one statement, run. */
export async function readStandRows(db: Db, userId: string, today: string, opts: { library: boolean }): Promise<StandRows> {
  const [rows] = (await db.all(renderedStandSql(db, userId, today, opts))) as StandRows[];
  return rows ?? {};
}

const arr = (v: unknown): unknown[] => {
  if (typeof v !== "string") return Array.isArray(v) ? v : [];
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};
const obj = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== "string") return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  try {
    const x: unknown = JSON.parse(v);
    return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored measure, parsed once an isolate (its JSON the key): the schema's parse was most of the facts' own CPU. */
const PARSED_MEASURES = new Map<string, KeyResultMeasure | null>();
function parsedMeasure(raw: unknown): KeyResultMeasure | null {
  const key = JSON.stringify(raw ?? null);
  if (PARSED_MEASURES.has(key)) return PARSED_MEASURES.get(key)!;
  const parsed = keyResultMeasureSchema.safeParse(raw);
  if (PARSED_MEASURES.size >= 256) PARSED_MEASURES.clear();
  PARSED_MEASURES.set(key, parsed.success ? parsed.data : null);
  return parsed.success ? parsed.data : null;
}

/** The statements the whole read costs: its one, and the measures of the key results it finds. */
export function standStatements(measures: readonly KeyResultMeasure[]): number {
  return 1 + measureStatements(measures, { library: true, labels: false });
}

/** The facts from the read's row: the key results measured (the library given, or the row's own). */
export async function standFactsFrom(
  db: Db,
  userId: string,
  rows: StandRows,
  opts: { today: string; tz: string; library?: readonly ExerciseRecord[] },
): Promise<StandFacts> {
  const today = opts.today;
  const objectiveRows = arr(rows.objectives)
    .map((x) => x as Record<string, unknown>)
    .sort((p, q) => (num(p.sort) ?? 0) - (num(q.sort) ?? 0) || String(p.created).localeCompare(String(q.created)) || String(p.id).localeCompare(String(q.id)));
  const krRows = arr(rows.keyResults)
    .map((x) => x as Record<string, unknown>)
    .sort((p, q) => (num(p.position) ?? 0) - (num(q.position) ?? 0) || String(p.created).localeCompare(String(q.created)) || String(p.id).localeCompare(String(q.id)));
  const keyResultsOf: StandKeyResult[] = krRows.map((x) => {
    const parsed = parsedMeasure(x.measure);
    const created = str(x.created);
    const unit = str(x.unit);
    return {
      id: String(x.id),
      objectiveId: String(x.o),
      label: str(x.label) ?? "",
      measure: parsed,
      direction: x.direction === "down" ? "down" : "up",
      baseline: num(x.baseline),
      target: num(x.target),
      unit: (KEY_RESULT_UNITS as readonly string[]).includes(unit ?? "") ? (unit as KeyResultUnit) : "score",
      due: str(x.due),
      createdOn: created && Number.isFinite(Date.parse(created)) ? todayInZone(opts.tz, new Date(created)) : today,
      progress: null,
    };
  });
  // In the block's order (the objectives', then each one's own), so the cap keeps the lines shown and the likeliest drifts.
  const ordered = objectiveRows.flatMap((o) => keyResultsOf.filter((kr) => kr.objectiveId === o.id));
  const chosen = new Set(standMeasured(ordered));
  for (const kr of ordered) if (!chosen.has(kr) && canDrift(kr)) kr.unread = true;
  const measured = [...chosen].filter((kr): kr is StandKeyResult & { measure: KeyResultMeasure } => kr.measure !== null);
  if (measured.length > 0) {
    const library = opts.library ?? (await accountLibraryFrom(db, userId, rows.library)).all;
    const progress = await measureKeyResults(
      db,
      userId,
      measured.map((kr) => ({ measure: kr.measure, unit: kr.unit })),
      { today, library, labels: false },
    );
    measured.forEach((kr, i) => (kr.progress = progress[i] ?? null));
  }
  const objectivesOut: StandObjective[] = objectiveRows.map((o) => ({ id: String(o.id), keyResults: keyResultsOf.filter((kr) => kr.objectiveId === o.id) }));

  const plan: StandPlanRow[] = arr(rows.plan)
    .filter((x): x is unknown[] => Array.isArray(x) && typeof x[1] === "string")
    .map((x) => ({
      id: String(x[0]),
      date: x[1] as string,
      time: str(x[2]) ?? "",
      category: str(x[3]) ?? "",
      origin: str(x[4]),
      state: str(x[5]) ?? "scheduled",
      sanctionedBy: str(x[6]),
      subtype: str(x[7]),
      sport: str(x[8]) ?? "",
      seconds: num(x[9]) ?? 0,
      ...(x[10] === 1 || x[10] === true ? { startNow: true as const } : {}),
      discipline: disciplineOf({ category: str(x[3]) ?? "", origin: str(x[4]) }),
    }))
    .sort((p, q) => `${p.date} ${p.time} ${p.id}`.localeCompare(`${q.date} ${q.time} ${q.id}`));
  const unplanned = arr(rows.unplanned)
    .filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string" && x[1] in SPORT_DISCIPLINE)
    .map(([date, sport]) => ({ date, discipline: SPORT_DISCIPLINE[sport]! }))
    .sort((p, q) => q.date.localeCompare(p.date));
  const health: ReadinessHealthRow[] = arr(rows.health)
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.date === "string")
    .map((x) => ({
      date: x.date as string,
      hrv: num(x.hrv),
      restingHeartRate: num(x.restingHeartRate),
      recoveryScore: num(x.recoveryScore),
      sleepHrvBase: num(x.sleepHrvBase),
      sleepHrvSd: num(x.sleepHrvSd),
    }))
    .sort((p, q) => q.date.localeCompare(p.date));
  const sleep = arr(rows.sleep)
    .filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number" && x[1] > 0)
    .map(([date, seconds]) => ({ date, seconds }))
    .sort((p, q) => q.date.localeCompare(p.date));
  const r = obj(rows.review);
  const review = r && typeof r.weekStart === "string" && typeof r.narrative === "string" ? { weekStart: r.weekStart, narrative: r.narrative } : null;
  const reads = arr(rows.reads)
    .filter((x): x is unknown[] => Array.isArray(x) && typeof x[0] === "string")
    .map((x) => ({
      date: x[0] as string,
      sport: str(x[1]) ?? "activity",
      seconds: num(x[2]) ?? 0,
      flags: arr(x[3]).filter((f): f is string => typeof f === "string"),
      glance: str(x[4]),
    }))
    .sort((p, q) => q.date.localeCompare(p.date));
  const beyond = obj(rows.beyond) ?? {};
  const beyondCore: Record<string, number> = {};
  for (const [kind, n] of Object.entries(beyond)) if (typeof n === "number" && n > 0) beyondCore[kind] = n;
  const conclusions = arr(rows.conclusions)
    .filter((x): x is [string, string, string, string, string] => Array.isArray(x) && x.length === 5 && x.every((v) => typeof v === "string"))
    .map(([id, drift, checkBack, at, body]) => ({ id, drift, checkBack, at, body }))
    .sort((p, q) => q.at.localeCompare(p.at));
  const plans = arr(rows.plans)
    .filter((x): x is unknown[] => Array.isArray(x) && typeof x[0] === "string")
    .map((x) => ({ id: x[0] as string, name: str(x[1]) ?? "", purpose: str(x[2])?.trim() || null }));
  return { today, objectives: objectivesOut, plan, unplanned, health, sleep, review, reads, beyondCore, conclusions, plans };
}

/** The most key results the stand measures (read_objectives' page cap): the CPU of every main context step and of the
 * nudges read on every Today load grows with them (the audits, 2026-11-06). */
export const STAND_KEY_RESULTS_MAX = 12;

/** A key result that can drift: a target and a due date to be behind. */
const canDrift = (kr: StandKeyResult): boolean => kr.target !== null && kr.due !== null;

/**
 * The key results the stand measures, STAND_KEY_RESULTS_MAX at most, from `ordered` (the block's order): the ones the
 * block shows (KR_LINES), then the ones that can drift — a target and a due date — soonest due first. One neither shown
 * nor able to drift is never read (CPU, 2026-11-06: nothing of it reaches the block); one that could drift but is past
 * the cap is left unread, and said so.
 */
export function standMeasured(ordered: readonly StandKeyResult[]): StandKeyResult[] {
  const shown = ordered.slice(0, KR_LINES);
  const drifting = ordered.slice(KR_LINES).filter(canDrift).sort((p, q) => p.due!.localeCompare(q.due!));
  return [...shown, ...drifting].slice(0, STAND_KEY_RESULTS_MAX);
}

/** The read whole: its statement (the library in it), then the measures. */
export async function readStandFacts(db: Db, userId: string, opts: { today: string; tz: string }): Promise<StandFacts> {
  return standFactsFrom(db, userId, await readStandRows(db, userId, opts.today, { library: true }), opts);
}

// ── Pace ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Pace = "ahead" | "on track" | "behind" | "reached" | "no data";
/** How far either side of the time gone a key result's progress still reads as on track. */
const PACE_BAND = 0.1;

/**
 * A key result's pace: how far it is from its start to its target (`done`, toward the target whichever way is better)
 * against how much of the time from its start to its due date has gone (`elapsed`, 0–1). Reached at the target; past due
 * and not reached is behind. Without a current value, a target, a due date or a start, there is no pace to read.
 */
export function paceOf(
  kr: { direction: "up" | "down"; start: number | null; target: number | null; startDate: string; due: string | null },
  current: number | null,
  today: string,
): { pace: Pace; done?: number; elapsed?: number; why?: string } {
  if (current === null) return { pace: "no data", why: "nothing measured" };
  if (kr.target === null) return { pace: "no data", why: "no target" };
  if (kr.due === null) return { pace: "no data", why: "no due date" };
  if (kr.start === null) return { pace: "no data", why: "no starting value" };
  const sign = kr.direction === "up" ? 1 : -1;
  const span = daysBetween(kr.startDate, kr.due);
  const elapsed = span <= 0 ? 1 : Math.min(1, Math.max(0, daysBetween(kr.startDate, today) / span));
  if ((current - kr.target) * sign >= 0) return { pace: "reached", done: 1, elapsed };
  // From the start, the target lies no way the better way: nothing to pace (the audits: "ahead, 300% there").
  const toward = (kr.target - kr.start) * sign;
  if (toward === 0) return { pace: "no data", why: "the target is the start" };
  if (toward < 0) return { pace: "no data", why: "started past the target" };
  const done = ((current - kr.start) * sign) / ((kr.target - kr.start) * sign);
  if (today > kr.due) return { pace: "behind", done, elapsed };
  return { pace: done >= elapsed + PACE_BAND ? "ahead" : done < elapsed - PACE_BAND ? "behind" : "on track", done, elapsed };
}

/** Its start: the baseline, else its oldest reading — when there are two at least (one reading is its own start). */
const startOf = (kr: StandKeyResult): number | null => kr.baseline ?? ((kr.progress?.series.length ?? 0) >= 2 ? kr.progress!.series[0]!.display : null);
function paceFor(kr: StandKeyResult, today: string): ReturnType<typeof paceOf> {
  const current = kr.progress?.display.current ?? null;
  if (kr.unread) return { pace: "no data", why: "not read here" };
  if (kr.baseline === null && current !== null && (kr.progress?.series.length ?? 0) < 2) return { pace: "no data", why: "one reading so far" };
  return paceOf({ direction: kr.direction, start: startOf(kr), target: kr.target, startDate: kr.createdOn, due: kr.due }, current, today);
}

// ── Planned against done ────────────────────────────────────────────────────────────────────────────────────────────

interface Tally {
  planned: number;
  /** Past, still only scheduled: within the sync's grace — not known yet, and no part of a drift. */
  pending: number;
  /** The oldest planned day, or null. */
  oldest: string | null;
  done: number;
  missed: number;
  skipped: number;
  unknown: number;
  unplanned: number;
}

/** A discipline's sessions in [from, to]: planned work only — never a rest day, never the coach's own skip. */
function tally(f: StandFacts, discipline: Discipline, from: string, to: string): Tally {
  const t: Tally = { planned: 0, pending: 0, oldest: null, done: 0, missed: 0, skipped: 0, unknown: 0, unplanned: 0 };
  for (const w of f.plan) {
    if (w.date < from || w.date > to || rowDiscipline(w) !== discipline) continue;
    // Started at once, never planned: done, it is work off the plan (the audits, 2026-11-06).
    if (w.startNow) {
      if (w.state === "completed") t.unplanned += 1;
      continue;
    }
    if (w.state === "skipped" && w.sanctionedBy === "coach") continue;
    t.planned += 1;
    if (t.oldest === null || w.date < t.oldest) t.oldest = w.date;
    if (w.state === "scheduled" && w.date < f.today) t.pending += 1;
    if (w.state === "completed") t.done += 1;
    else if (w.state === "missed") t.missed += 1;
    else if (w.state === "skipped") t.skipped += 1;
    else t.unknown += 1;
  }
  t.unplanned += f.unplanned.filter((u) => u.discipline === discipline && u.date >= from && u.date <= to).length;
  return t;
}

// ── Drift ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DRIFT_RULES = ["discipline", "none", "missed", "key_result"] as const;
export type DriftRule = (typeof DRIFT_RULES)[number];
/** A drift's id, as a chip, a run's `nudge` and `remember`'s `drift` name it. */
export const DRIFT_ID = /^drift:(discipline|none|missed|key_result)(:[A-Za-z0-9 _.:-]{1,80})?$/;

/** The days a discipline's drift is read over, and its floor. */
export const DRIFT_DAYS = 21;
export const DRIFT_MIN_PLANNED = 3;
/** None of a discipline: two planned at least — one session not done is the missed chip's, not a drift. */
export const NONE_MIN_PLANNED = 2;
/** …and the first of them a week back at least: a session or two just not done is the missed chip's. */
export const NONE_SINCE_DAYS = 7;
/** The days the not-logged drift is read over, and how many it takes. */
export const MISSED_DRIFT_DAYS = 14;
export const MISSED_DRIFT_MIN = 3;
/** A key result's drift: further behind its time than this, with less than this share of its time left. */
export const KR_BEHIND_BY = 0.25;
export const KR_TIME_LEFT = 0.5;

export interface Drift {
  id: string;
  rule: DriftRule;
  /** The app's words: what a chip says (a key result's label, the athlete's own, in it). */
  observation: string;
  /** A key result's label, for the block to mark (the observation starts with it). */
  label?: string;
  /** What it is about, as holds match it: `discipline:<key>` (a discipline's drift, or each discipline a not-logged
   * drift's sessions are in), `key_result:<id>`. */
  subjects: string[];
  /** Talked through: held until its check-back day — with what the coach concluded (its words). */
  held: { until: string; memoryId: string; at: string; body: string } | null;
  /** Talked through, and its check-back day has come. */
  since?: { at: string; memoryId: string; body: string };
}

const NOUN: Record<Discipline, string> = { runs: "runs", strength: "lifts", "mobility and care": "mobility sessions", yoga: "yoga sessions" };
const LABEL_IN_CHIP = 32;

function leftWords(days: number): string {
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} left`;
  return `${Math.round(days / 7)} weeks left`;
}

/** The drifts the app sees, the most pressing first, each held or not by what the coach concluded. */
export function driftsOf(f: StandFacts): Drift[] {
  const today = f.today;
  const yesterday = addDays(today, -1);
  const found: Array<{ d: Omit<Drift, "held"> ; rank: number }> = [];
  for (const discipline of DISCIPLINES) {
    const t = tally(f, discipline, addDays(today, -DRIFT_DAYS), yesterday);
    const key = discipline.replace(/ /g, "_");
    // A session still within the sync's grace is not known yet: no part of a drift.
    const known = t.planned - t.pending;
    if (known >= DRIFT_MIN_PLANNED && t.done * 2 < known) {
      found.push({
        d: { id: `drift:discipline:${key}`, rule: "discipline", subjects: [`discipline:${key}`], observation: `${t.done} of ${known} planned ${NOUN[discipline]} logged in 3 weeks` },
        rank: t.done / known,
      });
    } else if (
      known >= NONE_MIN_PLANNED &&
      known < DRIFT_MIN_PLANNED &&
      t.done === 0 &&
      t.unplanned === 0 &&
      t.oldest !== null &&
      t.oldest <= addDays(today, -NONE_SINCE_DAYS)
    ) {
      found.push({ d: { id: `drift:none:${key}`, rule: "none", subjects: [`discipline:${key}`], observation: `No ${NOUN[discipline]} logged in 3 weeks, with ${known} planned` }, rank: 0 });
    }
  }
  found.sort((p, q) => p.rank - q.rank);
  const notLogged = notLoggedOf(f);
  if (notLogged.length >= MISSED_DRIFT_MIN) {
    found.push({ d: { id: "drift:missed", rule: "missed", subjects: missedSubjects(f), observation: `${notLogged.length} sessions not logged in 2 weeks` }, rank: 1 });
  }
  const behind: Array<{ d: Omit<Drift, "held">; gap: number }> = [];
  for (const o of f.objectives) {
    for (const kr of o.keyResults) {
      const p = paceFor(kr, today);
      if (p.done === undefined || p.elapsed === undefined || p.pace === "reached") continue;
      if (p.elapsed - p.done > KR_BEHIND_BY && 1 - p.elapsed < KR_TIME_LEFT && kr.due) {
        const label = kr.label.length > LABEL_IN_CHIP ? `${kr.label.slice(0, LABEL_IN_CHIP - 1).trimEnd()}…` : kr.label;
        const left = Math.max(0, daysBetween(today, kr.due));
        behind.push({
          d: { id: `drift:key_result:${kr.id}`, rule: "key_result", subjects: [`key_result:${kr.id}`], label, observation: `${label} is behind schedule with ${leftWords(left)}` },
          gap: p.elapsed - p.done,
        });
      }
    }
  }
  behind.sort((p, q) => q.gap - p.gap);
  const live = f.conclusions.filter((c) => c.checkBack > today);
  return [...found.map((x) => x.d), ...behind.map((x) => x.d)].map((d) => {
    // Held by subject, never only by the exact id: the same sessions raise different drifts, and a discipline's flips
    // between discipline and none as the window slides (the audits, 2026-11-06).
    const by = coveringOf(d, live.map((c) => c.drift), f);
    const c = by === null ? null : live.find((x) => x.drift === by)!;
    if (c) return { ...d, held: { until: c.checkBack, memoryId: c.id, at: c.at.slice(0, 10), body: c.body } };
    const past = f.conclusions.find((x) => x.checkBack <= today && coveringOf(d, [x.drift], f) !== null);
    return past ? { ...d, held: null, since: { at: past.at.slice(0, 10), memoryId: past.id, body: past.body } } : { ...d, held: null };
  });
}

/** The sessions of the last 14 days missed or not logged (never a rest day, never one started at once). */
function notLoggedOf(f: StandFacts): StandPlanRow[] {
  const from = addDays(f.today, -MISSED_DRIFT_DAYS);
  const yesterday = addDays(f.today, -1);
  return f.plan.filter((w) => !w.startNow && w.date >= from && w.date <= yesterday && w.category !== "rest" && (w.state === "missed" || w.state === "unresolved"));
}

/** The disciplines the not-logged sessions are in, as subjects (a session of none: `discipline:other`). */
function missedSubjects(f: StandFacts): string[] {
  return [...new Set(notLoggedOf(f).map((w) => `discipline:${(disciplineOf(w) ?? "other").replace(/ /g, "_")}`))].sort();
}

/** What a drift id is about now: a discipline's, its discipline; a key result's, it; the not-logged one's, the disciplines
 * its sessions are in now. */
function subjectsOfId(id: string, f: StandFacts): string[] {
  const [, rule, ...rest] = id.split(":");
  const subject = rest.join(":");
  if ((rule === "discipline" || rule === "none") && subject) return [`discipline:${subject}`];
  if (rule === "key_result" && subject) return [`key_result:${subject}`];
  if (rule === "missed") return missedSubjects(f);
  return [];
}

/** The first of `ids` that covers `d` — every subject of it — or null. */
function coveringOf(d: Pick<Drift, "subjects">, ids: readonly string[], f: StandFacts): string | null {
  if (d.subjects.length === 0) return null;
  const covered = new Map<string, string>();
  for (const id of ids) for (const subject of subjectsOfId(id, f)) if (!covered.has(subject)) covered.set(subject, id);
  return d.subjects.every((x) => covered.has(x)) ? covered.get(d.subjects[0]!)! : null;
}

/** Whether runs that diagnosed `ids` (or conclusions of them) cover `d`, by the same subject match its holds use. */
export function driftCoveredBy(d: Pick<Drift, "subjects">, ids: readonly string[], f: StandFacts): boolean {
  return coveringOf(d, ids, f) !== null;
}

/** A drift as a "needs you" chip: an observation and a question; its request the athlete's words. */
export function driftNudge(d: Drift): { id: string; label: string; request: string } {
  return { id: d.id, label: `${d.observation} — talk it through?`, request: `${d.observation} — let's talk it through.` };
}

// ── The block ───────────────────────────────────────────────────────────────────────────────────────────────────────

const KR_LINES = 3;
/** Drift lines the block lists, the most pressing first (the chip only ever offers the first). */
const DRIFT_LINES = 3;
/** What a held drift's conclusion says in its line, at most (the memory item has it whole). */
const CONCLUSION_CHARS = 100;
const READS_LISTED = 2;
const PLANS_LISTED = 6;
const PLAN_NAME_CHARS = 40;
const PLAN_PURPOSE_CHARS = 80;
const DAY_ITEMS = 3;
const REVIEW_CHARS = 120;
const GLANCE_CHARS = 80;
const MEMORY_KINDS_ORDER = ["fact", "rule", "note", "observation"];

/** Cut at a word, with an ellipsis when cut. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const end = t.search(/[.!?](\s|$)/);
  return end >= 0 ? t.slice(0, end + 1) : t;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** A key result's figure in its own unit (the coach's objective changes say theirs the same way: audit fixes, E6). */
export function figure(v: number, unit: KeyResultUnit): string {
  switch (unit) {
    case "s":
      return v >= 600 ? mmss(v) : `${v} s`;
    case "min":
      return `${v} min`;
    case "kg":
    case "lb":
      return `${v} ${unit}`;
    case "reps":
      return `${v} reps`;
    case "s/km":
      return `${mmss(v)} /km`;
    case "s/mi":
      return `${mmss(v)} /mi`;
    case "score":
      return String(v);
  }
}

const EVIDENCE_WORDS: Partial<Record<KeyResultProgress["evidence"], string>> = { sparse: "few readings", capped: "at least" };
const pct = (x: number): string => `${Math.round(x * 100)}%`;

function objectiveLines(f: StandFacts): string[] {
  if (f.objectives.length === 0) return ["Objectives: none active."];
  const lines: string[] = [];
  for (const o of f.objectives) {
    if (o.keyResults.length === 0) lines.push(`- ${o.id}: no key results yet`);
    for (const kr of o.keyResults) {
      const cur = kr.progress?.display.current ?? null;
      const ev = kr.progress ? EVIDENCE_WORDS[kr.progress.evidence] : undefined;
      const p = paceFor(kr, f.today);
      const detail = p.why ? ` (${p.why})` : p.done !== undefined && p.elapsed !== undefined && p.pace !== "reached" ? ` (${pct(Math.max(0, p.done))} there, ${pct(p.elapsed)} of time gone)` : "";
      lines.push(
        `- ${o.id}: ${markUntrusted("athlete", kr.label)} ${cur === null ? "—" : figure(cur, kr.unit)}${ev ? ` (${ev})` : ""} → ${kr.target === null ? "no target" : figure(kr.target, kr.unit)}${kr.due ? ` by ${kr.due}` : ""}: ${p.pace}${detail}`,
      );
    }
  }
  const shown = lines.slice(0, KR_LINES);
  const more = lines.length - shown.length;
  const unread = f.objectives.reduce((n, o) => n + o.keyResults.filter((kr) => kr.unread).length, 0);
  return [
    "Objectives — current → target by due: pace:",
    ...shown,
    ...(more > 0 ? [`- and ${more} more key results (read_objectives${unread ? `; ${unread} not read here, so no drift of theirs below` : ""})`] : []),
  ];
}

function plannedLines(f: StandFacts): string[] {
  const yesterday = addDays(f.today, -1);
  const lines: string[] = [];
  const counts = (t: Tally) => `${t.missed}·${t.skipped}·${t.unknown}`;
  for (const discipline of DISCIPLINES) {
    const short = tally(f, discipline, addDays(f.today, -SHORT_DAYS), yesterday);
    const long = tally(f, discipline, addDays(f.today, -PAST_DAYS), yesterday);
    if (long.planned === 0 && long.unplanned === 0) continue;
    const apart = short.missed + short.skipped + short.unknown + long.missed + long.skipped + long.unknown > 0 ? ` (${counts(short)} | ${counts(long)})` : "";
    const off = long.unplanned > 0 ? `, +${long.unplanned} off the plan in 4 wk` : "";
    lines.push(`- ${discipline} ${short.done}/${short.planned} | ${long.done}/${long.planned}${apart}${off}`);
  }
  if (lines.length === 0) return ["Planned → done: nothing planned in the last 4 weeks."];
  return ["Planned → done, last 14 d | 4 wk (missed · skipped · not known):", ...lines];
}

function itemWords(w: StandPlanRow): string {
  const what =
    w.category === "rest"
      ? "rest"
      : w.category === "quality"
        ? (w.subtype && w.subtype !== "other" && w.subtype in QUALITY_SUBTYPE_LABELS ? QUALITY_SUBTYPE_LABELS[w.subtype as QualitySubtype].toLowerCase() : "quality run")
        : w.category === "easy" || w.category === "long" || w.category === "recovery"
          ? `${w.category} run`
          : w.category === "race"
            ? "race"
            : w.category === "unknown"
              ? "run"
              : w.category === "strength"
                ? "strength"
                : w.category === "yoga"
                  ? (disciplineOf(w) === "yoga" ? "yoga" : "mobility")
                  : w.category === "cross_training"
                    ? "cross-training"
                    : w.sport || "session";
  const minutes = w.category !== "rest" && w.seconds > 0 ? ` ${Math.round(w.seconds / 60)} min` : "";
  const state = w.state === "completed" ? " (done)" : w.state === "skipped" ? " (skipped)" : "";
  return `${what}${minutes}${state}`;
}

function aheadLines(f: StandFacts): string[] {
  const ahead = f.plan.filter((w) => w.date >= f.today).sort((p, q) => `${p.date} ${p.time} ${p.id}`.localeCompare(`${q.date} ${q.time} ${q.id}`));
  if (ahead.length === 0) return ["Next 14 days: nothing planned."];
  // A line a day with something on it (a rest day too); a day not listed has nothing planned.
  const lines = ["Next 14 days (a day not listed: nothing planned):"];
  const byDay = new Map<string, StandPlanRow[]>();
  for (const w of ahead) byDay.set(w.date, [...(byDay.get(w.date) ?? []), w]);
  for (let i = 0; i < AHEAD_DAYS; i++) {
    const date = addDays(f.today, i);
    const items = (byDay.get(date) ?? []).map(itemWords);
    if (items.length === 0) continue;
    const shown = items.slice(0, DAY_ITEMS);
    lines.push(`${dayLabel(date)}: ${shown.join("; ")}${items.length > DAY_ITEMS ? `; +${items.length - DAY_ITEMS}` : ""}`);
  }
  return lines;
}

/** Up, down or steady: the newer half of the readings' mean against the older half's (four readings at least). */
function trend(values: readonly number[]): string | null {
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const older = mean(values.slice(0, half));
  const newer = mean(values.slice(values.length - half));
  const change = (newer - older) / older;
  return change > 0.03 ? "rising" : change < -0.03 ? "falling" : "steady";
}

function readinessLine(f: StandFacts): string {
  const view = buildReadiness(f.health, f.today);
  const verdict = view.verdict ? view.verdict.level : "no verdict (too little data)";
  const days = Array.from({ length: WEEK }, (_, i) => addDays(f.today, i - (WEEK - 1)));
  const byDate = new Map(f.health.map((h) => [h.date, h]));
  const series = (k: "hrv" | "restingHeartRate"): Array<number | null> =>
    days.map((d) => {
      const v = byDate.get(d)?.[k];
      return typeof v === "number" && v > 0 ? Math.round(v) : null;
    });
  const signal = (name: string, k: "hrv" | "restingHeartRate"): string | null => {
    const s = series(k);
    const got = s.filter((v): v is number => v !== null);
    if (got.length === 0) return null;
    const usual = view.baseline?.[k];
    const notes = [usual ? `usual ${Math.round(usual)}` : null, trend(got)].filter(Boolean);
    return `${name} ${s.map((v) => (v === null ? "–" : String(v))).join(" ")}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  };
  const nights = f.sleep.filter((s) => s.date >= days[0]!).map((s) => s.seconds / 3600);
  const hours = (h: number) => (Math.round(h * 10) / 10).toFixed(1);
  const sleep = nights.length
    ? `sleep ${hours(nights.reduce((s, h) => s + h, 0) / nights.length)} h a night (${hours(Math.min(...nights))}–${hours(Math.max(...nights))})`
    : null;
  const parts = [signal("HRV", "hrv"), signal("resting HR", "restingHeartRate"), sleep].filter((p): p is string => p !== null);
  return `Readiness: ${verdict}. ${parts.length ? `Last 7 d, oldest first — ${parts.join(" · ")}` : "Last 7 d: no HRV, resting HR or sleep recorded."}`;
}

function reviewLine(f: StandFacts): string {
  if (!f.review) return "Last weekly review: none yet.";
  return `Last weekly review (week of ${dayLabel(f.review.weekStart)}): ${markUntrusted("coach read", clip(firstSentence(f.review.narrative), REVIEW_CHARS))}`;
}

function readLines(f: StandFacts): string[] {
  if (f.reads.length === 0) return ["Activity reads flagged in 7 d: none."];
  const lines = f.reads.slice(0, READS_LISTED).map((r) => {
    const minutes = r.seconds > 0 ? ` ${Math.round(r.seconds / 60)} min` : "";
    const glance = r.glance ? `: ${markUntrusted("coach read", clip(r.glance, GLANCE_CHARS))}` : "";
    return `- ${dayLabel(r.date)} ${r.sport}${minutes} — ${r.flags.join(", ")}${glance}`;
  });
  const more = f.reads.length - READS_LISTED;
  return ["Activity reads flagged in 7 d:", ...lines, ...(more > 0 ? [`and ${more} more (read_history)`] : [])];
}

/** What each active plan is for: its name and purpose, marked (the brief and the ending are read_plans'). Nothing with no plan. */
function planLines(f: StandFacts): string[] {
  if (f.plans.length === 0) return [];
  const lines = f.plans.slice(0, PLANS_LISTED).map((p) => {
    const purpose = p.purpose ? markUntrusted("athlete", clip(p.purpose, PLAN_PURPOSE_CHARS)) : "no purpose set yet";
    return `- ${markUntrusted("athlete", clip(p.name, PLAN_NAME_CHARS))}: ${purpose}`;
  });
  const more = f.plans.length - PLANS_LISTED;
  return ["Plans (read_plans has each one's brief and ending):", ...lines, ...(more > 0 ? [`- and ${more} more (read_plans)`] : [])];
}

function memoryLine(f: StandFacts): string {
  const kinds = Object.keys(f.beyondCore).sort((a, b) => {
    const i = (k: string) => (MEMORY_KINDS_ORDER.indexOf(k) + 1 || MEMORY_KINDS_ORDER.length + 1);
    return i(a) - i(b) || a.localeCompare(b);
  });
  if (kinds.length === 0) return "Memory beyond the core: none.";
  return `Memory beyond the core: ${kinds.map((k) => `${f.beyondCore[k]} ${k}${f.beyondCore[k] === 1 ? "" : "s"}`).join(", ")} (recall_memory).`;
}

/** A drift's line in the block: its key result's label marked, its id, and what was concluded of it. */
export function driftLine(d: Drift): string {
  const words = d.label ? `${markUntrusted("athlete", d.label)}${d.observation.slice(d.label.length)}` : d.observation;
  const said = (body: string) => markUntrusted("memory", clip(body, CONCLUSION_CHARS));
  const after = d.held
    ? ` — talked through ${d.held.at}, held until ${d.held.until} (${d.held.memoryId}): ${said(d.held.body)}`
    : d.since
      ? ` — talked through ${d.since.at} (${d.since.memoryId}), check back now: ${said(d.since.body)}`
      : "";
  return `- ${words} (${d.id})${after}`;
}

/** The block (see the module comment). */
/** The block's heading: the reviewer's packet finds the block by it in the designing run's opening (audit fixes, E5). */
export const STAND_HEADING = "# Where you stand (the app's own figures)";

export function standBlock(f: StandFacts, drifts: readonly Drift[]): string {
  return [
    STAND_HEADING,
    ...objectiveLines(f),
    ...plannedLines(f),
    ...aheadLines(f),
    ...planLines(f),
    readinessLine(f),
    reviewLine(f),
    ...readLines(f),
    memoryLine(f),
    ...(drifts.length
      ? [
          "Needs you (the first not held is the chip on Today and in the coach):",
          ...drifts.slice(0, DRIFT_LINES).map(driftLine),
          ...(drifts.length > DRIFT_LINES ? [`- and ${drifts.length - DRIFT_LINES} more the app sees (read_objectives, read_plan)`] : []),
        ]
      : ["Needs you: nothing the app sees."]),
  ].join("\n");
}
