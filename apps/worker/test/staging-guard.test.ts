import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installStagingGuard,
  stagingAllows,
  StagingOutboundBlocked,
  uninstallStagingGuardForTests,
} from "../src/services/staging.js";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  uninstallStagingGuardForTests();
  globalThis.fetch = realFetch;
});

describe("staging guard", () => {
  it("blocks COROS, Calendar, the MCP and the LLM gateway", async () => {
    const spy = vi.fn(async () => new Response("x"));
    globalThis.fetch = spy as unknown as typeof fetch;
    installStagingGuard();
    for (const u of [
      "https://teamapi.coros.com/account/login",
      "https://www.googleapis.com/calendar/v3/x",
      "https://mcp.coros.com/mcp",
      "https://ai-gateway.vercel.sh/v1/chat/completions",
    ]) {
      await expect(fetch(u)).rejects.toBeInstanceOf(StagingOutboundBlocked);
      await expect(fetch(new URL(u))).rejects.toBeInstanceOf(StagingOutboundBlocked);
      await expect(fetch(new Request(u))).rejects.toBeInstanceOf(StagingOutboundBlocked);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes the Google token exchange through", async () => {
    const spy = vi.fn(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;
    installStagingGuard();
    installStagingGuard(); // idempotent
    await fetch("https://oauth2.googleapis.com/token", { method: "POST" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("allows exactly the token origin", () => {
    expect(stagingAllows("https://oauth2.googleapis.com/token")).toBe(true);
    expect(stagingAllows("https://accounts.google.com/x")).toBe(false);
    expect(stagingAllows("https://www.googleapis.com/calendar/v3")).toBe(false);
    expect(stagingAllows("/api/x")).toBe(true);
  });

  it("scheduled does nothing in staging", async () => {
    const waitUntil = vi.fn();
    await worker.scheduled(
      { cron: "*/30 * * * *" } as ScheduledController,
      { STAGING: "1", DB: {} } as unknown as Env,
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
