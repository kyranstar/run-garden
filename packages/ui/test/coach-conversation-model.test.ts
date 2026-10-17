/**
 * THE COACH'S CONVERSATION, PURE (the new shape §5, stream C): what the sheet decides that needs no React and no network.
 *
 *  - the conversation read tolerantly (a newer server's fields, a turn missing a list, a card of an unknown kind);
 *  - the opening screen's one coach line, from the day's own data (no model call): the readiness first (it is about the
 *    day), else the week's focus (said as the week's), else the day's session, else a plain question;
 *  - the starter chips: general ones, or ones for what the coach sees, by its kind;
 *  - which turns show (a conversation the athlete left is not shown) and the turns a send started that the read hasn't
 *    caught up with;
 *  - which conversation a send continues: the known one, a new one after "New conversation", the server's choice only
 *    when the read failed;
 *  - a card open (its full card) or closed (one line, what came of it); a turn's stop line when the server said none.
 *
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { CoachConversationDto, CoachConversationTurnDto, CoachRunEventDto, TodayResponse } from "@rg/api-client";
import {
  BOX_PLACEHOLDER_NEW,
  BOX_PLACEHOLDER_REPLY,
  boxPlaceholder,
  cardIsOpen,
  cardOutcome,
  closedCardLine,
  conversationToSend,
  GENERAL_CHIPS,
  openingLine,
  starterChips,
  turnsShown,
  turnStopLine,
  type ProvisionalTurn,
} from "../src/screens/studio/coach-conversation-model.js";
import { toConversation } from "../src/screens/studio/coach-tolerance.js";
import { answerOf, appliedChangeLine, isAnswerEvent, isSetScope, runLines, statusWord } from "../src/screens/studio/run-model.js";
import { dayFocus, moveFocus, objectiveFocus, workoutFocus } from "../src/screens/studio/coach-focus.js";

const TODAY = "2026-10-17";

const turn = (over: Partial<CoachConversationTurnDto> = {}): CoachConversationTurnDto => ({
  runId: "run-1",
  at: `${TODAY}T08:00:00.000Z`,
  words: "Something for my hips",
  status: "finished",
  line: "Here's a gentle one for your hips.",
  cards: [],
  question: null,
  ...over,
});

const today = (over: Partial<TodayResponse> = {}): TodayResponse =>
  ({
    today: TODAY,
    todaySessions: [],
    readiness: { latest: null, baseline: null, sampleDays: 0, verdict: null },
    focus: null,
    ...over,
  }) as unknown as TodayResponse;

describe("the conversation, read tolerantly", () => {
  it("a known shape passes as it is", () => {
    const c: CoachConversationDto = {
      id: "run-1",
      startedAt: `${TODAY}T08:00:00.000Z`,
      turns: [
        turn({
          cards: [{ kind: "workout", proposalId: "dp-run-1", title: "Hips, gently", summary: "Today · Now · 24 min · Maintain", status: "pending" }],
          question: { text: "Home or gym?", choices: ["Home", "Gym"] },
        }),
      ],
    };
    expect(toConversation(c)).toEqual(c);
  });

  it("nothing, or no conversation: no id and no turns", () => {
    expect(toConversation(null)).toEqual({ id: null, startedAt: null, turns: [] });
    expect(toConversation({ id: null, startedAt: null, turns: [] })).toEqual({ id: null, startedAt: null, turns: [] });
    expect(toConversation({ turns: "nope" })).toEqual({ id: null, startedAt: null, turns: [] });
  });

  it("a turn with no run id is dropped; missing lists are empty; a card with no suggestion id is dropped; an unknown card kind passes", () => {
    const c = toConversation({
      id: "run-1",
      startedAt: "x",
      turns: [
        { words: "lost" },
        { runId: "run-2", at: "a", status: "finished", line: 7, cards: [{ kind: "workout" }, { kind: "a_newer_kind", proposalId: "dp-2", title: 3 }] },
      ],
    });
    expect(c.turns).toHaveLength(1);
    const t = c.turns[0]!;
    expect(t).toMatchObject({ runId: "run-2", words: null, line: null, question: null });
    expect(t.cards).toEqual([{ kind: "a_newer_kind", proposalId: "dp-2", title: "A suggestion", summary: "", status: "" }]);
  });

  it("a question: its words and its choices; a two-question ask and a check pass through; one with no words is none", () => {
    const t = toConversation({
      id: "r",
      turns: [
        { runId: "r", status: "waiting_athlete", question: { text: "Home or gym?", choices: ["Home", 4, "Gym"], questions: [{ text: "Home or gym?", choices: ["Home", "Gym"], why: "w" }] } },
        { runId: "s", status: "waiting_athlete", question: { text: "", choices: ["x"] } },
        { runId: "t", status: "waiting_athlete", question: { text: "Today's jaw check first?", choices: [], check: true } },
      ],
    }).turns;
    expect(t[0]!.question).toEqual({ text: "Home or gym?", choices: ["Home", "Gym"], questions: [{ text: "Home or gym?", choices: ["Home", "Gym"], why: "w" }] });
    expect(t[1]!.question).toBeNull();
    expect(t[2]!.question).toEqual({ text: "Today's jaw check first?", choices: [], check: true });
  });
});

describe("the opening screen's coach line (no model call)", () => {
  it("the morning's readiness first: it is about the day", () => {
    const poor = today({ readiness: { verdict: { level: "poor", reasons: ["x"] } } as never, focus: { text: "Build the long run.", at: TODAY } });
    expect(openingLine(poor)).toBe("Recovery is low this morning — a gentle day would suit you.");
    expect(openingLine(today({ readiness: { verdict: { level: "caution", reasons: ["x"] } } as never }))).toBe("A middling morning — steady suits today.");
    expect(openingLine(today({ readiness: { verdict: { level: "good", reasons: ["x"] } } as never }))).toBe("You're well recovered this morning — today can take its full effort.");
  });

  it("no readiness: the week's focus, said as the week's, its first sentence", () => {
    expect(openingLine(today({ focus: { text: "Keep the long run easy. Then a tempo on Thursday.", at: TODAY } }))).toBe("This week: keep the long run easy.");
  });

  it("neither: the day's session still to do; else a plain question", () => {
    const withSession = today({
      todaySessions: [{ workout: { id: "w1", title: "Hips & posture", category: "strength", completionState: "scheduled" }, build: null }] as never,
    });
    expect(openingLine(withSession)).toBe("Today: Hips & posture.");
    const done = today({
      todaySessions: [{ workout: { id: "w1", title: "Hips & posture", category: "strength", completionState: "completed" }, build: null }] as never,
    });
    expect(openingLine(done)).toBe("What would help today?");
    const rest = today({ todaySessions: [{ workout: { id: "w2", title: "Rest", category: "rest", completionState: "scheduled" }, build: null }] as never });
    expect(openingLine(rest)).toBe("What would help today?");
    expect(openingLine(undefined)).toBe("What would help today?");
  });
});

describe("the starter chips", () => {
  it("nothing seen: the general ones, with an objective's question when there is a short one", () => {
    expect(starterChips(null)).toEqual(GENERAL_CHIPS);
    expect(starterChips(null, { objective: "Wall sit" })).toEqual(["Something for right now", "Plan my week", "How is “Wall sit” going?", "I'm sore"]);
    // Too long for a chip: none.
    expect(starterChips(null, { objective: "Hold a strong two-minute wall sit before the ski trip" })).toEqual(GENERAL_CHIPS);
  });

  it("a workout seen: shorten it, move it, and why — a run's said as a run", () => {
    const strength = workoutFocus({ id: "w1", title: "Strength", effectiveDate: TODAY, workoutSeconds: 2400, calendarSeconds: null, category: "strength" });
    expect(starterChips(strength)).toEqual(["Shorten it", "Move it", "Why this session?"]);
    const runW = workoutFocus({ id: "w2", title: "Long run", effectiveDate: TODAY, workoutSeconds: 3600, calendarSeconds: null, category: "run" });
    expect(starterChips(runW)).toEqual(["Shorten it", "Move it", "Why this run?"]);
  });

  it("a day, a move, an objective: their own", () => {
    expect(starterChips(dayFocus(TODAY))).toEqual(["Plan this day", "Make it lighter", "I'm short on time"]);
    expect(starterChips(moveFocus({ id: "gobletSquat", name: "Goblet squat" }))).toEqual(["Build a workout around it", "How do I do it well?", "Something like it"]);
    expect(starterChips(objectiveFocus({ id: "o1", title: "Wall sit" }))).toEqual(["How is it going?", "Plan toward it", "A test for it"]);
    expect(starterChips({ kind: "session", id: "s1", label: "Sat 17 Oct · Hips" })).toEqual(["How did it go?", "What should come next?"]);
    expect(starterChips({ kind: "activity", id: "a1", label: "Sat 17 Oct · Run" })).toEqual(["How did it go?", "What should come next?"]);
  });

  it("2 to 4 chips, always", () => {
    for (const f of [null, dayFocus(TODAY), moveFocus({ id: "m", name: "M" }), { kind: "proposal" as const, id: "dp-1", label: "x" }]) {
      const n = starterChips(f).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    }
  });
});

describe("the turns shown", () => {
  const read = (over: Partial<CoachConversationDto> = {}): CoachConversationDto => ({ id: "run-1", startedAt: "x", turns: [turn()], ...over });

  it("the read's turns, then a turn a send started that the read hasn't caught up with — once", () => {
    const sent: ProvisionalTurn[] = [{ runId: "run-2", words: "Make it shorter", at: "b", status: "active" }];
    const shown = turnsShown(read(), null, sent);
    expect(shown.map((t) => t.runId)).toEqual(["run-1", "run-2"]);
    expect(shown[1]).toMatchObject({ words: "Make it shorter", status: "active", line: null, cards: [], question: null });
    // Caught up: the read's own turn, never two.
    const caught = turnsShown(read({ turns: [turn(), turn({ runId: "run-2", status: "stepping", line: null })] }), null, sent);
    expect(caught.map((t) => t.runId)).toEqual(["run-1", "run-2"]);
    expect(caught[1]!.status).toBe("stepping");
  });

  it("a conversation the athlete left ('New conversation') is not shown; its turns come back with nothing", () => {
    expect(turnsShown(read(), "run-1", [])).toEqual([]);
    expect(turnsShown(read(), "run-9", []).map((t) => t.runId)).toEqual(["run-1"]);
    // A new one's own turns show even before its read.
    expect(turnsShown(read(), "run-1", [{ runId: "run-3", words: "Plan my week", at: "c", status: "active" }]).map((t) => t.runId)).toEqual(["run-3"]);
    expect(turnsShown(undefined, null, []).map((t) => t.runId)).toEqual([]);
  });

  it("the box says 'Ask anything' with nothing shown, 'Reply' inside a conversation", () => {
    expect(boxPlaceholder(0)).toBe(BOX_PLACEHOLDER_NEW);
    expect(boxPlaceholder(2)).toBe(BOX_PLACEHOLDER_REPLY);
    expect(BOX_PLACEHOLDER_NEW).toBe("Ask anything");
    expect(BOX_PLACEHOLDER_REPLY).toBe("Reply");
  });
});

describe("which conversation a send continues", () => {
  const read = (id: string | null): CoachConversationDto => ({ id, startedAt: null, turns: [] });
  it("the one the server just named, else the one read", () => {
    expect(conversationToSend({ read: read("run-1"), readFailed: false, created: "run-5", left: null })).toBe("run-5");
    expect(conversationToSend({ read: read("run-1"), readFailed: false, created: null, left: null })).toBe("run-1");
  });
  it("after 'New conversation', or with none read: a new one (null)", () => {
    expect(conversationToSend({ read: read("run-1"), readFailed: false, created: null, left: "run-1" })).toBeNull();
    expect(conversationToSend({ read: read("run-1"), readFailed: false, created: "run-1", left: "run-1" })).toBeNull();
    expect(conversationToSend({ read: read(null), readFailed: false, created: null, left: null })).toBeNull();
  });
  it("the read failed and nothing is known: the server decides (left out)", () => {
    expect(conversationToSend({ read: undefined, readFailed: true, created: null, left: null })).toBeUndefined();
    // …unless the athlete asked for a new one.
    expect(conversationToSend({ read: undefined, readFailed: true, created: null, left: "run-1" })).toBeNull();
  });
});

describe("a card: open, or one line of what came of it", () => {
  const card = (kind: "workout" | "plan_changes" | "set", status: string) => ({ kind, proposalId: "dp-1", title: "Hips, gently", summary: "Sun 12 PM · 10 min · Recover", status });
  it("open while the athlete still decides", () => {
    expect(cardIsOpen(card("workout", "pending"))).toBe(true);
    expect(cardIsOpen(card("set", "partially_approved"))).toBe(true);
    for (const s of ["approved", "declined", "superseded", "expired", "rejected", "something_newer"]) expect(cardIsOpen(card("workout", s))).toBe(false);
  });
  it("what came of it, a change said as a change", () => {
    expect(cardOutcome(card("workout", "approved"))).toBe("Added to your plan");
    expect(cardOutcome(card("plan_changes", "approved"))).toBe("Done");
    expect(cardOutcome(card("workout", "declined"))).toBe("Not added");
    expect(cardOutcome(card("plan_changes", "declined"))).toBe("Left as planned");
    expect(cardOutcome(card("workout", "superseded"))).toBe("Replaced");
    expect(cardOutcome(card("workout", "expired"))).toBe("Its day passed");
    expect(cardOutcome(card("workout", "rejected"))).toBe("Couldn't be made");
    expect(cardOutcome(card("workout", "something_newer"))).toBe("something newer");
  });
  it("its one line: title, summary, outcome", () => {
    expect(closedCardLine(card("workout", "superseded"))).toBe("Hips, gently · Sun 12 PM · 10 min · Recover — Replaced");
    expect(closedCardLine({ ...card("workout", "approved"), summary: "" })).toBe("Hips, gently — Added to your plan");
  });
});

describe("a turn's stop line, when the server said none", () => {
  it("a run over with no words says what happened; a finished one with nothing says it is done; a live one nothing", () => {
    expect(turnStopLine("stepping")).toBeNull();
    expect(turnStopLine("waiting_athlete")).toBeNull();
    expect(turnStopLine("finished")).toBe("Done.");
    expect(turnStopLine("cancelled")).toBe("Cancelled.");
    expect(turnStopLine("expired")).toBe("This ran out of time.");
    expect(turnStopLine("failed")).toBe("The coach stopped before it finished.");
    expect(turnStopLine("failed", "gateway_402")).toBe("The AI account is out of credits. The coach can design again once credits are added.");
    expect(turnStopLine("stopped_cap", "weekly_cap")).toBe("This week's AI budget is used up. The coach can design again next week.");
  });
});

describe("the server's new words (stream A: plan powers, answers, the auto scope)", () => {
  const before = { date: "2026-10-18", time: "08:55", minutes: 30 };
  it("each change the coach can now make says what it did: Eased, Swapped, Removed, Put back", () => {
    const was = appliedChangeLine("skip", before).slice("Skipped".length);
    expect(appliedChangeLine("ease", before)).toBe(`Eased${was}`);
    expect(appliedChangeLine("swap", before)).toBe(`Swapped${was}`);
    expect(appliedChangeLine("remove", before)).toBe(`Removed${was}`);
    expect(appliedChangeLine("restore", before)).toBe(`Put back${was}`);
    // One this bundle doesn't know: said as a change, never a code.
    expect(appliedChangeLine("a_newer_kind" as never, before)).toBe(`Changed${was}`);
  });

  const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({ seq, kind, summary, payload, at: "x" });
  const long = `${"Your wall sit is up fifteen seconds in two weeks, held clean each time. ".repeat(10)}Keep the same rhythm.`;

  it("an answer is the coach's words: a finish's receipt says so, or a text-only answer's note — its whole summary", () => {
    const finish = [ev(1, "tool_call", "Finishing", { tool: "finish" }), ev(2, "tool_result", long, { tool: "finish", ok: true, receipt: { final: true, answer: true } })];
    expect(answerOf(finish)).toBe(long);
    expect(answerOf([ev(1, "note", "Up 15 seconds.", { final: true, answer: true })])).toBe("Up 15 seconds.");
    // A finish that proposed is no answer; nor a line with nothing in it.
    expect(answerOf([ev(1, "tool_result", "Here's your session.", { tool: "finish", ok: true, receipt: { final: true } })])).toBeNull();
    expect(answerOf([ev(1, "note", "  ", { answer: true })])).toBeNull();
    expect(isAnswerEvent(finish[1]!)).toBe(true);
    expect(isAnswerEvent(finish[0]!)).toBe(false);
  });

  it("in the conversation an answer is never a trail line too: the coach's words are the turn's", () => {
    const events = [
      ev(1, "note", "Read your last two weeks."),
      ev(2, "tool_call", "Finishing", { tool: "finish", toolUseId: "t1" }),
      ev(3, "tool_result", long, { tool: "finish", toolUseId: "t1", ok: true, receipt: { final: true, answer: true } }),
      ev(4, "note", "Up.", { answer: true }),
    ];
    expect(runLines(events).map((l) => l.summary)).toContain(long);
    expect(runLines(events, { answers: false }).map((l) => l.summary)).toEqual(["Read your last two weeks."]);
  });

  it("an auto run is never named by its scope: the coach at work is designing", () => {
    expect(statusWord({ status: "active", error: null, scope: { kind: "auto" } })).toBe("designing");
    expect(isSetScope({ scope: { kind: "auto" } })).toBe(false);
  });
});
