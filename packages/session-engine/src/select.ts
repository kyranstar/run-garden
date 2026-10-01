import { label, positionGroup, type EngineData, type ExerciseRecord, type HistorySession, type Theme } from "@rg/exercise-library";
import type { CoverageDates, CoverageMap } from "./coverage.js";
import { Hist, HistIndex } from "./hist.js";
import type { Prefs } from "./types.js";

// Scores candidate exercises for a slot and keeps the top reasons as "why this".

/** Score weights. The penalty for moves flagged in past sessions is each active profile's own weight. */
export const WEIGHTS = { theme: 3, debt: 3, novelty: 1.5, newMove: 3, saved: 1, rating: 2, flow: 1, repetition: 5, prep: 1, jitter: 0.5 };
const NEW_MOVE = "New move this week";
const RECENT_SESSIONS = 3;   // how far back the repetition penalty looks

export interface ExerciseStats {
  lastDate: string | null;
  /** Appearances in the last RECENT_SESSIONS sessions. */
  recent: number;
  /** Logged entries. */
  logged: number;
  /** Logged entries carrying each flag. */
  flags: Record<string, number>;
}

export interface SelectCtx {
  today: string;
  theme: Theme | Pick<Theme, "name" | "emphasis"> | null;
  debt: CoverageMap;
  maxDebt: number;
  coverageLast: CoverageDates;
  stats: Map<string, ExerciseStats>;
  prefs: Partial<Prefs>;
  rng: () => number;
  /** A fixed per-exercise tie-breaker (the builder's), so one swap doesn't reshuffle every other slot. */
  jitter?: (id: string) => number;
  newMoveOpen: boolean;
  prevPosition?: string | null;
  coreRegions?: readonly string[] | null;
  /** Exercise ids the person saved themselves. */
  saved?: ReadonlySet<string>;
}

export interface Scored {
  ex: ExerciseRecord;
  total: number;
  reasons: string[];
  isNew: boolean;
}

function statsIn(h: HistIndex, today: string): Map<string, ExerciseStats> {
  return h.memo(`stats|${today}`, () => {
    const ordered = h.sorted().filter(s => s.date <= today);
    const recent = new Set(ordered.slice(-RECENT_SESSIONS));
    const map = new Map<string, ExerciseStats>();
    const get = (raw: string): ExerciseStats => {
      const id = h.canonical(raw);
      let st = map.get(id);
      if (!st) {
        st = { lastDate: null, recent: 0, logged: 0, flags: {} };
        map.set(id, st);
      }
      return st;
    };
    const summary = h.movesAsOf(today);
    if (summary) {
      // A trimmed history: the all-time facts from its summary, the last sessions from the sessions.
      for (const [raw, m] of Object.entries(summary)) {
        if (m.last === null && !m.logged) continue;
        const st = get(raw);
        if (m.last && (!st.lastDate || m.last > st.lastDate)) st.lastDate = m.last;
        st.logged += m.logged;
        for (const [flag, n] of Object.entries(m.flags)) st.flags[flag] = (st.flags[flag] || 0) + n;
      }
      for (const s of recent) for (const raw of h.idsIn(s)) get(raw).recent += 1;
      return map;
    }
    for (const s of ordered) {
      for (const raw of h.idsIn(s)) {
        const st = get(raw);
        if (!st.lastDate || s.date > st.lastDate) st.lastDate = s.date;
        if (recent.has(s)) st.recent += 1;
      }
      for (const e of s.entries || []) {
        if (!e || !e.id) continue;
        const st = get(e.id);
        st.logged += 1;
        const flags = e.flags;
        if (flags && flags.length) for (const flag of flags.length === 1 ? flags : new Set(flags)) st.flags[flag] = (st.flags[flag] || 0) + 1;
      }
    }
    return map;
  });
}

const stats = (data: EngineData, sessions: readonly HistorySession[], today: string): Map<string, ExerciseStats> => statsIn(HistIndex.of(data, sessions), today);

function themeFit(ex: ExerciseRecord, theme: SelectCtx["theme"]): number {
  if (!theme) return 0;
  const e = theme.emphasis || {};
  let s = 0;
  for (const p of ex.patterns) s += (e.patterns || {})[p] || 0;
  for (const r of ex.regions) s += (e.regions || {})[r] || 0;
  for (const t of ex.tags) s += (e.tags || {})[t] || 0;
  return Math.min(1, s / 3);
}

interface DebtTop {
  kind: "patterns" | "regions";
  k: string;
  d: number;
}

// The reason names the most-behind body area if there is one (it reads better than a movement type).
function debtFit(ex: ExerciseRecord, ctx: SelectCtx): { value: number; top: DebtTop | null } {
  let sum = 0;
  const tops: { regions: DebtTop | null; patterns: DebtTop | null } = { regions: null, patterns: null };
  for (const [kind, keys] of [["patterns", ex.patterns], ["regions", ex.regions]] as const) {
    for (const k of keys) {
      const d = ((ctx.debt || {})[kind] || {})[k] || 0;
      sum += d;
      const top = tops[kind];
      if (d && (!top || d > top.d)) tops[kind] = { kind, k, d };
    }
  }
  return { value: ctx.maxDebt ? Math.min(1, sum / ctx.maxDebt) : 0, top: tops.regions || tops.patterns };
}

function debtText(top: DebtTop | null, ctx: SelectCtx): string {
  const last = ctx.coverageLast || { patterns: {}, regions: {} };
  const anyHistory = Object.keys(last.patterns || {}).length > 0;
  if (!top || !anyHistory) return "";   // before any history everything is "untrained" — not worth saying
  const when = (last[top.kind] || {})[top.k];
  const days = when ? Hist.daysBetween(when, ctx.today) : null;
  if (days == null) return `${label(top.k)}: not trained yet`;
  return days >= 3 ? `${label(top.k)}: ${days} days since trained` : `${label(top.k)}: behind this week`;
}

function score(data: EngineData, ex: ExerciseRecord, ctx: SelectCtx): Scored {
  const st = (ctx.stats && ctx.stats.get(ex.id)) || { lastDate: null, recent: 0, logged: 0, flags: {} };
  const parts: Array<{ value: number; text: string }> = [];
  const add = (value: number, text = "") => parts.push({ value, text });

  add(WEIGHTS.theme * themeFit(ex, ctx.theme), ctx.theme ? `Fits today's theme: ${ctx.theme.name}` : "");
  const d = debtFit(ex, ctx);
  add(WEIGHTS.debt * d.value, debtText(d.top, ctx));
  const days = st.lastDate ? Hist.daysBetween(st.lastDate, ctx.today) : null;
  add(WEIGHTS.novelty * (days == null ? 1 : Math.min(1, days / 14)), days != null && days >= 10 ? `Not done in ${days} days` : "");
  const isNew = days == null && Boolean(ctx.newMoveOpen);
  if (isNew) add(WEIGHTS.newMove, NEW_MOVE);
  // Moves the person saved come up a bit more, especially as the weekly new move.
  if (ctx.saved && ctx.saved.has(ex.id)) add(WEIGHTS.saved * (isNew ? 2 : 1), "From your saves");
  const rating = ((ctx.prefs || {}).ratings || {})[ex.id] || 0;
  add(WEIGHTS.rating * rating, rating > 0 ? "You rated this 👍" : "");
  if (ctx.prevPosition && positionGroup(ex.position) === positionGroup(ctx.prevPosition)) add(WEIGHTS.flow);
  add(-WEIGHTS.repetition * st.recent);
  if (st.logged) {
    for (const p of data.profiles.active) {
      if (p.setFlag) add(-p.flagPenaltyWeight * ((st.flags[p.setFlag.id] || 0) / st.logged));
    }
  }
  if (ctx.coreRegions && ex.regions.some(r => ctx.coreRegions!.includes(r))) add(WEIGHTS.prep, "Preps today's lifts");

  // A fixed per-exercise tie-breaker (builder) keeps one swap from reshuffling every other slot.
  const noise = ctx.jitter ? ctx.jitter(ex.id) : ctx.rng();
  const total = parts.reduce((sum, p) => sum + p.value, 0) + noise * WEIGHTS.jitter;
  let reasons = parts.filter(p => p.value > 0 && p.text).sort((a, b) => b.value - a.value).map(p => p.text);
  if (isNew) reasons = [NEW_MOVE, ...reasons.filter(r => r !== NEW_MOVE)];
  return { ex, total, reasons: reasons.slice(0, 2), isNew };
}

const rank = (data: EngineData, pool: readonly ExerciseRecord[], ctx: SelectCtx): Scored[] =>
  pool.map(ex => score(data, ex, ctx)).sort((a, b) => b.total - a.total || a.ex.id.localeCompare(b.ex.id));

export const Select = { WEIGHTS, stats, statsIn, score, rank };
