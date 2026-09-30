import type { EngineData, HistorySession } from "@rg/exercise-library";
import { Hist } from "./hist.js";
import { Lib } from "./lib.js";

// What's been trained lately, and what's behind (debt) against the weekly targets.

const NEVER_DAYS = 14;
const KINDS = ["patterns", "regions"] as const;

export interface CoverageMap {
  patterns: Record<string, number>;
  regions: Record<string, number>;
}
export interface CoverageDates {
  patterns: Record<string, string>;
  regions: Record<string, string>;
}

function exposures(data: EngineData, sessions: readonly HistorySession[], today: string, days = 7): { counts: CoverageMap; last: CoverageDates } {
  const counts: CoverageMap = { patterns: {}, regions: {} };
  const last: CoverageDates = { patterns: {}, regions: {} };
  for (const s of sessions || []) {
    if (!s.date || s.date > today) continue;
    const recent = Hist.daysBetween(s.date, today) < days;
    for (const raw of Hist.idsIn(s)) {
      const ex = Lib.get(data, raw);
      if (!ex) continue;
      for (const [kind, keys] of [["patterns", ex.patterns], ["regions", ex.regions]] as const) {
        for (const k of keys) {
          if (recent) counts[kind][k] = (counts[kind][k] || 0) + 1;
          const prev = last[kind][k];
          if (!prev || s.date > prev) last[kind][k] = s.date;
        }
      }
    }
  }
  return { counts, last };
}

function debt(data: EngineData, sessions: readonly HistorySession[], today: string): CoverageMap {
  const { counts, last } = exposures(data, sessions, today, 7);
  const out: CoverageMap = { patterns: {}, regions: {} };
  for (const kind of KINDS) {
    for (const [k, target] of Object.entries(data.targets[kind] || {})) {
      const missing = Math.max(0, target - (counts[kind][k] || 0));
      if (!missing) continue;
      const lastDate = last[kind][k];
      const since = lastDate ? Hist.daysBetween(lastDate, today) : NEVER_DAYS;
      out[kind][k] = missing * (1 + Math.min(since, NEVER_DAYS) / 7);
    }
  }
  return out;
}

export const Coverage = { exposures, debt };
