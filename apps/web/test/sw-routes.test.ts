/**
 * The service worker's runtime routes (sw-routes.ts, stringified into sw.js by vite-plugin-pwa). Ruling 2b-R6 / audit
 * 2b-A M-2: a `/api/auth/me` answer of 401 purges the account's cached answers in the worker itself — so a 401 that
 * arrives after the route's 3 s timeout (the cached answer already served to the page) still leaves nothing for the
 * next offline launch. The plugin runs as the worker runs it: its source, evaluated with nothing around it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeCaching } from "../sw-routes.js";

type FetchDidSucceed = (param: { response: Response }) => Promise<Response>;

/** The function as sw.js holds it: its own source, closure-free. */
function asTheWorkerRunsIt(fn: unknown): FetchDidSucceed {
  return new Function(`return (${String(fn)});`)() as FetchDidSucceed;
}

const meRoute = () => runtimeCaching.find((r) => r.options?.cacheName === "rg-me")!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the rg-me route", () => {
  it("is NetworkFirst with a 3 s timeout, one entry, a week", () => {
    expect(meRoute()).toMatchObject({
      handler: "NetworkFirst",
      options: { cacheName: "rg-me", networkTimeoutSeconds: 3, expiration: { maxEntries: 1, maxAgeSeconds: 604800 } },
    });
  });

  it("a 401 from me deletes rg-me and rg-read-cache, and passes the answer through", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", { delete: vi.fn(async (name: string) => deleted.push(name) > 0) });
    const plugin = meRoute().options!.plugins!.find((p) => "fetchDidSucceed" in p)!;
    const fetchDidSucceed = asTheWorkerRunsIt(plugin.fetchDidSucceed);

    const signedOut = new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    expect(await fetchDidSucceed({ response: signedOut })).toBe(signedOut);
    expect(deleted.sort()).toEqual(["rg-me", "rg-read-cache"]);

    deleted.length = 0;
    const ok = new Response("{}", { status: 200 });
    expect(await fetchDidSucceed({ response: ok })).toBe(ok);
    const down = new Response("{}", { status: 503 });
    expect(await fetchDidSucceed({ response: down })).toBe(down);
    expect(deleted).toEqual([]);
  });

  it("every other route keeps what it had: the shell, and the read cache's API paths", () => {
    expect(runtimeCaching.map((r) => r.options?.cacheName)).toEqual(["rg-shell", "rg-me", "rg-read-cache"]);
  });
});
