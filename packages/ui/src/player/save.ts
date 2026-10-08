/**
 * SAVE AND DISCARD (Phase 2 spec §2b "Review and save"). Save puts the session in the outbox, clears the session in
 * progress and what Start left for it, and tries to send it at once (for a few seconds): "saved" when it reached the
 * server, "pending" when it waits in the outbox ("Saved · will sync") — the outbox sends it later, exactly once.
 * Discard keeps nothing of the session and un-starts the slot (ruling 2b-R9: Today offers Start again).
 */
import type { PerformedSessionWire } from "@rg/domain";
import type { OfflineDb } from "../offline/idb.js";
import { clearLive } from "../offline/live.js";
import { drain, enqueue, outboxEntries, type DrainResult, type OutboxApi } from "../offline/outbox.js";
import { drainUnstarts, queueUnstart, type UnstartApi } from "../offline/unstarts.js";
import { forgetStart } from "./stored.js";

export type SaveResult = "saved" | "pending";

export const SEND_WAIT_MS = 4_000;

export async function saveSession(
  db: OfflineDb,
  wire: PerformedSessionWire,
  api: OutboxApi,
  /** The signed-in account the save belongs to (ruling 2b-R6: the outbox sends only its own). */
  userId: string,
  opts: {
    /** How long Save waits for the first send before it answers "pending". */
    waitMs?: number;
    /**
     * The first send's answer, whenever it comes — within the wait or after it (audit 2b-B M-2: a send that outlasts
     * the wait still lands, and what shows "will sync" must hear it). Null when the drain itself failed.
     */
    onDrained?: (result: DrainResult | null) => void;
  } = {},
): Promise<SaveResult> {
  await enqueue(db, wire, userId);
  if (wire.workoutId) {
    await clearLive(db, wire.workoutId);
    await forgetStart(db, wire.workoutId);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sent = drain(db, api, { userId })
    .catch(() => null)
    .then((result) => {
      opts.onDrained?.(result);
      return result;
    });
  await Promise.race([
    sent,
    new Promise((resolve) => {
      timer = setTimeout(resolve, opts.waitMs ?? SEND_WAIT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return (await outboxEntries(db)).some((e) => e.performedId === wire.id) ? "pending" : "saved";
}

/**
 * Discard (ruling 2b-R9): nothing of the session is kept, and the slot is un-started — on the server, back to `built`
 * with its build unlocked, so Today offers Start, not a Continue that would replay the discarded session; on the
 * device, the start is forgotten (the build, the player's extras, the review's basis). The un-start waits on the
 * device when the network is out (`offline/unstarts.ts`) — never while a save for the slot waits in the outbox, which
 * decides the slot itself. `onDrained` hears whether the server took it, whenever it does.
 */
export async function discardSession(
  db: OfflineDb,
  workoutId: string,
  opts: {
    /** The account Discard belongs to: the un-start waits for it alone (ruling 2b-R6). Null: tried once, not kept. */
    userId?: string | null;
    api?: UnstartApi;
    waitMs?: number;
    onDrained?: (result: { unstarted: number } | null) => void;
  } = {},
): Promise<void> {
  await clearLive(db, workoutId);
  const saving = await savedHere(db, workoutId);
  if (!saving && opts.userId) await queueUnstart(db, workoutId, opts.userId);
  await forgetStart(db, workoutId);
  if (saving || !opts.api) return;
  const api = opts.api;
  const sent: Promise<{ unstarted: number } | null> = opts.userId
    ? drainUnstarts(db, api, { userId: opts.userId }).catch(() => null)
    : api.unstartSession(workoutId).then(
        () => ({ unstarted: 1 }),
        () => null,
      );
  const heard = sent.then((r) => {
    opts.onDrained?.(r);
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([heard, new Promise((resolve) => (timer = setTimeout(resolve, opts.waitMs ?? SEND_WAIT_MS)))]);
  if (timer) clearTimeout(timer);
}

/**
 * The device's copy of a session the server already has as done — saved on another device (ruling 2b-R18): it is
 * forgotten here (the session in progress and what Start left), and the server's slot is left alone (no un-start: it
 * would be refused, and the slot is not this copy's to change).
 */
export async function discardHere(db: OfflineDb, workoutId: string): Promise<void> {
  await clearLive(db, workoutId);
  await forgetStart(db, workoutId);
}

/** A session of this slot saved on this device and still waiting for the server (or refused by it). */
export async function savedHere(db: OfflineDb, workoutId: string): Promise<boolean> {
  return (await outboxEntries(db)).some((e) => e.payload.workoutId === workoutId);
}
