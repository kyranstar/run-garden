/**
 * THE MAIN COACH'S WORDS FOR A RHYTHM, A PROMISE AND TODAY'S SESSION (R1.6; DEBUG-tre-cadence §4 and §5). The owner asked for
 * TRE every two weeks; the coach could not set it, thinned the sessions by hand, promised "I'll skip the extras as they appear"
 * — which nothing carries out — and kept tomorrow's session beside today's unlogged one. The main block now routes a course's
 * schedule to change_plan, says how "every few weeks", "twice a month" and "monthly" read, forbids a promise no tool keeps,
 * and counts today's session first. Only the main coach routes and plans: a designer's and the reviewer's blocks say none of it.
 */
import { describe, expect, it } from "vitest";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";

const main = roleBlock("main");
const others = [roleBlock("designer"), roleBlock("reviewer"), roleBlock("reviewer", undefined, "run"), SHARED_PROMPT].join("\n");

// Fix round 1 (the review's MAJOR 1): a rhythm is a course's alone; nothing invites a programme's.
export const RHYTHM_LINE =
  "A course's days, time or rhythm from now on are change_plan's. A rhythm longer than a week is everyWeeks with the days: \"every few weeks\" is 2 or 3, chosen from the plan's brief and history, the card's why saying which; twice a month is every 2 weeks; monthly is every 4 weeks, and say plainly that isn't a calendar month. A programme runs every week.";
export const TODAY_LINE = "Before thinning a plan or adding to it, count a session on today not yet logged: it may already be this week's, or this rhythm's — ask, or count it.";
export const PROMISE_LINE =
  "Never promise a future or recurring action no tool carries out (\"I'll skip the extras as they appear\", \"I'll remind you\"): use the lever that does it, or say plainly it can't be done.";

describe("the main coach's block", () => {
  it("routes a course's schedule to change_plan, and reads a rhythm's words", () => {
    expect(main).toContain(RHYTHM_LINE);
    expect(others).not.toContain("everyWeeks");
    // No programme rhythm is invited anywhere.
    expect(main).not.toMatch(/programme's through change_programme|programme['’]s rhythm|programme every/i);
  });
  it("counts today's unlogged session before thinning or adding", () => {
    expect(main).toContain(TODAY_LINE);
    expect(others).not.toContain("not yet logged");
  });
  it("never promises what no tool carries out", () => {
    expect(main).toContain(PROMISE_LINE);
    expect(others).not.toContain("I'll skip the extras");
  });
});
