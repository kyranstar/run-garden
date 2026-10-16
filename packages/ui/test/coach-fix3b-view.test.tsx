/**
 * Batch 3B's fix wave, Part U — the run view, rendered: a set's trail grouped by day under the main run's own lines
 * (B-I7), folded to one line once the run is over; a refused call a neutral note (B-I4); the spend (M4); the line under
 * a live run (M10); the check ask's primary action (M6); a stop said once, with no tile the quick starts below already
 * show (M5); the chosen chip's pressed style and the checkboxes' accent (B-C1, M7). Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { CoachRunDto, CoachRunEventDto } from "@rg/api-client";
import { RunView, StoppedLine } from "../src/screens/studio/run-view.js";
import { failureOf, PAUSE_LINE, QUICK_BELOW_LINE, TRAIL_FOLD_LINE, type FallbackTile } from "../src/screens/studio/run-model.js";
import { renderAt, text, todayDto } from "./studio-fixtures.js";

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "week" },
  request: "plan my week around my runs",
  status: "waiting_set",
  steps: 3,
  costUsd: 0.214,
  proposalId: null,
  error: null,
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z",
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 6,
  ...over,
});

const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({ seq, kind, summary, payload, at: "2026-10-14T08:00:00.000Z" });
const sub = (runId: string, forDay: string, forTitle?: string, extra: Record<string, unknown> = {}) => ({ ...extra, by: { runId, role: "designer" }, forDay, ...(forTitle ? { forTitle } : {}) });

const setTrail: CoachRunEventDto[] = [
  ev(1, "note", "Read your request and today's plan."),
  ev(2, "tool_result", "Planned 2 workouts — a workout for each day", { tool: "plan_set", ok: true }),
  ev(3, "note", "Read your request and today's plan.", sub("d-1", "2026-10-16")),
  ev(4, "draft", "Draft — “Hips and back, gently”: 10 min — sent for review", sub("d-1", "2026-10-16", "Hips and back, gently", { tool: "propose_workout" })),
  ev(5, "note", "Read your request and today's plan.", sub("d-2", "2026-10-17", "Single-leg strength")),
  ev(6, "tool_result", "Read today — 1 planned, 0 done", sub("d-2", "2026-10-17", "Single-leg strength", { tool: "read_day", ok: true, input: { date: "2026-10-17" } })),
];

function view(r: CoachRunDto, events: CoachRunEventDto[], o: { inFlight?: boolean } = {}) {
  const html = renderAt("/studio", createElement(RunView, { run: r, status: r.status, events, inFlight: o.inFlight ?? false, dueRole: null, lost: false }), {
    today: todayDto(null),
  });
  return { html, words: text(html) };
}

describe("a set's trail, by day (B-I7)", () => {
  it("the main run's lines ungrouped at the top; each day's under its heading — the day, and its title once known", () => {
    const { html, words } = view(run(), setTrail);
    const headings = [...html.matchAll(/<h3 class="coach-day-head">([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual(["Fri 16 Oct · Hips and back, gently", "Sat 17 Oct · Single-leg strength"]);
    // The main run's own lines come first, before any day.
    expect(words.indexOf("Planned 2 workouts")).toBeLessThan(words.indexOf("Fri 16 Oct · Hips and back, gently"));
    // Each day's lines sit under its own heading.
    const fri = html.slice(html.indexOf("Fri 16 Oct ·"), html.indexOf("Sat 17 Oct ·"));
    expect(text(fri)).toContain("Draft — “Hips and back, gently”");
    expect(text(fri)).not.toContain("Read today — 1 planned");
    expect(text(html.slice(html.indexOf("Sat 17 Oct ·")))).toContain("Read today — 1 planned, 0 done");
  });

  it("while it runs, the trail is open: no fold; once over, it folds to one line, the lines one tap down", () => {
    const live = view(run(), setTrail).html;
    expect(text(live)).not.toContain(TRAIL_FOLD_LINE);
    expect(live).not.toMatch(/class="coach-run-trail" hidden=""/);
    const done = view(run({ status: "finished" }), [...setTrail, ev(9, "note", "Three short sessions spread across the week.")]).html;
    expect(text(done)).toContain(TRAIL_FOLD_LINE);
    expect(done).toMatch(new RegExp(`aria-expanded="false"[^>]*>${TRAIL_FOLD_LINE}`));
    expect(done).toMatch(/class="coach-run-trail"[^>]*hidden=""/);
    // Every stop folds too: a failure is said once, under the run (M5).
    expect(view(run({ status: "failed", error: "gateway_402" }), [ev(1, "error", "The AI account is out of credits — the coach stopped here.")]).html).toMatch(
      /class="coach-run-trail"[^>]*hidden=""/,
    );
  });

  it("an over run with no lines has nothing to fold", () => {
    expect(text(view(run({ status: "cancelled" }), []).html)).not.toContain(TRAIL_FOLD_LINE);
  });
});

describe("the athlete's answers never fold into earlier lines (M10)", () => {
  it("a long live trail keeps the question and the answer in view; the rest of the earlier lines one tap away", () => {
    const events = [
      ev(1, "note", "Read your request and today's plan."),
      ev(2, "question", "How long do you have?", { tool: "ask_athlete", data: { questions: [{ text: "How long do you have?", chips: ["20 min"] }] } }),
      ev(3, "note", "You answered: 20 min", { answers: ["20 min"], receipt: { undo: { handle: "run-1:t1" } } }),
      ...Array.from({ length: 8 }, (_, i) => ev(4 + i, "note", `Line ${4 + i}`)),
    ];
    const { words } = view(run({ scope: { kind: "now" }, status: "active" }), events);
    expect(words).toContain("Show 3 earlier lines");
    expect(words).toContain("Asked you: How long do you have?");
    expect(words).toContain("You answered: 20 min");
    expect(words).toContain("Undo");
    expect(words).not.toContain("Read your request and today's plan.");
  });
});

describe("the header, and the line under a live run (M4, M10)", () => {
  it("the spend reads Spent $x", () => {
    expect(view(run(), setTrail).words).toContain("Coach · planning the set Spent $0.21");
  });

  it("a live run says the coach pauses while the athlete is away; a run over says nothing of it", () => {
    expect(view(run(), setTrail).words).toContain(PAUSE_LINE);
    expect(view(run({ status: "finished" }), setTrail).words).not.toContain(PAUSE_LINE);
  });
});

describe("a refused call is a neutral note (B-I4)", () => {
  const refused = ev(7, "note", "Adjusted the draft.", { tool: "propose_workout", input: { doc: { title: "Hips" } }, ok: false, error: "invalid_doc", why: "Tuck jumps are closed today." });

  it("– and no !, no word claiming a step done or one that failed; its detail one tap down", () => {
    const { html, words } = view(run({ scope: { kind: "now" }, status: "active" }), [ev(1, "note", "Read your request and today's plan."), refused]);
    const line = html.slice(html.indexOf('coach-line coach-line--neutral'));
    expect(line).toContain("–");
    expect(html).not.toContain("coach-line--error");
    expect(words).not.toContain("Didn't work: Adjusted the draft.");
    expect(words).not.toContain("Done: Adjusted the draft.");
    expect(html).toMatch(/aria-expanded="false"[^>]*>Adjusted the draft\.<\/button>/);
    expect(words).toContain("Why not Tuck jumps are closed today.");
  });
});

describe("a line's detail with no heading of its own (B-I3)", () => {
  it("a question's detail is its rows alone: You were asked · Choices", () => {
    const q = ev(2, "question", "How long do you have?", { tool: "ask_athlete", data: { questions: [{ text: "How long do you have?", chips: ["20 min", "45 min"] }] } });
    const { html, words } = view(run({ scope: { kind: "now" }, status: "active" }), [q, ev(3, "note", "You answered: 20 min", { answers: ["20 min"] })]);
    expect(words).toContain("You were asked How long do you have? Choices 20 min · 45 min");
    expect(html).not.toContain(">The question<");
  });
});

describe("the check ask (M6)", () => {
  it("its primary action is a full button in the profile's words; Skip is secondary; the app's own sheet one tap on", () => {
    const check = ev(5, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need today's check." } });
    const { html, words } = view(run({ scope: { kind: "now" }, status: "waiting_athlete" }), [check]);
    expect(html).toMatch(/<button type="button" class="btn btn-primary"[^>]*>Do the jaw check<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn"[^>]*>Skip<\/button>/);
    expect(html).not.toContain("condition-chip");
    expect(words).not.toContain("Jaw check ›");
  });
});

describe("a stop, said once (M5)", () => {
  const session: FallbackTile = { key: "session:w-1", kind: "session", title: "Jaw care", minutes: 30, href: "/plan?workout=w-1" };
  const stopped = (error: string, proposed: boolean, tiles: FallbackTile[]) =>
    renderAt("/studio", createElement(StoppedLine, { failure: failureOf({ status: "failed", error })!, proposed, tiles }));

  it("out of credits: what stopped and what's next, today's session, then the quick starts below — no route to credits", () => {
    const html = stopped("gateway_402", false, [session]);
    const words = text(html);
    expect(words).toContain("The AI account is out of credits. The coach can design again once credits are added.");
    expect(words).toContain("Today's session Jaw care");
    expect(words).toContain(QUICK_BELOW_LINE);
    expect(words).not.toContain("three ways");
    expect(html.match(/class="stu-qs"/g)).toHaveLength(1);
    expect(html).not.toMatch(/href="[^"]*(credit|billing|account)[^"]*"/i);
  });

  it("no tile to offer: the stop, and the quick starts below", () => {
    const words = text(stopped("weekly_cap", false, []));
    expect(words).toBe("This week's AI budget is used up. The coach can design again next week. Pick a quick start below.");
  });

  it("a suggestion proposed from what was reviewed: the stop alone — the card follows", () => {
    expect(text(stopped("gateway_402", true, [session]))).toBe("The AI account is out of credits. The coach can design again once credits are added.");
  });
});

describe("the stylesheet (B-C1, M7)", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("a chosen chip in the question card is filled — the theme's own tokens, so both themes", () => {
    const body = rule('.coach-ask .chip[aria-pressed="true"]');
    expect(body).toContain("background: var(--green)");
    expect(body).toContain("border-color: var(--green)");
    expect(body).toContain("color: var(--on-accent)");
  });

  it("the card's checkboxes take the accent colour, by its token", () => {
    expect(rule(".coach-pc-pick input")).toContain("accent-color: var(--green)");
  });
});
