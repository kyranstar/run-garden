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

/** A refused change's words: the server's own (409 `{ error, why }`), else what it always said. */
export function planRefusal(e: unknown, otherwise: string): string {
  if (e instanceof ApiError && e.status === 409) {
    const why = (e.body as { why?: unknown } | null)?.why;
    if (typeof why === "string" && why) return why;
  }
  return otherwise;
}
