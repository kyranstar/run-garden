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
import { sql, type SQL } from "drizzle-orm";
import { activities, dailyHealth, plannedWorkouts } from "@rg/database";
import { addDays, isoWeekday, paceBandFor, parseStoredWorkoutDoc, type RunEffort } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, type RunCtx } from "@rg/workout";
import { RUN_REGIONS } from "./body-exposure.js";

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
  const nearby: RunCtx["nearby"] = (Array.isArray(near) ? near : []).flatMap((x) => {
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
