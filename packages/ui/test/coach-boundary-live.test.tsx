// @vitest-environment jsdom
/**
 * The robustness pass (2026-10-16) — a render error in the coach stays in the coach. Without a boundary one throw while
 * drawing the suggestion's card unmounted the whole app (measured on the fixture stack: a blank page). Now:
 *
 *  - the piece that failed says "Something went wrong showing the coach — reload", and its reload reloads;
 *  - the other pieces stand: a card that throws leaves the run view (its header, its trail) on screen;
 *  - the objectives board that throws says so on the board, with the same reload.
 *
 * The card is replaced with one that throws (vi.mock); the board throws on its own read. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachRunDto } from "@rg/api-client";
import { brokenLine, CoachBoundary } from "../src/screens/studio/coach-boundary.js";
import { StudioCoach } from "../src/screens/studio/composer.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { ObjectivesRoute } from "../src/screens/studio/objectives.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/screens/studio/proposal-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screens/studio/proposal-card.js")>();
  return {
    ...actual,
    // The card throws as it draws — what a newer server's answer misread once did to the whole app.
    ProposalCard: () => {
      throw new Error("the card failed to draw");
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-b",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "finished",
  steps: 4,
  costUsd: 0.16,
  proposalId: "dp-1",
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: `${TODAY}T08:01:00.000Z`,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

function serve(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input).split("?")[0]}`;
      return key in routes ? json(routes[key]) : json({ error: "offline" }, 503);
    }),
  );
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

function mount(el: ReactNode, at = "/studio") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ today: todayDto(null) });
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [at] }, el)));
  });
}

const quietLoop = (): LoopDeps => ({
  step: () => new Promise(() => undefined),
  read: async () => ({ run: run(), events: [] }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  visible: () => true,
  onVisibility: () => () => undefined,
});

function Throws(): never {
  throw new Error("boom");
}

describe("a render error in the coach stays in the coach", () => {
  it("the piece that failed says so, with a reload; what is beside the boundary stands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    mount(
      createElement(
        "div",
        null,
        createElement("p", null, "The rest of the Studio"),
        createElement(CoachBoundary, { onReload: reload }, createElement(Throws)),
      ),
    );
    await settle();
    expect(text()).toContain("The rest of the Studio");
    expect(text()).toContain("Something went wrong showing the coach — reload");
    expect(document.querySelector(".coach-broken")?.getAttribute("role")).toBe("alert");
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "reload")!;
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(brokenLine("your objectives")).toBe("Something went wrong showing your objectives —");
  });

  it("quiet: a piece too small to say anything just isn't there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(createElement("div", null, createElement("p", null, "Studio"), createElement(CoachBoundary, { quiet: true }, createElement(Throws))));
    await settle();
    expect(text()).toBe("Studio");
  });

  it("a suggestion's card that throws: the run view stays — its header, its trail's fold — and the card says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    serve({
      "GET /api/coach/runs/current": { run: run(), events: [{ seq: 1, kind: "note", summary: "Read your request", payload: null, at: "" }], proposal: { id: "dp-1", status: "pending", flags: [] } },
      "GET /api/coach/proposals/dp-1": { id: "dp-1", status: "pending", resolvedAt: null, lines: [], changes: [] },
    });
    mount(createElement(StudioCoach, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: quietLoop }));
    await until(() => text().includes("Something went wrong showing the coach"), "the card's line");
    expect(text()).toContain("Coach · done");
    expect(text()).toContain("How the coach made this");
    // The composer, beside them, stands too.
    expect(text()).toContain("Ask the coach");
  });

  it("the objectives board that throws says so on the board", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A board read the screen can't draw (no list of objectives).
    serve({ "GET /api/objectives/board": { today: TODAY, objectives: null } });
    mount(createElement(ObjectivesRoute), "/studio/objectives");
    await until(() => text().includes("Something went wrong showing your objectives — reload"), "the board's line");
  });
});
