/**
 * COACH EVERYWHERE, PHASE A1 — the prompt's line per focus kind (design-prompt.ts `FOCUS_LINES`): what the athlete most
 * likely wants when they asked from there. Generic by construction (the repository is public): no condition, no
 * personal fact; only the tools the coach has. The opening context carries the one line of the run's focus.
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { FOCUS_KINDS } from "../src/services/design-focus.js";
import { FOCUS_LINES, PROMPT_TOOL_NAMES } from "../src/services/design-prompt.js";

const profileWords = (): string[] =>
  Object.values(PROFILES).flatMap((p) => [p.id, p.label, p.check.label, ...(p.setFlag ? [p.setFlag.label] : []), ...(p.care ? [p.care.block.label] : []), ...Object.keys(p.attributes)]);

describe("the focus lines", () => {
  it("one line per kind, verbatim (pinned)", () => {
    expect(Object.keys(FOCUS_LINES).sort()).toEqual([...FOCUS_KINDS].sort());
    expect(FOCUS_LINES).toEqual({
      workout:
        "They asked from a planned workout: they most likely want it changed, swapped or explained. A workout whose revisable is true is revised with propose_workout (target revise, from get_workout's rev); one whose revisable says no: take its instead — a programme session or a watch-plan run is skipped or moved with adjust_plan, and yours designed beside it. If its day has passed, design what comes next. Say how yours relates to it.",
      day: "They asked from a day on the plan: they most likely want that day planned or changed. Design for that date, around what it already holds — and say how yours fits with it. If the day has passed, design what comes next.",
      session:
        "They asked from a session they did: they most likely want what comes next to answer to it — easier, harder or different, by how it went. Read its sets with read_history before you dose from it.",
      activity:
        "They asked from an activity the watch recorded: they most likely want what comes next to fit around it — recovery after a hard effort, or the next session.",
      objective:
        "They asked from an objective: they most likely want a workout that serves it, or a test that measures it. Name it in intent.objectiveIds; read_objectives says where each measure stands.",
      move: "They asked from a move in the library: they most likely want it in a workout, or to know where it fits. Build around it when it fits the day; when a rule or the place stands in the way, say why and offer the closest move that fits.",
      proposal:
        "They asked from your open suggestion: they want to change it. Propose the changed workout with propose_workout — the same day unless they asked otherwise, keeping what they didn't ask to change — and it replaces that suggestion once it is ready.",
    });
  });

  it("each is one line, short, and generic — no condition the profiles know", () => {
    for (const kind of FOCUS_KINDS) {
      const line = FOCUS_LINES[kind];
      expect(line, kind).not.toContain("\n");
      expect(line.length, kind).toBeLessThanOrEqual(430);
      for (const w of profileWords()) expect(line.toLowerCase(), `${kind}: ${w}`).not.toContain(w.toLowerCase());
    }
  });

  it("names only the coach's own tools", () => {
    for (const kind of FOCUS_KINDS) {
      for (const word of FOCUS_LINES[kind].match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
        expect(PROMPT_TOOL_NAMES as readonly string[], `${kind}: ${word}`).toContain(word);
      }
    }
  });

  it("the suggestion's line: the athlete wants it changed — propose the changed workout, and it replaces the suggestion", () => {
    expect(FOCUS_LINES.proposal).toMatch(/want to change it/);
    expect(FOCUS_LINES.proposal).toMatch(/Propose the changed workout with propose_workout/);
    expect(FOCUS_LINES.proposal).toMatch(/replaces that suggestion/);
  });
});
