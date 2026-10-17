/**
 * The music dock (2026-10-17) and the service worker: nothing under `/api/music` is ever kept — the token is a live
 * secret with an hour to live, the connection changes in another browser, and the login and its callback are
 * navigations that must reach the Worker. No runtime route matches any of them.
 */
import { describe, expect, it } from "vitest";
import { runtimeCaching } from "../sw-routes.js";

type Matcher = (o: { url: URL; request: { mode: string } }) => boolean;

describe("the service worker never keeps the music dock's answers", () => {
  it("no runtime route matches /api/music, its token, its login or its callback — as a read or a navigation", () => {
    const paths = ["/api/music", "/api/music/spotify/token", "/api/music/spotify/token?fresh=1", "/api/music/spotify/login", "/api/music/spotify/callback?code=c&state=s"];
    for (const path of paths) {
      for (const mode of ["cors", "same-origin", "navigate"]) {
        const url = new URL(`https://app.test${path}`);
        const hits = runtimeCaching.filter((r) => typeof r.urlPattern === "function" && (r.urlPattern as unknown as Matcher)({ url, request: { mode } }));
        expect(hits.map((r) => r.options?.cacheName), `${mode} ${path}`).toEqual([]);
      }
    }
  });
});
