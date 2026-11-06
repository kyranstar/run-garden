// @vitest-environment jsdom
/**
 * The options page tests the token on Save (audit 2026-11-06, I1): it asks the app's cheapest token route and says
 * plainly whether the app took it — a token the app refuses is not saved. `chrome.storage.local` and `fetch` are stubs;
 * the app's address is the build's own (the only one a build may reach). Synthetic token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_APP_ORIGIN } from "../src/settings.js";
import { saveOptions } from "../src/options-model.js";
import { memoryStore } from "./fixtures.js";

const TOKEN = "tok-synthetic-0123456789";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("saveOptions", () => {
  it("a token the app takes is saved, and said so", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const out = await saveOptions({ appUrl: BUILT_APP_ORIGIN, token: TOKEN, maxPages: null }, {
      store,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
        return json(200, { links: [] });
      }) as typeof fetch,
    });
    expect(out).toEqual({ saved: true, line: "Saved — the app took the token." });
    expect(calls).toEqual([`${BUILT_APP_ORIGIN}/api/saves/links Bearer ${TOKEN}`]);
    expect(store.dump().settings).toEqual({ appUrl: BUILT_APP_ORIGIN, token: TOKEN });
  });

  it("a token the app refuses is not saved: the one saved before stays", async () => {
    const store = memoryStore();
    await store.set("settings", { appUrl: BUILT_APP_ORIGIN, token: "tok-older-one" });
    const out = await saveOptions({ appUrl: BUILT_APP_ORIGIN, token: TOKEN, maxPages: null }, { store, fetchImpl: (async () => json(401, { error: "unauthenticated" })) as typeof fetch });
    expect(out).toEqual({ saved: false, line: "The app refused this token — nothing was saved. Paste it again." });
    expect(store.dump().settings).toEqual({ appUrl: BUILT_APP_ORIGIN, token: "tok-older-one" });
  });

  it("an app that can't be reached: saved, and said that it couldn't be tested", async () => {
    const store = memoryStore();
    const out = await saveOptions({ appUrl: BUILT_APP_ORIGIN, token: TOKEN, maxPages: null }, { store, fetchImpl: (async () => { throw new TypeError("offline"); }) as typeof fetch });
    expect(out).toEqual({ saved: true, line: "Saved — the app couldn't be reached to test it." });
  });

  it("a blank token field tests the saved token; a form that doesn't validate asks nothing", async () => {
    const store = memoryStore();
    await store.set("settings", { appUrl: BUILT_APP_ORIGIN, token: TOKEN });
    let auth = "";
    await saveOptions({ appUrl: BUILT_APP_ORIGIN, token: "", maxPages: 5 }, {
      store,
      fetchImpl: (async (_: RequestInfo | URL, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return json(200, { links: [] });
      }) as typeof fetch,
    });
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(store.dump().settings).toEqual({ appUrl: BUILT_APP_ORIGIN, token: TOKEN, maxPages: 5 });
    const fetchImpl = vi.fn();
    expect(await saveOptions({ appUrl: BUILT_APP_ORIGIN, token: "", maxPages: null }, { store: memoryStore(), fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ saved: false, line: "Paste the import token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the options page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("Save says what the app said of the token, never a bare 'Saved'", async () => {
    const kept: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: kept[key] }),
          set: async (o: Record<string, unknown>) => void Object.assign(kept, o),
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "unauthenticated" })));
    document.body.innerHTML = `<form id="form"><input id="appUrl"><input id="token"><input id="maxPages"><button type="submit">Save</button><output id="status"></output></form>`;
    vi.resetModules();
    await import("../src/options.js");
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    (document.getElementById("token") as HTMLInputElement).value = TOKEN;
    (document.getElementById("form") as HTMLFormElement).requestSubmit();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("status")!.textContent).toBe("The app refused this token — nothing was saved. Paste it again.");
    expect(kept.settings).toBeUndefined();
  });
});
