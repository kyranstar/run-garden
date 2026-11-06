/**
 * The evidence words (import trail phase 3, Task 1; design 2026-11-05 §8.1, §3.3, §14.2): a saved move's reading as the
 * coach reads its evidence — stated or inferred, its quotes with stable ids and how each checked out — and the chips a
 * card's cites become. Pure: no database. Synthetic words only.
 */
import { describe, expect, it } from "vitest";
import {
  checkWord,
  claimsThePost,
  clockOf,
  doseNumbers,
  parseCite,
  quoteId,
  quoteLabel,
  readingEvidence,
  QUOTE_ID_RE,
} from "../src/services/saves-evidence.js";

const U = (text: string) => ({ untrusted: true, text });

describe("quote ids", () => {
  it("are the move's place in the batch and the quote's place across its links", () => {
    expect(quoteId(3, 2)).toBe("q3.2");
    expect(QUOTE_ID_RE.test("q3.2")).toBe(true);
    expect(QUOTE_ID_RE.test("q3")).toBe(false);
    expect(QUOTE_ID_RE.test("history")).toBe(false);
  });
});

describe("check words", () => {
  it("say where a quote stands in words", () => {
    expect(checkWord("verified", "caption")).toBe("in the caption");
    expect(checkWord("verified", "transcript")).toBe("said");
    expect(checkWord("verified", "speech")).toBe("said");
    expect(checkWord("in_speech", "speech")).toBe("heard");
    expect(checkWord("on_screen", "screen")).toBe("on screen");
    expect(checkWord("not_found", "transcript")).toBe("not in the post");
    expect(checkWord(undefined, "caption")).toBe("not in the post");
  });

  it("a clock reads minutes and seconds, hours past the hour", () => {
    expect(clockOf(72)).toBe("1:12");
    expect(clockOf(5.9)).toBe("0:05");
    expect(clockOf(3725)).toBe("1:02:05");
  });

  it("a quote's chip: said and heard carry their time; the caption, the screen and a missing quote don't", () => {
    const ref = (check: "verified" | "in_speech" | "on_screen" | "not_found", from: string, at: number | null) => ({ postId: "p", position: 0, quote: 0, check, from, at });
    expect(quoteLabel(ref("verified", "transcript", 72))).toBe("said 1:12");
    expect(quoteLabel(ref("verified", "transcript", null))).toBe("said");
    expect(quoteLabel(ref("in_speech", "speech", 12))).toBe("heard 0:12");
    expect(quoteLabel(ref("verified", "caption", 40))).toBe("in the caption");
    expect(quoteLabel(ref("on_screen", "screen", 9))).toBe("on screen");
    expect(quoteLabel(ref("not_found", "transcript", 9))).toBe("not in the post");
  });
});

describe("a reading's evidence", () => {
  const move = {
    name: "Zorbex hip lift",
    dose: { text: "2x6 per side" },
    purpose: "Opens the hips after easy runs",
    evidence: { name: "stated", dose: "stated", steps: "inferred", purpose: "stated", useWhen: "stated" },
    confidence: "high",
    why: "Hips stiffen after easy runs",
    useWhen: [{ text: "after an easy run", evidence: "stated" }],
    skipWhen: [{ text: "on a heavy leg day", evidence: "inferred" }],
    quotes: [
      { field: "name", text: "the Zorbex hip lift", from: "caption", check: "verified" },
      { field: "purpose", text: "if your hips get stiff after easy runs", at: 72, from: "transcript", check: "verified" },
      { field: "useWhen", text: "do it right after the run", at: 12, from: "speech", check: "in_speech" },
      { field: "dose", text: "two sets of six", at: 30, from: "transcript", check: "not_found" },
    ],
  };

  it("lists stated and inferred, each quote with its id, words and check, every text marked", () => {
    const out = readingEvidence(move, { moveNo: 2, firstK: 4, postId: "post-a", position: 1 })!;
    expect(out.evidence.confidence).toBe("high");
    expect(out.evidence.stated).toEqual(["name", "purpose", "useWhen"]);
    // A field whose quotes were all not found counts as inferred (§5.6).
    expect(out.evidence.inferred).toEqual(["dose", "steps"]);
    expect(out.evidence.dose).toEqual(U("2x6 per side"));
    expect(out.evidence.why).toEqual(U("Hips stiffen after easy runs"));
    expect(out.evidence.useWhen).toEqual([{ text: U("after an easy run"), said: true }]);
    expect(out.evidence.skipWhen).toEqual([{ text: U("on a heavy leg day"), said: false }]);
    expect(out.evidence.quotes).toEqual([
      { id: "q2.4", field: "name", text: U("the Zorbex hip lift"), check: "in the caption" },
      { id: "q2.5", field: "purpose", text: U("if your hips get stiff after easy runs"), check: "said", at: "1:12" },
      { id: "q2.6", field: "useWhen", text: U("do it right after the run"), check: "heard", at: "0:12" },
      { id: "q2.7", field: "dose", text: U("two sets of six"), check: "not in the post", at: "0:30" },
    ]);
    expect(out.refs).toEqual([
      ["q2.4", { postId: "post-a", position: 1, quote: 0, check: "verified", from: "caption", at: null }],
      ["q2.5", { postId: "post-a", position: 1, quote: 1, check: "verified", from: "transcript", at: 72 }],
      ["q2.6", { postId: "post-a", position: 1, quote: 2, check: "in_speech", from: "speech", at: 12 }],
      ["q2.7", { postId: "post-a", position: 1, quote: 3, check: "not_found", from: "transcript", at: 30 }],
    ]);
  });

  it("a reading from before extract-6 has its evidence and no quotes", () => {
    const old = { name: "Zorbex neck nod", dose: { text: "" }, evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "medium" };
    const out = readingEvidence(old, { moveNo: 1, firstK: 1, postId: "p", position: 0 })!;
    expect(out.evidence).toEqual({ confidence: "medium", stated: ["name", "steps"], inferred: ["dose"], dose: null, quotes: [] });
    expect(out.refs).toEqual([]);
  });

  it("nothing that reads as a move is null", () => {
    expect(readingEvidence(null, { moveNo: 1, firstK: 1, postId: "p", position: 0 })).toBeNull();
    expect(readingEvidence("words", { moveNo: 1, firstK: 1, postId: "p", position: 0 })).toBeNull();
  });
});

describe("cites", () => {
  it("are a quote id, history, a goal or a field the reader inferred", () => {
    expect(parseCite("q1.2")).toEqual({ kind: "quote", id: "q1.2" });
    expect(parseCite("history")).toEqual({ kind: "history", id: "history" });
    expect(parseCite("goal:obj-1")).toEqual({ kind: "goal", id: "goal:obj-1", goalId: "obj-1" });
    expect(parseCite("inferred:dose")).toEqual({ kind: "inferred", id: "inferred:dose", field: "dose" });
    expect(parseCite("inferred:colour")).toBeNull();
    expect(parseCite("q1")).toBeNull();
    expect(parseCite("goal:")).toBeNull();
  });
});

describe("a claim about what the post says", () => {
  it.each([
    "She says it loosens the hips.",
    "he said to hold it longer",
    "They recommend two sets.",
    "The creator pitches it for runners whose hips stiffen.",
    "the post recommends it after runs",
    "The caption says 30 s a side.",
    "the video shows a slow lower",
    "According to the post, it helps.",
    "In the video she says to breathe out.",
  ])("%s", (text) => expect(claimsThePost(text)).toBe(true));

  it.each([
    "Fills the hip work your plan has been short of.",
    "You already do a stronger version.",
    "Joins your mobility rotation after easy runs.",
    "The post never says how many — that was the reader's guess.",
    "It needs a cable stack.",
  ])("not: %s", (text) => expect(claimsThePost(text)).toBe(false));
});

describe("a dose's numbers", () => {
  it("are every number in order", () => {
    expect(doseNumbers("2×6 per side")).toEqual([2, 6]);
    expect(doseNumbers("8–12 reps, 2–3 sets")).toEqual([8, 12, 2, 3]);
    expect(doseNumbers("30–45 s")).toEqual([30, 45]);
    expect(doseNumbers("1.5 min")).toEqual([1.5]);
    expect(doseNumbers("as many as you like")).toEqual([]);
  });
});
