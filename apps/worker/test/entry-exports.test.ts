/**
 * The Worker's entry module exports only functions (and its default handler). workerd takes every named export of the
 * entry module as an entrypoint and refuses to start on one that is not a function or handler — a number exported
 * from index.ts (CRON_GARDEN_MAX_DAYS, 2026-10-09) stopped `wrangler dev` and the CI fixture stack cold.
 */
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";

describe("the Worker entry module's exports", () => {
  it("every named export is a function, the default a handler object", () => {
    const { default: handler, ...named } = entry as Record<string, unknown>;
    const notFunctions = Object.entries(named).filter(([, v]) => typeof v !== "function").map(([k]) => k);
    expect(notFunctions).toEqual([]);
    expect(typeof handler).toBe("object");
    expect(typeof (handler as { fetch?: unknown }).fetch).toBe("function");
  });
});
