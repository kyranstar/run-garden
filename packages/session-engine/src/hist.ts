import { addDays, daysBetween as calendarDays, isLocalDate, startOfIsoWeek } from "@rg/domain";
import type { EngineData, ExerciseRecord, HistorySession } from "@rg/exercise-library";
import { Lib } from "./lib.js";
import type { Block, HistorySummary, MoveSummary } from "./types.js";

// Helpers over saved sessions. Old sessions may be sparse or damaged; everything tolerates that.

type Dated = { startedAt?: string | null; date?: string | null };

const when = (s: Dated): string => String(s.startedAt || s.date || "");

/** Oldest first, by start time (or date). */
const sorted = <T extends Dated>(sessions: readonly T[] | null | undefined): T[] => [...(sessions || [])].sort((a, b) => when(a).localeCompare(when(b)));

/** Raw exercise ids a session touched: steps started plus logged entries. */
function idsIn(session: Pick<HistorySession, "done" | "entries">): string[] {
  const ids = new Set<string>();
  for (const d of session.done || []) if (d && d.id) ids.add(d.id);
  for (const e of session.entries || []) if (e && e.id) ids.add(e.id);
  return [...ids];
}

const EPOCH = "1970-01-01";
const dayNumbers = new Map<string, number>();
/**
 * A local date's day number (days since 1970-01-01; NaN when it isn't a date), remembered: a build asks about the
 * same few hundred dates thousands of times. Local dates are whole UTC days, so differences of day numbers are
 * exactly the calendar's day counts.
 */
function dayNumber(key: string): number {
  let n = dayNumbers.get(key);
  if (n === undefined) {
    n = isLocalDate(key) ? calendarDays(EPOCH, key) : NaN;
    if (dayNumbers.size >= 4096) dayNumbers.clear();
    dayNumbers.set(key, n);
  }
  return n;
}

/** Calendar days from one local date to another (NaN when either isn't a date). */
const daysBetween = (fromKey: string, toKey: string): number => dayNumber(toKey) - dayNumber(fromKey);

/** Today's id for a raw id (renamed ids resolve); an unknown id stays as it is. */
const canonical = (data: EngineData, raw: string): string => {
  const ex = Lib.get(data, raw);
  return ex ? ex.id : raw;
};

/**
 * One build's view of the history (ruling 2a-R6): what each module derives from the sessions — the sorted order,
 * the ids each session touched, the library record each raw id names, coverage, stats, first-done dates, each
 * exercise's logged entries — worked out once and shared, instead of every function rescanning every session for
 * every candidate. Each fact is computed exactly as the function that asks for it always did, the first time it is
 * asked for, and kept; nothing here changes an answer. An index belongs to one build: the sessions must not change
 * while it is in use (the engine never changes them).
 *
 * With a `HistorySummary`, `sessions` is a trimmed history (`trim`): the all-time facts — when each move was first
 * and last done, how often it was logged and flagged — come from the summary, everything else from the sessions.
 */
export class HistIndex {
  private readonly memos = new Map<string, unknown>();
  private readonly records = new Map<string, ExerciseRecord | null>();
  private readonly families = new Map<ExerciseRecord, string | null>();
  private readonly ids = new Map<Pick<HistorySession, "done" | "entries">, string[]>();
  private ordered: HistorySession[] | null = null;

  private constructor(
    readonly data: EngineData,
    readonly sessions: readonly HistorySession[],
    readonly summary: HistorySummary | null,
  ) {}

  /** A fresh index over these sessions (and, for a trimmed history, its summary). */
  static of(data: EngineData, sessions: readonly HistorySession[] | null | undefined, summary?: HistorySummary | null): HistIndex {
    return new HistIndex(data, sessions || [], summary ?? null);
  }

  /**
   * `hist` when it indexes exactly these sessions with this data (shared within a build) — and this summary, when the
   * caller has one — else a fresh index.
   */
  static for(
    data: EngineData, sessions: readonly HistorySession[] | null | undefined, hist?: HistIndex | null, summary?: HistorySummary | null,
  ): HistIndex {
    const shared = hist && hist.data === data && hist.sessions === sessions && (summary == null || hist.summary === summary);
    return shared ? hist : HistIndex.of(data, sessions, summary);
  }

  /** A derived fact, computed on first use and kept. Callers never change what they get back. */
  memo<T>(key: string, compute: () => T): T {
    if (this.memos.has(key)) return this.memos.get(key) as T;
    const value = compute();
    this.memos.set(key, value);
    return value;
  }

  /** The summary's moves, when there is one; it answers for its own date only. */
  movesAsOf(today: string): HistorySummary["moves"] | null {
    if (!this.summary) return null;
    if (this.summary.asOf !== today) throw new Error(`A history summary for ${this.summary.asOf} cannot answer for ${today}.`);
    return this.summary.moves;
  }

  /** Oldest first (Hist.sorted), shared: never change it. */
  sorted(): readonly HistorySession[] {
    return (this.ordered ??= sorted(this.sessions));
  }

  /** Hist.idsIn, once per session. */
  idsIn(session: Pick<HistorySession, "done" | "entries">): string[] {
    let ids = this.ids.get(session);
    if (!ids) {
      ids = idsIn(session);
      this.ids.set(session, ids);
    }
    return ids;
  }

  /** Lib.get, once per raw id. */
  get(raw: string): ExerciseRecord | null {
    let ex = this.records.get(raw);
    if (ex === undefined) {
      ex = Lib.get(this.data, raw);
      this.records.set(raw, ex);
    }
    return ex;
  }

  /** Hist.canonical. */
  canonical(raw: string): string {
    const ex = this.get(raw);
    return ex ? ex.id : raw;
  }

  /** Lib.coreFamilyOf, once per move. */
  familyOf(ex: ExerciseRecord): string | null {
    let family = this.families.get(ex);
    if (family === undefined) {
      family = Lib.coreFamilyOf(this.data, ex);
      this.families.set(ex, family);
    }
    return family;
  }
}

/** Canonical exercise id → date it was first done. */
const firstDoneIn = (h: HistIndex): Map<string, string> =>
  h.memo("firstDone", () => {
    const first = new Map<string, string>();
    if (h.summary) {
      // The earliest first session of the raw ids a move goes by: start order, then the date (the history's own
      // order breaks ties by date first).
      const earliest = new Map<string, MoveSummary["first"]>();
      for (const [raw, m] of Object.entries(h.summary.moves)) {
        const id = h.canonical(raw);
        const prev = earliest.get(id);
        const order = prev ? m.first.when.localeCompare(prev.when) : -1;
        if (order < 0 || (order === 0 && m.first.date < prev!.date)) earliest.set(id, m.first);
      }
      for (const [id, f] of earliest) first.set(id, f.date);
      return first;
    }
    for (const s of h.sorted()) {
      for (const raw of h.idsIn(s)) {
        const id = h.canonical(raw);
        if (!first.has(id)) first.set(id, s.date);
      }
    }
    return first;
  });

const firstDone = (data: EngineData, sessions: readonly HistorySession[]): Map<string, string> => firstDoneIn(HistIndex.of(data, sessions));

const newMoveThisWeekIn = (h: HistIndex, today: string): boolean =>
  h.memo(`newMoveThisWeek|${today}`, () => {
    const monday = startOfIsoWeek(today);
    for (const date of firstDoneIn(h).values()) if (date >= monday && date <= today) return true;
    return false;
  });

const newMoveThisWeek = (data: EngineData, sessions: readonly HistorySession[], today: string): boolean =>
  newMoveThisWeekIn(HistIndex.of(data, sessions), today);

/** Core family id → the last date on or before today a move of that family was done (every family in one pass). */
function lastFamilyDatesIn(h: HistIndex, today: string): Map<string, string | null> {
  return h.memo(`lastFamilyDates|${today}`, () => {
    const best = new Map<string, string | null>();
    for (const s of h.sessions) {
      if (s.date > today) continue;
      for (const raw of h.idsIn(s)) {
        const ex = h.get(raw);
        const family = ex ? h.familyOf(ex) : null;
        if (family === null) continue;
        const prev = best.get(family);
        if (prev === undefined || !prev || s.date > prev) best.set(family, s.date);
      }
    }
    return best;
  });
}

const lastFamilyDateIn = (h: HistIndex, familyId: string, today: string): string | null => {
  const best = lastFamilyDatesIn(h, today);
  return best.has(familyId) ? best.get(familyId)! : null;
};

const lastFamilyDate = (data: EngineData, sessions: readonly HistorySession[], familyId: string, today: string): string | null =>
  lastFamilyDateIn(HistIndex.of(data, sessions), familyId, today);

// ── Trimmed histories (ruling 2a-R6) ───────────────────────────────────────────────────────────────────────────
//
// What a build on `today` reads, module by module, and how far back:
//  - coverage counts (debt, the theme): sessions in the last 7 days; "days since" a pattern or region counts up to
//    14 in the debt — WINDOW_DAYS covers both. The theme also avoids the last themed session before today and any
//    theme done today.
//  - the proposal: the last session (gap, its checks and flags), the last 7 days (the week, its checks), the last
//    build-mode session if it was within 2 days.
//  - each core family's last day: capped at 14 days.
//  - the repetition penalty: the last 3 sessions on or before today.
//  - progression targets and a topped-out lift: each move's 2 newest logged entries; block rotation: the block's
//    lifts' entries since the block started (or the lift joined it).
//  - novelty and "not done in N days", "new move this week", "days since trained", the flag penalty: ALL-TIME facts
//    per move (first and last done, entries and flags) — the summary.
// Records and milestones are not part of a build. `trim` keeps exactly the sessions the first six read; everything
// else a build reads comes from `summarize`. Both work on raw ids, so renamed moves need no library.

const WINDOW_DAYS = 14;
const RECENT_SESSIONS = 3;
const PROGRESSION_ENTRIES = 2;

/** A logged entry progression reads: ladders and circuits don't count, nor an entry with no sets. */
const isProgression = (e: HistorySession["entries"][number] | null | undefined): e is HistorySession["entries"][number] =>
  Boolean(e && e.id && e.format !== "ladder" && e.format !== "circuit" && (e.sets || []).some(Boolean));

/**
 * The sessions a build on `today` reads one by one (see above), in the history's order: the last 14 days (and
 * anything dated later), from the block's start while it runs; the last 3 sessions on or before today; the last
 * themed session before today; and the sessions holding each move's 2 newest progression entries. With
 * `summarize(sessions, today)` alongside, a build plans exactly what it plans from the whole history.
 */
function trim(sessions: readonly HistorySession[], today: string, block: Pick<Block, "startedAt" | "weeks" | "rotations"> | null): HistorySession[] {
  const keep = new Set<HistorySession>();
  let from = addDays(today, -WINDOW_DAYS);
  if (block && !(daysBetween(block.startedAt, today) >= block.weeks * 7)) {
    for (const d of [block.startedAt, ...(block.rotations || []).map(r => r.date)]) if (d < from) from = d;
  }
  for (const s of sessions) if (!(s.date < from)) keep.add(s);
  const ordered = sorted(sessions);
  for (const s of ordered.filter(x => x.date <= today).slice(-RECENT_SESSIONS)) keep.add(s);
  const themed = ordered.filter(s => s.date < today && s.theme).pop();
  if (themed) keep.add(themed);
  // Newest first per raw id (start time, else date; the history's order on a tie), as progression orders them.
  const byId = new Map<string, Array<{ s: HistorySession; at: string }>>();
  for (const s of sessions) {
    for (const e of s.entries || []) {
      if (!isProgression(e)) continue;
      const list = byId.get(e.id);
      const item = { s, at: String(s.startedAt || s.date) };
      if (list) list.push(item);
      else byId.set(e.id, [item]);
    }
  }
  for (const list of byId.values()) {
    for (const { s } of list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, PROGRESSION_ENTRIES)) keep.add(s);
  }
  return sessions.filter(s => keep.has(s));
}

/** The all-time facts of a history a trimmed one can't show, as of `asOf` (see `HistorySummary`). */
function summarize(sessions: readonly HistorySession[], asOf: string): HistorySummary {
  const moves: Record<string, { first: MoveSummary["first"]; last: string | null; logged: number; flags: Record<string, number> }> = {};
  const at = (raw: string, s: HistorySession) => (moves[raw] ??= { first: { when: when(s), date: s.date }, last: null, logged: 0, flags: {} });
  for (const s of sorted(sessions)) {
    for (const raw of idsIn(s)) {
      const m = at(raw, s);
      if (s.date && s.date <= asOf && (m.last === null || s.date > m.last)) m.last = s.date;
    }
    if (!(s.date <= asOf)) continue;
    for (const e of s.entries || []) {
      if (!e || !e.id) continue;
      const m = at(e.id, s);
      m.logged += 1;
      for (const flag of new Set(e.flags || [])) m.flags[flag] = (m.flags[flag] || 0) + 1;
    }
  }
  return { asOf, moves };
}

export const Hist = {
  sorted, idsIn, daysBetween, canonical, firstDone, newMoveThisWeek, lastFamilyDate, trim, summarize,
  firstDoneIn, newMoveThisWeekIn, lastFamilyDateIn,
};
