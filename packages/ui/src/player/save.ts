/**
 * SAVE AND DISCARD (Phase 2 spec §2b "Review and save"). Save puts the session in the outbox, clears the session in
 * progress and what Start left for it, and tries to send it at once (for a few seconds): "saved" when it reached the
 * server, "pending" when it waits in the outbox ("Saved · will sync") — the outbox sends it later, exactly once.
 * Discard keeps nothing of the session; the slot keeps its locked build on the device (it is still started, and can
 * be played again from it, offline).
 */
import type { PerformedSessionWire } from "@rg/domain";
import type { OfflineDb } from "../offline/idb.js";
import { clearLive } from "../offline/live.js";
import { drain, enqueue, outboxEntries, type OutboxApi } from "../offline/outbox.js";
import { forgetStart } from "./stored.js";

export type SaveResult = "saved" | "pending";

const SEND_WAIT_MS = 4_000;

export async function saveSession(
  db: OfflineDb,
  wire: PerformedSessionWire,
  api: OutboxApi,
  /** The signed-in account the save belongs to (ruling 2b-R6: the outbox sends only its own). */
  userId: string,
  waitMs: number = SEND_WAIT_MS,
): Promise<SaveResult> {
  await enqueue(db, wire, userId);
  if (wire.workoutId) {
    await clearLive(db, wire.workoutId);
    await forgetStart(db, wire.workoutId);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    drain(db, api, { userId }).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return (await outboxEntries(db)).some((e) => e.performedId === wire.id) ? "pending" : "saved";
}

export async function discardSession(db: OfflineDb, workoutId: string): Promise<void> {
  await clearLive(db, workoutId);
}

/** A session of this slot saved on this device and still waiting for the server (or refused by it). */
export async function savedHere(db: OfflineDb, workoutId: string): Promise<boolean> {
  return (await outboxEntries(db)).some((e) => e.payload.workoutId === workoutId);
}
