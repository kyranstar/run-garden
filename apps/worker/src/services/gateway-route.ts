import { fixtureModeEnabled, type Env } from "../env.js";

/**
 * Where a model call goes (Audit 2 I1, Ruling C2) — for the coach wake (coach-wake.ts, which re-exports this) and the
 * coach designer (llm-messages.ts). A module of its own so the designer's client never imports the coach: the thread
 * coach may one day call the designer, and that import would be a cycle. `AI_DEFAULT_ENABLED` does not gate the wake,
 * and the e2e fixture stack's Plan page fires one on every open of a fresh account, so this is decided before the
 * model is asked anything:
 *
 * - fixture mode → `canned`: a fixed reply, no network. The one exception is
 *   a recorded-model server on loopback named by `FIXTURE_MODEL_URL` (the
 *   coach replay specs); `AI_GATEWAY_BASE_URL` is never used in fixture mode.
 * - no key → `no_key`: no call at all (coach reads skip the same way).
 */
export type WakeGateway = { kind: "canned" } | { kind: "no_key" } | { kind: "model"; env: Env };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `raw` when it is an http(s) URL on loopback; otherwise null. */
export function loopbackUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The gateway's routing for a model, spread into every gateway request body (both surfaces parse
 * `providerOptions.gateway.order`: free schema probe, 2026-11-02). A Claude model asks for Anthropic first: the
 * account's own Anthropic key on the gateway (BYOK, funded by the Claude plan's monthly API credits) pays only for
 * requests Anthropic serves, and a Claude model alone may be routed to Bedrock or Vertex instead. `order`, not `only`:
 * those stay as fallbacks, on the gateway's credits, when Anthropic is down. Any other model: nothing.
 */
export function gatewayRouting(model: string): { providerOptions?: { gateway: { order: string[] } } } {
  return model.startsWith("anthropic/") ? { providerOptions: { gateway: { order: ["anthropic"] } } } : {};
}

export function wakeGateway(env: Env): WakeGateway {
  if (fixtureModeEnabled(env)) {
    const recorded = loopbackUrl(env.FIXTURE_MODEL_URL);
    if (!recorded) return { kind: "canned" };
    if (!env.AI_GATEWAY_API_KEY) return { kind: "no_key" };
    return { kind: "model", env: { ...env, AI_GATEWAY_BASE_URL: recorded } };
  }
  if (!env.AI_GATEWAY_API_KEY) return { kind: "no_key" };
  return { kind: "model", env };
}
