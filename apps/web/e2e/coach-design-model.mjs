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
 *   POST /delay/<ms>        from here on, every answer waits that long (over a script's own): a step stays mid-response
 *                           (the robustness journeys); POST /delay/ goes back to the script's
 *   POST /stall/<n>         the next n answers stream the message's start and a word, then go silent for good: the
 *                           worker's stall guard must cut the read loose (llm-messages.ts)
 *   GET  /calls             the model calls begun, answered, and those whose caller hung up before the answer (the
 *                           worker's fetch cancelled); POST /calls/reset clears them
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

/** The run's opening message: its first user message's text (what a script may read the run's focus from). */
function openingOf(messages) {
  const first = (messages ?? []).find((m) => m.role === "user");
  if (!first) return "";
  return typeof first.content === "string" ? first.content : (first.content ?? []).map((b) => b.text ?? "").join("\n");
}

/**
 * The review's dimensions: the rubric the reviewer's own block lists (§8 §3: a run's draft is reviewed on the run
 * rubric, any other on the workout rubric — one block each, and submit_review's schema names both, requiring only the
 * dimensions they share), else submit_review's required ones.
 */
function dimensionsOf(tools, system) {
  const text = (Array.isArray(system) ? system.map((b) => b.text ?? "").join("\n") : String(system ?? "")) || "";
  const from = text.indexOf("Score every dimension");
  const to = text.indexOf("Score by the anchors", from);
  if (from >= 0 && to > from) {
    const ids = [...text.slice(from, to).matchAll(/^- ([a-z_]+) — /gm)].map((m) => m[1]);
    if (ids.length > 0) return ids;
  }
  const t = (tools ?? []).find((x) => x.name === "submit_review");
  return t?.input_schema?.properties?.scores?.required ?? [];
}

const RESTRAINT = JSON.stringify({ briefing: null, proposals: [], question: null, memoryOps: [], focus: null, raceLine: null });

/** The script a harness asked for (`POST /use/<name>`), over the model id's. */
let override = null;
/** The delay a harness asked for (`POST /delay/<ms>`), over the script's own. */
let delayOverride = null;
/** The designer's calls: begun, answered, and hung up on by the caller before the answer. */
let calls = { begun: 0, answered: 0, hungUp: 0 };
/** How many of the next answers stream a little, then go silent (`POST /stall/<n>`). */
let stallNext = 0;

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const use = /^\/use\/(\w*)$/.exec(req.url ?? "");
    if (use) {
      override = use[1] && SCRIPTS[use[1]] ? use[1] : null;
      return json(res, 200, { script: override });
    }
    const delay = /^\/delay\/(\d*)$/.exec(req.url ?? "");
    if (delay) {
      delayOverride = delay[1] ? Number(delay[1]) : null;
      return json(res, 200, { delayMs: delayOverride });
    }
    const stall = /^\/stall\/(\d+)$/.exec(req.url ?? "");
    if (stall) {
      stallNext = Number(stall[1]);
      return json(res, 200, { stallNext });
    }
    if (req.url === "/calls") return json(res, 200, calls);
    if (req.url === "/calls/reset") {
      calls = { begun: 0, answered: 0, hungUp: 0 };
      return json(res, 200, calls);
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
    const answer = (script[role] ?? script.main)(turn, { today: todayOf(request.messages), dimensions: dimensionsOf(request.tools, request.system), role, opening: openingOf(request.messages) });
    calls.begun += 1;
    let done = false;
    const begunAt = Date.now();
    res.on("close", () => {
      if (done) return;
      calls.hungUp += 1;
      console.log(`${new Date().toISOString()} the caller hung up before the answer (${role}, turn ${turn}, after ${Date.now() - begunAt} ms)`);
    });
    if (stallNext > 0) {
      // A stream that begins — the message, a text block, a word — then goes silent: the worker's stall guard must cut
      // it loose (llm-messages.ts). Nothing more is ever sent; the caller hanging up is what ends it.
      stallNext -= 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_stall", type: "message", role: "assistant", content: [], usage: { input_tokens: 1200, output_tokens: 1 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Thinking it over" } });
      return;
    }
    const wait = delayOverride ?? script.delayMs ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (res.destroyed) return;
    done = true;
    calls.answered += 1;
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
