/** A small key-value store: `chrome.storage.local` in the extension, an in-memory map in tests. */
export interface KvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** The extension's storage. Only the background and options pages call it. */
export const chromeStore: KvStore = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

export interface QueueEntry {
  /** `<kind>:<source>:<key>`: one entry per kind and post. */
  id: string;
  kind: "submit" | "extract";
  source: string;
  key: string;
  payload?: unknown;
}

const STORAGE_KEY = "queue";

/**
 * App calls not yet accepted by the app, kept in storage so a closed laptop, an offline moment, a killed service worker
 * or an app outage loses nothing: the next check sends them first. Every call reads storage afresh (no cached copy can
 * go stale across a restart); a check is single-flight, so nothing writes concurrently.
 */
export class ExtQueue {
  constructor(private readonly store: KvStore) {}

  private async entries(): Promise<QueueEntry[]> {
    const raw = await this.store.get(STORAGE_KEY);
    return Array.isArray(raw) ? (raw as QueueEntry[]) : [];
  }

  /** Adds an entry at the back. False (and nothing changes) when the same kind for the same post is already waiting. */
  async push(entry: Omit<QueueEntry, "id">): Promise<boolean> {
    const id = `${entry.kind}:${entry.source}:${entry.key}`;
    const all = await this.entries();
    if (all.some((e) => e.id === id)) return false;
    all.push({ id, ...entry });
    await this.store.set(STORAGE_KEY, all);
    return true;
  }

  async peek(): Promise<QueueEntry | null> {
    return (await this.entries())[0] ?? null;
  }

  async ack(id: string): Promise<void> {
    const all = await this.entries();
    const rest = all.filter((e) => e.id !== id);
    if (rest.length !== all.length) await this.store.set(STORAGE_KEY, rest);
  }

  async size(): Promise<number> {
    return (await this.entries()).length;
  }
}
