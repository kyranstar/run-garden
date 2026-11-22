/**
 * ONCE SWITCH A HAS BEEN ON, THE ACCOUNT'S COACH IS READ BY ANTHROPIC ONLY (R1.5; DESIGN-3 §3.12.4). Every Claude call asks
 * the gateway for Anthropic first (`order`), which leaves Claude on Bedrock or Vertex as fallbacks; LifeOS's sharing switch A
 * promises "Read by Claude (Anthropic)". So a pinned call is `only: ["anthropic"]`, no `order`; if Anthropic can't serve it,
 * it fails as an ordinary provider error and never falls back. An unpinned call is routed exactly as before.
 *
 * Here, the routing and the three clients that send it (the designer's Messages call, the chat-completions call the wake,
 * the activity reads and the Studio use, and the voice workshop's replay). Which calls are pinned: anthropic-pin-paths.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { replayRequest } from "../src/services/coach-replay.js";
import type { RunState } from "../src/services/coach-runs.js";
import { gatewayRouting } from "../src/services/gateway-route.js";
import { callMessages } from "../src/services/llm-messages.js";
import { chatCompletion } from "../src/services/studio-llm.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", AI_GATEWAY_API_KEY: "test-key" } as Env;
const CLAUDE = "anthropic/claude-opus-5.5";
const PINNED = { providerOptions: { gateway: { only: ["anthropic"] } } };

/** A gateway that answers `status` to every call, and the bodies it was sent. */
function gateway(status: number) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response(status === 200 ? "" : "unavailable", { status });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("the gateway's routing (R1.5)", () => {
  it("unpinned: a Claude model asks for Anthropic first, its fallbacks kept; any other model, nothing — as before", () => {
    expect(gatewayRouting(CLAUDE)).toEqual({ providerOptions: { gateway: { order: ["anthropic"] } } });
    expect(gatewayRouting("openai/gpt-5")).toEqual({});
  });

  it("pinned: Anthropic only, no order — whatever the model, so a non-Claude model is refused rather than routed elsewhere", () => {
    expect(gatewayRouting(CLAUDE, { anthropicOnly: true })).toEqual(PINNED);
    expect(gatewayRouting("openai/gpt-5", { anthropicOnly: true })).toEqual(PINNED);
    expect(gatewayRouting(CLAUDE, { anthropicOnly: false })).toEqual(gatewayRouting(CLAUDE));
  });
});

describe("the clients send it (R1.5)", () => {
  const messagesReq = { model: CLAUDE, system: [], messages: [{ role: "user" as const, content: "Hi" }], tools: [], maxTokens: 100 };

  it("the designer's Messages call: pinned, Anthropic only; unavailable, an ordinary provider error, one call, no fallback", async () => {
    const g = gateway(503);
    const out = await callMessages(env, { ...messagesReq, anthropicOnly: true }, g.fetchImpl);
    expect(out).toMatchObject({ ok: false, kind: "retryable" });
    expect(g.bodies).toHaveLength(1);
    expect(g.bodies[0]!.providerOptions).toEqual(PINNED.providerOptions);
    const plain = gateway(503);
    await callMessages(env, messagesReq, plain.fetchImpl);
    expect(plain.bodies[0]!.providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
  });

  it("the chat-completions call (the wake, the activity reads): pinned on every attempt, its retry too; unpinned as before", async () => {
    const g = gateway(503);
    const out = await chatCompletion(env, g.fetchImpl, CLAUDE, 100, [{ role: "user", content: "Hi" }], { anthropicOnly: true });
    expect(out.ok).toBe(false);
    expect(g.bodies.length).toBeGreaterThan(0);
    for (const b of g.bodies) expect(b.providerOptions).toEqual(PINNED.providerOptions);
    const plain = gateway(400);
    await chatCompletion(env, plain.fetchImpl, CLAUDE, 100, [{ role: "user", content: "Hi" }]);
    expect(plain.bodies[0]!.providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
  }, 15_000);

  it("the voice workshop's replay request: pinned when asked, as before when not", () => {
    const state = { v: 1, settings: { maxTokens: 100, effort: "medium" }, messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], system: [] } as unknown as RunState;
    const tail = (o?: { anthropicOnly?: boolean }) => JSON.parse(`{${replayRequest(state, 1, [], CLAUDE, [], o).tail.slice(2)}`) as Record<string, unknown>;
    expect(tail({ anthropicOnly: true }).providerOptions).toEqual(PINNED.providerOptions);
    expect(tail().providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
    expect(tail({ anthropicOnly: false }).providerOptions).toEqual({ gateway: { order: ["anthropic"] } });
  });
});
