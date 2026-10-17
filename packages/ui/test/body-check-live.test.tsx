// @vitest-environment jsdom
/**
 * THE BODY CHECK, TAPPED (the new shape, 2026-10-17): each chip keeps its answer (one request), Sore opens the area
 * picker and Done keeps the areas picked, Undo asks the server to put the session back, and a designed workout's "Ask
 * the coach to adapt it" opens the coach with the words written. Synthetic data; fetch is stubbed.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BodyCheckDto, WorkoutDto } from "@rg/api-client";
import { BodyCheck } from "../src/screens/today/body-check.js";
import { CoachOpenContext } from "../src/screens/studio/coach-ask.js";

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

const AREAS = [
  { id: "neck", label: "Neck" },
  { id: "hips", label: "Hips" },
  { id: "calves", label: "Calves" },
];
const view = (over: Partial<BodyCheckDto> = {}): BodyCheckDto => ({ workoutId: "w1", answer: null, change: null, open: true, areas: AREAS, ...over });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const workout = { id: "w1", title: "Long run", effectiveDate: "2026-10-17", category: "long" } as WorkoutDto;

/** The server: answers each request from `reply`, and keeps what was sent. */
function serve(reply: (method: string, path: string, body: unknown) => Response) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // The athlete's units (Settings): kilometres.
      if (path === "/api/settings") return json({ prefs: { units: "km" } });
      sent.push({ method, path, body });
      return reply(method, path, body);
    }),
  );
  return sent;
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
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === name);
const tap = async (name: string) => {
  const b = button(name);
  if (!b) throw new Error(`no button "${name}"; the page says: ${text()}`);
  await act(async () => b.click());
};

function mount(el: ReactNode, opener: { open: (a?: unknown) => void } | null = null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(CoachOpenContext.Provider, { value: opener as never }, el)));
  });
}

describe("tapping the body check", () => {
  it("A bit heavy keeps the answer in one request and says what it did; Undo puts it back", async () => {
    const sent = serve((method, path) => {
      if (method === "GET") return json(view());
      if (path === "/api/today/body") return json(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "eased", to: { meters: 14000 } } }));
      return json(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "kept", why: "undone" } }));
    });
    mount(createElement(BodyCheck, { workout }));
    await until(() => sent.length === 1, "the read");
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/today/body?workout=w1" });
    await tap("A bit heavy");
    await until(() => text().includes("Eased to 14 km for heavy legs"), "the line");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ method: "POST", path: "/api/today/body", body: { workoutId: "w1", feel: "heavy" } }]);
    expect(button("A bit heavy")?.getAttribute("aria-pressed")).toBe("true");
    await tap("Undo");
    await until(() => text().includes("Kept as planned."), "the undo's line");
    expect(sent.at(-1)).toEqual({ method: "POST", path: "/api/today/body/undo", body: { workoutId: "w1" } });
  });

  it("Sore somewhere opens the picker; Done keeps the areas picked, in one request", async () => {
    const sent = serve((method, _path, body) => {
      if (method === "GET") return json(view());
      const b = body as { feel: string; areas?: string[] };
      return json(view({ answer: { feel: "sore", areas: b.areas ?? [] }, change: { kind: "kept", why: "quiet" } }));
    });
    mount(createElement(BodyCheck, { workout }));
    // Sore waits for the areas it offers.
    await until(() => button("Sore somewhere")?.disabled === false, "the read");
    await tap("Sore somewhere");
    expect(button("Sore somewhere")?.getAttribute("aria-expanded")).toBe("true");
    expect(button("Done")?.disabled).toBe(true);
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
    await tap("Neck");
    await tap("Calves");
    expect(button("Neck")?.getAttribute("aria-pressed")).toBe("true");
    await tap("Done");
    await until(() => text().includes("Noted — today leaves your neck and calves alone."), "the line");
    expect(sent.filter((s) => s.method === "POST")).toEqual([
      { method: "POST", path: "/api/today/body", body: { workoutId: "w1", feel: "sore", areas: ["neck", "calves"] } },
    ]);
    expect(button("Done")).toBeUndefined();
  });

  it("a designed workout: Ask the coach to adapt it opens the coach with the words written", async () => {
    serve((method) =>
      method === "GET" ? json(view()) : json(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "ask" } })),
    );
    const open = vi.fn();
    mount(createElement(BodyCheck, { workout }), { open });
    await until(() => !!button("A bit heavy"), "the chips");
    await tap("A bit heavy");
    await until(() => !!button("Ask the coach to adapt it"), "the ask");
    await tap("Ask the coach to adapt it");
    expect(open).toHaveBeenCalledWith({ request: "Legs are heavy; adapt today's session" });
  });

  it("an ease that had to build the session first is finished by asking again, at once — one tap, two requests", async () => {
    const heavy = { feel: "heavy" as const, areas: [] };
    let posts = 0;
    const sent = serve((method) => {
      if (method === "GET") return json(view());
      posts += 1;
      return json(view({ answer: heavy, change: { kind: "eased", to: { mode: "consistent" } }, ...(posts === 1 ? { pending: true as const } : {}) }));
    });
    mount(createElement(BodyCheck, { workout }));
    await until(() => !!button("A bit heavy"), "the chips");
    await tap("A bit heavy");
    await until(() => text().includes("Eased to a consistent session for heavy legs") && !button("Undo")?.disabled, "the line");
    expect(sent.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([
      { workoutId: "w1", feel: "heavy" },
      { workoutId: "w1", feel: "heavy" },
    ]);
  });

  it("a check read while an ease is still pending is finished once, by the card", async () => {
    const heavy = { feel: "heavy" as const, areas: [] };
    const sent = serve((method) =>
      method === "GET"
        ? json(view({ answer: heavy, change: { kind: "eased", to: { mode: "consistent" } }, pending: true }))
        : json(view({ answer: heavy, change: { kind: "eased", to: { mode: "consistent" } } })),
    );
    mount(createElement(BodyCheck, { workout }));
    await until(() => sent.some((s) => s.method === "POST"), "the finish");
    await settle(20);
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ method: "POST", path: "/api/today/body", body: { workoutId: "w1", feel: "heavy" } }]);
  });

  it("a save that fails says so and keeps nothing as chosen", async () => {
    serve((method) => (method === "GET" ? json(view()) : json({ error: "offline" }, 503)));
    mount(createElement(BodyCheck, { workout }));
    await until(() => !!button("Fresh"), "the chips");
    await tap("Fresh");
    await until(() => text().includes("Couldn't save — try again."), "the error");
    expect(button("Fresh")?.getAttribute("aria-pressed")).toBe("false");
  });
});
