import { describe, expect, it } from "vitest";
import { postSubmitSchema } from "@rg/saves";
import {
  chaptersFromDescription, chaptersFromMarkers, captureSegments, panelSegments, parsePlayer, pickCapture, pickTrack, toYoutubeSubmit, watchUrl,
  type CaptionTrack,
} from "../src/youtube.js";

// Synthetic player answers: a made-up channel, a fake video id built here (the privacy grep never sees a real one).
const vid = ["Zx", "9_-Qa", "B3cD"].join("");
const profile = ["ht", "tp://www.", "you", "tube.com/@zorbexcoach"].join("");
const player = (over: Record<string, unknown> = {}) => ({
  videoDetails: {
    videoId: vid, title: "Zorbex hip flow", lengthSeconds: "754", shortDescription: "A flow.\n0:00 Intro\n1:00 Flow\n5:00 Cool-down",
    author: "Zorbex Coach", channelId: "UCzorbex", isLiveContent: false,
  },
  microformat: { playerMicroformatRenderer: { ownerProfileUrl: profile, publishDate: "2026-11-01", category: "Sports" } },
  playabilityStatus: { status: "OK" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { languageCode: "en", kind: "asr", name: { simpleText: "English (auto-generated)" }, baseUrl: "x?exp=1" },
        { languageCode: "de", name: { simpleText: "German" }, baseUrl: "y" },
        { languageCode: "en-GB", name: { runs: [{ text: "English (UK)" }] }, baseUrl: "z" },
      ],
    },
  },
  ...over,
});

describe("parsePlayer", () => {
  it("reads the video's details, its channel and its caption tracks", () => {
    const out = parsePlayer(JSON.stringify(player()), vid);
    expect(out).toEqual({
      ok: true,
      meta: {
        id: vid, title: "Zorbex hip flow", channel: { handle: "@zorbexcoach", name: "Zorbex Coach" }, lengthSec: 754,
        description: "A flow.\n0:00 Intro\n1:00 Flow\n5:00 Cool-down", publishedAt: "2026-11-01", live: false,
        tracks: [
          { languageCode: "en", kind: "asr", name: "English (auto-generated)" },
          { languageCode: "de", kind: null, name: "German" },
          { languageCode: "en-GB", kind: null, name: "English (UK)" },
        ],
      },
    });
  });

  it("the channel id stands in for a handle it can't find; no captions is no tracks, not a failure", () => {
    const out = parsePlayer({ ...player({ captions: undefined }), microformat: {} }, vid);
    expect(out).toMatchObject({ ok: true, meta: { channel: { handle: "UCzorbex", name: "Zorbex Coach" }, tracks: [] } });
  });

  it.each([
    [{ status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }, "unplayable", "Age-restricted"],
    // A bot check passes: tried again later, never marked gone (final audit G9) — coded so the health row reads it as the
    // whole stage's, with what to do (audit 2026-11-06, I3).
    [{ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" }, "youtube_login", "Sign in to YouTube in Chrome"],
    [{ status: "AGE_CHECK_REQUIRED" }, "unplayable", "Age-restricted"],
    [{ status: "ERROR", reason: "Video unavailable" }, "gone", "The video is gone"],
    [{ status: "UNPLAYABLE", reason: "The uploader has not made this video available in your country" }, "unplayable", "The uploader has not made this video available in your country"],
    [{ status: "UNPLAYABLE" }, "unplayable", "YouTube won't play it"],
    [{ status: "LIVE_STREAM_OFFLINE", reason: "Premieres soon" }, "unplayable", "Live now — try after it ends"],
  ])("a %o player says so in plain words", (playability, code, message) => {
    expect(parsePlayer(player({ playabilityStatus: playability }), vid)).toEqual({ ok: false, code, message });
  });

  it("a stream that is live now waits; one that ended is read, marked live", () => {
    const live = player();
    (live.videoDetails as Record<string, unknown>).isLive = true;
    expect(parsePlayer(live, vid)).toEqual({ ok: false, code: "unplayable", message: "Live now — try after it ends" });
    const ended = player();
    (ended.videoDetails as Record<string, unknown>).isLiveContent = true;
    expect(parsePlayer(ended, vid)).toMatchObject({ ok: true, meta: { live: true } });
  });

  it("another video, or no player at all, is not this one", () => {
    expect(parsePlayer(player(), "AAAAAAAAAAA")).toEqual({ ok: false, code: "unknown", message: "The player showed another video" });
    expect(parsePlayer(null, vid)).toEqual({ ok: false, code: "unknown", message: "The player didn't load" });
    expect(parsePlayer("not json", vid)).toEqual({ ok: false, code: "unknown", message: "The player didn't load" });
  });
});

describe("pickTrack", () => {
  const t = (languageCode: string, kind: "asr" | null = null): CaptionTrack => ({ languageCode, kind, name: languageCode });
  it("the creator's own track in the video's language (the auto-generated track's), else the auto-generated one", () => {
    expect(pickTrack([t("en", "asr"), t("de"), t("en-GB")])).toEqual(t("en-GB"));
    expect(pickTrack([t("fr", "asr"), t("de")])).toEqual(t("fr", "asr"));
  });
  it("with no auto-generated track, the first uploaded one; none at all, none", () => {
    expect(pickTrack([t("es"), t("en")])).toEqual(t("es"));
    expect(pickTrack([])).toBeNull();
  });
});

describe("pickCapture and captureSegments", () => {
  const json3 = (events: unknown[]) => JSON.stringify({ events });
  it("takes the capture in the track's language and kind, never an empty one", () => {
    const captures = [
      { url: "/api/timedtext?v=x&lang=de&fmt=json3", text: json3([{ tStartMs: 0, segs: [{ utf8: "Hallo" }] }]) },
      { url: "/api/timedtext?v=x&lang=en&kind=asr&fmt=json3", text: "" },
      { url: "/api/timedtext?v=x&lang=en&kind=asr&fmt=json3", text: json3([{ tStartMs: 0, segs: [{ utf8: "hello" }] }]) },
    ];
    expect(pickCapture(captures, { languageCode: "en", kind: "asr", name: "en" })).toBe(captures[2]!.text);
    // Only this video's (final audit G14): an ad's or the next video's captions are never its transcript.
    const other = [{ url: "/api/timedtext?v=AAAAAAAAAAA&lang=en&kind=asr&fmt=json3", text: "x" }, { url: `/api/timedtext?v=${vid}&lang=en&kind=asr`, text: "mine" }];
    expect(pickCapture(other, { languageCode: "en", kind: "asr", name: "en" }, vid)).toBe("mine");
    expect(pickCapture([other[0]!], { languageCode: "en", kind: "asr", name: "en" }, vid)).toBeNull();
    expect(pickCapture([captures[0]!], { languageCode: "en", kind: null, name: "en" })).toBe(captures[0]!.text);
    expect(pickCapture([], { languageCode: "en", kind: null, name: "en" })).toBeNull();
  });

  it("json3: each event's pieces joined, times to a tenth, empty lines dropped (27 lines of a 98 s video)", () => {
    const events = [
      { tStartMs: 0, dDurationMs: 98_000, id: 1, wpWinPosId: 1 },
      ...Array.from({ length: 27 }, (_, i) => ({ tStartMs: i * 3_600 + 40, segs: [{ utf8: `zorbex` }, { utf8: ` line ${i}`, tOffsetMs: 200 }] })),
      { tStartMs: 50_000, aAppend: 1, segs: [{ utf8: "\n" }] },
    ];
    const segs = captureSegments(json3(events));
    expect(segs).toHaveLength(27);
    expect(segs[0]).toEqual([0, "zorbex line 0"]);
    expect(segs[1]).toEqual([3.6, "zorbex line 1"]);
  });

  it("an XML track reads too (the older formats), entities decoded", () => {
    expect(captureSegments('<transcript><text start="1.5" dur="2">Lift &amp; hold</text><text start="4" dur="1">it&#39;s fine</text></transcript>')).toEqual([[1.5, "Lift & hold"], [4, "it's fine"]]);
    expect(captureSegments('<timedtext><body><p t="2500" d="900"><s>slow</s><s> reps</s></p></body></timedtext>')).toEqual([[2.5, "slow reps"]]);
    expect(captureSegments("garbage")).toEqual([]);
  });
});

describe("panelSegments", () => {
  it("the transcript panel's rows: their clocks as seconds", () => {
    expect(panelSegments([{ time: "0:05", text: " Zorbex  start " }, { time: "1:02:03", text: "late" }, { time: "?", text: "x" }, { time: "4:05", text: "" }])).toEqual([
      [5, "Zorbex start"], [3723, "late"],
    ]);
  });
});

describe("chapters", () => {
  const marker = (key: string, list: [number, string][]) => ({
    key, value: { chapters: list.map(([ms, title]) => ({ chapterRenderer: { title: { simpleText: title }, timeRangeStartMillis: ms } })) },
  });
  it("the player bar's chapters, the creator's before the automatic ones", () => {
    const markers = JSON.stringify([marker("AUTO_CHAPTERS", [[0, "Auto"]]), marker("DESCRIPTION_CHAPTERS", [[0, "Intro"], [65_000, "Flow"]])]);
    expect(chaptersFromMarkers(markers)).toEqual([{ start: 0, title: "Intro" }, { start: 65, title: "Flow" }]);
    expect(chaptersFromMarkers(JSON.stringify([marker("AUTO_CHAPTERS", [[0, "Auto"]])]))).toEqual([{ start: 0, title: "Auto" }]);
    expect(chaptersFromMarkers(null)).toEqual([]);
    expect(chaptersFromMarkers("{bad")).toEqual([]);
  });

  it("YouTube's description rule: from 0:00, three or more, ascending, each at least 10 s on", () => {
    expect(chaptersFromDescription("Hi\n0:00 Intro\n1:05 - Flow\n(12:30) Cool-down\nthanks")).toEqual([
      { start: 0, title: "Intro" }, { start: 65, title: "Flow" }, { start: 750, title: "Cool-down" },
    ]);
    expect(chaptersFromDescription("0:00 a\n1:00:05 b\n1:00:20 c")).toEqual([{ start: 0, title: "a" }, { start: 3605, title: "b" }, { start: 3620, title: "c" }]);
    expect(chaptersFromDescription("0:05 Intro\n1:00 Flow\n2:00 End")).toEqual([]); // not from 0:00
    expect(chaptersFromDescription("0:00 Intro\n1:00 Flow")).toEqual([]); // two
    expect(chaptersFromDescription("0:00 Intro\n0:05 Flow\n2:00 End")).toEqual([]); // a 5 s gap
    expect(chaptersFromDescription("0:00 Intro\n2:00 Flow\n1:00 End")).toEqual([]); // out of order
  });
});

describe("toYoutubeSubmit", () => {
  it("a submit the app's schema takes, with the read's facts", () => {
    const meta = (parsePlayer(player(), vid) as { meta: Parameters<typeof toYoutubeSubmit>[0] }).meta;
    const submit = toYoutubeSubmit(
      { ...meta, description: `${meta.description} #mobility #Zorbex` },
      { track: { languageCode: "en-GB", kind: null, name: "English (UK)" }, segments: [[0, "Welcome"], [5, "ten reps"]], via: "captured" },
      { list: [{ start: 0, title: "Intro" }, { start: 60, title: "Flow" }, { start: 300, title: "Cool-down" }], from: "description" },
      "0.3.0",
      8_123,
    );
    expect(postSubmitSchema.safeParse(submit).success).toBe(true);
    expect(submit).toMatchObject({
      source: "youtube", key: vid, url: watchUrl(vid), creator: { handle: "@zorbexcoach", name: "Zorbex Coach" }, mediaType: "video",
      hashtags: ["mobility", "Zorbex"], origin: "pasted", title: "Zorbex hip flow", durationSec: 754, postedAt: "2026-11-01", live: false,
      transcript: { lang: "en-GB", kind: "uploaded", text: "0\tWelcome\n5\tten reps", cut: false },
      readFacts: {
        via: "pasted", extVersion: "0.3.0", coverSent: false, mediaCount: 1,
        youtube: { captions: { lang: "en-GB", kind: "uploaded" }, segments: 2, transcriptChars: 20, chapters: 3, chaptersFrom: "description", via: "captured", ms: 8_123 },
      },
    });
  });

  it("no captions: no transcript, and the read says so", () => {
    const meta = (parsePlayer(player({ captions: undefined }), vid) as { meta: Parameters<typeof toYoutubeSubmit>[0] }).meta;
    const submit = toYoutubeSubmit({ ...meta, description: "d".repeat(6_000), title: "t".repeat(300) }, null, { list: [], from: null }, "0.3.0", 1_000);
    expect(postSubmitSchema.safeParse(submit).success).toBe(true);
    expect(submit.transcript).toBeUndefined();
    expect(submit.caption).toHaveLength(5_000);
    expect(submit.title).toHaveLength(200);
    expect(submit.readFacts!.youtube).toMatchObject({ captions: null, segments: 0, transcriptChars: 0, via: null });
  });
});

describe("an unknown length (final review F5)", () => {
  it("is sent as no length, never as zero", () => {
    const meta = (parsePlayer(player({ videoDetails: { ...player().videoDetails, lengthSeconds: "0" } }), vid) as { meta: Parameters<typeof toYoutubeSubmit>[0] }).meta;
    const submit = toYoutubeSubmit(meta, null, { list: [], from: null }, "0.3.0", 1_000);
    expect(submit.durationSec).toBeUndefined();
    expect(postSubmitSchema.safeParse(submit).success).toBe(true);
  });
});
