/**
 * read_readiness(days?) — how recovered the athlete reads (Stage 3 spec §4): the app's readiness verdict, built by the
 * one readiness builder every surface uses (`buildReadiness`: one morning against the athlete's own baseline), and
 * each signal — heart-rate variability, resting heart rate, sleep, training load, the watch's recovery — with the
 * date it was last read and how old that is, plus the last `days` days. A signal not read in 30 days is null and
 * said in `missing`; one more than two days old is said as stale. One statement: the athlete with the last month of
 * wellness and sleep.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dailyHealth, sleepRecords } from "@rg/database";
import { addDays, daysBetween } from "@rg/domain";
import { buildReadiness } from "../readiness.js";
import type { DesignTool } from "./types.js";
import { ageWords, answer, durationWords, isErr, parsedArray, parseInput, READ_ROLES, readAthlete } from "./read-common.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
/** How far back a signal is looked for (and what "none" means). */
const LOOKBACK_DAYS = 30;
/** The readiness builder's window (the app's own: two weeks, newest first). */
const READINESS_WINDOW = 14;
/** Older than this, a reading is stale. */
const STALE_DAYS = 2;

const input = z.object({ days: z.number().int().min(1).max(MAX_DAYS).optional() }).strict();

interface Health {
  date: string;
  hrv: number | null;
  restingHeartRate: number | null;
  recoveryScore: number | null;
  sleepHrvBase: number | null;
  sleepHrvSd: number | null;
  load7d: number | null;
  ratio: number | null;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export const readReadiness: DesignTool = {
  name: "read_readiness",
  description: "The app's readiness verdict and each signal — HRV, resting heart rate, sleep, training load, recovery — with when it was last read, and the last few days.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: `Days of history to list. Default ${DEFAULT_DAYS}.` } },
    additionalProperties: false,
  },
  statementCost: 1,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "an optional days (1–30)");
    if (isErr(p)) return p;
    const days = p.days ?? DEFAULT_DAYS;
    // Every timezone's today is within a day of the UTC date: read a day either side and keep the athlete's own window.
    const utc = ctx.now.toISOString().slice(0, 10);
    const lo = addDays(utc, -(LOOKBACK_DAYS + 1));
    const hi = addDays(utc, 1);
    const h = dailyHealth;
    const s = sleepRecords;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      health: sql`(select json_group_array(json_object('date', ${h.date}, 'hrv', ${h.hrv}, 'restingHeartRate', ${h.restingHeartRate},
          'recoveryScore', ${h.recoveryScore}, 'sleepHrvBase', ${h.sleepHrvBase}, 'sleepHrvSd', ${h.sleepHrvSd}, 'load7d', ${h.trainingLoad7d},
          'ratio', ${h.loadRatio}))
          from ${h} where ${h.userId} = ${ctx.userId} and ${h.date} between ${lo} and ${hi})`,
      sleep: sql`(select json_group_array(json_object('date', ${s.date}, 'seconds', ${s.durationSeconds}, 'quality', ${s.qualityScore}))
          from ${s} where ${s.userId} = ${ctx.userId} and ${s.date} between ${lo} and ${hi})`,
    });
    const today = athlete.today;
    const from = addDays(today, -(LOOKBACK_DAYS - 1));
    const inWindow = (d: unknown): d is string => typeof d === "string" && d >= from && d <= today;
    const health: Health[] = parsedArray(extra.health)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => inWindow(r.date))
      .map((r) => ({
        date: r.date as string,
        hrv: n(r.hrv),
        restingHeartRate: n(r.restingHeartRate),
        recoveryScore: n(r.recoveryScore),
        sleepHrvBase: n(r.sleepHrvBase),
        sleepHrvSd: n(r.sleepHrvSd),
        load7d: n(r.load7d),
        ratio: n(r.ratio),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const sleep = parsedArray(extra.sleep)
      .map((r) => r as Record<string, unknown>)
      .filter((r) => inWindow(r.date) && typeof r.seconds === "number" && r.seconds > 0)
      .map((r) => ({ date: r.date as string, seconds: r.seconds as number, quality: n(r.quality) }))
      .sort((a, b) => b.date.localeCompare(a.date));

    const view = buildReadiness(health.slice(0, READINESS_WINDOW), today);
    const latest = <K extends keyof Health>(k: K, ok: (v: number) => boolean = () => true) => health.find((r) => typeof r[k] === "number" && ok(r[k] as number));
    const hrv = latest("hrv", (v) => v > 0);
    const rhr = latest("restingHeartRate", (v) => v > 0);
    const load = latest("load7d");
    const recovery = latest("recoveryScore", (v) => v > 0);
    const lastSleep = sleep[0];
    const windowSleep = sleep.filter((r) => daysBetween(r.date, today) < days);

    const missing: string[] = [];
    const say = (what: string, row: { date: string } | undefined) => {
      if (!row) missing.push(`no ${what} in the last ${LOOKBACK_DAYS} days`);
      else if (daysBetween(row.date, today) > STALE_DAYS) missing.push(`${what} last read ${daysBetween(row.date, today)} d ago`);
    };
    say("HRV", hrv);
    say("resting heart rate", rhr);
    if (!lastSleep) missing.push(`no sleep recorded in the last ${LOOKBACK_DAYS} days`);
    else if (daysBetween(lastSleep.date, today) > STALE_DAYS) missing.push(`sleep last recorded ${daysBetween(lastSleep.date, today)} d ago`);
    if (!view.verdict) missing.push("no readiness verdict: too little recent data to judge");

    const byDate = new Map(health.map((r) => [r.date, r]));
    const sleepByDate = new Map(sleep.map((r) => [r.date, r]));
    const list = Array.from({ length: days }, (_, i) => {
      const date = addDays(today, -i);
      const r = byDate.get(date);
      const sl = sleepByDate.get(date);
      return {
        date,
        ...(r?.hrv ? { hrv: r.hrv } : {}),
        ...(r?.restingHeartRate ? { rhr: r.restingHeartRate } : {}),
        ...(sl ? { sleep: durationWords(sl.seconds) } : {}),
        ...(r?.load7d !== null && r?.load7d !== undefined ? { load: r.load7d } : {}),
      };
    });

    return answer({
      source: "the watch's daily wellness and sleep, and the app's readiness builder",
      now: ctx.now,
      missing,
      data: {
        verdict: view.verdict ? { level: view.verdict.level, reasons: view.verdict.reasons } : null,
        hrv: hrv
          ? { latest: hrv.hrv, date: hrv.date, age: ageWords(hrv.date, today), baseline: view.baseline?.hrv ?? null, ...(view.band ? { band: [view.band.lo, view.band.hi] } : {}) }
          : null,
        restingHr: rhr ? { latest: rhr.restingHeartRate, date: rhr.date, age: ageWords(rhr.date, today), baseline: view.baseline?.restingHeartRate ?? null } : null,
        sleep: lastSleep
          ? {
              last: durationWords(lastSleep.seconds),
              date: lastSleep.date,
              age: ageWords(lastSleep.date, today),
              ...(lastSleep.quality !== null ? { quality: lastSleep.quality } : {}),
              ...(windowSleep.length > 1
                ? { average: `${durationWords(windowSleep.reduce((t, r) => t + r.seconds, 0) / windowSleep.length)} over ${windowSleep.length} nights` }
                : {}),
            }
          : null,
        load: load ? { sevenDay: load.load7d, ...(load.ratio !== null ? { ratio: load.ratio } : {}), date: load.date, age: ageWords(load.date, today) } : null,
        recovery: recovery ? { score: recovery.recoveryScore, date: recovery.date, age: ageWords(recovery.date, today) } : null,
        days: list,
      },
      summary: view.verdict ? `Read readiness — ${view.verdict.level}` : "Read readiness — too little recent data for a verdict",
    });
  },
};
