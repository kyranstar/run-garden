/**
 * THE OUTBOX (Phase 2 spec §2b "Client storage"; plan Task 2): Save writes the session here and returns at once;
 * the outbox sends it with `PUT /api/sessions/performed/:id` when it can, and exactly once.
 *
 *  - An entry is keyed by the session's id AND its payload hash: the same save twice is one entry, and a second tab
 *    saving different edits of the same session is a second entry beside the first, never over it. The server
 *    arbitrates per session id: the first payload it takes wins, the other is refused `409 conflict`.
 *  - Sent in the order saved. 2xx (including `200 {status: "same_payload"}`) or `409 same_payload` removes the entry.
 *    `409 conflict` keeps it, flagged `conflict` (Settings → Data: "Couldn't sync one session", Retry / Discard). A
 *    refusal retrying cannot fix (400, 403, 404, 413, 422, …) is flagged `failed` the same way.
 *  - A network error, a timeout, 401, 408, 423 (a restore running), 429 or 5xx backs off — 1 s, 5 s, 30 s, then only on
 *    the next trigger (app start, `online`, the page becoming visible) — and stops the drain, so nothing saved later
 *    goes first. A trigger does not wait for the backoff.
 *  - Two drains at once (two tabs, or two triggers) never send one entry twice: a drain holds a lock in IndexedDB,
 *    renewed before each send, which a drain from a tab that died gives up after `lockMs`.
 */
import { ApiError } from "@rg/api-client";
import { canonicalJson, performedSessionSaveSchema, type PerformedSessionWire, type PerformedSessionWireInput } from "@rg/domain";
import type { OfflineDb } from "./idb.js";

export type OutboxState = "pending" | "conflict" | "failed";

export interface OutboxEntry {
  /** `${performedId}:${payloadHash}`. */
  key: string;
  performedId: string;
  payload: PerformedSessionWire;
  payloadHash: string;
  attempts: number;
  lastError: string | null;
  state: OutboxState;
  /** Epoch ms of the next timed attempt; 0 = due; null = only on the next trigger. */
  nextAttemptAt: number | null;
  /** Epoch ms of Save. */
  createdAt: number;
}

/** What sending needs: the api client's `savePerformed`. */
export interface OutboxApi {
  savePerformed(performedId: string, payload: PerformedSessionWire): Promise<unknown>;
}

export interface DrainResult {
  saved: number;
  conflicts: number;
  failed: number;
  /** Another drain holds the lock: this one sent nothing. */
  locked: boolean;
  /** When the first entry still waiting is due again (a timer should drain then); null when nothing is scheduled. */
  retryAt: number | null;
}

export const OUTBOX_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
const LOCK_KEY = "outbox-drain";
const DEFAULT_LOCK_MS = 60_000;

/** sha256 (hex) of the payload's canonical JSON — the same hash the server stores as `payload_hash`. */
export async function payloadHash(payload: PerformedSessionWire): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byOrder = (a: OutboxEntry, b: OutboxEntry) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export async function outboxEntries(db: OfflineDb): Promise<OutboxEntry[]> {
  return (await db.all<OutboxEntry>("outbox")).sort(byOrder);
}

/**
 * Put a saved session in the outbox (validated as the server will read it — a payload it would refuse throws here,
 * at Save, rather than sitting in the outbox for ever). The same save again changes nothing.
 */
export async function enqueue(db: OfflineDb, input: PerformedSessionWireInput, now: number = Date.now()): Promise<OutboxEntry> {
  const payload = performedSessionSaveSchema.parse(input);
  const hash = await payloadHash(payload);
  const key = `${payload.id}:${hash}`;
  const stored = await db.update<OutboxEntry>("outbox", key, (current) =>
    current ?? {
      key,
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
  await db.update<OutboxEntry>("outbox", key, (e) => (e ? { ...e, state: "pending", attempts: 0, nextAttemptAt: 0 } : undefined));
}

/** Settings → Data "Discard": the entry is dropped. */
export function discardEntry(db: OfflineDb, key: string): Promise<void> {
  return db.delete("outbox", key);
}

type Outcome = { kind: "saved" } | { kind: "conflict" } | { kind: "failed"; error: string } | { kind: "transient"; error: string };

const TRANSIENT_STATUSES = new Set([401, 408, 423, 425, 429]);

function classify(error: unknown): Outcome {
  if (!(error instanceof ApiError)) return { kind: "transient", error: "network" };
  const code = (error.body as { error?: unknown } | null)?.error;
  if (error.status === 409 && code === "same_payload") return { kind: "saved" };
  if (error.status === 409 && code === "conflict") return { kind: "conflict" };
  if (error.status >= 500 || TRANSIENT_STATUSES.has(error.status)) return { kind: "transient", error: `http_${error.status}` };
  return { kind: "failed", error: typeof code === "string" ? `http_${error.status} ${code}` : `http_${error.status}` };
}

async function claimLock(db: OfflineDb, owner: string, now: number, lockMs: number): Promise<boolean> {
  const held = await db.update<{ owner: string; until: number }>("meta", LOCK_KEY, (lock) =>
    !lock || lock.owner === owner || lock.until <= now ? { owner, until: now + lockMs } : lock,
  );
  return held?.owner === owner;
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
  opts: { now?: () => number; mode?: "event" | "timer"; lockMs?: number } = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
  const owner = crypto.randomUUID();
  const result: DrainResult = { saved: 0, conflicts: 0, failed: 0, locked: false, retryAt: null };
  if (!(await claimLock(db, owner, now(), lockMs))) return { ...result, locked: true };
  try {
    for (const entry of await outboxEntries(db)) {
      if (entry.state !== "pending") continue;
      const t = now();
      if (opts.mode === "timer" && (entry.nextAttemptAt === null || entry.nextAttemptAt > t)) break;
      // Still ours? (A drain that outlived its lock must not race the one that took it over.)
      if (!(await claimLock(db, owner, t, lockMs))) return { ...result, locked: true };
      let outcome: Outcome;
      try {
        await api.savePerformed(entry.performedId, entry.payload);
        outcome = { kind: "saved" };
      } catch (e) {
        outcome = classify(e);
      }
      if (outcome.kind === "saved") {
        await db.delete("outbox", entry.key);
        result.saved += 1;
      } else if (outcome.kind === "conflict") {
        await db.put<OutboxEntry>("outbox", entry.key, { ...entry, state: "conflict", lastError: "conflict", attempts: entry.attempts + 1 });
        result.conflicts += 1;
      } else if (outcome.kind === "failed") {
        await db.put<OutboxEntry>("outbox", entry.key, { ...entry, state: "failed", lastError: outcome.error, attempts: entry.attempts + 1 });
        result.failed += 1;
      } else {
        const attempts = entry.attempts + 1;
        const wait = OUTBOX_BACKOFF_MS[attempts - 1];
        await db.put<OutboxEntry>("outbox", entry.key, {
          ...entry,
          attempts,
          lastError: outcome.error,
          nextAttemptAt: wait === undefined ? null : now() + wait,
        });
        break;
      }
    }
    const waiting = (await outboxEntries(db)).find((e) => e.state === "pending");
    result.retryAt = waiting && waiting.nextAttemptAt !== null && waiting.nextAttemptAt > now() ? waiting.nextAttemptAt : null;
    return result;
  } finally {
    await releaseLock(db, owner);
  }
}

type Listens = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Keep the outbox draining for the life of the app: once now, on `online`, whenever the page becomes visible, and
 * when a backoff is up. Returns `stop`.
 */
export function startOutboxSync(opts: {
  db: () => Promise<OfflineDb>;
  api: OutboxApi;
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
        const result = await drain(await opts.db(), opts.api, { mode });
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer = result.retryAt === null ? null : setTimeout(() => run("timer"), Math.max(0, result.retryAt - Date.now()));
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
