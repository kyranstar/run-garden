/**
 * NDJSON stdio protocol. Request: {id, op, params?}. Response:
 * {id, ok:true, result} | {id, ok:false, error:{category,message}}.
 * `handleRequest` is a pure(ish) function over BridgeState so tests can drive
 * it without child processes; main.ts owns the readline loop and the queue
 * that serializes processing (and therefore all COROS writes).
 */

import { z } from "zod";
import type { NameResolver } from "@rg/providers";
import {
  COROS_BRIDGE_CAPABILITIES,
  CorosApiError,
  CorosClient,
  type CorosRegion,
} from "./coros-client.js";
import { buildSnapshot, loadNameResolver } from "./snapshot.js";
import { executeMoveJob } from "./write-executor.js";

export interface BridgeState {
  client: CorosClient | null;
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

      case "eraseCredentials": {
        if (state.client) {
          await state.client.logout().catch(() => undefined);
          state.client = null;
        }
        return ok(id, { erased: true });
      }

      case "shutdown":
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
