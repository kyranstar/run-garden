/**
 * The outbox (Phase 2 spec §2b "Client storage"; plan Task 2): a saved session waits in IndexedDB until
 * `PUT /api/sessions/performed/:id` takes it, exactly once. 2xx or `same_payload` removes it; `409 conflict` keeps it
 * and flags it for Settings → Data; a network error backs off 1 s, 5 s, 30 s, then waits for the next trigger (start,
 * online, visible). Two drains at once never send one entry twice (a drain lock in IndexedDB, with a timeout).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError } from "@rg/api-client";
import { performedSessionSaveSchema, type PerformedSessionWire, type PerformedSessionWireInput } from "@rg/domain";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import {
  discardEntry,
  drain,
  enqueue,
  outboxEntries,
  payloadHash,
  retryEntry,
  startOutboxSync,
  type OutboxApi,
} from "../../src/offline/outbox.js";

afterEach(() => {
  vi.useRealTimers();
});

const save = (id: string, over: Partial<PerformedSessionWireInput> = {}): PerformedSessionWireInput => ({
  id,
  source: "app",
  sourceRef: null,
  workoutId: `slot-${id}`,
  buildId: "b1",
  localDate: "2026-10-07",
  startedAt: "2026-10-07T18:00:00.000Z",
  endedAt: "2026-10-07T18:31:00.000Z",
  seconds: 1860,
  plannedSeconds: 1800,
  minutes: 30,
  mode: "consistent",
  theme: null,
  locationId: "home",
  blockRef: null,
  blockNumber: 1,
  completed: true,
  stepsTotal: 24,
  stepsDone: 24,
  note: null,
  newMove: null,
  entries: [{ exerciseId: "goblet-squat", implement: "kettlebell", format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 6, seconds: null, load: { v: 30, u: "lb" } }] }],
  ...over,
});

/** A server double: answers each PUT with the next scripted outcome for that session id, recording every call. */
function server(script: Record<string, Array<"ok" | "same_payload_200" | "same_payload_409" | "conflict" | "offline" | 422 | 503>>) {
  const calls: string[] = [];
  const api: OutboxApi = {
    savePerformed: vi.fn(async (id: string, payload: PerformedSessionWire) => {
      expect(payload.id).toBe(id);
      calls.push(id);
      const next = script[id]?.shift() ?? "ok";
      if (next === "ok") return { status: "saved" };
      if (next === "same_payload_200") return { status: "same_payload" };
      if (next === "same_payload_409") throw new ApiError(409, { error: "same_payload" });
      if (next === "conflict") throw new ApiError(409, { error: "conflict" });
      if (next === "offline") throw new TypeError("Failed to fetch");
      throw new ApiError(next, { error: next === 422 ? "invalid_save" : "busy" });
    }),
  };
  return { api, calls };
}

/** Lets real IndexedDB work run (fake timers leave `setImmediate` alone) until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting");
}

/** Lets any IndexedDB work in flight finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

async function freshDb(): Promise<OfflineDb> {
  return openOfflineDb(new IDBFactory());
}

describe("enqueue", () => {
  it("keys an entry by session id and payload hash: the same save twice is one entry, different edits are two", async () => {
    const db = await freshDb();
    const a = await enqueue(db, save("p1"), 1000);
    await enqueue(db, save("p1"), 2000);
    expect(await outboxEntries(db)).toHaveLength(1);
    expect(a).toMatchObject({ performedId: "p1", attempts: 0, state: "pending", createdAt: 1000, lastError: null });
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    // Saving the same thing again never resets an entry already tried (its attempts, its flag).
    await db.put("outbox", a.key, { ...a, attempts: 2, state: "conflict" });
    await enqueue(db, save("p1"), 2500);
    expect((await outboxEntries(db))[0]).toMatchObject({ attempts: 2, state: "conflict", createdAt: 1000 });

    // A second tab saving the same session with another note: kept beside the first, never over it.
    await enqueue(db, save("p1", { note: "other tab" }), 3000);
    const entries = await outboxEntries(db);
    expect(entries.map((e) => e.payload.note)).toEqual([null, "other tab"]);
    db.close();
  });

  it("refuses a payload the server would never take, storing nothing", async () => {
    const db = await freshDb();
    await expect(enqueue(db, save("p1", { localDate: "07/10/2026" }), 1000)).rejects.toThrow();
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("stores the payload as the server will read it (defaults filled), hashed over canonical JSON", async () => {
    const db = await freshDb();
    const entry = await enqueue(db, save("p1"), 1000);
    const parsed = performedSessionSaveSchema.parse(save("p1"));
    expect(entry.payload).toEqual(parsed);
    // Key order is not content.
    const reordered = Object.fromEntries(Object.entries(parsed).reverse()) as PerformedSessionWire;
    expect(await payloadHash(reordered)).toBe(entry.payloadHash);
    expect(await payloadHash({ ...parsed, note: "x" })).not.toBe(entry.payloadHash);
    db.close();
  });
});

describe("drain", () => {
  it("sends in the order saved and removes an entry on 2xx and on same_payload (200 or 409)", async () => {
    const db = await freshDb();
    await enqueue(db, save("c"), 3000);
    await enqueue(db, save("a"), 1000);
    await enqueue(db, save("b"), 2000);
    const { api, calls } = server({ a: ["ok"], b: ["same_payload_409"], c: ["same_payload_200"] });

    const result = await drain(db, api, { now: () => 5000 });

    expect(calls).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ saved: 3, conflicts: 0, failed: 0, locked: false });
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("keeps and flags a conflict, goes on with the next, and never sends the flagged one again by itself", async () => {
    const db = await freshDb();
    await enqueue(db, save("a"), 1000);
    await enqueue(db, save("b"), 2000);
    const { api, calls } = server({ a: ["conflict"], b: ["ok"] });

    expect(await drain(db, api, { now: () => 5000 })).toMatchObject({ saved: 1, conflicts: 1 });
    const [left] = await outboxEntries(db);
    expect(left).toMatchObject({ performedId: "a", state: "conflict", lastError: "conflict" });

    await drain(db, api, { now: () => 9000 });
    expect(calls).toEqual(["a", "b"]);

    // Settings → Data: Retry sends it once more; Discard drops it.
    await retryEntry(db, left!.key);
    await drain(db, api, { now: () => 10_000 });
    expect(calls).toEqual(["a", "b", "a"]);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("flags a refusal that retrying cannot fix (422) without retrying it, and Discard removes it", async () => {
    const db = await freshDb();
    const entry = await enqueue(db, save("a"), 1000);
    const { api, calls } = server({ a: [422] });
    expect(await drain(db, api, { now: () => 2000 })).toMatchObject({ failed: 1 });
    expect((await outboxEntries(db))[0]).toMatchObject({ state: "failed", lastError: "http_422 invalid_save" });
    await drain(db, api, { now: () => 3000 });
    expect(calls).toEqual(["a"]);
    await discardEntry(db, entry.key);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("backs off on a network error — 1 s, 5 s, 30 s, then only on the next trigger — and stops sending meanwhile", async () => {
    const db = await freshDb();
    await enqueue(db, save("a"), 1000);
    await enqueue(db, save("b"), 1001);
    const { api, calls } = server({ a: ["offline", "offline", 503, "offline", "offline", "ok"] });

    // Attempt 1 fails: the later entry is not tried while the network is down.
    expect((await drain(db, api, { now: () => 10_000 })).retryAt).toBe(11_000);
    expect(calls).toEqual(["a"]);
    expect((await outboxEntries(db))[0]).toMatchObject({ attempts: 1, state: "pending", lastError: "network" });

    // A timer drain before the backoff is up sends nothing.
    await drain(db, api, { now: () => 10_500, mode: "timer" });
    expect(calls).toEqual(["a"]);

    expect((await drain(db, api, { now: () => 11_000, mode: "timer" })).retryAt).toBe(16_000);
    expect((await drain(db, api, { now: () => 16_000, mode: "timer" })).retryAt).toBe(46_000); // 503 is transient too
    // The fourth failure schedules nothing: the next start / online / visible tries again.
    expect((await drain(db, api, { now: () => 46_000, mode: "timer" })).retryAt).toBeNull();
    expect((await outboxEntries(db))[0]).toMatchObject({ attempts: 4 });

    // A trigger (online, visible, start) does not wait for the backoff.
    await enqueue(db, save("c"), 1002);
    await drain(db, api, { now: () => 46_001, mode: "event" });
    expect(calls).toEqual(["a", "a", "a", "a", "a"]);
    await drain(db, api, { now: () => 46_002, mode: "event" });
    expect(calls).toEqual(["a", "a", "a", "a", "a", "a", "b", "c"]);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("two drains at once never send one entry twice", async () => {
    const db = await freshDb();
    await enqueue(db, save("a"), 1000);
    await enqueue(db, save("b"), 2000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const api: OutboxApi = {
      savePerformed: async (id) => {
        calls.push(id);
        await gate;
        return { status: "saved" };
      },
    };

    const both = Promise.all([drain(db, api, { now: () => 5000 }), drain(db, api, { now: () => 5000 })]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    release();
    const results = await both;

    expect(calls).toEqual(["a", "b"]);
    expect(results.filter((r) => r.locked)).toHaveLength(1);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });

  it("a lock left by a tab that died is taken over once it times out", async () => {
    const db = await freshDb();
    await enqueue(db, save("a"), 1000);
    await db.put("meta", "outbox-drain", { owner: "a tab that died", until: 61_000 });
    const { api, calls } = server({});
    expect(await drain(db, api, { now: () => 60_000 })).toMatchObject({ locked: true });
    expect(calls).toEqual([]);
    expect(await drain(db, api, { now: () => 61_001 })).toMatchObject({ locked: false, saved: 1 });
    expect(calls).toEqual(["a"]);
    // Released afterwards: the next drain is not locked out.
    expect(await db.get("meta", "outbox-drain")).toBeUndefined();
    db.close();
  });
});

describe("startOutboxSync", () => {
  it("drains on start, on online, on becoming visible, and when a backoff is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(100_000);
    const db = await freshDb();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const { api, calls } = server({ a: ["offline", "offline", "ok"] });
    await enqueue(db, save("a"), 1000);

    const drained: number[] = [];
    const stop = startOutboxSync({ db: async () => db, api, win, doc, onDrained: () => drained.push(Date.now()) });
    await until(() => drained.length === 1);
    expect(calls).toEqual(["a"]); // start

    // The first backoff (1 s) brings the next attempt.
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => drained.length === 2);
    expect(calls).toEqual(["a", "a"]);

    // Back online: sent at once, without waiting out the 5 s backoff.
    win.dispatchEvent(new Event("online"));
    await until(() => drained.length === 3);
    expect(calls).toEqual(["a", "a", "a"]);
    expect(await outboxEntries(db)).toEqual([]);

    // Hidden does nothing; visible drains.
    await enqueue(db, save("b"), 2000);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls).toEqual(["a", "a", "a"]);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await until(() => drained.length === 4);
    expect(calls).toEqual(["a", "a", "a", "b"]);

    stop();
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drained).toHaveLength(4);
    db.close();
  });
});
