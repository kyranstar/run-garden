// @vitest-environment jsdom
/**
 * TODAY'S "NEEDS YOU" CHIP (where you stand, spec 2026-11-05 §7.2, §13.5): when the coach's read sees drift — a
 * discipline slipping, sessions not logged, a key result behind — Today shows that one chip; a tap opens the coach with
 * its request and its id (the run diagnoses first). Nothing without the coach, without a drift chip, or when the read
 * fails. Proactive means a chip, never a push: nothing starts without the tap. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeedsYouToday } from "../src/components/needs-you-today.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { click, json, serve, settle, until, type Call } from "./coach-live-harness.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
});

const DRIFT = {
  id: "drift:discipline:strength",
  label: "1 of 4 planned lifts logged in 3 weeks — talk it through?",
  request: "1 of 4 planned lifts logged in 3 weeks — let's talk it through.",
};
const MISSED = { id: "missed:w1", label: "Rework my week around Tuesday's tempo", request: "Rework my week around Tuesday's tempo — I missed it." };

function mount(coach: CoachOpener | null = { open: vi.fn() }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let el = createElement(MemoryRouter, null, createElement(NeedsYouToday));
  if (coach) el = createElement(CoachOpenContext.Provider, { value: coach }, el);
  act(() => root!.render(createElement(QueryClientProvider, { client }, el)));
  return coach;
}

const read = (calls: Call[]) => calls.filter((c) => c.path === "/api/coach/nudges").length;

describe("Today's needs-you chip", () => {
  it("shows the drift chip (only that one), and a tap opens the coach with its request and its id", async () => {
    const calls = serve({ "GET /api/coach/nudges": { nudges: [MISSED, DRIFT] } });
    const coach = mount()!;
    await until(() => (host!.textContent ?? "").includes(DRIFT.label), "the chip");
    expect(host!.textContent).not.toContain(MISSED.label);
    expect(read(calls)).toBe(1);
    const chip = host!.querySelector<HTMLButtonElement>("button.coach-chip--needs");
    expect(chip?.textContent).toBe(DRIFT.label);
    await click(chip, "the chip");
    expect(coach.open).toHaveBeenCalledWith({ ask: { request: DRIFT.request, nudge: DRIFT.id, label: DRIFT.label }, seeing: null });
    // Nothing was started by the screen itself: no run created.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("nothing without a drift chip, without the coach, or when the read fails", async () => {
    let calls = serve({ "GET /api/coach/nudges": { nudges: [MISSED] } });
    mount();
    await until(() => read(calls) > 0, "the read");
    await settle(20);
    expect(host!.innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();

    calls = serve({ "GET /api/coach/nudges": json({ error: "not_found" }, 404) });
    mount();
    await until(() => read(calls) > 0, "the read");
    await settle(20);
    expect(host!.innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();

    calls = serve({ "GET /api/coach/nudges": { nudges: [DRIFT] } });
    mount(null);
    await settle(30);
    expect(host!.innerHTML).toBe("");
    expect(read(calls)).toBe(0);
  });
});
