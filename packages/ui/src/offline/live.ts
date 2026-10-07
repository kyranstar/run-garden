/**
 * THE SESSION IN PROGRESS (Phase 2 spec §2b "Client storage"): `live` holds, per slot, everything the player needs to
 * resume after a reload, a relaunch or a killed tab — the recorder's state, the step, the timer's wall-clock anchor
 * and whether it is paused. It is written on every change, debounced 250 ms, and flushed at once when the page is
 * hidden or left (`visibilitychange` → hidden, `pagehide`), so the last change survives the tab being killed.
 *
 * `performedId` is made here, at Start, by the client (`crypto.randomUUID()`): it is the saved session's id and the
 * server's idempotency key.
 */
import type { OfflineDb } from "./idb.js";

export interface LiveSession<R = unknown> {
  workoutId: string;
  /** The saved session's id, made at Start. */
  performedId: string;
  /** The locked build being played. */
  buildId: string;
  /** The recorder's state (`@rg/session-engine` recorder). */
  recorder: R;
  stepIndex: number;
  /** Epoch ms the running timer was last started from; null when no timer runs. Timers are wall-clock anchored. */
  timerAnchor: number | null;
  /** Milliseconds the current step's timer had already run before `timerAnchor` (time kept across pauses). */
  timerBankedMs: number;
  paused: boolean;
  /** Epoch ms of Start. */
  startedAt: number;
  /** Epoch ms of the last change. */
  updatedAt: number;
}

export function newLiveSession<R>(input: { workoutId: string; buildId: string; recorder: R; now?: number }): LiveSession<R> {
  const now = input.now ?? Date.now();
  return {
    workoutId: input.workoutId,
    performedId: crypto.randomUUID(),
    buildId: input.buildId,
    recorder: input.recorder,
    stepIndex: 0,
    timerAnchor: null,
    timerBankedMs: 0,
    paused: false,
    startedAt: now,
    updatedAt: now,
  };
}

export function readLive<R = unknown>(db: OfflineDb, workoutId: string): Promise<LiveSession<R> | undefined> {
  return db.get<LiveSession<R>>("live", workoutId);
}

export function writeLive(db: OfflineDb, session: LiveSession): Promise<void> {
  return db.put("live", session.workoutId, session);
}

/** Save, Discard and Leave-for-good end a live session. */
export function clearLive(db: OfflineDb, workoutId: string): Promise<void> {
  return db.delete("live", workoutId);
}

export async function liveSessions(db: OfflineDb): Promise<LiveSession[]> {
  return db.all<LiveSession>("live");
}

/** Is a session in progress on this device? (The offline launch lets the app in on it.) */
export async function hasLiveSession(db: OfflineDb): Promise<boolean> {
  return (await liveSessions(db)).length > 0;
}

export interface LiveWriter {
  /** Record the latest state; written 250 ms after the last call, or at once on hide / leave / flush. */
  write(session: LiveSession): void;
  /** Write the pending state now (no-op when none). Rejects when the write fails; the state then stays pending. */
  flush(): Promise<void>;
  /** Flush, then stop listening to the page. */
  dispose(): void;
  /**
   * Why the last write failed — the storage full (`QuotaExceededError`), the database closed or gone — until a write
   * lands; null while writes land. The session is NOT being kept while this is set: the player must say so (Task 4).
   */
  readonly error: unknown;
}

type Listens = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * A debounced writer for one player. `target` is the window (`pagehide`), `doc` the document (`visibilitychange`);
 * both default to the page's own. `onError` hears every write that fails, the timed and the page-hide ones included
 * (audit 2b-A M-8: they used to be swallowed, and the session silently stopped being kept); the change that failed
 * stays pending, so the next flush or write tries it again.
 */
export function createLiveWriter(
  db: OfflineDb,
  opts: {
    delayMs?: number;
    target?: Listens;
    doc?: Listens & { visibilityState: DocumentVisibilityState };
    onError?: (error: unknown) => void;
  } = {},
): LiveWriter {
  const delayMs = opts.delayMs ?? 250;
  const target = opts.target ?? window;
  const doc = opts.doc ?? document;
  let pending: LiveSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let error: unknown = null;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (!next) return;
    try {
      await writeLive(db, next);
      error = null;
    } catch (e) {
      // Kept for the next try — unless a newer change arrived meanwhile, which supersedes it.
      pending ??= next;
      error = e;
      throw e;
    }
  };
  /** A flush nobody awaits (the timer, hide, leave, dispose): its failure goes to `onError`, never unhandled. */
  const flushAndTell = () => {
    flush().catch((e: unknown) => opts.onError?.(e));
  };
  const onHide = () => {
    if (doc.visibilityState === "hidden") flushAndTell();
  };
  const onLeave = () => flushAndTell();
  doc.addEventListener("visibilitychange", onHide);
  target.addEventListener("pagehide", onLeave);

  return {
    write(session) {
      pending = session;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushAndTell, delayMs);
    },
    flush,
    dispose() {
      doc.removeEventListener("visibilitychange", onHide);
      target.removeEventListener("pagehide", onLeave);
      flushAndTell();
    },
    get error() {
      return error;
    },
  };
}

/**
 * Ask the browser to keep this site's storage under pressure (the offline spike found it best-effort by default), so
 * a session in progress is not evicted. The player calls it at Start. True or false is the browser's answer; null when
 * the browser cannot say. Never throws.
 */
export async function requestPersistentStorage(
  storage: Pick<StorageManager, "persist"> | undefined = typeof navigator === "undefined" ? undefined : navigator.storage,
): Promise<boolean | null> {
  if (!storage?.persist) return null;
  try {
    return await storage.persist();
  } catch {
    return null;
  }
}
