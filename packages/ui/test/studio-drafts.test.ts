/**
 * Stage 2 Task 5 — the workout being built, on this device (spec §7, §12): one draft at a time in the offline
 * database's `drafts` store; empty parts are a draft's right; what an older build or a broken write left reads as
 * none; with no IndexedDB the draft lives in the page; signing out forgets it.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing } from "@rg/workout";
import { openOfflineDb } from "../src/offline/idb.js";
import { forgetOfflineIdentity } from "../src/offline/me.js";
import { DRAFT_KEY, draftStore, readDraft } from "../src/studio-drafts.js";

const structured = () => newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } });

describe("the draft store", () => {
  it("keeps one draft through a close and a reopen, empty parts and all; clear forgets it", async () => {
    const browser = new IDBFactory();
    const store = draftStore(() => openOfflineDb(browser));
    expect(await store.load()).toBeNull();
    const doc = edit(startEditing(structured()), { type: "addItem", item: { kind: "exercise", libraryId: "catCow", dose: { reps: 6 } } }, EXERCISES).doc;
    const saved = await store.save(doc, 1234);
    expect(saved).toEqual({ doc, updatedAt: 1234 });

    const again = draftStore(() => openOfflineDb(browser));
    const loaded = await again.load();
    expect(loaded?.doc).toEqual(doc);
    expect(loaded?.doc.parts.map((p) => [p.purpose, p.items.length])).toEqual([
      ["warmup", 1],
      ["main", 0],
      ["cooldown", 0],
    ]);
    // One at a time: a second save replaces the first.
    const other = structured();
    await again.save(other, 5);
    expect((await store.load())?.doc.parts.every((p) => p.items.length === 0)).toBe(true);
    await again.clear();
    expect(await store.load()).toBeNull();
  });

  it("a stored value that no longer reads as a draft is none", () => {
    expect(readDraft(undefined)).toBeNull();
    expect(readDraft({ doc: { title: "x" } })).toBeNull();
    expect(readDraft({ doc: { ...structured(), version: 2 }, updatedAt: 1 })).toBeNull();
    expect(readDraft({ doc: { ...structured(), parts: [{ purpose: "nap", format: "straight", items: [] }] } })).toBeNull();
    // A good one, even with no parts at all (a blank new workout).
    const blank = newDoc("blank", { title: "Blank", source: { kind: "studio" } });
    expect(readDraft({ doc: blank, updatedAt: 9 })).toEqual({ doc: blank, updatedAt: 9 });
    expect(readDraft({ doc: structured() })?.updatedAt).toBe(0);
  });

  it("with no IndexedDB, the page keeps it", async () => {
    const store = draftStore(() => Promise.reject(new Error("IndexedDB is unavailable")));
    await store.clear();
    expect(await store.load()).toBeNull();
    const doc = structured();
    await store.save(doc, 1);
    expect((await store.load())?.doc).toEqual(doc);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("a create's key is kept with the draft on the device: through a reopen and an edit, until that create lands (whole-branch ruling)", async () => {
    const browser = new IDBFactory();
    const store = draftStore(() => openOfflineDb(browser));
    // No draft: nothing to keep a key with.
    expect(await store.createKey("workout")).toBeNull();
    await store.save(structured(), 1);
    const workout = await store.createKey("workout");
    expect(workout).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const template = await store.createKey("template");
    expect(template).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(template).not.toBe(workout);

    // The page reloads (another store on the same database), the draft is edited: the same keys.
    const again = draftStore(() => openOfflineDb(browser));
    await again.save(edit(startEditing(structured()), { type: "addItem", item: { kind: "exercise", libraryId: "catCow", dose: { reps: 6 } } }, EXERCISES).doc, 2);
    expect(await again.createKey("workout")).toBe(workout);
    expect(await again.createKey("template")).toBe(template);
    expect((await again.load())?.keys).toEqual({ workout, template });

    // The template landed: its key goes, the workout's stays, the draft too.
    await again.createLanded("template");
    expect((await store.load())?.keys).toEqual({ workout });
    const next = await store.createKey("template");
    expect(next).not.toBe(template);
    expect(await store.createKey("workout")).toBe(workout);
    expect((await store.load())?.doc.parts[0]!.items).toHaveLength(1);

    // Another draft (Start over clears this one): new keys.
    await store.clear();
    await store.save(structured(), 3);
    expect((await store.load())?.keys).toBeUndefined();
    expect(await store.createKey("workout")).not.toBe(workout);
  });

  it("a stored value that is no draft keeps no key, and is left as it is", async () => {
    const browser = new IDBFactory();
    const db = await openOfflineDb(browser);
    const broken = { doc: { title: "x" }, updatedAt: 1 };
    await db.put("drafts", DRAFT_KEY, broken);
    const store = draftStore(async () => db);
    expect(await store.createKey("workout")).toBeNull();
    expect(await db.get("drafts", DRAFT_KEY)).toEqual(broken);
    db.close();
  });

  it("a stored key that is not a key's shape reads as none", () => {
    const doc = structured();
    expect(readDraft({ doc, updatedAt: 1, keys: { workout: "ok-key_1", template: "no spaces" } })?.keys).toEqual({ workout: "ok-key_1" });
    expect(readDraft({ doc, updatedAt: 1, keys: { workout: 7, other: "x" } })?.keys).toBeUndefined();
    expect(readDraft({ doc, updatedAt: 1, keys: "workout" })?.keys).toBeUndefined();
  });

  it("with no IndexedDB, the page keeps the keys with its draft", async () => {
    const store = draftStore(() => Promise.reject(new Error("IndexedDB is unavailable")));
    await store.clear();
    expect(await store.createKey("workout")).toBeNull();
    await store.save(structured(), 1);
    const key = await store.createKey("workout");
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await store.save(structured(), 2);
    expect(await store.createKey("workout")).toBe(key);
    await store.createLanded("workout");
    expect(await store.createKey("workout")).not.toBe(key);
    await store.clear();
  });

  it("signing out forgets it, with the rest of the offline identity", async () => {
    const browser = new IDBFactory();
    const db = await openOfflineDb(browser);
    await draftStore(async () => db).save(structured(), 1);
    expect(await db.get("drafts", DRAFT_KEY)).toBeDefined();
    await forgetOfflineIdentity({ caches: undefined, db: async () => db });
    expect(await db.get("drafts", DRAFT_KEY)).toBeUndefined();
    db.close();
  });
});
