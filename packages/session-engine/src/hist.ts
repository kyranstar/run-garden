import { daysBetween as calendarDays, isLocalDate, startOfIsoWeek } from "@rg/domain";
import type { EngineData, ExerciseRecord, HistorySession } from "@rg/exercise-library";
import { Lib } from "./lib.js";

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
 */
export class HistIndex {
  private readonly memos = new Map<string, unknown>();
  private readonly records = new Map<string, ExerciseRecord | null>();
  private readonly families = new Map<ExerciseRecord, string | null>();
  private readonly ids = new Map<Pick<HistorySession, "done" | "entries">, string[]>();
  private ordered: HistorySession[] | null = null;

  private constructor(readonly data: EngineData, readonly sessions: readonly HistorySession[]) {}

  /** A fresh index over these sessions. */
  static of(data: EngineData, sessions: readonly HistorySession[] | null | undefined): HistIndex {
    return new HistIndex(data, sessions || []);
  }

  /** `hist` when it indexes exactly these sessions with this data (shared within a build), else a fresh index. */
  static for(data: EngineData, sessions: readonly HistorySession[] | null | undefined, hist?: HistIndex | null): HistIndex {
    return hist && hist.data === data && hist.sessions === sessions ? hist : HistIndex.of(data, sessions);
  }

  /** A derived fact, computed on first use and kept. Callers never change what they get back. */
  memo<T>(key: string, compute: () => T): T {
    if (this.memos.has(key)) return this.memos.get(key) as T;
    const value = compute();
    this.memos.set(key, value);
    return value;
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

export const Hist = {
  sorted, idsIn, daysBetween, canonical, firstDone, newMoveThisWeek, lastFamilyDate,
  firstDoneIn, newMoveThisWeekIn, lastFamilyDateIn,
};
