// @vitest-environment jsdom
/**
 * A DESIGNED RUN'S CARD (§8 §3): its steps on the face — time or distance, effort, pace in the athlete's units, a
 * distance's time on the watch — each part once with its rounds, the totals, and what the watch does on approve ("Goes
 * to your watch when you approve", or "Your watch will show time only"). No Edit (the builder plays no runs). The
 * numbers are the server's (the wire's own): the card only words them. Synthetic data; a stubbed fetch.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignLineDto, DesignRunDto } from "@rg/api-client";
import { ProposalCard } from "../src/screens/studio/proposal-card.js";
import { paceBandWords, RunSteps, runStepWords, runTotalsWords, RUN_WATCH_LINES } from "../src/screens/studio/run-card.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN: DesignRunDto = {
  segments: [
    { rounds: 1, steps: [{ role: "warmup", effort: "easy", seconds: 600, meters: null, pace: { fastSecPerKm: 349, slowSecPerKm: 409 }, asked: false, why: "Ease in." }] },
    {
      rounds: 3,
      steps: [
        { role: "work", effort: "tempo", seconds: 480, meters: null, pace: { fastSecPerKm: 299, slowSecPerKm: 314 }, asked: false, why: "Comfortably hard." },
        { role: "recovery", effort: "recovery", seconds: 120, meters: null, pace: { fastSecPerKm: 379, slowSecPerKm: 439 }, asked: false, why: null },
      ],
    },
    { rounds: 1, steps: [{ role: "cooldown", effort: "easy", seconds: 758, meters: 2000, pace: { fastSecPerKm: 349, slowSecPerKm: 409 }, asked: false, why: "Settle." }] },
  ],
  totalSeconds: 3158,
  totalMeters: 9579,
  watch: "goes",
};

describe("a run step in words", () => {
  it("its time or distance, its effort, its pace in the athlete's units, a distance's time on the watch", () => {
    expect(runStepWords(RUN.segments[1]!.steps[0]!, "km")).toBe("8 min · Tempo · 4:59–5:14 /km");
    expect(runStepWords(RUN.segments[1]!.steps[0]!, "mi")).toBe("8 min · Tempo · 8:01–8:25 /mi");
    expect(runStepWords(RUN.segments[2]!.steps[0]!, "km")).toBe("2 km · Easy · 5:49–6:49 /km · on your watch as 13 min");
    expect(runStepWords(RUN.segments[2]!.steps[0]!, "mi")).toBe("1.24 mi · Easy · 9:22–10:58 /mi · on your watch as 13 min");
    expect(runStepWords({ role: "work", effort: "by_feel", seconds: 1200, meters: null, pace: null, asked: false, why: null }, "km")).toBe("20 min · By feel");
    expect(runStepWords({ role: "recovery", effort: null, seconds: 60, meters: null, pace: null, asked: false, why: null }, "km")).toBe("Rest 1 min");
    expect(paceBandWords({ fastSecPerKm: 280, slowSecPerKm: 290 }, "km")).toBe("4:40–4:50 /km");
    expect(runTotalsWords(RUN, "km")).toBe("53 min · 9.6 km");
    expect(runTotalsWords({ totalSeconds: null, totalMeters: null }, "km")).toBeNull();
  });
});

describe("RunSteps", () => {
  it("each part once with its rounds, said for the ear too; the totals; the watch line while it is still to decide", () => {
    const html = renderToStaticMarkup(createElement(RunSteps, { run: RUN, units: "km", open: false, decided: false }));
    expect(html).toContain("<ol");
    expect(html).toContain("Warm-up");
    expect(html).toContain("3 ×");
    expect(html).toContain("Repeat 3 times");
    expect(html).toContain("Cool-down");
    expect(html).toContain("53 min · 9.6 km");
    expect(html).toContain("Goes to your watch when you approve");
    // The whys, one tap down.
    expect(html).not.toContain("Comfortably hard.");
    expect(renderToStaticMarkup(createElement(RunSteps, { run: RUN, units: "km", open: true, decided: false }))).toContain("Comfortably hard.");
    // Decided: no watch promise left on the card.
    expect(renderToStaticMarkup(createElement(RunSteps, { run: RUN, units: "km", open: false, decided: true }))).not.toContain("Goes to your watch");
    expect(renderToStaticMarkup(createElement(RunSteps, { run: { ...RUN, watch: "time_only" }, units: "km", open: false, decided: false }))).toContain(RUN_WATCH_LINES.time_only);
    expect(renderToStaticMarkup(createElement(RunSteps, { run: { ...RUN, watch: null }, units: "km", open: false, decided: false }))).not.toContain("coach-pc-run-watch");
  });
});

// ── On the suggestion's card ──────────────────────────────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const line: DesignLineDto = {
  opId: "r-1", kind: "new", date: "2026-10-20", time: "07:00", title: "Tempo blocks", minutes: 53, summary: "Tempo blocks · 53 min", effort: "Develop",
  place: "Home", parts: ["Warm-up", "Run · Intervals × 3", "Cool-down"], detail: ["Run", "Run", "Run", "Run"], reviewMean: 4.5,
  review: null, issues: [], outcome: null, written: null, intent: "Three tempo blocks.", whys: ["Ease in.", "Comfortably hard.", null, "Settle."], alternates: [[], [], [], []],
  run: RUN,
};

it("the suggestion's card shows a run's steps on its face, in the athlete's units, and offers no Edit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).split("?")[0]!;
      if (path === "/api/coach/proposals/dp-1") return new Response(JSON.stringify({ id: "dp-1", status: "pending", resolvedAt: null, title: "Tempo blocks", flags: [], lines: [line], changes: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient();
  qc.setQueryData(["settings"], { prefs: { units: "mi", weightUnit: "lb" } });
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ProposalCard, { proposalId: "dp-1" }))));
  });
  for (let i = 0; i < 100 && !(document.body.textContent ?? "").includes("Tempo"); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("8 min · Tempo · 8:01–8:25 /mi");
  expect(text).toContain("on your watch as 13 min");
  expect(text).toContain("Goes to your watch when you approve");
  // The run's steps stand in for a workout's move list: never "Run" four times.
  expect(text).not.toContain("Run Run");
  expect(document.querySelector("a.coach-pc-edit")).toBeNull();
});
