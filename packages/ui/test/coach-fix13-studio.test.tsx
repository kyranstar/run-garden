// @vitest-environment jsdom
/**
 * Task 13's fix wave, stream U — the coach in the Studio, live:
 *
 *  - "Also waiting" (R2, §2.7): the other open suggestions the current read names, under the current card, each a
 *    compact line that opens its own card — never the one the run already shows.
 *
 * The server is a stubbed fetch; the step loop's own deps are a quiet stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachRunDto, DesignLineDto } from "@rg/api-client";
import { COACH_CURRENT_QUERY, StudioCoach } from "../src/screens/studio/composer.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";

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

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "finished",
  steps: 4,
  costUsd: 0.31,
  proposalId: "dp-1",
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: `${TODAY}T08:03:00.000Z`,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

const line = (opId: string, title: string, over: Partial<DesignLineDto> = {}): DesignLineDto => ({
  opId,
  kind: "new",
  date: "2026-10-12",
  time: "18:00",
  title,
  minutes: 24,
  summary: "",
  effort: "Develop",
  place: "Home",
  parts: [],
  detail: [],
  reviewMean: 4.5,
  review: null,
  issues: [],
  outcome: null,
  written: null,
  ...over,
});
const proposal = (id: string, lines: DesignLineDto[]) => ({ id, status: "pending", resolvedAt: null, lines, changes: [] });

interface Call {
  method: string;
  path: string;
  body: any;
}

/** The server: `routes` answer by "METHOD path" (a function gets the body); anything else is a 503. */
function serve(routes: Record<string, unknown | ((body: any, calls: Call[]) => Response)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const answer = routes[`${method} ${path}`];
      if (answer === undefined) return json({ error: "offline" }, 503);
      if (typeof answer === "function") return (answer as (b: unknown, c: Call[]) => Response)(body, calls);
      return answer instanceof Response ? answer.clone() : json(answer);
    }),
  );
  return calls;
}

/** The loop's stand-in: its step never answers (no model here); its read answers `run`. */
const quietLoop = (r: () => CoachRunDto) => (): LoopDeps => ({
  step: () => new Promise(() => undefined),
  read: async () => ({ run: r(), events: [] }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  visible: () => true,
  onVisibility: () => () => undefined,
});

function mount(o: { loop?: () => LoopDeps; prime?: (qc: QueryClient) => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ today: todayDto(null) });
  o.prime?.(qc);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [{ pathname: "/studio", state: null }] },
          createElement(StudioCoach, { ctx: { ...emptyStudioCtx, today: TODAY, profiles: [] }, loopDeps: o.loop ?? quietLoop(() => run()) }),
        ),
      ),
    );
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
const gets = (calls: Call[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path);
const alsoSection = () => [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Also waiting") ?? null;
const alsoLines = () => [...(alsoSection()?.querySelectorAll<HTMLButtonElement>("li > button") ?? [])];

// ── Also waiting ────────────────────────────────────────────────────────────

describe("Also waiting (R2, §2.7)", () => {
  const alsoOpen = [
    { proposalId: "dp-2", title: "Hips and back, gently", date: "2026-10-11", time: "13:05", items: 1 },
    { proposalId: "dp-3", title: "Your next workouts", date: "2026-10-13", time: null, items: 3 },
    // The one the run shows is never listed again, whatever the server sent.
    { proposalId: "dp-1", title: "Gym session", date: "2026-10-11", time: "19:00", items: 1 },
  ];

  it("under the current card: one compact line each — its title, its day and time, how many to decide — and none for the card on show", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [], proposal: { id: "dp-1", status: "pending", flags: [] }, alsoOpen },
      "GET /api/coach/proposals/dp-1": proposal("dp-1", [line("op-1", "Gym session")]),
    });
    mount();
    await until(() => !!alsoSection(), "Also waiting");
    await until(() => text().includes("Gym session"), "the current card");
    expect(alsoLines().map((b) => b.textContent)).toEqual(["Hips and back, gently · Sun 1:05 PM", "Your next workouts · Tue · 3 to decide"]);
    // After the current card, in the page's order.
    const card = document.querySelector(".coach-pc")!;
    expect(card.compareDocumentPosition(alsoSection()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No card is read before a line is opened.
    expect(gets(calls, "/api/coach/proposals/dp-2")).toHaveLength(0);
    for (const b of alsoLines()) expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("a line opens its own card (its own read), and closes it again", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [], proposal: { id: "dp-1", status: "pending", flags: [] }, alsoOpen },
      "GET /api/coach/proposals/dp-1": proposal("dp-1", [line("op-1", "Gym session")]),
      "GET /api/coach/proposals/dp-2": proposal("dp-2", [line("op-2", "Hips and back, gently", { date: TODAY, time: "13:05" })]),
    });
    mount();
    await until(() => alsoLines().length === 2, "the lines");
    await click(alsoLines()[0], "the first line");
    expect(alsoLines()[0]!.getAttribute("aria-expanded")).toBe("true");
    await until(() => document.querySelectorAll(".coach-pc").length === 2, "its card");
    expect(gets(calls, "/api/coach/proposals/dp-2")).toHaveLength(1);
    const opened = alsoSection()!.querySelector(".coach-pc")!;
    expect(opened.textContent).toContain("Hips and back, gently");
    expect([...opened.querySelectorAll("button")].some((b) => b.textContent === "Approve")).toBe(true);
    await click(alsoLines()[0], "the first line again");
    expect(alsoLines()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(alsoSection()!.querySelector(".coach-pc")).toBeNull();
  });

  it("with no run to show, the composer — and the suggestions still waiting under it", async () => {
    serve({ "GET /api/coach/runs/current": { run: null, alsoOpen: alsoOpen.slice(0, 1) } });
    mount();
    await until(() => !!alsoSection(), "Also waiting");
    expect(document.querySelector(".coach-composer-field")).not.toBeNull();
    expect(alsoLines().map((b) => b.textContent)).toEqual(["Hips and back, gently · Sun 1:05 PM"]);
  });

  it("a kept read's list is never shown: only a read made since the screen opened says what is waiting", async () => {
    serve({ "GET /api/coach/runs/current": () => new Promise<Response>(() => undefined) as unknown as Response });
    mount({ prime: (qc) => qc.setQueryData(COACH_CURRENT_QUERY, { run: null, alsoOpen: alsoOpen.slice(0, 1) }) });
    await settle(20);
    expect(alsoSection()).toBeNull();
  });

  it("nothing else open (or an older server that doesn't say): no Also waiting at all", async () => {
    serve({
      "GET /api/coach/runs/current": { run: run(), events: [], proposal: { id: "dp-1", status: "pending", flags: [] } },
      "GET /api/coach/proposals/dp-1": proposal("dp-1", [line("op-1", "Gym session")]),
    });
    mount();
    await until(() => text().includes("Gym session"), "the current card");
    await settle(20);
    expect(alsoSection()).toBeNull();
  });
});

// ── The week's budget ───────────────────────────────────────────────────────

describe("the week's budget (R11, M6, D11, §2.11)", () => {
  const spend = (spentUsd: number, cutoffUsd = 20) => ({ since: `${TODAY}T00:00:00.000Z`, spentMicros: Math.round(spentUsd * 1e6), spentUsd, warnMicros: 5e6, cutoffMicros: cutoffUsd * 1e6 });
  const coachPrefs = (defaultScope: "now" | "week" | "next_n") => ({
    coach: { defaultScope },
    settings: { defaultScope, nextN: 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } },
    model: { id: "m", name: "The coach's model" },
  });
  const field = () => document.querySelector<HTMLTextAreaElement>(".coach-composer-field");
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
  const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs");

  it("past the week's cutoff: one plain line where the ways to start were — nothing to tap that would start a run", async () => {
    const calls = serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/spend": spend(20.4) });
    mount();
    await until(() => text().includes("This week's AI budget is used up."), "the line");
    expect(text()).toContain("This week's AI budget is used up. The coach can design again next week.");
    expect(button("Now")).toBeNull();
    expect(button("Later today")).toBeNull();
    expect(button("Plan ahead")).toBeNull();
    expect(document.querySelector(".coach-composer-actions")).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it("a set as the default and the week tighter than its limit: '$X left this week' beside what a set usually costs", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/spend": spend(17.9), "GET /api/coach/preferences": coachPrefs("week") });
    mount();
    await until(() => text().includes("left this week"), "the week's line");
    expect(document.querySelector(".coach-composer-cost")!.textContent).toBe("A plan for the next 7 days usually costs about $3–5; $2.10 left this week.");
  });

  it("the run's own limit the tighter one: no word of the week", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/spend": spend(4), "GET /api/coach/preferences": coachPrefs("week") });
    mount();
    await until(() => !!document.querySelector(".coach-composer-cost"), "the cost line");
    await settle(20);
    expect(document.querySelector(".coach-composer-cost")!.textContent).toBe("A plan for the next 7 days usually costs about $3–5.");
  });

  it("the spend can't be read: the composer as it was", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!field(), "the composer");
    await settle(20);
    expect(button("Now")).not.toBeNull();
    expect(text()).not.toContain("budget");
  });

  it("the server's 409 week_budget: one plain line, the words kept, no run", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/spend": spend(19.6),
      "POST /api/coach/runs": () => json({ error: "week_budget", spentUsd: 19.6, cutoffUsd: 20 }, 409),
    });
    mount();
    await until(() => !!field(), "the composer");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field()!, "plan my week");
      field()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Plan ahead"), "Plan ahead");
    await click(button("Next 7 days"), "Next 7 days");
    await until(() => text().includes("not enough for this request"), "the line");
    expect(document.querySelector(".coach-composer-error")!.textContent).toBe("This week's AI budget has $0.40 left — not enough for this request.");
    expect(posts(calls)).toHaveLength(1);
    expect(field()!.value).toBe("plan my week");
    expect(document.querySelector(".coach-run")).toBeNull();
  });

  it("a live set's estimate: the week's left beside it when the week is the tighter limit", async () => {
    const live = run({ id: "run-set", scope: { kind: "week" }, status: "waiting_set", costUsd: 0.5, estimateUsd: 4.23, ceilingUsd: 6, proposalId: null, finishedAt: null });
    serve({ "GET /api/coach/runs/current": { run: live, events: [], proposal: null }, "GET /api/coach/spend": spend(17.9) });
    mount({ loop: quietLoop(() => live) });
    await until(() => text().includes("left this week"), "the estimate");
    expect(document.querySelector(".coach-run-estimate")!.textContent).toBe("About $4.23; $2.10 left this week");
  });
});
