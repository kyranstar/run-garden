/**
 * The voice workshop's comparison page (scripts/replay-page.mjs): replay results in, one self-contained page out — one
 * section per run, the line as shipped, each variant a card labelled by its settings with its length. The coach's words
 * and the athlete's are text, never markup. Synthetic replies only.
 */
import { describe, expect, it } from "vitest";
import { buildReplayPage, escapeHtml, replaysOf, settingsLabel } from "../scripts/replay-page.mjs";

const finishReply = {
  runId: "run-a",
  at: "finish",
  request: "Something calm for the hips?",
  model: "anthropic/claude-opus-5.5",
  baseline: { line: "A calm session for your hips, glutes first.", chars: 43 },
  variants: [
    { id: "today", settings: {}, line: "Hips, gently: glutes first.", chars: 27, costUsd: 0.16 },
    { id: "warm-short", settings: { length: "sentence", tone: "warm", include: "next_step", person: "you" }, line: "You'll feel looser after this.", chars: 30, said: "Keeping it light.", costUsd: 0.012 },
    { id: "late", settings: { tone: "brisk" }, costUsd: 0, skipped: { reason: "request_cap", why: "This replay reached its own spending limit." } },
    { id: "broke", settings: { tone: "plain" }, costUsd: 0, error: "retryable" },
  ],
  costUsd: 0.172,
};
const askReply = {
  runId: "run-a",
  at: "ask",
  request: "Something calm for the hips?",
  baseline: { question: "How long do you have?", choices: ["20 minutes", "40 minutes"] },
  variants: [{ id: "q", settings: { tone: "brisk" }, question: "Time?", choices: ["15", "30"], costUsd: 0.02 }],
  costUsd: 0.02,
};
const proseReply = {
  runId: "run-b",
  at: "prose",
  request: null,
  baseline: { prose: { title: "Calm hips", intent: "Wake the glutes.", whys: [], cues: [] } },
  variants: [{ id: "p", settings: { person: "neutral" }, prose: { title: "Easy hips", intent: "Glutes, then the hinge.", whys: ["Activation first."], cues: ["Slow down."] }, costUsd: 0.1 }],
  costUsd: 0.1,
};

describe("the comparison page", () => {
  it("has one section per run, the shipped words, and every variant as a card labelled by its settings with its length", () => {
    const page = buildReplayPage([finishReply, askReply, proseReply]);
    expect(page.match(/<section class="run">/g)).toHaveLength(2);
    expect(page).toContain("“Something calm for the hips?”");
    expect(page).toContain("No words: a quick tap");
    expect(page).toContain("As shipped · 43 characters");
    expect(page).toContain("A calm session for your hips, glutes first.");
    // Labels: today's voice for none, each setting in words.
    for (const label of ["today&#39;s voice", "one sentence", "warm", "+ a next step", "to “you”", "brisk", "neutral"]) expect(page).toContain(label);
    expect(page).toContain("27 characters · 63% of shipped");
    expect(page).toContain("Keeping it light.");
    expect(page).toContain("This replay reached its own spending limit.");
    expect(page).toContain("The call failed");
    // The question's chips and the workout's words.
    expect(page).toContain("<li>20 minutes</li>");
    expect(page).toContain("Glutes, then the hinge.");
    expect(page).toContain("Activation first.");
    expect(page).toContain("2 runs · 6 variants · $0.292");
  });

  it("is text, never markup: the coach's and the athlete's words are escaped", () => {
    const hostile = {
      ...finishReply,
      request: '<img src=x onerror="alert(1)">',
      baseline: { line: "</p><script>alert(1)</script>" },
      variants: [{ id: "x", settings: { tone: "<b>" }, line: "a & b's \"c\"", costUsd: 0 }],
    };
    const page = buildReplayPage(hostile);
    expect(page).not.toMatch(/<script|<img|<b>/);
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(page).toContain("a &amp; b&#39;s &quot;c&quot;");
    expect(escapeHtml("<&>\"'")).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("stands alone — no script, no link, no network — in light and dark, readable on a phone", () => {
    const page = buildReplayPage(finishReply);
    expect(page).not.toMatch(/<script|<link|https?:\/\//);
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain("@media (prefers-color-scheme: dark)");
    expect(page).toMatch(/body \{[^}]*background: var\(--bg\)/);
  });

  it("reads one reply, a list of them, or { replays }; anything else is no replay", () => {
    expect(replaysOf(finishReply)).toHaveLength(1);
    expect(replaysOf([finishReply, askReply])).toHaveLength(2);
    expect(replaysOf({ replays: [proseReply] })).toHaveLength(1);
    expect(replaysOf({ error: "not_found" })).toHaveLength(0);
    expect(replaysOf(null)).toHaveLength(0);
    expect(buildReplayPage([])).toContain("No replays in the file.");
    expect(settingsLabel({})).toEqual(["today's voice"]);
  });
});
