/**
 * THE WATCH CATCHES UP WHILE THE APP IS OPEN (the watch mirrors the plan §3.7, A5). The hourly runs one watch job an
 * hour; while a screen that shows the watch is open, the app drains what is waiting, one job a request
 * (`drainWatchUntilIdle`, at most six). Decided ONCE, when the screen's data first arrives: `waiting` is `undefined`
 * while it loads, then whether the watch has work waiting (the session sheet: its state `updating` or `sending`; Today:
 * a session on the page updating — its row's `watch_updating`). A state that turns to waiting later (after a watch
 * write, say) is the action's own drain's, never this one's. `after` runs when the chain ends having run something —
 * read again what it changed.
 */
import { useEffect, useRef } from "react";
import { api } from "@rg/api-client";
import { appAuthoredRow } from "@rg/domain";

export function useWatchCatchUp(waiting: boolean | undefined, after: () => void): void {
  const decided = useRef(false);
  const latest = useRef(after);
  latest.current = after;
  useEffect(() => {
    if (waiting === undefined || decided.current) return;
    decided.current = true;
    if (waiting) void api.drainWatchUntilIdle().then(({ ran }) => ran > 0 && latest.current());
  }, [waiting]);
}

/**
 * A CHANGE TO TODAY'S SESSION GOES TO THE WATCH AS THE DAY'S BUILD (the watch mirrors the plan §3.3; M1). A session of
 * today whose check is answered is never sent a provisional copy — the day's reading may close a move — so after a
 * change lands on one (a Studio save, a coach approve, a move onto today, Put on my watch) its day build is asked for
 * (`POST …/build`, the sheet's own call: the server's mirror hands it over, replaces the copy or pushes it), and then
 * the drain chain runs what that queued. Only for a session the build may go on: not started or done, its day's check
 * answered (one read each — the sheet itself builds only then). Callers pass today's sessions only; another day's copy
 * is the drain's or the sweep's. Never rejects: a refused or failed read or build is left to the session's next open.
 */
export async function watchFollows(todayIds: readonly string[]): Promise<{ ran: number; pending: number }> {
  for (const id of new Set(todayIds)) {
    const s = await api.getSession(id).catch(() => null);
    if (!s || s.contentState === "started" || s.contentState === "done" || s.lockedBy === "started") continue;
    if ((s.profiles ?? []).some((p) => !s.checks?.[p.profileId])) continue;
    await api.buildSession(id, {}).catch(() => undefined);
  }
  return api.drainWatchUntilIdle();
}

/**
 * After a change lands somewhere other than the session's sheet: today's app sessions among `ids` (by today's read,
 * fresh — a move onto today shows there only after it) follow as the day's build (`watchFollows`); any other change's
 * copy is made by the drain chain, which runs regardless. `ids` "all": every app session of today (a change that does
 * not say which sessions it touched — the thread coach's approve). Best effort; never rejects.
 */
export async function watchFollowsChange(
  ids: readonly string[] | "all",
  readToday: () => Promise<{ todaySessions: ReadonlyArray<{ workout: { id: string; origin?: string | null } }> } | null>,
): Promise<{ ran: number; pending: number }> {
  const today = await readToday().catch(() => null);
  const own = (today?.todaySessions ?? []).map((t) => t.workout).filter((wk) => !!wk && appAuthoredRow({ origin: wk.origin ?? null }));
  const touched = ids === "all" ? own.map((wk) => wk.id) : own.map((wk) => wk.id).filter((id) => ids.includes(id));
  return touched.length > 0 ? watchFollows(touched) : api.drainWatchUntilIdle();
}

/**
 * After a coach approve (the watch mirrors the plan §3.3; M1): the sessions it wrote or changed — `applied` workouts,
 * `changed` sessions — follow (`watchFollowsChange`: today's as the day's build; the drain chain for the rest). Nothing
 * when the approve wrote nothing. `readToday` is the screen's own fresh read of Today.
 */
export function followApproved(
  answers: ReadonlyArray<{ applied?: ReadonlyArray<{ workout?: { id: string } }>; changed?: ReadonlyArray<{ workoutId: string }> }>,
  readToday: Parameters<typeof watchFollowsChange>[1],
): void {
  // Never throws (it runs in an approve's onSuccess, where a throw would turn the approve into a failure): an answer
  // that leaves a list out (an older server's) gives none of it.
  const ids = answers.flatMap((a) => [...(a.applied ?? []).map((x) => x.workout?.id), ...(a.changed ?? []).map((x) => x.workoutId)]).filter(
    (id): id is string => typeof id === "string",
  );
  if (ids.length > 0) void watchFollowsChange(ids, readToday).catch(() => undefined);
}
