/**
 * THE THREAD COACH'S CARDS ON PLAN (the new shape, stream C): the Plan's floating coach window and its pill go — the
 * coach's chat is the one conversation now — but what the thread coach still puts on the Plan by itself stays there:
 * its pending suggestions (each the card it always was, with its id, so a tap on its ghost in the week lands on it) and
 * its open question with tappable answers. No box to type in. Nothing pending and no question: nothing drawn.
 *
 * Takes the same props the window's panel took (`coachPanelProps`), so the Plan hands it the same object.
 * Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CoachProposalDto, CoachQuestionDto } from "@rg/api-client";
import { OUT_OF_CREDITS_LINE } from "../src/ai-credits.js";
import { ThreadCoachCards } from "../src/screens/thread-coach-cards.js";

const noop = () => undefined;

const prop = (id: string, over: Partial<CoachProposalDto> = {}): CoachProposalDto => ({
  id,
  title: `Proposal ${id}`,
  evidence: "two short nights",
  rationale: "Rest beats a junk tempo.",
  flags: [],
  ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
  status: "pending",
  createdAt: "2026-10-15T10:00:00Z",
  expiresAt: "2026-10-18",
  ...over,
});

const question: CoachQuestionDto = { id: "q1", body: "How are the legs today?", chips: ["Fresh", "Heavy"] } as CoachQuestionDto;

/** The window's panel's props, whole — the Plan spreads the same object. */
const panelProps = (over: Record<string, unknown> = {}) => ({
  messages: [],
  proposals: [prop("p1"), prop("p2", { title: "Move the long run" })],
  settledProposals: [],
  question,
  busy: false,
  acting: false,
  proposalErrors: { p2: "Couldn't reach the coach — try again." },
  onSend: noop,
  onApprove: noop,
  onDecline: noop,
  onAnswer: noop,
  onDismiss: noop,
  ...over,
});

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ThreadCoachCards, props as never)));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the thread coach's cards on the Plan", () => {
  it("each pending suggestion is its card, with its id for the week's ghost tap; its error stays on it", () => {
    const html = render(panelProps());
    expect(html).toContain('id="proposal-p1"');
    expect(html).toContain('id="proposal-p2"');
    expect(words(html)).toContain("Proposal p1");
    expect(words(html)).toContain("Move the long run");
    expect(words(html)).toContain("Make it so");
    expect(words(html)).toContain("Couldn't reach the coach — try again.");
  });

  it("the open question, with its tappable answers and a way to dismiss it", () => {
    const html = render(panelProps({ proposals: [] }));
    expect(words(html)).toContain("How are the legs today?");
    expect(words(html)).toContain("Fresh");
    expect(words(html)).toContain("Heavy");
    expect(html).toContain('aria-label="Dismiss question"');
  });

  it("no box to type in: the chat is the coach's conversation now", () => {
    const html = render(panelProps());
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(words(html)).not.toContain("Tell your coach anything");
  });

  it("named as a section, in plain words", () => {
    const html = render(panelProps());
    expect(html).toMatch(/<section[^>]*aria-labelledby=/);
    expect(words(html)).toContain("From your coach");
  });

  it("nothing pending and no question: nothing drawn", () => {
    expect(render(panelProps({ proposals: [], question: null }))).toBe("");
  });

  it("the thread coach's AI account out of credits: one plain line, with Retry — even with nothing pending", () => {
    const html = render(panelProps({ proposals: [], question: null, outOfCredits: true, onRetry: noop }));
    expect(words(html)).toContain(OUT_OF_CREDITS_LINE);
    expect(html).toMatch(/<button type="button" class="btn btn-small"[^>]*>Retry<\/button>/);
    expect(html).toMatch(/role="status"/);
    // A wake actually running wins: no line while it may be finding the credits back.
    expect(words(render(panelProps({ outOfCredits: true, busy: true, onRetry: noop })))).not.toContain(OUT_OF_CREDITS_LINE);
    // No Retry offered with no way to retry.
    expect(render(panelProps({ outOfCredits: true }))).not.toContain(">Retry<");
  });

  it("the last wake's lost work, said in its own words ('… Nothing was applied …'), even with nothing pending", () => {
    const lost = "One plan change didn't make it: “Easier Tuesday” (1 ease) — a day gone by. Nothing was applied. Ask again — naming one day at a time helps — and it will come back as a proposal you can approve.";
    const html = render(panelProps({ proposals: [], question: null, nothingApplied: lost }));
    expect(words(html)).toContain("Nothing was applied.");
    expect(html).toContain('role="status"');
    expect(render(panelProps({ proposals: [], question: null, nothingApplied: "  " }))).toBe("");
  });
});
