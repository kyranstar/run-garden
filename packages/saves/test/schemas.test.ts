import { describe, expect, it } from "vitest";
import { PROFILE_IDS } from "@rg/exercise-library";
import {
  checkReportSchema, extractedMoveSchema, extractionSchema, filterVerdictSchema, postSubmitSchema, SAVE_SOURCE_RE,
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
    expect(postSubmitSchema.safeParse({ ...post, caption: "c".repeat(4001) }).success).toBe(false);
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
    expect(extractionSchema.safeParse({ ...ex, moves: Array(13).fill(move) }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, themes: Array(6).fill("t") }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...ex, summary: "s".repeat(301) }).success).toBe(false);
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
