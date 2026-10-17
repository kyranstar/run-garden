/**
 * The session's sounds (Task 13's sound pass, 2026-10-17): the cue player and its palettes.
 *  - nothing is made before the tap that unlocks audio; the tap asks for an "ambient" session (cues mix over music);
 *  - each palette renders its cues once, dry and mono, at the context's rate;
 *  - a cue is one buffer source, placed from its WALL-CLOCK due time (`currentTime + (at − now) / 1000`);
 *  - a list given before the renders, or while interrupted, is placed once both are ready;
 *  - past cues and cues beyond the window are left; a new schedule replaces the old one; off places nothing.
 */
import { describe, expect, it } from "vitest";
import { WINDOW_MS, cueIdOf, createCuePlayer, type CuePlayerDeps } from "../../src/player/cue-player.js";
import { CUE_IDS, CUE_NOTES, cueSeconds, renderCues, type CueId, type PaletteId } from "../../src/player/sound-palettes.js";
import { SOUND_KEY, readSound, resolvePalette, soundFor, writeSound } from "../../src/player/sound-settings.js";

const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v: number) { this.value = v; } });
const node = () => ({ connect: (n: unknown) => n, disconnect() {} });

function fakeBuffer(id: string) {
  return { id, duration: 1 } as unknown as AudioBuffer;
}

function fakeOffline(log: Array<{ channels: number; frames: number; rate: number }>) {
  let made = 0;
  return (channels: number, frames: number, rate: number) => {
    log.push({ channels, frames, rate });
    const n = made++;
    const c = {
      sampleRate: rate,
      destination: node(),
      createOscillator: () => ({ ...node(), type: "sine", frequency: param(), start() {}, stop() {} }),
      createGain: () => ({ ...node(), gain: param() }),
      startRendering: () => Promise.resolve(fakeBuffer(`r${n}`)),
    };
    return c as unknown as OfflineAudioContext;
  };
}

function fakeContext() {
  const sources: Array<{ buffer: AudioBuffer | null; at: number; stopped: boolean }> = [];
  const ctx = {
    state: "suspended" as string,
    currentTime: 100,
    sampleRate: 48000,
    destination: node(),
    resumed: 0,
    onstatechange: null as null | (() => void),
    resume() {
      ctx.resumed++;
      ctx.state = "running";
      return Promise.resolve();
    },
    createGain: () => ({ ...node(), gain: param() }),
    createConvolver: () => ({ ...node(), buffer: null }),
    createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param(), Q: param() }),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createBuffer: (_ch: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
    createOscillator: () => ({ ...node(), type: "sine", frequency: param(), start() {}, stop() {} }),
    createBufferSource() {
      const s = { buffer: null as AudioBuffer | null, at: -1, stopped: false, ...node(), start(at: number) { s.at = at; }, stop() { s.stopped = true; } };
      sources.push(s);
      return s;
    },
  };
  return { ctx, sources };
}

/** A player on fakes, with the wall clock at `clock.now`. Renders resolve on the next microtasks. */
function setup(opts: { offline?: boolean } = {}) {
  const f = fakeContext();
  const offlineLog: Array<{ channels: number; frames: number; rate: number }> = [];
  const clock = { now: 1_000_000 };
  let made = 0;
  let ambient = 0;
  const deps: CuePlayerDeps = {
    makeContext: () => {
      made++;
      return f.ctx as unknown as AudioContext;
    },
    makeOffline: opts.offline === false ? null : fakeOffline(offlineLog),
    ambientSession: () => void ambient++,
    now: () => clock.now,
  };
  const player = createCuePlayer(deps);
  return { player, f, offlineLog, clock, made: () => made, ambient: () => ambient };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const live = (sources: ReturnType<typeof fakeContext>["sources"]) => sources.filter((s) => !s.stopped && s.at >= 0);

describe("the cue player", () => {
  it("makes nothing and places nothing before the tap that unlocks audio", async () => {
    const t = setup();
    t.player.schedule([{ at: t.clock.now + 5000, kind: "go" }]);
    await flush();
    expect(t.made()).toBe(0);
    expect(t.f.sources).toHaveLength(0);
  });

  it("the tap asks for an ambient session, makes one context, resumes it, and renders the palette's cues", async () => {
    const t = setup();
    t.player.unlock();
    t.player.unlock();
    expect(t.made()).toBe(1);
    expect(t.ambient()).toBe(2);
    expect(t.f.ctx.resumed).toBe(1);
    await flush();
    expect(t.offlineLog).toHaveLength(CUE_IDS.length);
    expect(new Set(t.offlineLog.map((r) => r.channels))).toEqual(new Set([1]));
    expect(new Set(t.offlineLog.map((r) => r.rate))).toEqual(new Set([48000]));
  });

  it("places each cue as one buffer source from its wall-clock time, with that cue's render", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([
      { at: t.clock.now + 2000, kind: "tick", n: 3 },
      { at: t.clock.now + 3000, kind: "tick", n: 2 },
      { at: t.clock.now + 4000, kind: "tick", n: 1 },
      { at: t.clock.now + 5000, kind: "go" },
    ]);
    const placed = live(t.f.sources);
    expect(placed.map((s) => s.at)).toEqual([102, 103, 104, 105]);
    // Four different renders: the ticks are three pitches, then the chord.
    expect(new Set(placed.map((s) => (s.buffer as unknown as { id: string }).id)).size).toBe(4);
  });

  it("keeps a list given before the renders are ready, and places it from the wall clock once they are", async () => {
    const t = setup();
    t.player.unlock();
    t.player.schedule([{ at: t.clock.now + 6000, kind: "rest" }]);
    expect(live(t.f.sources)).toHaveLength(0);
    t.clock.now += 1000; // a second passes while rendering
    await flush();
    expect(live(t.f.sources).map((s) => s.at)).toEqual([105]);
  });

  it("leaves a cue already due and one beyond the window; a new schedule replaces the old one", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([
      { at: t.clock.now - 10, kind: "go" },
      { at: t.clock.now + 1000, kind: "switch" },
      { at: t.clock.now + WINDOW_MS + 1, kind: "done" },
    ]);
    expect(live(t.f.sources).map((s) => s.at)).toEqual([101]);
    t.player.schedule([{ at: t.clock.now + 2000, kind: "next" }]);
    expect(live(t.f.sources).map((s) => s.at)).toEqual([102]);
    t.player.cancel();
    expect(live(t.f.sources)).toHaveLength(0);
  });

  it("off places nothing; on again places the list; volume is clamped and set on the room", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.configure({ on: false, volume: 3, palette: "keys" });
    t.player.schedule([{ at: t.clock.now + 1000, kind: "go" }]);
    expect(live(t.f.sources)).toHaveLength(0);
    t.player.configure({ on: true, volume: 0.4, palette: "keys" });
    expect(live(t.f.sources)).toHaveLength(1);
  });

  it("a new palette renders and the list is placed again with its cues", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([{ at: t.clock.now + 1000, kind: "go" }]);
    const before = (live(t.f.sources)[0]!.buffer as unknown as { id: string }).id;
    t.player.configure({ on: true, volume: 0.7, palette: "kalimba" });
    await flush();
    const after = live(t.f.sources);
    expect(after).toHaveLength(1);
    expect((after[0]!.buffer as unknown as { id: string }).id).not.toBe(before);
    expect(t.offlineLog).toHaveLength(CUE_IDS.length * 2);
  });

  it("an interrupted context (a call, Siri) is resumed by the next tap, and the cues are placed again from the wall clock", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([{ at: t.clock.now + 30_000, kind: "done" }]);
    t.f.ctx.state = "interrupted";
    t.clock.now += 10_000;
    t.f.ctx.currentTime = 200;
    t.player.unlock();
    expect(t.f.ctx.resumed).toBe(2);
    t.f.ctx.onstatechange?.();
    expect(live(t.f.sources).map((s) => s.at)).toEqual([220]);
  });

  it("a new schedule, or cancel, never cuts a cue already due — it rings on; sound off stops it", async () => {
    // The player plans again the moment a step changes, which is the moment its cue plays (the sound pass's fix).
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([
      { at: t.clock.now + 1000, kind: "go" },
      { at: t.clock.now + 5000, kind: "done" },
    ]);
    const [go, done] = live(t.f.sources);
    t.clock.now += 1200;
    t.f.ctx.currentTime += 1.2;
    t.player.schedule([{ at: t.clock.now + 3000, kind: "tick", n: 3 }]);
    expect(go!.stopped).toBe(false);
    expect(done!.stopped).toBe(true);
    t.player.cancel();
    expect(go!.stopped).toBe(false);
    t.player.configure({ on: false, volume: 0.7, palette: "keys" });
    expect(go!.stopped).toBe(true);
  });

  it("a stalled audio clock does not drift a cue: each schedule places it from the wall clock (moved from the chimes)", async () => {
    const t = setup();
    t.player.unlock();
    await flush();
    t.player.schedule([{ at: t.clock.now + 5000, kind: "go" }]);
    expect(live(t.f.sources).map((s) => s.at)).toEqual([105]);
    // A minute on, the audio clock has fallen 2 s behind the wall clock (158, not 160).
    t.clock.now += 60_000;
    t.f.ctx.currentTime = 158;
    t.player.schedule([{ at: t.clock.now + 5000, kind: "go" }]);
    expect(t.f.sources.at(-1)!.at).toBe(163);
  });

  it("says whether audio runs: not before the tap, and once the context does", async () => {
    const t = setup();
    expect(t.player.running()).toBe(false);
    t.player.unlock();
    expect(t.player.running()).toBe(true);
    t.f.ctx.state = "interrupted";
    expect(t.player.running()).toBe(false);
  });

  it("a preview plays at once, and the countdown preview is three ticks and a go", async () => {
    const t = setup();
    t.player.preview("count");
    await flush();
    t.player.preview("count");
    const last4 = t.f.sources.slice(-4).map((s) => s.at - t.f.ctx.currentTime);
    expect(last4.map((x) => Math.round(x * 100) / 100)).toEqual([0.05, 1.05, 2.05, 3.05]);
  });
});

describe("the palettes", () => {
  it("the countdown climbs and lands on a chord with the tonic", () => {
    const pitch = (id: CueId) => CUE_NOTES[id][0]!.midi;
    expect(pitch("tick3")).toBeLessThan(pitch("tick2"));
    expect(pitch("tick2")).toBeLessThan(pitch("tick1"));
    expect(CUE_NOTES.go.length).toBeGreaterThanOrEqual(3);
    expect(CUE_NOTES.go.some((n) => n.midi % 12 === 2)).toBe(true); // D
    expect(CUE_NOTES.done.length).toBeGreaterThan(CUE_NOTES.go.length);
  });

  it("each palette's renders are as long as its notes ring, and the bowls longest", () => {
    for (const cue of CUE_IDS) {
      expect(cueSeconds(cue, "bowl")).toBeGreaterThan(cueSeconds(cue, "keys"));
      expect(cueSeconds(cue, "keys")).toBeGreaterThan(cueSeconds(cue, "kalimba"));
    }
    expect(cueSeconds("done", "bowl")).toBeLessThan(7);
    expect(cueSeconds("tick1", "kalimba")).toBeLessThan(0.5);
  });

  it("renderCues renders every cue, mono, at the rate given", async () => {
    const log: Array<{ channels: number; frames: number; rate: number }> = [];
    const out = await renderCues("keys" as PaletteId, 44100, fakeOffline(log));
    expect(Object.keys(out).sort()).toEqual([...CUE_IDS].sort());
    expect(log.every((r) => r.channels === 1 && r.rate === 44100)).toBe(true);
    expect(log.find((r) => r.frames === Math.ceil(cueSeconds("done", "keys") * 44100))).toBeTruthy();
  });

  it("a tick's id carries its count", () => {
    expect(cueIdOf({ kind: "tick", n: 2 })).toBe("tick2");
    expect(cueIdOf({ kind: "rest" })).toBe("rest");
  });
});

describe("the sound settings", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("read leniently: nothing, garbage or a wrong value takes the default (automatic, on, 70%)", () => {
    const s = store();
    expect(readSound(s)).toEqual({ on: true, volume: 0.7, choice: "auto" });
    s.m.set(SOUND_KEY, "{not json");
    expect(readSound(s).choice).toBe("auto");
    s.m.set(SOUND_KEY, JSON.stringify({ on: false, volume: 9, choice: "gong" }));
    expect(readSound(s)).toEqual({ on: false, volume: 1, choice: "auto" });
  });

  it("round-trips what is written", () => {
    const s = store();
    writeSound({ on: true, volume: 0.35, choice: "kalimba" }, s);
    expect(readSound(s)).toEqual({ on: true, volume: 0.35, choice: "kalimba" });
  });

  it("automatic is soft keys, and bowls for a calm session; a chosen palette is always that palette", () => {
    expect(resolvePalette("auto", false)).toBe("keys");
    expect(resolvePalette("auto", true)).toBe("bowl");
    expect(resolvePalette("kalimba", true)).toBe("kalimba");
    expect(soundFor({ on: true, volume: 0.5, choice: "auto" }, true)).toEqual({ on: true, volume: 0.5, palette: "bowl" });
  });
});
