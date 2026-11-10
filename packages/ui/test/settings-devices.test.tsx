// @vitest-environment jsdom
/**
 * Settings → Devices (native device sign-in, SLICE-CONTRACT revision 2 §10.1, §4): laptop web pairs a phone and can
 * stop it. Pair shows the code once, with its expiry; a pending phone shows its label and check number, with Confirm;
 * an active one its label, last use and expiry, with Revoke; and Revoke all. Nothing renders while the switch is off
 * and no phone is paired. Against a stubbed worker; synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import type { NativeDeviceDto } from "@rg/api-client";
import { DevicesSection } from "../src/screens/settings/devices.js";
import { SettingsScreen } from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-10T19:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const DAY = 86_400_000;

const pending = (over: Partial<NativeDeviceDto> = {}): NativeDeviceDto => ({
  id: "a".repeat(64), label: "Kitchen iPhone", state: "pending", check: "4821", createdAt: iso(-60_000), confirmedAt: null, lastUsedAt: null, expiresAt: iso(9 * 60_000), expiresSoon: false, ...over,
});
const active = (over: Partial<NativeDeviceDto> = {}): NativeDeviceDto => ({
  id: "b".repeat(64), label: "Running phone", state: "active", check: null, createdAt: iso(-3 * DAY), confirmedAt: iso(-3 * DAY), lastUsedAt: iso(-2 * 3_600_000), expiresAt: iso(27 * DAY), expiresSoon: false, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string; body: unknown }>;

/** A worker in memory: the devices list and what Pair, Confirm and Revoke do to it. */
function worker(
  init: { enabled?: boolean; devices?: NativeDeviceDto[]; listStatus?: number; listBody?: unknown; pairRefusal?: unknown; confirmRefusal?: unknown } = {},
) {
  const state = { enabled: init.enabled ?? true, devices: [...(init.devices ?? [])] };
  calls = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      const path = url.replace(/\?.*$/, "");
      calls.push({ method, path, body: req?.body ? JSON.parse(String(req.body)) : null });
      if (path === "/api/native/devices" && method === "GET") {
        if (init.listStatus) return json(init.listBody ?? { error: "x" }, init.listStatus);
        return json(init.listBody ?? state);
      }
      if (path === "/api/native/pairings") return init.pairRefusal ? json(init.pairRefusal, 429) : json({ code: "7K2QXM9D", expiresAt: iso(5 * 60_000) });
      const confirm = path.match(/^\/api\/native\/devices\/(\w+)\/confirm$/);
      if (confirm && init.confirmRefusal) {
        state.devices = state.devices.filter((d) => d.id !== confirm[1]);
        return json(init.confirmRefusal, 409);
      }
      if (confirm) {
        state.devices = state.devices.map((d) => (d.id === confirm[1] ? { ...d, state: "active", check: null, confirmedAt: iso(0), expiresAt: iso(30 * DAY) } : d));
        return json({ ok: true, expiresAt: iso(30 * DAY) });
      }
      const revoke = path.match(/^\/api\/native\/devices\/(\w+)\/revoke$/);
      if (revoke) {
        state.devices = state.devices.filter((d) => d.id !== revoke[1]);
        return json({ ok: true, revoked: true });
      }
      if (path === "/api/native/devices/revoke-all") {
        const n = state.devices.length;
        state.devices = [];
        return json({ ok: true, revoked: n });
      }
      if (path === "/api/settings") return json({ prefs: DEFAULT_USER_PREFERENCES, llm: null });
      if (path === "/api/auth/me") return json({ userId: "u", email: "owner@example.test", connections: [], fixtureMode: false, restore: null });
      if (path === "/api/my-saves/status") return json({ error: "not_found" }, 404);
      // The other cards' reads, as shape-settings.test.tsx answers them.
      if (path === "/api/conditions") return json({ profiles: [] });
      if (path === "/api/places") return json({ places: [], equipment: [] });
      if (path === "/api/coach/preferences") return json({ coach: { trainingTimes: [] }, settings: { defaultScope: "now", nextN: 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } }, model: { name: "A model" } });
      if (path === "/api/coach/spend") return json({ spentUsd: 0, spentMicros: 0, warnMicros: 5_000_000, cutoffMicros: 20_000_000 });
      if (path === "/api/coach/memory") return json({ items: [] });
      if (path === "/api/coros/status") return json({ connected: false, email: null, lastSyncAt: null, lastErrorCategory: null });
      if (path === "/api/garden") return json({ restMode: { active: false, until: null } });
      if (path === "/api/calendar/calendars") return json({ calendars: [] });
      return json({});
    }),
  );
  return state;
}

async function mount(el: typeof DevicesSection | typeof SettingsScreen = DevicesSection) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(el))));
  });
  await flush();
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (name: string, within: ParentNode = host!) => [...within.querySelectorAll("button")].find((b) => words(b) === name)!;
const click = async (b: HTMLButtonElement) => {
  await act(async () => b.click());
  await flush();
};
const rowOf = (label: string) => [...host!.querySelectorAll<HTMLElement>(".setting-row")].find((r) => words(r).includes(label))!;
const clock = (ms: number) => new Date(NOW + ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

describe("Settings → Devices", () => {
  it("renders nothing while the switch is off and no phone is paired, nor for an answer it can't read", async () => {
    worker({ enabled: false });
    await mount();
    expect(host!.innerHTML).toBe("");
    act(() => root?.unmount());
    worker({ listBody: {} });
    await mount();
    expect(host!.innerHTML).toBe("");
    act(() => root?.unmount());
    worker({ listStatus: 500 });
    await mount();
    expect(host!.innerHTML).toBe("");
  });

  it("Pair shows the code once, grouped for reading, with its expiry; Done puts it away for good", async () => {
    worker();
    await mount();
    expect(words(host!.querySelector("h2, h3"))).toBe("Devices");
    expect(words(host)).toContain("No phone is paired");
    await click(button("Pair a phone"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/native/pairings"]);
    expect(words(host!.querySelector(".pair-code"))).toBe("7K2Q-XM9D");
    expect(words(host)).toContain(`Expires at ${clock(5 * 60_000)}`);
    await click(button("Done"));
    expect(host!.querySelector(".pair-code")).toBeNull();
    expect(words(host)).not.toContain("7K2Q");
    // Nothing reads it back: the code is never in any GET.
    expect(calls.filter((c) => c.method === "GET").every((c) => c.path === "/api/native/devices")).toBe(true);
  });

  it("a pending phone shows its label and check number, with Confirm, which sends that number; then it is active", async () => {
    worker({ devices: [pending()] });
    await mount();
    const row = rowOf("Kitchen iPhone");
    expect(words(row)).toContain("Check number 4821");
    expect(words(row)).toContain("Waiting for your confirmation");
    await click(button("Confirm", row));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"a".repeat(64)}/confirm`, body: { check: "4821" } }]);
    const now = rowOf("Kitchen iPhone");
    expect(words(now)).not.toContain("4821");
    expect(button("Revoke", now)).toBeTruthy();
  });

  it("an active phone shows its label, last use and expiry, with Revoke; a phone near its expiry says to pair again", async () => {
    worker({ devices: [active(), active({ id: "c".repeat(64), label: "Old phone", lastUsedAt: null, expiresAt: iso(5 * DAY), expiresSoon: true })] });
    await mount();
    const phone = rowOf("Running phone");
    expect(words(phone)).toContain("Last used 2h ago");
    expect(words(phone)).toContain("Expires in 27 days");
    expect(words(phone)).not.toContain("pair it again");
    expect(words(rowOf("Old phone"))).toContain("Never used");
    expect(words(rowOf("Old phone"))).toContain("Expires in 5 days");
    expect(words(rowOf("Old phone"))).toContain("Pair it again before then");
    await click(button("Revoke", phone));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/native/devices/${"b".repeat(64)}/revoke`]);
    expect(rowOf("Running phone")).toBeUndefined();
    expect(rowOf("Old phone")).toBeTruthy();
  });

  it("the expiry counts down in days: within a day it says today, and one day is a day", async () => {
    worker({ devices: [active({ label: "Today phone", expiresAt: iso(3_600_000), expiresSoon: true }), active({ id: "d".repeat(64), label: "Tomorrow phone", expiresAt: iso(DAY), expiresSoon: true })] });
    await mount();
    expect(words(rowOf("Today phone"))).toContain("Expires today");
    expect(words(rowOf("Tomorrow phone"))).toContain("Expires in 1 day");
  });

  it("too many codes: says when to try again, and shows no code", async () => {
    worker({ pairRefusal: { error: "too_many_codes", retryAfter: 600 } });
    await mount();
    await click(button("Pair a phone"));
    expect(words(host)).toContain("Too many codes just now. Try again in 10 minutes.");
    expect(host!.querySelector(".pair-code")).toBeNull();
  });

  it("a confirm the server answered by turning the phone away says so, and to pair it again", async () => {
    worker({ devices: [pending()], confirmRefusal: { error: "check_mismatch", revoked: true } });
    await mount();
    await click(button("Confirm", rowOf("Kitchen iPhone")));
    expect(words(host)).toContain("The numbers didn't match too many times, so that phone was turned away. Pair it again.");
    expect(rowOf("Kitchen iPhone")).toBeUndefined();
  });

  it("Revoke all stops every phone at once", async () => {
    worker({ devices: [active(), pending()] });
    await mount();
    await click(button("Revoke all"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/native/devices/revoke-all"]);
    expect(host!.querySelectorAll(".setting-row")).toHaveLength(0);
    expect(words(host)).toContain("No phone is paired");
  });

  it("with the switch off, paired phones still show and can be revoked; Pair is not offered", async () => {
    worker({ enabled: false, devices: [active()] });
    await mount();
    expect(words(host)).toContain("Device sign-in is off");
    expect(button("Pair a phone")).toBeUndefined();
    expect(button("Revoke", rowOf("Running phone"))).toBeTruthy();
    expect(button("Revoke all")).toBeTruthy();
  });

  it("sits in Settings → Data & account, before Account", async () => {
    worker({ devices: [active()] });
    await mount(SettingsScreen);
    for (let i = 0; i < 100 && !host!.querySelector(".settings-group"); i++) await flush();
    const group = [...host!.querySelectorAll<HTMLElement>(".settings-group")].find((g) => words(g.querySelector("h2")) === "Data & account")!;
    const titles = [...group.querySelectorAll<HTMLElement>(".card")].map((c) => words(c.querySelector("h3")));
    expect(titles.slice(-2)).toEqual(["Devices", "Account"]);
  });
});
