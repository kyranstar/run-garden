/**
 * The builder's template save is made again, silently, only when the template there holds the document opened here
 * (Task 9 fix rounds 2–3): `sameDocument` compares them as a save sends them, and a document a save could not send is
 * never a match — two of them are not "the same", whatever their titles.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { suggestedItem } from "@rg/workout";
import { sameDocument } from "../src/screens/studio/use-build-flows.js";

const rec = (id: string) => EXERCISES.find((e) => e.id === id)!;
const doc = (title: string, moves: string[]): WorkoutDoc => ({
  version: 1,
  title,
  intent: { summary: title, goals: [], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: moves.map((m) => suggestedItem(rec(m), "main")) }],
  source: { kind: "studio" },
});

describe("sameDocument", () => {
  it("the same document is the same; another move or title is not", () => {
    expect(sameDocument(doc("Thursday lift", ["gobletSquat"]), doc("Thursday lift", ["gobletSquat"]))).toBe(true);
    expect(sameDocument(doc("Thursday lift", ["gobletSquat"]), doc("Thursday lift", ["deadlift"]))).toBe(false);
    expect(sameDocument(doc("Thursday lift", ["gobletSquat"]), doc("Friday lift", ["gobletSquat"]))).toBe(false);
  });

  it("documents a save could not send are never a match", () => {
    expect(sameDocument(doc("Thursday lift", []), doc("Thursday lift", []))).toBe(false);
    expect(sameDocument(doc("Thursday lift", []), doc("Thursday lift", ["gobletSquat"]))).toBe(false);
  });
});
