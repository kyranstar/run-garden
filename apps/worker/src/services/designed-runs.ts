/**
 * DESIGNED RUNS (§8 §3, 2026-10-18): what the worker knows of the athlete's running for a run the coach designs, and
 * the approved run's row.
 *
 * THE ATHLETE'S RUNNING, READ IN SQL — no statement of its own: each read rides a statement its caller already runs.
 *  - The opening context's line (`runningLine`, design-context.ts, in its scalar counts statement): the athlete's
 *    threshold pace and when the watch measured it, every effort's pace band computed from it (`paceBandFor`, the one
 *    function the card, the validator and the wire read), and the last four weeks' running (distance each week, newest
 *    first, and the time a week on average) — in the athlete's units, in at most RUNNING_LINE_MAX characters, so every
 *    run's opening message carries it whatever was asked.
 *  - The validator's (`runCtxSql` → `runCtxOf`: the act tools' athlete statement, the approve's own read): the threshold;
 *    the hard sessions on the run's day and either side of it (a quality or race run; strength of a develop or peak
 *    effort working the legs — RUN_REGIONS, at least HARD_LEGS_SETS working sets — read from its document); the running
 *    planned in the run's week (Monday to Sunday) and the last four weeks' weekly average before it (the watch's runs).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { activities, corosWriteJobs, dailyHealth, plannedWorkouts, plannedWorkoutStages, programs, scheduleOverrides } from "@rg/database";
import { buildProgramFor } from "@rg/coros";
import {
  addDays,
  coachCreateWorkoutJobSchema,
  isoWeekday,
  newId,
  paceBandFor,
  parseStoredWorkoutDoc,
  RUN_EFFORT_LABELS,
  runStepBand,
  runWatchSessionOf,
  runWatchStepOf,
  runWatchSteps,
  type RunEffort,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { summarizeStageRows } from "@rg/scheduling";
import { deriveDoc, stagesFromDoc, type DocIssue, type RunCtx } from "@rg/workout";
import { restoreInProgress } from "./account-state.js";
import { RUN_REGIONS } from "./body-exposure.js";
import { enqueueWatchCreate } from "./coach-apply.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { insertBatches, runAtomically, type Db } from "./db.js";
import { judgeDoc } from "./doc-build.js";
import {
  accepted,
  DocInvalidError,
  docDayContext,
  keyedRowId,
  parsedDoc,
  PastDateError,
  studioProgramId,
  type DocWorkoutCtx,
  type DocWorkoutDto,
  type DocWriteSource,
} from "./doc-workouts.js";
import { RestoreInProgressError } from "./programs.js";
import { bookedSeconds } from "./session-build.js";
import { newRowDocColumns, revisionInsert } from "./workout-doc-store.js";

const METERS_PER_MILE = 1609.344;

/** The most the opening context's running line holds, in characters (a test pins the longest it can be). */
export const RUNNING_LINE_MAX = 300;
/** Lower-body working sets that make a develop or peak strength session hard on the legs. */
export const HARD_LEGS_SETS = 6;

/** An activity's day as SQL can tell it: the device's local start, else the UTC one. */
const ACTIVITY_DAY = sql`substr(coalesce(${activities.startTimeLocal}, ${activities.startTime}), 1, 10)`;

/** The athlete's latest threshold pace and the day it was read: `{ v, d }`, or null. */
export function thresholdSql(userId: string): SQL {
  const dh = dailyHealth;
  return sql`(select json_object('v', ${dh.thresholdPaceSecPerKm}, 'd', ${dh.date}) from ${dh}
    where ${dh.userId} = ${userId} and ${dh.thresholdPaceSecPerKm} is not null order by ${dh.date} desc limit 1)`;
}

/** The last four weeks' running, by week back from `today` (0: the seven days to today): `[{ w, s, m }]`. */
export function runWeeksSql(userId: string, today: string): SQL {
  const a = activities;
  return sql`(select json_group_array(json_object('w', w, 's', s, 'm', m)) from (
    select cast((julianday(${today}) - julianday(${ACTIVITY_DAY})) / 7 as integer) as w,
      sum(${a.durationSeconds}) as s, sum(coalesce(${a.distanceMeters}, 0)) as m
    from ${a} where ${a.userId} = ${userId} and ${a.sport} = 'run' and ${ACTIVITY_DAY} between ${addDays(today, -27)} and ${today}
    group by w))`;
}

/** The athlete's running as the opening context says it. */
export interface RunningFacts {
  threshold: { secPerKm: number; date: string } | null;
  /** The last four weeks, newest first: seconds and metres run. */
  weeks: Array<{ seconds: number; meters: number }>;
}

const parsedJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** `thresholdSql` and `runWeeksSql`'s columns, read. */
export function runningFactsOf(thresholdRaw: unknown, weeksRaw: unknown): RunningFacts {
  const t = parsedJson(thresholdRaw) as { v?: unknown; d?: unknown } | null;
  const v = typeof t?.v === "number" && Number.isFinite(t.v) ? t.v : null;
  const weeks = Array.from({ length: 4 }, () => ({ seconds: 0, meters: 0 }));
  const rows = parsedJson(weeksRaw);
  for (const r of Array.isArray(rows) ? rows : []) {
    const x = r as { w?: unknown; s?: unknown; m?: unknown };
    const w = typeof x.w === "number" ? x.w : -1;
    if (w < 0 || w > 3) continue;
    weeks[w] = { seconds: Number(x.s) || 0, meters: Number(x.m) || 0 };
  }
  return { threshold: v !== null && typeof t?.d === "string" ? { secPerKm: v, date: t.d } : null, weeks };
}

/** "7:45" — seconds per km as the athlete's pace reads, per km or per mile. */
function paceIn(secPerKm: number, units: "km" | "mi"): string {
  const s = Math.round(units === "mi" ? secPerKm * (METERS_PER_MILE / 1000) : secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "1 h 32 min" / "48 min". */
function durationWords(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** The efforts the line names a band for, slowest first (the efforts with one, `paceBandFor`). */
const BANDED: readonly RunEffort[] = ["recovery", "easy", "long", "steady", "tempo", "threshold", "interval"];

/** "8 Mar": a day as the line dates the threshold. */
function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m! - 1]}`;
}

/**
 * The opening context's running line (see the module comment): "Running: threshold 4:49 /km (8 Mar). Effort paces /km
 * — recovery 6:19–7:19, easy …, interval 4:29–4:44. Last 4 weeks, newest first: 30.2, 0.0, 28.5, 31.0 km; 2 h 50 min a
 * week on average."
 */
export function runningLine(f: RunningFacts, units: "km" | "mi"): string {
  const head = f.threshold
    ? (() => {
        const t = f.threshold.secPerKm;
        const bands = BANDED.flatMap((e) => {
          const b = paceBandFor(e, t);
          return b ? [`${e} ${paceIn(b.fastSecPerKm, units)}–${paceIn(b.slowSecPerKm, units)}`] : [];
        });
        return `Running: threshold ${paceIn(t, units)} /${units} (${shortDate(f.threshold.date)}). Effort paces /${units} — ${bands.join(", ")}.`;
      })()
    : "Running: no threshold pace known yet, so a run's steps carry no pace targets (the watch shows time only).";
  const total = f.weeks.reduce((s, w) => s + w.seconds, 0);
  if (total === 0) return `${head} No running logged in the last four weeks.`;
  // By distance when every week that ran has one (a watch run without a distance is said in minutes, never as 0 km).
  const per = units === "mi" ? METERS_PER_MILE : 1000;
  const byDistance = f.weeks.every((w) => w.seconds === 0 || w.meters > 0);
  const each = byDistance
    ? `${f.weeks.map((w) => (w.meters / per).toFixed(1)).join(", ")} ${units}`
    : `${f.weeks.map((w) => Math.round(w.seconds / 60)).join(", ")} min`;
  return `${head} Last 4 weeks, newest first: ${each}; ${durationWords(total / 4)} a week on average.`;
}

// ── The validator's running (`RunCtx`) ──────────────────────────────────────────────────────────────────────────────

/** The run's week: Monday to Sunday. */
export function weekOf(date: string): { start: string; end: string } {
  const start = addDays(date, -(isoWeekday(date) - 1));
  return { start, end: addDays(start, 6) };
}

/**
 * What the validator reads of the athlete's running for a run on `date` (see the module comment), as one JSON column:
 * `{ t: threshold, near: [{ d, c, s, t, doc }], week: seconds, avg: { s, n } }`.
 */
export function runCtxSql(userId: string, date: string): SQL {
  const pw = plannedWorkouts;
  const a = activities;
  const { start, end } = weekOf(date);
  const live = sql`${pw.userId} = ${userId} and ${pw.archivedAt} is null and ${pw.completionState} not in ('skipped', 'missed')`;
  const seconds = sql`coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}, ${pw.calendarBlockDurationSeconds})`;
  return sql`json_object(
    't', (select ${dailyHealth.thresholdPaceSecPerKm} from ${dailyHealth} where ${dailyHealth.userId} = ${userId}
      and ${dailyHealth.thresholdPaceSecPerKm} is not null order by ${dailyHealth.date} desc limit 1),
    'near', (select json_group_array(json_object('d', ${pw.effectiveDate}, 'c', ${pw.category}, 's', ${pw.sport}, 't', ${pw.title},
        'doc', case when ${pw.sport} = 'strength' then ${pw.workoutDoc} end))
      from ${pw} where ${live} and ${pw.effectiveDate} between ${addDays(date, -1)} and ${addDays(date, 1)}
        and ((${pw.sport} = 'run' and ${pw.category} in ('quality', 'race')) or ${pw.sport} = 'strength')),
    'week', (select coalesce(sum(${seconds}), 0) from ${pw} where ${live} and ${pw.sport} = 'run'
      and ${pw.effectiveDate} between ${start} and ${end}),
    'avg', (select json_object('s', coalesce(sum(${a.durationSeconds}), 0), 'n', count(*)) from ${a}
      where ${a.userId} = ${userId} and ${a.sport} = 'run' and ${ACTIVITY_DAY} between ${addDays(start, -28)} and ${addDays(start, -1)}))`;
}

const LEGS = new Set<string>(RUN_REGIONS);

/** A strength document hard on the legs: a develop or peak effort working the legs for HARD_LEGS_SETS sets or more. */
function hardOnLegs(docText: unknown): boolean {
  const doc = parseStoredWorkoutDoc(typeof docText === "string" ? docText : null);
  if (!doc || (doc.intent.effort !== "develop" && doc.intent.effort !== "peak")) return false;
  const exposure = deriveDoc(doc, EXERCISES).regionExposure;
  return Object.entries(exposure).reduce((n, [region, sets]) => n + (LEGS.has(region) ? sets : 0), 0) >= HARD_LEGS_SETS;
}

/** `runCtxSql`'s column, read for the validator. */
export function runCtxOf(raw: unknown): RunCtx {
  const o = (parsedJson(raw) ?? {}) as { t?: unknown; near?: unknown; week?: unknown; avg?: unknown };
  const t = typeof o.t === "number" && Number.isFinite(o.t) ? o.t : null;
  const near = parsedJson(o.near);
  type Near = RunCtx["nearby"][number];
  const nearby: Near[] = (Array.isArray(near) ? near : []).flatMap((x): Near[] => {
    const r = x as { d?: unknown; c?: unknown; s?: unknown; t?: unknown; doc?: unknown };
    if (typeof r.d !== "string") return [];
    const title = typeof r.t === "string" && r.t.trim() ? r.t : r.s === "run" ? "A hard run" : "Strength";
    if (r.s === "run") return [{ date: r.d, kind: "quality_run" as const, title }];
    return hardOnLegs(r.doc) ? [{ date: r.d, kind: "hard_legs" as const, title }] : [];
  });
  // By day, then title: the aggregate's order is SQLite's to choose.
  nearby.sort((a, b) => (a.date === b.date ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.date < b.date ? -1 : 1));
  const avg = parsedJson(o.avg) as { s?: unknown; n?: unknown } | null;
  const n = Number(avg?.n) || 0;
  return {
    thresholdSecPerKm: t,
    nearby,
    weekMinutes: Math.round((Number(o.week) || 0) / 60),
    fourWeekAvgMinutes: n > 0 ? Math.round((Number(avg?.s) || 0) / 60 / 4) : null,
  };
}

// ── The approved run's row (`createDesignedRun`) ────────────────────────────────────────────────────────────────────

/** The fingerprint a designed run's row is seeded with until its create lands (the verify writes the wire's own): a value
 * no COROS read could be mistaken for (`isUpstreamFingerprint`), by which the plan's coverage knows the row. */
export const DESIGNED_RUN_SEED = "designed-run";

/** A stage row as `planned_workout_stages` takes it. */
type StageRow = typeof plannedWorkoutStages.$inferInsert;

/** The quality subtype a hard run's efforts name (the hardest first), as the app files planned runs. */
const SUBTYPE_OF: ReadonlyArray<[RunEffort, string]> = [["interval", "intervals"], ["threshold", "threshold"], ["tempo", "tempo"], ["hills", "hills"]];

/**
 * A designed run's stage rows (the plan's own structure: Today, Plan and the session sheet read them, the body check
 * eases from them): the document's stages (`stagesFromDoc` — a part with rounds a repeat holding its items), each run
 * segment with the pace band the watch gets (`runStepBand`: the one asked for in whole seconds, else its effort's from
 * the threshold) and its effort in
 * words as its label ("tempo", as a coach run's stage says its intensity). The stored document keeps only what was
 * authored; the bands are computed, so they live here.
 */
export function designedRunStages(workoutId: string, doc: WorkoutDoc, thresholdSecPerKm: number | null): StageRow[] {
  const labels: Array<string | null> = [];
  const paced: WorkoutDoc = {
    ...doc,
    parts: doc.parts.map((part) => {
      if (part.rounds !== undefined) labels.push(null);
      return {
        ...part,
        items: part.items.map((item) => {
          if (item.kind !== "run") {
            labels.push(null);
            return item;
          }
          labels.push(RUN_EFFORT_LABELS[item.effort].toLowerCase());
          // The band the watch gets, from the step the watch gets (`runWatchStepOf`: a named pace in whole seconds).
          const step = runWatchStepOf(item, part.purpose);
          const band = typeof step === "string" ? null : runStepBand(step, thresholdSecPerKm).band;
          const { pace: _named, ...target } = item.target;
          return { ...item, target: band ? { ...target, pace: band } : target };
        }),
      };
    }),
  };
  const stages = stagesFromDoc(paced, EXERCISES);
  return stages.map((s, i) => ({
    id: `${workoutId}:${s.id}`,
    workoutId,
    parentStageId: s.parentStageId ? `${workoutId}:${s.parentStageId}` : null,
    ord: s.order,
    kind: s.kind,
    repeatCount: s.repeatCount ?? null,
    durationType: s.durationType,
    durationSeconds: s.durationSeconds ?? null,
    distanceMeters: s.distanceMeters ?? null,
    targetType: s.targetType ?? null,
    targetLow: s.targetLow ?? null,
    targetHigh: s.targetHigh ?? null,
    paceZone: s.paceZone ?? null,
    hrZone: s.hrZone ?? null,
    label: labels.length === stages.length ? labels[i]! : null,
    note: s.note ?? null,
  }));
}

/** The statements a designed run's stage rows take to insert (D1's bound-variable cap: `insertBatches`). */
export function stageInsertCount(doc: WorkoutDoc): number {
  return insertBatches(designedRunStages("x", doc, null)).length;
}

/** What `createDesignedRun` answers: the workout as a Studio save answers it, and whether a watch job waits. */
export interface DesignedRunMade {
  workout: DocWorkoutDto;
  warnings: DocIssue[];
  /** A watch create was queued (COROS writes on, and every step has its time): the client drains it. */
  queued: boolean;
  repeated?: true;
}

/**
 * THE APPROVED RUN'S ROW (§8 §3; design-approve.ts's run branch). A designed run lands in the COACH LANE — origin null,
 * as the thread coach's runs do — so the body check's ease, adjust_plan and Undo work on it unchanged, and it goes to
 * the watch when it is approved (the athlete's approval is the consent; COROS writes on): a `coach_create_workout` job
 * whose session is its `run_watch`, built at the write from the freshest threshold.
 *
 * Made once per key (`clientId`, the approve's op key: a repeat answers the row it made, writing nothing). Judged as a
 * save judges a document — the day's rules (`docDayContext`) with the athlete's running (`runCtxSql`: one read) — an
 * error refuses it (`DocInvalidError`), a warning comes back with it. Its columns: the document's title; its derived
 * category and the quality subtype its hardest effort names; sport run; its length the steps' on the watch
 * (`runWatchSteps`, a distance at its band's middle; else derived), booked to five minutes; its expected distance the
 * steps' (a time at its band's middle) when every one can be read. Its stage rows (`designedRunStages`) and the
 * document at revision 1 with its revision row, in one batch; a time asked for is pinned, else the athlete's window and
 * the day's collision pass. It hangs from the account's Studio programme, as the coach's other designed workouts do.
 *
 * Statements: the key's read, the day (DAY_READS), the running read, the restore check, the batch (the programme, the
 * row, the revision, the stage inserts, a pinned time), the collision pass (two reads and the rows it moves) when
 * placed, and the watch job (the day's stamps, the insert) — design-approve.ts `runCreateCost`.
 */
export async function createDesignedRun(
  db: Db,
  userId: string,
  input: { date: string; time: string | null; doc: unknown; clientId: string },
  ctx: DocWorkoutCtx,
  source: DocWriteSource,
): Promise<DesignedRunMade> {
  const id = await keyedRowId(userId, input.clientId);
  const pw = plannedWorkouts;
  const [had] = await db
    .select({ id: pw.id, effectiveDate: pw.effectiveDate, effectiveTime: pw.effectiveTime, title: pw.title, category: pw.category, sport: pw.sport, contentState: pw.contentState, completionState: pw.completionState, workoutDocRev: pw.workoutDocRev, seconds: pw.fallbackEstimatedDurationSeconds, summary: sql<string | null>`case when json_valid(${pw.workoutDoc}) then json_extract(${pw.workoutDoc}, '$.intent.summary') end` })
    .from(pw)
    .where(and(eq(pw.id, id), eq(pw.userId, userId)))
    .limit(1);
  if (had) {
    return {
      workout: { id: had.id, date: had.effectiveDate, time: had.effectiveTime, title: had.title, intentSummary: had.summary ?? "", category: had.category, sport: had.sport, origin: "coach", contentState: had.contentState ?? "outline", completionState: had.completionState, docRev: had.workoutDocRev ?? null, minutes: Math.round((had.seconds ?? 0) / 60) },
      warnings: [],
      queued: false,
      repeated: true,
    };
  }
  if (input.date < ctx.today) throw new PastDateError();
  const doc = parsedDoc(input.doc);
  const [day, ran] = await Promise.all([
    docDayContext(db, userId, { date: input.date, today: ctx.today, workoutId: id, placeId: doc.setting?.placeId }),
    db.all(sql`select ${runCtxSql(userId, input.date)} as r`) as Promise<Array<{ r: unknown }>>,
  ]);
  const running = runCtxOf(ran[0]?.r ?? null);
  const warnings = accepted(judgeDoc(doc, { ...day, run: running }));
  const made = runWatchSessionOf(doc);
  // The validator refuses what the wire can't hold first (run_mixed, run_open, run_too_long): never reached.
  if (!("session" in made)) throw new DocInvalidError(warnings);
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();

  const threshold = running.thresholdSecPerKm;
  const resolved = runWatchSteps(made.session, threshold);
  const derived = deriveDoc(doc, EXERCISES);
  const seconds = resolved.totalSeconds ?? derived.estimatedMinutes * 60;
  const efforts = new Set(doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "run" ? [i.effort] : []))));
  const subtype = derived.category === "quality" ? (SUBTYPE_OF.find(([e]) => efforts.has(e))?.[1] ?? null) : null;
  const stages = designedRunStages(id, doc, threshold);
  const date = input.date;
  const row = {
    id,
    userId,
    planId: studioProgramId(userId),
    sourceWorkoutId: id,
    sourceProgramId: null,
    sourceIdInPlan: null,
    title: doc.title,
    category: derived.category,
    qualitySubtype: subtype,
    sport: "run",
    originalPlanDate: date,
    // "" = COROS has never verified this row: the create's verify stamps the real date.
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: input.time ?? windowTimeFor({ category: derived.category, date }, ctx.prefs),
    // A seed no COROS read could be mistaken for (`isUpstreamFingerprint`): the create's verify writes the wire's own.
    sourceContentFingerprint: DESIGNED_RUN_SEED,
    sourceVersion: null,
    sourceEstimatedDurationSeconds: null,
    fallbackEstimatedDurationSeconds: seconds,
    calendarBlockDurationSeconds: bookedSeconds(seconds),
    durationEstimate: null,
    expectedDistanceMeters: resolved.totalMeters,
    stageSummary: summarizeStageRows(stages.map((s) => ({ ...s, ord: s.ord }))),
    structuredJson: null,
    calendarSyncState: "not_created",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    missingReads: 0,
    origin: null,
    ...newRowDocColumns(doc),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  } satisfies typeof plannedWorkouts.$inferInsert;
  await runAtomically(db, [
    db
      .insert(programs)
      .values({ id: studioProgramId(userId), userId, kind: "studio", name: "Studio", status: "active", disciplines: [], startDate: null, endDate: null, raceDate: null, source: null, config: {}, createdAt: ctx.now, updatedAt: ctx.now, archivedAt: null })
      .onConflictDoNothing(),
    db.insert(plannedWorkouts).values(row),
    revisionInsert(db, { userId, workoutId: id, sourceKind: source.sourceKind ?? "coach", sourceRef: source.sourceRef ?? null, now: ctx.now }),
    ...insertBatches(stages).map((batch) => db.insert(plannedWorkoutStages).values(batch)),
    // A time asked for is pinned, as a time the athlete picks is: no collision pass moves it.
    ...(input.time != null
      ? [db.insert(scheduleOverrides).values({ id: newId(), workoutId: id, kind: "time_change", fromDate: date, toDate: date, toTime: input.time, source: "app", createdAt: ctx.now })]
      : []),
  ]);
  let time = row.effectiveTime;
  if (input.time == null) {
    const moved = await separateDayCollisions(db, userId, [date], ctx.prefs, { from: ctx.today, now: ctx.now });
    time = moved.find((m) => m.workoutId === id)?.to ?? time;
  }
  // To the watch when approved (decision 1): the athlete's approval is the consent; the job runs as the client drains.
  const queued = ctx.prefs.corosWritesEnabled === true && (await enqueueWatchCreate(db, userId, id, date, made.session, ctx.now, threshold ?? undefined)) !== null;
  return {
    workout: { id, date, time, title: doc.title, intentSummary: doc.intent.summary, category: derived.category, sport: "run", origin: "coach", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: Math.round(seconds / 60) },
    warnings,
    queued,
  };
}

// ── Fixture mode only: the e2e's levers (index.ts `/api/dev/threshold`, `/api/dev/coach-job`) ────────────────────────

/** The athlete's threshold pace for `date` — what the COROS read writes in production; the fixture account has none. */
export async function fixtureThreshold(db: Db, userId: string, date: string, secPerKm: number, now: string): Promise<void> {
  await db
    .insert(dailyHealth)
    .values({ id: `${userId}:${date}`, userId, date, thresholdPaceSecPerKm: secPerKm, contentFingerprint: "fixture-threshold", updatedAt: now })
    .onConflictDoUpdate({ target: dailyHealth.id, set: { thresholdPaceSecPerKm: secPerKm, updatedAt: now } });
}

/**
 * A workout's watch create job, and the program the write lane would put on the watch from it now (`buildProgramFor`,
 * the freshest threshold): each step's role, time and pace bytes — computed, never sent (the fixture's COROS connection
 * holds no credentials). Null when the workout has no such job.
 */
export async function fixtureWatchJob(db: Db, userId: string, workoutId: string): Promise<{
  kind: string;
  status: string;
  sessionKind: string | null;
  steps: Array<Record<string, unknown>>;
} | null> {
  const [job] = await db
    .select({ kind: corosWriteJobs.kind, status: corosWriteJobs.status, payload: corosWriteJobs.payload })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, "coach_create_workout")))
    .limit(1);
  if (!job) return null;
  const parsed = coachCreateWorkoutJobSchema.safeParse(job.payload);
  if (!parsed.success) return { kind: job.kind, status: job.status, sessionKind: null, steps: [] };
  const [t] = (await db.all(sql`select ${thresholdSql(userId)} as t`)) as Array<{ t: unknown }>;
  const threshold = runningFactsOf(t?.t ?? null, null).threshold?.secPerKm ?? parsed.data.thresholdPaceSecPerKm;
  const program = buildProgramFor({ happenDay: parsed.data.happenDay.replaceAll("-", ""), name: parsed.data.name, session: parsed.data.session, ...(threshold ? { thresholdPaceSecPerKm: threshold } : {}) }, new Map());
  const pick = ["exerciseType", "name", "targetType", "targetValue", "intensityType", "intensityValue", "intensityValueExtend", "intensityMultiplier", "intensityDisplayUnit"];
  return {
    kind: job.kind,
    status: job.status,
    sessionKind: (parsed.data.session as { kind?: string }).kind ?? null,
    steps: (program.exercises ?? []).map((e) => Object.fromEntries(pick.map((k) => [k, (e as unknown as Record<string, unknown>)[k]]))),
  };
}
