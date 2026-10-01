import type { EngineData, ExerciseRecord, HistorySession } from "@rg/exercise-library";
import { Hist, HistIndex } from "./hist.js";

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

// Every session on or before today counts toward when each pattern and region was last trained, and those in the
// last `days` days toward how often. Worked out per move first (one entry per session and id), then spread over the
// move's patterns and regions — the same sums, maxima and key order as counting key by key, without the per-key
// work for every session. A trimmed history's summary says when each move was last done.
function exposuresIn(h: HistIndex, today: string, days = 7): { counts: CoverageMap; last: CoverageDates } {
  return h.memo(`exposures|${today}|${days}`, () => {
    const summary = h.movesAsOf(today);
    const lastOf = new Map<ExerciseRecord, string>();
    const recentOf = new Map<ExerciseRecord, number>();
    for (const s of h.sessions) {
      if (!s.date || s.date > today) continue;
      const recent = Hist.daysBetween(s.date, today) < days;
      for (const raw of h.idsIn(s)) {
        const ex = h.get(raw);
        if (!ex) continue;
        const prev = lastOf.get(ex);
        if (!summary && (prev === undefined || s.date > prev)) lastOf.set(ex, s.date);
        if (recent) recentOf.set(ex, (recentOf.get(ex) ?? 0) + 1);
      }
    }
    if (summary) {
      for (const [raw, m] of Object.entries(summary)) {
        const ex = m.last ? h.get(raw) : null;
        if (!ex) continue;
        const prev = lastOf.get(ex);
        if (prev === undefined || m.last! > prev) lastOf.set(ex, m.last!);
      }
    }
    // Maps keep the order moves were first met, so keys go in where counting key by key first met them.
    const counts: CoverageMap = { patterns: {}, regions: {} };
    const last: CoverageDates = { patterns: {}, regions: {} };
    for (const [ex, n] of recentOf) {
      for (const k of ex.patterns) counts.patterns[k] = (counts.patterns[k] || 0) + n;
      for (const k of ex.regions) counts.regions[k] = (counts.regions[k] || 0) + n;
    }
    for (const [ex, date] of lastOf) {
      for (const k of ex.patterns) if (!last.patterns[k] || date > last.patterns[k]!) last.patterns[k] = date;
      for (const k of ex.regions) if (!last.regions[k] || date > last.regions[k]!) last.regions[k] = date;
    }
    return { counts, last };
  });
}

const exposures = (data: EngineData, sessions: readonly HistorySession[], today: string, days = 7): { counts: CoverageMap; last: CoverageDates } =>
  exposuresIn(HistIndex.of(data, sessions), today, days);

function debtIn(h: HistIndex, today: string): CoverageMap {
  return h.memo(`debt|${today}`, () => {
    const { counts, last } = exposuresIn(h, today, 7);
    const out: CoverageMap = { patterns: {}, regions: {} };
    for (const kind of KINDS) {
      for (const [k, target] of Object.entries(h.data.targets[kind] || {})) {
        const missing = Math.max(0, target - (counts[kind][k] || 0));
        if (!missing) continue;
        const lastDate = last[kind][k];
        const since = lastDate ? Hist.daysBetween(lastDate, today) : NEVER_DAYS;
        out[kind][k] = missing * (1 + Math.min(since, NEVER_DAYS) / 7);
      }
    }
    return out;
  });
}

const debt = (data: EngineData, sessions: readonly HistorySession[], today: string): CoverageMap => debtIn(HistIndex.of(data, sessions), today);

export const Coverage = { exposures, debt, exposuresIn, debtIn };
