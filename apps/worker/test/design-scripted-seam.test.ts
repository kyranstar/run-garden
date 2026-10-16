/**
 * THE SCRIPTED MODEL IS A FIXTURE-STACK SEAM ONLY (Stage 3 Task 9). On the fixture stack, `AI_DESIGN_MODEL=scripted:<name>`
 * names a script the stack's stand-in model serves (apps/web/e2e/coach-design-model.mjs, on loopback through
 * `FIXTURE_MODEL_URL`), so the composer → run → proposal → approve journey runs end to end with no key. Anywhere else —
 * production, staging, a test host — the setting is ignored: the designer's model is the default, and a call goes to the
 * gateway as it always does. The guard is `/api/dev/*`'s own: fixture mode.
 *
 * No key and no network: every call goes through an injected fetch. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { callMessages, DEFAULT_DESIGN_MODEL, designModel, SCRIPTED_MODEL_PREFIX, type MessagesRequest } from "../src/services/llm-messages.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-gateway-key",
    ...overrides,
  };
}

const request: MessagesRequest = { system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100 };

/** A gateway that records where each call went and with which model, and answers one plain turn. */
function recorder() {
  const calls: Array<{ url: string; model: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), model: (JSON.parse(String(init?.body)) as { model: string }).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("AI_DESIGN_MODEL=scripted:<name>", () => {
  it("is the prefix the fixture stack's stand-in model reads", () => {
    expect(SCRIPTED_MODEL_PREFIX).toBe("scripted:");
  });

  it("outside fixture mode is ignored: the designer's model is the default", () => {
    expect(designModel(makeEnv({ AI_DESIGN_MODEL: "scripted:now" }))).toBe(DEFAULT_DESIGN_MODEL);
    expect(designModel(makeEnv({ AI_DESIGN_MODEL: "scripted:now", STAGING: "1" }))).toBe(DEFAULT_DESIGN_MODEL);
    // Another model the owner picks is still honoured.
    expect(designModel(makeEnv({ AI_DESIGN_MODEL: "anthropic/claude-fable-5.1" }))).toBe("anthropic/claude-fable-5.1");
  });

  it("outside fixture mode, a call goes to the gateway with the default model — never a script, even one asked for by name", async () => {
    const env = makeEnv({ AI_DESIGN_MODEL: "scripted:now", FIXTURE_MODEL_URL: "http://127.0.0.1:8897" });
    for (const req of [request, { ...request, model: "scripted:now" }]) {
      const { calls, fetchImpl } = recorder();
      const res = await callMessages(env, req, fetchImpl);
      expect(res.ok).toBe(true);
      expect(calls).toEqual([{ url: "https://ai-gateway.vercel.sh/v1/messages", model: DEFAULT_DESIGN_MODEL }]);
    }
  });

  it("in fixture mode, the script's name reaches the stand-in on loopback", async () => {
    const env = makeEnv({ FIXTURE_MODE: "1", AI_DESIGN_MODEL: "scripted:now", FIXTURE_MODEL_URL: "http://127.0.0.1:8897" });
    expect(designModel(env)).toBe("scripted:now");
    const { calls, fetchImpl } = recorder();
    expect((await callMessages(env, request, fetchImpl)).ok).toBe(true);
    expect(calls).toEqual([{ url: "http://127.0.0.1:8897/messages", model: "scripted:now" }]);
  });

  it("in fixture mode with no stand-in named, the canned answer stands: nothing leaves the machine", async () => {
    const { calls, fetchImpl } = recorder();
    const res = await callMessages(makeEnv({ FIXTURE_MODE: "1", AI_DESIGN_MODEL: "scripted:now" }), request, fetchImpl);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([]);
  });
});
