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
  it("production is never fixture mode, and never names a stand-in model (Task 9: the scripted designer is a fixture-stack seam)", () => {
    const production = toml.slice(0, toml.indexOf("[env.staging]"));
    expect(production.match(/^\s*FIXTURE_MODE\s*=.*$/gm)).toEqual(['FIXTURE_MODE = "0"']);
    expect(toml).not.toMatch(/^\s*FIXTURE_MODEL_URL\s*=/m);
    expect(toml).not.toMatch(/^\s*AI_DESIGN_MODEL\s*=\s*"scripted:/m);
  });
  it("has its own database", () => {
    expect(staging).toContain('database_name = "run-garden-db-staging"');
    expect(staging).not.toContain("00acb208-8450-4bc0-88da-6b1e75f76280");
  });
});

describe("the coach's step alarm: a Durable Object per run (the robustness pass, Phase 3 (d))", () => {
  const production = toml.slice(0, toml.indexOf("[env.staging]"));
  const binding = (prefix: string) =>
    new RegExp(`^\\[\\[${prefix}durable_objects\\.bindings\\]\\]\\s*\\nname = "COACH_RUN_STEPPER"\\s*\\nclass_name = "CoachRunStepper"\\s*$`, "m");

  it("binds the run stepper in production and in staging (a binding is never inherited by an environment)", () => {
    expect(production).toMatch(binding(""));
    expect(staging).toMatch(binding("env\\.staging\\."));
  });

  it("declares its class once, SQLite-backed — the only kind the Workers Free plan has — and staging inherits it", () => {
    expect(toml.match(/^\[\[migrations\]\]\s*\ntag = "v1"\s*\nnew_sqlite_classes = \["CoachRunStepper"\]\s*$/gm)).toHaveLength(1);
    expect(toml).not.toMatch(/^\s*new_classes\s*=/m);
    expect(staging).not.toMatch(/^\[\[env\.staging\.migrations\]\]/m);
  });

  it("turns the switch on in production — inert while the coach is off — and leaves staging on the direct path", () => {
    expect(production.match(/^\s*COACH_STEP_ALARM\s*=.*$/gm)).toEqual(['COACH_STEP_ALARM = "1"']);
    expect(staging).not.toMatch(/COACH_STEP_ALARM/);
  });

  it("the model's deadline is 10 minutes everywhere but the fixture stack, which shortens it to 30 s (fixture mode only)", () => {
    expect(toml).not.toMatch(/FIXTURE_MODEL_TIMEOUT_MS/);
    expect(readFileSync(new URL("../wrangler.dev.toml", import.meta.url), "utf8")).not.toMatch(/FIXTURE_MODEL_TIMEOUT_MS/);
    expect(readFileSync(new URL("../../web/e2e/fixture-stack.sh", import.meta.url), "utf8")).toContain("--var FIXTURE_MODEL_TIMEOUT_MS:30000");
  });

  it("local dev and the fixture stack run it on, with the same binding and class", () => {
    const dev = readFileSync(new URL("../wrangler.dev.toml", import.meta.url), "utf8");
    expect(dev).toMatch(/^COACH_STEP_ALARM = "1"$/m);
    expect(dev).toMatch(binding(""));
    expect(dev).toMatch(/^\[\[migrations\]\]\s*\ntag = "v1"\s*\nnew_sqlite_classes = \["CoachRunStepper"\]\s*$/m);
    expect(readFileSync(new URL("../../web/e2e/fixture-stack.sh", import.meta.url), "utf8")).toContain("--var COACH_STEP_ALARM:1");
  });
});
