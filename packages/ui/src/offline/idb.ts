/**
 * THE OFFLINE DATABASE (Phase 2 spec §2b "Client storage"): `rg-offline`, a small wrapper over IndexedDB with no
 * dependency.
 *
 *   builds   workoutId → the session's build and view, as the sheet or the player last loaded them
 *   live     workoutId → the session in progress (recorder state, step, timer anchor, paused)
 *   outbox   `${performedId}:${payloadHash}` → a saved session waiting for the server
 *   meta     small bookkeeping (the outbox's drain lock)
 *
 * Keys are given with each write (out-of-line). The schema is versioned: `UPGRADES[n]` takes a database from version n
 * to n + 1, so a later version adds a store without touching what is stored.
 */

export const OFFLINE_DB_NAME = "rg-offline";
export const OFFLINE_STORES = ["builds", "live", "outbox", "meta"] as const;
export type OfflineStore = (typeof OFFLINE_STORES)[number];

const UPGRADES: ReadonlyArray<(db: IDBDatabase) => void> = [
  (db) => {
    for (const store of OFFLINE_STORES) db.createObjectStore(store);
  },
];
export const OFFLINE_DB_VERSION = UPGRADES.length;

export interface OfflineDb {
  get<T>(store: OfflineStore, key: string): Promise<T | undefined>;
  put<T>(store: OfflineStore, key: string, value: T): Promise<void>;
  delete(store: OfflineStore, key: string): Promise<void>;
  /** Every value in the store, in key order. */
  all<T>(store: OfflineStore): Promise<T[]>;
  /**
   * Read and write one key in a single transaction, so two callers (two tabs) never both act on what they read:
   * `change` gets the stored value (synchronously — no awaiting inside) and returns the value to store, or
   * `undefined` to delete it. Resolves, once committed, with what was stored.
   */
  update<T>(store: OfflineStore, key: string, change: (current: T | undefined) => T | undefined): Promise<T | undefined>;
  close(): void;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap(db: IDBDatabase): OfflineDb {
  const tx = (store: OfflineStore, mode: IDBTransactionMode) => db.transaction(store, mode);
  return {
    async get<T>(store: OfflineStore, key: string) {
      return (await result(tx(store, "readonly").objectStore(store).get(key))) as T | undefined;
    },
    async put<T>(store: OfflineStore, key: string, value: T) {
      const t = tx(store, "readwrite");
      t.objectStore(store).put(value, key);
      await done(t);
    },
    async delete(store: OfflineStore, key: string) {
      const t = tx(store, "readwrite");
      t.objectStore(store).delete(key);
      await done(t);
    },
    async all<T>(store: OfflineStore) {
      return (await result(tx(store, "readonly").objectStore(store).getAll())) as T[];
    },
    async update<T>(store: OfflineStore, key: string, change: (current: T | undefined) => T | undefined) {
      const t = tx(store, "readwrite");
      const os = t.objectStore(store);
      let next: T | undefined;
      const read = os.get(key);
      read.onsuccess = () => {
        next = change(read.result as T | undefined);
        if (next === undefined) os.delete(key);
        else os.put(next, key);
      };
      await done(t);
      return next;
    },
    close: () => db.close(),
  };
}

/**
 * Open (creating or upgrading) the offline database in `factory` — the browser's `indexedDB` unless given one.
 * `onClosed` runs when a newer version opening in another tab makes this connection let go.
 */
export function openOfflineDb(factory: IDBFactory = indexedDB, onClosed?: () => void): Promise<OfflineDb> {
  return new Promise((resolve, reject) => {
    const req = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = (e) => {
      for (let v = e.oldVersion; v < OFFLINE_DB_VERSION; v++) UPGRADES[v]!(req.result);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        onClosed?.();
      };
      resolve(wrap(db));
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("rg-offline is held open by an older tab"));
  });
}

let shared: Promise<OfflineDb> | null = null;

/** The app's offline database, opened once per page and shared (reopened after another tab upgrades it). */
export function offlineDb(): Promise<OfflineDb> {
  if (!shared) {
    const forget = () => {
      shared = null;
    };
    shared =
      typeof indexedDB === "undefined" ? Promise.reject(new Error("IndexedDB is unavailable")) : openOfflineDb(indexedDB, forget);
    shared.catch(forget);
  }
  return shared;
}
