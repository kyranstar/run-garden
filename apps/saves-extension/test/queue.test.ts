import { describe, expect, it } from "vitest";
import { ExtQueue } from "../src/queue.js";
import { memoryStore } from "./fixtures.js";

describe("ExtQueue", () => {
  it("survives a simulated restart: a new queue on the same storage sees the same entries, in order", async () => {
    const store = memoryStore();
    const before = new ExtQueue(store);
    await before.push({ kind: "submit", source: "instagram", key: "Syn00000001", payload: { n: 1 } });
    await before.push({ kind: "extract", source: "instagram", key: "Syn00000002" });

    const after = new ExtQueue(store); // the service worker was killed and started again
    expect(await after.size()).toBe(2);
    const head = await after.peek();
    expect(head).toMatchObject({ kind: "submit", key: "Syn00000001", payload: { n: 1 } });
    await after.ack(head!.id);
    expect(await after.peek()).toMatchObject({ kind: "extract", key: "Syn00000002" });
    expect(await new ExtQueue(store).size()).toBe(1);
  });

  it("holds one entry per kind and post", async () => {
    const q = new ExtQueue(memoryStore());
    expect(await q.push({ kind: "submit", source: "instagram", key: "k" })).toBe(true);
    expect(await q.push({ kind: "submit", source: "instagram", key: "k" })).toBe(false);
    expect(await q.push({ kind: "extract", source: "instagram", key: "k" })).toBe(true);
    expect(await q.size()).toBe(2);
  });

  it("is empty on fresh storage, and acking an unknown id changes nothing", async () => {
    const q = new ExtQueue(memoryStore());
    expect(await q.peek()).toBeNull();
    await q.push({ kind: "submit", source: "instagram", key: "k" });
    await q.ack("nope");
    expect(await q.size()).toBe(1);
  });
});
