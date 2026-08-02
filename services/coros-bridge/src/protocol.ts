/**
 * NDJSON stdio protocol. Request: {id, op, params?}. Response:
 * {id, ok:true, result} | {id, ok:false, error:{category,message}}.
 * `handleRequest` is a pure(ish) function over BridgeState so tests can drive
 * it without child processes; main.ts owns the readline loop and the queue
 * that serializes processing (and therefore all COROS writes).
 */

import os from "node:os";
import { z } from "zod";
import type { NameResolver } from "@rg/providers";
import {
  COROS_BRIDGE_CAPABILITIES,
  CorosApiError,
  CorosClient,
  type CorosRegion,
} from "./coros-client.js";
import { CloudSync, generateDeviceKeypair } from "./cloud-sync.js";
import { buildSnapshot, loadNameResolver } from "./snapshot.js";
import { executeMoveJob } from "./write-executor.js";

export interface BridgeState {
  client: CorosClient | null;
  cloudSync: CloudSync | null;
  shuttingDown: boolean;
  readonly fetchImpl: typeof fetch;
  readonly makeClient: (region: CorosRegion) => CorosClient;
  localePromise: Promise<NameResolver | undefined> | null;
}

export function createBridgeState(
  opts: {
    fetchImpl?: typeof fetch;
    makeClient?: (region: CorosRegion) => CorosClient;
  } = {},
): BridgeState {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    client: null,
    cloudSync: null,
    shuttingDown: false,
    fetchImpl,
    makeClient: opts.makeClient ?? ((region) => new CorosClient({ region, fetchImpl })),
    localePromise: null,
  };
}

export type BridgeResponse =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { category: string; message: string } };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const requestSchema = z.object({
  id: z.string(),
  op: z.string(),
  params: z.record(z.unknown()).optional(),
});

const authenticateParams = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  region: z.enum(["us", "eu", "cn"]),
});

const rangeParams = z.object({
  rangeStart: z.string().regex(DATE_RE),
  rangeEnd: z.string().regex(DATE_RE),
});

const executeJobParams = z.object({
  job: z.object({
    id: z.string(),
    originalDate: z.string().regex(DATE_RE),
    destinationDate: z.string().regex(DATE_RE),
    expectedContentFingerprint: z.string().optional(),
    workout: z.object({
      sourceIdInPlan: z.string(),
      sourcePlanId: z.string(),
      sourceProgramId: z.string().optional(),
    }),
  }),
});

const pairDeviceParams = z.object({
  apiUrl: z.string().url(),
  deviceName: z.string().optional(),
  appVersion: z.string().optional(),
});

const claimDeviceParams = z.object({
  apiUrl: z.string().url(),
  handshakeId: z.string(),
});

const startCloudSyncParams = z.object({
  apiUrl: z.string().url(),
  deviceId: z.string(),
  privateKeyPem: z.string(),
});

function platformName(): "macos" | "windows" | "linux" {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}

function ok(id: string | null, result: unknown): BridgeResponse {
  return { id, ok: true, result };
}

function err(id: string | null, category: string, message: string): BridgeResponse {
  return { id, ok: false, error: { category, message } };
}

/** Parse one NDJSON line and handle it. Invalid JSON → error with id null. */
export async function handleLine(state: BridgeState, line: string): Promise<BridgeResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return err(null, "invalid_request", "line is not valid JSON");
  }
  return handleRequest(state, parsed);
}

export async function handleRequest(state: BridgeState, input: unknown): Promise<BridgeResponse> {
  const rawId =
    typeof input === "object" && input !== null && typeof (input as { id?: unknown }).id === "string"
      ? ((input as { id: string }).id)
      : null;
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return err(rawId, "invalid_request", "request must be {id, op, params?}");
  }
  const { id, op, params } = parsed.data;

  try {
    switch (op) {
      case "authenticate": {
        const p = authenticateParams.safeParse(params ?? {});
        if (!p.success) return err(id, "invalid_request", "authenticate needs email/password/region");
        // Replace any previous session; credentials live in client memory only.
        if (state.client) await state.client.logout().catch(() => undefined);
        const client = state.makeClient(p.data.region);
        const { userId } = await client.login(p.data.email, p.data.password);
        state.client = client;
        return ok(id, { userId, capabilities: client.getCapabilities() });
      }

      case "testConnection": {
        if (!state.client) return ok(id, { connected: false });
        try {
          await state.client.getDashboard();
          return ok(id, { connected: true });
        } catch {
          return ok(id, { connected: false });
        }
      }

      case "getCapabilities":
        return ok(id, { ...COROS_BRIDGE_CAPABILITIES });

      case "readSnapshot": {
        const client = state.client;
        if (!client) return err(id, "not_authenticated", "authenticate first");
        const p = rangeParams.safeParse(params ?? {});
        if (!p.success || p.data.rangeStart > p.data.rangeEnd) {
          return err(id, "invalid_request", "readSnapshot needs rangeStart <= rangeEnd (yyyy-mm-dd)");
        }
        state.localePromise ??= loadNameResolver(state.fetchImpl);
        const resolver = await state.localePromise;
        const snapshot = await buildSnapshot(client, p.data.rangeStart, p.data.rangeEnd, resolver);
        return ok(id, snapshot);
      }

      case "executeJob": {
        const client = state.client;
        if (!client) return err(id, "not_authenticated", "authenticate first");
        const p = executeJobParams.safeParse(params ?? {});
        if (!p.success) return err(id, "invalid_request", "executeJob needs a move job");
        return ok(id, await executeMoveJob(client, p.data.job));
      }

      case "pairDevice": {
        // Bootstrap device registration (not device-signed): generate an
        // Ed25519 identity, register the public key with the cloud, and return
        // the private key for the Rust core to store in the OS keychain.
        const p = pairDeviceParams.safeParse(params ?? {});
        if (!p.success) return err(id, "invalid_request", "pairDevice needs apiUrl");
        const kp = generateDeviceKeypair();
        const body = {
          publicKey: kp.publicKeyRaw,
          deviceName: p.data.deviceName ?? os.hostname() ?? "This Mac",
          platform: platformName(),
          appVersion: p.data.appVersion ?? "0.1.0",
        };
        const res = await state.fetchImpl(`${p.data.apiUrl.replace(/\/+$/, "")}/api/devices/handshake`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(id, "pairing_failed", `handshake failed (${res.status})`);
        const hs = (await res.json()) as { handshakeId: string; approveUrl: string };
        return ok(id, {
          handshakeId: hs.handshakeId,
          approveUrl: hs.approveUrl,
          privateKeyPem: kp.privateKeyPem,
          publicKeyRaw: kp.publicKeyRaw,
        });
      }

      case "claimDevice": {
        const p = claimDeviceParams.safeParse(params ?? {});
        if (!p.success) return err(id, "invalid_request", "claimDevice needs apiUrl/handshakeId");
        const res = await state.fetchImpl(
          `${p.data.apiUrl.replace(/\/+$/, "")}/api/devices/handshake/${encodeURIComponent(p.data.handshakeId)}`,
        );
        if (!res.ok) return err(id, "claim_failed", `claim failed (${res.status})`);
        return ok(id, await res.json());
      }

      case "startCloudSync": {
        const client = state.client;
        if (!client) return err(id, "not_authenticated", "authenticate first");
        const p = startCloudSyncParams.safeParse(params ?? {});
        if (!p.success) return err(id, "invalid_request", "startCloudSync needs apiUrl/deviceId/privateKeyPem");
        if (state.cloudSync) state.cloudSync.stop();
        state.cloudSync = new CloudSync({
          apiUrl: p.data.apiUrl,
          deviceId: p.data.deviceId,
          privateKeyPem: p.data.privateKeyPem,
          client,
          fetchImpl: state.fetchImpl,
        });
        state.cloudSync.start();
        return ok(id, { started: true });
      }

      case "readGarden": {
        // Ambient garden read for the desktop screensaver window. Requires an
        // active cloud sync (which holds the device signing key); returns the
        // same { snapshot, condition, species } the website renders.
        if (!state.cloudSync) return err(id, "not_connected", "cloud sync not started");
        return ok(id, await state.cloudSync.readGarden());
      }

      case "stopCloudSync": {
        if (state.cloudSync) {
          state.cloudSync.stop();
          state.cloudSync = null;
        }
        return ok(id, { stopped: true });
      }

      case "eraseCredentials": {
        if (state.cloudSync) {
          state.cloudSync.stop();
          state.cloudSync = null;
        }
        if (state.client) {
          await state.client.logout().catch(() => undefined);
          state.client = null;
        }
        return ok(id, { erased: true });
      }

      case "shutdown":
        if (state.cloudSync) state.cloudSync.stop();
        state.shuttingDown = true;
        return ok(id, { shuttingDown: true });

      default:
        return err(id, "unknown_op", `unknown op "${op}"`);
    }
  } catch (e) {
    if (e instanceof CorosApiError) return err(id, e.category, e.message);
    // Sanitized: never echo request payloads back in errors.
    return err(id, "internal", e instanceof Error ? e.message : "unknown error");
  }
}
