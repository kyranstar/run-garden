// @vitest-environment jsdom
/**
 * Ruling 2b-R6 at the two places the athlete ends an account's presence on this device (audit 2b-A I-1, M-9):
 * Settings → Data → "Delete all data" and Settings → "Sign out" both forget the offline identity — the service
 * worker's `rg-me` and `rg-read-cache`, the stored builds and the live sessions — so an offline launch afterwards
 * never opens the account. The outbox's unsynced saves stay (tagged with their account).
 *
 * Mounted in jsdom against a stubbed worker, a Cache Storage double and a fake IndexedDB (the app's own `offlineDb`).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import { offlineDb } from "../../src/offline/idb.js";
import { DataSection, SettingsScreen } from "../../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const browser = new IDBFactory();
let cacheNames: Set<string>;
let calls: string[];
let root: Root | null = null;

beforeAll(() => {
  // The app's shared connection opens this fake once, for the whole file.
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = browser;
});
afterAll(async () => {
  (await offlineDb()).close();
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

beforeEach(async () => {
  document.body.innerHTML = "";
  calls = [];
  cacheNames = new Set(["rg-me", "rg-read-cache", "rg-shell"]);
  vi.stubGlobal("caches", {
    match: vi.fn(async () => undefined),
    delete: vi.fn(async (name: string) => cacheNames.delete(name)),
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/\?.*$/, "");
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/auth/me") return json({ userId: "u1", email: "runner@example.com", connections: [], fixtureMode: false, restore: null });
      if (path === "/api/settings") {
        return json({ prefs: DEFAULT_USER_PREFERENCES, llm: { spentDollars: 0, warnDollars: 1, cutoffDollars: 2, maxDollars: 3, warn: false, cutoff: false } });
      }
      if (path === "/api/settings/delete-all" || path === "/api/auth/logout") return json({ ok: true });
      return json({ error: "not_found" }, 404);
    }),
  );
  // The account's offline traces on this device.
  const db = await offlineDb();
  await db.put("builds", "w1", { workoutId: "w1" });
  await db.put("live", "w1", { workoutId: "w1", performedId: "p1" });
  await db.put("outbox", "p1:h", { key: "p1:h", userId: "u1" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

function mount(screen: typeof DataSection | typeof SettingsScreen): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(screen)));
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}

async function click(label: string): Promise<void> {
  await until(() => [...document.querySelectorAll("button")].some((b) => b.textContent === label), `a "${label}" button`);
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === label)!;
  await act(async () => {
    b.click();
  });
}

async function forgotten(): Promise<boolean> {
  const db = await offlineDb();
  return (
    !cacheNames.has("rg-me") &&
    !cacheNames.has("rg-read-cache") &&
    (await db.all("builds")).length === 0 &&
    (await db.all("live")).length === 0
  );
}

describe("the offline identity is forgotten where the athlete ends it (ruling 2b-R6)", () => {
  it("Delete all data: both caches, the stored builds and the live sessions are gone; the shell and the outbox stay (I-1)", async () => {
    mount(DataSection);
    await click("Delete all data");
    await click("Really delete everything — cannot be undone");
    await until(() => calls.includes("POST /api/settings/delete-all"), "the delete-all request");
    await until(forgotten, "the offline identity forgotten");
    expect([...cacheNames]).toEqual(["rg-shell"]);
    expect(await (await offlineDb()).all("outbox")).toHaveLength(1);
  });

  it("Sign out: the same (M-9)", async () => {
    mount(SettingsScreen);
    await click("Sign out");
    await until(() => calls.includes("POST /api/auth/logout"), "the sign-out request");
    await until(forgotten, "the offline identity forgotten");
    expect([...cacheNames]).toEqual(["rg-shell"]);
    expect(await (await offlineDb()).all("outbox")).toHaveLength(1);
  });
});
