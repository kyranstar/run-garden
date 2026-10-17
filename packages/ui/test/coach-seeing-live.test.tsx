// @vitest-environment jsdom
/**
 * THE SEAM WITH THE SHELL (the new shape, stream C ↔ B): `useCoach().open({ request?, seeing? })` opens the app's one
 * coach sheet, and `useCoachSeeing(focus | null)` is how a screen says what it shows — the sheet's quiet "Seeing" hint
 * when the athlete opens the coach from the nav (or any Ask) without naming one.
 *
 *  - Without the sheet in the app (the coach off) there is no opener, and registering is harmless.
 *  - `open()` sees what the screen registered; `open({ seeing })` names its own; `open({ seeing: null })` sees nothing.
 *  - `open({ request })` writes the words in the box — the athlete's to send, never sent for them.
 *  - What a screen registered goes with it; the newest registration wins, and an older one comes back when it goes.
 *  - A screen re-rendering with an equal focus (a new object each render) registers it once.
 *
 * Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeeingRegistry, useCoach, useCoachSeeing } from "../src/screens/studio/coach-ask.js";
import { dayFocus, moveFocus, workoutFocus, type CoachFocus } from "../src/screens/studio/coach-focus.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { click, dialog, quietLoop, run, serve, settle, until } from "./coach-live-harness.js";
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

const WORKOUT = workoutFocus({ id: "w1", title: "Long run", effectiveDate: TODAY, workoutSeconds: 3600, calendarSeconds: 3600 });
const DAY = dayFocus(TODAY);
const MOVE = moveFocus({ id: "gobletSquat", name: "Goblet squat" });

/** A screen that registers what it shows, and asks in the given way. */
function Screen({ seeing, ask }: { seeing: CoachFocus | null; ask: Parameters<NonNullable<ReturnType<typeof useCoach>>["open"]>[0] }) {
  useCoachSeeing(seeing);
  const coach = useCoach();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", id: "opener", onClick: () => coach?.open(ask) }, "Coach"),
    createElement("button", { type: "button", id: "leave", onClick: () => navigate("/bare") }, "Leave"),
  );
}

/** A screen with no registration of its own: the nav's Coach button on it. */
function Bare() {
  const coach = useCoach();
  return createElement("button", { type: "button", id: "opener", onClick: () => coach?.open() }, "Coach");
}

function mount(children: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient({ today: todayDto(null) });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/here"] },
          createElement(
            CoachSheetProvider,
            { loopDeps: quietLoop(() => run()) },
            createElement(Routes, null, createElement(Route, { path: "/here", element: children }), createElement(Route, { path: "/bare", element: createElement(Bare) })),
          ),
        ),
      ),
    );
  });
}

const box = () => dialog()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const quietServer = () =>
  serve({
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": { id: null, startedAt: null, turns: [] },
  });

describe("without the coach's sheet", () => {
  it("there is no opener, and a screen registering what it shows draws and throws nothing", () => {
    let seen: ReturnType<typeof useCoach> | undefined;
    function Lone() {
      useCoachSeeing(WORKOUT);
      seen = useCoach();
      return createElement("p", null, "a screen");
    }
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: primedClient() }, createElement(Lone)));
    expect(html).toBe("<p>a screen</p>");
    expect(seen).toBeNull();
  });
});

describe("open() and what the screen registered", () => {
  it("open() with nothing named sees what the screen registered", async () => {
    quietServer();
    mount(createElement(Screen, { seeing: WORKOUT, ask: undefined }));
    await click(document.getElementById("opener"), "the coach button");
    await until(() => !!box(), "the box in the sheet");
    expect(dialog()!.textContent).toContain(WORKOUT.label);
  });

  it("open({ seeing }) names its own; open({ seeing: null }) sees nothing at all", async () => {
    quietServer();
    mount(createElement(Screen, { seeing: WORKOUT, ask: { seeing: MOVE } }));
    await click(document.getElementById("opener"), "the coach button");
    await until(() => !!box(), "the box");
    expect(dialog()!.textContent).toContain(MOVE.label);
    expect(dialog()!.textContent).not.toContain(WORKOUT.label);
    act(() => root?.unmount());
    host?.remove();
    quietServer();
    mount(createElement(Screen, { seeing: WORKOUT, ask: { seeing: null } }));
    await click(document.getElementById("opener"), "the coach button");
    await until(() => !!box(), "the box");
    expect(dialog()!.textContent).not.toContain(WORKOUT.label);
  });

  it("open({ request }) writes the words in the box, and nothing is sent for the athlete", async () => {
    const calls = quietServer();
    mount(createElement(Screen, { seeing: null, ask: { request: "15 minutes for my hips" } }));
    await click(document.getElementById("opener"), "the coach button");
    await until(() => !!box(), "the box");
    expect(box()!.value).toBe("15 minutes for my hips");
    await settle(20);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs")).toEqual([]);
  });

  it("what a screen registered goes with it: on the next screen the coach sees nothing", async () => {
    quietServer();
    mount(createElement(Screen, { seeing: WORKOUT, ask: undefined }));
    await click(document.getElementById("leave"), "Leave");
    await click(document.getElementById("opener"), "the coach button on the bare screen");
    await until(() => !!box(), "the box");
    expect(dialog()!.textContent).not.toContain(WORKOUT.label);
  });
});

describe("the registry", () => {
  it("the newest registration wins; when it goes, the one before comes back; listeners hear each change", () => {
    const r = new SeeingRegistry();
    const heard: Array<string | null> = [];
    const off = r.subscribe(() => heard.push(r.current?.label ?? null));
    expect(r.current).toBeNull();
    const a = r.register(DAY);
    const b = r.register(WORKOUT);
    expect(r.current).toBe(WORKOUT);
    b();
    expect(r.current).toBe(DAY);
    // Unregistering twice changes nothing.
    b();
    a();
    expect(r.current).toBeNull();
    off();
    r.register(MOVE);
    expect(heard).toEqual([DAY.label, WORKOUT.label, DAY.label, null]);
  });

  it("a screen re-rendering with an equal focus (a new object each render) registers it once", async () => {
    const registered: string[] = [];
    const spy = vi.spyOn(SeeingRegistry.prototype, "register").mockImplementation(function (this: SeeingRegistry, f: CoachFocus) {
      registered.push(f.label);
      return () => undefined;
    });
    let bump: (() => void) | null = null;
    function Rerendering() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      // A new object every render, equal in what it names.
      useCoachSeeing({ ...WORKOUT });
      return createElement("p", null, `render ${n}`);
    }
    quietServer();
    mount(createElement(Rerendering));
    for (let i = 0; i < 5; i++) act(() => bump!());
    await settle();
    expect(registered).toEqual([WORKOUT.label]);
    spy.mockRestore();
  });
});
