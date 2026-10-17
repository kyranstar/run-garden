/**
 * THE SESSION'S SOUNDS: three palettes of cues, synthesised (no audio files, nothing to license or cache).
 *
 * Each palette is a voice: a recipe of partials with their own envelopes, so a note has a timbre rather than a bare
 * sine. Each cue is a few notes in the key of D: the countdown's ticks climb E–F#–A into a D chord on "go", a side
 * switch is a rising fourth, a rest settles on a low G major 7, and the end resolves on a slow D major 9.
 *
 * The cues are rendered once, dry and mono, into buffers (`renderCues`, an OfflineAudioContext per cue), and the live
 * graph adds the room: a generated stereo reverb (the width), a gentle low-pass and a soft compressor (`createRoom`). A
 * session then plays one buffer per cue, so a chord of bowls (dozens of oscillators) costs the phone one buffer source
 * at the moment it plays. A palette's renders hold about 1–5 MB.
 *
 * The listening page the owner chose from built the same voices, notes and room, live.
 */

export type PaletteId = "kalimba" | "bowl" | "keys";
export const PALETTE_IDS: readonly PaletteId[] = ["kalimba", "bowl", "keys"];
export const PALETTE_NAMES: Record<PaletteId, string> = { kalimba: "Kalimba", bowl: "Bowls", keys: "Soft keys" };

/** Every rendered cue. The countdown's three ticks are three pitches. */
export type CueId = "tick3" | "tick2" | "tick1" | "go" | "switch" | "rest" | "next" | "target" | "done";
export const CUE_IDS: readonly CueId[] = ["tick3", "tick2", "tick1", "go", "switch", "rest", "next", "target", "done"];

/** One note of a cue: when (s after the cue starts), which (MIDI), how hard (0–1), how long it rings (× the voice's own decay). */
export interface CueNote {
  at: number;
  midi: number;
  velocity: number;
  length: number;
}

const strum = (notes: readonly number[], gap: number, velocity: number, length: number): CueNote[] =>
  notes.map((midi, i) => ({ at: i * gap, midi, velocity, length }));

export const CUE_NOTES: Record<CueId, readonly CueNote[]> = {
  tick3: [{ at: 0, midi: 76, velocity: 0.3, length: 0.3 }],
  tick2: [{ at: 0, midi: 78, velocity: 0.32, length: 0.3 }],
  tick1: [{ at: 0, midi: 81, velocity: 0.36, length: 0.3 }],
  go: strum([62, 69, 76, 78], 0.022, 0.5, 1.0),
  switch: [
    { at: 0, midi: 69, velocity: 0.42, length: 0.6 },
    { at: 0.14, midi: 74, velocity: 0.48, length: 0.85 },
  ],
  rest: strum([71, 66, 62, 55], 0.05, 0.36, 1.25),
  next: [
    { at: 0, midi: 69, velocity: 0.32, length: 0.7 },
    { at: 0.012, midi: 74, velocity: 0.32, length: 0.7 },
  ],
  target: strum([78, 81, 86], 0.03, 0.3, 0.9),
  done: strum([50, 62, 69, 73, 76, 78, 81], 0.085, 0.42, 1.6),
};

export const midiHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** How long each voice rings for a note of length 1, in seconds (its longest partial's attack and decay). */
const RING_S: Record<PaletteId, number> = { kalimba: 1.26, bowl: 4.62, keys: 1.95 };

/**
 * How long a cue's dry render is: its last note's start plus 80% of that note's ring. The last fifth of an exponential
 * fall to −80 dB is under −64 dB, inaudible under the room's reverb, so it is not kept.
 */
export function cueSeconds(cue: CueId, palette: PaletteId): number {
  let end = 0;
  for (const n of CUE_NOTES[cue]) end = Math.max(end, n.at + 0.8 * RING_S[palette] * n.length);
  return end + 0.02;
}

/** What a voice needs of a context (the live one or an offline one). */
type Ctx = BaseAudioContext;

function partial(c: Ctx, t: number, hz: number, amp: number, attack: number, decay: number, out: AudioNode, type: OscillatorType = "sine"): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, t);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

type Voice = (c: Ctx, t: number, hz: number, velocity: number, length: number, out: AudioNode) => void;

export const VOICES: Record<PaletteId, Voice> = {
  /** A marimba-tuned bar: the fundamental, its 4th and 10th partials, and a quick mallet thock. */
  kalimba(c, t, f, v, len, out) {
    partial(c, t, f, 0.85 * v, 0.004, 1.25 * len, out);
    partial(c, t, f * 3.93, 0.16 * v, 0.003, 0.34 * len, out);
    partial(c, t, f * 9.6, 0.045 * v, 0.002, 0.11 * len, out);
    partial(c, t, f * 2, 0.08 * v, 0.003, 0.08 * len, out, "triangle");
  },
  /** A struck bowl: four inharmonic modes, each a pair of slightly detuned tones that beat slowly, and a soft strike. */
  bowl(c, t, f, v, len, out) {
    const modes: ReadonlyArray<readonly [number, number, number]> = [
      [1, 1, 4.6],
      [2.76, 0.42, 3.0],
      [5.4, 0.2, 1.7],
      [8.93, 0.09, 0.9],
    ];
    for (const [ratio, amp, decay] of modes) {
      const beat = 0.9 * Math.sqrt(ratio);
      partial(c, t, f * ratio + beat / 2, 0.5 * amp * v, 0.014, decay * len, out);
      partial(c, t, f * ratio - beat / 2, 0.5 * amp * v, 0.014, decay * len, out);
    }
    partial(c, t, f * 6.1, 0.04 * v, 0.002, 0.05, out, "triangle");
  },
  /** A two-operator FM electric piano: bright at the touch, mellowing as the modulation index falls. */
  keys(c, t, f, v, len, out) {
    const car = c.createOscillator();
    const mod = c.createOscillator();
    const depth = c.createGain();
    const g = c.createGain();
    car.frequency.setValueAtTime(f, t);
    mod.frequency.setValueAtTime(f, t);
    depth.gain.setValueAtTime(f * 1.5, t);
    depth.gain.exponentialRampToValueAtTime(f * 0.1, t + 0.55 * len + 0.05);
    mod.connect(depth);
    depth.connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9 * len);
    car.connect(g);
    g.connect(out);
    car.start(t);
    mod.start(t);
    car.stop(t + 1.95 * len);
    mod.stop(t + 1.95 * len);
    partial(c, t, f * 4, 0.035 * v, 0.002, 0.22 * len, out);
  },
};

/** Play `cue` in `palette` into `dest` from time `t` (the live context's preview, or an offline render). */
export function voiceCue(c: Ctx, palette: PaletteId, cue: CueId, t: number, dest: AudioNode): void {
  for (const n of CUE_NOTES[cue]) VOICES[palette](c, t + n.at, midiHz(n.midi), n.velocity, n.length, dest);
}

/** Makes an offline context: `new OfflineAudioContext(channels, frames, rate)` in a browser; a fake in tests. */
export type MakeOffline = (channels: number, frames: number, rate: number) => OfflineAudioContext;

export function defaultMakeOffline(): MakeOffline | null {
  const g = globalThis as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  return Ctor ? (channels, frames, rate) => new Ctor(channels, frames, rate) : null;
}

/** Render every cue of `palette`, dry and mono, at `rate`. One offline context per cue; all in parallel. */
export async function renderCues(palette: PaletteId, rate: number, makeOffline: MakeOffline): Promise<Record<CueId, AudioBuffer>> {
  const entries = await Promise.all(
    CUE_IDS.map(async (cue) => {
      const c = makeOffline(1, Math.ceil(cueSeconds(cue, palette) * rate), rate);
      voiceCue(c, palette, cue, 0, c.destination);
      return [cue, await c.startRendering()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<CueId, AudioBuffer>;
}

/** A stereo impulse of a soft room: noise, darkening as it fades, after a short pre-delay. */
export function makeImpulse(c: BaseAudioContext, seconds = 2.8, random: () => number = Math.random): AudioBuffer {
  const rate = c.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.015);
  const buf = c.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = 0.5 - 0.42 * (i / len);
      lp += k * (random() * 2 - 1 - lp);
      d[i] = i < pre ? 0 : lp * (1 - (i - pre) / (len - pre)) ** 2.4;
    }
  }
  return buf;
}

/**
 * The room every cue plays into, on the live context: dry and reverb, a gentle low-pass, a soft compressor, then the
 * volume. Returns the input to play into and the volume to set.
 */
export function createRoom(c: AudioContext): { input: AudioNode; volume: GainNode } {
  const input = c.createGain();
  const dry = c.createGain();
  dry.gain.value = 0.8;
  const wet = c.createGain();
  wet.gain.value = 0.34;
  const verb = c.createConvolver();
  verb.buffer = makeImpulse(c);
  const tone = c.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 6500;
  tone.Q.value = 0.4;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 14;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.3;
  const volume = c.createGain();
  input.connect(dry);
  input.connect(verb);
  verb.connect(wet);
  dry.connect(tone);
  wet.connect(tone);
  tone.connect(comp);
  comp.connect(volume);
  volume.connect(c.destination);
  return { input, volume };
}
