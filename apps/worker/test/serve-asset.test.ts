/**
 * A build file the assets don't hold answers 404, never the app's page (2026-10-08): while a deploy rolled out, a new
 * service worker asked a location still on the old build for the new script, got the page back with a 200, and
 * cached it under the script's address — the installed app stayed blank until the next deploy.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppContext } from "../src/auth/middleware.js";
import type { Env } from "../src/env.js";
import { serveAsset } from "../src/index.js";

const PAGE = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

/** The assets binding as wrangler's single-page-application mode answers: a file it holds, else the page. */
function envWith(files: Record<string, { body: string; type: string }>): Env {
  return {
    ASSETS: {
      fetch: async (req: Request) => {
        const file = files[new URL(req.url).pathname];
        return file
          ? new Response(file.body, { headers: { "content-type": file.type } })
          : new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  } as unknown as Env;
}

function makeApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.all("*", serveAsset);
  return app;
}

const env = envWith({ "/assets/index-abc.js": { body: "export {}", type: "text/javascript" } });

describe("serveAsset", () => {
  it("serves a build file the assets hold", async () => {
    const res = await makeApp().request("/assets/index-abc.js", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe("export {}");
  });

  it("answers 404 for a build file the assets don't hold, not the page", async () => {
    const res = await makeApp().request("/assets/index-new.js", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("<html");
  });

  it("still answers an app route with the page", async () => {
    const res = await makeApp().request("/settings", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
  });
});
