/**
 * The deleted desktop bridge's poll answers 410 Gone, empty (2026-10-26): `/api/devices/bridge/jobs/claim` was removed in
 * 844aa0ec, and the owner's Mac kept polling it for weeks; the request fell through to the assets binding and died with
 * a stream error.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/auth/middleware.js";
import type { Env } from "../src/env.js";
import { bridgeGone, serveAsset } from "../src/index.js";

const env = {
  ASSETS: { fetch: async () => new Response("asset body", { headers: { "content-type": "text/plain" } }) },
} as unknown as Env;

function makeApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.all("/api/devices/*", bridgeGone);
  app.all("*", serveAsset);
  return app;
}

describe("bridgeGone", () => {
  it("POST /api/devices/bridge/jobs/claim is 410 with an empty body; GET /assets/x still reaches the assets", async () => {
    const gone = await makeApp().request("/api/devices/bridge/jobs/claim", { method: "POST" }, env);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toBe("");
    const asset = await makeApp().request("/assets/x", {}, env);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("asset body");
  });
});
