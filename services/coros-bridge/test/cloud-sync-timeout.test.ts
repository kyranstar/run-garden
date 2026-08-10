/**
 * The four-day wedge: every CloudSync request rides one shared work chain,
 * and the poll loop's re-arm lives in that chain — so a single cloud request
 * that never settles used to kill job claiming silently, forever, while the
 * snapshot interval kept the device looking online. The cure is a hard
 * request timeout: a hung request must abort and let the chain move on.
 */

import { describe, expect, it } from "vitest";
import type { CorosClient } from "../src/coros-client.js";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";

const noop = (): void => undefined;

describe("CloudSync — request timeout", () => {
  it("a claim request that never settles aborts and does not wedge later polls", async () => {
    let claims = 0;
    const cloudFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      claims += 1;
      if (claims === 1) {
        // Hang forever — settle only when the timeout signal aborts us,
        // exactly like a dead TCP connection with no server RST.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      return new Response(JSON.stringify({ job: null, pendingCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-timeout",
      privateKeyPem,
      // pollJobs touches COROS only after a claim succeeds — never here.
      client: {} as unknown as CorosClient,
      fetchImpl: cloudFetch,
      intervals: { requestTimeoutMs: 50 },
      logger: noop,
    });

    // The hung request must settle (by aborting) instead of hanging the test.
    await expect(sync.pollJobs()).rejects.toThrow();
    expect(claims).toBe(1);

    // And the same instance polls fine afterwards — nothing stayed wedged.
    await sync.pollJobs();
    expect(claims).toBe(2);
  });
});
