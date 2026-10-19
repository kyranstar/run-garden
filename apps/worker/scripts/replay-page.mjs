#!/usr/bin/env node
/**
 * The voice workshop's comparison page (services/coach-replay.ts): replay results in, one self-contained HTML page out.
 *
 *   node apps/worker/scripts/replay-page.mjs <results.json> [out.html]
 *
 * <results.json> holds what `POST /api/coach/replay` answered: one response, an array of them, or `{ "replays": [...] }`.
 * The page has one section per run (the athlete's words), and in it one block per step replayed: the line as shipped,
 * then each variant as a card labelled by its settings, with its length in characters and what it cost. Calm, light and
 * dark, readable on a phone; no network, no script.
 *
 * Not shipped to the Worker, and never committed with real data: the results are the athlete's own words.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SETTING_WORDS = {
  length: { sentence: "one sentence", few: "two or three sentences", paragraph: "a short paragraph" },
  tone: { plain: "plain", warm: "warm", brisk: "brisk" },
  include: { why: "+ the why", numbers: "+ the numbers", next_step: "+ a next step", none: "nothing extra" },
  person: { you: "to “you”", neutral: "neutral" },
};
const STEP_WORDS = { finish: "The last line", ask: "The question", prose: "The workout's words" };
const SETTING_ORDER = ["length", "tone", "include", "person"];

/** Text as HTML: every character that could open markup, escaped. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const usd = (n) => `$${(Number(n) || 0).toFixed(Number(n) > 0 && Number(n) < 0.01 ? 4 : 3)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The settings in words: "today's voice" for none. */
export function settingsLabel(settings) {
  const parts = SETTING_ORDER.filter((k) => settings && settings[k]).map((k) => SETTING_WORDS[k][settings[k]] ?? `${k}: ${settings[k]}`);
  return parts.length > 0 ? parts : ["today's voice"];
}

/** The replies, however the file holds them. */
export function replaysOf(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.replays) ? data.replays : data && typeof data === "object" ? [data] : [];
  return list.filter((r) => r && typeof r === "object" && typeof r.runId === "string" && Array.isArray(r.variants));
}

/** The words' length the card shows: a line's, a question's, or a workout's intent. */
function lengthOf(words) {
  if (typeof words?.line === "string") return words.line.length;
  if (typeof words?.question === "string") return words.question.length;
  if (typeof words?.prose?.intent === "string") return words.prose.intent.length;
  return null;
}

function wordsHtml(words) {
  const out = [];
  if (typeof words?.line === "string") out.push(`<p class="line">${escapeHtml(words.line)}</p>`);
  if (typeof words?.question === "string") {
    out.push(`<p class="line">${escapeHtml(words.question)}</p>`);
    const choices = Array.isArray(words.choices) ? words.choices : [];
    if (choices.length > 0) out.push(`<ul class="choices">${choices.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`);
  }
  const p = words?.prose;
  if (p && typeof p === "object") {
    const list = (items) => `<ul>${(Array.isArray(items) ? items : []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
    out.push(
      `<dl class="prose"><dt>Title</dt><dd>${escapeHtml(p.title ?? "—")}</dd><dt>Intent</dt><dd>${escapeHtml(p.intent ?? "—")}</dd>` +
        (Array.isArray(p.whys) && p.whys.length > 0 ? `<dt>Whys</dt><dd>${list(p.whys)}</dd>` : "") +
        (Array.isArray(p.cues) && p.cues.length > 0 ? `<dt>Cues</dt><dd>${list(p.cues)}</dd>` : "") +
        `</dl>`,
    );
  }
  if (typeof words?.said === "string") out.push(`<p class="aside"><span class="tag">Beside the call</span> ${escapeHtml(words.said)}</p>`);
  if (Array.isArray(words?.called) && words.called.length > 0) out.push(`<p class="aside"><span class="tag">Called instead</span> ${escapeHtml(words.called.join(", "))}</p>`);
  return out.join("");
}

function variantCard(v, shippedChars) {
  const chips = settingsLabel(v.settings)
    .map((s) => `<span class="chip">${escapeHtml(s)}</span>`)
    .join("");
  let body;
  if (v.skipped) body = `<p class="aside"><span class="tag">Not called</span> ${escapeHtml(v.skipped.why ?? v.skipped.reason)}</p>`;
  else if (v.error) body = `<p class="aside"><span class="tag">The call failed</span> ${escapeHtml(v.error)}</p>`;
  else body = wordsHtml(v) || `<p class="aside">No words came back.</p>`;
  const n = lengthOf(v);
  const ratio = n !== null && shippedChars ? ` · ${Math.round((n / shippedChars) * 100)}% of shipped` : "";
  const facts = [n !== null ? `${n} characters${ratio}` : null, v.skipped ? null : usd(v.costUsd)].filter(Boolean).join(" · ");
  return `<article class="card"><header><span class="id">${escapeHtml(v.id)}</span><span class="chips">${chips}</span></header>${body}<footer>${escapeHtml(facts)}</footer></article>`;
}

function stepBlock(r) {
  const shipped = r.baseline ?? {};
  const shippedChars = lengthOf(shipped);
  const cards = r.variants.map((v) => variantCard(v, shippedChars)).join("");
  const facts = [r.model, `${plural(r.variants.length, "variant")}`, usd(r.costUsd)].filter(Boolean).join(" · ");
  return (
    `<div class="step"><h3>${escapeHtml(STEP_WORDS[r.at] ?? r.at ?? "Replay")}<span class="facts">${escapeHtml(facts)}</span></h3>` +
    `<div class="shipped"><span class="tag">As shipped${shippedChars !== null ? ` · ${shippedChars} characters` : ""}</span>${wordsHtml(shipped) || "<p class=\"aside\">—</p>"}</div>` +
    `<div class="grid">${cards}</div></div>`
  );
}

/** The whole page, self-contained. */
export function buildReplayPage(data, o = {}) {
  const replays = replaysOf(data);
  const runs = new Map();
  for (const r of replays) {
    if (!runs.has(r.runId)) runs.set(r.runId, []);
    runs.get(r.runId).push(r);
  }
  const total = replays.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);
  const variants = replays.reduce((sum, r) => sum + r.variants.length, 0);
  const sections = [...runs.values()]
    .map((list, i) => {
      const words = list.find((r) => typeof r.request === "string")?.request;
      return (
        `<section class="run"><h2><span class="n">${i + 1}</span>${words ? `“${escapeHtml(words)}”` : "<em>No words: a quick tap</em>"}</h2>` +
        list.map(stepBlock).join("") +
        `</section>`
      );
    })
    .join("");
  const title = escapeHtml(o.title ?? "Coach voice replays");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg: #f7f6f2; --surface: #ffffff; --ink: #23251f; --muted: #6a6d63; --line: #e3e1d8;
  --accent: #4f6b4a; --chip: #eef1ea; --shipped: #f1efe6;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 40px;
  --radius: 12px; --text-s: 0.8125rem; --text-m: 1rem; --text-l: 1.25rem;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161814; --surface: #1f221d; --ink: #e8e9e3; --muted: #a0a497; --line: #33372f; --accent: #9dbb95; --chip: #2a3027; --shipped: #262a23; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: var(--text-m)/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 76rem; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-6); }
h1 { font-size: var(--text-l); margin: 0 0 var(--space-1); }
.meta, .facts, footer, .tag { color: var(--muted); font-size: var(--text-s); font-weight: 400; }
.run { margin-top: var(--space-6); }
.run h2 { font-size: var(--text-l); font-weight: 600; margin: 0 0 var(--space-3); display: flex; gap: var(--space-3); align-items: baseline; overflow-wrap: anywhere; }
.n { color: var(--accent); font-variant-numeric: tabular-nums; }
.step { margin-top: var(--space-4); }
.step h3 { font-size: var(--text-m); margin: 0 0 var(--space-2); display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: baseline; }
.shipped { background: var(--shipped); border-radius: var(--radius); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); }
.grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr)); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.card header { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.id { font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip { background: var(--chip); color: var(--ink); border-radius: 999px; padding: 2px var(--space-2); font-size: var(--text-s); }
.card footer { margin-top: auto; }
.line { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.aside { margin: 0; color: var(--muted); font-size: var(--text-s); overflow-wrap: anywhere; }
.tag { display: inline-block; margin-right: var(--space-1); }
.shipped .tag { display: block; margin-bottom: var(--space-1); }
.choices { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-1); }
.choices li { border: 1px solid var(--line); border-radius: 999px; padding: 2px var(--space-2); font-size: var(--text-s); }
.prose { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); }
.prose dt { color: var(--muted); font-size: var(--text-s); }
.prose dd { margin: 0; overflow-wrap: anywhere; }
.prose ul { margin: 0; padding-left: 1.1em; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">${escapeHtml(`${plural(runs.size, "run")} · ${plural(variants, "variant")} · ${usd(total)}`)}</p>
${sections || '<p class="meta">No replays in the file.</p>'}
</main>
</body>
</html>
`;
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node apps/worker/scripts/replay-page.mjs <results.json> [out.html]");
    process.exit(2);
  }
  const out = output ?? input.replace(/\.json$/i, "") + ".html";
  writeFileSync(out, buildReplayPage(JSON.parse(readFileSync(input, "utf8"))));
  console.log(`wrote ${out}`);
}
