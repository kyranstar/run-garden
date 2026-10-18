// @vitest-environment jsdom
/**
 * THE COACH'S AI ACCOUNT IS OUT OF CREDITS (owner report, 2026-10-09).
 *
 * The worker now answers a gateway 402 with `out_of_credits` and keeps a record of it (services/ai-credits.ts). Every
 * place that waits on the coach must stop waiting on it and say so in one plain line: an effort's read card, and
 * Settings → Coach & AI. (The Plan's chat with the thread coach went with the new shape: the coach is one conversation,
 * whose stops say so in its own words — coach-conversation-model.test.ts.)
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import { OUT_OF_CREDITS_LINE } from "../src/ai-credits.js";
import { CoachRead } from "../src/screens/coach-read.js";
import { CoachAiSection } from "../src/screens/settings/coach-settings.js";

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

describe("an effort's read card", () => {
  it("says the same line, with Try again — never the generic failure", async () => {
    emptyAccountWorker();
    mount(createElement(CoachRead, { activityId: "act-1" }));
    await until(() => text().includes(OUT_OF_CREDITS_LINE), "the out-of-credits line");
    expect(text()).not.toContain("couldn't read this effort");
    expect(button("Try again")).toBeDefined();
  });
});

describe("Settings → Coach & AI", () => {
  function settingsWorker(outOfCreditsSince: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        // The settings answer; the coach's own reads are not this test's (a server whose coach is off: 404).
        url.startsWith("/api/settings") ? json({
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
        }) : json({ error: "not_found" }, 404),
      ),
    );
  }

  it("shows the line while the account is empty", async () => {
    settingsWorker("2026-10-08T09:00:00.000Z");
    mount(createElement(CoachAiSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => text().includes("AI this week"), "the card");
    expect(text()).toContain(OUT_OF_CREDITS_LINE);
  });

  it("and not otherwise", async () => {
    settingsWorker(null);
    mount(createElement(CoachAiSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => text().includes("AI this week"), "the card");
    expect(text()).not.toContain(OUT_OF_CREDITS_LINE);
  });
});
