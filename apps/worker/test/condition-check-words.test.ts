/**
 * A key result measuring a condition's daily check, in words: what `read_objectives` says it measures, the unit the
 * coach's `before → after` line reads in, and the check scale's reference points on the profile's view (the only road
 * they take to the check sheet and the board). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { keyResultMeasureSchema } from "@rg/domain";
import { profileById } from "@rg/exercise-library";
import { measureWords } from "../src/services/design-tools/read-objectives.js";
import { objectiveChangeLine } from "../src/services/objective-changes.js";
import { conditionView } from "../src/services/condition-views.js";

describe("measureWords for a daily check", () => {
  it("names the profile by its check's own label and the window, and says it is a daily check averaged", () => {
    const m = keyResultMeasureSchema.parse({ kind: "condition_check", profileId: "tmj", windowDays: 21 });
    expect(measureWords(m)).toBe(`daily ${profileById("tmj").check.label} check (else the day's first before-check), averaged over 21 d`);
  });

  it("for a profile the library no longer holds, falls back to the id rather than failing", () => {
    const m = keyResultMeasureSchema.parse({ kind: "condition_check", profileId: "gone", windowDays: 14 });
    expect(measureWords(m)).toBe("daily gone check (else the day's first before-check), averaged over 14 d");
  });
});

describe("a coach's proposal to add a daily-check key result", () => {
  it("reads right before → after: the label, and the target as a plain score", () => {
    const after = { id: "k", label: "Calmer days", measure: { kind: "condition_check", profileId: "tmj", windowDays: 14 }, direction: "down", baseline: null, target: 2, unit: "score", dueDate: null };
    expect(objectiveChangeLine({ change: "add_key_result", title: "Calmer", before: null, after })).toBe("Calmer: new key result — Calmer days, target 2");
    expect(objectiveChangeLine({ change: "retarget", title: "Calmer", before: 3, after: 2, kr: { label: "Calmer days", unit: "score" } })).toBe("Calmer days: target 3 → 2");
  });
});

describe("the profile's view carries the check's reference points", () => {
  it("label, scale and anchors — the anchors as the profile holds them", () => {
    const view = conditionView("tmj");
    expect(view.check).toEqual({
      label: profileById("tmj").check.label,
      min: 0,
      max: 10,
      anchors: profileById("tmj").check.anchors.map((a) => ({ value: a.value, words: a.words })),
    });
    expect(view.check.anchors.length).toBeGreaterThan(0);
  });
});
