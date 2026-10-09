import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const staging = toml.includes("[env.staging]") ? toml.slice(toml.indexOf("[env.staging]")) : "";

describe("wrangler staging env", () => {
  it("exists and is separate from production", () => {
    expect(staging).not.toBe("");
    const name = /^name = "([^"]+)"/m.exec(staging)?.[1];
    expect(name).toBe("run-garden-staging");
    expect(name).not.toBe("run-garden-api");
  });
  it("is inert: no crons, staging on, fixtures and AI off", () => {
    expect(staging).toMatch(/\[env\.staging\.triggers\]\s*\ncrons = \[\]/);
    expect(staging).toContain('STAGING = "1"');
    expect(staging).toContain('FIXTURE_MODE = "0"');
    expect(staging).toContain('AI_DEFAULT_ENABLED = "0"');
  });
  it("turns the watch switch on in production only, as the owner approved on 2026-10-09 (Phase 3 §6, plan Task 12)", () => {
    const production = toml.slice(0, toml.indexOf("[env.staging]"));
    expect(production.match(/^\s*WATCH_PUSH_ENABLED\s*=.*$/gm)).toEqual(['WATCH_PUSH_ENABLED = "1"']);
    expect(staging).not.toMatch(/^\s*WATCH_PUSH_ENABLED\s*=/m);
  });
  it("has its own database", () => {
    expect(staging).toContain('database_name = "run-garden-db-staging"');
    expect(staging).not.toContain("00acb208-8450-4bc0-88da-6b1e75f76280");
  });
});
