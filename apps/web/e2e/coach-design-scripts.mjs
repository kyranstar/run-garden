/* eslint-disable */
/**
 * THE SCRIPTED COACH DESIGNER (Stage 3 Task 9) — the scripts the fixture stack's stand-in model serves
 * (coach-design-model.mjs). The worker names one with `AI_DESIGN_MODEL=scripted:<name>`, a setting it honours in
 * fixture mode only (llm-messages.ts `designModel`); everything downstream of these bytes is the real worker: the
 * opening context, the tools, the reviewer sub-run, the proposal, the approve.
 *
 * A script is stateless, like the model: each answer is chosen from the request alone — the run's role (its system
 * block names it) and how many turns it has had (the assistant messages in its history). Today's date is read from the
 * opening message ("Today is <weekday>, <YYYY-MM-DD>, …"), so a workout is always proposed for the athlete's own today.
 *
 * Generic content only: a mobility session of the library's own moves, no personal data.
 *
 *   now      reads the day and the library, proposes, is reviewed, finishes
 *   ask      asks one question first (chips and words), then as `now`
 *   check    asks for today's condition check first, then as `now`
 *   credits  the AI account is out of credits (402) at the first call: nothing is proposed
 *   slow     as `now`, each answer three seconds late (a live run to look at)
 */

/** A turn calling tools, the way the model answers. */
const uses = (...calls) => ({
  content: [{ type: "text", text: "" }, ...calls.map(([name, input], i) => ({ type: "tool_use", id: `toolu_${name}_${i}_${Math.random().toString(36).slice(2, 10)}`, name, input }))],
  stop_reason: "tool_use",
});

/** The workout every script proposes: calm, short, the library's own moves. */
export function mobilityDoc() {
  return {
    version: 1,
    title: "Hips and back, gently",
    intent: { summary: "Open the hips, wake the glutes and brace the trunk.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "main",
        format: "straight",
        items: [
          { kind: "exercise", libraryId: "bridge", dose: { sets: 3, reps: 12, restSec: 45 } },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: 3, reps: 8, restSec: 45 } },
          { kind: "exercise", libraryId: "birdDog", dose: { sets: 2, reps: 8, restSec: 30 } },
        ],
      },
    ],
    source: { kind: "studio" },
  };
}

/** The main coach's design, after any question: read, propose, finish. `offset` is the turns its question took. */
function designAfter(offset) {
  return (turn, ctx) => {
    switch (turn - offset) {
      case 0:
        return uses(["read_day", { date: ctx.today }], ["search_library", { query: "hips" }]);
      case 1:
        return uses(["propose_workout", { doc: mobilityDoc(), target: { kind: "new", date: ctx.today } }]);
      default:
        return uses(["finish", { summary: "A short hips session for today, reviewed and ready to approve." }]);
    }
  };
}

/** The reviewer: one review, every dimension the tool asks for scored. */
function reviewer(_turn, ctx) {
  const scores = Object.fromEntries(ctx.dimensions.map((d, i) => [d, i === 1 ? 4 : 5]));
  const notes = Object.fromEntries(ctx.dimensions.map((d) => [d, "Fits the day and the request."]));
  return uses(["submit_review", { scores, notes, mustFix: [], improvements: ["Hold the last bridge for a slow count of three."] }]);
}

export const SCRIPTS = {
  now: { main: designAfter(0), reviewer },
  slow: { main: designAfter(0), reviewer, delayMs: 3000 },
  ask: {
    main: (turn, ctx) =>
      turn === 0
        ? uses([
            "ask_athlete",
            { questions: [{ text: "How do your hips feel today?", chips: ["Tight", "Okay", "Loose"], why: "It decides how long the warm-up is." }] },
          ])
        : designAfter(1)(turn, ctx),
    reviewer,
  },
  check: {
    main: (turn, ctx) =>
      turn === 0 ? uses(["ask_athlete", { check: "condition", why: "The session starts with gentle jaw work; today's check decides how much." }]) : designAfter(1)(turn, ctx),
    reviewer,
  },
  credits: { main: () => ({ status: 402 }), reviewer: () => ({ status: 402 }) },
};
