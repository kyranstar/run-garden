/**
 * The reviewer's faithfulness to the evidence (import trail phase 3, Task 8; design 2026-11-05 §8.5): a revised
 * workout's item for a move from the athlete's saves — its dose, why and notes — must match the move's record and the
 * post's quoted words, or say why they differ; a mismatch with no reason is must-fix. Scored only when the draft holds a
 * saved move, so a library-only workout's review shows no empty line. Pure and synthetic.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { REVIEW_DIMENSIONS, roleBlock, RUN_REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { lineReview } from "../src/services/design-manifest.js";
import { faithfulnessMissing, packetDoc, parseReview, submitReviewSchema } from "../src/services/design-review.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { savedMoveDraft } from "./saves-batch-fixture.js";

const SAVED_ID = "myZorbexHipLiftAbc123";
const SAVED: ExerciseRecord = toPersonalRecord(SAVED_ID, savedMoveDraft("Zorbex hip lift", { purpose: "Opens the hips after easy runs", dose: { text: "2x6 per side", type: "reps", range: [6, 6], sets: [2, 2] } }));

/** A review scoring every workout dimension but faithfulness 5, with a note each. */
const review = (o: { faithfulness?: boolean } = {}) => {
  const ids = REVIEW_DIMENSIONS.map((d) => d.id).filter((id) => o.faithfulness || id !== "faithfulness");
  return { scores: Object.fromEntries(ids.map((id) => [id, 5])), notes: Object.fromEntries(ids.map((id) => [id, "Fine."])), mustFix: [], improvements: [] };
};

/** calmDoc with one of its items swapped for the saved move. */
function withSaved(): ReturnType<typeof calmDoc> {
  const doc = calmDoc();
  const part = doc.parts.find((p) => p.items.some((i) => i.kind === "exercise"))!;
  const at = part.items.findIndex((i) => i.kind === "exercise");
  part.items[at] = { ...(part.items[at] as object), libraryId: SAVED_ID } as never;
  return doc;
}

describe("the faithfulness dimension", () => {
  it("is the workout rubric's, labelled for the athlete; a run's rubric has none", () => {
    expect(REVIEW_DIMENSIONS.find((d) => d.id === "faithfulness")).toMatchObject({ label: "Faithful to your saves" });
    expect(RUN_REVIEW_DIMENSIONS.some((d) => d.id === "faithfulness")).toBe(false);
  });

  it("is optional in a review and in its schema; scored, it is kept", () => {
    expect("error" in parseReview(review())).toBe(false);
    const scored = parseReview(review({ faithfulness: true }));
    expect("error" in scored ? null : scored.scores.faithfulness).toBe(5);
    const schema = submitReviewSchema("workout") as { properties: { scores: { required: string[]; properties: Record<string, unknown> } } };
    expect(schema.properties.scores.properties.faithfulness).toBeDefined();
    expect(schema.properties.scores.required).not.toContain("faithfulness");
  });

  it("is required of a draft that holds a move from the athlete's saves — only that one", () => {
    expect(faithfulnessMissing(calmDoc(), review())).toBe(false);
    expect(faithfulnessMissing(withSaved(), review())).toBe(true);
    expect(faithfulnessMissing(withSaved(), review({ faithfulness: true }))).toBe(false);
  });

  it("a saved move in the reviewer's packet carries its record's dose and purpose beside it", () => {
    const packet = packetDoc(withSaved(), [...EXERCISES, SAVED]) as { parts: Array<{ items: Array<Record<string, unknown>> }> };
    const item = packet.parts.flatMap((p) => p.items).find((i) => i.libraryId === SAVED_ID)!;
    expect(item.saved).toEqual({ dose: "6 reps, 2 sets", purpose: "Opens the hips after easy runs" });
    const library = packet.parts.flatMap((p) => p.items).find((i) => i.kind === "exercise" && i.libraryId !== SAVED_ID)!;
    expect(library.saved).toBeUndefined();
  });

  it("the reviewer is told how to score it and that a mismatch with no reason is must-fix", () => {
    const block = roleBlock("reviewer");
    expect(block).toContain("- faithfulness — Faithful to your saves:");
    expect(block).toContain("Also must-fix: a move from the athlete's saves whose dose, why or notes differ from its record or the post's quoted words, with no reason given.");
    expect(roleBlock("reviewer", undefined, "run")).not.toContain("faithfulness");
  });

  it("a review that didn't score it shows no empty line on the card", () => {
    const r = parseReview(review());
    if ("error" in r) throw new Error(r.why);
    const shown = lineReview({ ...r, rounds: 1, changes: [] } as never)!;
    expect(shown.dimensions.some((d) => d.id === "faithfulness")).toBe(false);
  });
});
