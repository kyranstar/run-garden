/**
 * Security audit S3 — the CSRF origin guard on /api/*.
 *
 * The old check was direction-inverted (`APP_URL.startsWith(origin)` let any
 * prefix such as "https://run" through) and an `x-device-id` header bypassed
 * it entirely — dead code from the deleted desktop bridge. Now: a PRESENT
 * Origin must equal APP_URL's origin exactly on mutating methods; a missing
 * Origin still passes (same-origin GETs and non-browser clients omit it).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/auth/middleware.js";
import type { Env } from "../src/env.js";
import { originGuard } from "../src/index.js";

const APP_URL = "https://run-garden.example.com";

function makeApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use("/api/*", originGuard);
  app.post("/api/echo", (c) => c.json({ ok: true }));
  app.get("/api/echo", (c) => c.json({ ok: true }));
  return app;
}

const env = { APP_URL } as Env;

describe("originGuard", () => {
  it("rejects a mismatched Origin on POST", async () => {
    const res = await makeApp().request(
      "/api/echo",
      { method: "POST", headers: { Origin: "https://evil.example" } },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
  });

  it("rejects a prefix Origin the old inverted check accepted", async () => {
    // "https://run" is a prefix of APP_URL, so `APP_URL.startsWith(origin)`
    // used to wave it through.
    const res = await makeApp().request(
      "/api/echo",
      { method: "POST", headers: { Origin: "https://run" } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("no longer honors the x-device-id bypass", async () => {
    const res = await makeApp().request(
      "/api/echo",
      {
        method: "POST",
        headers: { Origin: "https://evil.example", "x-device-id": "device-1" },
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("allows a missing Origin on POST (non-browser clients omit it)", async () => {
    const res = await makeApp().request("/api/echo", { method: "POST" }, env);
    expect(res.status).toBe(200);
  });

  it("allows the exact app origin on POST", async () => {
    const res = await makeApp().request(
      "/api/echo",
      { method: "POST", headers: { Origin: APP_URL } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("compares origins, not raw APP_URL strings", async () => {
    // A trailing slash or path on APP_URL must not break the match.
    const res = await makeApp().request(
      "/api/echo",
      { method: "POST", headers: { Origin: APP_URL } },
      { APP_URL: `${APP_URL}/` } as Env,
    );
    expect(res.status).toBe(200);
  });

  it("leaves GET untouched regardless of Origin", async () => {
    const res = await makeApp().request(
      "/api/echo",
      { headers: { Origin: "https://evil.example" } },
      env,
    );
    expect(res.status).toBe(200);
  });
});
