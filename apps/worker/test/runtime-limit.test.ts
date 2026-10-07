/**
 * `isRuntimeLimit` tells a Cloudflare ceiling on this invocation from a remote
 * service failing. A ceiling is retried without spending the job's attempts and
 * never shown to the athlete as a COROS problem; anything else is not a ceiling.
 */
import { describe, expect, it } from "vitest";
import { isRuntimeLimit } from "../src/services/runtime-limit.js";

describe("isRuntimeLimit", () => {
  it.each([
    "Too many subrequests.",
    "Worker exceeded CPU time limit.",
    "Exceeded CPU Limit",
    "The script will never generate a response.",
  ])("matches the Workers ceiling %j", (message) => {
    expect(isRuntimeLimit(new Error(message))).toBe(true);
  });

  it.each([
    "Too many API requests by single worker invocation.",
    "D1_ERROR: Too many API requests by single worker invocation.",
    "Error: Too many API requests by a single Worker invocation",
  ])("matches D1's per-invocation query cap %j", (message) => {
    expect(isRuntimeLimit(new Error(message))).toBe(true);
    expect(isRuntimeLimit(message)).toBe(true);
  });

  it.each([
    // A bug in our own SQL, not a ceiling: retrying it can never succeed.
    "D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR",
    // A remote rate limit is the remote service's answer, not this invocation's budget.
    "COROS 429: Too many API requests",
    "fetch failed",
    "COROS returned result=1019",
  ])("does not match %j", (message) => {
    expect(isRuntimeLimit(new Error(message))).toBe(false);
  });

  it("reads non-Error values without throwing", () => {
    expect(isRuntimeLimit(null)).toBe(false);
    expect(isRuntimeLimit(undefined)).toBe(false);
    expect(isRuntimeLimit({ code: 1 })).toBe(false);
  });
});
