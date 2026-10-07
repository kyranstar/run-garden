/**
 * The offline database (`rg-offline`, Phase 2 spec §2b "Client storage"): what is put there is there after the page
 * (or the browser) is gone and the database is opened again. Each test gets a fresh fake browser (`IDBFactory`).
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { OFFLINE_STORES, openOfflineDb } from "../../src/offline/idb.js";

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
});
