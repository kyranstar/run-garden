/**
 * read_balance(from, to) — the computed balance of what was done over a range (Stage 3 spec §4; principles §2.3,
 * §2.4): `derivePerformed` (@rg/workout, the same rules a document's balance is computed with) over every session and
 * activity in the range, summed — contraction types (isometric minutes, isotonic and eccentric reps, plyometric
 * contacts), aerobic, mobility and recovery minutes, exposure by region and muscle ranked (in working sets), the
 * regions not trained at all (null when nothing was logged), and for each of the athlete's focus areas the last day it
 * was trained and its working sets (each set of a move that trains it, once). The units are in the answer. One
 * physical session counts once; a session's played-only moves count as played, once. Nothing logged is said, never
 * balanced as zeros. Two statements: the athlete with the focus areas, then the range in one read.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { athleteProfiles, performedSessions } from "@rg/database";
import { daysBetween, focusAreaSchema } from "@rg/domain";
import { EXERCISES, REGIONS } from "@rg/exercise-library";
import { derivePerformed, type BalanceProfile, type PerformedInput } from "@rg/workout";
import type { DesignTool } from "./types.js";
import { answer, checkRange, DATE_SCHEMA, dateField, isErr, parsedArray, parseInput, plural, READ_ROLES, readAthlete, readTagged, untrusted } from "./read-common.js";
import { activitiesAround, activityRows, doneTerms, sessionRows, sessionsOnce, sessionsWhere, setRows } from "./read-sessions.js";

const TOP_REGIONS = 10;
const TOP_MUSCLES = 12;
const LIBRARY = new Set(EXERCISES.map((e) => e.id));
const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

/** What each figure counts. */
const UNITS = {
  balance: "isometricMin, aerobicMin, mobilityMin, recoveryMin in minutes; isotonicReps and eccentricReps in reps (a side each); plyoContacts in contacts",
  regions: "working sets of the moves that load each region (top ten)",
  muscles: "working sets, a muscle a move works secondarily counting half (top twelve)",
  focusAreas: "working sets of the moves that train any of the area's regions or muscles, each set once",
} as const;

const input = z.object({ from: dateField, to: dateField }).strict();

const round1 = (n: number): number => Math.round(n * 10) / 10;
const top = (m: Map<string, number>, n: number): Record<string, number> =>
  Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, v]) => [k, round1(v)]));

export const readBalance: DesignTool = {
  name: "read_balance",
  description:
    "The balance of what was done between two dates: contraction types, aerobic and mobility minutes, exposure by region and muscle, untrained regions, and when each focus area was last trained.",
  inputSchema: { type: "object", properties: { from: DATE_SCHEMA, to: DATE_SCHEMA }, required: ["from", "to"], additionalProperties: false },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "from and to (YYYY-MM-DD)");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      focus: sql`(select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${ctx.userId})`,
    });
    const focus = parsedArray(typeof extra.focus === "string" ? extra.focus : null).flatMap((f) => {
      const parsed = focusAreaSchema.safeParse(f);
      return parsed.success ? [parsed.data] : [];
    });
    const scope = sessionsWhere(ctx.userId, sql`${performedSessions.localDate} between ${p.from} and ${p.to}`);
    const [sTerm, xTerm, , aTerm] = doneTerms(ctx.userId, scope, { activitiesWhere: activitiesAround(p.from, p.to) });
    const rows = await readTagged(ctx.db, [sTerm!, xTerm!, aTerm!]);

    const all = sessionRows(rows.get("s"));
    const chosen = sessionsOnce(all);
    const sets = setRows(rows.get("x"));
    // A session's own activity joins it whatever its date; the rest are the range's, by their local date.
    const acts = new Map(activityRows(rows.get("a"), athlete.tz).map((a) => [a.id, a]));
    const logged = new Set(all.map((s) => s.activityId).filter((id): id is string => id !== null));

    const balance: BalanceProfile = { isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 0, recoverySec: 0 };
    const regions = new Map<string, number>();
    const muscles = new Map<string, number>();
    const focusSeen = new Map<string, { last: string | null; sets: number }>(focus.map((f) => [f.id, { last: null, sets: 0 }]));
    const unknown = new Set<string>();
    const add = (input: PerformedInput) => {
      const d = derivePerformed(input, EXERCISES);
      for (const k of Object.keys(balance) as Array<keyof BalanceProfile>) balance[k] += d.balance[k];
      for (const [k, v] of Object.entries(d.regionExposure)) regions.set(k, (regions.get(k) ?? 0) + v);
      for (const [k, v] of Object.entries(d.muscleExposure)) muscles.set(k, (muscles.get(k) ?? 0) + v);
    };
    /**
     * A focus area's sets: every working set of a move that trains it, once — a move counts when any of the area's refs
     * is one of its regions or muscles, however many of them it names (an area of a region and that region's muscles
     * never counts a set twice).
     */
    const trains = (exerciseId: string, f: (typeof focus)[number]): boolean => {
      const rec = BY_ID.get(exerciseId);
      if (!rec) return false;
      const says = new Set<string>([...rec.regions, ...rec.muscles.primary, ...rec.muscles.secondary]);
      return f.refs.some((ref) => says.has(ref));
    };
    const countFocus = (exerciseId: string, workingSets: number, date: string) => {
      for (const f of focus) {
        if (!trains(exerciseId, f)) continue;
        const seen = focusSeen.get(f.id)!;
        seen.sets += workingSets;
        if (!seen.last || date > seen.last) seen.last = date;
      }
    };

    for (const s of chosen) {
      const mine = sets.filter((x) => x.session === s.id);
      const entries = new Map<string, PerformedInput["entries"][number]>();
      /** Working sets per move: a set done a side at a time (a row per side) is one set. */
      const working = new Map<string, Set<string>>();
      for (const x of mine) {
        if (!LIBRARY.has(x.exerciseId)) unknown.add(x.exerciseId);
        const key = `${x.entry}:${x.exerciseId}:${x.perSide}`;
        const e = entries.get(key) ?? { exerciseId: x.exerciseId, perSide: x.perSide, sets: [] };
        e.sets.push({ reps: x.reps, seconds: x.seconds, loadKg: null, done: true, flags: x.flags });
        entries.set(key, e);
        working.set(x.exerciseId, (working.get(x.exerciseId) ?? new Set()).add(`${x.entry}:${x.index}`));
      }
      const loggedIds = new Set(mine.map((x) => x.exerciseId));
      const played = s.movesDone.filter((m) => !loggedIds.has(m.exerciseId));
      for (const m of played) if (!LIBRARY.has(m.exerciseId)) unknown.add(m.exerciseId);
      const a = s.activityId ? acts.get(s.activityId) : undefined;
      add({ entries: [...entries.values()], movesDone: played, activity: a ? { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } : null });
      for (const [exerciseId, n] of working) countFocus(exerciseId, n.size, s.date);
      for (const m of played) countFocus(m.exerciseId, 1, s.date);
    }
    let runs = 0;
    let other = 0;
    for (const a of acts.values()) {
      if (logged.has(a.id) || a.date < p.from || a.date > p.to) continue;
      if (a.sport === "run") runs += 1;
      else other += 1;
      add({ entries: [], movesDone: [], activity: { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } });
    }

    const nothing = chosen.length === 0 && runs === 0 && other === 0;
    const minutes = (sec: number) => Math.round(sec / 60);
    const missing: string[] = [...athlete.missing];
    if (nothing) missing.push(`nothing logged from ${p.from} to ${p.to}`);
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
        // Unknown when nothing was logged: not every region untrained.
        untrained: nothing ? null : REGIONS.filter((r) => r !== "full-body" && !(regions.get(r)! > 0)),
        muscles: top(muscles, TOP_MUSCLES),
        focusAreas: focus.map((f) => {
          const seen = focusSeen.get(f.id)!;
          return {
            id: f.id,
            label: untrusted(f.label),
            lastTrained: seen.last,
            daysAgo: seen.last ? daysBetween(seen.last, athlete.today) : null,
            sets: round1(seen.sets),
          };
        }),
      },
      summary: nothing
        ? `Nothing logged from ${p.from} to ${p.to}`
        : `Read the balance of ${plural(chosen.length, "session")} and ${plural(runs + other, "activity", "activities")} from ${p.from} to ${p.to}`,
    });
  },
};
