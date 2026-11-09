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

/**
 * The server refused it, so the session can't be changed this way now: a sheet stops offering the change. Not when the
 * session only changed under the request (`session_changed`: moved by another writer, neither done nor under way): the
 * session is read again, and the same change may be pressed again.
 */
export const refusedByServer = (e: unknown): boolean =>
  refusedWhy(e) !== null && ((e as ApiError).body as { error?: unknown } | null)?.error !== "session_changed";

/**
 * Of a sheet's changes, the error to say: the one pressed last (`last`, its name), so an older press's error never hides it;
 * with that one fine, none; with none pressed yet, the first that failed. Null when there is none.
 */
export function latestError<K extends string>(changes: Readonly<Record<K, { isError: boolean; error: unknown }>>, last: K | null): unknown {
  const key = latestFailed(changes, last);
  return key === null ? null : (changes[key].error ?? null);
}

/** The change whose error a sheet says (`latestError`): its name, or null. */
function latestFailed<K extends string>(changes: Readonly<Record<K, { isError: boolean; error: unknown }>>, last: K | null): K | null {
  if (last !== null) return changes[last].isError ? last : null;
  return (Object.keys(changes) as K[]).find((k) => changes[k].isError) ?? null;
}

/**
 * What a sheet says of its changes: the latest press's error in words (`latestError`, `planRefusal`; `otherwise`, one line
 * or each change's own) — and nothing while that press is on its way or went through, though an older one failed.
 */
export function changeErrorText<K extends string>(changes: Readonly<Record<K, { isError: boolean; error: unknown }>>, last: K | null, otherwise: string | Readonly<Record<K, string>>): string | null {
  const key = latestFailed(changes, last);
  if (key === null) return null;
  return planRefusal(changes[key].error, typeof otherwise === "string" ? otherwise : otherwise[key]);
}
