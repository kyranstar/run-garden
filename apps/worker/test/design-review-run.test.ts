/**
 * THE REVIEW OF A DESIGNED RUN (§8 §3): the rubric is chosen by the draft's discipline. A run is judged on its
 * intention, the request, its structure (warm-up → work → cool-down, the intensity fitting the day), progression
 * (volume and the long run's share against what was run), recovery (hard running and hard leg strength nearby), pace
 * (the efforts against the athlete's threshold), honesty and the words — and `parseReview` takes the draft's own list.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { RUN_LIMITS } from "../src/services/design-limits.js";
import { lineReview } from "../src/services/design-manifest.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { REVIEW_DIMENSIONS, roleBlock, RUN_REVIEW_DIMENSIONS, reviewDimensions } from "../src/services/design-prompt.js";
import { parseReview, reviewPacket, reviewRubricOf, submitReview, submitReviewSchema } from "../src/services/design-review.js";
import { toolSpecs } from "../src/services/coach-runs.js";
import { proposeWorkout } from "../src/services/design-tools/propose.js";

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

  it("the reviewer's block carries its draft's rubric only: a strength review never reads the run's", () => {
    const run = roleBlock("reviewer", 4, "run");
    const workout = roleBlock("reviewer", 4);
    for (const d of RUN_REVIEW_DIMENSIONS) expect(run).toContain(`- ${d.id} — ${d.label}: ${d.question}`);
    for (const d of REVIEW_DIMENSIONS) expect(workout).toContain(`- ${d.id} — ${d.label}: ${d.question}`);
    expect(run).not.toContain("- sequencing — ");
    expect(workout).not.toContain("- pace — ");
    expect(workout).not.toContain("- structure — ");
    // The rest of the block is the same text: one rubric swapped for the other.
    const without = (block: string, ids: readonly { id: string; label: string; question: string }[]) =>
      ids.reduce((b, d) => b.replace(`- ${d.id} — ${d.label}: ${d.question}\n`, ""), block);
    expect(without(run, RUN_REVIEW_DIMENSIONS)).toBe(without(workout, REVIEW_DIMENSIONS));
    expect(roleBlock("reviewer", 4, "workout")).toBe(workout);
  });

  it("a run's packet says it is a run, which rubric, and where its paces come from", () => {
    const packet = reviewPacket({ round: 1, draft: { proposalId: "dp-x", target: { kind: "new", date: "2026-03-10" }, date: "2026-03-10", doc: RUN_DOC, issues: [], derived: { minutes: 50 } }, records: [] });
    expect(packet).toContain(`This draft is a run: score it on the run rubric — ${RUN_IDS.join(", ")}.`);
    expect(packet).toContain("Its paces are the app's, computed from the athlete's threshold (the running line gives each effort's band)");
  });
});

describe("a run's reviewer is built with the run's block", () => {
  it("its opening context's role block is the run rubric's; any other reviewer's the workout one's", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const reviewer = { id: "rv-1", role: "reviewer" as const, scope: { kind: "now" }, request: null, parentId: "run-1", packet: "# What to review" };
    const now = new Date("2026-03-10T16:00:00Z");
    const run = await buildDesignContext(db, {} as Env, userId, { ...reviewer, rubric: "run" }, now);
    expect(run.system[1]!.text).toBe(roleBlock("reviewer", RUN_LIMITS.reviewer.maxCalls, "run"));
    const workout = await buildDesignContext(db, {} as Env, userId, reviewer, now);
    expect(workout.system[1]!.text).toBe(roleBlock("reviewer", RUN_LIMITS.reviewer.maxCalls));
    // Only a reviewer's block changes: the shared prefix, cached first, is one text for both.
    expect(run.system[0]!.text).toBe(workout.system[0]!.text);
  });
});

describe("submit_review's schema is its rubric's: every dimension parseReview demands, required", () => {
  it("a workout's is the schema as it always was, byte for byte (before §8)", () => {
    const capWords = (chars: number) => `at most about ${Math.max(5, Math.round(chars / 6.5 / 5) * 5)} words (${chars} characters)`;
    const SCORE = { type: "integer", minimum: 1, maximum: 5 };
    const NOTE = { type: "string", minLength: 1 };
    const ITEM = { type: "string", minLength: 1 };
    const before = {
      type: "object",
      properties: {
        scores: { type: "object", properties: Object.fromEntries(WORKOUT_IDS.map((d) => [d, SCORE])), required: [...WORKOUT_IDS], additionalProperties: false },
        notes: {
          type: "object",
          description: `One line per dimension, written to the athlete: ${capWords(240)} each.`,
          properties: Object.fromEntries(WORKOUT_IDS.map((d) => [d, NOTE])),
          required: [...WORKOUT_IDS],
          additionalProperties: false,
        },
        mustFix: { type: "array", maxItems: 8, description: `Each one concrete change, ${capWords(240)}.`, items: ITEM },
        improvements: { type: "array", maxItems: 6, description: `Each one concrete change, ${capWords(240)}.`, items: ITEM },
        accepted: {
          type: "array",
          maxItems: 3,
          description: "Costs the athlete chose in their own words: the dimension whose score they lower (never condition_safety), and the cost.",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string", enum: WORKOUT_IDS.filter((d) => d !== "condition_safety") },
              why: { type: "string", minLength: 1, description: "The cost they chose, in a few words to them: \"heavier legs for Sunday's run\"." },
            },
            required: ["dimension", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores", "notes", "mustFix", "improvements"],
      additionalProperties: false,
    };
    expect(JSON.stringify(submitReview.inputSchema)).toBe(JSON.stringify(before));
    expect(JSON.stringify(submitReviewSchema("workout"))).toBe(JSON.stringify(before));
  });

  it("each rubric's required lists are what parseReview demands of it: all of them pass, any one left out is refused", () => {
    for (const rubric of ["workout", "run"] as const) {
      const schema = submitReviewSchema(rubric) as { properties: { scores: { required: string[]; properties: object }; notes: { required: string[] } } };
      const ids = reviewDimensions(rubric).map((d) => d.id);
      expect(schema.properties.scores.required).toEqual(ids);
      expect(schema.properties.notes.required).toEqual(ids);
      expect(Object.keys(schema.properties.scores.properties)).toEqual(ids);
      expect("error" in parseReview(verdict(schema.properties.scores.required), rubric)).toBe(false);
      for (const left of ids) expect("error" in parseReview(verdict(ids.filter((d) => d !== left)), rubric), `${rubric} without ${left}`).toBe(true);
    }
  });

  it("a run's reviewer is offered the run's; every other run, each tool as it declares itself", () => {
    const tools = [submitReview, proposeWorkout];
    const forRun = toolSpecs(tools, { reviewOf: { proposalId: "p", designerRunId: "d", toolUseId: "t", round: 1, rubric: "run" } });
    expect(forRun.find((t) => t.name === "submit_review")!.input_schema).toEqual(submitReviewSchema("run"));
    expect(forRun.find((t) => t.name === "propose_workout")!.input_schema).toBe(proposeWorkout.inputSchema);
    const forWorkout = toolSpecs(tools, { reviewOf: { proposalId: "p", designerRunId: "d", toolUseId: "t", round: 1 } });
    expect(forWorkout.find((t) => t.name === "submit_review")!.input_schema).toBe(submitReview.inputSchema);
    expect(toolSpecs(tools, {}).find((t) => t.name === "submit_review")!.input_schema).toBe(submitReview.inputSchema);
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
