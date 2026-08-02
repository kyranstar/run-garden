import { describe, expect, it } from "vitest";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";
import { CorosClient } from "../src/coros-client.js";
import { buildSnapshot } from "../src/snapshot.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;

/**
 * Exercise catalog sync (plan-studio-design §4): buildSnapshot only fetches
 * the COROS strength catalog (sportType 4) when asked to, and CloudSync only
 * asks for it when the worker's previous sync response said the stored copy
 * was stale.
 */

describe("buildSnapshot exercise catalog", () => {
  it("omits exerciseCatalog by default", async () => {
    const server = mockCorosServer();
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.login(server.email, server.password);
    const snapshot = await buildSnapshot(client, "2026-07-27", "2026-08-31", undefined);
    expect(snapshot.exerciseCatalog).toBeUndefined();
  });

  it("fetches and maps the sportType=4 catalog when asked", async () => {
    const server = mockCorosServer();
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.login(server.email, server.password);
    const snapshot = await buildSnapshot(client, "2026-07-27", "2026-08-31", undefined, {
      includeExerciseCatalog: true,
    });
    expect(snapshot.exerciseCatalog).toEqual([
      { id: "425898928110747648", name: "T2001" },
      { id: "426109589008859137", name: "T2101" },
    ]);
  });
});

describe("CloudSync catalog-staleness tracking", () => {
  function makeSync(cloudFetch: typeof fetch) {
    const server = mockCorosServer();
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    const { privateKeyPem } = generateDeviceKeypair();
    const login = client.login(server.email, server.password);
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-catalog",
      privateKeyPem,
      client,
      fetchImpl: cloudFetch,
      logger: noop,
    });
    return { sync, login };
  }

  it("includes the catalog on the first-ever sync (no prior knowledge)", async () => {
    let lastBody: Record<string, unknown> | undefined;
    const cloudFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, catalogStale: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { sync, login } = makeSync(cloudFetch);
    await login;

    await sync.pushSnapshot();
    expect(Array.isArray(lastBody?.exerciseCatalog)).toBe(true);
    expect(lastBody?.exerciseCatalog).toEqual([
      { id: "425898928110747648", name: "T2001" },
      { id: "426109589008859137", name: "T2101" },
    ]);
  });

  it("omits the catalog once the worker reports it is fresh, and resumes sending it once stale again", async () => {
    const responses = [{ catalogStale: false }, { catalogStale: true }];
    const bodies: Array<Record<string, unknown>> = [];
    const cloudFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = responses.shift() ?? { catalogStale: false };
      return new Response(JSON.stringify({ ok: true, ...next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { sync, login } = makeSync(cloudFetch);
    await login;

    // 1st sync: no prior knowledge → sends the catalog. Worker replies "fresh now".
    await sync.pushSnapshot();
    expect(bodies[0]?.exerciseCatalog).toBeTruthy();

    // 2nd sync: previous response said fresh → omit the catalog.
    await sync.pushSnapshot();
    expect(bodies[1]?.exerciseCatalog).toBeUndefined();

    // Worker's 2nd response said stale again → 3rd sync resumes sending it.
    await sync.pushSnapshot();
    expect(bodies[2]?.exerciseCatalog).toBeTruthy();
  });
});
