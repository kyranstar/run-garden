/**
 * The hourly job places adaptive programs' slots BEFORE the heavy per-user steps (audit 2a-model M8): an
 * invocation that dies part-way through the garden, coach and COROS-write steps on a CPU or subrequest ceiling
 * must not also lose the week's placement. And placement failing never stops the steps after it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const log = vi.hoisted(() => ({ calls: [] as string[], placementFails: false }));

vi.mock("../src/services/program-slots.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/program-slots.js")>();
  return {
    ...real,
    placeSlotsForAllPrograms: vi.fn(async (...args: Parameters<typeof real.placeSlotsForAllPrograms>) => {
      log.calls.push("placement");
      if (log.placementFails) throw new Error("placement exploded");
      return real.placeSlotsForAllPrograms(...args);
    }),
  };
});
vi.mock("../src/services/garden-sync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/garden-sync.js")>();
  return {
    ...real,
    advanceGarden: vi.fn(async (...args: Parameters<typeof real.advanceGarden>) => {
      log.calls.push("garden");
      return real.advanceGarden(...args);
    }),
  };
});

import { hourly } from "../src/index.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

let db: Db;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  await makeTestUser(db);
  log.calls = [];
  log.placementFails = false;
});

describe("the hourly job's order", () => {
  it("places programs before any user's garden step", async () => {
    await hourly(db, makeEnv());
    expect(log.calls).toEqual(["placement", "garden"]);
  });

  it("a placement failure does not stop the per-user steps", async () => {
    log.placementFails = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await hourly(db, makeEnv());
    expect(log.calls).toEqual(["placement", "garden"]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("slot placement failed"));
    errors.mockRestore();
  });
});
