/**
 * The offline database (`rg-offline`, Phase 2 spec §2b "Client storage"): what is put there is there after the page
 * (or the browser) is gone and the database is opened again. Each test gets a fresh fake browser (`IDBFactory`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { OFFLINE_DB_NAME, OFFLINE_DB_VERSION, OFFLINE_STORES, offlineDb, onOfflineDbReplaced, openOfflineDb } from "../../src/offline/idb.js";

/** A later deploy's code opening the database at the next version, in another tab (adds a store, as upgrades do). */
function newerTab(browser: IDBFactory, version = OFFLINE_DB_VERSION + 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = browser.open(OFFLINE_DB_NAME, version);
    req.onupgradeneeded = () => req.result.createObjectStore(`added-in-v${version}`);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

describe("the offline database", () => {
  it("keeps what was put through a close and a reopen, in every store", async () => {
    const browser = new IDBFactory();
    const first = await openOfflineDb(browser);
    for (const store of OFFLINE_STORES) await first.put(store, "k1", { store, n: 1 });
    first.close();

    const again = await openOfflineDb(browser);
    for (const store of OFFLINE_STORES) expect(await again.get(store, "k1")).toEqual({ store, n: 1 });
    expect(OFFLINE_STORES).toEqual(expect.arrayContaining(["builds", "live", "outbox"]));
    again.close();
  });

  it("a fresh browser holds nothing; delete removes one key; all lists a store in key order", async () => {
    const db = await openOfflineDb(new IDBFactory());
    expect(await db.get("live", "w1")).toBeUndefined();
    await db.put("live", "w2", { id: 2 });
    await db.put("live", "w1", { id: 1 });
    await db.put("builds", "w1", { other: true });
    expect(await db.all("live")).toEqual([{ id: 1 }, { id: 2 }]);
    await db.delete("live", "w1");
    expect(await db.all("live")).toEqual([{ id: 2 }]);
    expect(await db.get("builds", "w1")).toEqual({ other: true });
    db.close();
  });

  it("update reads and writes in one transaction: two at once never lose a change", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await db.put("meta", "count", 0);
    await Promise.all(Array.from({ length: 10 }, () => db.update<number>("meta", "count", (n) => (n ?? 0) + 1)));
    expect(await db.get("meta", "count")).toBe(10);
    // Returning undefined deletes; the result is what was written.
    expect(await db.update("meta", "count", () => undefined)).toBeUndefined();
    expect(await db.get("meta", "count")).toBeUndefined();
    db.close();
  });

  it("clear empties one store and leaves the others", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await db.put("live", "w1", 1);
    await db.put("live", "w2", 2);
    await db.put("outbox", "k", 3);
    await db.clear("live");
    expect(await db.all("live")).toEqual([]);
    expect(await db.all("outbox")).toEqual([3]);
    db.close();
  });
});

describe("a newer version in another tab (audit 2b-A M-11, M-10)", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it("this tab lets go at once (the newer tab is never blocked), is told, and its next open takes the database as it now is", async () => {
    const browser = new IDBFactory();
    const closed = vi.fn();
    const old = await openOfflineDb(browser, closed);
    await old.put("live", "w1", { step: 3 });

    const newer = await newerTab(browser);
    expect(closed).toHaveBeenCalledOnce();
    newer.close();

    // This tab's code still asks for its own (older) version: VersionError, so it reopens without one — what it needs
    // is all there, since an upgrade only adds.
    const again = await openOfflineDb(browser);
    expect(await again.get("live", "w1")).toEqual({ step: 3 });
    await again.put("outbox", "k", 1);
    expect(await again.all("outbox")).toEqual([1]);
    again.close();
  });

  it("the app's shared connection tells the page (which reloads), and the next offlineDb() opens again", async () => {
    const browser = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = browser;
    const replaced = vi.fn();
    const stop = onOfflineDbReplaced(replaced);
    const first = await offlineDb();
    await first.put("builds", "w1", { b: 1 });

    (await newerTab(browser)).close();
    expect(replaced).toHaveBeenCalledOnce();

    const second = await offlineDb();
    expect(second).not.toBe(first);
    expect(await second.get("builds", "w1")).toEqual({ b: 1 });
    stop();
    second.close();
  });

  it("blocked by a connection that never lets go: the open fails, and when it succeeds later the connection is closed, never leaked", async () => {
    // A stand-in request: blocked first, then (the holder gone) a success nobody is waiting for any more.
    const req = {} as { onblocked?: () => void; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: unknown; result?: unknown };
    const browser = { open: vi.fn(() => req) } as unknown as IDBFactory;
    const opening = openOfflineDb(browser);
    req.onblocked!();
    await expect(opening).rejects.toThrow("held open");
    const late = { close: vi.fn(), onversionchange: null };
    req.result = late;
    req.onsuccess!();
    expect(late.close).toHaveBeenCalledOnce();
  });
});
