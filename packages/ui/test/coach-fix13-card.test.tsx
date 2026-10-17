// @vitest-environment jsdom
/**
 * Task 13's fix wave, stream U — the suggestion card (audits 13c R5, 13d D1/D2/D3/D7; the brief's §2.6, §2.8–§2.10):
 *
 *  - no "Tip" on the card's face: the reviewer's improvements are one tap down, in "See the review", under "Ideas the
 *    coach didn't use";
 *  - the workout's aim (its intent) is one line under its title, on the face;
 *  - one tap on the title: each move with its why under it, and the moves the coach weighed instead ("or <name> —
 *    <why>");
 *  - a set's card shows the plan's other days (`context`) as quiet lines among the suggested ones, in day order — each
 *    saying it is on the plan already, in words, never by its colour alone;
 *  - the review's new dimensions in plain words;
 *  - a "now" design reads as now — never "That time has passed".
 *
 * The server is a stubbed fetch. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignChangeLineDto, DesignLineDto } from "@rg/api-client";
import { NO_TIME_LEFT_LINE, ProposalCard, TIME_PASSED_LINE } from "../src/screens/studio/proposal-card.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const THU = "2026-10-15";

const line = (opId: string, over: Partial<DesignLineDto> = {}): DesignLineDto => ({
  opId,
  kind: "new",
  date: THU,
  time: "18:00",
  title: `Workout ${opId}`,
  minutes: 24,
  summary: `Workout ${opId} · 24 min`,
  effort: "Develop",
  place: "Home",
  parts: ["Warm-up", "Main · Superset × 3"],
  detail: ["Cat-cow 1 × 8", "Glute bridge 2 × 12"],
  reviewMean: 4.25,
  review: {
    dimensions: [{ id: "intent", label: "Intent clarity", score: 5, note: "One clear aim." }],
    mustFix: [],
    improvements: ["Hold the last bridge for a slow count of three."],
    changes: [],
    accepted: [],
    rounds: 1,
    note: null,
  },
  issues: [],
  outcome: null,
  written: null,
  ...over,
});

/** The suggestion's read: its lines, changes and (a set's) context. */
function serve(read: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => (String(input).split("?")[0] === "/api/coach/proposals/dp-1" ? json(read) : json({ error: "offline" }, 503))),
  );
}

const pending = (lines: DesignLineDto[], extra: { changes?: DesignChangeLineDto[]; context?: unknown } = {}) => ({
  id: "dp-1",
  status: "pending",
  resolvedAt: null,
  lines,
  changes: extra.changes ?? [],
  ...(extra.context !== undefined ? { context: extra.context } : {}),
});

function mount(today: string | null = null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient();
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ProposalCard, { proposalId: "dp-1", today }))));
  });
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}
async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
/** Shown: in the page and under no `hidden` ancestor. */
const shown = (el: Element | null | undefined) => !!el && !el.closest("[hidden]");
const withText = (sel: string, words: string) => [...document.querySelectorAll(sel)].find((el) => el.textContent?.replace(/\s+/g, " ").trim() === words) ?? null;

describe("the card's face (R5, D2): no Tip", () => {
  it("the reviewer's improvements are no Tip on the face: one tap down, in See the review, under 'Ideas from the review'", async () => {
    serve(pending([line("op-a")]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    const card = document.querySelector<HTMLElement>(".coach-pc")!;
    expect(text()).not.toMatch(/\bTip\b/);
    const idea = withText("li", "Hold the last bridge for a slow count of three.");
    expect(idea).not.toBeNull();
    expect(shown(idea)).toBe(false);
    expect(idea!.closest(".coach-pc-review")).not.toBeNull();
    const titles = [...card.querySelectorAll(".coach-pc-review .coach-detail-title")].map((h) => h.textContent);
    // Headed neutrally (round 2, I3): after an amend, an idea the coach applied is still listed here.
    expect(titles).toContain("Ideas from the review");
    expect(text()).not.toContain("didn't use");
    await click(button("See the review"), "See the review");
    expect(shown(idea)).toBe(true);
  });

  it("a review whose only content is an improvement still offers See the review", async () => {
    serve(pending([line("op-a", { review: { dimensions: [], mustFix: [], improvements: ["Slow the lowering."], changes: [], accepted: [], rounds: 1, note: null } })]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    expect(button("See the review")).not.toBeNull();
    expect(shown(withText("li", "Slow the lowering."))).toBe(false);
  });

  it("the validator's costs stay on the face, under Worth knowing", async () => {
    serve(pending([line("op-a", { issues: [{ code: "x", message: "Last session wasn't clean." }] })]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    const titles = [...document.querySelectorAll(".coach-pc-main > .coach-pc-sub > .coach-detail-title")].map((h) => h.textContent);
    expect(titles).toEqual(["Worth knowing"]);
    expect(shown(withText("li", "Last session wasn't clean."))).toBe(true);
  });
});

describe("what it is for, and why each move (D1, D3)", () => {
  const rich = line("op-a", {
    intent: "Loosen the hips and wake the glutes before tomorrow's run.",
    whys: ["Opens the spine gently first.", null],
    alternates: [[], [{ name: "Hip thrust", why: "heavier, but needs a bench" }, { name: "Single-leg bridge", why: null }]],
  });

  it("the intent is one line under the title, on the face", async () => {
    serve(pending([rich]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    const intent = document.querySelector(".coach-pc-intent");
    expect(intent?.textContent).toBe("Loosen the hips and wake the glutes before tomorrow's run.");
    expect(shown(intent)).toBe(true);
    // Under the title, before the facts.
    const main = document.querySelector(".coach-pc-main")!;
    const order = [...main.children].map((el) => el.className.split(" ")[0]);
    expect(order.indexOf("coach-pc-intent")).toBe(order.indexOf("coach-pc-name") + 1);
    expect(order.indexOf("coach-pc-intent")).toBeLessThan(order.indexOf("coach-pc-facts"));
  });

  it("one tap on the title: each move, its why under it, and the moves weighed instead — 'or <name> — <why>'", async () => {
    serve(pending([rich]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    const detail = document.querySelector<HTMLElement>(".coach-pc-detail")!;
    expect(detail.hidden).toBe(true);
    await click(button("Workout op-a"), "the title");
    expect(detail.hidden).toBe(false);
    const moves = [...detail.querySelectorAll(".coach-pc-moves > li")];
    expect(moves).toHaveLength(2);
    expect(moves[0]!.querySelector(".coach-pc-move")?.textContent).toBe("Cat-cow 1 × 8");
    expect(moves[0]!.querySelector(".coach-pc-move-why")?.textContent).toBe("Opens the spine gently first.");
    expect(moves[0]!.querySelectorAll(".coach-pc-alt")).toHaveLength(0);
    expect(moves[1]!.querySelector(".coach-pc-move-why")).toBeNull();
    expect([...moves[1]!.querySelectorAll(".coach-pc-alt")].map((a) => a.textContent)).toEqual(["or Hip thrust — heavier, but needs a bench", "or Single-leg bridge"]);
  });

  it("an older server's line — no intent, whys or alternates — shows the moves as before, nothing undefined", async () => {
    serve(pending([line("op-a")]));
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    expect(document.querySelector(".coach-pc-intent")).toBeNull();
    await click(button("Workout op-a"), "the title");
    const moves = [...document.querySelectorAll(".coach-pc-moves > li")].map((li) => li.textContent);
    expect(moves).toEqual(["Cat-cow 1 × 8", "Glute bridge 2 × 12"]);
    expect(text()).not.toContain("undefined");
    expect(text()).not.toContain("null");
  });
});

describe("a set's card shows the rest of the plan (D7, §2.9)", () => {
  const set = [
    line("op-fri", { date: "2026-10-16", time: "18:00", title: "Hips and core" }),
    line("op-mon", { date: "2026-10-19", time: "07:30", title: "Single-leg strength" }),
    line("op-thu", { date: "2026-10-22", time: null, title: "Upper back" }),
  ];
  const context = [
    { date: "2026-10-18", time: "08:00", kind: "run", title: "Long run", minutes: 90 },
    { date: "2026-10-17", time: null, kind: "programme", title: "Jaw care", minutes: 10 },
    { date: "2026-10-20", time: "18:30", kind: "run", title: "Easy run", minutes: 40 },
    { date: "2026-10-21", time: "06:45", kind: "workout", title: "Mobility flow", minutes: null },
  ];

  it("a week of 3 suggested and 4 already planned, in day order; the planned ones quiet, said in words, with no controls", async () => {
    serve(pending(set, { context }));
    mount();
    await until(() => text().includes("Hips and core"), "the card");
    const rows = [...document.querySelectorAll(".coach-pc-list > li")];
    const said = rows.map((li) => (li.classList.contains("coach-pc-context") ? `plan:${li.textContent}` : `new:${li.querySelector(".coach-pc-name")?.textContent}`));
    expect(said).toEqual([
      "new:Hips and core",
      "plan:Sat · Jaw care · 10 min · on your plan",
      "plan:Sun 8 AM · Long run · 90 min · on your plan",
      "new:Single-leg strength",
      "plan:Tue 6:30 PM · Easy run · 40 min · on your plan",
      "plan:Wed 6:45 AM · Mobility flow · on your plan",
      "new:Upper back",
    ]);
    for (const li of rows.filter((r) => r.classList.contains("coach-pc-context"))) {
      expect(li.querySelectorAll("button, a, input")).toHaveLength(0);
    }
    // The planned lines are never the athlete's to decide: three checkboxes, Approve names none.
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  });

  it("a row the bundle can't read is left out; no context, nothing extra", async () => {
    serve(pending(set, { context: [{ date: "soon", title: "?" }, { date: "2026-10-18", kind: "run" }, null, { date: "2026-10-18", time: "08:00", kind: "run", title: "Long run", minutes: "lots" }] }));
    mount();
    await until(() => text().includes("Hips and core"), "the card");
    expect([...document.querySelectorAll(".coach-pc-context")].map((li) => li.textContent)).toEqual(["Sun 8 AM · Long run · on your plan"]);
  });
});

describe("a now design reads as now (§2.6)", () => {
  it("an open `atNow` line says Now, never a day's time or 'That time has passed'", async () => {
    serve(pending([line("op-now", { date: "2026-10-11", time: "13:15", atNow: true })]));
    mount("2026-10-11");
    await until(() => text().includes("Workout op-now"), "the card");
    expect(document.querySelector(".coach-pc-facts")!.textContent).toBe("Now · 24 min · Develop · Home · Reviewed 4.3 of 5");
    expect(text()).not.toContain(TIME_PASSED_LINE);
    expect(text()).not.toContain(NO_TIME_LEFT_LINE);
  });

  it("an atNow line the approve can't place (no time left today: `timePassed`) says so — the day alone, never 'Now' (round 2, Minor 2)", async () => {
    serve(pending([line("op-now", { date: "2026-10-11", time: "23:55", atNow: true, timePassed: true })]));
    mount("2026-10-11");
    await until(() => text().includes("Workout op-now"), "the card");
    expect(document.querySelector(".coach-pc-facts")!.textContent).toBe("Sun · 24 min · Develop · Home · Reviewed 4.3 of 5");
    expect(document.querySelector(".coach-pc-time-passed")?.textContent).toBe("No time left today — pick a time");
    expect(text()).not.toContain(TIME_PASSED_LINE);
    // Edit is beside it, as for any time the approve would refuse.
    expect([...document.querySelectorAll("a")].some((a) => a.textContent === "Edit")).toBe(true);
  });

  it("once applied, it says where it went, as any line does", async () => {
    serve(
      pending([
        line("op-now", {
          date: "2026-10-11",
          time: "13:15",
          atNow: true,
          outcome: { status: "applied", at: "", workoutId: "w-1", rev: 1, written: { date: "2026-10-11", time: "13:40", title: "Workout op-now", minutes: 24 } },
          written: { date: "2026-10-11", time: "13:40", title: "Workout op-now", minutes: 24, summary: "", edited: false, moved: false },
        }),
      ]),
    );
    mount("2026-10-11");
    await until(() => text().includes("On your plan for"), "the outcome");
    expect(document.querySelector(".coach-pc-facts")!.textContent).toBe("Sun 1:40 PM · 24 min · Develop · Home · Reviewed 4.3 of 5");
  });
});

describe("the review's dimensions after the rubric's change (§2.10)", () => {
  it("fit, request and words in plain words; a retired id keeps its plain label", async () => {
    serve(
      pending([
        line("op-a", {
          review: {
            dimensions: [
              { id: "fit", label: "fit", score: 4, note: null },
              { id: "request", label: "request", score: 5, note: null },
              { id: "words", label: "words", score: 3, note: null },
              { id: "time_fit", label: "time_fit", score: 4, note: null },
            ],
            mustFix: [],
            improvements: [],
            changes: [],
            accepted: [],
            rounds: 1,
            note: null,
          },
        }),
      ]),
    );
    mount();
    await until(() => text().includes("Workout op-a"), "the card");
    const labels = [...document.querySelectorAll(".coach-pc-review dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Fits your time and place", "Answers what you asked", "Clear words", "Fits your time"]);
  });
});
