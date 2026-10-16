/**
 * Stage 3 Task 9 — the coach's run, pure (run-model.ts): the header's words, the trail's lines and their detail, the
 * loop's decisions, what stopped a run, ways to train now, and the plan's refusals in plain words. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { ApiError, type CoachRunDto, type CoachRunEventDto, type TodayResponse } from "@rg/api-client";
import {
  askedOf,
  backoffMs,
  DETAIL_VALUE_MAX,
  detailOf,
  estimateLine,
  failureOf,
  fallbackTiles,
  isSteppable,
  lastSeq,
  MAX_DUE_WAIT_MS,
  mergeEvents,
  mondayOf,
  planDayHref,
  refusalWords,
  refusedLine,
  runLines,
  statusWord,
  stepDelay,
  stepErrorKind,
  tileKindWord,
  usd,
} from "../src/screens/studio/run-model.js";

const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({
  seq,
  kind,
  summary,
  payload,
  at: `2026-10-14T08:00:${String(seq).padStart(2, "0")}.000Z`,
});

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "active",
  steps: 1,
  costUsd: 0.21,
  proposalId: null,
  error: null,
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z",
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});

describe("the header's word", () => {
  it("says what the coach is doing in plain words, never a status's name", () => {
    expect(statusWord(run({ status: "active" }))).toBe("designing");
    expect(statusWord(run({ status: "stepping" }))).toBe("designing");
    expect(statusWord(run({ status: "active" }), "reviewer")).toBe("reviewing");
    expect(statusWord(run({ status: "active", scope: { kind: "week" } }), "main")).toBe("planning the set");
    expect(statusWord(run({ status: "active", scope: { kind: "week" } }), "designer")).toBe("designing");
    expect(statusWord(run({ status: "waiting_athlete" }))).toBe("waiting for you");
    expect(statusWord(run({ status: "waiting_review" }))).toBe("reviewing");
    expect(statusWord(run({ status: "waiting_set" }))).toBe("planning the set");
    expect(statusWord(run({ status: "finished" }))).toBe("done");
    expect(statusWord(run({ status: "failed", error: "gateway_402" }))).toBe("stopped");
    expect(statusWord(run({ status: "stopped_cap", error: "run_ceiling" }))).toBe("ran out of budget");
    expect(statusWord(run({ status: "stopped_cap", error: "weekly_cap" }))).toBe("ran out of budget");
    expect(statusWord(run({ status: "stopped_cap", error: "step_cap" }))).toBe("stopped");
    expect(statusWord(run({ status: "expired" }))).toBe("expired");
    expect(statusWord(run({ status: "cancelled" }))).toBe("cancelled");
  });

  it("money has two decimals; a set's estimate stands beside its limit", () => {
    expect(usd(0.2)).toBe("$0.20");
    expect(usd(4.234567)).toBe("$4.23");
    expect(usd(6)).toBe("$6.00");
    expect(estimateLine(run({ estimateUsd: 4.234567, ceilingUsd: 6 }))).toBe("About $4.23; the limit is $6.00");
    expect(estimateLine(run({ estimateUsd: null }))).toBeNull();
  });
});

describe("the trail", () => {
  it("one line an event; a tool's call and the result that answers it share one line, the result's summary", () => {
    const lines = runLines([
      ev(1, "note", "Read the request and what the coach needs to start."),
      ev(2, "tool_call", "Reading the plan…", { tool: "read_plan", input: { from: "2026-10-14" } }),
      ev(3, "tool_result", "Read the plan — 3 sessions this week", { tool: "read_plan", ok: true, provenance: { source: "the plan" } }),
      ev(4, "tool_result", "Couldn't use search library: no moves matched", { tool: "search_library", ok: false, error: "no_match" }),
      ev(5, "error", "The AI service didn't answer — trying again shortly."),
    ]);
    expect(lines.map((l) => [l.summary, l.glyph])).toEqual([
      ["Read the request and what the coach needs to start.", "done"],
      ["Read the plan — 3 sessions this week", "done"],
      ["Couldn't use search library: no moves matched", "error"],
      ["The AI service didn't answer — trying again shortly.", "error"],
    ]);
    expect(lines[1]!.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("a sub-run's call pairs with its own result, never another run's", () => {
    const by = (runId: string) => ({ runId, role: "designer" });
    const lines = runLines([
      ev(1, "tool_call", "a", { tool: "read_day", by: by("d1") }),
      ev(2, "tool_result", "b", { tool: "read_day", by: by("d2"), ok: true }),
      ev(3, "tool_result", "c", { tool: "read_day", by: by("d1"), ok: true }),
    ]);
    expect(lines.map((l) => l.summary)).toEqual(["c", "b"]);
  });

  it("a kept answer's line carries its undo handle", () => {
    const [line] = runLines([ev(7, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "run-1:toolu_9" } } })]);
    expect(line!.undo).toBe("run-1:toolu_9");
    expect(runLines([ev(8, "note", "You skipped the question.")])[0]!.undo).toBeNull();
  });

  it("merges a step's events and a poll's by seq — in order, never one twice", () => {
    const a = [ev(1, "note", "one"), ev(2, "note", "two")];
    const merged = mergeEvents(a, [ev(2, "note", "two"), ev(4, "note", "four"), ev(3, "note", "three")]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeEvents(merged, [ev(1, "note", "one")]).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(lastSeq(merged)).toBe(4);
    expect(lastSeq([])).toBe(0);
  });

  it("a line's detail is a short key: value list — what was asked, what came back — never raw JSON, cut to size", () => {
    const long = "x".repeat(500);
    const [line] = runLines([
      ev(1, "tool_result", "Searched the library", {
        tool: "search_library",
        input: { query: "single-leg", filters: { part: "main", region: "hips" }, limit: 14 },
        ok: true,
        provenance: { source: "the exercise library", asOf: "2026-10-14" },
        missing: ["equipment"],
        receipt: { matched: 14, note: long, moves: [{ id: "a", name: "Split squat" }, { id: "b", name: "Step-up" }] },
      }),
    ]);
    const sections = detailOf(line!);
    expect(sections.map((s) => s.title)).toEqual(["Asked for", "Came back"]);
    expect(sections[0]!.rows).toEqual([
      { key: "Searched for", value: "single-leg" },
      { key: "Filters", value: "part main · region hips" },
      { key: "Limit", value: "14" },
    ]);
    const back = Object.fromEntries(sections[1]!.rows.map((r) => [r.key, r.value]));
    expect(back["Read from"]).toBe("the exercise library");
    expect(back.Missing).toBe("equipment");
    expect(back.Moves).toBe("Split squat, Step-up");
    expect(back.Note!.length).toBe(DETAIL_VALUE_MAX);
    expect(back.Note!.endsWith("…")).toBe(true);
    for (const s of sections) for (const r of s.rows) expect(r.value).not.toMatch(/[{}"]/);
  });

  it("one tap down holds no internal words: no ids, revisions or kinds; where it read from, in the athlete's words", () => {
    const [line] = runLines([
      ev(1, "draft", "Draft — “Hips”: 20 min — sent for review", {
        tool: "propose_workout",
        input: { doc: { title: "Hips" }, target: { kind: "new", date: "2026-10-16" }, changeNote: "Gentler warm-up." },
        receipt: { proposalId: "dp-1", opId: "run-d1", workoutId: "w-9", baseRev: 2, reviewRunId: "rv-1", round: 1, id: "x" },
        provenance: { source: "the exercise library, today's condition checks and the athlete's logged sets and exercise preferences" },
      }),
    ]);
    const rows = detailOf(line!).flatMap((s) => s.rows);
    const keys = rows.map((r) => r.key);
    for (const internal of ["Op id", "Workout id", "Base rev", "Review run id", "Id", "Proposal id", "Kind", "Round", "Target", "Doc"]) expect(keys).not.toContain(internal);
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: "Workout", value: "Hips" },
        { key: "For", value: "day 2026-10-16" },
        { key: "What changed", value: "Gentler warm-up." },
        { key: "Read from", value: "the exercise library, today's condition checks and your logged sets and exercise preferences" },
      ]),
    );
  });

  it("nothing proposed is an outcome, not a step done: no ✓", () => {
    const [line] = runLines([ev(9, "note", "Nothing was proposed.", { proposed: false })]);
    expect(line!.glyph).toBe("neutral");
  });

  it("a question waiting on the athlete isn't a trail line (its card is on top); once answered it says it asked", () => {
    const asked = ev(2, "question", "How are the hips today?", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips today?", chips: ["tight"] }] } });
    const check = ev(4, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "x" } });
    expect(runLines([ev(1, "note", "Read your request and today's plan."), asked], { waiting: true }).map((l) => l.summary)).toEqual(["Read your request and today's plan."]);
    expect(runLines([asked, ev(3, "note", "You answered: tight"), check], { waiting: true }).map((l) => l.summary)).toEqual(["Asked you: How are the hips today?", "You answered: tight"]);
    expect(runLines([asked, check]).map((l) => l.summary)).toEqual(["Asked you: How are the hips today?", "Asked for today's condition check."]);
  });

  it("a review's line opens to every score, one a row", () => {
    const [line] = runLines([
      ev(1, "review", "Review — 4.9 avg", {
        receipt: { round: 1, mean: 4.92, scores: { intent: 5, sequencing: 4, condition_safety: 5 }, mustFix: 0 },
        by: { runId: "rv-1", role: "reviewer" },
      }),
    ]);
    const rows = detailOf(line!)[0]!.rows;
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: "Intent", value: "5 of 5" },
        { key: "Sequencing", value: "4 of 5" },
        { key: "Condition safety", value: "5 of 5" },
        { key: "Mean", value: "4.92" },
      ]),
    );
    expect(rows.some((r) => r.key === "Scores")).toBe(false);
    // A whole rubric's twelve scores, and the mean after them.
    const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`dimension_${i + 1}`, 5]));
    const [full] = runLines([ev(2, "review", "Review — 5 avg", { receipt: { round: 1, mean: 5, scores: twelve, mustFix: 0 } })]);
    const fullRows = detailOf(full!)[0]!.rows;
    expect(fullRows.filter((r) => r.value === "5 of 5")).toHaveLength(12);
    expect(fullRows.some((r) => r.key === "Mean")).toBe(true);
  });

  it("marked text reads as its text; a truncated payload says what it holds", () => {
    const [line] = runLines([ev(1, "tool_result", "Read history", { tool: "read_history", input: { note: { text: "my knee", untrusted: true } }, ok: true })]);
    expect(detailOf(line!)[0]!.rows).toEqual([{ key: "Note", value: "my knee" }]);
    const [cut] = runLines([ev(2, "draft", "A draft", { tool: "propose_workout", input: { truncated: true, head: '{"doc":' } })]);
    expect(detailOf(cut!)[0]!.rows).toEqual([{ key: "Detail", value: '{"doc":' }]);
  });
});

describe("the question", () => {
  it("the latest question's chips; or the condition check with its why", () => {
    const events = [
      ev(1, "question", "Hips today?", { tool: "ask_athlete", data: { questions: [{ text: "Hips today?", chips: ["tight", "okay"], why: "the plan", allowFreeText: true }] } }),
      ev(2, "note", "You answered: tight"),
      ev(3, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need it." } }),
    ];
    expect(askedOf(events)).toEqual({ kind: "check", why: "Landing drills need it." });
    expect(askedOf(events.slice(0, 2))).toEqual({ kind: "questions", questions: [{ text: "Hips today?", chips: ["tight", "okay"] }] });
    expect(askedOf([ev(1, "note", "x")])).toBeNull();
  });
});

describe("the loop's decisions", () => {
  it("steps active, stepping (a 409 then backs off), waiting_review and waiting_set; never waiting_athlete or one over", () => {
    for (const s of ["active", "stepping", "waiting_review", "waiting_set"] as const) expect(isSteppable(s)).toBe(true);
    for (const s of ["waiting_athlete", "finished", "failed", "cancelled", "expired", "stopped_cap"] as const) expect(isSteppable(s)).toBe(false);
  });

  it("backs off 1, 2, 4, then 8 seconds, capped at 8", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(backoffMs(0)).toBe(0);
  });

  it("never steps before nextDue; the backoff on top; a far-off nextDue is held to MAX_DUE_WAIT_MS", () => {
    const now = 1_000_000;
    expect(stepDelay({ nextDueAt: now + 20_000, now, backoff: 0 })).toBe(20_000);
    expect(stepDelay({ nextDueAt: now + 20_000, now, backoff: 4_000 })).toBe(20_000);
    expect(stepDelay({ nextDueAt: now - 5_000, now, backoff: 2_000 })).toBe(2_000);
    expect(stepDelay({ nextDueAt: null, now, backoff: 0 })).toBe(0);
    expect(stepDelay({ nextDueAt: now + 10 * MAX_DUE_WAIT_MS, now, backoff: 0 })).toBe(MAX_DUE_WAIT_MS);
  });

  it("a 409 is busy, a 404 gone, anything else to try again", () => {
    expect(stepErrorKind(new ApiError(409, { error: "busy" }))).toBe("busy");
    expect(stepErrorKind(new ApiError(404, { error: "not_found" }))).toBe("gone");
    expect(stepErrorKind(new ApiError(503, null))).toBe("transient");
    expect(stepErrorKind(new TypeError("Failed to fetch"))).toBe("transient");
  });
});

describe("what stopped a run", () => {
  it("says what failed, in plain words, and what happens next", () => {
    expect(failureOf(run({ status: "failed", error: "gateway_402" }))).toMatchObject({ what: "The AI account is out of credits.", credits: true });
    expect(failureOf(run({ status: "stopped_cap", error: "weekly_cap" }))).toMatchObject({ what: "This week's AI budget is used up.", next: "The coach can design again next week." });
    expect(failureOf(run({ status: "stopped_cap", error: "run_ceiling" }))!.what).toBe("This design reached its spending limit.");
    expect(failureOf(run({ status: "failed", error: "retries" }))!.what).toBe("The AI service didn't answer.");
    expect(failureOf(run({ status: "failed", error: "gateway_503" }))!.what).toBe("The AI service refused the request.");
    expect(failureOf(run({ status: "expired", error: "expired" }))!.what).toBe("This design ran out of time.");
    expect(failureOf(run({ status: "finished" }))).toBeNull();
    expect(failureOf(run({ status: "cancelled" }))).toBeNull();
    expect(failureOf(run({ status: "active" }))).toBeNull();
  });
});

describe("ways to train now", () => {
  const quick = [
    { key: "condition_care", title: "Jaw care", minutes: 5, href: "/studio/build/quick/condition_care" },
    { key: "desk_reset", title: "Desk reset", minutes: 8, href: "/studio/build/quick/desk_reset" },
    { key: "hip_opener", title: "Hip opener", minutes: 10, href: "/studio/build/quick/hip_opener" },
    { key: "template:t1", title: "Pinned one", minutes: 20, href: "/studio/build/template/t1" },
  ];
  const templates = [{ key: "template:t1", title: "Pinned one", minutes: 20, href: "/studio/build/template/t1" }];
  const today = (origin: string, completionState = "scheduled") =>
    ({ todaySessions: [{ workout: { id: "w-1", origin, title: "Strength A", completionState, contentState: "built" }, build: { minutes: 35 } }] }) as unknown as TodayResponse;

  it("the day's programme session, a pinned or recent template, then a built-in quick start — each saying what kind it is", () => {
    const tiles = fallbackTiles({ today: today("program"), quick, templates });
    expect(tiles.map((t) => [t.kind, t.title])).toEqual([
      ["session", "Strength A"],
      ["template", "Pinned one"],
      ["quick", "Jaw care"],
    ]);
    expect(tiles[0]).toEqual({ key: "session:w-1", kind: "session", title: "Strength A", minutes: 35, href: "/plan?workout=w-1" });
    expect(tiles.map(tileKindWord)).toEqual(["Today's session", "Your template", "Quick start"]);
  });

  it("the day's session by its own name and length — beside a quick start of that name, it is plainly another thing", () => {
    const named = {
      todaySessions: [
        { workout: { id: "w-2", origin: "program", title: "Jaw care · Gentle flow", completionState: "scheduled", contentState: "outline", workoutSeconds: 1800 }, build: { theme: "Gentle flow", minutes: null } },
      ],
    } as unknown as TodayResponse;
    const tiles = fallbackTiles({ today: named, quick, templates: [] });
    expect(tiles.map((t) => [t.kind, t.title, t.minutes])).toEqual([
      ["session", "Jaw care", 30],
      ["quick", "Jaw care", 5],
      ["quick", "Desk reset", 8],
    ]);
  });

  it("no programme session to do (none, done, a Studio workout): templates and quick starts fill the three", () => {
    expect(fallbackTiles({ today: today("program", "completed"), quick, templates }).map((t) => t.title)).toEqual(["Pinned one", "Jaw care", "Desk reset"]);
    expect(fallbackTiles({ today: today("studio"), quick, templates: [] }).map((t) => t.title)).toEqual(["Jaw care", "Desk reset", "Hip opener"]);
    expect(fallbackTiles({ today: null, quick: quick.slice(1, 2), templates: [] }).map((t) => t.title)).toEqual(["Desk reset"]);
  });
});

describe("the plan's refusals, in plain words", () => {
  it("words each code, and the causes of not_editable", () => {
    expect(refusalWords({ error: "past_date" })).toBe("Its day has passed.");
    expect(refusalWords({ error: "stale_revision" })).toBe("That workout changed after the coach read it.");
    expect(refusalWords({ error: "not_editable", cause: "programme" })).toBe("It's a programme's session: the programme plans it.");
    expect(refusalWords({ error: "not_editable", cause: "studio" })).toBe("Its length comes from the Studio: edit the workout there.");
    expect(refusalWords({ error: "not_editable", cause: "completed" })).toBe("It's done already.");
    expect(refusalWords({ error: "race" })).toBe("A race day stays as it is.");
    expect(refusalWords({ error: "something_new" })).toBe("The plan couldn't take it.");
  });

  it("the server's why joins the words only where it adds to them", () => {
    expect(refusedLine({ error: "past_date", why: "Wed 13 May has passed." })).toEqual({ lead: "Its day has passed.", detail: null });
    // Said once: the day's words, then what it refuses — never "The day doesn't allow it now. The day now refuses it: …".
    expect(refusedLine({ error: "invalid_doc", why: "The day now refuses it: tuck jumps are closed today." })).toEqual({
      lead: "The day doesn't allow it now: tuck jumps are closed today.",
      detail: null,
    });
    expect(refusedLine({ error: "invalid_doc", why: "Box jumps aren't in the library any more." })).toEqual({
      lead: "The day doesn't allow it now.",
      detail: "Box jumps aren't in the library any more.",
    });
  });

  it("a workout's day on the Plan: its week, its sheet open", () => {
    expect(mondayOf("2026-10-15")).toBe("2026-10-12");
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(planDayHref("w 1", "2026-10-15")).toBe("/plan?week=2026-10-12&workout=w%201");
  });
});
