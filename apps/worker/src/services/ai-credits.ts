/**
 * THE AI ACCOUNT IS OUT OF CREDITS — a gateway 402 (owner report, 2026-10-09).
 *
 * Live: from 2026-10-08 the Vercel AI Gateway answered every call with
 * `402 {"error":{"message":"A positive credit balance is required…`. The app
 * treated that like a blip: each coach read was queued again with backoff until
 * five attempts burned it to `failed` (recording no reason), and a message to
 * the coach left the screen saying "thinking" while nothing was. A 402 is not a
 * blip. It says the same thing on every call until someone adds credits, so:
 *
 *  · it is never retried — not in place, not by the wake, not by the read queue;
 *  · it is recorded here, with when it was first and last seen, so the coach
 *    screen and Settings → AI can say it in words;
 *  · the first call that works again clears it.
 *
 * WHERE IT LIVES. `provider_cursor_state` — the existing per-account key/value
 * row (Google Calendar keeps its "ops that failed last run" there), one row,
 * `${userId}:ai_gateway:out_of_credits`: `value` is the first sighting and
 * `updated_at` the latest. No new table and no migration. The gateway key is the
 * server's, not the athlete's, but the athlete is who is waiting, so the record
 * is per account and each account clears its own on its next working call.
 */
import { eq } from "drizzle-orm";
import { providerCursorState } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "./db.js";
import { restoreInProgress } from "./account-state.js";

const PROVIDER = "ai_gateway";
const KEY = "out_of_credits";
const rowId = (userId: string) => `${userId}:${PROVIDER}:${KEY}`;

/** The gateway's "payment required": the account has no credit left. */
export const OUT_OF_CREDITS_REASON = "gateway_402";

/** Is this `chatCompletion` failure reason the account being out of credits? */
export function isOutOfCredits(reason: string | null | undefined): boolean {
  return reason === OUT_OF_CREDITS_REASON;
}

export interface OutOfCredits {
  /** The first 402 of this stretch. */
  since: string;
  /** The latest one — what a backoff measures from. */
  lastSeenAt: string;
}

export async function loadOutOfCredits(db: Db, userId: string): Promise<OutOfCredits | null> {
  const [row] = await db
    .select({ value: providerCursorState.value, updatedAt: providerCursorState.updatedAt })
    .from(providerCursorState)
    .where(eq(providerCursorState.id, rowId(userId)))
    .limit(1);
  return row ? { since: row.value, lastSeenAt: row.updatedAt } : null;
}

/** A 402 was seen at `at`. Keeps the first sighting; moves the latest. */
export async function recordOutOfCredits(db: Db, userId: string, at: string = nowInstant()): Promise<void> {
  await db
    .insert(providerCursorState)
    .values({ id: rowId(userId), userId, provider: PROVIDER, cursorKey: KEY, value: at, updatedAt: at })
    .onConflictDoUpdate({ target: providerCursorState.id, set: { updatedAt: at } });
}

export async function clearOutOfCredits(db: Db, userId: string): Promise<void> {
  await db.delete(providerCursorState).where(eq(providerCursorState.id, rowId(userId)));
}

/**
 * What one gateway call says about the account: a 402 records, a call that
 * worked clears, any other failure says nothing about credits. Skipped while a
 * restore is replacing the account — every writer stands down for it (B2), and
 * this row is one the restore itself may be writing.
 */
export async function noteGatewayOutcome(
  db: Db,
  userId: string,
  chat: { ok: boolean; reason?: string },
): Promise<void> {
  if (!chat.ok && !isOutOfCredits(chat.reason)) return;
  if (await restoreInProgress(db, userId)) return;
  if (chat.ok) await clearOutOfCredits(db, userId);
  else await recordOutOfCredits(db, userId);
}

/** Was a 402 seen within the last `minutes`? */
export function outOfCreditsWithin(state: OutOfCredits | null, minutes: number, now: number = Date.now()): boolean {
  return !!state && now - Date.parse(state.lastSeenAt) < minutes * 60_000;
}
