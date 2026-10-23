import { describe, expect, it } from "vitest";
import { createAppClient } from "../src/app-client.js";
import { AppRefusedError, AppUnreachableError } from "../src/errors.js";

const TOKEN = "tok-synthetic-0123456789";
const APP = "https://app.example.com/";

function recorder(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, client: createAppClient({ appUrl: APP, token: TOKEN, fetchImpl }) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("the app client", () => {
  it("sends the token only as a bearer header, never in the URL", async () => {
    const { calls, client } = recorder(() => json(200, { fresh: ["a"] }));
    expect(await client.known("instagram", ["a", "b"])).toEqual(["a"]);
    expect(calls[0]!.url).toBe("https://app.example.com/api/saves/known");
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(header(calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ source: "instagram", keys: ["a", "b"] });
  });

  it("asks /known in chunks of at most 200 keys", async () => {
    const { calls, client } = recorder((_, init) => json(200, { fresh: JSON.parse(String(init.body)).keys.slice(0, 1) }));
    const keys = Array.from({ length: 450 }, (_, i) => `k${i}`);
    expect(await client.known("instagram", keys)).toEqual(["k0", "k200", "k400"]);
    expect(calls.map((c) => JSON.parse(String(c.init.body)).keys.length)).toEqual([200, 200, 50]);
  });

  it("sends the relay body as a string (so it has a Content-Length), with the model and token budget headers", async () => {
    const { calls, client } = recorder(() => json(200, { status: "matched", moves: 1, kind: "single_move" }));
    const body = JSON.stringify({ model: "google/gemini-3.6-flash", messages: [] });
    expect(await client.extract("instagram", "Syn/01", body, { model: "google/gemini-3.6-flash", maxTokens: 4000 })).toEqual({ ok: true });
    const [call] = calls;
    expect(call!.url).toBe("https://app.example.com/api/saves/posts/Syn%2F01/extract?source=instagram");
    expect(call!.init.method).toBe("POST");
    expect(typeof call!.init.body).toBe("string");
    expect(header(call!.init, "x-saves-model")).toBe("google/gemini-3.6-flash");
    expect(header(call!.init, "x-saves-max-tokens")).toBe("4000");
    expect(header(call!.init, "content-type")).toBe("application/json");
  });

  it("reads the relay's coded refusals by their error, whatever the status", async () => {
    const answers = [
      json(502, { error: "model_failed", issues: ["moves.0.name: is required"] }),
      json(413, { error: "too_large" }),
      json(429, { error: "budget_paused" }),
      json(404, { error: "not_found" }),
      json(409, { error: "conflict" }),
      json(502, { error: "unknown" }),
    ];
    const { client } = recorder(() => answers.shift()!);
    const ask = () => client.extract("instagram", "k", "{}", { model: "m", maxTokens: 10 });
    expect(await ask()).toEqual({ ok: false, code: "model_failed", issues: ["moves.0.name: is required"] });
    expect(await ask()).toEqual({ ok: false, code: "too_large" });
    expect(await ask()).toEqual({ ok: false, code: "budget_paused" });
    expect(await ask()).toEqual({ ok: false, code: "not_found" });
    expect(await ask()).toEqual({ ok: false, code: "conflict" });
    expect(await ask()).toEqual({ ok: false, code: "unknown" });
  });

  it("an outage (network, 5xx, a non-JSON gateway page) is AppUnreachableError; a 401 or 422 is AppRefusedError", async () => {
    const down = recorder(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(down.client.work()).rejects.toBeInstanceOf(AppUnreachableError);
    const five = recorder(() => json(503, { error: "restore_in_progress" }));
    await expect(five.client.submitPost({} as never)).rejects.toBeInstanceOf(AppUnreachableError);
    const html = recorder(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(html.client.extract("instagram", "k", "{}", { model: "m", maxTokens: 1 })).rejects.toBeInstanceOf(AppUnreachableError);
    const auth = recorder(() => json(401, { error: "unauthenticated" }));
    await expect(auth.client.reportCheck({ checkId: "x", phase: "start" })).rejects.toBeInstanceOf(AppRefusedError);
    const invalid = recorder(() => json(422, { error: "invalid", issues: [] }));
    await expect(invalid.client.submitPost({} as never)).rejects.toMatchObject({ status: 422 });
  });

  it("never puts the token in an error message", async () => {
    const { client } = recorder(() => {
      throw new TypeError(`Failed to fetch`);
    });
    const err = await client.work().catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it("reads the work list and a submit's answer", async () => {
    const answers = [
      json(200, { keys: [{ source: "instagram", key: "k", url: "https://www.instagram.com/p/k/", action: "filter" }] }),
      json(200, { status: "queued", verdict: "training", reason: "drills" }),
    ];
    const { client } = recorder(() => answers.shift()!);
    expect(await client.work()).toEqual([{ source: "instagram", key: "k", url: "https://www.instagram.com/p/k/", action: "filter" }]);
    expect(await client.submitPost({} as never)).toEqual({ status: "queued", verdict: "training", reason: "drills" });
  });
});
