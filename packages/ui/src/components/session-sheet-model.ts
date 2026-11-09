import { ApiError } from "@rg/api-client";

/**
 * What a session's sheet offers on the plan, and what it says when the server refuses. A session the watch completed keeps its
 * content `outline` or `built`, so nothing else says it is over: moving it would re-date a credit the garden already walked, and
 * the server refuses that (`session-guard.ts`), so the sheet doesn't offer it.
 */
export interface SheetPlanState {
  completed: boolean;
  /** Started or done, or locked other than for the watch. */
  locked: boolean;
  /** Sent to the watch from an older server: Move and Skip stay (the sheet's own `sentHere`). */
  sentHere: boolean;
  past: boolean;
}

export const offersMoveAndSkip = (s: SheetPlanState): boolean => !s.completed && (!s.locked || s.sentHere);

export const offersMoveToToday = (s: SheetPlanState): boolean => !s.completed && s.past && !s.locked;

/** The server's words when it refused the change (409 `{ error, why }`: the session done, or under way); else null. */
function refusedWhy(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const why = (e.body as { why?: unknown } | null)?.why;
  return typeof why === "string" && why ? why : null;
}

/** A refused change's words: the server's own (409 `{ error, why }`), else what it always said. */
export function planRefusal(e: unknown, otherwise: string): string {
  return refusedWhy(e) ?? otherwise;
}

/** The server refused it, so the session can't be changed this way now: a sheet stops offering the change. */
export const refusedByServer = (e: unknown): boolean => refusedWhy(e) !== null;

/**
 * Of a sheet's changes, the error to say: the one pressed last (`last`, its name), so an older press's error never hides it;
 * with that one fine, none; with none pressed yet, the first that failed. Null when there is none.
 */
export function latestError<K extends string>(changes: Readonly<Record<K, { isError: boolean; error: unknown }>>, last: K | null): unknown {
  if (last !== null) return changes[last].isError ? changes[last].error : null;
  return Object.values<{ isError: boolean; error: unknown }>(changes).find((m) => m.isError)?.error ?? null;
}
