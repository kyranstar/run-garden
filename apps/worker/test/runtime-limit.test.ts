/**
 * `isRuntimeLimit` tells a Cloudflare ceiling on this invocation from a remote
 * service failing. A ceiling is retried without spending the job's attempts and
 * never shown to the athlete as a COROS problem; anything else is not a ceiling.
 */
import { describe, expect, it } from "vitest";
import { isRuntimeLimit, isStorageError } from "../src/services/runtime-limit.js";

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

// Audit C3: "D1_ERROR: Network connection lost" was reported as a COROS outage.
describe("isStorageError", () => {
  it.each([
    "D1_ERROR: Network connection lost.",
    "D1 DB is overloaded. Requests queued for too long.",
    "D1 DB storage operation exceeded timeout which caused object to be reset.",
    "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.",
  ])("matches the database itself failing %j", (message) => {
    expect(isStorageError(new Error(message))).toBe(true);
  });

  it("reads the cause a wrapper keeps", () => {
    expect(isStorageError(new Error("Failed query: insert into activities", { cause: new Error("D1_ERROR: Network connection lost.") }))).toBe(true);
  });

  it.each([
    // A remote failing — a fetch's own "Network connection lost." carries no D1 mark.
    "Network connection lost.",
    "fetch failed",
    "network down",
    "COROS returned result=1019",
    "COROS 429: Too many API requests",
    // Our own statement wrong, which D1 answered: a bug that every retry meets, not the database failing.
    "D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR",
    "D1_ERROR: table planned_workout_stages has no column named note: SQLITE_ERROR",
    "D1_ERROR: UNIQUE constraint failed: planned_workouts.id: SQLITE_CONSTRAINT",
    "D1_EXEC_ERROR: Error in line 1: near \"x\": syntax error",
  ])("does not match %j", (message) => {
    expect(isStorageError(new Error(message))).toBe(false);
  });

  it("reads non-Error values without throwing", () => {
    expect(isStorageError(null)).toBe(false);
    expect(isStorageError(undefined)).toBe(false);
    expect(isStorageError({ code: 1 })).toBe(false);
  });
});
