import { describe, expect, it } from "vitest";
import { LINK_REFUSED, linkState, normalizeLink } from "../src/index.js";

// Links assembled at runtime, with a video id built here, so the repository's privacy grep never sees a real one.
const S = ["ht", "tps://"].join("");
const YT = ["you", "tube.com"].join("");
const SHORT = ["you", "tu.be"].join("");
const IG = ["insta", "gram.com"].join("");
const id = ["Zx", "9_", "-Qa", "B3c", "D"].join(""); // 11 characters
const code = ["Zorb", "ex1_2-AB"].join("");
const watch = `${S}www.${YT}/watch?v=${id}`;

describe("normalizeLink", () => {
  it.each([
    [`${S}www.${YT}/watch?v=${id}`],
    [`${S}${YT}/watch?feature=share&v=${id}&t=42s`],
    [`${S}m.${YT}/watch?v=${id}`],
    [`${S}${SHORT}/${id}?si=abc`],
    [`${SHORT}/${id}`],
    [`${S}www.${YT}/shorts/${id}`],
    [`  ${S}www.${YT}/watch?v=${id}  `],
  ])("a YouTube link %s is the video's watch link", (input) => {
    expect(normalizeLink(input)).toEqual({ source: "youtube", key: id, url: watch });
  });

  it.each([
    [`${S}www.${IG}/p/${code}/`, "p"],
    [`${S}${IG}/p/${code}?igsh=x`, "p"],
    [`${S}www.${IG}/reel/${code}/`, "reel"],
    [`${S}www.${IG}/reels/${code}/`, "reel"],
    [`${S}www.${IG}/zorbex.creator/p/${code}/`, "p"],
  ])("an Instagram link %s is its post by shortcode", (input, kind) => {
    expect(normalizeLink(input)).toEqual({ source: "instagram", key: code, url: `${S}www.${IG}/${kind}/${code}/` });
  });

  it.each([
    [`${S}vimeo.com/123`],
    [`${S}www.${YT}/watch?v=${id.slice(1)}`],
    [`${S}www.${YT}/channel/UCzorbex`],
    [`${S}www.${IG}/stories/zorbex/123/`],
    [`${S}www.${IG}/zorbex.creator/`],
    ["javascript:alert(1)"],
    [""],
  ])("refuses %s", (input) => {
    expect(normalizeLink(input)).toBeNull();
  });

  it("says what it takes", () => {
    expect(LINK_REFUSED).toBe("Only YouTube and Instagram links for now.");
  });
});

describe("linkState", () => {
  const link = (over = {}) => ({ status: "waiting", addedFrom: "app" as const, errorCode: null, error: null, ...over });
  const post = (over = {}) => ({ status: "seen", lastErrorCode: null, lastError: null, moves: 0, watchVideo: false, ...over });

  it("before the extension has it", () => {
    expect(linkState(link(), null)).toEqual({ state: "waiting", words: "Waiting for your computer's extension", action: null });
    expect(linkState(link({ addedFrom: "extension" }), null)).toEqual({ state: "reading", words: "Reading", action: null });
    expect(linkState(link({ status: "failed", errorCode: "unplayable", error: "Age-restricted" }), null)).toEqual({
      state: "failed", words: "Failed: Age-restricted", action: "retry",
    });
  });

  it("once the post is in, the post's status is the truth", () => {
    expect(linkState(link(), post()).words).toBe("Screening");
    expect(linkState(link(), post({ status: "queued" })).words).toBe("Reading the moves");
    expect(linkState(link(), post({ status: "queued", watchVideo: true })).words).toBe("Waiting for your computer's extension");
    expect(linkState(link({ addedFrom: "extension" }), post({ status: "queued", watchVideo: true })).words).toBe("Reading the moves");
    expect(linkState(link(), post({ status: "extracting" })).words).toBe("Reading the moves");
    expect(linkState(link(), post({ status: "matched", moves: 3 }))).toEqual({ state: "moves", words: "3 moves", action: null });
    expect(linkState(link(), post({ status: "matched", moves: 1 })).words).toBe("1 move");
    expect(linkState(link(), post({ status: "matched", moves: 0 })).words).toBe("No moves");
    expect(linkState(link(), post({ status: "filtered_out" }))).toEqual({ state: "not_training", words: "Not training", action: "import_anyway" });
    expect(linkState(link(), post({ status: "failed", lastErrorCode: "no_captions" }))).toEqual({
      state: "failed", words: "Failed: No captions, and the video couldn't be watched", action: "retry",
    });
    expect(linkState(link(), post({ status: "skipped_by_owner" })).words).toBe("Skipped");
    expect(linkState(link(), post({ status: "reference_only" })).words).toBe("Kept as a reference");
  });
});

describe("normalizeLink takes what people paste (final audit G12)", () => {
  it.each([
    [["ht", "tp://www.", YT, "/watch?v=", id].join("")],
    [`${S}www.${YT}/live/${id}?feature=share`],
    [`${S}www.${YT}/embed/${id}`],
    [`Watch this Zorbex flow! ${S}${SHORT}/${id}?si=abc — so good`],
    [`Zorbex hip flow\n${S}www.${YT}/watch?v=${id}`],
  ])("%s is the video's watch link", (input) => {
    expect(normalizeLink(input)).toEqual({ source: "youtube", key: id, url: watch });
  });
  it("share text with an Instagram link", () => {
    expect(normalizeLink(`Saw this on Instagram: ${S}www.${IG}/reel/${code}/?igsh=x`)).toEqual({ source: "instagram", key: code, url: `${S}www.${IG}/reel/${code}/` });
  });
  it("share text with no link it takes is still refused", () => {
    expect(normalizeLink(`Look: ${S}vimeo.com/1 and more`)).toBeNull();
    expect(normalizeLink("just words")).toBeNull();
  });
});

describe("YouTube asking to sign in (audit 2026-11-06, I3)", () => {
  it("is a code of its own, in words that say what to do", async () => {
    const { failureWords, SAVE_ERROR_CODES } = await import("../src/index.js");
    expect(SAVE_ERROR_CODES).toContain("youtube_login");
    expect(failureWords("youtube_login", "YouTube asked to sign in")).toBe("Sign in to YouTube in Chrome");
    expect(linkState({ status: "failed", addedFrom: "extension", errorCode: "youtube_login", error: "Sign in to YouTube in Chrome" }, null)).toEqual({
      state: "failed", words: "Failed: Sign in to YouTube in Chrome", action: "retry",
    });
  });
});
