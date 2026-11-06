import { describe, expect, it } from "vitest";
import {
  captionsInPage, closeLeftoverTabs, installCaptionCapture, readPlayerInPage, readYoutube, transcriptPanelInPage, type YoutubeTabs,
} from "../src/youtube-reader.js";
import { memoryStore } from "./fixtures.js";

// The page reader's order and bounds, against a fake browser: real YouTube can't run in a test (every parser it uses is
// tested in youtube.test.ts). Synthetic answers; a fake video id built here.
const vid = ["Zx", "9_-Qa", "B3cD"].join("");
const playerJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    videoDetails: { videoId: vid, title: "Zorbex hip flow", lengthSeconds: "98", shortDescription: "0:00 a\n0:30 b\n1:00 c", author: "Zorbex Coach", channelId: "UCz" },
    playabilityStatus: { status: "OK" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", name: { simpleText: "English" } }] } },
    ...over,
  });
const json3 = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "zorbex one" }] }, { tStartMs: 4_000, segs: [{ utf8: "zorbex two" }] }] });

interface Script {
  player?: () => { player: string | null; markers: string | null };
  captions?: () => { url: string; text: string }[];
  panel?: () => { time: string; text: string }[];
  hang?: boolean;
  /** The page never finishes loading. */
  hangLoad?: boolean;
}

function fakeTabs(script: Script) {
  const calls: string[] = [];
  let clock = 0;
  const tabs: YoutubeTabs = {
    async open(url) {
      calls.push(`open ${url}`);
      return 7;
    },
    async mute() {
      calls.push("mute");
    },
    async loaded() {
      calls.push("loaded");
      if (script.hangLoad) await new Promise(() => undefined);
    },
    async run(_id, func, args, world) {
      const f = func as unknown;
      const name =
        f === installCaptionCapture ? "capture" : f === readPlayerInPage ? "player" : f === captionsInPage ? "captions" : f === transcriptPanelInPage ? "panel" : "other";
      calls.push(`${name}:${world}${name === "capture" ? `:${(args as unknown[])[0]}` : ""}`);
      if (script.hang && name === "player") return new Promise(() => undefined) as never;
      if (name === "player") return (script.player?.() ?? { player: playerJson(), markers: null }) as never;
      if (name === "captions") return (script.captions?.() ?? []) as never;
      if (name === "panel") return (script.panel?.() ?? []) as never;
      return null as never;
    },
    async close(id) {
      calls.push(`close ${id}`);
    },
  };
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    capMs: 60_000,
  };
  return { tabs, calls, deps };
}

describe("readYoutube", () => {
  it("installs the capture in the page before asking the player for captions, reads them, and closes the tab", async () => {
    const { tabs, calls, deps } = fakeTabs({ captions: () => [{ url: `/api/timedtext?v=${vid}&lang=en&kind=asr&fmt=json3`, text: json3 }] });
    const out = await readYoutube(tabs, vid, deps);
    expect(out).toMatchObject({
      ok: true,
      meta: { id: vid, title: "Zorbex hip flow" },
      transcript: { via: "captured", track: { languageCode: "en", kind: "asr" }, segments: [[0, "zorbex one"], [4, "zorbex two"]] },
      chapters: { from: "description", list: [{ start: 0, title: "a" }, { start: 30, title: "b" }, { start: 60, title: "c" }] },
    });
    expect(calls.indexOf(`capture:MAIN:${vid}`)).toBeGreaterThan(-1);
    expect(calls.indexOf(`capture:MAIN:${vid}`)).toBeLessThan(calls.indexOf("captions:MAIN"));
    expect(calls[0]).toMatch(/^open .*watch\?v=/);
    expect(calls.at(-1)).toBe("close 7");
    expect(calls).toContain("mute");
  });

  it("nothing captured: the transcript panel, read from the page", async () => {
    const { tabs, calls, deps } = fakeTabs({ panel: () => [{ time: "0:01", text: "from the panel" }] });
    const out = await readYoutube(tabs, vid, deps);
    expect(out).toMatchObject({ ok: true, transcript: { via: "panel", segments: [[1, "from the panel"]] } });
    expect(calls).toContain("panel:MAIN");
  });

  it("neither: no transcript, which is not a failure (the reader may still watch it)", async () => {
    const { tabs, deps } = fakeTabs({});
    expect(await readYoutube(tabs, vid, deps)).toMatchObject({ ok: true, transcript: null });
  });

  it("a video with no caption tracks asks for none", async () => {
    const { tabs, calls, deps } = fakeTabs({ player: () => ({ player: playerJson({ captions: undefined }), markers: null }) });
    expect(await readYoutube(tabs, vid, deps)).toMatchObject({ ok: true, transcript: null });
    expect(calls.some((c) => c.startsWith("captions"))).toBe(false);
  });

  it("the player bar's chapters come first", async () => {
    const markers = JSON.stringify([{ key: "DESCRIPTION_CHAPTERS", value: { chapters: [{ chapterRenderer: { title: { simpleText: "Bar" }, timeRangeStartMillis: 0 } }] } }]);
    const { tabs, deps } = fakeTabs({ player: () => ({ player: playerJson(), markers }) });
    expect(await readYoutube(tabs, vid, deps)).toMatchObject({ ok: true, chapters: { from: "player", list: [{ start: 0, title: "Bar" }] } });
  });

  it("a video YouTube won't play fails in its words, and the tab is closed", async () => {
    const { tabs, calls, deps } = fakeTabs({ player: () => ({ player: playerJson({ playabilityStatus: { status: "AGE_CHECK_REQUIRED" } }), markers: null }) });
    expect(await readYoutube(tabs, vid, deps)).toEqual({ ok: false, code: "unplayable", message: "Age-restricted" });
    expect(calls.at(-1)).toBe("close 7");
  });

  it("a player that never shows the video: 'The player didn't load', within the cap", async () => {
    const { tabs, calls, deps } = fakeTabs({ player: () => ({ player: null, markers: null }) });
    const out = await readYoutube(tabs, vid, deps);
    expect(out).toEqual({ ok: false, code: "unknown", message: "The player didn't load" });
    expect(deps.now()).toBeLessThanOrEqual(60_000);
    expect(calls.at(-1)).toBe("close 7");
  });

  it("a page that never answers ends at the cap, the tab closed", async () => {
    const { tabs, calls } = fakeTabs({ hang: true });
    const out = await readYoutube(tabs, vid, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), capMs: 50 });
    expect(out).toEqual({ ok: false, code: "unknown", message: "YouTube took too long" });
    expect(calls.at(-1)).toBe("close 7");
  });
});

describe("the page scripts are self-contained (they run in the page, from their source)", () => {
  it.each([installCaptionCapture, readPlayerInPage, captionsInPage, transcriptPanelInPage])("%o names nothing of this module", (fn) => {
    const src = fn.toString();
    expect(src).not.toMatch(/\bimport\(|\brequire\(|\b__vite|\bparsePlayer\b|\bpickTrack\b|\bYT_ORIGIN\b/);
  });
});

describe("the reader tab and its captions (final audit G14, G15)", () => {
  it("the capture keeps only this video's captions; the tab is muted at once, before its page loads", async () => {
    const { tabs, calls, deps } = fakeTabs({});
    await readYoutube(tabs, vid, deps);
    expect(calls).toContain(`capture:MAIN:${vid}`);
    expect(calls.indexOf("mute")).toBeLessThan(calls.indexOf("loaded"));
  });

  it("a page that never loads still ends at the cap with its tab closed", async () => {
    const { tabs, calls } = fakeTabs({ hangLoad: true });
    const out = await readYoutube(tabs, vid, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), capMs: 50 });
    expect(out).toEqual({ ok: false, code: "unknown", message: "YouTube took too long" });
    expect(calls.at(-1)).toBe("close 7");
  });

  it("tabs a dead read left open are closed when the extension starts", async () => {
    const store = memoryStore();
    await store.set("readerTabs", [11, 12]);
    const closed: number[] = [];
    await closeLeftoverTabs(store, async (id) => {
      closed.push(id);
    });
    expect(closed).toEqual([11, 12]);
    expect(await store.get("readerTabs")).toEqual([]);
  });
});
