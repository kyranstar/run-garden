/**
 * WHAT THE COACH SEES, AND THE PIECES AROUND IT (coach everywhere; the new shape §5), as markup and as functions:
 *
 *  - what each kind of focus is called ("Fri 23 Oct · Strength · 40 min"), a workout's kind kept for the chips;
 *  - the one Ask the Today card keeps: "Ask" with the coach mark, which opens the coach seeing what it is about — and
 *    is not there at all without the coach;
 *  - the box: "Seeing: …" with a ✕ named for what it drops, and the round send button named Send;
 *  - the suggestion's card: no "Change something…" line (the conversation's box replies), and one part of a
 *    suggestion — its workouts, or its changes — shown alone.
 *
 * Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, DesignLineDto, WorkoutDto } from "@rg/api-client";
import { dayLabel } from "@rg/domain";
import { AskCoach, CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { activityFocus, dayFocus, moveFocus, objectiveFocus, workoutFocus } from "../src/screens/studio/coach-focus.js";
import { CoachBox } from "../src/screens/studio/coach-conversation.js";
import { designProposalQuery, ProposalCard } from "../src/screens/studio/proposal-card.js";
import { primedClient, staticRouter, text } from "./studio-fixtures.js";

const TODAY = "2026-10-21";
const recorder = (): CoachOpener & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return { calls, open: (args) => calls.push(args) };
};

const workout = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w1",
    title: "Strength",
    category: "strength",
    effectiveDate: "2026-10-23",
    effectiveTime: "18:00",
    workoutSeconds: 2400,
    calendarSeconds: 3300,
    ...over,
  }) as WorkoutDto;

describe("what a focus is called, and the scope it asks for", () => {
  it("a planned workout: its day, its title, its minutes (the plan's own, else its calendar block), and its kind", () => {
    expect(workoutFocus(workout())).toEqual({ kind: "workout", id: "w1", date: "2026-10-23", label: "Fri 23 Oct · Strength · 40 min", category: "strength" });
    expect(workoutFocus(workout({ workoutSeconds: null })).label).toBe("Fri 23 Oct · Strength · 55 min");
  });

  it("a day, an objective, a move", () => {
    expect(dayFocus("2026-10-23")).toEqual({ kind: "day", id: "2026-10-23", date: "2026-10-23", label: "Fri 23 Oct" });
    // One date format with the server's own words (its refusal: "Ask about a day from …"): the domain's dayLabel.
    expect(dayFocus("2026-10-23").label).toBe(dayLabel("2026-10-23"));
    expect(objectiveFocus({ id: "o1", title: "Hold a strong wall sit" })).toEqual({ kind: "objective", id: "o1", label: "Hold a strong wall sit" });
    expect(moveFocus({ id: "gobletSquat", name: "Goblet squat" })).toEqual({ kind: "move", id: "gobletSquat", label: "Goblet squat" });
  });

  it("an activity: the session it logged when it holds one, else the activity itself", () => {
    const a = {
      id: "a1",
      date: "2026-10-20",
      title: "Evening run",
      sport: "run",
      durationSeconds: 2700,
      distanceMeters: 8000,
      performed: null,
    } as unknown as ActivityDto;
    expect(activityFocus(a)).toEqual({ kind: "activity", id: "a1", date: "2026-10-20", label: "Tue 20 Oct · Evening run · 45 min" });
    const logged = { ...a, title: null, sport: "strength", performed: { id: "s1", source: "app", mode: "build", theme: "Full-body strength", checks: [], played: null } } as unknown as ActivityDto;
    expect(activityFocus(logged)).toEqual({ kind: "session", id: "s1", date: "2026-10-20", label: "Tue 20 Oct · Full-body strength · 45 min" });
    // An older server's row says no session id: the activity, then.
    const older = { ...logged, performed: { ...logged.performed, id: undefined } } as unknown as ActivityDto;
    expect(activityFocus(older).kind).toBe("activity");
  });

});

describe("the Ask affordance", () => {
  const focus = workoutFocus(workout());
  const html = (opener: CoachOpener | null, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(CoachOpenContext.Provider, { value: opener }, createElement(AskCoach, { focus, ...extra })));

  it("without the coach (no sheet in the app): nothing at all", () => {
    expect(html(null)).toBe("");
  });

  it("with it: a small button, 'Ask' with the coach mark, named for what it asks about", () => {
    const out = html(recorder());
    expect(out).toMatch(/^<button type="button" class="btn btn-small ask-coach" data-focus="workout:w1" aria-label="Ask the coach about Fri 23 Oct · Strength · 40 min">/);
    expect(out).toContain("<svg");
    expect(out).toMatch(/>Ask<\/span><\/button>$/);
  });

  it("its own words where an entry point has them (the objectives' words-carrying links)", () => {
    const out = html(recorder(), { label: "Ask the coach for a test", variant: "link" });
    expect(out).toMatch(/class="linklike tap-pad ask-coach-link"/);
    expect(out).toContain(">Ask the coach for a test</span>");
    expect(out).toContain('aria-label="Ask the coach for a test: Fri 23 Oct · Strength · 40 min"');
  });
});

describe("the box", () => {
  const box = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(CoachBox, {
        boxRef: { current: null },
        draft: "",
        onDraft: () => undefined,
        placeholder: "Ask anything",
        canSend: false,
        onSend: () => undefined,
        seeing: null,
        onDropSeeing: () => undefined,
        ...props,
      }),
    );

  it("what the coach sees, muted over the box, with a ✕ named for what it drops", () => {
    const out = box({ seeing: workoutFocus(workout()) });
    expect(out).toContain('<p class="coach-seeing">');
    expect(out).toContain("Seeing: Fri 23 Oct · Strength · 40 min");
    expect(out).toMatch(/<button type="button" class="coach-seeing-drop tap-pad" aria-label="Stop showing the coach “Fri 23 Oct · Strength · 40 min”">/);
  });

  it("nothing seen: no line", () => {
    expect(box({})).not.toContain("coach-seeing");
  });

  it("the field is named by its placeholder; the round send button is named Send, and waits for words", () => {
    const out = box({});
    expect(out).toMatch(/<label class="visually-hidden" for="([^"]+)">Ask anything<\/label><textarea id="\1"/);
    expect(out).toMatch(/<button type="submit" class="coach-send" aria-label="Send" disabled="">/);
    expect(box({ canSend: true, draft: "hips" })).toMatch(/<button type="submit" class="coach-send" aria-label="Send">/);
  });
});

describe("the suggestion's card in the conversation", () => {
  const line = (opId: string, over: Partial<DesignLineDto> = {}): DesignLineDto =>
    ({
      opId,
      kind: "new",
      date: TODAY,
      time: null,
      atNow: true,
      title: `Workout ${opId}`,
      minutes: 24,
      summary: "",
      effort: "Maintain",
      place: "Home",
      parts: [],
      detail: [],
      reviewMean: 4.2,
      review: null,
      issues: [],
      outcome: null,
      written: null,
      ...over,
    }) as DesignLineDto;
  const skip = { opId: "c1", kind: "skip", workoutId: "w9", date: TODAY, time: null, summary: "Strength — skipped", was: null, effect: null, why: "", issues: [], outcome: null };
  const card = (read: Record<string, unknown>, part?: "workouts" | "changes") => {
    const qc = primedClient();
    qc.setQueryData(designProposalQuery("dp-r1"), { id: "dp-r1", resolvedAt: null, changes: [], ...read });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter("/studio", createElement(ProposalCard, { proposalId: "dp-r1", today: TODAY, part }))));
  };

  it("no 'Change something…' line: the conversation's box replies", () => {
    expect(card({ status: "pending", lines: [line("o1")] })).not.toContain("coach-pc-follow");
  });

  it("its workouts alone, or its changes alone (two cards of one suggestion); the changes headed as changes", () => {
    const both = { status: "pending", lines: [line("o1")], changes: [skip] };
    expect(text(card(both, "workouts"))).toContain("Workout o1");
    expect(text(card(both, "workouts"))).not.toContain("Strength — skipped");
    expect(text(card(both, "changes"))).toContain("Strength — skipped");
    expect(text(card(both, "changes"))).not.toContain("Workout o1");
    expect(card(both, "changes")).toContain(">Each change</h2>");
    // A part with nothing in it draws nothing.
    expect(card({ status: "pending", lines: [line("o1")], changes: [] }, "changes")).toBe("");
  });
});
