/**
 * The robustness pass (2026-10-16) — the coach's answers read tolerantly (coach-tolerance.ts) and the run model's
 * decisions on what a newer server or a cut-off answer may send:
 *
 *  - a run, its events, a step's answer, the current read and a suggestion's read each come out with every field the
 *    screens read, whatever came: a missing list empty, a text that isn't one empty, a number that isn't one none;
 *  - an unknown status, event kind, op kind or outcome passes as its own word: shown plainly, never a failure line,
 *    never stepped;
 *  - an event with no seq is dropped; one with no summary isn't a line;
 *  - a day or a time that can't be read is left out of what the card says, never "undefined".
 *
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESIGN_MODEL_DEADLINE_MS, type CoachRunEventDto } from "@rg/api-client";
import { toCurrent, toEvents, toProposal, toRun, toRunRead, toStepResult } from "../src/screens/studio/coach-tolerance.js";
import {
  dayAndTime,
  failureOf,
  isLive,
  isSlow,
  isSteppable,
  mergeEvents,
  planDayHref,
  runLines,
  statusWord,
  usd,
} from "../src/screens/studio/run-model.js";

const ev = (seq: number, summary = `Line ${seq}`): CoachRunEventDto => ({ seq, kind: "note", summary, payload: null, at: "2026-10-16T08:00:00.000Z" });

describe("a run, read tolerantly", () => {
  it("a whole run passes as it is", () => {
    const run = {
      id: "run-1",
      role: "main",
      scope: { kind: "next_n", n: 3 },
      request: "hips",
      status: "active",
      steps: 2,
      costUsd: 0.12,
      proposalId: "dp-1",
      error: null,
      createdAt: "2026-10-16T08:00:00.000Z",
      updatedAt: "2026-10-16T08:01:00.000Z",
      finishedAt: null,
      estimateUsd: 4.2,
      ceilingUsd: 6,
    };
    expect(toRun(run)).toEqual(run);
  });

  it("a run missing its fields, or with the wrong kinds of them, has every field the screens read", () => {
    const run = toRun({ id: "run-1", status: "thinking_hard", scope: null, request: { text: "an object" }, costUsd: "lots", steps: null });
    expect(run).toMatchObject({
      id: "run-1",
      role: "main",
      scope: { kind: "now" },
      request: null,
      status: "thinking_hard",
      steps: 0,
      costUsd: 0,
      proposalId: null,
      error: null,
      estimateUsd: null,
      ceilingUsd: null,
    });
    expect(toRun(null)).toMatchObject({ id: "", status: "active", costUsd: 0 });
  });

  it("events: kept with any kind and payload; one with no seq dropped; a summary that isn't text empty", () => {
    const events = toEvents([
      { seq: 1, kind: "plan_v2", summary: "Something new", payload: { weird: [1] }, at: "x" },
      { kind: "note", summary: "no seq" },
      { seq: 2, kind: "note", summary: null },
      "not an event",
      { seq: "3", kind: "note", summary: "a seq that is text" },
    ]);
    expect(events).toEqual([
      { seq: 1, kind: "plan_v2", summary: "Something new", payload: { weird: [1] }, at: "x" },
      { seq: 2, kind: "note", summary: "", payload: null, at: "" },
    ]);
    expect(toEvents(undefined)).toEqual([]);
    expect(toEvents({ not: "a list" })).toEqual([]);
  });

  it("a step's answer: no events is none, an unreadable nextDue is none", () => {
    expect(toStepResult({ status: "active", nextDue: { runId: "r", role: "main", at: "2026-10-16T08:00:00.000Z" } })).toEqual({
      status: "active",
      nextDue: { runId: "r", role: "main", at: "2026-10-16T08:00:00.000Z" },
      events: [],
    });
    expect(toStepResult({ status: "active", nextDue: { at: "not a date" }, events: [ev(1)] })).toEqual({ status: "active", nextDue: null, events: [ev(1)] });
    expect(toStepResult(null)).toEqual({ status: "active", nextDue: null, events: [] });
  });

  it("a run's read and the current read", () => {
    expect(toRunRead({ run: { id: "r", status: "finished" } }).events).toEqual([]);
    expect(toCurrent({ run: null })).toEqual({ run: null });
    expect(toCurrent({ run: { status: "active" } })).toEqual({ run: null });
    expect(toCurrent(undefined)).toEqual({ run: null });
    const c = toCurrent({ run: { id: "r", status: "active" }, proposal: { id: "dp-1", status: "pending", flags: ["kept", 3] } });
    expect(c.run?.id).toBe("r");
    expect(c).toMatchObject({ events: [], proposal: { id: "dp-1", status: "pending", flags: ["kept"] } });
    expect(toCurrent({ run: { id: "r" }, proposal: { status: "pending" } })).toMatchObject({ proposal: null });
  });
});

describe("a suggestion, read tolerantly", () => {
  it("a line missing its lists, with an unknown outcome, and a change of an unknown kind each have what the card reads", () => {
    const p = toProposal({
      id: "dp-1",
      status: "pending",
      lines: [
        { opId: "op-1", title: "Hips", date: "2026-10-16", time: "10:00", minutes: 20, reviewMean: undefined, outcome: { status: "teleported" }, review: { dimensions: [{ id: "intent" }] } },
        { title: "no op id" },
      ],
      changes: [{ opId: "ch-1", kind: "swap_v2", why: 5, outcome: { status: "declined", reason: 7 } }],
    });
    const line = p.lines![0]!;
    expect(p.lines).toHaveLength(1);
    expect(line).toMatchObject({ opId: "op-1", parts: [], detail: [], issues: [], reviewMean: null, written: null, effort: "", place: "" });
    expect(line.outcome).toMatchObject({ status: "teleported" });
    expect(line.review).toMatchObject({ dimensions: [{ id: "intent", label: "intent", score: null, note: null }], mustFix: [], improvements: [], changes: [], accepted: [] });
    const change = p.changes![0]!;
    expect(change).toMatchObject({ opId: "ch-1", kind: "swap_v2", why: "", issues: [], summary: "A change to your plan", date: null });
    expect(change.outcome).toMatchObject({ status: "declined", reason: undefined });
  });

  it("an outcome's texts are texts: a refusal's why, an applied change's session as it stood", () => {
    const p = toProposal({
      id: "dp-1",
      status: "pending",
      lines: [{ opId: "op-1", outcome: { status: "refused", error: null } }],
      changes: [{ opId: "ch-1", kind: "skip", outcome: { status: "applied", before: { date: 5 } } }],
    });
    expect(p.lines![0]!.outcome).toMatchObject({ status: "refused", error: "", why: "" });
    expect(p.changes![0]!.outcome).toMatchObject({ status: "applied", workoutId: "", before: { date: "", time: "", title: "", minutes: null } });
  });

  it("no lists at all: none (the thread coach's proposals carry none)", () => {
    expect(toProposal({ id: "p", status: "pending", resolvedAt: null })).toEqual({ id: "p", status: "pending", resolvedAt: null });
    expect(toProposal({ id: "p", status: "pending", lines: "not a list" })).toMatchObject({ lines: [] });
  });

  it("an applied line's plan figures fall back to the line's own where the server left them out", () => {
    const p = toProposal({ id: "p", status: "approved", lines: [{ opId: "op-1", date: "2026-10-16", minutes: 25, written: { time: "10:00" } }] });
    expect(p.lines![0]!.written).toMatchObject({ date: "2026-10-16", time: "10:00", minutes: 25 });
  });
});

describe("the run model, on what it has never seen", () => {
  it("an unknown status: its own words in the header, not live, never stepped, never a failure", () => {
    expect(statusWord({ status: "thinking_hard" as never, error: null, scope: { kind: "now" } })).toBe("thinking hard");
    expect(isLive("thinking_hard" as never)).toBe(false);
    expect(isSteppable("thinking_hard" as never)).toBe(false);
    expect(failureOf({ status: "thinking_hard" as never, error: null })).toBeNull();
    // The statuses it knows keep their words and their failures.
    expect(failureOf({ status: "failed", error: "retries" })?.what).toBe("The AI service didn't answer.");
    expect(failureOf({ status: "stopped_cap", error: "some_new_code" })?.what).toBe("The AI service refused the request.");
  });

  it("a spend that isn't a number is nothing spent", () => {
    expect(usd(Number.NaN)).toBe("$0.00");
    expect(usd(undefined as never)).toBe("$0.00");
    expect(usd(0.125)).toBe("$0.13");
  });

  it("events merged from an answer without them: nothing merged, nothing thrown", () => {
    const have = [ev(1)];
    expect(mergeEvents(have, undefined)).toBe(have);
    expect(mergeEvents(have, null)).toBe(have);
    expect(mergeEvents(have, "x" as never)).toBe(have);
  });

  it("an event with no summary is no line; a result with none keeps its call's", () => {
    const call = { seq: 1, kind: "tool_call", summary: "Reading today", payload: { tool: "read_day" }, at: "" } as CoachRunEventDto;
    const result = { seq: 2, kind: "tool_result", summary: "", payload: { tool: "read_day", ok: true }, at: "" } as CoachRunEventDto;
    expect(runLines([call, result, ev(3, ""), ev(4, "Done")]).map((l) => l.summary)).toEqual(["Reading today", "Done"]);
  });

  it("a day or a time that can't be read is left out, never 'undefined'", () => {
    expect(dayAndTime("2026-10-16", "10:00")).toBe("Fri 10 AM");
    expect(dayAndTime("2026-10-16", null)).toBe("Fri");
    expect(dayAndTime("", "10:00")).toBe("10 AM");
    expect(dayAndTime("", "")).toBe("");
    expect(dayAndTime("2026-10-16", "soon")).toBe("Fri");
    expect(planDayHref("w 1", "2026-10-16")).toBe("/plan?week=2026-10-12&workout=w%201");
    expect(planDayHref("w1", "")).toBe("/plan?workout=w1");
  });

  it("the model's deadline the view waits out is the worker's own (TIMEOUT_MS in llm-messages.ts)", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/worker/src/services/llm-messages.ts"), "utf8");
    const expr = /\nconst TIMEOUT_MS = ([\d_ *]+);/.exec(source)?.[1];
    expect(expr, "the worker's constant, a product of numbers").toBeDefined();
    const ms = expr!.split("*").reduce((n, part) => n * Number(part.trim().replace(/_/g, "")), 1);
    expect(ms).toBe(DESIGN_MODEL_DEADLINE_MS);
  });

  it("taking longer than usual: past the model's own deadline, and only while a step is at work", () => {
    const t0 = Date.parse("2026-10-16T08:00:00.000Z");
    expect(isSlow(t0, t0 + DESIGN_MODEL_DEADLINE_MS, DESIGN_MODEL_DEADLINE_MS)).toBe(false);
    expect(isSlow(t0, t0 + DESIGN_MODEL_DEADLINE_MS + 1, DESIGN_MODEL_DEADLINE_MS)).toBe(true);
    expect(isSlow(null, t0 + 60 * DESIGN_MODEL_DEADLINE_MS, DESIGN_MODEL_DEADLINE_MS)).toBe(false);
  });
});
