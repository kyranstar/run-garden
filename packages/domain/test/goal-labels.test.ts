/**
 * The goals' plain labels (Stage 3 Task 11 QA): every goal id a document or an objective names has words of its own,
 * kept beside `GOAL_IDS` — never the raw id ("aerobic-base") on a screen.
 */
import { describe, expect, it } from "vitest";
import { GOAL_IDS, GOAL_LABELS } from "../src/index.js";

describe("GOAL_LABELS", () => {
  it("names every goal id, and nothing else", () => {
    expect(Object.keys(GOAL_LABELS).sort()).toEqual([...GOAL_IDS].sort());
  });

  it("each in plain words: capitalised, no hyphen, never the id itself", () => {
    for (const id of GOAL_IDS) {
      const words = GOAL_LABELS[id];
      expect(words, id).toMatch(/^[A-Z][a-z]*(?: [a-z]+)*$/);
      expect(words, id).not.toBe(id);
    }
  });

  it("reads as the athlete would say it", () => {
    expect(GOAL_LABELS["aerobic-base"]).toBe("Aerobic base");
    expect(GOAL_LABELS["condition-care"]).toBe("Condition care");
    expect(GOAL_LABELS.ski).toBe("Ski");
  });
});
