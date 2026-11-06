import type { Chapter, SaveErrorCode, Segment } from "@rg/saves";
import type { KvStore } from "./queue.js";
import {
  captureSegments, chaptersFromDescription, chaptersFromMarkers, panelSegments, parsePlayer, pickCapture, pickTrack, PLAYER_DIDNT_LOAD,
  watchUrl, type CaptionTrack, type YoutubeMeta,
} from "./youtube.js";

// READING A YOUTUBE VIDEO IN THE OWNER'S SESSION (design 2026-11-05 §5.2). A background tab on the watch page; scripts
// in the page's MAIN world (the player's own objects live there) hand over what the page holds, and youtube.ts parses
// it. The captions: fetching a track's link returns nothing (it needs the player's token), so the page's XMLHttpRequest
// and fetch are wrapped BEFORE the player is asked to show captions, and the player's own answer is kept (the live
// spike, 2026-11-05). Fallback: the transcript panel. The tab is always closed; the whole read is capped.

/** The browser's tabs and scripts, behind a seam so the read can be tested without Chrome. */
export interface YoutubeTabs {
  /** Opens a background tab on `url`; resolves with its id at once (final audit G15: it is muted before it loads). */
  open(url: string): Promise<number>;
  mute(id: number): Promise<void>;
  /** Resolves once the tab has loaded, or after a load wait. */
  loaded(id: number): Promise<void>;
  /** Runs a self-contained function in the tab's page; its result, or null when the page gave none. */
  run<A extends unknown[], R>(id: number, func: (...args: A) => R | Promise<R>, args: A, world: "MAIN" | "ISOLATED"): Promise<R | null>;
  close(id: number): Promise<void>;
}

export interface YoutubeReadDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The whole read's cap (60 s). */
  capMs?: number;
}

export type YoutubeRead =
  | {
      ok: true;
      meta: YoutubeMeta;
      transcript: { track: CaptionTrack; segments: Segment[]; via: "captured" | "panel" } | null;
      chapters: { list: Chapter[]; from: "player" | "description" | null };
      ms: number;
    }
  | { ok: false; code: SaveErrorCode; message: string };

export const READ_CAP_MS = 60_000;
const PLAYER_WAIT_MS = 20_000;
const CAPTIONS_WAIT_MS = 15_000;
const PANEL_WAIT_MS = 10_000;
const POLL_MS = 500;
const TOO_LONG: YoutubeRead = { ok: false, code: "unknown", message: "YouTube took too long" };

/** Read one video: its details, chapters and transcript, or why not, in plain words. The tab is closed whatever happens. */
export async function readYoutube(tabs: YoutubeTabs, id: string, deps: YoutubeReadDeps): Promise<YoutubeRead> {
  const cap = deps.capMs ?? READ_CAP_MS;
  const started = deps.now();
  const left = () => cap - (deps.now() - started);
  let tab: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<YoutubeRead> => {
    tab = await tabs.open(watchUrl(id));
    // Muted at once, before its page loads; the load wait is inside the cap (final audit G15).
    await tabs.mute(tab);
    await tabs.loaded(tab);
    // The capture first: the player's captions request must find the wrappers already in place. Only this video's.
    await tabs.run(tab, installCaptionCapture, [id], "MAIN");

    let meta: YoutubeMeta | null = null;
    let markers: string | null = null;
    const playerUntil = Math.min(PLAYER_WAIT_MS, left());
    for (let waited = 0; ; waited += POLL_MS) {
      const page = await tabs.run(tab, readPlayerInPage, [], "MAIN");
      const read = parsePlayer(page?.player ?? null, id);
      if (read.ok) {
        meta = read.meta;
        markers = page?.markers ?? null;
        break;
      }
      // A player that says why it won't play is the answer; one not there yet (or on another video) is waited for.
      if (read.code !== "unknown") return read;
      if (waited + POLL_MS > playerUntil || left() <= POLL_MS) return { ok: false, code: "unknown", message: PLAYER_DIDNT_LOAD };
      await deps.sleep(POLL_MS);
    }

    const fromBar = chaptersFromMarkers(markers);
    const fromText = fromBar.length ? [] : chaptersFromDescription(meta.description);
    const chapters = { list: fromBar.length ? fromBar : fromText, from: fromBar.length ? ("player" as const) : fromText.length ? ("description" as const) : null };

    let transcript: Extract<YoutubeRead, { ok: true }>["transcript"] = null;
    const track = pickTrack(meta.tracks);
    if (track && left() > 0) {
      const captures = (await tabs.run(tab, captionsInPage, [track.languageCode, track.kind, Math.min(CAPTIONS_WAIT_MS, left())], "MAIN")) ?? [];
      const text = pickCapture(captures, track, id);
      const segments = text ? captureSegments(text) : [];
      if (segments.length) transcript = { track, segments, via: "captured" };
      else if (left() > 0) {
        const rows = (await tabs.run(tab, transcriptPanelInPage, [Math.min(PANEL_WAIT_MS, left())], "MAIN")) ?? [];
        const panel = panelSegments(rows);
        if (panel.length) transcript = { track, segments: panel, via: "panel" };
      }
    }
    return { ok: true, meta, transcript, chapters, ms: deps.now() - started };
  };
  try {
    return await Promise.race([work(), new Promise<YoutubeRead>((resolve) => (timer = setTimeout(() => resolve(TOO_LONG), cap)))]);
  } catch {
    return { ok: false, code: "unknown", message: "The YouTube tab closed" };
  } finally {
    clearTimeout(timer);
    if (tab !== null) await tabs.close(tab).catch(() => undefined);
  }
}

// --- Page scripts. Each runs INSIDE the YouTube tab from its own source (chrome.scripting), so it may use only its
// arguments and the page's globals — never anything else from this module.

/**
 * Wraps XMLHttpRequest and fetch so each `/api/timedtext` answer the player gets for `videoId` is kept in
 * `window.__rgCaptured` — never an ad's or the next video's (final audit G14).
 */
export function installCaptionCapture(videoId: string): void {
  const w = window as unknown as { __rgCaptured?: { url: string; text: string }[] };
  if (w.__rgCaptured) return;
  const kept: { url: string; text: string }[] = [];
  w.__rgCaptured = kept;
  const keep = (url: string, text: string) => {
    if (url.indexOf("/api/timedtext") < 0 || !text) return;
    let v: string | null = null;
    try {
      v = new URL(url, location.href).searchParams.get("v");
    } catch {
      v = null;
    }
    if (v === videoId) kept.push({ url, text });
  };
  const proto = XMLHttpRequest.prototype as unknown as {
    open: (this: XMLHttpRequest & { __rgUrl?: string }, ...a: unknown[]) => void;
    send: (this: XMLHttpRequest, ...a: unknown[]) => void;
  };
  const open = proto.open;
  const send = proto.send;
  proto.open = function (...a: unknown[]) {
    this.__rgUrl = String(a[1] ?? "");
    return open.apply(this, a);
  };
  proto.send = function (...a: unknown[]) {
    const xhr = this as XMLHttpRequest & { __rgUrl?: string };
    xhr.addEventListener("load", () => {
      try {
        const body = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : typeof xhr.response === "string" ? xhr.response : "";
        keep(xhr.__rgUrl ?? xhr.responseURL ?? "", body);
      } catch {
        // an answer that can't be read as text is no transcript
      }
    });
    return send.apply(this, a);
  };
  const original = window.fetch;
  window.fetch = async function (this: unknown, ...a: Parameters<typeof fetch>) {
    const res = await original.apply(this, a);
    try {
      const input = a[0] as unknown;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : ((input as { url?: string })?.url ?? "");
      if (url.indexOf("/api/timedtext") >= 0) res.clone().text().then((t) => keep(url, t), () => undefined);
    } catch {
      // the page's own request is untouched
    }
    return res;
  } as typeof fetch;
}

/** The player's response (only the parts the read needs, as JSON) and the player bar's chapter markers. */
export function readPlayerInPage(): { player: string | null; markers: string | null } {
  try {
    const p = document.querySelector("#movie_player") as unknown as { getPlayerResponse?: () => Record<string, unknown> } | null;
    const pr = p && typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null;
    const data = (window as unknown as { ytInitialData?: Record<string, any> }).ytInitialData;
    const markers = data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
      ?.multiMarkersPlayerBarRenderer?.markersMap;
    return {
      player: pr ? JSON.stringify({ videoDetails: pr.videoDetails, microformat: pr.microformat, playabilityStatus: pr.playabilityStatus, captions: pr.captions }) : null,
      markers: markers ? JSON.stringify(markers) : null,
    };
  } catch {
    return { player: null, markers: null };
  }
}

/**
 * Asks the player to show a track's captions (muted: the module, the track, the subtitles button off and on, a moment
 * of play), waits for a captured answer, and hands over what was captured.
 */
export async function captionsInPage(languageCode: string, kind: string | null, waitMs: number): Promise<{ url: string; text: string }[]> {
  const w = window as unknown as { __rgCaptured?: { url: string; text: string }[] };
  const player = document.querySelector("#movie_player") as unknown as Record<string, unknown> | null;
  const call = (name: string, ...args: unknown[]) => {
    try {
      const f = player?.[name];
      if (typeof f === "function") f.apply(player, args);
    } catch {
      // the player's own trouble: the next step may still work
    }
  };
  call("mute");
  call("loadModule", "captions");
  call("setOption", "captions", "track", kind ? { languageCode, kind } : { languageCode });
  const button = document.querySelector(".ytp-subtitles-button") as HTMLElement | null;
  if (button) {
    if (button.getAttribute("aria-pressed") === "true") button.click();
    button.click();
  }
  call("seekTo", 1, true);
  call("playVideo");
  const until = Date.now() + waitMs;
  const has = () => (w.__rgCaptured ?? []).some((c) => c.text.trim().length > 0);
  while (Date.now() < until && !has()) await new Promise((r) => setTimeout(r, 250));
  call("pauseVideo");
  return (w.__rgCaptured ?? []).slice(-10);
}

/** Opens the description's transcript panel and hands over its rows: each one's clock and words. */
export async function transcriptPanelInPage(waitMs: number): Promise<{ time: string; text: string }[]> {
  const read = () =>
    Array.from(document.querySelectorAll("ytd-transcript-segment-renderer")).map((el) => ({
      time: (el.querySelector(".segment-timestamp")?.textContent ?? "").trim(),
      text: (el.querySelector(".segment-text")?.textContent ?? "").trim(),
    }));
  if (read().length === 0) {
    (document.querySelector("#description-inline-expander #expand, tp-yt-paper-button#expand") as HTMLElement | null)?.click();
    (document.querySelector("ytd-video-description-transcript-section-renderer button") as HTMLElement | null)?.click();
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until && read().length === 0) await new Promise((r) => setTimeout(r, 300));
  return read();
}

// --- The real browser.

const LOAD_WAIT_MS = 20_000;

/** Resolves once the tab has loaded, or after LOAD_WAIT_MS (the player is looked for either way). */
function loaded(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, LOAD_WAIT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(), done);
  });
}

/** Where the reader's open tabs are kept, so one a dead read left (a killed service worker) is closed at startup. */
const READER_TABS = "readerTabs";

/** Close the tabs a dead read left open (the extension's start), and forget them (final audit G15). */
export async function closeLeftoverTabs(store: KvStore, closeTab: (id: number) => Promise<void>): Promise<void> {
  const raw = await store.get(READER_TABS);
  const ids = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  for (const id of ids) await closeTab(id).catch(() => undefined);
  await store.set(READER_TABS, []);
}

async function remember(store: KvStore, id: number, keep: boolean): Promise<void> {
  const raw = await store.get(READER_TABS);
  const ids = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number" && x !== id) : [];
  await store.set(READER_TABS, keep ? [...ids, id] : ids);
}

export function chromeYoutubeTabs(store: KvStore): YoutubeTabs {
  return {
    async open(url) {
      const created = await chrome.tabs.create({ url, active: false });
      if (created.id === undefined) throw new Error("Could not open a YouTube tab");
      await remember(store, created.id, true);
      return created.id;
    },
    async mute(id) {
      await chrome.tabs.update(id, { muted: true }).catch(() => undefined);
    },
    loaded(id) {
      return loaded(id);
    },
    async run(id, func, args, world) {
      const [first] = await chrome.scripting.executeScript({ target: { tabId: id }, world, func: func as never, args: args as never });
      return (first?.result ?? null) as never;
    },
    async close(id) {
      await remember(store, id, false);
      await chrome.tabs.remove(id);
    },
  };
}
