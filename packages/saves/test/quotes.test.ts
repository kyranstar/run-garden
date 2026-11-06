import { describe, expect, it } from "vitest";
import { foldWords, verifyQuotes, type Extraction } from "../src/index.js";

// §5.6: a quote is the creator's words only when the words are there. Synthetic text throughout.

type Q = { field: "name" | "dose" | "purpose" | "useWhen" | "skipWhen" | "steps" | "why"; text: string; at?: number; from: "caption" | "transcript" | "speech" | "screen"; check?: string };
const reading = (quotes: Q[], evidence: Record<string, string> = {}): Extraction =>
  ({
    kind: "single_move", summary: "s", themes: [], insights: [],
    moves: [{ name: "Zorbex lift", quotes, evidence: { name: "stated", dose: "stated", steps: "stated", ...evidence } }],
  }) as unknown as Extraction;
const checks = (out: ReturnType<typeof verifyQuotes>) => out.results.map((r) => r.check);

describe("foldWords", () => {
  it("folds case, accents, punctuation and spacing", () => {
    expect(foldWords("  Café—LIFT,   now! ")).toBe("cafe lift now");
  });
});

describe("verifyQuotes", () => {
  const transcript: [number, string][] = [[0, "welcome to the zorbex flow"], [12, "do ten slow reps"], [15, "on each side and breathe"], [300, "later words here"]];

  it("a caption quote with other case and punctuation is verified", () => {
    const out = verifyQuotes(reading([{ field: "purpose", text: "Opens the HIPS, gently", from: "caption" }]), { caption: "This opens the hips gently after a run." });
    expect(checks(out)).toEqual(["verified"]);
  });

  it("accents fold: café is cafe", () => {
    expect(checks(verifyQuotes(reading([{ field: "name", text: "café lift", from: "caption" }]), { caption: "the cafe lift" }))).toEqual(["verified"]);
  });

  it("a transcript quote spanning two segments is verified, with the time it starts at", () => {
    const out = verifyQuotes(reading([{ field: "dose", text: "ten slow reps on each side", at: 13, from: "transcript" }]), { caption: "", transcript });
    expect(out.results[0]).toMatchObject({ check: "verified", at: 12 });
  });

  it("near the quote's time, 80% of its words are enough; 70% are not", () => {
    const eighty = verifyQuotes(reading([{ field: "dose", text: "do ten slow reps on every side", at: 12, from: "transcript" }]), { caption: "", transcript });
    expect(checks(eighty)).toEqual(["verified"]);
    const seventy = verifyQuotes(reading([{ field: "dose", text: "do twelve fast reps on every leg", at: 12, from: "transcript" }]), { caption: "", transcript });
    expect(checks(seventy)).toEqual(["not_found"]);
  });

  it("a quote found only in the reader's own transcription is in_speech", () => {
    const out = verifyQuotes(reading([{ field: "why", text: "keeps the knees happy", from: "speech" }]), { caption: "", speech: "This one keeps the knees happy, she says." });
    expect(checks(out)).toEqual(["in_speech"]);
  });

  it("a quote not in the words makes its field inferred, and the model's own check is replaced", () => {
    const out = verifyQuotes(reading([{ field: "dose", text: "twenty reps", from: "caption", check: "verified" }]), { caption: "Do it slowly." });
    expect(checks(out)).toEqual(["not_found"]);
    const move = out.extraction.moves[0] as unknown as { quotes: Q[]; evidence: Record<string, string> };
    expect(move.quotes[0]!.check).toBe("not_found");
    expect(move.evidence.dose).toBe("inferred");
    expect(move.evidence.name).toBe("stated");
  });

  it("a found quote leaves its field as the reader said it", () => {
    const out = verifyQuotes(reading([{ field: "dose", text: "do it slowly", from: "caption" }]), { caption: "Do it slowly." });
    expect((out.extraction.moves[0] as unknown as { evidence: Record<string, string> }).evidence.dose).toBe("stated");
  });

  it("a long transcript with no time on the quote is matched by its words in order only", () => {
    const long: [number, string][] = Array.from({ length: 4_100 }, (_, i) => [i, `alpha beta gamma delta epsilon w${i}`]);
    const swapped = verifyQuotes(reading([{ field: "steps", text: "beta alpha delta gamma epsilon", from: "transcript" }]), { caption: "", transcript: long });
    expect(checks(swapped)).toEqual(["not_found"]);
    const exact = verifyQuotes(reading([{ field: "steps", text: "gamma delta epsilon w4000", from: "transcript" }]), { caption: "", transcript: long });
    expect(exact.results[0]).toMatchObject({ check: "verified", at: 4000 });
  });

  it("a title or a chapter is a source the reader didn't write", () => {
    const out = verifyQuotes(reading([{ field: "name", text: "zorbex hip flow", from: "caption" }, { field: "name", text: "cool down", from: "caption" }]), {
      caption: "", title: "The Zorbex Hip Flow", chapters: ["Cool-down"],
    });
    expect(checks(out)).toEqual(["verified", "verified"]);
  });

  it("a reading with no quotes is untouched", () => {
    const r = { kind: "tips", summary: "s", themes: [], insights: [], moves: [] } as unknown as Extraction;
    expect(verifyQuotes(r, { caption: "x" })).toEqual({ extraction: r, results: [] });
  });
});

describe("verifyQuotes reads a long transcript only when it must (final review F2)", () => {
  const transcript: [number, string][] = [[0, "welcome to the zorbex flow"], [12, "do ten slow reps"]];
  it("a transcript handed lazily is read once, and not at all when every quote is in the caption", () => {
    let reads = 0;
    const lazy = () => {
      reads++;
      return transcript;
    };
    const inCaption = verifyQuotes(reading([{ field: "purpose", text: "opens the hips", from: "caption" }]), { caption: "It opens the hips.", transcript: lazy });
    expect(inCaption.results.map((r) => r.check)).toEqual(["verified"]);
    expect(reads).toBe(0);
    const inTranscript = verifyQuotes(
      reading([{ field: "dose", text: "ten slow reps", at: 12, from: "transcript" }, { field: "name", text: "zorbex flow", from: "transcript" }]),
      { caption: "", transcript: lazy },
    );
    expect(inTranscript.results.map((r) => [r.check, r.at])).toEqual([["verified", 12], ["verified", 0]]);
    expect(reads).toBe(1);
  });
});
