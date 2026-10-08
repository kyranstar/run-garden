/**
 * DISCARD'S UN-START (ruling 2b-R9). Discard on the player asks the server to return the slot to `built` and unlock its
 * build (`POST /api/sessions/:workoutId/unstart`), so Today offers Start again rather than a Continue that would
 * replay the discarded session. Offline — or with the server unreachable — the request waits here, in the offline
 * database's `meta` store (no new store: no upgrade), and goes on the outbox's own triggers (start, `online`, visible).
 *
 *  - Never while a save for the slot waits in the outbox (or was refused there): the save decides the slot — and the
 *    server would refuse anyway once it lands (409 `performed`). The waiting un-start is dropped.
 *  - Never once the slot is played again on this device (a session in progress for it): it was started anew.
 *  - 2xx, 409 and 404 are final; anything else (a dropped connection, 5xx, 401, 423) waits for the next trigger.
 *  - Each belongs to the account that discarded, and is sent only while that account is signed in (ruling 2b-R6).
 */
import { ApiError } from "@rg/api-client";
import type { OfflineDb } from "./idb.js";
import { liveSessions } from "./live.js";
import { outboxEntries } from "./outbox.js";

export interface QueuedUnstart {
  kind: "unstart";
  workoutId: string;
  /** The account that discarded. */
  userId: string;
  /** Epoch ms of Discard. */
  at: number;
}

/** What sending needs: the api client's `unstartSession`. */
export interface UnstartApi {
  unstartSession(workoutId: string): Promise<unknown>;
}

const key = (workoutId: string) => `unstart:${workoutId}`;
const isUnstart = (v: unknown): v is QueuedUnstart => (v as Partial<QueuedUnstart> | null)?.kind === "unstart";

export async function queueUnstart(db: OfflineDb, workoutId: string, userId: string, now: number = Date.now()): Promise<void> {
  await db.put<QueuedUnstart>("meta", key(workoutId), { kind: "unstart", workoutId, userId, at: now });
}

export function forgetUnstart(db: OfflineDb, workoutId: string): Promise<void> {
  return db.delete("meta", key(workoutId));
}

/** `userId`'s waiting un-starts, oldest first. */
export async function queuedUnstarts(db: OfflineDb, userId: string): Promise<QueuedUnstart[]> {
  return (await db.all<unknown>("meta")).filter(isUnstart).filter((u) => u.userId === userId).sort((a, b) => a.at - b.at);
}

/** A refusal the server will always give: the slot was saved (409 `performed`), or is not this account's (404). */
const final = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.status === 404);

/** Send `userId`'s waiting un-starts that may still go. Never throws for a send; `unstarted` counts the ones the server took. */
export async function drainUnstarts(db: OfflineDb, api: UnstartApi, opts: { userId: string }): Promise<{ unstarted: number }> {
  let unstarted = 0;
  const queued = await queuedUnstarts(db, opts.userId);
  if (queued.length === 0) return { unstarted };
  const saving = new Set((await outboxEntries(db)).map((e) => e.payload.workoutId));
  const playing = new Set((await liveSessions(db)).map((l) => l.workoutId));
  for (const u of queued) {
    if (saving.has(u.workoutId) || playing.has(u.workoutId)) {
      await forgetUnstart(db, u.workoutId);
      continue;
    }
    try {
      await api.unstartSession(u.workoutId);
      unstarted += 1;
    } catch (e) {
      if (!final(e)) continue;
    }
    await forgetUnstart(db, u.workoutId);
  }
  return { unstarted };
}
