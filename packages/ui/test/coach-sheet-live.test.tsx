// @vitest-environment jsdom
/**
 * COACH EVERYWHERE, PHASE A3 — the app's one coach sheet, live:
 *
 *  - `useCoach().open({ focus, request, scope })` opens it in place — the composer with the focus's chip, the run view
 *    and the suggestion's card in the sheet, never a trip to the Studio; the focus moves into it (the field), Escape
 *    and ✕ close it and give the focus back, and leaving the screen closes it;
 *  - Now / Later today / Plan ahead post the focus with the words (`{ kind, id }`, never its label); the ✕ on the chip
 *    takes it off, and the next start carries none; a focus the server refuses is said in plain words;
 *  - a live run is shown in its place (one run at a time); a finished one from before is not brought back;
 *  - the suggestion card's "Change something…" sends a follow-up — the words and the suggestion as the focus, no scope
 *    (the server takes the suggestion's own) — and the new run's trail takes the old card's place.
 *
 * The server is a stubbed fetch; the step loop is a quiet stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachRunDto, CoachRunStepResult, DesignLineDto } from "@rg/api-client";
import { useCoach } from "../src/screens/studio/coach-ask.js";
import { workoutFocus } from "../src/screens/studio/coach-focus.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { StudioCoach } from "../src/screens/studio/composer.js";
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
  status: "active",
  steps: 0,
  costUsd: 0,
  proposalId: null,
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: any;
}

function serve(routes: Record<string, unknown | ((body: any) => Response)>): Call[] {
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
      if (typeof answer === "function") return (answer as (b: unknown) => Response)(body);
      return answer instanceof Response ? answer.clone() : json(answer);
    }),
  );
  return calls;
}

const quietLoop = (r: () => CoachRunDto) => (): LoopDeps => ({
  step: () => new Promise(() => undefined),
  read: async () => ({ run: r(), events: [] }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  visible: () => true,
  onVisibility: () => () => undefined,
});

/** A loop the test drives: each step waits until `answer` gives its result; the read answers the server's run. */
function drivenLoop(server: () => CoachRunDto) {
  const waiting: Array<(r: CoachRunStepResult) => void> = [];
  const deps = (): LoopDeps => ({
    step: () => new Promise<CoachRunStepResult>((r) => waiting.push(r)),
    read: async () => ({ run: server(), events: [] }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => true,
    onVisibility: () => () => undefined,
  });
  const answer = async (r: CoachRunStepResult) => {
    await until(() => waiting.length > 0, "a step out");
    await act(async () => waiting.shift()!(r));
    await settle(10);
  };
  return { deps, answer };
}

const FOCUS = workoutFocus({ id: "w1", title: "Strength", effectiveDate: TODAY, workoutSeconds: 2400, calendarSeconds: 2400 });

/** A screen with one way to ask, and a way to leave it. */
function Screen() {
  const coach = useCoach();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", id: "opener", onClick: () => coach?.open({ focus: FOCUS, request: "Something easier?" }) }, "Ask about it"),
    createElement("button", { type: "button", id: "leave", onClick: () => navigate("/elsewhere") }, "Leave"),
  );
}

let client: QueryClient | null = null;

function mount(children: ReactNode = createElement(Screen), o: { loop?: () => LoopDeps; path?: string } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = primedClient({ today: todayDto(null) });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: client! },
        createElement(
          MemoryRouter,
          { initialEntries: [o.path ?? "/plan"] },
          createElement(
            CoachSheetProvider,
            { loopDeps: o.loop ?? quietLoop(() => run()) },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/plan", element: children }),
              createElement(Route, { path: "/studio", element: children }),
              createElement(Route, { path: "/elsewhere", element: createElement("p", null, "elsewhere") }),
            ),
          ),
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
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const field = () => document.querySelector<HTMLTextAreaElement>(".coach-composer-field");
async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs").map((c) => c.body);

describe("the sheet, opened by the hook", () => {
  it("opens in place on the screen asked from: the chip, the words, the field focused; the focus's scope primary", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    expect(dialog()).toBeNull();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer in the sheet");
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.querySelector("h2")?.textContent).toBe("Coach");
    expect(d.querySelector(".coach-about")?.textContent).toContain("About: ");
    expect(d.textContent).toContain(FOCUS.label);
    expect(field()!.value).toBe("Something easier?");
    await until(() => document.activeElement === field(), "the field focused");
    // A workout (today's or another day's): Now is the primary way to start — one workout, which the request's day or
    // workout directs (the review, I1: never a whole week's set for one workout).
    expect(d.querySelector(".btn-primary")?.textContent).toBe("Now");
    // It stayed on the screen it was opened from.
    expect(document.getElementById("opener")).not.toBeNull();
  });

  it("Escape closes it and gives the focus back to what opened it; so does ✕", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    const opener = document.getElementById("opener")!;
    opener.focus();
    await click(opener, "the opener");
    await until(() => !!field(), "the composer");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await click(opener, "the opener again");
    await until(() => !!field(), "the composer again");
    await click(dialog()!.querySelector('button[aria-label="Close"]'), "✕");
    expect(dialog()).toBeNull();
  });

  it("leaving the screen closes it", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await act(async () => {
      dialog()!.querySelector<HTMLElement>(".coach-composer-field")!.blur();
    });
    // A link inside it (a card's Edit, its "On your plan") leaves the screen: the sheet goes with it.
    await click(document.getElementById("leave"), "Leave");
    expect(text()).toContain("elsewhere");
    expect(dialog()).toBeNull();
  });
});

describe("the focus, once (the review, I2)", () => {
  it("a run that ends in the sheet never pulls the focus back into the field: the composer comes back without taking it", async () => {
    let status: CoachRunDto["status"] = "active";
    const loop = drivenLoop(() => run({ id: "run-once", status }));
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-once", request: body.request }), existing: false }),
    });
    mount(createElement(Screen), { loop: loop.deps });
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await until(() => document.activeElement === field(), "the field focused on open");
    await click(button("Now", dialog()!), "Now");
    await until(() => !!dialog()!.querySelector(".coach-run"), "the run view");
    // The run ends: the composer is drawn again, and the focus stays with the run's result.
    status = "finished";
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => !!field(), "the composer back");
    await settle(20);
    expect(document.activeElement).not.toBe(field());
  });

  it("opened over a live run: when it ends, the composer comes back without taking the focus", async () => {
    let status: CoachRunDto["status"] = "active";
    const loop = drivenLoop(() => run({ id: "run-live-once", status, request: "the live one" }));
    serve({ "GET /api/coach/runs/current": { run: run({ id: "run-live-once", status: "active", request: "the live one" }), events: [], proposal: null } });
    mount(createElement(Screen), { loop: loop.deps });
    await click(document.getElementById("opener"), "the opener");
    await until(() => text().includes("the live one"), "the live run");
    status = "finished";
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => !!field(), "the composer");
    await settle(20);
    expect(document.activeElement).not.toBe(field());
  });
});

describe("starting from it", () => {
  it("Now posts the focus — its kind and id, never its label — with the words", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ request: body.request }), existing: false }),
    });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await click(button("Now", dialog()!), "Now");
    expect(posts(calls)).toEqual([{ scope: { kind: "now" }, request: "Something easier?", focus: { kind: "workout", id: "w1" } }]);
    // The run view takes the composer's place, in the sheet.
    await until(() => text().includes("Coach · "), "the run view");
    expect(dialog()!.querySelector(".coach-run")).not.toBeNull();
  });

  it("the chip's ✕ takes the focus off: the start carries none", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ request: body.request }), existing: false }),
    });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await click(dialog()!.querySelector(".coach-about-clear"), "the chip's ✕");
    expect(dialog()!.querySelector(".coach-about")).toBeNull();
    // With no focus, the athlete's own default scope is primary again (none set: Now).
    expect(dialog()!.querySelector(".btn-primary")?.textContent).toBe("Now");
    await click(button("Later today", dialog()!), "Later today");
    expect(posts(calls)).toEqual([{ scope: { kind: "later_today" }, request: "Something easier?" }]);
  });

  it("a focus the server refuses is said plainly; the words stay", async () => {
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": json({ error: "focus_out_of_range", why: "Ask about a day from Tue 14 Oct to Mon 27 Oct." }, 400),
    });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await click(button("Now", dialog()!), "Now");
    await until(() => text().includes("Ask about a day from Tue 14 Oct to Mon 27 Oct."), "the refusal");
    expect(field()!.value).toBe("Something easier?");
  });

  it("a workout that isn't there any more: one plain line", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "POST /api/coach/runs": json({ error: "focus_not_found" }, 404) });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await click(button("Now", dialog()!), "Now");
    await until(() => text().includes("That isn't there any more"), "the refusal");
  });

  it("a live run is shown in its place; a finished one from before is not brought back", async () => {
    serve({ "GET /api/coach/runs/current": { run: run({ status: "active", request: "the live one" }), events: [], proposal: null } });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => text().includes("the live one"), "the live run");
    expect(field()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    serve({
      "GET /api/coach/runs/current": { run: run({ id: "old", status: "finished", proposalId: "dp-old" }), events: [], proposal: { id: "dp-old", flags: [] } },
      "GET /api/coach/proposals/dp-old": { id: "dp-old", status: "pending", resolvedAt: null, lines: [], changes: [] },
    });
    mount();
    await click(document.getElementById("opener"), "the opener");
    await until(() => !!field(), "the composer");
    await settle(20);
    expect(dialog()!.querySelector(".coach-run")).toBeNull();
  });
});

describe("a follow-up from the card", () => {
  const line: DesignLineDto = {
    opId: "o1",
    kind: "new",
    date: TODAY,
    time: null,
    atNow: true,
    title: "Hips, gently",
    minutes: 25,
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
  } as DesignLineDto;

  it("'Change something…' sends the words with the suggestion as the focus and no scope; the new run's trail takes the card's place", async () => {
    let created = false;
    const calls = serve({
      "GET /api/coach/runs/current": () =>
        json(created ? { run: run({ id: "run-2", status: "active", request: "Make it 15 minutes" }), events: [], proposal: null } : { run: run({ status: "finished", proposalId: "dp-run-1" }), events: [], proposal: { id: "dp-run-1", flags: [] } }),
      "GET /api/coach/proposals/dp-run-1": { id: "dp-run-1", status: "pending", resolvedAt: null, lines: [line], changes: [] },
      "POST /api/coach/runs": (body: any) => {
        created = true;
        return json({ run: run({ id: "run-2", status: "active", request: body.request }), existing: false });
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: primedClient({ today: todayDto(null) }) },
          createElement(
            MemoryRouter,
            { initialEntries: ["/studio"] },
            createElement(StudioCoach, { ctx: { ...emptyStudioCtx, today: TODAY, profiles: [] }, loopDeps: quietLoop(() => run({ id: "run-2", status: "active", request: "Make it 15 minutes" })) }),
          ),
        ),
      );
    });
    await until(() => !!document.querySelector(".coach-pc-follow input"), "the follow-up line");
    const input = document.querySelector<HTMLInputElement>(".coach-pc-follow input")!;
    expect(input.placeholder).toBe("Change something…");
    await type(input, "  Make it 15 minutes  ");
    await act(async () => {
      document.querySelector<HTMLFormElement>(".coach-pc-follow")!.requestSubmit();
    });
    await settle();
    expect(posts(calls)).toEqual([{ request: "Make it 15 minutes", focus: { kind: "proposal", id: "dp-run-1" } }]);
    await until(() => text().includes("Make it 15 minutes") && !!document.querySelector(".coach-run"), "the new run's trail");
    // The old card gives way to the new run's trail; the new suggestion's card comes when it is ready.
    expect(document.querySelector("section.coach-pc")).toBeNull();
  });

  it("a follow-up that ends with no suggestion (it failed, or was cancelled) gives the original card back (the review, minor 3)", async () => {
    let created = false;
    let status: CoachRunDto["status"] = "active";
    const loop = drivenLoop(() => run({ id: "run-back", status, request: "Make it 15 minutes" }));
    serve({
      "GET /api/coach/runs/current": () =>
        json(created ? { run: run({ id: "run-back", status, request: "Make it 15 minutes" }), events: [], proposal: null } : { run: run({ status: "finished", proposalId: "dp-run-1" }), events: [], proposal: { id: "dp-run-1", flags: [] } }),
      "GET /api/coach/proposals/dp-run-1": { id: "dp-run-1", status: "pending", resolvedAt: null, lines: [line], changes: [] },
      "POST /api/coach/runs": (body: any) => {
        created = true;
        return json({ run: run({ id: "run-back", status: "active", request: body.request }), existing: false });
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: primedClient({ today: todayDto(null) }) },
          createElement(MemoryRouter, { initialEntries: ["/studio"] }, createElement(StudioCoach, { ctx: { ...emptyStudioCtx, today: TODAY, profiles: [] }, loopDeps: loop.deps })),
        ),
      );
    });
    await until(() => !!document.querySelector(".coach-pc-follow input"), "the follow-up line");
    await type(document.querySelector<HTMLInputElement>(".coach-pc-follow input")!, "Make it 15 minutes");
    await act(async () => {
      document.querySelector<HTMLFormElement>(".coach-pc-follow")!.requestSubmit();
    });
    await until(() => document.querySelector("section.coach-pc") === null, "the card giving way to the follow-up's trail");
    // The follow-up's run fails, proposing nothing: the suggestion it was asked from is still the athlete's — shown again.
    status = "failed";
    await loop.answer({ status: "failed", nextDue: null, events: [] });
    await until(() => !!document.querySelector("section.coach-pc"), "the original card back");
    expect(document.querySelector("section.coach-pc")!.textContent).toContain("Hips, gently");
  });

  it("an empty line sends nothing", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run({ status: "finished", proposalId: "dp-run-1" }), events: [], proposal: { id: "dp-run-1", flags: [] } },
      "GET /api/coach/proposals/dp-run-1": { id: "dp-run-1", status: "pending", resolvedAt: null, lines: [line], changes: [] },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: primedClient({ today: todayDto(null) }) },
          createElement(MemoryRouter, { initialEntries: ["/studio"] }, createElement(StudioCoach, { ctx: { ...emptyStudioCtx, today: TODAY, profiles: [] }, loopDeps: quietLoop(() => run()) })),
        ),
      );
    });
    await until(() => !!document.querySelector(".coach-pc-follow input"), "the follow-up line");
    await type(document.querySelector<HTMLInputElement>(".coach-pc-follow input")!, "   ");
    await act(async () => {
      document.querySelector<HTMLFormElement>(".coach-pc-follow")!.requestSubmit();
    });
    await settle();
    expect(posts(calls)).toEqual([]);
  });
});
