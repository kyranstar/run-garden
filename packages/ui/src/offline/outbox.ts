/**
 * THE OUTBOX (Phase 2 spec §2b "Client storage"; plan Task 2): Save writes the session here and returns at once;
 * the outbox sends it with `PUT /api/sessions/performed/:id` when it can, and exactly once.
 *
 *  - An entry is keyed by the session's id AND its payload hash: the same save twice is one entry, and a second tab
 *    saving different edits of the same session is a second entry beside the first, never over it. The server
 *    arbitrates per session id: the first payload it takes wins, the other is refused `409 conflict`.
 *  - Sent in the order saved. 2xx (including `200 {status: "same_payload"}`) or `409 same_payload` removes the entry.
 *    `409 conflict` keeps it, flagged `conflict` (Settings → Data: "Couldn't sync one session", Discard); so does
 *    `409 slot_done` — another session of the slot was saved first, on another device (ruling 2b-R18; Settings → Data:
 *    "Saved on another device", Discard). A refusal retrying cannot fix (400, 403, 404, 413, 422, …) is flagged
 *    `failed` the same way (Retry / Discard).
 *  - A network error, a timeout, 401, 408, 423 (a restore running), 429 or 5xx backs off — 1 s, 5 s, 30 s, then only on
 *    the next trigger (app start, `online`, the page becoming visible, and every 5 minutes while the page is visible)
 *    — and stops the drain, so nothing saved later goes first. A trigger does not wait for the backoff.
 *  - The same 5xx `OUTBOX_MAX_SAME_5XX` times in a row (not the save's own `503 busy`) flags the entry `failed`: a
 *    save the server can never complete surfaces instead of being retried for ever (audit 2b-A M-4).
 *  - Every entry belongs to the account that saved it, and is sent only while that account is signed in (ruling 2b-R6):
 *    signing out keeps it, unsynced work, for that account's next sign-in.
 *  - Retry and Discard (Settings → Data) win over a drain sending that entry at the same moment: the drain writes its
 *    answer onto the entry as it is then, and never brings back one discarded meanwhile (audit 2b-A M-8).
 *  - Two drains at once (two tabs, or two triggers) never send one entry twice: a drain holds a lock in IndexedDB,
 *    renewed before each send, which a drain from a tab that died gives up after `lockMs`.
 *  - A session played under a provisional id (`local:…`, a quick start or template started offline — R11) is sent onto
 *    the workout recorded for it first (`local-starts.ts`: once, with the device's key). That create is retried as a
 *    save is (the network, a 5xx); refused, the entry is flagged `failed` (Retry / Discard) and the session stays here.
 */
import { ApiError, type CreateDocWorkoutRequest } from "@rg/api-client";
import { canonicalJson, performedSessionSaveSchema, type PerformedSessionWire, type PerformedSessionWireInput } from "@rg/domain";
import type { OfflineDb } from "./idb.js";
import { forgetLocalStart, isLocalId, loadLocalStart, localStarts, LocalStartMissingError, onTheServer, standAlone } from "./local-starts.js";
import { drainUnstarts } from "./unstarts.js";

export type OutboxState = "pending" | "conflict" | "failed";

export interface OutboxEntry {
  /** `${performedId}:${payloadHash}`. */
  key: string;
  /** The account that saved it: sent only while that account is signed in (ruling 2b-R6). */
  userId: string;
  performedId: string;
  payload: PerformedSessionWire;
  payloadHash: string;
  attempts: number;
  lastError: string | null;
  /** How many attempts in a row the server answered with `lastError`, a 5xx (not its own `busy`): see OUTBOX_MAX_SAME_5XX. */
  repeats?: number;
  state: OutboxState;
  /** Epoch ms of the next timed attempt; 0 = due; null = only on the next trigger. */
  nextAttemptAt: number | null;
  /** Epoch ms of Save. */
  createdAt: number;
}

/**
 * What sending needs: the api client's `savePerformed` — `createWorkout`, for a session played under a provisional id
 * (R11; without it such a session waits) — and `unstartSession`, for Discards that wait (ruling 2b-R9).
 */
export interface OutboxApi {
  savePerformed(performedId: string, payload: PerformedSessionWire): Promise<unknown>;
  createWorkout?(body: CreateDocWorkoutRequest): Promise<{ workout: { id: string } }>;
  unstartSession?(workoutId: string): Promise<unknown>;
}

export interface DrainResult {
  saved: number;
  conflicts: number;
  failed: number;
  /** Another drain holds the lock: this one sent nothing. */
  locked: boolean;
  /**
   * When to drain again (a timer should): the first entry still waiting is due, or — locked out — the other drain's
   * lock runs out (it may be a tab closed mid-send). Null when nothing is scheduled.
   */
  retryAt: number | null;
  /** An entry of this account still waits with its backoff spent: only a trigger sends it now. */
  stalled: boolean;
  /**
   * The server answered 401: this device's sign-in has expired. The entry waits (it drains after sign-in, under the
   * same account); the app should ask the athlete to sign in again (audit 2b-B M-3).
   */
  signedOut: boolean;
  /** Discards made offline that the server has now taken (`startOutboxSync` only; ruling 2b-R9). */
  unstarted?: number;
}

export const OUTBOX_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
/** After the backoff is spent, a visible page tries again this often (a desktop tab left open; audit 2b-A M-8). */
export const OUTBOX_SLOW_RETRY_MS = 5 * 60_000;
/** The same 5xx this many attempts in a row flags the entry `failed` (audit 2b-A M-4). */
export const OUTBOX_MAX_SAME_5XX = 5;
const LOCK_KEY = "outbox-drain";
const DEFAULT_LOCK_MS = 60_000;

/** sha256 (hex) of the payload's canonical JSON — the same hash the server stores as `payload_hash`. */
export async function payloadHash(payload: PerformedSessionWire): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byOrder = (a: OutboxEntry, b: OutboxEntry) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The outbox in the order saved — only `userId`'s entries when given (what Settings → Data lists). */
export async function outboxEntries(db: OfflineDb, userId?: string): Promise<OutboxEntry[]> {
  return (await db.all<OutboxEntry>("outbox")).filter((e) => userId === undefined || e.userId === userId).sort(byOrder);
}

/**
 * What Settings → Data may offer for an entry: a `conflict` can only be discarded — the server keeps the first version
 * of the session it took and refuses any other, every time (audit 2b-A M-8) — and a `failed` one can be retried or
 * discarded. A pending entry is the outbox's own business.
 */
export function entryActions(entry: Pick<OutboxEntry, "state">): Array<"retry" | "discard"> {
  if (entry.state === "conflict") return ["discard"];
  if (entry.state === "failed") return ["retry", "discard"];
  return [];
}

/**
 * Put a saved session in the outbox for the signed-in account `userId` (validated as the server will read it — a
 * payload it would refuse throws here, at Save, rather than sitting in the outbox for ever). The same save again
 * changes nothing.
 */
export async function enqueue(db: OfflineDb, input: PerformedSessionWireInput, userId: string, now: number = Date.now()): Promise<OutboxEntry> {
  const payload = performedSessionSaveSchema.parse(input);
  const hash = await payloadHash(payload);
  const key = `${payload.id}:${hash}`;
  const stored = await db.update<OutboxEntry>("outbox", key, (current) =>
    current ?? {
      key,
      userId,
      performedId: payload.id,
      payload,
      payloadHash: hash,
      attempts: 0,
      lastError: null,
      state: "pending",
      nextAttemptAt: 0,
      createdAt: now,
    },
  );
  return stored!;
}

/** Settings → Data "Retry": the entry is sent again on the next drain. */
export async function retryEntry(db: OfflineDb, key: string): Promise<void> {
  await db.update<OutboxEntry>("outbox", key, (e) => (e ? { ...e, state: "pending", attempts: 0, repeats: 0, nextAttemptAt: 0 } : undefined));
}

/** Settings → Data "Discard": the entry is dropped — and a start made offline that only it was waiting to record. */
export async function discardEntry(db: OfflineDb, key: string): Promise<void> {
  const entry = await db.get<OutboxEntry>("outbox", key);
  await db.delete("outbox", key);
  if (entry) await forgetUnneededStart(db, entry.payload.workoutId);
}

/**
 * Delete everything: the deleted account's unsynced saves go with it (ruling 2b-R6 as amended), and its starts made
 * offline. Another account's stay. Each through `update`, so an entry a drain is answering at that moment is not
 * brought back.
 */
export async function discardAccountEntries(db: OfflineDb, userId: string): Promise<void> {
  for (const entry of await outboxEntries(db, userId)) {
    await db.update<OutboxEntry>("outbox", entry.key, (current) => (current?.userId === userId ? undefined : current));
  }
  for (const start of await localStarts(db, userId)) await forgetLocalStart(db, start.localId);
}

/** A start made offline is kept while a session of it waits here (two tabs' edits of one session are two entries). */
async function forgetUnneededStart(db: OfflineDb, workoutId: string | null): Promise<void> {
  if (!isLocalId(workoutId)) return;
  if ((await outboxEntries(db)).some((e) => e.payload.workoutId === workoutId)) return;
  await forgetLocalStart(db, workoutId);
}

/**
 * Why an entry is a `conflict`: the same session saved with other edits (`conflict`), or another session of its slot
 * saved first — on another device (`slot_done`, ruling 2b-R18). Either way the server refuses it every time.
 */
export const SLOT_DONE = "slot_done";

type Outcome =
  | { kind: "saved" }
  | { kind: "conflict"; why: "conflict" | typeof SLOT_DONE }
  | { kind: "failed"; error: string }
  | { kind: "transient"; error: string };

const TRANSIENT_STATUSES = new Set([401, 408, 423, 425, 429]);

function classify(error: unknown): Outcome {
  if (!(error instanceof ApiError)) return { kind: "transient", error: "network" };
  const code = (error.body as { error?: unknown } | null)?.error;
  if (error.status === 409 && code === "same_payload") return { kind: "saved" };
  if (error.status === 409 && code === "conflict") return { kind: "conflict", why: "conflict" };
  if (error.status === 409 && code === SLOT_DONE) return { kind: "conflict", why: SLOT_DONE };
  // The save's own 503 says another delivery of it holds its lock (or the COROS read does): plainly transient.
  if (error.status === 503 && code === "busy") return { kind: "transient", error: "http_503 busy" };
  if (error.status >= 500 || TRANSIENT_STATUSES.has(error.status)) return { kind: "transient", error: `http_${error.status}` };
  return { kind: "failed", error: typeof code === "string" ? `http_${error.status} ${code}` : `http_${error.status}` };
}

/** A server failure that counts towards OUTBOX_MAX_SAME_5XX: a 5xx, but not the save's own `busy`. */
const countsAsRepeat = (error: string) => /^http_5\d\d$/.test(error);

/** A sender that cannot record a start made offline (no `createWorkout`): its session waits for one that can. */
class CannotCreateError extends Error {}

/**
 * Why recording a start made offline did not happen (R11): the network or a server failing backs off as a save does; a
 * refusal (422 `played_offline_refused`, a document that does not read, …) is `failed`, and so is a start gone from
 * the device. A create's 409 is never a save's `same_payload` or `conflict`.
 */
function classifyCreate(error: unknown): Outcome {
  if (error instanceof LocalStartMissingError) return { kind: "failed", error: "local_start_missing" };
  if (error instanceof CannotCreateError) return { kind: "transient", error: "network" };
  if (!(error instanceof ApiError)) return { kind: "transient", error: "network" };
  if (error.status >= 500 || TRANSIENT_STATUSES.has(error.status)) return { kind: "transient", error: `http_${error.status}` };
  const code = (error.body as { error?: unknown } | null)?.error;
  return { kind: "failed", error: typeof code === "string" ? `http_${error.status} ${code}` : `http_${error.status}` };
}

/**
 * Send one entry: onto the workout recorded for it first, when it was played under a provisional id. One that joined
 * today's same start on another device, which saved first (409 `slot_done`), is kept by a workout of its own, made and
 * sent onto at once (`standAlone`; R11 fix round 2): no conflict is left, and nothing done is lost.
 */
async function send(db: OfflineDb, api: OutboxApi, entry: OutboxEntry, alone = false): Promise<Outcome> {
  let payload = entry.payload;
  if (isLocalId(payload.workoutId)) {
    const createWorkout = api.createWorkout?.bind(api);
    try {
      if (!createWorkout) throw new CannotCreateError();
      payload = await onTheServer(db, { createWorkout }, payload);
    } catch (e) {
      return classifyCreate(e);
    }
  }
  try {
    await api.savePerformed(entry.performedId, payload);
    return { kind: "saved" };
  } catch (e) {
    const outcome = classify(e);
    const localId = entry.payload.workoutId;
    if (!alone && outcome.kind === "conflict" && outcome.why === SLOT_DONE && isLocalId(localId)) {
      if ((await loadLocalStart(db, localId).catch(() => undefined))?.joined) {
        await standAlone(db, localId);
        return send(db, api, entry, true);
      }
    }
    return outcome;
  }
}

/** The lock for `owner`, or — held by another drain — when that one's lock runs out. */
async function claimLock(db: OfflineDb, owner: string, now: number, lockMs: number): Promise<{ ok: boolean; until: number }> {
  const held = await db.update<{ owner: string; until: number }>("meta", LOCK_KEY, (lock) =>
    !lock || lock.owner === owner || lock.until <= now ? { owner, until: now + lockMs } : lock,
  );
  return { ok: held?.owner === owner, until: held?.until ?? now };
}

async function releaseLock(db: OfflineDb, owner: string): Promise<void> {
  await db.update<{ owner: string; until: number }>("meta", LOCK_KEY, (lock) => (lock?.owner === owner ? undefined : lock));
}

/**
 * Send what is due, in order. `mode: "event"` (start, online, visible — the default) sends every pending entry;
 * `mode: "timer"` only those whose backoff is up.
 */
export async function drain(
  db: OfflineDb,
  api: OutboxApi,
  opts: { userId: string; now?: () => number; mode?: "event" | "timer"; lockMs?: number },
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
  const owner = crypto.randomUUID();
  const result: DrainResult = { saved: 0, conflicts: 0, failed: 0, locked: false, retryAt: null, stalled: false, signedOut: false };
  // Locked out: come back when that lock runs out — it may be a tab closed mid-send (Phase 2b Task 8, journey e).
  const first = await claimLock(db, owner, now(), lockMs);
  if (!first.ok) return { ...result, locked: true, retryAt: first.until };
  // The drain's answer lands on the entry as it is NOW: Retry's reset stands, and a Discard is never undone.
  const settle = (key: string, change: (current: OutboxEntry) => OutboxEntry) =>
    db.update<OutboxEntry>("outbox", key, (current) => (current ? change(current) : undefined));
  try {
    for (const entry of await outboxEntries(db, opts.userId)) {
      if (entry.state !== "pending") continue;
      const t = now();
      if (opts.mode === "timer" && (entry.nextAttemptAt === null || entry.nextAttemptAt > t)) break;
      // Still ours? (A drain that outlived its lock must not race the one that took it over.)
      const still = await claimLock(db, owner, t, lockMs);
      if (!still.ok) return { ...result, locked: true, retryAt: still.until };
      const outcome = await send(db, api, entry);
      if (outcome.kind === "saved") {
        await db.delete("outbox", entry.key);
        await forgetUnneededStart(db, entry.payload.workoutId);
        result.saved += 1;
      } else if (outcome.kind === "conflict") {
        const why = outcome.why;
        await settle(entry.key, (e) => ({ ...e, state: "conflict", lastError: why, attempts: e.attempts + 1 }));
        result.conflicts += 1;
      } else if (outcome.kind === "failed") {
        await settle(entry.key, (e) => ({ ...e, state: "failed", lastError: outcome.error, attempts: e.attempts + 1 }));
        result.failed += 1;
      } else {
        if (outcome.error === "http_401") result.signedOut = true;
        const t = now();
        const after = await settle(entry.key, (e) => {
          const attempts = e.attempts + 1;
          const repeats = countsAsRepeat(outcome.error) ? (e.lastError === outcome.error ? (e.repeats ?? 1) : 0) + 1 : 0;
          if (repeats >= OUTBOX_MAX_SAME_5XX) return { ...e, state: "failed", attempts, lastError: outcome.error, repeats };
          const wait = OUTBOX_BACKOFF_MS[attempts - 1];
          return { ...e, attempts, lastError: outcome.error, repeats, nextAttemptAt: wait === undefined ? null : t + wait };
        });
        if (after?.state === "failed") {
          // Surfaced (Settings → Data): what was saved after it goes on.
          result.failed += 1;
          continue;
        }
        break;
      }
    }
    const waiting = (await outboxEntries(db, opts.userId)).find((e) => e.state === "pending");
    result.retryAt = waiting && waiting.nextAttemptAt !== null && waiting.nextAttemptAt > now() ? waiting.nextAttemptAt : null;
    result.stalled = waiting !== undefined && waiting.nextAttemptAt === null;
    return result;
  } finally {
    await releaseLock(db, owner);
  }
}

type Listens = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Keep the outbox draining for the signed-in account `userId` for the life of the app: once now, on `online`, whenever
 * the page becomes visible, when a backoff is up, and — once the backoff is spent — every OUTBOX_SLOW_RETRY_MS while
 * the page is visible. Returns `stop`.
 */
export function startOutboxSync(opts: {
  db: () => Promise<OfflineDb>;
  api: OutboxApi;
  /** The signed-in account: only its entries are sent (ruling 2b-R6). */
  userId: string;
  win?: Listens;
  doc?: Listens & { visibilityState: DocumentVisibilityState };
  onDrained?: (result: DrainResult) => void;
}): () => void {
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again: "event" | "timer" | null = null;

  const run = (mode: "event" | "timer"): void => {
    if (stopped) return;
    if (running) {
      // One drain at a time per tab; a trigger meanwhile runs once more after it.
      if (again !== "event") again = mode;
      return;
    }
    running = (async () => {
      try {
        const db = await opts.db();
        const result = await drain(db, opts.api, { userId: opts.userId, mode });
        // Discards made offline go on the same triggers, after the saves (one waiting for the slot drops them).
        const unstart = opts.api.unstartSession?.bind(opts.api);
        if (unstart) result.unstarted = (await drainUnstarts(db, { unstartSession: unstart }, { userId: opts.userId }).catch(() => null))?.unstarted ?? 0;
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer =
          result.retryAt !== null
            ? setTimeout(() => run("timer"), Math.max(0, result.retryAt - Date.now()))
            : result.stalled && doc.visibilityState === "visible"
              ? setTimeout(() => run("event"), OUTBOX_SLOW_RETRY_MS)
              : null;
        opts.onDrained?.(result);
      } catch {
        // IndexedDB unavailable (a private window, say): nothing can be queued either.
      }
    })().finally(() => {
      running = null;
      const next = again;
      again = null;
      if (next) run(next);
    });
  };
  const onOnline = () => run("event");
  const onVisible = () => {
    if (doc.visibilityState === "visible") run("event");
  };
  win.addEventListener("online", onOnline);
  doc.addEventListener("visibilitychange", onVisible);
  run("event");

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    win.removeEventListener("online", onOnline);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}
