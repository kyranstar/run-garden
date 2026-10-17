/**
 * COACH EVERYWHERE, PHASE A3 — the pieces, as markup and as functions:
 *
 *  - what each kind of focus is called on its chip ("About: Fri Oct 23 · Strength · 40 min"), and the scope it asks
 *    for by default (a past session, an activity, an objective or a move → Now; a future day or workout → Later today
 *    or Plan ahead as fits; a suggestion → its own);
 *  - the one affordance every entry point wears: "Ask" with the coach mark, which opens the app's coach sheet with
 *    what it is about — and is not there at all without the coach;
 *  - the composer's chip, and the ✕ that takes it off;
 *  - the suggestion card's "Change something…" line: under a pending single-workout suggestion only.
 *
 * Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, DesignLineDto, WorkoutDto } from "@rg/api-client";
import { AskCoach, CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import {
  activityFocus,
  askableDay,
  dayFocus,
  focusScope,
  moveFocus,
  objectiveFocus,
  proposalFocus,
  workoutFocus,
  type CoachFocus,
} from "../src/screens/studio/coach-focus.js";
import { Composer } from "../src/screens/studio/composer.js";
import { designProposalQuery, ProposalCard, FOLLOW_UP_PLACEHOLDER } from "../src/screens/studio/proposal-card.js";
import { primedClient, staticRouter } from "./studio-fixtures.js";

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
  it("a planned workout: its day, its title, its minutes (the plan's own, else its calendar block)", () => {
    expect(workoutFocus(workout())).toEqual({ kind: "workout", id: "w1", date: "2026-10-23", label: "Fri Oct 23 · Strength · 40 min" });
    expect(workoutFocus(workout({ workoutSeconds: null })).label).toBe("Fri Oct 23 · Strength · 55 min");
  });

  it("a day, an objective, a move, a suggestion", () => {
    expect(dayFocus("2026-10-23")).toEqual({ kind: "day", id: "2026-10-23", date: "2026-10-23", label: "Fri Oct 23" });
    expect(objectiveFocus({ id: "o1", title: "Hold a strong wall sit" })).toEqual({ kind: "objective", id: "o1", label: "Hold a strong wall sit" });
    expect(moveFocus({ id: "gobletSquat", name: "Goblet squat" })).toEqual({ kind: "move", id: "gobletSquat", label: "Goblet squat" });
    const line = { title: "Hips, gently", date: TODAY, atNow: true } as Pick<DesignLineDto, "title" | "date" | "atNow">;
    expect(proposalFocus("dp-r1", line, TODAY)).toEqual({ kind: "proposal", id: "dp-r1", label: "Hips, gently", scope: "now" });
    expect(proposalFocus("dp-r1", { title: "Evening hips", date: TODAY }, TODAY).scope).toBe("later_today");
    // A single suggestion for another day came from a Now run that named it.
    expect(proposalFocus("dp-r1", { title: "Thursday hips", date: "2026-10-23" }, TODAY).scope).toBe("now");
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
    expect(activityFocus(a)).toEqual({ kind: "activity", id: "a1", date: "2026-10-20", label: "Tue Oct 20 · Evening run · 45 min" });
    const logged = { ...a, title: null, sport: "strength", performed: { id: "s1", source: "app", mode: "build", theme: "Full-body strength", checks: [], played: null } } as unknown as ActivityDto;
    expect(activityFocus(logged)).toEqual({ kind: "session", id: "s1", date: "2026-10-20", label: "Tue Oct 20 · Full-body strength · 45 min" });
    // An older server's row says no session id: the activity, then.
    const older = { ...logged, performed: { ...logged.performed, id: undefined } } as unknown as ActivityDto;
    expect(activityFocus(older).kind).toBe("activity");
  });

  it("the scope: Now for what is done or fixed; today's day or workout Later today; a later one Plan ahead; a suggestion its own", () => {
    for (const f of [
      { kind: "session", id: "s", label: "" },
      { kind: "activity", id: "a", label: "" },
      { kind: "objective", id: "o", label: "" },
      { kind: "move", id: "m", label: "" },
    ] as CoachFocus[]) {
      expect(focusScope(f, TODAY), f.kind).toBe("now");
    }
    for (const kind of ["workout", "day"] as const) {
      expect(focusScope({ kind, id: "x", label: "", date: "2026-10-20" }, TODAY), `${kind} past`).toBe("now");
      expect(focusScope({ kind, id: "x", label: "", date: TODAY }, TODAY), `${kind} today`).toBe("later_today");
      expect(focusScope({ kind, id: "x", label: "", date: "2026-10-22" }, TODAY), `${kind} later`).toBe("week");
    }
    expect(focusScope({ kind: "proposal", id: "p", label: "", scope: "later_today" }, TODAY)).toBe("later_today");
    expect(focusScope({ kind: "proposal", id: "p", label: "" }, TODAY)).toBeNull();
    // Today unknown: no guess from a date.
    expect(focusScope({ kind: "day", id: "x", label: "", date: "2026-10-22" }, null)).toBeNull();
  });

  it("a day the coach can be asked about: a week back to the last day Plan ahead plans (13 ahead)", () => {
    expect(askableDay("2026-10-14", TODAY)).toBe(true);
    expect(askableDay("2026-10-13", TODAY)).toBe(false);
    expect(askableDay("2026-11-03", TODAY)).toBe(true);
    expect(askableDay("2026-11-04", TODAY)).toBe(false);
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
    expect(out).toMatch(/^<button type="button" class="btn btn-small ask-coach" data-focus="workout:w1" aria-label="Ask the coach about Fri Oct 23 · Strength · 40 min">/);
    expect(out).toContain("<svg");
    expect(out).toMatch(/>Ask<\/span><\/button>$/);
  });

  it("its own words where an entry point had them (the objectives board's)", () => {
    const out = html(recorder(), { label: "Ask the coach for a test", variant: "link" });
    expect(out).toMatch(/class="linklike tap-pad ask-coach-link"/);
    expect(out).toContain(">Ask the coach for a test</span>");
    expect(out).toContain('aria-label="Ask the coach for a test: Fri Oct 23 · Strength · 40 min"');
  });
});

describe("the composer's chip", () => {
  const compose = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(Composer, { draft: "", onDraft: () => undefined, onStart: () => undefined, ...props }),
    );

  it("says what the athlete asked from, with a ✕ to take it off", () => {
    const out = compose({ about: workoutFocus(workout()), onClearAbout: () => undefined });
    expect(out).toContain('<p class="coach-about">');
    expect(out).toContain("About: Fri Oct 23 · Strength · 40 min");
    expect(out).toMatch(/<button type="button" class="coach-about-clear tap-pad" aria-label="Remove “Fri Oct 23 · Strength · 40 min”">/);
  });

  it("none without a focus", () => {
    expect(compose({})).not.toContain("coach-about");
  });

  it("the scope the focus asks for is the primary button", () => {
    const primary = (out: string) => (/<button type="button" class="btn btn-primary"[^>]*>([^<]+)</.exec(out) ?? [])[1];
    expect(primary(compose({ defaultScope: "now" }))).toBe("Now");
    expect(primary(compose({ defaultScope: "later_today" }))).toBe("Later today");
    expect(primary(compose({ defaultScope: "week" }))).toBe("Plan the next 7 days");
  });
});

describe("the card's 'Change something…' line", () => {
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
  const card = (read: Record<string, unknown>, onFollowUp?: (w: string) => void) => {
    const qc = primedClient();
    qc.setQueryData(designProposalQuery("dp-r1"), { id: "dp-r1", resolvedAt: null, changes: [], ...read });
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, staticRouter("/studio", createElement(ProposalCard, { proposalId: "dp-r1", today: TODAY, onFollowUp }))),
    );
  };
  const follow = () => undefined;

  it("under a pending single-workout suggestion: one line, labelled, with Send", () => {
    const out = card({ status: "pending", lines: [line("o1")] }, follow);
    expect(out).toContain('<form class="coach-pc-follow"');
    expect(out).toContain(`placeholder="${FOLLOW_UP_PLACEHOLDER}"`);
    expect(FOLLOW_UP_PLACEHOLDER).toBe("Change something…");
    expect(out).toMatch(/<label class="visually-hidden" for="[^"]+">Change something about this suggestion<\/label>/);
    expect(out).toMatch(/<button type="submit" class="btn btn-small">Send<\/button>/);
  });

  it("not for a set's, two workouts, one decided, one closed — nor where no one can send it", () => {
    expect(card({ status: "pending", lines: [line("o1")], context: [] }, follow)).not.toContain("coach-pc-follow");
    expect(card({ status: "pending", lines: [line("o1"), line("o2")] }, follow)).not.toContain("coach-pc-follow");
    expect(card({ status: "partially_approved", lines: [line("o1", { outcome: { status: "declined", at: "x" } }), line("o2")] }, follow)).not.toContain("coach-pc-follow");
    expect(card({ status: "approved", lines: [line("o1", { outcome: { status: "applied", at: "x", workoutId: "w", rev: 1, written: { date: TODAY, time: "09:00", title: "x", minutes: 24 } } })] }, follow)).not.toContain(
      "coach-pc-follow",
    );
    expect(card({ status: "pending", lines: [line("o1")] })).not.toContain("coach-pc-follow");
  });
});
