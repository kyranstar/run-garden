/* eslint-disable */
/**
 * A STAND-IN FOR THE AI GATEWAY THAT SERVES THE SCRIPTED COACH DESIGNER (Stage 3 Task 9), on loopback, for the fixture
 * stack only. The worker reaches it through `FIXTURE_MODEL_URL` (fixture mode's one way to a model: gateway-route.ts)
 * with `AI_DESIGN_MODEL=scripted:<name>`; outside fixture mode the worker ignores a scripted id (llm-messages.ts).
 *
 *   POST /messages          the designer's call: the script named by the request's `model` answers (coach-design-scripts.mjs)
 *   POST /chat/completions  the thread coach's wake: a complete wake that proposes nothing, so the Plan stays quiet
 *   POST /use/<name>        from here on, answer with that script whatever the model id (a screenshot run's several
 *                           journeys on one worker); POST /use/ goes back to the model id's
 *
 *   node apps/web/e2e/coach-design-model.mjs [port]     (default 8897; RG_DESIGN_MODEL_PORT too)
 *
 * Every answer is chosen from the request alone (see the scripts' header); nothing is recorded, nothing leaves the
 * machine.
 */
import { createServer } from "node:http";
import { SCRIPTS } from "./coach-design-scripts.mjs";

const PORT = Number(process.argv[2] || process.env.RG_DESIGN_MODEL_PORT || 8897);

/** The run's role, from the role block its system prompt carries. */
function roleOf(system) {
  const text = (Array.isArray(system) ? system.map((b) => b.text ?? "").join("\n") : String(system ?? "")) || "";
  if (text.includes("# Your role: the independent reviewer")) return "reviewer";
  if (text.includes("# Your role: a workout's designer")) return "designer";
  return "main";
}

/** Today, as the opening message says it ("Today is Tuesday, 2026-10-13, …"); the machine's own date otherwise. */
function todayOf(messages) {
  for (const m of messages ?? []) {
    const parts = typeof m.content === "string" ? [m.content] : (m.content ?? []).map((b) => b.text ?? "");
    for (const t of parts) {
      const found = /Today is \w+, (\d{4}-\d{2}-\d{2})/.exec(t);
      if (found) return found[1];
    }
  }
  return new Date().toISOString().slice(0, 10);
}

/** The review's dimensions, from submit_review's own schema in the request. */
function dimensionsOf(tools) {
  const t = (tools ?? []).find((x) => x.name === "submit_review");
  return t?.input_schema?.properties?.scores?.required ?? [];
}

const RESTRAINT = JSON.stringify({ briefing: null, proposals: [], question: null, memoryOps: [], focus: null, raceLine: null });

/** The script a harness asked for (`POST /use/<name>`), over the model id's. */
let override = null;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const use = /^\/use\/(\w*)$/.exec(req.url ?? "");
    if (use) {
      override = use[1] && SCRIPTS[use[1]] ? use[1] : null;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ script: override }));
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: RESTRAINT } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (!req.url?.endsWith("/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unreadable" }));
    }
    const name = override ?? String(request.model ?? "").replace(/^scripted:/, "");
    const script = SCRIPTS[name];
    if (!script) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no script named ${name}` }));
    }
    const role = roleOf(request.system);
    const turn = (request.messages ?? []).filter((m) => m.role === "assistant").length;
    const answer = (script[role] ?? script.main)(turn, { today: todayOf(request.messages), dimensions: dimensionsOf(request.tools), role });
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    if (answer.status) {
      res.writeHead(answer.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "scripted", message: `scripted ${answer.status}` } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        content: answer.content,
        stop_reason: answer.stop_reason,
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    );
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`scripted coach designer on ${PORT}`));
