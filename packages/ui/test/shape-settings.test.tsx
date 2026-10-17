// @vitest-environment jsdom
/**
 * THE NEW SHAPE, SETTINGS (2026-10-17 brief, stream B): five groups behind the athlete's mark —
 *
 *  - Connections: Google Calendar; COROS, with its sync switch, sleep and history in the one card.
 *  - Training: Times (the run times, the reminder, the buffers, the zone — and the coach's training times beside
 *    them), Race, Units, Places & equipment, Health conditions, Sounds.
 *  - Coach & AI: one card — the AI switch, the per-request limits, the model and ONE spend line — then Memory.
 *  - Garden: rest mode.
 *  - Data & account: your data, Import (folded here, no longer gated), diagnostics, and the account itself.
 *
 * Saving as you go (no Save button), real switches (`role="switch"`), short hints. The page is rendered whole against a
 * stubbed worker. Synthetic data only.
 */
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import { SettingsScreen } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
});

const coachPrefs = {
  coach: { trainingTimes: ["07:00"] },
  settings: { defaultScope: "now", nextN: 3, trainingTimes: ["07:00"], ceilingsUsd: { day: 1.5, set: 6 } },
  model: { name: "A model" },
};

function worker(prefs: Partial<UserPreferences> = {}) {
  const state = { prefs: { ...DEFAULT_USER_PREFERENCES, ...prefs } as UserPreferences };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      const body = req?.body ? JSON.parse(String(req.body)) : null;
      const path = url.replace(/\?.*$/, "");
      calls.push({ method, path, body });
      if (path === "/api/settings" && method === "GET") return json({ prefs: state.prefs, llm: { spentDollars: 1.2, cutoffDollars: 20, warn: false, cutoff: false, outOfCreditsSince: null } });
      if (path === "/api/settings" && method === "PUT") {
        state.prefs = { ...state.prefs, ...body };
        return json({ ok: true, prefs: state.prefs });
      }
      if (path === "/api/auth/me") return json({ email: "sam@example.test", connections: [], fixtureMode: false, restore: null });
      if (path === "/api/conditions") return json({ profiles: [{ profileId: "p-x", label: "Knee", active: false, since: null }] });
      if (path === "/api/places") return json({ places: [], equipment: [] });
      if (path === "/api/coach/preferences") return json(coachPrefs);
      if (path === "/api/coach/spend") return json({ spentUsd: 1.2, spentMicros: 1_200_000, warnMicros: 5_000_000, cutoffMicros: 20_000_000 });
      if (path === "/api/coach/memory") return json({ items: [] });
      if (path === "/api/coros/status") return json({ connected: true, email: "sam@example.test", lastSyncAt: null, lastErrorCategory: null });
      if (path === "/api/garden") return json({ restMode: { active: false, until: null } });
      if (path === "/api/calendar/calendars") return json({ calendars: [] });
      return json({});
    }),
  );
  return { state, calls };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`waited for ${what}\n${document.body.textContent}`);
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(SettingsScreen)))));
  await until(() => !!host!.querySelector(".settings-group") && words(host!).includes("Coach & AI") && !!host!.querySelector(".coach-spend"), "the settings");
}

const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const groups = () => [...host!.querySelectorAll<HTMLElement>(".settings-group")];
const group = (name: string) => groups().find((g) => words(g.querySelector("h2")) === name)!;
const cards = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>(".card")].map((c) => words(c.querySelector("h3")));

describe("five groups", () => {
  it("Connections, Training, Coach & AI, Garden, Data & account — each a heading, its cards one level under it", async () => {
    worker();
    await mount();
    expect(groups().map((g) => words(g.querySelector("h2")))).toEqual(["Connections", "Training", "Coach & AI", "Garden", "Data & account"]);
    for (const g of groups()) {
      for (const c of g.querySelectorAll(".card")) expect(c.querySelector("h2"), words(c)).toBeNull();
    }
  });

  it("each group holds what the brief puts in it", async () => {
    worker();
    await mount();
    expect(cards(group("Connections"))).toEqual(["Google Calendar", "COROS"]);
    expect(cards(group("Training"))).toEqual(["Times", "Race", "Units", "Places & equipment", "Health conditions", "Sounds"]);
    expect(cards(group("Coach & AI"))).toEqual(["Coach & AI", "Coach memory"]);
    expect(cards(group("Garden"))).toEqual(["Rest mode"]);
    expect(cards(group("Data & account"))).toEqual(["Your data", "Import", "Diagnostics", "Account"]);
  });

  it("COROS is one card: the connection, the sync switch, sleep and history", async () => {
    worker();
    await mount();
    const coros = [...group("Connections").querySelectorAll<HTMLElement>(".card")][1]!;
    expect(words(coros)).toContain("Write date changes back to COROS");
    expect(words(coros)).toContain("Sleep from COROS");
    expect(words(coros)).toContain("History");
  });

  it("the coach's training times sit with the run times; Coach & AI has no time-frame setting left", async () => {
    worker();
    await mount();
    const times = [...group("Training").querySelectorAll<HTMLElement>(".card")][0]!;
    await until(() => !!times.querySelector(".coach-time-row"), "the coach's times");
    expect(times.querySelector('input[aria-label="Training time 1"]')).not.toBeNull();
    const coach = group("Coach & AI");
    expect(words(coach)).not.toMatch(/Start with|Next workouts|Training times/);
  });

  it("the account: who is signed in, and Sign out", async () => {
    worker();
    await mount();
    const account = [...group("Data & account").querySelectorAll<HTMLElement>(".card")].at(-1)!;
    expect(words(account)).toContain("sam@example.test");
    expect([...account.querySelectorAll("button")].map(words)).toContain("Sign out");
  });
});

describe("saving as you go, with real switches", () => {
  it("no Save button: a choice saves itself, alone", async () => {
    const { calls } = worker();
    await mount();
    expect([...host!.querySelectorAll("button")].map(words)).not.toContain("Save scheduling");
    const window = host!.querySelector<HTMLSelectElement>("#s-window")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(window, "evening");
      window.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => calls.some((c) => c.method === "PUT" && c.path === "/api/settings"), "the save");
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/settings").map((c) => c.body)).toEqual([{ defaultWindow: "evening" }]);
  });

  it("a time saves when it is left, and only if it changed", async () => {
    const { calls } = worker();
    await mount();
    const time = host!.querySelector<HTMLInputElement>("#s-wm")!;
    await act(async () => {
      time.focus();
      time.blur();
    });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(time, "06:30");
      time.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      time.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await until(() => calls.some((c) => c.method === "PUT"), "the save");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ weekdayMorningTime: "06:30" }]);
  });

  it("the AI and COROS-writes switches are real switches, and a tap saves", async () => {
    const { calls } = worker({ aiEnabled: true, corosWritesEnabled: false });
    await mount();
    const ai = host!.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Activity reads and the week\'s story"]')!;
    expect(ai.getAttribute("aria-checked")).toBe("true");
    const writes = host!.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Write date changes back to COROS"]')!;
    expect(writes.getAttribute("aria-checked")).toBe("false");
    await act(async () => writes.click());
    await until(() => calls.some((c) => c.method === "PUT"), "the save");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ corosWritesEnabled: true }]);
  });

  it("one spend line", async () => {
    worker();
    await mount();
    const lines = [...host!.querySelectorAll(".coach-spend")];
    expect(lines).toHaveLength(1);
    expect(words(lines[0])).toBe("AI this week: $1.20 of $20.00");
    expect(words(host!)).not.toContain("Spend this week");
  });
});

describe("the leftovers", () => {
  it("no `settings-new` class, no dead Import gate", () => {
    for (const f of ["screens/settings.tsx", "screens/settings/sounds.tsx"]) expect(src(f), f).not.toContain("settings-new");
    expect(src("screens/settings.tsx")).not.toContain("features.import");
  });

  it("hints are short: one line each", async () => {
    worker();
    await mount();
    for (const h of host!.querySelectorAll(".hint")) expect(words(h).length, words(h)).toBeLessThanOrEqual(70);
  });
});
