/**
 * The wake lock (spec §2b "Player"; spike report docs/reports/2026-10-07-offline-spike.md): taken while playing and
 * re-taken when the page comes back (the browser drops it when hidden).
 *
 * The chimes these tests once shared the file with are gone (the sound pass, 2026-10-17): the cue player took their
 * place, and their tests moved to cue-player.test.ts (nothing before the tap; wall-clock placement, a stalled audio
 * clock included; a new schedule replaces the old; nothing played late).
 */
import { describe, expect, it } from "vitest";
import { holdWakeLock } from "../../src/player/wake.js";

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
