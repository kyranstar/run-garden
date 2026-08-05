/**
 * The bridge's handling of a `backfill` job: executed through the
 * activities-only path and posted to /bridge/backfill-chunk.
 *
 * The second test is the regression guard for the plan-archiving hazard — a
 * backfill job must never push a snapshot, because an old range through the
 * snapshot path trips import-plan rules 8/9 and archives the live plan.
 */

import { describe, expect, it } from "vitest";
import { CorosClient } from "../src/coros-client.js";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;

async function runBackfillJob(): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  const server = mockCorosServer();
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.login(server.email, server.password);

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
                id: "backfill-job-1",
                kind: "backfill",
                originalDate: "2026-04-23",
                destinationDate: "2026-07-21",
                payload: { chunkStart: "2026-04-23", chunkEnd: "2026-07-21" },
              },
              pendingCount: 1,
            }
          : { job: null, pendingCount: 0 };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { privateKeyPem } = generateDeviceKeypair();
  const sync = new CloudSync({
    apiUrl: "https://api.example.com",
    deviceId: "dev-backfill",
    privateKeyPem,
    client,
    fetchImpl: cloudFetch,
    logger: noop,
  });

  await sync.pollJobs();
  return calls;
}

describe("CloudSync — backfill job kind", () => {
  it("posts the chunk it was asked for, then reports the job verified", async () => {
    const calls = await runBackfillJob();

    const chunkIdx = calls.findIndex((c) => c.path === "/api/devices/bridge/backfill-chunk");
    const resultIdx = calls.findIndex(
      (c) => c.path === "/api/devices/bridge/jobs/backfill-job-1/result",
    );

    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(chunkIdx); // chunk posted BEFORE the result

    const chunk = calls[chunkIdx]!.body;
    expect(chunk.chunkStart).toBe("2026-04-23");
    expect(chunk.chunkEnd).toBe("2026-07-21");
    expect(Array.isArray(chunk.activities)).toBe(true);

    expect(calls[resultIdx]!.body).toMatchObject({
      jobId: "backfill-job-1",
      deviceId: "dev-backfill",
      outcome: "verified",
    });
  });

  it("never pushes a snapshot for a backfill job", async () => {
    const calls = await runBackfillJob();
    expect(calls.map((c) => c.path)).not.toContain("/api/devices/bridge/sync");
  });
});
