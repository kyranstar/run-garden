/**
 * Chimes and the wake lock (spec §2b "Player"; spike report docs/reports/2026-10-07-offline-spike.md):
 *  - audio is unlocked inside the Start tap (no context is made outside a gesture);
 *  - every chime is placed on the audio clock from the WALL-CLOCK due time each time it is scheduled
 *    (`currentTime + (dueAt − now) / 1000`) — the spike saw the audio clock stall 2 s once, so an offset taken at Start
 *    would drift;
 *  - the wake lock is taken while playing and re-taken when the page comes back (the browser drops it when hidden).
 */
import { describe, expect, it } from "vitest";
import { createChimes, type AudioContextLike } from "../../src/player/audio.js";
import { holdWakeLock } from "../../src/player/wake.js";

function fakeContext() {
  const started: number[] = [];
  const stopped: number[] = [];
  const ctx = {
    state: "suspended" as AudioContextState,
    currentTime: 100,
    resumed: 0,
    destination: {},
    resume() {
      ctx.resumed++;
      ctx.state = "running";
      return Promise.resolve();
    },
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        disconnect() {},
        start: (at: number) => void started.push(at),
        stop: (at?: number) => void stopped.push(at ?? -1),
      };
      return osc;
    },
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n, disconnect() {} };
    },
  };
  return { ctx, started, stopped };
}

describe("chimes", () => {
  it("nothing is made or played before the tap that unlocks audio", () => {
    let made = 0;
    const chimes = createChimes(() => {
      made++;
      return fakeContext().ctx as unknown as AudioContextLike;
    });
    chimes.schedule([5000], 0);
    expect(made).toBe(0);
    chimes.unlock();
    expect(made).toBe(1);
  });

  it("the tap resumes a suspended context", () => {
    const f = fakeContext();
    const chimes = createChimes(() => f.ctx as unknown as AudioContextLike);
    chimes.unlock();
    expect(f.ctx.resumed).toBe(1);
  });

  it("a chime is placed from the wall-clock due time each time it is scheduled, so a stalled audio clock does not drift it", () => {
    const f = fakeContext();
    const chimes = createChimes(() => f.ctx as unknown as AudioContextLike);
    chimes.unlock();
    const T = 1_000_000;
    chimes.schedule([T + 5000], T);
    expect(f.started).toEqual([105]);
    // A minute on, the audio clock has fallen 2 s behind the wall clock (158, not 160).
    f.ctx.currentTime = 158;
    chimes.schedule([T + 65_000], T + 60_000);
    expect(f.started).toEqual([105, 163]);
  });

  it("scheduling again cancels what was scheduled; past chimes are not played late", () => {
    const f = fakeContext();
    const chimes = createChimes(() => f.ctx as unknown as AudioContextLike);
    chimes.unlock();
    chimes.schedule([10_000, 20_000], 0);
    expect(f.started).toEqual([110, 120]);
    chimes.schedule([5_000, 30_000], 12_000);
    // The two pending ones are stopped; 5 s is already past and is skipped.
    expect(f.stopped.filter((s) => s === 0)).toHaveLength(2);
    expect(f.started).toEqual([110, 120, 118]);
  });
});

describe("the wake lock", () => {
  function fakes() {
    const listeners = new Map<string, () => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (t: string, f: () => void) => void listeners.set(t, f),
      removeEventListener: (t: string) => void listeners.delete(t),
    };
    let requests = 0;
    let released = 0;
    const nav = {
      wakeLock: {
        request: async () => {
          requests++;
          return { release: async () => void released++ };
        },
      },
    };
    return { doc, nav, listeners, counts: () => ({ requests, released }) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("is taken at once and taken again each time the page comes back", async () => {
    const f = fakes();
    const release = holdWakeLock(f.nav, f.doc);
    await tick();
    expect(f.counts().requests).toBe(1);
    f.doc.visibilityState = "hidden";
    f.listeners.get("visibilitychange")!();
    await tick();
    expect(f.counts().requests).toBe(1);
    f.doc.visibilityState = "visible";
    f.listeners.get("visibilitychange")!();
    await tick();
    expect(f.counts().requests).toBe(2);
    release();
    await tick();
    expect(f.counts().released).toBe(1);
    expect(f.listeners.has("visibilitychange")).toBe(false);
  });

  it("a browser without it (or that refuses) changes nothing", async () => {
    const f = fakes();
    expect(() => holdWakeLock({}, f.doc)()).not.toThrow();
    const refusing = { wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } };
    const release = holdWakeLock(refusing, f.doc);
    await tick();
    expect(() => release()).not.toThrow();
  });
});
