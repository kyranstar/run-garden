import { createHash, createPublicKey, verify as nodeVerify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { corosProgramFingerprint, FIXTURE_PLAN_ID } from "@rg/providers";
import { CorosClient } from "../src/coros-client.js";
import { CloudSync, generateDeviceKeypair, publicKeyRawFromPrivate } from "../src/cloud-sync.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;

function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function dummyClient(): CorosClient {
  return new CorosClient({
    region: "us",
    fetchImpl: (async () => {
      throw new Error("no network in dummy client");
    }) as typeof fetch,
    logger: noop,
  });
}

describe("device keypair + request signing", () => {
  it("exports the raw 32-byte public key as base64url", () => {
    const { publicKeyRaw, privateKeyPem } = generateDeviceKeypair();
    expect(b64urlDecode(publicKeyRaw).length).toBe(32);
    expect(publicKeyRaw).not.toMatch(/[+/=]/); // b64url, unpadded
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(publicKeyRawFromPrivate(privateKeyPem)).toBe(publicKeyRaw);
  });

  it("signs requests verifiably with node:crypto over the worker's canonical message", () => {
    const { publicKeyRaw, privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-1",
      privateKeyPem,
      client: dummyClient(),
      logger: noop,
    });

    const body = JSON.stringify({ hello: "world" });
    const headers = sync.signRequest("POST", "/api/devices/bridge/sync", body);
    expect(headers["x-device-id"]).toBe("dev-1");
    expect(Number.isFinite(Date.parse(headers["x-device-timestamp"]!))).toBe(true);

    // Exactly what apps/worker/src/auth/crypto.ts deviceSigningMessage builds.
    const message = `POST\n/api/devices/bridge/sync\n${headers["x-device-timestamp"]}\n${sha256Hex(body)}`;
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKeyRaw },
      format: "jwk",
    });
    const valid = nodeVerify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      Buffer.from(headers["x-device-signature"]!, "base64url"),
    );
    expect(valid).toBe(true);

    // A tampered body must not verify.
    const tampered = `POST\n/api/devices/bridge/sync\n${headers["x-device-timestamp"]}\n${sha256Hex("{}")}`;
    expect(
      nodeVerify(
        null,
        Buffer.from(tampered, "utf8"),
        publicKey,
        Buffer.from(headers["x-device-signature"]!, "base64url"),
      ),
    ).toBe(false);
  });

  it("verifies with WebCrypto raw Ed25519 import — proving worker compatibility", async () => {
    const { publicKeyRaw, privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-2",
      privateKeyPem,
      client: dummyClient(),
      logger: noop,
    });
    const body = JSON.stringify({ jobId: "j1" });
    const headers = sync.signRequest("POST", "/api/devices/bridge/jobs/j1/result", body);
    const message = `POST\n/api/devices/bridge/jobs/j1/result\n${headers["x-device-timestamp"]}\n${sha256Hex(body)}`;

    // Same import path the worker uses (apps/worker/src/auth/crypto.ts verifyEd25519).
    const key = await webcrypto.subtle.importKey(
      "raw",
      b64urlDecode(publicKeyRaw),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await webcrypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64urlDecode(headers["x-device-signature"]!),
      new TextEncoder().encode(message),
    );
    expect(valid).toBe(true);
  });

  it("signs identically from a raw 32-byte seed", () => {
    const seed = new Uint8Array(32).fill(7);
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-3",
      privateKeySeed: seed,
      client: dummyClient(),
      logger: noop,
    });
    const headers = sync.signRequest("GET", "/api/devices/bridge/heartbeat", "");
    expect(headers["x-device-signature"]!.length).toBeGreaterThan(0);
  });
});

describe("CloudSync loop", () => {
  it("pushes a signed snapshot with plan, capabilities and range", async () => {
    const server = mockCorosServer(); // dynamic baseMonday: next Monday
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.login(server.email, server.password);

    const calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
    const cloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : (input as URL).href).pathname;
      calls.push({
        path,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ ok: true, job: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-snap",
      privateKeyPem,
      client,
      bridgeVersion: "0.1.0-test",
      fetchImpl: cloudFetch,
      logger: noop,
    });

    await sync.pushSnapshot();
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.path).toBe("/api/devices/bridge/sync");
    expect(call.headers.get("x-device-id")).toBe("dev-snap");
    expect(call.headers.get("x-device-signature")).toBeTruthy();
    expect(call.body.bridgeVersion).toBe("0.1.0-test");
    expect((call.body.capabilities as Record<string, boolean>).updateExistingScheduledWorkout).toBe(
      true,
    );
    expect((call.body.plan as { sourcePlanId: string }).sourcePlanId).toBe(FIXTURE_PLAN_ID);
    expect(Array.isArray(call.body.workouts)).toBe(true);
    expect(call.body.rangeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.body.rangeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("claims a job, executes the move, and reports a signed result", async () => {
    const baseMonday = "2026-08-03";
    const server = mockCorosServer({ baseMonday });
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.login(server.email, server.password);
    const program = server.state.schedule.programs?.find((p) => String(p.idInPlan) === "11");

    let claims = 0;
    const results: Array<Record<string, unknown>> = [];
    const cloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : (input as URL).href).pathname;
      let payload: unknown = { ok: true };
      if (path === "/api/devices/bridge/jobs/claim") {
        claims += 1;
        payload =
          claims === 1
            ? {
                job: {
                  id: "cloud-job-1",
                  kind: "move_scheduled_workout",
                  originalDate: "2026-08-04",
                  destinationDate: "2026-08-07",
                  expectedContentFingerprint: corosProgramFingerprint(program!),
                  attemptCount: 0,
                  workout: {
                    id: "w-1",
                    sourcePlanId: FIXTURE_PLAN_ID,
                    sourceWorkoutId: `${FIXTURE_PLAN_ID}:11`,
                    sourceIdInPlan: "11",
                    title: "Threshold 5x5",
                  },
                },
              }
            : { job: null };
      } else if (path === "/api/devices/bridge/jobs/cloud-job-1/result") {
        results.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { privateKeyPem } = generateDeviceKeypair();
    const sync = new CloudSync({
      apiUrl: "https://api.example.com",
      deviceId: "dev-jobs",
      privateKeyPem,
      client,
      fetchImpl: cloudFetch,
      logger: noop,
    });

    await sync.pollJobs();
    expect(claims).toBe(2); // drained until the queue reported empty
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      jobId: "cloud-job-1",
      deviceId: "dev-jobs",
      outcome: "verified",
      pathUsed: "direct_update",
      observedDate: "2026-08-07",
      signature: "sig-in-headers",
    });
    expect(typeof results[0]!.finishedAt).toBe("string");
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260807);
  });
});
