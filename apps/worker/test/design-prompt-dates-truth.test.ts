/**
 * THE CARD'S LINES ARE THE TRUTH ABOUT DATES, AND A CHANGE NAMES WHO MAKES IT (R1.7; r1-7/BRIEF.md "Build" 2, and the
 * coordinator's copy rule of 23 Nov). On 23 Nov the coach couldn't see why TRE's 7 Dec was held back: it guessed at a leftover
 * skip, then told the owner 7 Dec was scheduled. The main block now says the card's computed lines and read_plans' heldBack
 * are the truth about a plan's dates, never to be contradicted or guessed past; and, the owner's rule, that a change is said
 * with who makes it, never as if a thing moved itself. Only the main coach answers the athlete about the plan: the designer's
 * and the reviewer's blocks say none of it.
 */
import { describe, expect, it } from "vitest";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";

const main = roleBlock("main");
const others = [roleBlock("designer"), roleBlock("reviewer"), roleBlock("reviewer", undefined, "run"), SHARED_PROMPT].join("\n");

export const DATES_TRUTH_LINE =
  "A card's computed lines (Next, Not …, Taken off) and read_plans' heldBack are the truth about a plan's dates: never contradict them or guess past them; explain with the reason they give, or say you don't know.";
export const WHO_LINE =
  "Say who makes a change (\"I'll move it to Mondays\", \"Fridays will be taken off\"), never as if a thing changed itself (\"Reading moves to 4:00\", \"Fridays come off\").";

describe("the main coach's block", () => {
  it("holds the card's computed lines as the truth about dates", () => {
    expect(main).toContain(DATES_TRUTH_LINE);
    expect(others).not.toContain("heldBack");
  });
  it("says who makes a change, next to it", () => {
    expect(main).toContain(`${DATES_TRUTH_LINE} ${WHO_LINE}`);
    expect(others).not.toContain("Fridays will be taken off");
  });
});
