// @vitest-environment jsdom
/**
 * THE COACH'S AI ACCOUNT IS OUT OF CREDITS (owner report, 2026-10-09).
 *
 * The worker now answers a gateway 402 with `out_of_credits` and keeps a record of it (services/ai-credits.ts). Every
 * place that waits on the coach must stop waiting on it and say so in one plain line: the chat (instead of "Coach is
 * thinking…", with a Retry), an effort's read card, and Settings → AI. The athlete's message stays in the thread.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import { OUT_OF_CREDITS_LINE } from "../src/ai-credits.js";
import { CoachPanel } from "../src/screens/coach-panel.js";
import { CoachRead } from "../src/screens/coach-read.js";
import { coachPanelProps, usePlanCoach } from "../src/screens/plan.js";
import { AiSection } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** A worker in memory whose AI account is empty. */
function emptyAccountWorker() {
  const state = {
    messages: [] as Array<Record<string, unknown>>,
    outOfCredits: null as null | { since: string; lastSeenAt: string },
  };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      const body = req?.body ? JSON.parse(String(req.body)) : null;
      const path = url.replace(/\?.*$/, "");
      calls.push({ method, path, body });
      if (path === "/api/coach/state") {
        return json({
          messages: state.messages,
          pendingProposals: [],
          settledProposals: [],
          openQuestion: null,
          memoryCount: 0,
          lastCoachAt: null,
          wakeAdvised: false,
          // A reply is owed, but nothing is thinking about it — the worker's own rule now.
          coachThinking: false,
          outOfCredits: state.outOfCredits,
        });
      }
      if (path === "/api/coach/message" || path === "/api/coach/wake") {
        if (path === "/api/coach/message") {
          state.messages.push({ id: `m${state.messages.length}`, role: "user", body: body.body, refs: {}, at: new Date().toISOString() });
        }
        const at = new Date().toISOString();
        state.outOfCredits = { since: state.outOfCredits?.since ?? at, lastSeenAt: at };
        return json({ status: "out_of_credits" });
      }
      if (path.startsWith("/api/coach/analyze/")) return json({ error: "out_of_credits" }, 402);
      return json({});
    }),
  );
  return { state, calls };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === name);

async function until(check: () => boolean, what: string, ms = 2_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`);
}

/** The plan page's wiring, minus the page: the same hook, the same props, the same panel. */
function PlanCoach() {
  const coach = usePlanCoach();
  const props = coachPanelProps(coach, new Map());
  return props ? createElement(CoachPanel, props) : null;
}

describe("the chat", () => {
  it("a send that meets an empty AI account stops 'thinking' at once and says why — the words stay", async () => {
    emptyAccountWorker();
    mount(createElement(PlanCoach));
    await until(() => !!document.querySelector("input[aria-label='Message your coach']"), "the composer");
    const input = document.querySelector<HTMLInputElement>("input[aria-label='Message your coach']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "how is my week?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("Send")!.click();
    });
    // Well inside the 15 s the client bridges a send for: the answer is already known.
    await until(() => text().includes(OUT_OF_CREDITS_LINE), "the out-of-credits line");
    const field = document.querySelector<HTMLInputElement>("input[aria-label='Message your coach']")!;
    expect(field.placeholder).not.toBe("Coach is thinking…");
    expect(field.disabled).toBe(false);
    expect(text()).toContain("how is my week?");
  });

  it("Retry asks the coach again", async () => {
    const { state, calls } = emptyAccountWorker();
    state.outOfCredits = { since: "2026-10-08T09:00:00.000Z", lastSeenAt: "2026-10-09T07:00:00.000Z" };
    state.messages.push({ id: "m0", role: "user", body: "still there?", refs: {}, at: "2026-10-09T07:00:00.000Z" });
    mount(createElement(PlanCoach));
    await until(() => !!button("Retry"), "Retry");
    await act(async () => {
      button("Retry")!.click();
    });
    await until(() => calls.some((c) => c.path === "/api/coach/wake"), "the wake");
    expect(calls.find((c) => c.path === "/api/coach/wake")!.body).toEqual({ force: true });
    // Still empty: the line is back at once, not after the 15 s bridge.
    await until(() => text().includes(OUT_OF_CREDITS_LINE), "the line again");
  });

  it("answering the coach's question: the same — the line, at once", async () => {
    const { calls } = emptyAccountWorker();
    const stateAnswer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, req) => {
      const path = String(url).replace(/\?.*$/, "");
      if (path === "/api/coach/state") {
        const res = (await (await stateAnswer(url, req)).json()) as Record<string, unknown>;
        const answered = calls.some((c) => c.path === "/api/coach/questions/q1/answer");
        return json({ ...res, openQuestion: answered ? null : { id: "q1", body: "Long run Saturday or Sunday?", chips: ["Saturday", "Sunday"], askedAt: "2026-10-09T07:00:00.000Z" } });
      }
      if (path === "/api/coach/questions/q1/answer") {
        calls.push({ method: "POST", path, body: null });
        await stateAnswer("/api/coach/wake", { method: "POST", body: "{}" });
        return json({ ok: true, memoryId: "mem1", wake: { status: "out_of_credits" } });
      }
      return stateAnswer(url, req);
    });
    mount(createElement(PlanCoach));
    await until(() => !!button("Sunday"), "the question's chips");
    await act(async () => {
      button("Sunday")!.click();
    });
    await until(() => text().includes(OUT_OF_CREDITS_LINE), "the out-of-credits line");
  });
});

describe("the panel itself", () => {
  const base = {
    messages: [],
    proposals: [],
    question: null,
    onSend: () => undefined,
    onApprove: () => undefined,
    onDecline: () => undefined,
    onAnswer: () => undefined,
    onDismiss: () => undefined,
    onRetry: () => undefined,
  };

  it("a wake actually running wins: 'thinking', not the credits line", () => {
    mount(createElement(CoachPanel, { ...base, outOfCredits: true, busy: true }));
    expect(text()).not.toContain(OUT_OF_CREDITS_LINE);
    expect(button("Retry")).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>("input")!.placeholder).toBe("Coach is thinking…");
  });

  it("no record, no line", () => {
    mount(createElement(CoachPanel, { ...base, outOfCredits: false }));
    expect(text()).not.toContain(OUT_OF_CREDITS_LINE);
  });
});

describe("an effort's read card", () => {
  it("says the same line, with Try again — never the generic failure", async () => {
    emptyAccountWorker();
    mount(createElement(CoachRead, { activityId: "act-1" }));
    await until(() => text().includes(OUT_OF_CREDITS_LINE), "the out-of-credits line");
    expect(text()).not.toContain("couldn't read this effort");
    expect(button("Try again")).toBeDefined();
  });
});

describe("Settings → AI", () => {
  function settingsWorker(outOfCreditsSince: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          prefs: DEFAULT_USER_PREFERENCES,
          llm: {
            spentDollars: 1.2,
            warnDollars: 5,
            cutoffDollars: 20,
            maxDollars: 25,
            warn: false,
            cutoff: false,
            outOfCreditsSince,
          },
        }),
      ),
    );
  }

  it("shows the line while the account is empty", async () => {
    settingsWorker("2026-10-08T09:00:00.000Z");
    mount(createElement(AiSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => text().includes("Spend this week"), "the card");
    expect(text()).toContain(OUT_OF_CREDITS_LINE);
  });

  it("and not otherwise", async () => {
    settingsWorker(null);
    mount(createElement(AiSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => text().includes("Spend this week"), "the card");
    expect(text()).not.toContain(OUT_OF_CREDITS_LINE);
  });
});
