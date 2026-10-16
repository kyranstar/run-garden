/**
 * Stage 3 Task 9 — the run view (spec §10), rendered for every status a run can show: the header's plain word and the
 * spend so far, the request as text, the trail's lines and their marks (✓ done, ! didn't work, ● the step in flight,
 * each with its word for a reader), the question while the coach waits, Cancel while it is live — and, once it stopped
 * short, what stopped it, then ways to train now when nothing was proposed. Synthetic data only.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { CoachRunDto, CoachRunEventDto } from "@rg/api-client";
import { RunView, StoppedLine } from "../src/screens/studio/run-view.js";
import { failureOf, OUT_OF_CREDITS_FALLBACK, type FallbackTile } from "../src/screens/studio/run-model.js";
import { renderAt, text, todayDto } from "./studio-fixtures.js";

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "a 30-minute lower-body session at home",
  status: "active",
  steps: 3,
  costUsd: 0.214,
  proposalId: null,
  error: null,
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z",
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({ seq, kind, summary, payload, at: "2026-10-14T08:00:00.000Z" });

const trail: CoachRunEventDto[] = [
  ev(1, "note", "Read the request and what the coach needs to start."),
  ev(2, "tool_result", "Read today — check-in 2 at 07:40, run at 6pm", { tool: "read_day", input: { date: "2026-10-14" }, ok: true, provenance: { source: "the day" } }),
  ev(3, "tool_result", "Couldn't use search library: no moves matched", { tool: "search_library", ok: false, error: "no_match" }),
  ev(4, "draft", "Draft — “Wake, load, open”: 31 min", { tool: "propose_workout", input: { doc: { title: "Wake, load, open" } } }),
];

const question = ev(5, "question", "How are the hips today?", {
  tool: "ask_athlete",
  data: { questions: [{ text: "How are the hips today?", chips: ["tight", "okay", "loose"], why: "It changes the warm-up.", allowFreeText: true }] },
});
const check = ev(5, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need today's check." } });

function view(r: CoachRunDto, events: CoachRunEventDto[] = trail, o: { inFlight?: boolean; dueRole?: "main" | "designer" | "reviewer" | null; lost?: boolean } = {}) {
  const html = renderAt("/studio", createElement(RunView, { run: r, status: r.status, events, inFlight: o.inFlight ?? false, dueRole: o.dueRole ?? null, lost: o.lost ?? false }), {
    today: todayDto(null),
  });
  return { html, words: text(html) };
}

describe("the run view, by status", () => {
  it("active, a step in flight: designing, the spend, the request as text, the lines and the step in flight", () => {
    const { html, words } = view(run(), trail, { inFlight: true });
    expect(words).toContain("Coach · designing");
    expect(words).toContain("$0.21");
    expect(words).toContain("“a 30-minute lower-body session at home”");
    expect(html).toContain("coach-line--done");
    expect(html).toContain("coach-line--error");
    expect(words).toContain("Done: Read today — check-in 2 at 07:40, run at 6pm");
    expect(words).toContain("Didn't work: Couldn't use search library: no moves matched");
    expect(words).toContain("Now: Designing…");
    expect(html).toContain("●");
    // Collapsed by default: each line's detail is there, hidden, one tap down.
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/class="coach-line-detail" hidden=""/);
    expect(words).toContain("Cancel");
  });

  it("the request is the athlete's words: text, never markup", () => {
    const { html } = view(run({ request: '<img src=x onerror="alert(1)"> **bold**' }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("**bold**");
  });

  it("stepping, its next step a reviewer's: reviewing", () => {
    expect(view(run({ status: "stepping" }), trail, { inFlight: true, dueRole: "reviewer" }).words).toContain("Coach · reviewing");
    expect(view(run({ status: "stepping" }), trail, { inFlight: true, dueRole: "reviewer" }).words).toContain("Now: Reviewing…");
  });

  it("waiting_review and waiting_set: reviewing, planning the set", () => {
    expect(view(run({ status: "waiting_review" })).words).toContain("Coach · reviewing");
    expect(view(run({ status: "waiting_set", scope: { kind: "week" } })).words).toContain("Coach · planning the set");
  });

  it("a set shows its estimate beside the limit once its plan made one", () => {
    const { words } = view(run({ scope: { kind: "week" }, estimateUsd: 4.2, ceilingUsd: 6, status: "waiting_set" }));
    expect(words).toContain("About $4.20; the limit is $6.00");
    expect(view(run({ scope: { kind: "week" }, ceilingUsd: 6 })).words).not.toContain("About $");
  });

  it("waiting_athlete: the question on top — its text, its chips, words of one's own, Send and Skip", () => {
    const { html, words } = view(run({ status: "waiting_athlete" }), [...trail, question]);
    expect(words).toContain("Coach · waiting for you");
    expect(html.indexOf("coach-ask")).toBeLessThan(html.indexOf("coach-run-lines"));
    expect(words).toContain("How are the hips today?");
    for (const chip of ["tight", "okay", "loose"]) expect(html).toContain(`aria-pressed="false">${chip}</button>`);
    expect(html).toContain('placeholder="Or in your own words"');
    expect(words).toContain("Send");
    expect(words).toContain("Skip");
  });

  it("waiting_athlete for today's condition check: the app's own check, the why as text, Skip", () => {
    const { html, words } = view(run({ status: "waiting_athlete" }), [...trail, check]);
    expect(words).toContain("The coach asks you to log today's condition check.");
    expect(words).toContain("Landing drills need today's check.");
    // The chip Today wears for the profile, opening the same sheet.
    expect(html).toContain("condition-chip");
    expect(words).toContain("Jaw check ›");
    expect(words).toContain("Skip");
    expect(html).not.toContain('placeholder="Or in your own words"');
  });

  it("finished: done, no Cancel, no question — even one asked earlier on its trail", () => {
    const { html, words } = view(run({ status: "finished" }), [...trail, question, ev(6, "note", "You answered: tight"), ev(7, "note", "The coach finished.")]);
    expect(words).toContain("Coach · done");
    expect(words).not.toContain("Cancel");
    expect(html).not.toContain("coach-ask");
    expect(html).not.toContain('placeholder="Or in your own words"');
  });

  it("failed for credits, the week's cap, the gateway; stopped at its own limit; expired; cancelled", () => {
    expect(view(run({ status: "failed", error: "gateway_402" })).words).toContain("Coach · stopped");
    expect(view(run({ status: "stopped_cap", error: "weekly_cap" })).words).toContain("Coach · ran out of budget");
    expect(view(run({ status: "failed", error: "retries" })).words).toContain("Coach · stopped");
    expect(view(run({ status: "stopped_cap", error: "run_ceiling" })).words).toContain("Coach · ran out of budget");
    expect(view(run({ status: "expired", error: "expired" })).words).toContain("Coach · expired");
    expect(view(run({ status: "cancelled" })).words).toContain("Coach · cancelled");
    for (const s of ["failed", "stopped_cap", "expired", "cancelled"] as const) expect(view(run({ status: s })).words).not.toContain("Cancel");
  });

  it("lost the connection: says so, with Retry", () => {
    const { words } = view(run(), trail, { lost: true });
    expect(words).toContain("Lost the connection. It'll pick up when you're back.");
    expect(words).toContain("Retry");
  });

  it("a long trail shows its latest lines; the earlier ones one tap away", () => {
    const many = Array.from({ length: 10 }, (_, i) => ev(i + 1, "note", `Line ${i + 1}`));
    const { words } = view(run(), many);
    expect(words).toContain("Show 4 earlier lines");
    expect(words).toContain("Line 10");
    expect(words).not.toContain("Line 4 ");
  });

  it("a kept answer's line offers Undo while the run is live, and not once it is over", () => {
    const answered = ev(6, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "run-1:toolu_1" } } });
    expect(view(run(), [...trail, answered]).words).toContain("Undo");
    expect(view(run({ status: "finished" }), [...trail, answered]).words).not.toContain("Undo");
  });
});

describe("when it stopped short", () => {
  const tiles: FallbackTile[] = [
    { key: "session:w-1", title: "Strength A", minutes: 35, href: "/plan?workout=w-1" },
    { key: "template:t1", title: "Pinned one", minutes: 20, href: "/studio/build/template/t1" },
    { key: "condition_care", title: "Jaw care", minutes: 5, href: "/studio/build/quick/condition_care" },
  ];
  const stopped = (error: string, proposed: boolean, t = tiles) =>
    renderAt("/studio", createElement(StoppedLine, { failure: failureOf({ status: error === "expired" ? "expired" : "failed", error })!, proposed, tiles: t }));

  it("out of credits with nothing proposed: the pinned words, then the programme session, a template and a quick start", () => {
    const html = stopped("gateway_402", false);
    expect(text(html)).toContain(OUT_OF_CREDITS_FALLBACK);
    expect(html).toContain('href="/plan?workout=w-1"');
    expect(html).toContain('href="/studio/build/template/t1"');
    expect(html).toContain('href="/studio/build/quick/condition_care"');
    expect(html.match(/class="stu-qs"/g)).toHaveLength(3);
  });

  it("another stop: what failed and what happens next, then the ways to train now", () => {
    const words = text(stopped("weekly_cap", false));
    expect(words).toContain("This week's AI budget is used up. The coach can design again next week. Ways to train now:");
    expect(text(stopped("expired", false))).toContain("This design ran out of time.");
    expect(text(stopped("retries", false))).toContain("The AI service didn't answer.");
  });

  it("with a suggestion proposed from what was reviewed: the failure line alone — the card follows, no tiles", () => {
    const html = stopped("gateway_402", true);
    expect(text(html)).toBe("The AI account is out of credits. The coach can design again once credits are added.");
    expect(html).not.toContain("stu-qs");
  });
});
