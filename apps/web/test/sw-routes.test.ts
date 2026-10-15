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

  it("a 401 from me deletes rg-me, rg-read-cache and rg-doc-cache, and passes the answer through", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", { delete: vi.fn(async (name: string) => deleted.push(name) > 0) });
    const plugin = meRoute().options!.plugins!.find((p) => "fetchDidSucceed" in p)!;
    const fetchDidSucceed = asTheWorkerRunsIt(plugin.fetchDidSucceed);

    const signedOut = new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    expect(await fetchDidSucceed({ response: signedOut })).toBe(signedOut);
    expect(deleted.sort()).toEqual(["rg-doc-cache", "rg-me", "rg-read-cache"]);

    deleted.length = 0;
    const ok = new Response("{}", { status: 200 });
    expect(await fetchDidSucceed({ response: ok })).toBe(ok);
    const down = new Response("{}", { status: 503 });
    expect(await fetchDidSucceed({ response: down })).toBe(down);
    expect(deleted).toEqual([]);
  });

  it("every other route keeps what it had: the shell, and the read cache's API paths", () => {
    expect(runtimeCaching.map((r) => r.options?.cacheName)).toEqual(["rg-shell", "rg-me", "rg-read-cache", "rg-doc-cache"]);
  });
});

describe("the read cache (rg-read-cache)", () => {
  const readCache = () => runtimeCaching.find((r) => r.options?.cacheName === "rg-read-cache")!;
  /** The matcher as sw.js holds it: its own source, closure-free. */
  const matches = (path: string) => {
    const fn = new Function(`return (${String(readCache().urlPattern)});`)() as (p: { url: URL; request: { mode: string } }) => boolean;
    return fn({ url: new URL(`https://run.garden.test${path}`), request: { mode: "cors" } });
  };

  it("answers Today, Plan, the garden, insights and settings offline, as before", () => {
    for (const path of ["/api/plan/today", "/api/plan/workouts", "/api/garden", "/api/insights", "/api/settings"]) expect(matches(path), path).toBe(true);
    expect(readCache()).toMatchObject({ handler: "NetworkFirst", options: { networkTimeoutSeconds: 4 } });
  });

  it("answers the quick review's basis offline, so the Log your session Today offers opens offline (audit 3-B UI-9)", () => {
    expect(matches("/api/sessions/slot-p1-2026-10-08/watch-review")).toBe(true);
  });

  /**
   * The Studio's reads (Stage 2 spec §12): the templates, the planned workouts' list, the athlete's side of the library
   * (pins, ratings, history) and the places' gear — so the Studio opened offline, a cold start included, knows what it
   * knew online, and a quick start is built at once rather than after its reads fail through their retries. One entry
   * each: the lists only, never a move's or a workout's own read, and never a typed search of the workouts.
   */
  it("answers the Studio's list reads offline: templates, workouts, the library view, places, the profile", () => {
    for (const path of ["/api/templates", "/api/workouts", "/api/workouts?from=2026-10-12&to=2026-11-09", "/api/library", "/api/library?limit=200", "/api/places", "/api/profile"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  // A planned workout's document is kept in a cache of its own (below): one entry a workout here would push Today out.
  it("never keeps a planned workout's document: that is the document cache's", () => {
    expect(matches("/api/workouts/w1/doc")).toBe(false);
  });

  it("keeps no read of one move or one template, no typed search, no filtered library: each would be an entry of its own", () => {
    for (const path of [
      "/api/library/gobletSquat",
      "/api/library/gobletSquat/prefs",
      // The library's list only as the Studio reads it (all of it, or a page of it): a filter is a list of its own.
      "/api/library?part=main",
      "/api/library?limit=200&q=squat",
      "/api/workouts?q=squat",
      "/api/workouts/w1",
      "/api/workouts/w1/doc/x",
      "/api/templates/t1",
      "/api/templates/t1/use",
      "/api/places/p1",
      "/api/librarything",
      "/api/templatesx",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("caches answers only — GET — and its bounds are as they were: 40 entries, a day", () => {
    expect(readCache().method ?? "GET").toBe("GET");
    expect(readCache().options?.expiration).toEqual({ maxEntries: 40, maxAgeSeconds: 86400 });
  });

  it("keeps nothing else of a session: the sheet, the preview, the review basis, a save", () => {
    for (const path of [
      "/api/sessions/slot-p1-2026-10-08",
      "/api/sessions/slot-p1-2026-10-08/watch-preview",
      "/api/sessions/slot-p1-2026-10-08/review-basis",
      "/api/sessions/slot-p1-2026-10-08/watch-review/x",
      "/api/sessions/performed/abc",
      "/api/sessions/watch/drain",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });
});

// Spec §12 (fix round 1): a planned workout opens in the builder offline. A save after reconnecting carries the revision
// it was built on (`baseRev`), so a stale copy from here is refused (409), never a lost update. Whole-branch review: in
// a cache of its own, a few entries, so the documents of many workouts opened never push Today out of the read cache.
describe("the document cache (rg-doc-cache)", () => {
  const docCache = () => runtimeCaching.find((r) => r.options?.cacheName === "rg-doc-cache")!;
  const matches = (path: string) => {
    const fn = new Function(`return (${String(docCache().urlPattern)});`)() as (p: { url: URL; request: { mode: string } }) => boolean;
    return fn({ url: new URL(`https://run.garden.test${path}`), request: { mode: "cors" } });
  };

  it("answers a planned workout's document offline, one entry a workout, and nothing else", () => {
    expect(matches("/api/workouts/w1/doc")).toBe(true);
    expect(matches("/api/workouts/0b6f8a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/doc")).toBe(true);
    for (const path of ["/api/workouts", "/api/workouts/w1", "/api/workouts/w1/doc/x", "/api/plan/today", "/api/templates"]) expect(matches(path), path).toBe(false);
  });

  it("is NetworkFirst, GET only, and small: 12 entries, a day", () => {
    expect(docCache()).toMatchObject({ handler: "NetworkFirst", options: { networkTimeoutSeconds: 4 } });
    expect(docCache().method ?? "GET").toBe("GET");
    expect(docCache().options?.expiration).toEqual({ maxEntries: 12, maxAgeSeconds: 86400 });
  });
});
