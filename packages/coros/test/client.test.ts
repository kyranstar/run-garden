import { describe, expect, it } from "vitest";
import { CorosClient } from "../src/client.js";
import { mockCorosServer } from "./mock-coros-server.js";
import { createHash } from "node:crypto";

/** Test-side password login: node md5 + the public loginWithHash seam. */
const loginMd5 = (client: CorosClient, email: string, password: string) =>
  client.loginWithHash(email, createHash("md5").update(password, "utf8").digest("hex"));


const BASE_MONDAY = "2026-08-03";
const noop = (): void => undefined;

function makeClient(server = mockCorosServer({ baseMonday: BASE_MONDAY })) {
  return {
    server,
    client: new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop }),
  };
}

describe("CorosClient auth", () => {
  it("logs in with md5-hashed credentials and stores the session", async () => {
    const { server, client } = makeClient();
    const { userId } = await loginMd5(client, server.email, server.password);
    expect(userId).toBe(server.userId);
    expect(client.isAuthenticated).toBe(true);
    expect(client.currentUserId).toBe(server.userId);
  });

  it("maps result 1030 to bad_credentials", async () => {
    const { server, client } = makeClient();
    await expect(loginMd5(client, server.email, "wrong password")).rejects.toMatchObject({
      name: "CorosApiError",
      category: "bad_credentials",
      resultCode: "1030",
    });
    expect(client.isAuthenticated).toBe(false);
  });

  it("re-logins once and retries when a call returns 1019", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    expect(server.counts.login).toBe(1);

    server.expireTokens(); // next authed call → 1019
    const dashboard = await client.getDashboard();
    expect(dashboard.rhr).toBe(47);
    expect(dashboard.recoveryPct).toBe(88);
    expect(dashboard.fullRecoveryHours).toBe(9);
    expect(server.counts.login).toBe(2); // exactly one automatic re-login
  });

  it("does not retry 1019 after credentials are erased", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    await client.logout();
    server.expireTokens();
    await expect(client.getDashboard()).rejects.toMatchObject({ category: "not_authenticated" });
  });
});

describe("CorosClient reads", () => {
  it("reads the raw schedule for a window", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    const raw = await client.getRawSchedule("2026-08-01", "2026-08-31");
    expect(raw.id).toBe("800000000000001234");
    expect(raw.entities?.length).toBeGreaterThan(0);
    expect(Number(raw.maxIdInPlan)).toBe(20);
  });

  it("caps the schedule range at 90 days client-side", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    await expect(client.getRawSchedule("2026-01-01", "2026-12-31")).rejects.toMatchObject({
      category: "range_too_wide",
    });
    expect(server.counts.scheduleQuery).toBe(0); // rejected before hitting the API
  });

  it("paginates /activity/query via totalPage", async () => {
    const { server, client } = makeClient();
    server.forcePageSize = 1; // 4 fixture activities → 4 pages
    await loginMd5(client, server.email, server.password);
    const activities = await client.getActivities("2026-08-01", "2026-08-31");
    expect(activities.map((a) => a.labelId).sort()).toEqual([
      "act-bike-1",
      "act-run-1",
      "act-strength-1",
      "act-yoga-1",
    ]);
  });

  it("fetches activity detail form-encoded and daily metrics", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    const detail = await client.getActivityDetail("act-run-1", 100);
    expect(detail.summary?.avgPace).toBe(300);
    const days = await client.getDailyMetrics("2026-08-01", "2026-08-31");
    expect(days.length).toBe(2);
    expect(days[0]?.rhr).toBe(47);
  });

  it("reads the native duration estimate from program/calculate", async () => {
    const { server, client } = makeClient();
    await loginMd5(client, server.email, server.password);
    const program = server.state.schedule.programs?.find((p) => String(p.idInPlan) === "11");
    expect(program).toBeDefined();
    await expect(client.calculateProgram(program!)).resolves.toBe(3240);
  });
});
