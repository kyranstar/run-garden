/**
 * read_balance(from, to) — the computed balance of what was done over a range (Stage 3 spec §4; principles §2.3,
 * §2.4): `derivePerformed` (@rg/workout, the same rules a document's balance is computed with) over every session and
 * activity in the range, summed — contraction types (isometric minutes, isotonic and eccentric reps, plyometric
 * contacts), aerobic, mobility and recovery minutes, exposure by region and muscle ranked (in working sets), the
 * regions not trained at all (null when nothing was logged), and for each of the athlete's focus areas the last day it
 * was trained and its working sets (each set of a move that trains it, once). The units are in the answer. One
 * physical session counts once; a session's played-only moves count as played, once. Nothing logged is said, never
 * balanced as zeros. A watch move counts as the library move its key maps to; one the library has no record for is
 * named in `missing` by COROS's own name, with how many sessions logged it (fix wave 13, A2) — never dropped in
 * silence. Two statements: the athlete with the focus areas, then the range in one read — the computation is
 * `readExposure` (body-exposure.ts), shared with Growth's body map.
 *
 * RUNS LOAD THE LEGS (audit I5). A run is no working set, so the regions above are the sessions' alone; what runs
 * loaded is said apart (`fromRuns`: each region a run loads — RUN_REGIONS — with the runs in the range and the last
 * one's date). A region a run loaded is never listed untrained, and a focus area that means one of them gains
 * `lastRun` beside its strength-only `lastTrained` — so a run-heavy week never reads as legs left untrained.
 */
import { z } from "zod";
import { dayRangeLabel, daysBetween } from "@rg/domain";
import { REGIONS } from "@rg/exercise-library";
import type { DesignTool } from "./types.js";
import { answer, checkRange, DATE_SCHEMA, dateField, isErr, parseInput, plural, READ_ROLES, untrusted } from "./read-common.js";
import { readExposure, regionOf, RUN_REGIONS } from "../body-exposure.js";

const TOP_REGIONS = 10;
const TOP_MUSCLES = 12;
/** Watch moves named in `missing`, at most (the rest are counted). */
const WATCH_NAMED = 8;
const RUN_REGION_SET = new Set<string>(RUN_REGIONS);

/** What each figure counts. */
const UNITS = {
  balance: "isometricMin, aerobicMin, mobilityMin, recoveryMin in minutes; isotonicReps and eccentricReps in reps (a side each); plyoContacts in contacts",
  regions: "working sets of the moves that load each region (top ten); runs are counted apart, in fromRuns",
  muscles: "working sets, a muscle a move works secondarily counting half (top twelve)",
  focusAreas: "working sets of the moves that train any of the area's regions or muscles, each set once; lastTrained is a strength, mobility or care session's, lastRun a run's",
  fromRuns: `each region a run loads (${RUN_REGIONS.join(", ")}): the runs in the range and the last one's date — such a region is never listed untrained`,
} as const;

const input = z.object({ from: dateField, to: dateField }).strict();

const round1 = (n: number): number => Math.round(n * 10) / 10;
const top = (m: Map<string, number>, n: number): Record<string, number> =>
  Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, v]) => [k, round1(v)]));

export const readBalance: DesignTool = {
  name: "read_balance",
  description:
    "The balance of what was done between two dates: contraction types, aerobic and mobility minutes, exposure by region and muscle, what runs loaded, untrained regions, and when each focus area was last trained.",
  inputSchema: { type: "object", properties: { from: DATE_SCHEMA, to: DATE_SCHEMA }, required: ["from", "to"], additionalProperties: false },
  statementCost: 2,
  cpuWeight: 1.7,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "from and to (YYYY-MM-DD)");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    const { athlete, sessions: chosen, runs, other, nothing, balance, regions, muscles, focus, focusSeen, lastRun, ranDays, unknown, watchUnknown } =
      await readExposure(ctx.db, ctx.userId, ctx.now, p);
    const fromRuns = lastRun ? Object.fromEntries(RUN_REGIONS.map((r) => [r, { runs: ranDays.length, last: lastRun }])) : {};
    const runLoaded = (region: string): boolean => lastRun !== null && RUN_REGION_SET.has(region);

    const minutes = (sec: number) => Math.round(sec / 60);
    const missing: string[] = [...athlete.missing];
    if (nothing) missing.push(`nothing logged from ${p.from} to ${p.to}`);
    if (watchUnknown.size) {
      const named = [...watchUnknown.entries()]
        .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
        .map(([name, sessions]) => `${name} (${plural(sessions.size, "session")})`);
      const shown = named.slice(0, WATCH_NAMED);
      const more = named.length > WATCH_NAMED ? `, and ${named.length - WATCH_NAMED} more` : "";
      missing.push(`${plural(watchUnknown.size, "watch move")} not in the library, left out of the balance: ${shown.join(", ")}${more}`);
    }
    if (unknown.size) missing.push(`${plural(unknown.size, "logged move")} the library does not know, left out of the balance`);
    return answer({
      source: "derivePerformed over logged sessions (app and watch) and the watch's activities",
      now: ctx.now,
      missing,
      data: {
        from: p.from,
        to: p.to,
        units: UNITS,
        sessions: chosen.length,
        runs,
        other,
        balance: nothing
          ? null
          : {
              isometricMin: minutes(balance.isometricSec),
              isotonicReps: balance.isotonicReps,
              eccentricReps: balance.eccentricReps,
              plyoContacts: balance.plyoContacts,
              aerobicMin: minutes(balance.aerobicSec),
              mobilityMin: minutes(balance.mobilitySec),
              recoveryMin: minutes(balance.recoverySec),
            },
        regions: top(regions, TOP_REGIONS),
        fromRuns,
        // Unknown when nothing was logged: not every region untrained. A region a run loaded is not untrained.
        untrained: nothing ? null : REGIONS.filter((r) => r !== "full-body" && !(regions.get(r)! > 0) && !runLoaded(r)),
        muscles: top(muscles, TOP_MUSCLES),
        focusAreas: focus.map((f) => {
          const seen = focusSeen.get(f.id)!;
          const ran = f.refs.some((ref) => runLoaded(regionOf(ref) ?? ""));
          return {
            id: f.id,
            label: untrusted(f.label),
            lastTrained: seen.last,
            daysAgo: seen.last ? daysBetween(seen.last, athlete.today) : null,
            sets: round1(seen.sets),
            ...(ran ? { lastRun } : {}),
          };
        }),
      },
      summary: nothing
        ? `Nothing logged, ${dayRangeLabel(p.from, p.to)}`
        : `Read the balance of ${plural(chosen.length, "session")} and ${plural(runs + other, "activity", "activities")}, ${dayRangeLabel(p.from, p.to)}`,
    });
  },
};
