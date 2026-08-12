/**
 * Task 11: the bridge's handling of a `read_now` job — claimed like any other
 * job, but executed by re-pushing a snapshot (a plain read) rather than by
 * writing anything to COROS. Mirrors signing.test.ts's "CloudSync loop"
 * pattern: a real CorosClient against `mockCorosServer` (so `buildSnapshot`
 * has everything it needs — plan, workouts, activities, daily metrics) and a
 * stubbed `fetchImpl` standing in for the worker.
 */

import { describe, expect, it } from "vitest";
import { loginWithPassword } from "../src/coros-login.js";
import { CorosClient } from "@rg/coros";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;

describe("CloudSync — read_now job kind", () => {
  it("executes a claimed read_now job by pushing a snapshot, then reports outcome verified", async () => {
    const server = mockCorosServer(); // dynamic baseMonday: next Monday
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await loginWithPassword(client, server.email, server.password);

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let claims = 0;
    const cloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : (input as URL).href).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });

      if (path === "/api/devices/bridge/jobs/claim") {
        claims += 1;
        const payload =
          claims === 1
            ? {
                job: {
                  id: "read-now-job-1",
                  kind: "read_now",
                  originalDate: "2026-08-08",
                  destinationDate: "2026-08-08",
                },
                pendingCount: 1,
              }
            : { job: null, pendingCount: 0 };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/devices/bridge/sync") {
        return new Response(JSON.stringify({ ok: true, catalogStale: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // .../jobs/:id/result
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-readnow",
      privateKeyPem,
      client,
      fetchImpl: cloudFetch,
      logger: noop,
    });

    await sync.pollJobs();

    expect(claims).toBe(2); // drained until the queue reported empty

    const claimIdx = calls.findIndex((c) => c.path === "/api/devices/bridge/jobs/claim");
    const syncIdx = calls.findIndex((c) => c.path === "/api/devices/bridge/sync");
    const resultIdx = calls.findIndex((c) => c.path === "/api/devices/bridge/jobs/read-now-job-1/result");

    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThan(claimIdx); // the sync push happens AFTER the claim…
    expect(resultIdx).toBeGreaterThan(syncIdx); // …and BEFORE the result is reported.

    const resultCall = calls[resultIdx]!;
    expect(resultCall.body).toMatchObject({
      jobId: "read-now-job-1",
      deviceId: "dev-readnow",
      outcome: "verified",
    });
    expect(typeof resultCall.body.finishedAt).toBe("string");

    // No move/studio executor ran — the sync body carries a real snapshot
    // (proof pushSnapshot(), not some no-op, is what ran).
    const syncCall = calls[syncIdx]!;
    expect(Array.isArray(syncCall.body.workouts)).toBe(true);
  });
});
