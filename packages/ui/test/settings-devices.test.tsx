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
  id: "a".repeat(64), label: "Kitchen iPhone", state: "pending", check: "4821", createdAt: iso(-60_000), confirmedAt: null, lastUsedAt: null, expiresAt: iso(9 * 60_000), expiresSoon: false,
  scope: "training-v2", nextScope: null, previousScope: null, ...over,
});
/** The ladder the worker grants and steps down along (device-scope.ts `NEXT_DEVICE_SCOPE`, `PREVIOUS_DEVICE_SCOPE`). */
const NEXT: Record<string, string | null> = { "training-slice-v1": "training-v2", "training-v2": "training-v3", "training-v3": "training-v4", "training-v4": "training-v5", "training-v5": null };
const PREVIOUS: Record<string, string | null> = { "training-slice-v1": null, "training-v2": null, "training-v3": "training-v2", "training-v4": "training-v3", "training-v5": "training-v4" };
const V4_CAN = "Can play, save, move and fit workouts, record your feedback, and read your plan and history.";
const V4_GRANT =
  "It will also be able to read your training plan, from three months back to two weeks ahead, and what you've done in the last year: titles, times, distances and the sets you logged. Never heart rate, pace, routes or health readings. You can stop it here any time.";
const V4_STOP = "It will no longer be able to read your coming weeks and your history. It stays paired.";
/** R1's words (DESIGN-3 §3.5): what a v5 phone can do, its grant's line — saying plainly that it shares nothing of the day — and its step-down's. */
const V5_CAN = "Can play, save, move and fit workouts, record your feedback, read your plan and history, use your library, and work with your coach.";
const V5_GRANT =
  "It will also be able to browse your saved workouts and moves and put one on your plan; ask your coach to design or change workouts, answer its questions, and approve or decline what it suggests; take back a workout it put on your plan or a coach change it approved, until that day ends (8 days at most); and see, edit, add to and delete what your coach remembers. It can read your coach's questions to you, which the coach writes itself and so can mention your training and how it's going, and what your coach remembers. Everything else it sees of your coach is plain facts like days, times and minutes, never your health readings or conditions. Its coach use counts toward this account's weekly AI limit. This doesn't share anything about your day with your coach; that's a separate choice on the phone. You can stop it here any time.";
const V5_STOP = "It will no longer use your library or coach. What it already added stays on your plan. It stays paired.";
/** What every phone reads whatever its scope (`/api/native/me`'s time zone, R1.1): one sentence, on every row (R1.2). */
const ZONE = "It also reads this account's time zone, so its days and times match your plan's.";
/** Renew's one line (LifeOS Q-172), and the hint beside a phone inside the warning while Renew is offered. */
const RENEW_LINE = "It will keep working for 30 more days from now. Nothing else changes.";
const RENEW_HINT = "Renew it to keep it working.";
/** An active phone at `scope` (v2 unless said), with the steps the worker offers it. */
const active = (over: Partial<NativeDeviceDto> = {}): NativeDeviceDto => {
  const scope = over.scope ?? "training-v2";
  return {
    id: "b".repeat(64), label: "Running phone", state: "active", check: null, createdAt: iso(-3 * DAY), confirmedAt: iso(-3 * DAY), lastUsedAt: iso(-2 * 3_600_000), expiresAt: iso(27 * DAY), expiresSoon: false,
    scope, nextScope: NEXT[scope] ?? null, previousScope: PREVIOUS[scope] ?? null, ...over,
  };
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Array<{ method: string; path: string; body: unknown }>;

/** A worker in memory: the devices list and what Pair, Confirm and Revoke do to it. */
function worker(
  init: {
    enabled?: boolean; devices?: NativeDeviceDto[]; listStatus?: number; listBody?: unknown; pairRefusal?: unknown; confirmRefusal?: unknown; timezone?: string;
    grantRefusal?: { status: number; body: unknown }; reduceRefusal?: { status: number; body: unknown }; pairScope?: string;
    renewRefusal?: { status: number; body: unknown };
  } = {},
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
      if (path === "/api/native/pairings") {
        return init.pairRefusal ? json(init.pairRefusal, 429) : json({ code: "7K2QXM9D", expiresAt: iso(5 * 60_000), ...(init.pairScope ? { scope: init.pairScope } : {}) });
      }
      const grant = path.match(/^\/api\/native\/devices\/(\w+)\/grant$/);
      if (grant && init.grantRefusal) return json(init.grantRefusal.body, init.grantRefusal.status);
      if (grant) {
        const to = (JSON.parse(String(req!.body)) as { scope: string }).scope;
        state.devices = state.devices.map((d) => (d.id === grant[1] ? { ...d, scope: to, nextScope: NEXT[to] ?? null, previousScope: PREVIOUS[to] ?? null } : d));
        return json({ ok: true, scope: to, granted: true });
      }
      const reduce = path.match(/^\/api\/native\/devices\/(\w+)\/reduce$/);
      if (reduce && init.reduceRefusal) return json(init.reduceRefusal.body, init.reduceRefusal.status);
      if (reduce) {
        const to = (JSON.parse(String(req!.body)) as { scope: string }).scope;
        state.devices = state.devices.map((d) => (d.id === reduce[1] ? { ...d, scope: to, nextScope: NEXT[to] ?? null, previousScope: PREVIOUS[to] ?? null } : d));
        return json({ ok: true, scope: to, reduced: true });
      }
      const renew = path.match(/^\/api\/native\/devices\/(\w+)\/renew$/);
      if (renew && init.renewRefusal) return json(init.renewRefusal.body, init.renewRefusal.status);
      if (renew) {
        // 30 days from the server's acceptance (the worker's renewDevice), every other field kept.
        state.devices = state.devices.map((d) => (d.id === renew[1] ? { ...d, expiresAt: iso(30 * DAY), expiresSoon: false } : d));
        return json({ ok: true, expiresAt: iso(30 * DAY), renewed: true });
      }
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
      if (path === "/api/settings") return json({ prefs: { ...DEFAULT_USER_PREFERENCES, ...(init.timezone ? { timezone: init.timezone } : {}) }, llm: null });
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

async function mount(el: typeof DevicesSection | typeof SettingsScreen = DevicesSection, props: { timezone?: string } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(el as typeof DevicesSection, props))));
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

  it("an active phone shows its label, last use and expiry, with Revoke; a phone near its expiry says to renew it", async () => {
    worker({ devices: [active(), active({ id: "c".repeat(64), label: "Old phone", lastUsedAt: null, expiresAt: iso(5 * DAY), expiresSoon: true })] });
    await mount();
    const phone = rowOf("Running phone");
    expect(words(phone)).toContain("Last used 2h ago");
    expect(words(phone)).toContain("Expires in 27 days");
    expect(words(phone)).not.toContain("Renew");
    expect(words(rowOf("Old phone"))).toContain("Never used");
    expect(words(rowOf("Old phone"))).toContain("Expires in 5 days");
    expect(words(rowOf("Old phone"))).toContain(RENEW_HINT);
    expect(words(rowOf("Old phone"))).not.toContain("Pair it again");
    await click(button("Revoke", phone));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/native/devices/${"b".repeat(64)}/revoke`]);
    expect(rowOf("Running phone")).toBeUndefined();
    expect(rowOf("Old phone")).toBeTruthy();
  });

  it("the expiry counts calendar days on the owner's clock (review F8): today is today's date, tomorrow is 1 day, however few hours", async () => {
    // Now is 11:00 in Los Angeles on Nov 10 (19:00Z).
    worker({
      devices: [
        active({ label: "Tonight phone", expiresAt: "2026-11-11T07:30:00.000Z", expiresSoon: true }), // 23:30 Nov 10 in LA
        active({ id: "d".repeat(64), label: "Small hours phone", expiresAt: "2026-11-11T09:00:00.000Z", expiresSoon: true }), // 01:00 Nov 11 in LA
        active({ id: "e".repeat(64), label: "Next week phone", expiresAt: "2026-11-24T20:00:00.000Z", expiresSoon: false }), // Nov 24
      ],
    });
    await mount(DevicesSection, { timezone: "America/Los_Angeles" });
    expect(words(rowOf("Tonight phone"))).toContain("Expires today");
    expect(words(rowOf("Small hours phone"))).toContain("Expires in 1 day");
    expect(words(rowOf("Next week phone"))).toContain("Expires in 14 days");
    // In Tokyo it is already Nov 11 (04:00): the same tonight is Nov 11 16:30 there, so it expires today too, and the small
    // hours one (Nov 11 18:00 there) as well.
    act(() => root?.unmount());
    host?.remove();
    await mount(DevicesSection, { timezone: "Asia/Tokyo" });
    expect(words(rowOf("Small hours phone"))).toContain("Expires today");
  });

  it("the hint and Renew show at 7 calendar days or fewer, and not at 8", async () => {
    worker({
      devices: [
        active({ label: "Seven phone", expiresAt: "2026-11-18T03:00:00.000Z", expiresSoon: false }), // Nov 17 19:00 in LA: 7 days
        active({ id: "d".repeat(64), label: "Eight phone", expiresAt: "2026-11-18T09:00:00.000Z", expiresSoon: false }), // Nov 18 01:00 in LA: 8 days
      ],
    });
    await mount(DevicesSection, { timezone: "America/Los_Angeles" });
    expect(words(rowOf("Seven phone"))).toContain("Expires in 7 days");
    expect(words(rowOf("Seven phone"))).toContain(RENEW_HINT);
    expect(button("Renew", rowOf("Seven phone"))).toBeTruthy();
    expect(words(rowOf("Eight phone"))).toContain("Expires in 8 days");
    expect(words(rowOf("Eight phone"))).not.toContain(RENEW_HINT);
    expect(button("Renew", rowOf("Eight phone"))).toBeUndefined();
  });

  it("Renew (LifeOS Q-172): one line first, sending nothing; Renew sends it, and the row says 30 days, its hint and button gone", async () => {
    worker({ devices: [active({ label: "Old phone", expiresAt: iso(5 * DAY), expiresSoon: true }), active({ id: "c".repeat(64), label: "Running phone" })] });
    await mount();
    // Renew leads the row's buttons while the phone is inside the warning; its grant and Revoke are still there.
    expect([...rowOf("Old phone").querySelectorAll("button")].map(words)).toEqual(["Renew", "Allow fitting and feedback", "Revoke"]);
    // Two phones can be near expiry at once: each Renew button's accessible name says which (review NIT-4).
    expect(button("Renew", rowOf("Old phone")).getAttribute("aria-label")).toBe("Renew Old phone");
    await click(button("Renew", rowOf("Old phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("Old phone");
    expect(words(asking)).toContain(RENEW_LINE);
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Renew", "Not now"]);
    expect(button("Renew", asking).getAttribute("aria-label")).toBe("Renew Old phone");
    // The other phone isn't asked anything.
    expect(words(rowOf("Running phone"))).not.toContain(RENEW_LINE);
    await click(button("Renew", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/renew`, body: {} }]);
    const after = rowOf("Old phone");
    expect(words(after)).toContain("Expires in 30 days");
    expect(words(after)).not.toContain(RENEW_LINE);
    expect(words(after)).not.toContain(RENEW_HINT);
    // What it can do is unchanged: the same words, the same grant to offer, no Renew now it has its 30 days.
    expect(words(after)).toContain("Can play, save and move workouts.");
    expect([...after.querySelectorAll("button")].map(words)).toEqual(["Allow fitting and feedback", "Revoke"]);
  });

  it("Not now puts Renew's question away and sends nothing; a phone on its last day can still be renewed", async () => {
    worker({ devices: [active({ label: "Tonight phone", expiresAt: iso(3 * 3_600_000), expiresSoon: true })] });
    await mount(DevicesSection, { timezone: "America/Los_Angeles" });
    expect(words(rowOf("Tonight phone"))).toContain("Expires today");
    await click(button("Renew", rowOf("Tonight phone")));
    await click(button("Not now", rowOf("Tonight phone")));
    expect(words(rowOf("Tonight phone"))).not.toContain(RENEW_LINE);
    expect(button("Renew", rowOf("Tonight phone"))).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    await click(button("Renew", rowOf("Tonight phone")));
    await click(button("Renew", rowOf("Tonight phone")));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/native/devices/${"b".repeat(64)}/renew`]);
    expect(words(rowOf("Tonight phone"))).toContain("Expires in 30 days");
  });

  it("no Renew while pending, nor with device sign-in off (the worker answers 404 then): the old hint stays", async () => {
    worker({ devices: [pending()] });
    await mount();
    expect(button("Renew")).toBeUndefined();
    act(() => root?.unmount());
    host?.remove();
    worker({ enabled: false, devices: [active({ label: "Old phone", expiresAt: iso(5 * DAY), expiresSoon: true })] });
    await mount();
    expect([...rowOf("Old phone").querySelectorAll("button")].map(words)).toEqual(["Revoke"]);
    expect(words(rowOf("Old phone"))).toContain("Pair it again before then");
  });

  it("a refused Renew says why plainly, and the list is read again", async () => {
    const refusals: Array<[{ status: number; body: unknown }, string]> = [
      [{ status: 409, body: { error: "device_revoked" } }, "That phone was revoked or has expired: pair it again."],
      [{ status: 409, body: { error: "device_expired" } }, "That phone was revoked or has expired: pair it again."],
      [{ status: 404, body: { error: "not_found" } }, "Device sign-in is off, or that phone is no longer paired."],
      // A restore holds every write (the worker's 423): said as the app says it elsewhere (review NIT-3).
      [{ status: 423, body: { error: "restore_in_progress" } }, "A restore is running — try again when it's done."],
      [{ status: 500, body: { error: "x" } }, "Couldn't renew that phone. Try again."],
    ];
    for (const [refusal, says] of refusals) {
      act(() => root?.unmount());
      host?.remove();
      worker({ devices: [active({ label: "Old phone", expiresAt: iso(5 * DAY), expiresSoon: true })], renewRefusal: refusal });
      await mount();
      await click(button("Renew", rowOf("Old phone")));
      const gets = calls.filter((c) => c.method === "GET" && c.path === "/api/native/devices").length;
      await click(button("Renew", rowOf("Old phone")));
      expect(words(host)).toContain(says);
      expect(calls.filter((c) => c.method === "GET" && c.path === "/api/native/devices").length).toBeGreaterThan(gets);
    }
  });

  it("Settings counts on the account's own time zone, not the laptop's", async () => {
    // The account is in Tokyo, where it is already 04:00 on Nov 11: 01:00 Nov 11 in LA is 18:00 Nov 11 there — today.
    // And 16:00Z on Nov 11 is 01:00 Nov 12 there: 21 hours away, but tomorrow on the account's calendar.
    worker({
      devices: [
        active({ label: "Small hours phone", expiresAt: "2026-11-11T09:00:00.000Z" }),
        active({ id: "d".repeat(64), label: "After midnight phone", expiresAt: "2026-11-11T16:00:00.000Z" }),
      ],
      timezone: "Asia/Tokyo",
    });
    await mount(SettingsScreen);
    for (let i = 0; i < 100 && !rowOf("Small hours phone"); i++) await flush();
    expect(words(rowOf("Small hours phone"))).toContain("Expires today");
    expect(words(rowOf("After midnight phone"))).toContain("Expires in 1 day");
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

  it("each phone says what it can do, in plain words; a pending one what it will once confirmed", async () => {
    worker({
      devices: [
        active({ id: "c".repeat(64), label: "Old phone", scope: "training-slice-v1" }),
        active({ label: "Running phone" }),
        active({ id: "d".repeat(64), label: "New phone", scope: "training-v3" }),
        active({ id: "f".repeat(64), label: "Newest phone", scope: "training-v4" }),
        active({ id: "e".repeat(64), label: "Odd phone", scope: "training-v9" }),
        pending(),
      ],
    });
    await mount();
    expect(words(rowOf("Newest phone"))).toContain(V4_CAN);
    expect(words(rowOf("Old phone"))).toContain("Can play and save workouts.");
    expect(words(rowOf("Running phone"))).toContain("Can play, save and move workouts.");
    expect(words(rowOf("New phone"))).toContain("Can play, save, move and fit workouts, and record your feedback.");
    // A scope this laptop has no words for says nothing of it, rather than guess.
    expect(words(rowOf("Odd phone"))).not.toContain("Can ");
    expect(words(rowOf("Kitchen iPhone"))).toContain("Once confirmed, it can play, save and move workouts.");
  });

  it("every phone says it reads the account's time zone, in one sentence whatever its scope: pending, active and the code (R1.2)", async () => {
    // Every scope's `/api/native/me` names the account's time zone (R1.1), so a v4 phone paired before it reads the zone
    // too: one shared sentence on every row and with the code, never a copy per scope (the R1.1 review's minor 1).
    worker({
      devices: [
        active({ id: "c".repeat(64), label: "Old phone", scope: "training-slice-v1" }),
        active({ label: "Running phone" }),
        active({ id: "d".repeat(64), label: "New phone", scope: "training-v3" }),
        active({ id: "f".repeat(64), label: "Newest phone", scope: "training-v4" }),
        active({ id: "9".repeat(64), label: "Coach phone", scope: "training-v5" }),
        active({ id: "e".repeat(64), label: "Odd phone", scope: "training-v9" }),
        pending(),
        pending({ id: "8".repeat(64), label: "Spare iPhone", scope: "training-v5" }),
      ],
      pairScope: "training-v5",
    });
    await mount();
    const times = (text: string) => text.split(ZONE).length - 1;
    for (const label of ["Old phone", "Running phone", "New phone", "Newest phone", "Coach phone", "Odd phone", "Kitchen iPhone", "Spare iPhone"]) {
      expect(times(words(rowOf(label))), label).toBe(1);
    }
    await click(button("Pair a phone"));
    expect(times(words(host!.querySelector(".pair-code")!.parentElement))).toBe(1);
  });

  it("an active v2 phone has one button for the next version; it says what that adds, once, then grants it", async () => {
    worker({ devices: [active()] });
    await mount();
    const row = rowOf("Running phone");
    expect([...row.querySelectorAll("button")].map(words)).toEqual(["Allow fitting and feedback", "Revoke"]);
    await click(button("Allow fitting and feedback", row));
    // Nothing is sent until it's confirmed: the line says what the grant adds, and that it can be stopped here.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("Running phone");
    expect(words(asking)).toContain(
      "It will also be able to fit a workout to the day (its time, place and moves) and record Not for me and harder-move switches. You can stop it here any time.",
    );
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Allow", "Not now"]);
    await click(button("Allow", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/grant`, body: { scope: "training-v3" } }]);
    const after = rowOf("Running phone");
    expect(words(after)).toContain("Can play, save, move and fit workouts, and record your feedback.");
    expect(words(after)).not.toContain("It will also");
    // At v3: the next grant (v4) and its own step-down.
    expect([...after.querySelectorAll("button")].map(words)).toEqual(["Allow reading your plan and history", "Stop fitting and feedback", "Revoke"]);
  });

  it("a v3 phone's grant of v4 (DESIGN-2c §4): its button, the one line naming what it reads and never, then Allow grants it", async () => {
    worker({ devices: [active({ label: "New phone", scope: "training-v3" })] });
    await mount();
    await click(button("Allow reading your plan and history", rowOf("New phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("New phone");
    expect(words(asking)).toContain(V4_GRANT);
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Allow", "Not now"]);
    await click(button("Allow", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/grant`, body: { scope: "training-v4" } }]);
    const after = rowOf("New phone");
    expect(words(after)).toContain(V4_CAN);
    // At v4: the next grant (v5) and its own step-down.
    expect([...after.querySelectorAll("button")].map(words)).toEqual(["Allow your library and coach", "Stop reading your plan and history", "Revoke"]);
  });

  it("a v4 phone's step-down: one line saying what stops (what v4 does today: reading the coming weeks and history) and that it stays paired; Stop sends v3", async () => {
    worker({ devices: [active({ label: "Newest phone", scope: "training-v4" })] });
    await mount();
    expect([...rowOf("Newest phone").querySelectorAll("button")].map(words)).toEqual(["Allow your library and coach", "Stop reading your plan and history", "Revoke"]);
    await click(button("Stop reading your plan and history", rowOf("Newest phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("Newest phone");
    expect(words(asking)).toContain(V4_STOP);
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Stop", "Not now"]);
    await click(button("Stop", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/reduce`, body: { scope: "training-v3" } }]);
    expect(words(rowOf("Newest phone"))).toContain("Can play, save, move and fit workouts, and record your feedback.");
    expect([...rowOf("Newest phone").querySelectorAll("button")].map(words)).toEqual(["Allow reading your plan and history", "Stop fitting and feedback", "Revoke"]);
  });

  it("a v4 phone's grant of v5 (DESIGN-3 §3.5): its button, the one line saying what it allows and that it shares nothing of the day, then Allow grants it", async () => {
    worker({ devices: [active({ label: "Newer phone", scope: "training-v4" })] });
    await mount();
    await click(button("Allow your library and coach", rowOf("Newer phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("Newer phone");
    expect(words(asking)).toContain(V5_GRANT);
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Allow", "Not now"]);
    await click(button("Allow", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/grant`, body: { scope: "training-v5" } }]);
    const after = rowOf("Newer phone");
    expect(words(after)).toContain(V5_CAN);
    // At the top: no grant, and its own step-down.
    expect([...after.querySelectorAll("button")].map(words)).toEqual(["Stop library and coach", "Revoke"]);
  });

  it("a v5 phone's step-down: one line saying what stops, that what it added stays, and that it stays paired; Stop sends v4", async () => {
    worker({ devices: [active({ label: "Newest phone", scope: "training-v5" })] });
    await mount();
    expect(words(rowOf("Newest phone"))).toContain(V5_CAN);
    await click(button("Stop library and coach", rowOf("Newest phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("Newest phone");
    expect(words(asking)).toContain(V5_STOP);
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Stop", "Not now"]);
    await click(button("Stop", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/reduce`, body: { scope: "training-v4" } }]);
    expect(words(rowOf("Newest phone"))).toContain(V4_CAN);
    expect([...rowOf("Newest phone").querySelectorAll("button")].map(words)).toEqual(["Allow your library and coach", "Stop reading your plan and history", "Revoke"]);
  });

  it("a v3 phone's step-down: one button, one line saying what stops and that it stays paired, then Stop sends it", async () => {
    worker({ devices: [active({ label: "New phone", scope: "training-v3" })] });
    await mount();
    await click(button("Stop fitting and feedback", rowOf("New phone")));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const asking = rowOf("New phone");
    expect(words(asking)).toContain("It will no longer fit workouts to the day or record Not for me and harder-move switches. It stays paired.");
    expect([...asking.querySelectorAll("button")].map(words)).toEqual(["Stop", "Not now"]);
    await click(button("Stop", asking));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/native/devices/${"b".repeat(64)}/reduce`, body: { scope: "training-v2" } }]);
    expect(words(rowOf("New phone"))).toContain("Can play, save and move workouts.");
    expect(button("Allow fitting and feedback", rowOf("New phone"))).toBeTruthy();
  });

  it("Not now puts the question away and sends nothing; a v1 phone's button is for moving workouts, and a v2 phone has no step-down", async () => {
    worker({ devices: [active({ label: "Old phone", scope: "training-slice-v1" })] });
    await mount();
    expect([...rowOf("Old phone").querySelectorAll("button")].map(words)).toEqual(["Allow moving workouts", "Revoke"]);
    await click(button("Allow moving workouts", rowOf("Old phone")));
    expect(words(rowOf("Old phone"))).toContain("It will also be able to move, skip and put back workouts on your plan. To stop that, revoke it here.");
    await click(button("Not now", rowOf("Old phone")));
    expect(words(rowOf("Old phone"))).not.toContain("It will also");
    expect(button("Allow moving workouts", rowOf("Old phone"))).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    await click(button("Allow moving workouts", rowOf("Old phone")));
    await click(button("Allow", rowOf("Old phone")));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ scope: "training-v2" }]);
    // At v2 the next grant is offered, and no step-down (review r2-m2): stopping its plan edits is Revoke.
    expect([...rowOf("Old phone").querySelectorAll("button")].map(words)).toEqual(["Allow fitting and feedback", "Revoke"]);
  });

  it("the laptop never offers v2 → v1, even from a worker that lists it: it has no words for that step, so no button", async () => {
    worker({ devices: [active({ label: "Running phone", scope: "training-v2", previousScope: "training-slice-v1" })] });
    await mount();
    expect([...rowOf("Running phone").querySelectorAll("button")].map(words)).toEqual(["Allow fitting and feedback", "Revoke"]);
    expect(words(rowOf("Running phone"))).not.toContain("Stop");
  });

  it("no grant at the top, while pending, or with device sign-in off — but the v3 step-down still answers with sign-in off", async () => {
    worker({ devices: [active({ label: "New phone", scope: "training-v3", nextScope: null }), pending()] });
    await mount();
    expect([...rowOf("New phone").querySelectorAll("button")].map(words)).toEqual(["Stop fitting and feedback", "Revoke"]);
    expect([...rowOf("Kitchen iPhone").querySelectorAll("button")].map(words)).toEqual(["Confirm", "Revoke"]);
    act(() => root?.unmount());
    host?.remove();
    worker({ enabled: false, devices: [active(), active({ id: "d".repeat(64), label: "New phone", scope: "training-v3" })] });
    await mount();
    // Narrowing a phone never widens one: like Revoke, it is the owner's whatever the switch. A v2 phone has none to offer.
    expect([...rowOf("New phone").querySelectorAll("button")].map(words)).toEqual(["Stop fitting and feedback", "Revoke"]);
    expect([...rowOf("Running phone").querySelectorAll("button")].map(words)).toEqual(["Revoke"]);
  });

  it("a refused grant or step-down says why plainly, and the list is read again", async () => {
    worker({ devices: [active()], grantRefusal: { status: 409, body: { error: "not_next_scope", scope: "training-v3", next: null } } });
    await mount();
    await click(button("Allow fitting and feedback", rowOf("Running phone")));
    const gets = calls.filter((c) => c.method === "GET" && c.path === "/api/native/devices").length;
    await click(button("Allow", rowOf("Running phone")));
    expect(words(host)).toContain("That phone's access changed meanwhile. Here it is as it stands now.");
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/native/devices").length).toBeGreaterThan(gets);
    // [the refusal, what the grant says, what the step-down says] — a step-down answers whatever the switch, so its 404 is
    // the phone gone, never "sign-in is off".
    const refusals: Array<[{ status: number; body: unknown }, string, string]> = [
      [{ status: 409, body: { error: "device_revoked" } }, "That phone was revoked or has expired: pair it again.", "That phone was revoked or has expired: pair it again."],
      [{ status: 409, body: { error: "device_expired" } }, "That phone was revoked or has expired: pair it again.", "That phone was revoked or has expired: pair it again."],
      [{ status: 404, body: { error: "not_found" } }, "Device sign-in is off, or that phone is no longer paired.", "That phone is no longer paired."],
      [{ status: 409, body: { error: "not_previous_scope", scope: "training-v2", previous: null } }, "That phone's access changed meanwhile. Here it is as it stands now.", "That phone's access changed meanwhile. Here it is as it stands now."],
      [{ status: 500, body: { error: "x" } }, "Couldn't change what that phone can do. Try again.", "Couldn't change what that phone can do. Try again."],
    ];
    for (const [refusal, grantSays, stepSays] of refusals) {
      act(() => root?.unmount());
      host?.remove();
      worker({ devices: [active(), active({ id: "d".repeat(64), label: "New phone", scope: "training-v3" })], grantRefusal: refusal, reduceRefusal: refusal });
      await mount();
      await click(button("Allow fitting and feedback", rowOf("Running phone")));
      await click(button("Allow", rowOf("Running phone")));
      expect(words(host)).toContain(grantSays);
      await click(button("Stop fitting and feedback", rowOf("New phone")));
      await click(button("Stop", rowOf("New phone")));
      expect(words(host)).toContain(stepSays);
    }
  });

  it("the pairing code says what a phone paired now can do, from the worker's answer", async () => {
    // A new pairing is the newest scope (the worker's PAIRING_SCOPE, v5): the code says all of what that allows.
    worker({ pairScope: "training-v5" });
    await mount();
    await click(button("Pair a phone"));
    expect(words(host)).toContain("A phone paired now can play, save, move and fit workouts, record your feedback, read your plan and history, use your library, and work with your coach.");
    // v5 is its consent: the AI limit, what it never sees, and that it shares nothing of the day (review A MAJOR-1).
    expect(words(host)).toContain("Its coach use counts toward this account's weekly AI limit. It can read your coach's questions and what your coach remembers, which the coach writes and so can mention your training and how it's going; everything else is plain facts, never your health readings or conditions. It shares nothing about your day unless you turn that on on the phone.");
    // And, as with every scope, that it reads the account's time zone (R1.2: the one shared sentence).
    expect(words(host)).toContain(ZONE);
    act(() => root?.unmount());
    host?.remove();
    worker({ pairScope: "training-v4" });
    await mount();
    await click(button("Pair a phone"));
    expect(words(host)).toContain("A phone paired now can play, save, move and fit workouts, record your feedback, and read your plan and history.");
    act(() => root?.unmount());
    host?.remove();
    worker({ pairScope: "training-v3" });
    await mount();
    await click(button("Pair a phone"));
    expect(words(host)).toContain("A phone paired now can play, save, move and fit workouts, and record your feedback.");
    // And whatever a worker names, the line follows it (an older worker's v2 code says v2's).
    act(() => root?.unmount());
    host?.remove();
    worker({ pairScope: "training-v2" });
    await mount();
    await click(button("Pair a phone"));
    expect(words(host)).toContain("A phone paired now can play, save and move workouts.");
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
