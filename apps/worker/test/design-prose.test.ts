/**
 * PROSE FITTED TO WHERE IT LANDS (Task 13's fix wave). `clipProse` cuts an over-long line at a sentence end (a model
 * can't count characters, so a line a little over its cap is clipped, never refused); `athleteText` turns the
 * reviewer's packet words — library ids, tool names, field names, "validator" — into what the athlete reads.
 * Generic text only.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import { athleteText, clipProse } from "../src/services/design-prose.js";
import { PROMPT_TOOL_NAMES } from "../src/services/design-prompt.js";

const nameOf = (id: string) => EXERCISES.find((e) => e.id === id)!.name;

describe("clipProse", () => {
  it("leaves a text that fits as it is (trimmed)", () => {
    expect(clipProse("  Two short sentences. Both fit.  ", 40)).toBe("Two short sentences. Both fit.");
  });

  it("cuts an over-long text after its last sentence end inside the cap", () => {
    const text = "Easy hips today. Keep the breath slow. Then a longer third sentence that runs past the cap by a lot.";
    const out = clipProse(text, 50);
    expect(out).toBe("Easy hips today. Keep the breath slow.");
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("counts a closing quote or bracket with its sentence", () => {
    expect(clipProse('You said "go easy." So it is gentle. And then far too much more text follows here.', 40)).toBe('You said "go easy." So it is gentle.');
  });

  it("with no sentence end in the back half, cuts at a word and marks it", () => {
    const text = "One long sentence with no full stop that keeps on going well beyond any sensible cap at all";
    const out = clipProse(text, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("an early sentence end that would keep less than half is not used", () => {
    const out = clipProse("Short. Then one very long clause that goes on and on without stopping anywhere near the cap", 60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeGreaterThan(30);
  });

  it("never exceeds the cap, at any cap", () => {
    const text = "Warm up first. Then the main set, slow and controlled! Finish with breathing? Yes. ".repeat(6);
    for (let max = 10; max <= text.length + 5; max += 7) expect(clipProse(text, max).length).toBeLessThanOrEqual(max);
  });
});

describe("athleteText", () => {
  it("names library moves instead of their ids, backticks or not", () => {
    expect(athleteText("Swap jawIsoOpen ahead of `physiologicalSigh`.")).toBe(`Swap ${nameOf("jawIsoOpen")} ahead of ${nameOf("physiologicalSigh")}.`);
  });

  it("turns every tool name into plain words, and leaves no snake_case behind", () => {
    for (const tool of PROMPT_TOOL_NAMES) {
      const out = athleteText(`As ${tool} shows, keep it.`);
      expect(out).not.toMatch(/\b[a-z]+_[a-z]+\b/);
    }
    expect(athleteText("read_balance has no hinge work.")).toBe("Your recent balance has no hinge work.");
    expect(athleteText("Fine. read_plan shows a run.")).toBe("Fine. Your plan shows a run.");
    expect(athleteText("as get_exercise says")).toBe("as the move's details says");
  });

  it("splits other camelCase field names into words", () => {
    expect(athleteText("lastTrained is null and neckLoad ≤1.")).toBe("last trained is null and neck load ≤1.");
  });

  it("says the app's checks for the validator", () => {
    expect(athleteText("The validator raised nothing.")).toBe("The app's checks raised nothing.");
    expect(athleteText("No validator notes.")).toBe("No app check notes.");
    expect(athleteText("the validator's note stands")).toBe("the app's note stands");
    expect(athleteText("Validator: clean")).toBe("App check: clean");
  });

  it("says watch for coros, and a watch move's name (or 'a watch move') for its code", () => {
    expect(athleteText("coros sessions are in")).toBe("watch sessions are in");
    expect(athleteText("coros:ZZZ-not-a-code was logged")).toBe("A watch move was logged");
    expect(athleteText("Only coros:ZZZ-not-a-code was logged")).toBe("Only a watch move was logged");
  });

  it("speaks to the athlete where it safely can", () => {
    expect(athleteText("The athlete asked for a hard day; the athlete's legs are fresh.")).toBe("You asked for a hard day; your legs are fresh.");
  });

  it("leaves plain prose alone", () => {
    const plain = "Hold each stretch for five slow breaths, then rest.";
    expect(athleteText(plain)).toBe(plain);
  });
});
