/**
 * TASK 13'S FIX WAVE, THE PROMPT (fix13-brief.md, S2): each rule the four audits asked for, pinned where it lives — the
 * shared prefix every role reads, or one role's block. Generic by construction (design-prompt.test.ts holds the text to
 * the profiles' words and its size).
 */
import { describe, expect, it } from "vitest";
import { RUN_LIMITS } from "../src/services/coach-runs.js";
import { REVIEW_DIMENSIONS, roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";

const line = (tool: string): string => SHARED_PROMPT.split("\n").find((l) => l.startsWith(`- ${tool}:`)) ?? "";
const main = roleBlock("main");
const reviewer = roleBlock("reviewer");

describe("the shared prefix (every role)", () => {
  it("13a A1: planned is not done — ask, or design so it is right either way; never name a workout by an unconfirmed session", () => {
    expect(SHARED_PROMPT).toContain("a planned session is not a done one");
    expect(SHARED_PROMPT).toContain("and nothing is logged, ask; if you don't, design so it is right either way, and never name or justify a workout by it.");
    expect(SHARED_PROMPT).toContain("- A big planned session with nothing logged, when whether it happened changes the design:");
  });

  it("13d D3: one plain line of what it weighed, beside the tool call — the main coach's and a designer's, never the reviewer's (round 2, I1)", () => {
    const d3 = "When you choose — a draft's shape, a move over its rivals, what a revision changes — say why in one plain line of text beside the tool call";
    expect(roleBlock("main")).toContain(d3);
    expect(roleBlock("designer")).toContain(d3);
    // The reviewer's turn text would be critique on the trail before the review is shown.
    expect(SHARED_PROMPT).not.toContain(d3);
    expect(roleBlock("reviewer")).not.toContain(d3);
    expect(roleBlock("reviewer")).toContain("Write no text beside your calls: your verdict goes only in submit_review.");
  });

  it("13a A5 + A2: unaccustomed means the movement — a first exposure capped, sets short of failure; with no logged sets, set 1 is the test", () => {
    expect(SHARED_PROMPT).toContain("Unaccustomed means the movement, not only its tempo");
    expect(SHARED_PROMPT).toContain("the first session caps its volume and keeps sets short of failure, whatever the request");
    expect(SHARED_PROMPT).toContain("With no logged sets for a lift, set 1 is the test");
  });

  it("13a A6: a runner's week, and a programme's core lift stays in its block", () => {
    expect(SHARED_PROMPT).toContain("- A strength week around running: hard days hard, easy days easy — lower-body strength on a quality-run day or a day without a run, never the day after the long run, and 48 hours clear of the next lower-body session.");
    expect(SHARED_PROMPT).toContain("A programme's core lift belongs to its block: outside its sessions, use a complementary lift, or dose it from the block's last logged sets and say how it counts.");
  });

  it("13a A7: a test is done the same way every time, and its protocol remembered", () => {
    expect(SHARED_PROMPT).toContain("A test is done the same way every time — after the warm-up, before other work on those muscles, fresh — so results compare; remember the protocol after the first.");
  });

  it("13d D6: elastic work at zero for weeks is coverage debt a set starts to pay, gated with its recovery-mode alternate", () => {
    expect(SHARED_PROMPT).toContain("often elastic work — is coverage debt; a set is the place to start paying it: a gated move on a later day, with its recovery-mode alternate.");
  });

  it("13a A12 / 13d D6, D10: the condition check is asked before a develop or peak day and when a flare or symptom is told", () => {
    expect(SHARED_PROMPT).toContain("would develop or peak, or the athlete tells of a flare or a symptom: ask_athlete({ check: \"condition\", why })");
  });

  it("13a A8 / 13b M7: a request too vague to act on gets one question with three tappable directions", () => {
    expect(SHARED_PROMPT).toContain("- A request too vague to act on — no length, place or aim, none in the profile, no open suggestion that fits: one question, three tappable directions");
  });

  it("13a A13 / 13c R14: a goal the profile doesn't hold is asked about; only the athlete's own body", () => {
    expect(SHARED_PROMPT).toContain("A goal the profile doesn't hold is asked about (is it new?), never corrected.");
    expect(SHARED_PROMPT).toContain("The app designs for the athlete's own body");
    expect(line("record_answer")).toContain("about the athlete's own body");
  });

  it("13d D9: mobility, flows included — 'yoga' names only a yoga programme", () => {
    expect(SHARED_PROMPT).toContain('strength, mobility (flows included), condition care, or a mix; "yoga" names only a yoga programme');
    expect(SHARED_PROMPT).not.toMatch(/mobility, yoga,/);
  });

  it("§2.2, §2.3, §2.5: the amend path, and what a review's result carries", () => {
    expect(line("propose_workout")).toContain("propose_workout({ amend: true, changeNote }): checked again, no new review, no round.");
    expect(line("propose_workout")).toContain("the open suggestions it would replace (willReplace)");
    expect(SHARED_PROMPT).toContain("An improvement that corrects a fact or removes an unexplained cost, or a validator note words can fix, is an amend; nothing else needs a round.");
  });

  it("13a A3, 13c R2, R16, 13d D10: the last line — never a flaw or a review item, 'suggestion', 'replaces' only when willReplace says so, no check reminders", () => {
    const finish = line("finish");
    expect(finish).toContain("never the review, the app or a flaw (fix it with amend, or leave it out)");
    expect(finish).toContain('Say "suggestion", not "proposal"');
    expect(finish).toContain('say "replaces" only when willReplace names it');
    expect(finish).toContain("Don't remind them about checks: the app asks at the start and end of a session.");
  });

  it("13c R8: a suggestion read back is built on with basedOn kind proposal", () => {
    expect(line("list_workouts and get_workout")).toContain("or proposal for a suggestion, read back with get_workout({ proposalId, opId }).");
  });
});

describe("the main coach's block", () => {
  it("13a A8: the open suggestions first — one that answers the request is the answer", () => {
    // The opening index lists them (S3, 13b §1): the line points there first.
    expect(main).toContain('Read the open suggestions first: the index\'s "open suggestions" line, read_proposals for more. One that already answers the request is the answer');
  });

  it("13c R7: a request bigger than the scope gets what the scope allows, and Plan ahead named", () => {
    expect(main).toContain("A request bigger than the scope — a week asked for from Now — gets what the scope allows, and your last line says Plan ahead plans the week.");
  });

  it("13c R1: Now leaves the time out unless the athlete named one", () => {
    expect(main).toContain("Now: leave target.time out unless the athlete named a time");
  });

  it("13b I7: a set asks what would change days or purposes before plan_set", () => {
    expect(main).toContain("before plan_set ask what would change which days or what for — whether a planned outing happened, how an area feels, time or place for the week");
  });
});

describe("the reviewer's block (13a A4, 13b I5, I8, 13c R5, R15)", () => {
  it("the rubric with its new dimensions, and the calibration line", () => {
    for (const id of ["fit", "request", "words"]) expect(reviewer, id).toContain(`- ${id} — `);
    expect(reviewer).not.toContain("time_fit");
    expect(REVIEW_DIMENSIONS.find((d) => d.id === "honesty")!.question).toContain("from the log or their answer, never the plan");
    expect(reviewer).toContain("Score by the anchors: a note naming a gap the athlete would feel is a 3, not a 4; 5 means you have nothing to add.");
    expect(reviewer).toContain("An explained cost is still a cost: explaining it makes it honest, not good.");
  });

  it("must-fix also: a statement the tools contradict, and a fixable validator note neither fixed nor explained", () => {
    expect(reviewer).toContain("Also must-fix: a statement the tool results contradict (a wrong fact, day or figure), and a validator note the document neither fixes nor explains");
  });

  it("a cost the athlete chose is never the coach's dosing nor condition safety; its why is written to them", () => {
    expect(reviewer).toContain('its why the cost they chose in a few words to them ("heavier legs for Sunday\'s run") — never your own dosing choices, and never condition safety.');
  });

  it("its words are the athlete's: 'you', moves by name, never ids, tools or app words", () => {
    expect(reviewer).toContain('Your notes, must-fix items, improvements and accepted reasons are shown to the athlete: write to them ("you"), name moves by their names — never ids, tools, fields or app words.');
    expect(reviewer).toContain("the draft (each move named, with its condition ratings)");
  });

  it("13b I9: the days around the draft's day are in its opening message, so it doesn't re-read the plan", () => {
    expect(reviewer).toContain("the days around the draft's day (planned and done — no need to read the plan for them)");
    expect(REVIEW_DIMENSIONS.find((d) => d.id === "recovery")!.question).toContain("the days either side (in your opening message)");
  });
});

describe("compact (the cached prefix grew 3k tokens since the pre-live audit)", () => {
  it("the shared prefix stays near 5k tokens and each role block well under its limit", () => {
    // §8 (2026-10-18): 5,200 until §8's prompt streams — R's run lines, W's two plan-tool lines — measured 5,656; the whole
    // prefix's growth is coach-shape-pins.test.ts's to hold.
    expect(SHARED_PROMPT.length / 4).toBeLessThanOrEqual(5660);
    for (const role of ["main", "designer", "reviewer"] as const) expect(roleBlock(role, RUN_LIMITS[role].maxCalls).length / 4, role).toBeLessThanOrEqual(1300);
    // A run's reviewer (§8 §3): the block with the run rubric in place of the workout one — its own cached prefix.
    expect(roleBlock("reviewer", RUN_LIMITS.reviewer.maxCalls, "run").length / 4).toBeLessThanOrEqual(1300);
  });
});
