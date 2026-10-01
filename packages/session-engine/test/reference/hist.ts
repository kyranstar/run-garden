import { daysBetween as calendarDays, isLocalDate, startOfIsoWeek } from "@rg/domain";
import type { EngineData, HistorySession } from "@rg/exercise-library";
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

/** Calendar days from one local date to another (NaN when either isn't a date). */
const daysBetween = (fromKey: string, toKey: string): number =>
  isLocalDate(fromKey) && isLocalDate(toKey) ? calendarDays(fromKey, toKey) : NaN;

/** Today's id for a raw id (renamed ids resolve); an unknown id stays as it is. */
const canonical = (data: EngineData, raw: string): string => {
  const ex = Lib.get(data, raw);
  return ex ? ex.id : raw;
};

/** Canonical exercise id → date it was first done. */
function firstDone(data: EngineData, sessions: readonly HistorySession[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const s of sorted(sessions)) {
    for (const raw of idsIn(s)) {
      const id = canonical(data, raw);
      if (!first.has(id)) first.set(id, s.date);
    }
  }
  return first;
}

function newMoveThisWeek(data: EngineData, sessions: readonly HistorySession[], today: string): boolean {
  const monday = startOfIsoWeek(today);
  for (const date of firstDone(data, sessions).values()) if (date >= monday && date <= today) return true;
  return false;
}

function lastFamilyDate(data: EngineData, sessions: readonly HistorySession[], familyId: string, today: string): string | null {
  let best: string | null = null;
  for (const s of sessions || []) {
    if (s.date > today) continue;
    for (const raw of idsIn(s)) {
      const ex = Lib.get(data, raw);
      if (ex && Lib.coreFamilyOf(data, ex) === familyId && (!best || s.date > best)) best = s.date;
    }
  }
  return best;
}

export const Hist = { sorted, idsIn, daysBetween, canonical, firstDone, newMoveThisWeek, lastFamilyDate };
