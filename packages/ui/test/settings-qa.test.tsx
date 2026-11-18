// @vitest-environment jsdom
/**
 * Settings → Developer → LifeOS QA (the phone QA harness; the worker's routes/qa.ts): the owner's panel for the QA account.
 * Nothing renders unless the worker answers the status (anyone but the owner gets a 404). Set up makes the account, its
 * fixtures and a pairing code in one, and shows the code with the line for `scripts/phone-qa.sh`; Purge asks first, then
 * says how many rows remain (zero). Against a stubbed worker; synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaStatusDto } from "@rg/api-client";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import { QaSection } from "../src/screens/settings/qa.js";
import { SettingsScreen } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-18T19:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const HARNESS = `rgq_${"1".repeat(8)}-0000-4000-8000-000000000001_1800000000_${"b".repeat(64)}`;
const PLAN = "c".repeat(64);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string; body: unknown }>;

const none: QaStatusDto = { qa: null, today: "2026-11-18", rows: 0, devices: [], plan: [] };
const some: QaStatusDto = {
  qa: { userId: "11111111-0000-4000-8000-000000000001", accountTag: "3f2a9c1e", createdAt: iso(-60_000) },
  today: "2026-11-18",
  rows: 42,
  devices: [{ state: "active", scope: "training-v3", label: "LifeOS phone", lastUsedAt: iso(-30_000) }],
  plan: [
    { title: "QA Hips and back", date: "2026-11-18", time: "15:00", state: "scheduled" },
    { title: "QA Core reset", date: "2026-11-19", time: "07:00", state: "scheduled" },
  ],
};

function worker(init: { status?: number; body?: unknown; exists?: boolean } = {}) {
  let status: QaStatusDto | unknown = init.body ?? none;
  let purgeSteps = 0;
  let pairs = 0;
  calls = [];
  const json = (b: unknown, code = 200) => new Response(JSON.stringify(b), { status: code, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      calls.push({ method, path: url, body: req?.body ? JSON.parse(String(req.body)) : null });
      if (url === "/api/qa/status") return init.status ? json({ error: "not_found" }, init.status) : json(status);
      if (url === "/api/qa/user") return init.exists ? json({ error: "qa_exists" }, 409) : json({ qa: { userId: some.qa!.userId, accountTag: "3f2a9c1e" } }, 201);
      if (url === "/api/qa/seed") {
        status = some;
        return init.exists ? json({ error: "already_seeded" }, 409) : json({ today: "2026-11-18", tomorrow: "2026-11-19", fixtures: [] });
      }
      if (url === "/api/qa/pairings") {
        pairs += 1;
        return json({ code: pairs === 1 ? "7K2QXM9D" : "ABCD1234", expiresAt: iso(5 * 60_000), scope: "training-v3", planToken: PLAN, harnessToken: HARNESS, harnessExpiresAt: iso(6 * 3_600_000), accountTag: "3f2a9c1e" });
      }
      if (url === "/api/qa/purge") {
        // Two steps: the worker purges within its per-request budget, and says when it's done.
        purgeSteps += 1;
        if (purgeSteps === 1) return json({ done: false, removed: { schedule_overrides: 3 }, remaining: { planned_workouts: 5 }, total: 5 });
        status = none;
        return json({ done: true, removed: { planned_workouts: 5, users: 1 }, remaining: { planned_workouts: 0, users: 0 }, total: 0 });
      }
      // The other cards' reads, as settings-devices.test.tsx answers them.
      if (url === "/api/settings") return json({ prefs: DEFAULT_USER_PREFERENCES, llm: null });
      if (url === "/api/auth/me") return json({ userId: "u", email: "owner@example.test", connections: [], fixtureMode: false, restore: null });
      if (url === "/api/native/devices") return json({ enabled: true, devices: [] });
      if (url === "/api/my-saves/status") return json({ error: "not_found" }, 404);
      if (url === "/api/conditions") return json({ profiles: [] });
      if (url === "/api/places") return json({ places: [], equipment: [] });
      if (url === "/api/coach/preferences") return json({ coach: { trainingTimes: [] }, settings: { defaultScope: "now", nextN: 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } }, model: { name: "A model" } });
      if (url === "/api/coach/spend") return json({ spentUsd: 0, spentMicros: 0, warnMicros: 5_000_000, cutoffMicros: 20_000_000 });
      if (url === "/api/coach/memory") return json({ items: [] });
      if (url === "/api/coros/status") return json({ connected: false, email: null, lastSyncAt: null, lastErrorCategory: null });
      if (url === "/api/garden") return json({ restMode: { active: false, until: null } });
      if (url === "/api/calendar/calendars") return json({ calendars: [] });
      return json({});
    }),
  );
}

async function mount(el: typeof QaSection | typeof SettingsScreen = QaSection) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(el))));
  });
  await flush();
}
const headings = () => [...host!.querySelectorAll("h2")].map((h) => words(h));
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (name: string) => [...host!.querySelectorAll("button")].find((b) => words(b) === name);
const click = async (b: HTMLButtonElement | undefined) => {
  expect(b, "button").toBeDefined();
  await act(async () => b!.click());
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Settings → Developer", () => {
  it("shows for the owner (the worker answers the status), after Data & account", async () => {
    worker({ body: some });
    await mount(SettingsScreen);
    expect(headings().slice(-2)).toEqual(["Data & account", "Developer"]);
    expect(words(host)).toContain("LifeOS QA");
  }, 30_000);

  it("is not there for anyone else (a 404)", async () => {
    worker({ status: 404 });
    await mount(SettingsScreen);
    expect(headings()).not.toContain("Developer");
    expect(words(host)).not.toContain("LifeOS QA");
  }, 30_000);
});

describe("Settings → Developer → LifeOS QA", () => {
  it("renders nothing for anyone the worker doesn't answer (a 404), or an answer it doesn't recognise", async () => {
    worker({ status: 404 });
    await mount();
    expect(words(host)).toBe("");
    act(() => root?.unmount());
    host?.remove();
    worker({ body: {} });
    await mount();
    expect(words(host)).toBe("");
  });

  it("with no QA account: says so, and Set up makes it, its fixtures and a code — shown with the line for phone-qa.sh", async () => {
    worker();
    await mount();
    expect(words(host)).toContain("LifeOS QA");
    expect(words(host)).toContain("No QA account");
    await click(button("Set up"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/qa/user", "/api/qa/seed", "/api/qa/pairings"]);
    const text = words(host);
    expect(text).toContain("7K2Q-XM9D");
    expect(text).toContain(`QA_HARNESS_TOKEN=${HARNESS} QA_PLAN_TOKEN=${PLAN} QA_PAIR_CODE=7K2QXM9D scripts/phone-qa.sh`);
    expect(text).toContain("42 rows");
    expect(text).toContain("QA Hips and back");
    expect(text).toContain("LifeOS phone");
  });

  it("with one: a new code on demand", async () => {
    worker({ body: some });
    await mount();
    await click(button("New pairing code"));
    expect(words(host)).toContain("7K2Q-XM9D");
  });

  it("Purge asks first; Not now sends nothing; Purge says the rows that remain: zero", async () => {
    worker({ body: some });
    await mount();
    await click(button("Purge"));
    expect(words(host)).toContain("Purge everything the QA account holds?");
    await click(button("Not now"));
    expect(calls.some((c) => c.path === "/api/qa/purge")).toBe(false);
    await click(button("Purge"));
    await click(button("Purge everything"));
    // Asked until done: two steps, their removals summed.
    expect(calls.filter((c) => c.path === "/api/qa/purge")).toEqual(Array(2).fill({ method: "POST", path: "/api/qa/purge", body: { confirm: "purge qa" } }));
    expect(words(host)).toContain("Purged: 9 rows removed, 0 remain.");
    expect(words(host)).toContain("No QA account");
  });
});
