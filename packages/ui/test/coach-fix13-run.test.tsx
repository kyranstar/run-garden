/**
 * Task 13's fix wave, stream U — the run view, rendered (audits 13b M1, 13c R3/R12/R13; the brief's §2.12):
 *
 *  - a stop on a run that proposed never says "Try a shorter request": the card is the answer (R3);
 *  - no "The coach pauses while the app is closed." — a run keeps going without a watching client (§2.12);
 *  - Undo for what the coach noted from the request stays while the answer is fresh, not only while the run is live
 *    (R13);
 *  - a refused call's "Why not" is in plain words, never a schema's (M1).
 *
 * Synthetic data only.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { CoachRunDto, CoachRunEventDto } from "@rg/api-client";
import { RunView, StoppedLine } from "../src/screens/studio/run-view.js";
import { detailOf, failureOf, runLines } from "../src/screens/studio/run-model.js";
import { renderAt, text, todayDto } from "./studio-fixtures.js";

const TODAY = "2026-10-16";

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "my calves are sore, something easy",
  status: "active",
  steps: 3,
  costUsd: 0.21,
  proposalId: null,
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null, at = `${TODAY}T08:00:00.000Z`): CoachRunEventDto => ({ seq, kind, summary, payload, at });

function view(r: CoachRunDto, events: CoachRunEventDto[], o: { today?: string | null; timeZone?: string | null } = {}) {
  const html = renderAt(
    "/studio",
    createElement(RunView, { run: r, status: r.status, events, inFlight: false, dueRole: null, lost: false, today: "today" in o ? o.today : TODAY, timeZone: o.timeZone ?? "UTC" }),
    { today: todayDto(null) },
  );
  return { html, words: text(html) };
}

describe("a stop on a run that proposed (R3)", () => {
  it("state_cap with a suggestion: no 'Try a shorter request', no 'grew too long' — the coach ran out of room before its last word", () => {
    const f = failureOf({ status: "stopped_cap", error: "state_cap" }, { proposed: true })!;
    expect(f).toEqual({ what: "The coach ran out of room before its last word.", next: null, credits: false });
    const words = text(renderAt("/studio", createElement(StoppedLine, { failure: f, proposed: true, tiles: [] })));
    expect(words).toBe("The coach ran out of room before its last word.");
    expect(words).not.toContain("shorter request");
  });

  it("the other limits with a suggestion: what stopped, and no advice to start again — the card is the answer", () => {
    expect(failureOf({ status: "stopped_cap", error: "step_cap" }, { proposed: true })).toEqual({ what: "This design reached its step limit.", next: null, credits: false });
    expect(failureOf({ status: "stopped_cap", error: "run_ceiling" }, { proposed: true })).toEqual({ what: "This design reached its spending limit.", next: null, credits: false });
  });

  it("nothing proposed: the stop as before", () => {
    expect(failureOf({ status: "stopped_cap", error: "state_cap" })).toEqual({ what: "This design grew too long to continue.", next: "Try a shorter request.", credits: false });
    expect(failureOf({ status: "stopped_cap", error: "state_cap" }, { proposed: false })!.next).toBe("Try a shorter request.");
    // The week's cap says when the coach can design again, proposed or not.
    expect(failureOf({ status: "stopped_cap", error: "weekly_cap" }, { proposed: true })!.next).toBe("The coach can design again next week.");
  });
});

describe("no pause line (§2.12): the coach goes on with the app closed", () => {
  it("a live run says nothing of pausing", () => {
    for (const status of ["active", "stepping", "waiting_set"] as const) {
      expect(view(run({ status }), [ev(1, "note", "Read your request and today's plan.")]).words).not.toMatch(/pause/i);
    }
  });
});

describe("Undo for what the coach noted, while the answer is fresh (R13)", () => {
  const noted = (at: string, undo: Record<string, unknown> = { handle: "ra:run-1:t1" }) =>
    ev(2, "tool_result", "Noted from your request: soreness — calves", { tool: "record_answer", ok: true, receipt: { undo, recorded: [{ question: "soreness", area: "calves" }] } }, at);
  const answered = (at: string) => ev(4, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "aa:run-1:t2" } } }, at);
  const undos = (html: string) => (html.match(/>Undo<\/button>/g) ?? []).length;
  const over = run({ status: "finished", proposalId: "dp-1" });

  it("the run over, an answer given today: Undo stays (the trail one tap down)", () => {
    const { html } = view(over, [ev(1, "note", "Read your request and today's plan."), noted(`${TODAY}T08:01:00.000Z`), answered(`${TODAY}T08:02:00.000Z`)]);
    expect(undos(html)).toBe(2);
  });

  it("an answer from an earlier day, with no last fresh day said: no Undo once the run is over", () => {
    const { html } = view(over, [noted("2026-10-14T08:01:00.000Z"), answered("2026-10-15T20:00:00.000Z")]);
    expect(undos(html)).toBe(0);
  });

  it("the receipt's last fresh day decides when it says one: fresh through it, gone after", () => {
    expect(undos(view(over, [noted("2026-10-14T08:01:00.000Z", { handle: "ra:run-1:t1", expiresAt: "2026-10-16" })]).html)).toBe(1);
    expect(undos(view(over, [noted("2026-10-14T08:01:00.000Z", { handle: "ra:run-1:t1", expiresAt: "2026-10-15" })]).html)).toBe(0);
  });

  it("the day an answer was given is the athlete's, in their zone", () => {
    // 01:30 UTC on the 16th is still the 15th in Los Angeles.
    const late = [noted("2026-10-16T01:30:00.000Z")];
    expect(undos(view(over, late, { timeZone: "UTC" }).html)).toBe(1);
    expect(undos(view(over, late, { timeZone: "America/Los_Angeles" }).html)).toBe(0);
  });

  it("while the run is live, Undo whatever the day", () => {
    expect(undos(view(run({ status: "active" }), [noted("2026-10-14T08:01:00.000Z")]).html)).toBe(1);
  });

  it("no today known: only while live, as before", () => {
    expect(undos(view(over, [noted(`${TODAY}T08:01:00.000Z`)], { today: null }).html)).toBe(0);
  });
});

describe("a refused call's Why not, in plain words (M1)", () => {
  const whyOf = (payload: Record<string, unknown>) => {
    const [line] = runLines([ev(7, "note", "Adjusted the draft.", { tool: "propose_workout", ok: false, ...payload })]);
    return detailOf(line!).flatMap((s) => s.rows).find((r) => r.key === "Why not")?.value;
  };

  it("a field past its ceiling (the server's teachable words): the field, too long", () => {
    expect(whyOf({ error: "invalid_input", refusal: { error: "invalid_input", why: "changeNote is 1,410 characters; at most 300 — about 45 words" } })).toBe("What changed: too long");
    expect(whyOf({ error: "invalid_input", refusal: { error: "invalid_input", why: "summary is 900 characters; at most 200 — about 30 words; questions.0.why is 700 characters; at most 160 — about 25 words" } })).toBe(
      "Summary: too long · Why: too long",
    );
  });

  it("a schema's own words: never quoted — each issue as the athlete would say it", () => {
    const why = whyOf({
      error: "invalid_input",
      refusal: {
        error: "invalid_input",
        why: 'unknown field "foo"; target.date: Required; doc.intent.effort: Invalid enum value. Expected \'develop\' | \'maintain\', received \'hard\'; questions: Array must contain at most 3 element(s)',
      },
    });
    expect(why).toBe("A detail the tool doesn't take · Day: missing · Effort: not one of the choices · Questions: too many");
    for (const raw of ["Required", "Invalid enum", "Array must", "element(s)", "foo", "target.date"]) expect(why).not.toContain(raw);
  });

  it("anything else the schema says: one plain line", () => {
    expect(whyOf({ error: "invalid_input", why: "doc: Expected object, received string" })).toBe("Workout: the wrong kind of value");
    // A path that ends at a position names the list it is in, never the position.
    expect(whyOf({ error: "invalid_input", why: "answers.2: Expected object, received string" })).toBe("Answers: the wrong kind of value");
    expect(whyOf({ error: "invalid_input", why: "input: something odd happened" })).toBe("Not in the form the tool takes");
  });

  it("a refusal in the server's own plain words is kept as before", () => {
    expect(whyOf({ error: "invalid_doc", why: "Tuck jumps are closed today." })).toBe("Tuck jumps are closed today.");
  });
});

describe("the trail's refusals after §2.13", () => {
  const refusal = (seq: number, tool: string, summary: string) =>
    ev(seq, "note", summary, { tool, ok: false, error: "invalid_input", refusal: { error: "invalid_input", why: "summary: Required" } });

  it("a refused finish, question, review or read is quiet — an empty summary is no line, no mark", () => {
    const events = [ev(1, "note", "Read your request and today's plan."), refusal(2, "finish", ""), refusal(3, "ask_athlete", ""), refusal(4, "submit_review", ""), refusal(5, "read_day", "")];
    expect(runLines(events).map((l) => l.summary)).toEqual(["Read your request and today's plan."]);
    const { html } = view(run({ status: "finished", proposalId: "dp-1" }), events);
    expect(html.match(/class="coach-line /g)).toHaveLength(1);
  });

  it("a refused plan reads 'Adjusted the plan.', neutral as a refused draft is", () => {
    const [plan] = runLines([refusal(6, "plan_set", "Adjusted the plan.")]);
    expect(plan!.summary).toBe("Adjusted the plan.");
    expect(plan!.glyph).toBe("neutral");
  });
});
