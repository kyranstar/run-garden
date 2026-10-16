// @vitest-environment jsdom
/**
 * SETTINGS → COACH AND MEMORY V2, LIVE (Stage 3 Task 10) — what each control sends, and what comes back on screen:
 *
 *  - Memory: Pin and Unpin send `{ pinned }`, Confirm sends `{ confirm: true }`; a pin past the cap shows the server's
 *    plain words; an edit and a delete go out exactly as they always have (`{ body }`; DELETE).
 *  - Coach: a tap on a scope, a count, a limit save the settings whole; a limit typed past its default is refused on
 *    the spot and never sent; a server whose coach is off (404) shows nothing.
 *
 * Synthetic data only.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachMemoryItem } from "@rg/api-client";
import { coachSettings, type CoachPreferences } from "@rg/domain";
import { features } from "../src/features.js";
import { CoachMemorySection } from "../src/screens/settings/coach-memory.js";
import { CoachSection } from "../src/screens/settings/coach-settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-03T09:00:00.000Z";
const mem = (id: string, over: Partial<CoachMemoryItem> = {}): CoachMemoryItem => ({
  id,
  kind: "fact",
  body: `Body ${id}`,
  provenance: { source: "message", at: AT },
  learnedAt: AT,
  expiresAt: null,
  pinned: false,
  confidence: "stated",
  supersededBy: null,
  ...over,
});

function fakeWorker(init: { memory?: CoachMemoryItem[]; pinRefusal?: boolean; coach?: CoachPreferences; coachOff?: boolean } = {}) {
  const state = { memory: init.memory ?? [], coach: init.coach ?? {} };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const prefs = () => ({ coach: state.coach, settings: coachSettings(state.coach), model: { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      const body = req?.body ? JSON.parse(String(req.body)) : null;
      calls.push({ method, path: url, body });
      if (url === "/api/coach/memory" && method === "GET") return json({ memory: state.memory, history: [] });
      const m = url.match(/^\/api\/coach\/memory\/(.+)$/);
      if (m && method === "PATCH") {
        if (init.pinRefusal && body.pinned === true) return json({ error: "pin_cap", max: 12, why: "Twelve are pinned already. Unpin one first." }, 409);
        state.memory = state.memory.map((x) => (x.id === m[1] ? { ...x, ...(body.body ? { body: body.body } : {}), ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}), ...(body.confirm ? { confidence: "confirmed" as const } : {}) } : x));
        return json({ ok: true, item: state.memory.find((x) => x.id === m[1]) });
      }
      if (m && method === "DELETE") {
        state.memory = state.memory.filter((x) => x.id !== m[1]);
        return json({ ok: true });
      }
      if (url === "/api/coach/preferences") {
        if (init.coachOff) return json({ error: "not_found" }, 404);
        if (method === "PUT") state.coach = body;
        return json(prefs());
      }
      if (url === "/api/coach/spend") return json({ since: AT, spentMicros: 1_250_000, spentUsd: 1.25, warnMicros: 5_000_000, cutoffMicros: 20_000_000, byKind: [] });
      return json({});
    }),
  );
  return { state, calls };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const was = { coach: features.coach, studio: features.studio };

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, el));
  });
}

beforeEach(() => {
  features.coach = true;
  features.studio = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  Object.assign(features, was);
});

const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${text()}`);
}
async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error(`no control\n${text()}`);
  await act(async () => {
    el.click();
  });
}
/** The button named `name` in the item whose words are `body`. */
const inItem = (body: string, name: string) =>
  [...document.querySelectorAll<HTMLElement>(".memory-item")].find((el) => el.textContent?.includes(body))?.querySelectorAll<HTMLButtonElement>("button") &&
  [...[...document.querySelectorAll<HTMLElement>(".memory-item")].find((el) => el.textContent!.includes(body))!.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name,
  );
const writes = (calls: Array<{ method: string; path: string; body: unknown }>) => calls.filter((c) => c.method !== "GET");

describe("the memory list", () => {
  it("pin, unpin and confirm send just that", async () => {
    const { calls } = fakeWorker({ memory: [mem("a", { body: "Long runs on Sunday", kind: "rule" }), mem("b", { body: "Squats go better late", kind: "observation", confidence: "inferred" })] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Long runs on Sunday"), "the list");
    expect(text()).toContain("Rule · You said · From your message, Oct 3");
    await click(inItem("Long runs on Sunday", "Pin"));
    await until(() => text().includes("Rule · You said · From your message, Oct 3 · Pinned"), "pinned");
    await click(inItem("Long runs on Sunday", "Unpin"));
    await click(inItem("Squats go better late", "Confirm"));
    await until(() => text().includes("Something the coach noticed · Confirmed"), "confirmed");
    expect(inItem("Squats go better late", "Confirm")).toBeUndefined();
    expect(writes(calls)).toEqual([
      { method: "PATCH", path: "/api/coach/memory/a", body: { pinned: true } },
      { method: "PATCH", path: "/api/coach/memory/a", body: { pinned: false } },
      { method: "PATCH", path: "/api/coach/memory/b", body: { confirm: true } },
    ]);
  });

  it("a pin past the cap shows the server's plain words, and nothing is pinned", async () => {
    fakeWorker({ memory: [mem("a", { body: "Has a bench" })], pinRefusal: true });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Has a bench"), "the list");
    await click(inItem("Has a bench", "Pin"));
    await until(() => text().includes("Twelve are pinned already. Unpin one first."), "the refusal");
    expect(text()).not.toContain("· Pinned");
  });

  it("edit and delete go out as they always have", async () => {
    const { calls } = fakeWorker({ memory: [mem("a", { body: "Trains mornings" }), mem("b", { body: "Old fact" })] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Trains mornings"), "the list");
    await click(inItem("Trains mornings", "Edit"));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Edit memory"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Trains evenings");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await until(() => text().includes("Trains evenings"), "the edit");
    await click(inItem("Old fact", "Delete"));
    await click(inItem("Old fact", "Yes"));
    await until(() => !text().includes("Old fact"), "the delete");
    expect(writes(calls)).toEqual([
      { method: "PATCH", path: "/api/coach/memory/a", body: { body: "Trains evenings" } },
      { method: "DELETE", path: "/api/coach/memory/b", body: null },
    ]);
  });

  // ── Fix wave 3B, M9 (LIVE: the memory list is in production for the thread coach) ──

  it("Delete asks first, inline: 'Delete for good?' — No sends nothing and puts the actions back; Yes deletes", async () => {
    const { calls } = fakeWorker({ memory: [mem("a", { body: "Old fact" }), mem("b", { body: "Kept fact" })] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Old fact"), "the list");
    await click(inItem("Old fact", "Delete"));
    const item = () => [...document.querySelectorAll<HTMLElement>(".memory-item")].find((el) => el.textContent!.includes("Old fact"))!;
    expect(item().textContent).toContain("Delete for good?");
    expect(inItem("Old fact", "Yes")).toBeDefined();
    expect(inItem("Old fact", "No")).toBeDefined();
    // The question takes the place of that item's actions only.
    expect(inItem("Old fact", "Edit")).toBeUndefined();
    expect(inItem("Kept fact", "Delete")).toBeDefined();
    expect(writes(calls)).toEqual([]);
    await click(inItem("Old fact", "No"));
    expect(item().textContent).not.toContain("Delete for good?");
    expect(inItem("Old fact", "Delete")).toBeDefined();
    expect(writes(calls)).toEqual([]);
    await click(inItem("Old fact", "Delete"));
    await click(inItem("Old fact", "Yes"));
    await until(() => !text().includes("Old fact"), "the delete");
    expect(writes(calls)).toEqual([{ method: "DELETE", path: "/api/coach/memory/a", body: null }]);
    expect(text()).toContain("Kept fact");
  });

  it("after Yes, the focus goes to the next item's first control — never dropped with the item it was on", async () => {
    fakeWorker({ memory: [mem("a", { body: "First fact", learnedAt: "2026-10-03T09:00:00.000Z" }), mem("b", { body: "Second fact", learnedAt: "2026-10-02T09:00:00.000Z" })] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Second fact"), "the list");
    // Newest first: "First fact", then "Second fact".
    await click(inItem("First fact", "Delete"));
    await click(inItem("First fact", "Yes"));
    await until(() => !text().includes("First fact"), "the delete");
    await until(() => document.activeElement === inItem("Second fact", "Pin"), "the focus on the next item's first control");
  });

  it("after Yes on the last item, the focus goes to the section's heading", async () => {
    fakeWorker({ memory: [mem("a", { body: "Only fact" })] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Only fact"), "the list");
    await click(inItem("Only fact", "Delete"));
    await click(inItem("Only fact", "Yes"));
    await until(() => !text().includes("Only fact"), "the delete");
    await until(() => document.activeElement?.textContent === "Coach memory", "the focus on the section's heading");
    expect(document.activeElement?.tagName).toMatch(/^H\d$/);
  });

  it("the caption says, plainly, what the list is and that all of it can be changed", async () => {
    fakeWorker({ memory: [mem("a")] });
    mount(createElement(CoachMemorySection));
    await until(() => text().includes("Body a"), "the list");
    expect(text()).toContain("Everything the coach remembers about you — from your messages, answers and requests. Edit or delete any of it.");
    expect(text()).not.toContain("learned from your messages, editable here");
  });
});

describe("Settings → Coach", () => {
  it("a tap on a scope or a count saves the settings whole", async () => {
    const { calls } = fakeWorker({ coach: { ceilingsUsd: { day: 1 } } });
    mount(createElement(CoachSection));
    await until(() => text().includes("AI spend this week") && text().includes("$1.25 of $20.00"), "the card and the week's spend");
    await click(buttons().find((b) => b.textContent === "Next 7 days"));
    await until(() => buttons().find((b) => b.textContent === "Next 7 days")?.getAttribute("aria-pressed") === "true", "pressed");
    const select = document.querySelector<HTMLSelectElement>("select.coach-n")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "5");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => text().includes("Next 5 workouts"), "N");
    expect(writes(calls).map((c) => c.body)).toEqual([
      { ceilingsUsd: { day: 1 }, defaultScope: "week" },
      { ceilingsUsd: { day: 1 }, defaultScope: "week", nextN: 5 },
    ]);
  });

  /** Type into the first limit's field and press Enter. */
  async function typeLimit(v: string) {
    const [day] = [...document.querySelectorAll<HTMLInputElement>(".coach-limit input")];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(day!, v);
      day!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      day!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  it("a limit lowered is saved; one past its default is refused on the spot and never sent", async () => {
    const { calls } = fakeWorker();
    mount(createElement(CoachSection));
    await until(() => text().includes("Spending limit"), "the card");
    await typeLimit("2");
    await until(() => text().includes("At most $1.50."), "the refusal");
    expect(writes(calls)).toEqual([]);
    await typeLimit("0.75");
    await until(() => writes(calls).length === 1, "the save");
    expect(writes(calls)[0]!.body).toEqual({ ceilingsUsd: { day: 0.75 } });
    expect(text()).not.toContain("At most");
  });

  it("a limit set back at its default is no setting at all", async () => {
    const { calls } = fakeWorker({ coach: { nextN: 2, ceilingsUsd: { day: 0.75 } } });
    mount(createElement(CoachSection));
    await until(() => document.querySelector<HTMLInputElement>(".coach-limit input")?.value === "0.75", "the stored limit");
    await typeLimit("1.50");
    await until(() => writes(calls).length === 1, "the save");
    expect(writes(calls)[0]!.body).toEqual({ nextN: 2 });
  });

  it("Add a time: the focus goes to the new time's field (fix wave 3B, B-I9)", async () => {
    fakeWorker({ coach: { trainingTimes: ["07:00"] } });
    mount(createElement(CoachSection));
    await until(() => !!buttons().find((b) => b.textContent === "Add a time"), "Add a time");
    await click(buttons().find((b) => b.textContent === "Add a time"));
    const fields = [...document.querySelectorAll<HTMLInputElement>('input[type="time"]')];
    expect(fields).toHaveLength(2);
    expect(document.activeElement).toBe(fields[1]);
    expect(fields[1]!.getAttribute("aria-label")).toBe("Training time 2");
  });

  it("a server whose coach is off answers 404: the card isn't there", async () => {
    fakeWorker({ coachOff: true });
    mount(createElement(CoachSection));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(text()).toBe("");
  });
});
