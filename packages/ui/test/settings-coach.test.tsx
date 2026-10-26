/**
 * SETTINGS → COACH AND MEMORY V2 (Stage 3 Task 10), as rendered (renderToStaticMarkup; node, no DOM):
 *
 *  - Each memory item says its kind (Fact, Rule, Note (until <date>), Something the coach noticed), how sure it is
 *    (You said, The coach inferred, Confirmed) and where it came from in a few words — never an id; pinned items say
 *    so in words and come first; Confirm only for the coach's inference; the versions an item replaced sit one tap
 *    down, collapsed.
 *  - Settings → Coach: the default scope pressed, N, the times, the limits, the model in plain words, the week's spend;
 *    a limit typed past its default is refused in plain words. Hidden without the coach designer.
 *
 * Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { CoachMemoryItem, CoachPreferencesDto } from "@rg/api-client";
import { coachSettings } from "@rg/domain";
import { features } from "../src/features.js";
import {
  confidenceWords,
  groupItems,
  historyOf,
  HISTORY_MAX,
  kindWords,
  metaLine,
  provenanceWords,
} from "../src/screens/settings/coach-memory-model.js";
import { MemoryItem, MemoryList } from "../src/screens/settings/coach-memory.js";
import { CoachAiSection, CoachLimits, readLimit, spendLine, spendOf, TrainingTimes, TrainingTimesView } from "../src/screens/settings/coach-settings.js";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";

const coachPrefsFixture = DEFAULT_USER_PREFERENCES;

const noop = () => undefined;
const item = (over: Partial<CoachMemoryItem> = {}): CoachMemoryItem => ({
  id: "mem:run-SECRET-ID:toolu_SECRET",
  kind: "fact",
  body: "Trains in a garage",
  provenance: { source: "message", at: "2026-10-03T09:00:00.000Z" },
  learnedAt: "2026-10-03T09:00:00.000Z",
  expiresAt: null,
  pinned: false,
  confidence: "stated",
  supersededBy: null,
  ...over,
});

const html = (el: React.ReactElement): string => renderToStaticMarkup(el);
const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function itemMarkup(m: CoachMemoryItem, history: CoachMemoryItem[] = []): string {
  return html(
    createElement(MemoryItem, {
      item: m,
      history,
      editing: false,
      draft: "",
      onDraft: noop,
      onSave: noop,
      onCancel: noop,
      onEdit: noop,
      onDelete: noop,
      onPin: noop,
      onConfirm: noop,
    }),
  );
}

describe("each item, in plain words", () => {
  it("its kind", () => {
    expect(kindWords(item({ kind: "fact" }))).toBe("Fact");
    expect(kindWords(item({ kind: "rule" }))).toBe("Rule");
    expect(kindWords(item({ kind: "note", expiresAt: "2026-10-26" }))).toBe("Note (until Oct 26)");
    expect(kindWords(item({ kind: "observation" }))).toBe("Something the coach noticed");
  });

  it("how sure it is — an item from before memory v2 is what the athlete said", () => {
    expect(confidenceWords(item({ confidence: "stated" }))).toBe("You said");
    expect(confidenceWords(item({ confidence: "inferred" }))).toBe("The coach inferred");
    expect(confidenceWords(item({ confidence: "confirmed" }))).toBe("Confirmed");
    expect(confidenceWords(item({ confidence: undefined }))).toBe("You said");
  });

  it("where it came from, in a few words and when — never an id", () => {
    const from = (source: string, extra: Record<string, string> = {}) =>
      provenanceWords(item({ provenance: { source, at: "2026-10-03T09:00:00.000Z", ...extra } }));
    expect(from("message", { messageId: "msg-SECRET" })).toBe("From your message, Oct 3");
    expect(from("question")).toBe("From your answer to a question, Oct 3");
    expect(from("manual")).toBe("From a check-in, Oct 3");
    expect(from("open")).toBe("From your recent training, Oct 3");
    expect(from("athlete_words", { runId: "run-SECRET" })).toBe("From your request to the coach, Oct 3");
    // "Request", never the coach's "run" (fix wave 3B, B-I12).
    expect(from("coach_inference", { runId: "run-SECRET" })).toBe("From a coach request, Oct 3");
    expect(from("studio_brief", { planId: "plan-SECRET" })).toBe("From the old Studio's brief, Oct 3");
    // An insight a saved post gave (saved-posts import, spec §17): neither the post's id nor its link.
    expect(from("saved post", { postId: "post-SECRET", url: "https://example.com/p/SECRET" })).toBe("From a saved post, Oct 3");
    expect(from("weekly")).toBe("From the coach, Oct 3");
  });

  it("rendered: the words, the line under them, the actions; no id anywhere", () => {
    const pinned = itemMarkup(item({ pinned: true, kind: "rule", confidence: "confirmed", provenance: { source: "coach_inference", runId: "run-SECRET-ID", at: "2026-10-03T09:00:00.000Z" } }));
    expect(text(pinned)).toContain("Trains in a garage");
    expect(text(pinned)).toContain("Rule · Confirmed · From a coach request, Oct 3 · Pinned");
    expect(pinned).toMatch(/aria-pressed="true"[^>]*>Unpin</);
    expect(pinned).not.toMatch(/>Confirm</);
    expect(pinned).not.toContain("SECRET");
    const inferred = itemMarkup(item({ kind: "observation", confidence: "inferred" }));
    expect(text(inferred)).toContain("Something the coach noticed · The coach inferred · From your message, Oct 3");
    expect(inferred).toMatch(/>Confirm</);
    expect(inferred).toMatch(/aria-pressed="false"[^>]*>Pin</);
    expect(inferred).toMatch(/>Edit</);
    expect(inferred).toMatch(/>Delete</);
    expect(metaLine(item({ kind: "note", expiresAt: "2026-10-26" }))).toBe("Note (until Oct 26) · You said · From your message, Oct 3");
  });

  it("the versions it replaced: one tap down, collapsed, newest first", () => {
    const live = item({ id: "live", body: "Evenings now" });
    const history = [
      item({ id: "older", body: "Mornings", supersededBy: "mid", learnedAt: "2026-09-01T09:00:00.000Z" }),
      item({ id: "mid", body: "Lunchtimes", supersededBy: "live", learnedAt: "2026-09-15T09:00:00.000Z" }),
      item({ id: "other", body: "Someone else's", supersededBy: "elsewhere" }),
    ];
    const versions = historyOf("live", history);
    expect(versions.map((h) => h.body)).toEqual(["Lunchtimes", "Mornings"]);
    const markup = itemMarkup(live, versions);
    expect(markup).toMatch(/<details class="memory-history"><summary[^>]*>Earlier versions \(2\)<\/summary>/);
    expect(markup).not.toMatch(/<details[^>]*open/);
    expect(text(markup)).toContain("Lunchtimes · You said, Sep 15");
    expect(markup.indexOf("Lunchtimes")).toBeLessThan(markup.indexOf("Mornings"));
    // No history: no disclosure.
    expect(itemMarkup(live)).not.toContain("<details");
  });

  it("a loop in stored history never runs away", () => {
    const loop = [item({ id: "a", supersededBy: "b" }), item({ id: "b", supersededBy: "a" })];
    expect(historyOf("a", loop).map((h) => h.id)).toEqual(["b"]);
    const long = Array.from({ length: 40 }, (_, i) => item({ id: `v${i}`, supersededBy: i === 0 ? "live" : `v${i - 1}` }));
    expect(historyOf("live", long)).toHaveLength(HISTORY_MAX);
  });

  it("the list: four groups, what the coach noticed among them, pinned items first", () => {
    const memory = [
      item({ id: "f1", body: "Older fact", learnedAt: "2026-09-01T09:00:00.000Z" }),
      item({ id: "f2", body: "Pinned fact", pinned: true, learnedAt: "2026-08-01T09:00:00.000Z" }),
      item({ id: "o1", kind: "observation", body: "Squats go better after activation", confidence: "inferred" }),
    ];
    expect(groupItems(memory, "fact").map((m) => m.id)).toEqual(["f2", "f1"]);
    const markup = html(createElement(MemoryList, { memory, history: [], render: (m) => m.body }));
    expect(text(markup)).toBe("About you Pinned fact Older fact Things the coach noticed Squats go better after activation");
  });
});

// ── Settings → Coach ─────────────────────────────────────────────────────────

const dto = (coach: CoachPreferencesDto["coach"] = {}): CoachPreferencesDto => ({
  coach,
  settings: coachSettings(coach),
  model: { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
});

function view(d: CoachPreferencesDto): string {
  return html(createElement(CoachLimits, { data: d, onSave: noop }));
}

const times = (d: CoachPreferencesDto): string => html(createElement(TrainingTimesView, { data: d, onSave: noop }));

const coachSpend = (usd: number) => ({ since: "2026-10-09T00:00:00.000Z", spentMicros: Math.round(usd * 1e6), spentUsd: usd, warnMicros: 5_000_000, cutoffMicros: 20_000_000 });

describe("Settings → Coach & AI (the new shape: no time frame up front, one spend line)", () => {
  const was = { coach: features.coach, studio: features.studio };
  afterEach(() => Object.assign(features, was));

  it("the defaults: the full limits for one request and the model — no 'Start with', no 'Next workouts'", () => {
    const markup = view(dto());
    expect(markup).toContain('value="1.50"');
    expect(markup).toContain('value="6.00"');
    expect(markup).toMatch(/max="1.5"/);
    expect(markup).toMatch(/max="6"/);
    expect(text(markup)).toContain("Model Claude Opus 5.5");
    expect(markup).not.toContain("anthropic/");
    expect(text(markup)).not.toMatch(/Start with|Next workouts|Later today|Next 7 days/);
  });

  it("the words: a request, never a run; one workout, or a plan of several", () => {
    const words = text(view(dto()));
    expect(words).toContain("Spending limit for one request");
    expect(words).toContain("One workout");
    expect(words).toContain("A plan of several");
    expect(words).not.toMatch(/\brun\b/);
  });

  it("one spend line: the week's spend, past the warning that the coach keeps going, at the cutoff that it waits (M4)", () => {
    const line = (usd: number) => spendLine(spendOf(coachSpend(usd), null)!);
    expect(line(3.2)).toBe("AI this week: $3.20 of $20.00");
    expect(line(5.07)).toBe("AI this week: $5.07 of $20.00 — past $5, the coach keeps going until $20.");
    expect(line(5)).toBe("AI this week: $5.00 of $20.00");
    expect(line(20)).toBe("AI this week: $20.00 of $20.00 — paused until the week clears.");
    // Without the coach's own count, the settings' answer for the same week.
    expect(spendLine(spendOf(null, { spentDollars: 1.2, cutoffDollars: 20, warn: false, cutoff: false })!)).toBe("AI this week: $1.20 of $20.00");
    expect(spendOf(null, null)).toBeNull();
  });

  it("what the athlete set: a lowered limit; the coach's training times, in order, with room for three", () => {
    const d = dto({ trainingTimes: ["18:30", "07:00"], ceilingsUsd: { day: 1 } });
    expect(view(d)).toContain('value="1.00"');
    const markup = times(d);
    expect(markup.indexOf('value="07:00"')).toBeLessThan(markup.indexOf('value="18:30"'));
    expect(text(times(dto()))).toContain("None set.");
    // Three times: no room for another.
    expect(times(dto({ trainingTimes: ["07:00", "12:00", "18:00"] }))).not.toContain("Add a time");
  });

  it("a limit typed past its default is refused in plain words; lower is fine", () => {
    expect(readLimit("day", "1.51")).toEqual({ why: "At most $1.50." });
    expect(readLimit("set", "$7")).toEqual({ why: "At most $6.00." });
    expect(readLimit("day", "0.10")).toEqual({ why: "At least $0.25." });
    expect(readLimit("day", "lots")).toEqual({ why: "A dollar amount, like 1.25." });
    expect(readLimit("day", "")).toEqual({ why: "A dollar amount, like 1.25." });
    expect(readLimit("day", "1.25")).toEqual({ usd: 1.25 });
    expect(readLimit("set", "$4.5")).toEqual({ usd: 4.5 });
  });

  it("without the coach designer the card keeps its AI switch and spend, and reads none of the coach's settings", () => {
    features.coach = false;
    const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const markup = html(createElement(QueryClientProvider, { client: qc }, createElement(CoachAiSection, { prefs: coachPrefsFixture })));
    expect(markup).toContain('role="switch"');
    expect(text(markup)).not.toContain("Spending limit");
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey[0])).not.toContain("coach-preferences");
  });

  it("the training times are hidden without the coach designer: nothing rendered, nothing read", () => {
    features.coach = false;
    features.studio = true;
    const qc = new QueryClient();
    expect(html(createElement(QueryClientProvider, { client: qc }, createElement(TrainingTimes)))).toBe("");
    features.coach = true;
    features.studio = false;
    expect(html(createElement(QueryClientProvider, { client: qc }, createElement(TrainingTimes)))).toBe("");
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});
