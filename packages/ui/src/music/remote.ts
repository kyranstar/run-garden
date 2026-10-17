/**
 * Playing a shortcut on a Spotify Connect device (the music dock, 2026-10-17).
 *
 * Spotify says the order of separate player calls is not guaranteed, so each waits for the last one's answer: shuffle
 * on, then the play — from a random position inside the context's count when Spotify will say it (an album, or a
 * playlist the athlete owns), so a shuffle doesn't always open on track one. A device that refuses the shuffle before
 * anything plays on it (an idle phone) gets it right after the play.
 *
 * No device listed (on iOS a backgrounded Spotify app often drops off the list): the shortcut's open.spotify.com link
 * is opened — on a phone that opens the Spotify app — and the play waits; when the app is visible again it is tried
 * against the device that is listed by then, a few times over a few seconds, and never opens the link a second time.
 */
import type { MusicShortcut } from "@rg/domain";
import { openUrlOf } from "./links.js";
import { isNoDevice, SpotifyError, type Device, type Spotify } from "./spotify.js";

/** The kind of device this app runs on: its own is the one to prefer when none is active. */
export type DeviceKind = "Smartphone" | "Computer";

export function chooseDevice(devices: Device[], prefer: DeviceKind): (Device & { id: string }) | null {
  const usable = devices.filter((d): d is Device & { id: string } => typeof d.id === "string" && !!d.id && !d.is_restricted);
  return usable.find((d) => d.is_active) ?? usable.find((d) => d.type === prefer) ?? usable[0] ?? null;
}

export type PlayOutcome = { kind: "playing"; device: Device & { id: string } } | { kind: "no_device"; openUrl: string };

/** A device refusing a shuffle because nothing plays on it yet: NO_ACTIVE_DEVICE, or a restriction. */
const refusedBeforePlay = (e: unknown): boolean => isNoDevice(e) || (e instanceof SpotifyError && e.status === 403);

export async function playContext(
  spotify: Spotify,
  target: { uri: string; shuffle: boolean },
  opts: { prefer: DeviceKind; random: () => number },
): Promise<PlayOutcome> {
  const [devices, count] = await Promise.all([spotify.devices(), target.shuffle ? spotify.count(target.uri) : Promise.resolve(null)]);
  const device = chooseDevice(devices, opts.prefer);
  if (!device) return { kind: "no_device", openUrl: openUrlOf(target.uri) };
  const position = target.shuffle && count !== null && count > 1 ? Math.min(count - 1, Math.floor(opts.random() * count)) : undefined;
  try {
    if (target.shuffle) {
      let shuffled = true;
      try {
        await spotify.shuffle(true, device.id);
      } catch (e) {
        if (!refusedBeforePlay(e)) throw e;
        shuffled = false;
      }
      await spotify.play({ contextUri: target.uri, deviceId: device.id, ...(position !== undefined ? { position } : {}) });
      if (!shuffled) await spotify.shuffle(true, device.id);
    } else {
      await spotify.play({ contextUri: target.uri, deviceId: device.id });
    }
  } catch (e) {
    if (isNoDevice(e)) return { kind: "no_device", openUrl: openUrlOf(target.uri) };
    throw e;
  }
  return { kind: "playing", device };
}

export type RemoteResult =
  | { kind: "playing"; device: Device & { id: string } }
  /** The link opened (the Spotify app, on a phone): the play waits for the app to be visible again. */
  | { kind: "opened"; openUrl: string }
  /** The browser wouldn't open it unasked: the dock shows it to be tapped. The play waits all the same. */
  | { kind: "blocked"; openUrl: string }
  /** Back, and still no device after looking a few times. */
  | { kind: "waiting"; openUrl: string };

export interface RemoteDeps {
  spotify: Spotify;
  prefer: () => DeviceKind;
  random: () => number;
  /** Open a link in a new context; false when the browser refused. */
  openLink: (url: string) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** When to look again after the app is visible (ms from then): Spotify takes a moment to list a device. */
  retryDelaysMs?: number[];
  /** A waiting play is forgotten after this long. */
  pendingTtlMs?: number;
}

export function makeRemote(deps: RemoteDeps) {
  const delays = deps.retryDelaysMs ?? [0, 1500, 4000];
  const ttl = deps.pendingTtlMs ?? 10 * 60_000;
  let waiting: { shortcut: MusicShortcut; at: number } | null = null;

  const attempt = (shortcut: MusicShortcut) => playContext(deps.spotify, shortcut, { prefer: deps.prefer(), random: deps.random });
  const pending = (): MusicShortcut | null => (waiting && deps.now() - waiting.at <= ttl ? waiting.shortcut : null);

  function fallBack(shortcut: MusicShortcut): RemoteResult {
    waiting = { shortcut, at: deps.now() };
    const openUrl = openUrlOf(shortcut.uri);
    return deps.openLink(openUrl) ? { kind: "opened", openUrl } : { kind: "blocked", openUrl };
  }

  return {
    pending,
    cancel: () => {
      waiting = null;
    },
    /**
     * Play a shortcut. `noDevice` (the dock already knows no device is listed) opens the link before anything is
     * awaited, while the tap still counts as the athlete's: a browser opens a new context only inside one.
     */
    async play(shortcut: MusicShortcut, opts: { noDevice?: boolean } = {}): Promise<RemoteResult> {
      if (opts.noDevice) return fallBack(shortcut);
      const out = await attempt(shortcut);
      if (out.kind === "playing") {
        waiting = null;
        return out;
      }
      return fallBack(shortcut);
    },
    /** The app is visible again: a waiting play is tried against the device listed now. */
    async visible(): Promise<RemoteResult | null> {
      const shortcut = pending();
      if (!shortcut) return null;
      for (const delay of delays) {
        if (delay > 0) await deps.sleep(delay);
        if (pending() !== shortcut) return null;
        const out = await attempt(shortcut);
        if (out.kind === "playing") {
          waiting = null;
          return out;
        }
      }
      return { kind: "waiting", openUrl: openUrlOf(shortcut.uri) };
    },
  };
}

export type Remote = ReturnType<typeof makeRemote>;
