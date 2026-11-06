// @vitest-environment jsdom
/**
 * THE COACH'S REVIEW CARD (import trail phase 3, Task 10; design 2026-11-05 §3.3–3.5): a fit's pins card whose lines
 * carry the coach's review — grouped In, then Left out; each the move's name (it opens the post's trail at the move),
 * where and the dose, the coach's words, and chips for its evidence (a quote's opens the trail at the quote; history and a
 * goal are plain); Challenge fills the reply box with "About <move>: "; the corrections it holds under the lines, approved
 * with them in one tap; the why at its foot. A suggestion of corrections alone is the same card in its own words. The
 * server is a stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignCorrectionLineDto, DesignPinsLineDto } from "@rg/api-client";
import { CoachReplyContext } from "../src/screens/studio/coach-reply.js";
import { CORRECTIONS_WORDS, PlanCard } from "../src/screens/studio/plan-card.js";
import { button, click, serve, text, until } from "./coach-live-harness.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  vi.unstubAllGlobals();
});

const OP = "pins-run-7";
const SAID = { id: "q1.1", kind: "quote" as const, label: "said 1:12", postId: "post-1", position: 0, quote: 1 };
const HISTORY = { id: "history", kind: "history" as const, label: "your history" };
const LIFT = {
  moveId: "myZorbexHipLiftAbc123", name: "Zorbex hip lift", text: "She says it's for stiff hips after easy runs.", decision: "in" as const,
  where: "joins your mobility rotation", dose: "2 × 6 each side", cites: [SAID, HISTORY], post: { id: "post-1", position: 0 },
};
const NOD = { moveId: "myZorbexNeckNodAbc123", name: "Zorbex neck nod", text: "Your neck care already covers it.", decision: "out" as const, cites: [HISTORY], post: { id: "post-1", position: 2 } };
const FIX: DesignCorrectionLineDto = {
  opId: "fix-move-myZorbexHipLiftAbc123-dose", target: "move", targetId: "myZorbexHipLiftAbc123", field: "dose", name: "Zorbex hip lift", line: "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)",
  why: "The transcript says two sets of thirty seconds.", basis: "evidence", cites: [SAID], outcome: null,
};
const WHY = "The lift fills the hip work your plan lacks; the nod repeats your neck care.";
const pinsLine = (over: Partial<DesignPinsLineDto> = {}): DesignPinsLineDto => ({
  opId: OP, title: "One saved move in", summary: "One joins the rotation.", lines: [LIFT, NOD], why: WHY, pin: [LIFT.moveId], unpin: [], issues: [], outcome: null, ...over,
});
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "pins", proposalId: "dp-run-7", title: "One saved move in", summary: "One joins the rotation.", status: "pending", opId: OP,
  lines: ["Zorbex hip lift: …", "Zorbex neck nod: …"], pinLines: [LIFT, NOD], ...over,
});
const TRAIL = {
  post: { id: "post-1", source: "instagram", url: null, title: null, creator: { handle: "maker" }, mediaType: "video", postedAt: null, firstSeenAt: "2026-11-03T12:00:00.000Z", status: "matched", origin: "saved", durationSec: null, videoSeen: null },
  account: {
    kind: "routine", summary: "Hips after a run.", health: { status: "ok", line: "Read cleanly" },
    moves: [{
      position: 0, name: "Zorbex hip lift", outcome: "new", moveId: LIFT.moveId, purpose: "Opens the hips.",
      quotes: [{ field: "name", text: "the hip lift", from: "caption", check: "verified" }, { field: "purpose", text: "for stiff hips after easy runs", at: 72, from: "transcript", check: "verified" }],
    }],
  },
  events: [], rebuilt: false,
};

async function mount(c: CoachConversationCardDto, wrap: (n: ReactNode) => ReactNode = (n) => n) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient();
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, wrap(createElement(PlanCard, { card: c })))));
  });
}

const read = (over: Record<string, unknown> = {}) => ({ id: "dp-run-7", status: "pending", resolvedAt: null, lines: [], changes: [], pins: [pinsLine()], corrections: [FIX], ...over });

describe("the coach's review card", () => {
  it("groups In then Left out: each line its name, where and dose, the coach's words and chips; the corrections; the why at the foot", async () => {
    serve({ "GET /api/coach/proposals/dp-run-7": () => read() });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    const groups = [...document.querySelectorAll(".coach-review-group")].map((h) => h.textContent);
    expect(groups).toEqual(["In", "Left out", "Corrections"]);
    const [lift, nod] = [...document.querySelectorAll(".coach-review-line")];
    expect(lift!.querySelector(".coach-review-name")!.textContent).toBe("Zorbex hip lift");
    expect(lift!.querySelector(".coach-review-where")!.textContent).toBe("joins your mobility rotation · 2 × 6 each side");
    expect(lift!.querySelector(".coach-review-text")!.textContent).toContain("She says it's for stiff hips after easy runs.");
    expect([...lift!.querySelectorAll(".coach-cite")].map((c) => c.textContent)).toEqual(["said 1:12", "your history"]);
    expect(nod!.querySelector(".coach-review-where")).toBeNull();
    expect(text()).toContain("Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)");
    expect(document.querySelector(".coach-review-why")!.textContent).toBe(`Why: ${WHY}`);
    // A quote's chip is a button; history is plain words.
    expect([...lift!.querySelectorAll(".coach-cite")].map((c) => c.tagName)).toEqual(["BUTTON", "SPAN"]);
  });

  it("a quote's chip opens the post's trail at that quote", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    serve({ "GET /api/coach/proposals/dp-run-7": () => read(), "GET /api/my-saves/posts/post-1/trail": () => TRAIL });
    await mount(card());
    await until(() => document.querySelectorAll(".coach-cite").length > 0, "chips");
    await click(document.querySelector("button.coach-cite") as HTMLButtonElement, "the said chip");
    await until(() => !!document.querySelector(".trail-row--focus"), "the trail at the quote");
    expect(document.querySelector(".trail-row--focus")!.textContent).toContain("for stiff hips after easy runs");
  });

  it("Challenge fills the reply box with the move it is about", async () => {
    serve({ "GET /api/coach/proposals/dp-run-7": () => read() });
    const challenge = vi.fn();
    await mount(card(), (n) => createElement(CoachReplyContext.Provider, { value: { challenge } }, n));
    await until(() => document.querySelectorAll(".coach-challenge").length === 2, "Challenge on each line");
    await click(document.querySelectorAll(".coach-challenge")[1] as HTMLButtonElement, "Challenge the nod");
    expect(challenge).toHaveBeenCalledWith("About Zorbex neck nod: ");
  });

  it("outside a conversation there is no Challenge", async () => {
    serve({ "GET /api/coach/proposals/dp-run-7": () => read() });
    await mount(card());
    await until(() => document.querySelectorAll(".coach-review-line").length === 2, "lines");
    expect(document.querySelectorAll(".coach-challenge")).toHaveLength(0);
  });

  it("Approve approves the card and its corrections in one tap", async () => {
    let state = read();
    const calls = serve({
      "GET /api/coach/proposals/dp-run-7": () => state,
      "POST /api/coach/proposals/dp-run-7/approve": () => {
        state = read({ status: "approved", pins: [pinsLine({ outcome: { status: "applied", at: "x", pinned: [LIFT.moveId], unpinned: [], lines: [] } })], corrections: [{ ...FIX, outcome: { status: "applied", at: "x" } }] });
        return { ok: true, status: "approved", applied: [], changed: [], refused: [], settled: [], remaining: [] };
      },
    });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    await click(button("Approve"), "Approve");
    await until(() => text().includes("Programme's pool updated"), "done");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [OP, FIX.opId] }]);
  });

  it("a suggestion of corrections alone: the same card in its own words, its corrections approved together", async () => {
    let state = read({ pins: undefined, corrections: [FIX, { ...FIX, opId: "fix-2", line: "Why for Zorbex hip lift: long runs (was easy runs)" }] });
    const calls = serve({
      "GET /api/coach/proposals/dp-run-7": () => state,
      "POST /api/coach/proposals/dp-run-7/approve": () => {
        state = read({ status: "approved", pins: undefined, corrections: [{ ...FIX, outcome: { status: "applied", at: "x" } }, { ...FIX, opId: "fix-2", outcome: { status: "applied", at: "x" } }] });
        return { ok: true, status: "approved", applied: [], changed: [], refused: [], settled: [], remaining: [] };
      },
    });
    await mount(card({ kind: "corrections", opId: undefined, title: "Corrections to your saves", summary: "2 corrections", pinLines: undefined, lines: [FIX.line, "Why for Zorbex hip lift: long runs (was easy runs)"] }));
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    expect(text()).toContain("Why for Zorbex hip lift: long runs (was easy runs)");
    await click(button("Approve"), "Approve");
    await until(() => text().includes(CORRECTIONS_WORDS.done), "corrected");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [FIX.opId, "fix-2"] }]);
  });
});

describe("a dose fix that didn't land (final review, Important 1)", () => {
  it("the card says the fix changed since, and the line shows no dose it never got", async () => {
    const STALE = "It changed since the coach suggested this — ask again.";
    const lift = { ...LIFT, dose: "30 s, 2 sets" };
    serve({
      "GET /api/coach/proposals/dp-run-7": () =>
        read({
          status: "partially_approved",
          pins: [pinsLine({ lines: [lift, NOD], outcome: { status: "applied", at: "x", pinned: [LIFT.moveId], unpinned: [], lines: [] } })],
          corrections: [{ ...FIX, outcome: { status: "refused", at: "x", error: "stale", why: STALE } }],
        }),
    });
    await mount(card({ status: "partially_approved", pinLines: [lift, NOD] }));
    await until(() => text().includes("Programme's pool updated"), "the pins applied");
    const fix = document.querySelector(".coach-review-fix")!;
    expect(fix.textContent).toContain(STALE);
    const where = document.querySelector(".coach-review-line .coach-review-where")!;
    expect(where.textContent).toBe("joins your mobility rotation");
  });

  it("an applied fix says so; while the card is open its dose shows", async () => {
    const lift = { ...LIFT, dose: "30 s, 2 sets" };
    serve({ "GET /api/coach/proposals/dp-run-7": () => read({ pins: [pinsLine({ lines: [lift, NOD] })], corrections: [FIX] }) });
    await mount(card({ pinLines: [lift, NOD] }));
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    expect(document.querySelector(".coach-review-line .coach-review-where")!.textContent).toBe("joins your mobility rotation · 30 s, 2 sets");
    act(() => root?.unmount());
    host?.remove();
    serve({ "GET /api/coach/proposals/dp-run-7": () => read({ status: "approved", corrections: [{ ...FIX, outcome: { status: "applied", at: "x" } }] }) });
    await mount(card({ status: "approved" }));
    await until(() => !!document.querySelector(".coach-review-fix"), "the fix");
    expect(document.querySelector(".coach-review-fix")!.textContent).toContain("✓");
  });
});

describe("the reader's report (the controller's fix pass, C1)", () => {
  it("a stated field's chip says the reader's report and opens the post's trail at the move", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const STATED = { id: "stated:steps", kind: "stated" as const, label: "reader's report", field: "steps", postId: "post-1", position: 0 };
    const lift = { ...LIFT, cites: [STATED] };
    serve({ "GET /api/coach/proposals/dp-run-7": () => read({ pins: [pinsLine({ lines: [lift, NOD] })] }), "GET /api/my-saves/posts/post-1/trail": () => TRAIL });
    await mount(card({ pinLines: [lift, NOD] }));
    await until(() => document.querySelectorAll(".coach-cite").length > 0, "chips");
    const chip = document.querySelector(".coach-review-line .coach-cite") as HTMLElement;
    expect(chip.textContent).toBe("reader's report");
    expect(chip.tagName).toBe("BUTTON");
    await click(chip as HTMLButtonElement, "the report chip");
    // The move's account opens: what the post says of it.
    await until(() => text().includes("What the post says"), "the trail at the move");
  });
});

describe("the card's corrections (the controller's fix pass, D6, E16, E18, E22)", () => {
  it("D6: a correction has its own Challenge, naming what it corrects", async () => {
    serve({ "GET /api/coach/proposals/dp-run-7": () => read() });
    const challenge = vi.fn();
    await mount(card(), (n) => createElement(CoachReplyContext.Provider, { value: { challenge } }, n));
    await until(() => !!document.querySelector(".coach-review-fix .coach-challenge"), "Challenge on the correction");
    const fix = document.querySelector(".coach-review-fix .coach-challenge") as HTMLButtonElement;
    expect(fix.getAttribute("aria-label")).toBe("Challenge the correction to Zorbex hip lift");
    await click(fix, "Challenge the correction");
    expect(challenge).toHaveBeenCalledWith("About the correction to Zorbex hip lift: ");
  });

  it("E16: a same-as that kept the duplicate says why", async () => {
    const SAME: DesignCorrectionLineDto = {
      ...FIX, opId: "fix-link", target: "link", targetId: "post-1:2", field: "same_as", name: "Zorbex neck nod", line: "Zorbex neck nod is the same as Dead bug", cites: [],
      outcome: { status: "applied", at: "x", lines: ["Zorbex neck nod stays: it has logged sets — marked like Dead bug"] },
    };
    serve({ "GET /api/coach/proposals/dp-run-7": () => read({ status: "approved", corrections: [SAME] }) });
    await mount(card({ kind: "corrections", opId: undefined, title: "Corrections to your saves", summary: "1 correction", pinLines: undefined, lines: [SAME.line] }));
    await until(() => text().includes("Zorbex neck nod is the same as Dead bug"), "the correction");
    expect(document.querySelector(".coach-review-fix")!.textContent).toContain("Zorbex neck nod stays: it has logged sets — marked like Dead bug");
  });

  it("E22: corrections alone with nothing left to decide — one done, one not changed — show as done, no Approve", async () => {
    const corrections = [{ ...FIX, outcome: { status: "applied" as const, at: "x" } }, { ...FIX, opId: "fix-2", line: "Why for Zorbex hip lift: long runs", outcome: { status: "declined" as const, at: "x" } }];
    serve({ "GET /api/coach/proposals/dp-run-7": () => read({ status: "partially_approved", pins: undefined, corrections }) });
    await mount(card({ kind: "corrections", opId: undefined, title: "Corrections to your saves", summary: "2 corrections", pinLines: undefined, lines: corrections.map((c) => c.line) }));
    await until(() => text().includes(CORRECTIONS_WORDS.done), "done");
    expect(button("Approve")).toBeFalsy();
  });

  it("E18: an approve reads the Studio's moves again", async () => {
    let state = read();
    serve({
      "GET /api/coach/proposals/dp-run-7": () => state,
      "POST /api/coach/proposals/dp-run-7/approve": () => {
        state = read({ status: "approved", pins: [pinsLine({ outcome: { status: "applied", at: "x", pinned: [LIFT.moveId], unpinned: [], lines: [] } })], corrections: [{ ...FIX, outcome: { status: "applied", at: "x" } }] });
        return { ok: true, status: "approved", applied: [], changed: [], refused: [], settled: [], remaining: [] };
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const client = primedClient();
    client.setQueryData(["library", "personal"], { moves: [] });
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(PlanCard, { card: card() }))));
    });
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    expect(client.getQueryState(["library", "personal"])!.isInvalidated).toBe(false);
    await click(button("Approve"), "Approve");
    await until(() => text().includes("Programme's pool updated"), "done");
    expect(client.getQueryState(["library", "personal"])!.isInvalidated).toBe(true);
  });
});

describe("the card's taps (the controller's fix pass, E21)", () => {
  // Found from this file, not the working directory: CI runs vitest from the repo root (as shape-fixes does).
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
  const rule = (selector: string) => {
    const from = css.indexOf(`\n${selector} {`);
    return from < 0 ? "" : css.slice(from, css.indexOf("}", from));
  };
  it("the chips' row and a line's column name the clearance their pads may reach, and keep that much between them", () => {
    for (const selector of [".coach-cites", ".coach-review-line"]) {
      expect(rule(selector), selector).toMatch(/--tap-clear: var\(--space-\d\)/);
      expect(rule(selector), selector).toMatch(/gap: var\(--tap-clear\)/);
    }
  });
});

describe("the quote a chip opens (the controller's fix pass, E20)", () => {
  it("the trail's row for it takes the focus, so a screen reader is there too", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    serve({ "GET /api/coach/proposals/dp-run-7": () => read(), "GET /api/my-saves/posts/post-1/trail": () => TRAIL });
    await mount(card());
    await until(() => document.querySelectorAll(".coach-cite").length > 0, "chips");
    await click(document.querySelector("button.coach-cite") as HTMLButtonElement, "the said chip");
    await until(() => !!document.querySelector(".trail-row--focus"), "the trail at the quote");
    const row = document.querySelector(".trail-row--focus") as HTMLElement;
    expect(row.getAttribute("tabindex")).toBe("-1");
    await until(() => document.activeElement === row, "the focus on the quote");
  });
});
