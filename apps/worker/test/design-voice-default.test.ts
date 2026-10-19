/**
 * THE COACH'S DEFAULT VOICE (2026-10-19, the owner's voice; chosen from production replays in the voice workshop: "brisk
 * next looks probably best. The coach doesn't need to apologize"). What the athlete reads at the end of a run — the
 * finish line on a suggestion, a change, a set or a plan, or an answer in words — is brisk and direct, leads with what
 * changed or what the answer is, carries one next step the card doesn't show, never apologizes, doesn't repeat the card,
 * stays short, and names a check-in number only when it is the reason. Criteria, in the main coach's block (the one
 * that writes those words); the shared finish line points there and no longer asks for anything else. The workshop's
 * own voice block (coach-voice.ts) is unchanged, so its "brisk" and "next_step" still mean what they meant.
 */
import { describe, expect, it } from "vitest";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { ANSWER_MAX, LINE_MAX } from "../src/services/design-tools/finish.js";
import { VOICE_LINES } from "../src/services/coach-voice.js";

const main = roleBlock("main");
const others = [roleBlock("designer"), roleBlock("reviewer"), roleBlock("reviewer", undefined, "run")].join("\n");
const voice = main.split("\n").find((l) => l.startsWith("- Your last words")) ?? "";
const finishLine = SHARED_PROMPT.split("\n").find((l) => l.startsWith("- finish:")) ?? "";

describe("the coach's default voice, in the main coach's block", () => {
  it("covers every last word the athlete reads: a finish line on a suggestion, a change, a set or a plan, or an answer", () => {
    expect(voice).toContain("- Your last words — the finish line on a suggestion, a change, a set or a plan, or an answer in words:");
    expect(others).not.toContain("Your last words");
  });

  it("brisk and direct, leading with what changed or the answer; one next step the card doesn't show, unless there honestly is none", () => {
    expect(voice).toContain("brisk and direct, leading with what changed or what the answer is; then");
    expect(voice).toContain("then one next step the card doesn't show — how to do it, what to watch for, or when — unless there honestly is none.");
  });

  it("no apologies: corrected, it says so plainly and acts", () => {
    expect(voice).toContain('No apologies: when the athlete corrects you, say so plainly and act ("Upper back\'s out — …").');
    // Nowhere does the prompt ask for one.
    expect([SHARED_PROMPT, main, others].join("\n")).not.toMatch(/\bsorry\b|apologi[sz]e (for|that)/i);
  });

  it("doesn't repeat the card; a suggestion's line stays near 180 characters; a check-in number only when it is the reason", () => {
    expect(voice).toContain("Don't repeat the card (its moves, minutes, dates or what it replaces) unless that is the point.");
    expect(voice).toContain("A suggestion's line stays near 180 characters.");
    // An answer's own length is the scope line's, as before.
    expect(main).toContain("call finish with the answer, up to about 900 characters, and suggest nothing");
    expect(voice).toContain("A check-in number only when it is the reason for the choice.");
    // The caps clip, never refuse: the line's hard cap and the answer's are as they were.
    expect([LINE_MAX, ANSWER_MAX]).toEqual([300, 900]);
  });

  it("the shared finish line points to it, and no longer asks for 'one plain line … what you suggested'", () => {
    expect(finishLine).toContain("- finish: end the run with your last words to the athlete (the main coach's block says how)");
    expect(finishLine).not.toContain("one plain line");
    expect(finishLine).not.toContain("what they will do");
    // What it still holds (fix waves 13a–13d).
    expect(finishLine).toContain("never the review, the app or a flaw (fix it with amend, or leave it out)");
    expect(finishLine).toContain('say "replaces" only when willReplace names it');
  });

  it("the workshop's voice block is unchanged: its brisk and next_step mean what they meant", () => {
    expect(VOICE_LINES.tone.brisk).toBe("Tone: brisk and direct. Lead with the point; no preamble, no softening.");
    expect(VOICE_LINES.include.next_step).toBe("Include one next step for them: what to do, or what to notice.");
  });
});
