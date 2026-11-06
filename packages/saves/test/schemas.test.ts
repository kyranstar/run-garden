import { describe, expect, it } from "vitest";
import { PROFILE_IDS } from "@rg/exercise-library";
import {
  checkReportSchema, extractedMoveSchema, extractionSchema, filterVerdictSchema, postSubmitSchema, SAVE_SOURCE_RE, fitSchema,
} from "../src/index.js";

const post = {
  source: "social", key: "k1", url: "https://example.com/p/k1", creator: { handle: "someone" }, caption: "c",
  hashtags: ["a"], mediaType: "video" as const,
};
const conditions = Object.fromEntries(PROFILE_IDS.map((p) => [p, { attrs: { load: 2, safe: true }, note: "ok" }]));
const move = {
  name: "Hip switch", aliases: [], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose: "mobility",
  dose: { text: "10 each", type: "reps" as const, range: [8, 12] as [number, number] },
  patterns: ["mobility"], regions: ["hips"], equipment: ["mat"], position: "seated", laterality: "alternating",
  load: "bodyweight", contraction: ["isotonic"], difficulty: 2, conditions,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high",
};

describe("schemas", () => {
  it("accepts a valid post and rejects unknown keys and over-length fields", () => {
    expect(postSubmitSchema.safeParse(post).success).toBe(true);
    expect(postSubmitSchema.safeParse({ ...post, extra: 1 }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, key: "k".repeat(65) }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, caption: "c".repeat(5001) }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, url: "http://example.com/x" }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, hashtags: Array(31).fill("a") }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, source: "Bad Source" }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, cover: { mime: "image/gif", base64: "AA" } }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, cover: { mime: "image/png", base64: "A".repeat(400_001) } }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, seed: { status: "queued", reason: "r".repeat(161) } }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...post, creator: { handle: "h", x: 1 } }).success).toBe(false);
  });
  it("source pattern", () => {
    expect(SAVE_SOURCE_RE.test("social.v1")).toBe(true);
    expect(SAVE_SOURCE_RE.test("Social")).toBe(false);
  });
  it("filter verdict", () => {
    expect(filterVerdictSchema.safeParse({ verdict: "maybe", reason: "r" }).success).toBe(true);
    expect(filterVerdictSchema.safeParse({ verdict: "yes", reason: "r" }).success).toBe(false);
    expect(filterVerdictSchema.safeParse({ verdict: "not", reason: "r".repeat(161) }).success).toBe(false);
    expect(filterVerdictSchema.safeParse({ verdict: "not", reason: "r", x: 1 }).success).toBe(false);
  });
  it("extracted move", () => {
    expect(extractedMoveSchema.safeParse(move).success).toBe(true);
    expect(extractedMoveSchema.safeParse({ ...move, extra: 1 }).success).toBe(false);
    expect(extractedMoveSchema.safeParse({ ...move, name: "n".repeat(81) }).success).toBe(false);
    expect(extractedMoveSchema.safeParse({ ...move, steps: Array(9).fill("s") }).success).toBe(false);
    expect(extractedMoveSchema.safeParse({ ...move, aliases: Array(6).fill("s") }).success).toBe(false);
    expect(extractedMoveSchema.safeParse({ ...move, difficulty: 6 }).success).toBe(false);
  });
  it("rejects a move missing a profile's condition rating", () => {
    for (const p of PROFILE_IDS) {
      const { [p]: _gone, ...rest } = conditions;
      expect(extractedMoveSchema.safeParse({ ...move, conditions: rest }).success).toBe(false);
    }
  });
  it("rejects vocab outside the library", () => {
    for (const bad of [
      { patterns: ["levitate"] }, { regions: ["elbow"] }, { equipment: ["jetpack"] }, { position: "flying" },
      { laterality: "tri" }, { load: "heavy" }, { contraction: ["magic"] }, { dose: { text: "x", type: "laps" } },
    ]) {
      expect(extractedMoveSchema.safeParse({ ...move, ...bad }).success).toBe(false);
    }
  });
  it("extraction", () => {
    const ex = { kind: "routine", summary: "s", themes: ["a"], moves: [move], routine: { rounds: 2, order: [0] } };
    expect(extractionSchema.safeParse(ex).success).toBe(true);
    expect(extractionSchema.safeParse({ ...ex, extra: 1 }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, moves: Array(31).fill(move) }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, themes: Array(6).fill("t") }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, summary: "s".repeat(301) }).success).toBe(false);
  });
  it("extraction insights (spec §17): at most 5 of at most 200 characters; one stored before they were asked for reads as none", () => {
    const ex = { kind: "routine", summary: "s", themes: ["a"], moves: [move] };
    const withInsights = extractionSchema.safeParse({ ...ex, insights: ["Do it before a run, not after.", "Twice a week is plenty."] });
    expect(withInsights.success && withInsights.data.insights).toEqual(["Do it before a run, not after.", "Twice a week is plenty."]);
    const older = extractionSchema.safeParse(ex);
    expect(older.success && older.data.insights).toEqual([]);
    expect(extractionSchema.safeParse({ ...ex, insights: Array(6).fill("i") }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, insights: ["i".repeat(201)] }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, insights: ["i".repeat(200)] }).success).toBe(true);
    expect(extractionSchema.safeParse({ ...ex, insights: [3] }).success).toBe(false);
  });
  it("check report", () => {
    const id = "0b0c6b9e-6d4c-4b8e-9d57-1f0f2a9f3a11";
    expect(checkReportSchema.safeParse({ checkId: id, phase: "start" }).success).toBe(true);
    expect(checkReportSchema.safeParse({ checkId: id, phase: "finish", error: { code: "gone", message: "m" } }).success).toBe(true);
    expect(checkReportSchema.safeParse({ checkId: "nope", phase: "start" }).success).toBe(false);
    expect(checkReportSchema.safeParse({ checkId: id, phase: "finish", error: { code: "other", message: "m" } }).success).toBe(false);
    expect(checkReportSchema.safeParse({ checkId: id, phase: "finish", error: { code: "gone", message: "m".repeat(201) } }).success).toBe(false);
    expect(checkReportSchema.safeParse({ checkId: id, phase: "start", x: 1 }).success).toBe(false);
  });
});

describe("fitSchema", () => {
  it("takes personal ids with include or skip, strictly", () => {
    expect(fitSchema.safeParse({ choices: {} }).success).toBe(true);
    expect(fitSchema.safeParse({ choices: { myZorbexQuadShuffleabc123: "include" } }).success).toBe(true);
    expect(fitSchema.safeParse({ choices: { myZorbexQuadShuffleabc123: "maybe" } }).success).toBe(false);
    expect(fitSchema.safeParse({ choices: { gobletSquat: "skip" } }).success).toBe(false);
    expect(fitSchema.safeParse({ choices: {}, extra: 1 }).success).toBe(false);
  });
  it("takes no choices at all — the one-tap fit, which keeps the stored ones — but never null or other keys", () => {
    expect(fitSchema.safeParse({}).data).toEqual({});
    expect(fitSchema.safeParse({ choices: null }).success).toBe(false);
    expect(fitSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(fitSchema.safeParse(undefined).success).toBe(false);
  });
  it("holds to 60 choices", () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`myZorbex${i}`, "skip"]));
    expect(fitSchema.safeParse({ choices: many(60) }).success).toBe(true);
    expect(fitSchema.safeParse({ choices: many(61) }).success).toBe(false);
  });
});

describe("schemas: pasted links and YouTube (phase 2)", () => {
  const video = {
    ...post, source: "youtube", key: "Zx9_-QaB3cD", mediaType: "video" as const, caption: "d".repeat(5_000), origin: "pasted" as const,
    title: "Zorbex hip flow", durationSec: 754, chapters: [{ start: 0, title: "Intro" }, { start: 30, title: "Flow" }],
    transcript: { lang: "en", kind: "auto" as const, text: "0\tzorbex", cut: false }, live: false,
  };
  it("takes a video's title, length, chapters and transcript, and a 5,000-character description", () => {
    expect(postSubmitSchema.safeParse(video).success).toBe(true);
    expect(postSubmitSchema.safeParse({ ...video, caption: "d".repeat(5_001) }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...video, transcript: { ...video.transcript, text: "x".repeat(400_001) } }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...video, chapters: Array(101).fill({ start: 0, title: "a" }) }).success).toBe(false);
    expect(postSubmitSchema.safeParse({ ...video, transcript: { ...video.transcript, kind: "robot" } }).success).toBe(false);
  });
  it("takes a YouTube read's facts", () => {
    const readFacts = {
      via: "pasted", extVersion: "0.3.0", coverSent: false, mediaCount: 1,
      youtube: { captions: { lang: "en", kind: "auto" }, segments: 27, transcriptChars: 900, chapters: 2, chaptersFrom: "description", via: "captured", ms: 8_000 },
    };
    expect(postSubmitSchema.safeParse({ ...video, readFacts }).success).toBe(true);
    expect(postSubmitSchema.safeParse({ ...video, readFacts: { ...readFacts, youtube: { ...readFacts.youtube, extra: 1 } } }).success).toBe(false);
  });
  it("an extract-5 reading (string insights, none of the new fields) still parses", () => {
    expect(extractionSchema.safeParse({ kind: "single_move", summary: "s", themes: [], moves: [move], insights: ["Do it after easy runs."] }).success).toBe(true);
  });
  it("reads extract-6's reasons and quotes, and at most 30 moves", () => {
    const six = {
      ...move,
      useWhen: [{ text: "After easy runs", evidence: "stated" }], skipWhen: [{ text: "With a sore knee", evidence: "inferred" }],
      why: "Opens the hips", quotes: [{ field: "dose", text: "ten each side", at: 12, from: "transcript" }],
      evidence: { ...move.evidence, purpose: "stated", useWhen: "stated", skipWhen: "inferred" },
    };
    const reading = { kind: "routine", summary: "s", themes: [], moves: [six], speech: "zorbex", insights: [{ text: "Twice a week", scope: "general" }, "plain"] };
    expect(extractionSchema.safeParse(reading).success).toBe(true);
    expect(extractionSchema.safeParse({ ...reading, moves: Array(30).fill(six) }).success).toBe(true);
    expect(extractionSchema.safeParse({ ...reading, moves: Array(31).fill(six) }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...reading, insights: [{ text: "x", scope: "everyone" }] }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...reading, moves: [{ ...six, quotes: Array(9).fill(six.quotes[0]) }] }).success).toBe(false);
  });
});
