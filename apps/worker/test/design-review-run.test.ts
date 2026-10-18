/**
 * THE REVIEW OF A DESIGNED RUN (§8 §3): the rubric is chosen by the draft's discipline. A run is judged on its
 * intention, the request, its structure (warm-up → work → cool-down, the intensity fitting the day), progression
 * (volume and the long run's share against what was run), recovery (hard running and hard leg strength nearby), pace
 * (the efforts against the athlete's threshold), honesty and the words — and `parseReview` takes the draft's own list.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc } from "@rg/domain";
import { lineReview } from "../src/services/design-manifest.js";
import { REVIEW_DIMENSIONS, roleBlock, RUN_REVIEW_DIMENSIONS, reviewDimensions } from "../src/services/design-prompt.js";
import { parseReview, reviewPacket, reviewRubricOf } from "../src/services/design-review.js";

const RUN_DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
  ],
  source: { kind: "coach" },
};

const verdict = (ids: readonly string[], score = 4, over: Record<string, number> = {}) => ({
  scores: Object.fromEntries(ids.map((d) => [d, over[d] ?? score])),
  notes: Object.fromEntries(ids.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [] as string[],
  improvements: [] as string[],
});
const RUN_IDS = RUN_REVIEW_DIMENSIONS.map((d) => d.id);
const WORKOUT_IDS = REVIEW_DIMENSIONS.map((d) => d.id);

describe("the run rubric", () => {
  it("intention, the request, structure, progression, recovery, pace, honesty and the words", () => {
    expect(RUN_IDS).toEqual(["intent", "request", "structure", "progression", "recovery", "pace", "honesty", "words"]);
    expect(reviewDimensions("run")).toBe(RUN_REVIEW_DIMENSIONS);
    expect(reviewDimensions("workout")).toBe(REVIEW_DIMENSIONS);
    const q = (id: string) => RUN_REVIEW_DIMENSIONS.find((d) => d.id === id)!.question;
    expect(q("structure")).toMatch(/warm-up.*cool-down/i);
    expect(q("pace")).toMatch(/threshold/);
    expect(q("recovery")).toMatch(/48 hours/);
  });

  it("is chosen by the draft's discipline", () => {
    expect(reviewRubricOf(RUN_DOC)).toBe("run");
    expect(reviewRubricOf({ ...RUN_DOC, parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { reps: 10 } }] }] })).toBe("workout");
  });

  it("the reviewer's block carries both, the run's said to be for a run", () => {
    const block = roleBlock("reviewer", 4);
    // Every dimension in full: its own in the run's list, those it shares with the workout rubric in that one (named once
    // in the run's: the block's size, design-prompt.test.ts).
    for (const d of RUN_REVIEW_DIMENSIONS) expect(block).toContain(`- ${d.id} — ${d.label}: ${d.question}`);
    expect(block.split("- request — ")).toHaveLength(2);
    expect(block).toContain(`A run is scored on the run rubric instead (the packet says when the draft is one; its paces are the app's, from the athlete's threshold): ${RUN_IDS.join(", ")} — request, honesty, words as above:`);
  });

  it("a run's packet says it is a run, which rubric, and where its paces come from", () => {
    const packet = reviewPacket({ round: 1, draft: { proposalId: "dp-x", target: { kind: "new", date: "2026-03-10" }, date: "2026-03-10", doc: RUN_DOC, issues: [], derived: { minutes: 50 } }, records: [] });
    expect(packet).toContain(`This draft is a run: score it on the run rubric — ${RUN_IDS.join(", ")}.`);
    expect(packet).toContain("Its paces are the app's, computed from the athlete's threshold (the running line gives each effort's band)");
  });
});

describe("parseReview takes the draft's own dimensions", () => {
  it("a run's review: the run's dimensions, exactly", () => {
    expect(parseReview(verdict(RUN_IDS), "run")).toMatchObject({ scores: Object.fromEntries(RUN_IDS.map((d) => [d, 4])), mustFix: [] });
    const asWorkout = parseReview(verdict(WORKOUT_IDS), "run");
    expect("error" in asWorkout && asWorkout.why).toContain("scores: missing structure, pace");
    expect("error" in asWorkout && asWorkout.why).toContain('scores: no dimension "sequencing"');
    expect("error" in asWorkout && asWorkout.fix).toContain(RUN_IDS.join(", "));
  });

  it("a low run dimension is must-fix by its own label", () => {
    expect(parseReview(verdict(RUN_IDS, 4, { pace: 2 }), "run")).toMatchObject({ mustFix: ["Pace: pace: as it should be."] });
  });

  it("a workout's review is as it was — the default", () => {
    expect("error" in parseReview(verdict(WORKOUT_IDS))).toBe(false);
    expect("error" in parseReview(verdict(WORKOUT_IDS), "workout")).toBe(false);
    expect("error" in parseReview(verdict(RUN_IDS))).toBe(true);
  });
});

describe("the card shows a run's review in its own rubric's order and words", () => {
  it("structure and pace by their labels, in the run's order", () => {
    const v = parseReview(verdict(RUN_IDS, 4, { pace: 3 }), "run");
    if ("error" in v) throw new Error(v.why);
    const shown = lineReview({ ...v, rounds: 1 } as never)!;
    expect(shown.dimensions.map((d) => d.label)).toEqual(RUN_REVIEW_DIMENSIONS.map((d) => d.label));
    expect(shown.dimensions.find((d) => d.id === "pace")).toMatchObject({ label: "Pace", score: 3 });
  });
});
