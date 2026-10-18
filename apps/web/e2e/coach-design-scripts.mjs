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
 *   big      as `now`, its proposing answer over 16 KB: its calls run in the step after the one that read it
 *   followup as `now`, but a run asked from one of its suggestions proposes that workout shorter (coach everywhere)
 *   auto_answer  an auto run (no scope: the new shape §5) that answers in words — reads, then finishes, nothing suggested
 *   auto_design  an auto run that designs one workout for right now (today, no time), as `now`
 *   reply        the conversation: as `now`, until the conversation so far holds a workout it suggested — then that
 *                workout shorter, naming it in `replaces`
 *   plan_change  the conversation: skips the session the athlete is looking at (adjust_plan), then finishes
 *   auto_set     an auto run that plans a set: plan_set with two briefs (tomorrow, three days on), each designed and
 *                reviewed, then the finish
 *   whole_plan   whole plans (§8 §5): reads the plans, then a new four-week 10K block from next Monday (its first week
 *                filled in, three shape weeks); asked to extend it — the request says "extend" and the conversation so far
 *                holds the plan it suggested — two more shape weeks for that block; then the finish
 *
 * `ctx.opening` is the run's opening message (its first user message's text): a script may read what the run was
 * asked from in it.
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
          {
            kind: "exercise",
            libraryId: "bridge",
            dose: { sets: 3, reps: 12, restSec: 45 },
            why: "Wakes the glutes before the trunk work.",
            alternates: [{ libraryId: "singleLegBridge", why: "harder, one side at a time" }],
          },
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

/**
 * As `now`, but the turn that proposes says a great deal first: its answer is over the worker's DOCUMENT_ANSWER_BYTES
 * (16 KB), so the step that reads it runs none of its calls — they wait, queued, for the next step (coach-runs.ts).
 */
function designBig(turn, ctx) {
  const answer = designAfter(0)(turn, ctx);
  if (turn !== 1) return answer;
  const musing = "Weighing the hips against the back, the warm-up against the time, and the bridges against the floor space. ".repeat(180);
  return { ...answer, content: [{ type: "text", text: musing }, ...answer.content.filter((b) => b.type !== "text")] };
}

/** The follow-up's changed workout (coach everywhere, A2): the same session, shorter — the bird dogs left out. */
export function shorterDoc() {
  const doc = mobilityDoc();
  return { ...doc, title: "Hips and back, shorter", parts: [{ ...doc.parts[0], items: doc.parts[0].items.slice(0, 2) }] };
}

/**
 * As `now`, until a run is asked from one of the coach's own suggestions (the opening message's "The athlete asked
 * from: your suggestion …" block, coach everywhere A1): then it proposes the changed workout, which replaces that
 * suggestion (A2).
 */
function designFollowUp(turn, ctx) {
  if (!/The athlete asked from: your suggestion/.test(ctx.opening ?? "")) return designAfter(0)(turn, ctx);
  switch (turn) {
    case 0:
      return uses(["propose_workout", { doc: shorterDoc(), target: { kind: "new", date: ctx.today } }]);
    default:
      return uses(["finish", { summary: "The same session, shorter: the bird dogs left out." }]);
  }
}

/** A day `n` after `today` ("YYYY-MM-DD"). */
function dayAfter(today, n) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The words an auto run answers a question with (the new shape §5): a finish with words only, nothing suggested. */
export const AUTO_ANSWER =
  "Your holds have grown steadily over the last three weeks. Keep them twice a week, and add ten seconds when the last one feels easy.";

/** An auto run that answers in words: it reads the history, then finishes with the answer — nothing suggested. */
function autoAnswer(turn, ctx) {
  return turn === 0 ? uses(["read_history", { from: dayAfter(ctx.today, -21), to: ctx.today }]) : uses(["finish", { summary: AUTO_ANSWER }]);
}

/**
 * An auto run that plans a set (the new shape §5): plan_set with two briefs — raising the run to a set's ceiling — each
 * designer drafting its day's workout, each reviewed, then the main coach's finish.
 */
function autoSetMain(turn, ctx) {
  if (turn === 0) {
    const brief = (key, n) => ({
      key,
      date: dayAfter(ctx.today, n),
      purpose: "Hips and trunk, steady.",
      emphasis: "Control over load.",
      constraints: "About 20 minutes, at home.",
      why: "Spaced away from the runs.",
      // The fixture plan holds a programme session on most days: a short piece beside it, said so.
      sameDayWhy: "A short, gentle piece beside the day's session.",
    });
    return uses(["plan_set", { briefs: [brief("first", 1), brief("second", 3)] }]);
  }
  return uses(["finish", { summary: "Two short sessions, spaced around your runs." }]);
}

/** A set's designer: its brief's day (from the opening message's "Read the brief for …" day), a draft, a finish. */
function autoSetDesigner(turn, ctx) {
  if (turn === 0) {
    // The brief's own line: "Date: Thu 14 May (2026-05-14)." (design-orchestrate.ts `briefText`).
    const date = /Date: [^(\n]*\((\d{4}-\d{2}-\d{2})\)/.exec(ctx.opening ?? "")?.[1] ?? ctx.today;
    return uses(["propose_workout", { doc: mobilityDoc(), target: { kind: "new", date } }]);
  }
  return uses(["finish", {}]);
}

/**
 * A reply in the conversation (the new shape §5): as `now` — until the opening's "The conversation so far" holds a
 * workout it suggested; then it proposes that workout shorter, naming it in `replaces` (the coach's own follow-up).
 */
function designReply(turn, ctx) {
  const id = [...(ctx.opening ?? "").matchAll(/Suggested a workout \(id ([^)\s]+)\)/g)].at(-1)?.[1];
  if (!id) return designAfter(0)(turn, ctx);
  switch (turn) {
    case 0:
      return uses(["propose_workout", { doc: shorterDoc(), target: { kind: "new", date: ctx.today }, replaces: id }]);
    default:
      return uses(["finish", { summary: "The same session, shorter: the bird dogs left out." }]);
  }
}

/** The words a plan change finishes with. */
export const PLAN_CHANGE_LINE = "One session off, so the legs come back for the weekend.";

/** What a plan change says when the run was asked from nothing it could change: the journey fails on it. */
export const NO_FOCUS_LINE = "No session was seen: nothing to change.";

/**
 * A change to the plan (the new shape §5, the coach's reach): it skips the session the athlete is looking at — the
 * opening's "The athlete asked from: a planned workout (id …)" — then finishes; no workout. Asked from nothing (no focus
 * posted), it changes nothing and says so, never falling back on another session: the journey that expects the change
 * fails (the integrated review).
 */
function planChange(turn, ctx) {
  const id = /a planned workout \(id ([^)\s]+)\)/.exec(ctx.opening ?? "")?.[1];
  if (!id) return uses(["finish", { summary: NO_FOCUS_LINE }]);
  if (turn === 0) return uses(["adjust_plan", { workoutId: id, change: { kind: "skip", reason: "A lighter day." }, why: "The legs asked for a lighter day." }]);
  return uses(["finish", { summary: PLAN_CHANGE_LINE }]);
}

/** The Monday after `today` (never today): a plan's first day. */
function nextMonday(today) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return dayAfter(today, ((8 - dow) % 7) || 7);
}

/** The finish's words for a new block, and for its extension. */
export const PLAN_LINE = "Four weeks that build to your 10K, easy days kept easy.";
export const EXTEND_LINE = "Two more weeks on the end of your 10K build.";

const run = (title, category, minutes, intensity = "easy") => ({ category, title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity }] } });

/**
 * Whole plans (§8 §5): read the plans, then propose one change to their shape and finish. Asked to extend (the request
 * says "extend", and the conversation so far names the plan this script suggested), the block made from it — its id is
 * the applier's, `cp-<proposal>-0` — gets two more shape weeks; otherwise a new block.
 */
function wholePlan(turn, ctx) {
  const opening = ctx.opening ?? "";
  const request = opening.slice(opening.lastIndexOf("The athlete's request"));
  const suggested = [...opening.matchAll(/Suggested a plan \(id ([^)\s]+)\)/g)].at(-1)?.[1];
  const extend = /extend/i.test(request) && suggested;
  const monday = nextMonday(ctx.today);
  if (turn === 0) return uses(["read_plans", {}]);
  if (turn === 1 && extend) {
    const weeks = [4, 5].map((w) => ({ weekStart: dayAfter(monday, 7 * w), volumeTarget: "about 30 km", keySessions: ["long run", "strides"] }));
    return uses(["propose_plan", { change: { kind: "extendPlan", planId: `cp-${suggested}-0`, shapeWeeks: weeks }, why: "Two easier weeks to hold what you built." }]);
  }
  if (turn === 1) {
    return uses([
      "propose_plan",
      {
        change: {
          kind: "createPlan",
          discipline: "run",
          name: "10K build",
          startDate: monday,
          endDate: dayAfter(monday, 27),
          raceDate: dayAfter(monday, 27),
          firmSessions: [
            { date: monday, session: run("Easy run", "easy", 40) },
            { date: dayAfter(monday, 2), session: run("Tempo run", "quality", 45, "threshold") },
            { date: dayAfter(monday, 4), session: run("Easy run", "easy", 35) },
            { date: dayAfter(monday, 6), session: run("Long run", "long", 70) },
          ],
          shapeWeeks: [1, 2, 3].map((w) => ({ weekStart: dayAfter(monday, 7 * w), volumeTarget: w === 3 ? "taper, about 20 km" : "about 32 km", keySessions: w === 3 ? ["openers", "race Sunday"] : ["tempo", "long run"] })),
        },
        why: "A steady build: one quality day, one long run, the rest easy.",
      },
    ]);
  }
  return uses(["finish", { summary: extend ? EXTEND_LINE : PLAN_LINE }]);
}

export const SCRIPTS = {
  // §8 §5: whole plans in the conversation.
  whole_plan: { main: wholePlan, reviewer },
  now: { main: designAfter(0), reviewer },
  // The conversation (the new shape §5): a reply that changes the suggestion before it; a change to the plan.
  reply: { main: designReply, reviewer },
  plan_change: { main: planChange, reviewer },
  // The new shape §5: a run asked with no scope is the coach's to size.
  auto_answer: { main: autoAnswer, reviewer },
  auto_design: { main: designAfter(0), reviewer },
  auto_set: { main: autoSetMain, designer: autoSetDesigner, reviewer },
  followup: { main: designFollowUp, reviewer },
  big: { main: designBig, reviewer },
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
