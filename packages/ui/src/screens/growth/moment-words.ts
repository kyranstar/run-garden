/**
 * The objectives board's garden moments (the new shape §7), pure: each key result's best ever (once it has something to
 * beat — the board's `best`), on its day, in its own unit ("A best ever on Wall sit hold: 96 s."), and each completed
 * objective, on the day it was marked complete in the athlete's zone ("“Hold a strong wall sit” is complete."). They
 * ride the arrival block's watermark (arrival.ts `selectArrival`'s `moments`).
 *
 * Kept out of arrival.ts on purpose: that module is pure and dependency-light (a worker test reads it), and a key
 * result's words come from the board's model, which is UI code.
 *
 * Read leniently: Today calls this, and a board read that failed, came back partial or from an older shape must never
 * break Today — what can't be read is no moment.
 */
import { todayInZone, type ObjectiveBoardDto } from "@rg/domain";
import type { ArrivalMoment } from "../arrival.js";
import { formatKr } from "../studio/objectives-model.js";

export function objectiveMoments(board: ObjectiveBoardDto | null | undefined, tz: string): ArrivalMoment[] {
  const cards = Array.isArray(board?.objectives) ? board.objectives : [];
  return cards.flatMap((c) => {
    if (!c || typeof c !== "object" || !c.objective) return [];
    const bests = (Array.isArray(c.keyResults) ? c.keyResults : []).flatMap((k) =>
      k?.best && typeof k.best.date === "string" && typeof k.best.display === "number" && k.keyResult
        ? [{ date: k.best.date, line: `A best ever on ${k.keyResult.label}: ${formatKr(k.best.display, k.keyResult.unit, k.keyResult.measure)}.` }]
        : [],
    );
    const at = Date.parse(c.objective.updatedAt);
    const done =
      c.objective.status === "done" && Number.isFinite(at) ? [{ date: dayInZone(tz, new Date(at)), line: `“${c.objective.title}” is complete.` }] : [];
    return [...bests, ...done];
  });
}

/** The day an instant falls on in `tz`; an unknown zone reads UTC. */
function dayInZone(tz: string, at: Date): string {
  try {
    return todayInZone(tz, at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
