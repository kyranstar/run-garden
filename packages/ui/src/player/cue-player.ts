/**
 * THE CUE PLAYER: the session's sounds on the audio clock (spec §2b "Player"; the spike report
 * docs/reports/2026-10-07-offline-spike.md, "Audio, 30 minutes"; Task 13's sound pass, 2026-10-17).
 *
 *  - Audio is unlocked inside a tap (`unlock`): WebKit keeps a context made at any other time suspended. Nothing is
 *    made before then. The tap also asks the page's audio session to be "ambient", so the cues mix over the athlete's
 *    music (Spotify keeps playing) and follow the ring/silent switch, and it renders the palette's cues.
 *  - Cues are rendered once per palette (`sound-palettes.ts`) and each one plays as a single buffer source.
 *  - Each cue is placed from its WALL-CLOCK due time when it is scheduled: `currentTime + (dueAt − now) / 1000`. The
 *    spike saw the audio clock stall and fall 2 s behind once; an offset taken at Start would carry that drift.
 *  - Scheduling replaces what was scheduled (a pause, a skip, a step change); a cue already due is not played late.
 *    Cues more than `WINDOW_MS` ahead are left for a later schedule (the caller schedules again at each step).
 *  - A cue list given before the renders are ready, or while the context is suspended or interrupted (a call, Siri),
 *    is kept and placed again, from the wall clock, once both are ready.
 */
import { CUE_IDS, PALETTE_IDS, createRoom, defaultMakeOffline, renderCues, voiceCue, type CueId, type MakeOffline, type PaletteId } from "./sound-palettes.js";

export type CueKind = "tick" | "go" | "switch" | "rest" | "next" | "target" | "done";

/** One cue at an epoch-ms time. A tick carries its count (3, 2, 1), which is its pitch. */
export interface Cue {
  at: number;
  kind: CueKind;
  n?: 1 | 2 | 3;
}

export interface SoundSettings {
  on: boolean;
  /** 0–1. */
  volume: number;
  palette: PaletteId;
}

export interface CuePlayer {
  /** In a tap: make or resume the audio context, and render the palette's cues. */
  unlock(): void;
  /** Replace what is scheduled with these cues. */
  schedule(cues: readonly Cue[]): void;
  cancel(): void;
  configure(settings: SoundSettings): void;
  /** In a tap: play one cue (or the countdown into "go") now, in `palette` or the configured one. */
  preview(cue: CueKind | "count", palette?: PaletteId): void;
}

/** Cues further ahead than this are placed by a later schedule. */
export const WINDOW_MS = 120_000;

export const cueIdOf = (cue: Pick<Cue, "kind" | "n">): CueId => (cue.kind === "tick" ? (`tick${cue.n ?? 1}` as CueId) : cue.kind);

/** What the cue player uses of the platform (a test hands in fakes). */
export interface CuePlayerDeps {
  makeContext(): AudioContext | null;
  makeOffline: MakeOffline | null;
  /** Ask for an "ambient" audio session (Safari 16.4+); a no-op elsewhere. */
  ambientSession(): void;
  now(): number;
}

function defaultDeps(): CuePlayerDeps {
  return {
    makeContext() {
      const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = g.AudioContext ?? g.webkitAudioContext;
      return Ctor ? new Ctor() : null;
    },
    makeOffline: defaultMakeOffline(),
    ambientSession() {
      const session = (globalThis.navigator as { audioSession?: { type: string } } | undefined)?.audioSession;
      try {
        if (session && session.type !== "ambient") session.type = "ambient";
      } catch {
        // an older Safari: the default session already mixes Web Audio
      }
    },
    now: () => Date.now(),
  };
}

/** Soft keys unless a calm session asks for bowls (the owner's choice by ear, 2026-10-17; `resolvePalette`). */
export const DEFAULT_SOUND: SoundSettings = { on: true, volume: 0.7, palette: "keys" };

export function createCuePlayer(deps: CuePlayerDeps = defaultDeps()): CuePlayer {
  let ctx: AudioContext | null = null;
  let room: { input: AudioNode; volume: GainNode } | null = null;
  let settings: SoundSettings = { ...DEFAULT_SOUND };
  const rendered = new Map<PaletteId, Record<CueId, AudioBuffer>>();
  const rendering = new Map<PaletteId, Promise<void>>();
  let wanted: readonly Cue[] = [];
  let playing: AudioBufferSourceNode[] = [];

  const running = () => ctx !== null && ctx.state === "running";

  const stopAll = () => {
    for (const s of playing) {
      try {
        s.stop(0);
        s.disconnect();
      } catch {
        // already stopped
      }
    }
    playing = [];
  };

  const render = (palette: PaletteId): void => {
    if (!ctx || !deps.makeOffline || rendered.has(palette) || rendering.has(palette)) return;
    const job = renderCues(palette, ctx.sampleRate, deps.makeOffline)
      .then((buffers) => {
        rendered.set(palette, buffers);
        if (palette === settings.palette) place();
      })
      .catch(() => undefined)
      .finally(() => rendering.delete(palette));
    rendering.set(palette, job);
  };

  /** Place `wanted` from the wall clock, if the context runs and the palette is rendered. */
  const place = (): void => {
    stopAll();
    const buffers = rendered.get(settings.palette);
    if (!ctx || !room || !buffers || !running() || !settings.on) return;
    const now = deps.now();
    for (const cue of wanted) {
      if (cue.at < now || cue.at - now > WINDOW_MS) continue;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buffers[cueIdOf(cue)];
        src.connect(room.input);
        src.start(ctx.currentTime + (cue.at - now) / 1000);
        playing.push(src);
      } catch {
        // a closed context: no cue
      }
    }
  };

  const setVolume = () => {
    if (ctx && room) room.volume.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.03);
  };

  const unlock = (): void => {
    try {
      deps.ambientSession();
      if (!ctx) {
        ctx = deps.makeContext();
        if (!ctx) return;
        room = createRoom(ctx);
        room.volume.gain.value = settings.volume;
        // Back from a suspension or an interruption (a call, Siri): place the cues again from the wall clock.
        ctx.onstatechange = () => {
          if (running()) place();
        };
      }
      const state = ctx.state as string;
      if (state === "suspended" || state === "interrupted") void ctx.resume().catch(() => undefined);
      render(settings.palette);
    } catch {
      ctx = null;
      room = null;
    }
  };

  return {
    unlock,
    schedule(cues) {
      wanted = cues;
      place();
    },
    cancel() {
      wanted = [];
      stopAll();
    },
    configure(next) {
      const palette = PALETTE_IDS.includes(next.palette) ? next.palette : DEFAULT_SOUND.palette;
      const volume = Math.min(1, Math.max(0, Number.isFinite(next.volume) ? next.volume : DEFAULT_SOUND.volume));
      const changedPalette = palette !== settings.palette;
      settings = { on: next.on !== false, volume, palette };
      setVolume();
      if (changedPalette) render(palette);
      place();
    },
    preview(cue, palette) {
      unlock();
      if (!ctx || !room) return;
      const which = palette ?? settings.palette;
      const t = ctx.currentTime + 0.05;
      const play = (id: CueId, at: number) => {
        const buffers = rendered.get(which);
        if (buffers) {
          const src = ctx!.createBufferSource();
          src.buffer = buffers[id];
          src.connect(room!.input);
          src.start(at);
        } else {
          // Not rendered yet (the first tap): voice it live, once.
          voiceCue(ctx!, which, id, at, room!.input);
        }
      };
      if (cue === "count") {
        play("tick3", t);
        play("tick2", t + 1);
        play("tick1", t + 2);
        play("go", t + 3);
      } else {
        play(cue === "tick" ? "tick1" : cue, t);
      }
      render(which);
    },
  };
}

/** Every cue id a palette renders (for tests and the settings' preview list). */
export const ALL_CUES: readonly CueId[] = CUE_IDS;

/** The app's cue player: one context for the page, unlocked by Start (or the first tap after a reload). */
export const cuePlayer = createCuePlayer();
