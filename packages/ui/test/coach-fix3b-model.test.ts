/**
 * Batch 3B's fix wave, Part U — the coach's run, pure (run-model.ts): a line's detail is never raw data (B-I3), a refused
 * call is a neutral note (B-I4), a set's trail is grouped by its day (B-I7), the athlete's answers never fold away
 * (M10), the review's plainer labels (M2), ways to train now never repeat the quick starts below (M5), the check ask's
 * own words (M6), an applied change's outcome (B-I5). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { CoachRunEventDto, TodayResponse } from "@rg/api-client";
import {
  appliedChangeLine,
  checkAskLabel,
  dayHeading,
  detailOf,
  EXISTING_LINE,
  fallbackTiles,
  foldLines,
  PAUSE_LINE,
  REVIEW_LABELS,
  reviewLabel,
  runLines,
  spentWords,
  trailSections,
  TRAIL_FOLD_LINE,
  valueWords,
} from "../src/screens/studio/run-model.js";

const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({
  seq,
  kind,
  summary,
  payload,
  at: `2026-10-14T08:00:${String(seq).padStart(2, "0")}.000Z`,
});

const sub = (runId: string, forDay: string | null, forTitle?: string) => ({
  by: { runId, role: "designer" },
  ...(forDay ? { forDay } : {}),
  ...(forTitle ? { forTitle } : {}),
});

describe("a line's detail is never raw data (B-I3)", () => {
  it("a question reads: You were asked … · Choices …, one pair a question — no 'text', 'chips', 'allow free text' or 'why'", () => {
    const [line] = runLines([
      ev(2, "question", "How long do you have?", {
        tool: "ask_athlete",
        data: {
          questions: [
            { text: "How long do you have?", chips: ["20 min", "45 min"], why: "The calendar doesn't say.", allowFreeText: true },
            { text: "How do the hips feel?", chips: ["Tight", "Okay"] },
          ],
        },
      }),
    ]);
    const rows = detailOf(line!).flatMap((s) => s.rows);
    expect(rows).toEqual([
      { key: "You were asked", value: "How long do you have?" },
      { key: "Choices", value: "20 min · 45 min" },
      { key: "You were asked", value: "How do the hips feel?" },
      { key: "Choices", value: "Tight · Okay" },
    ]);
    const words = JSON.stringify(detailOf(line!));
    for (const raw of ["text ", "chips", "allow free", "why ", "Questions"]) expect(words).not.toContain(raw);
  });

  it("a question with no chips is just what was asked; the condition check says what it asked for", () => {
    const [plain] = runLines([ev(1, "question", "Anything sore?", { tool: "ask_athlete", data: { questions: [{ text: "Anything sore?" }] } })]);
    expect(detailOf(plain!).flatMap((s) => s.rows)).toEqual([{ key: "You were asked", value: "Anything sore?" }]);
    const [check] = runLines([ev(1, "question", "The coach asks for today's check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need it." } })]);
    expect(detailOf(check!).flatMap((s) => s.rows)).toEqual([{ key: "You were asked", value: "Today's condition check · Landing drills need it." }]);
  });

  it("a set's line lists each day's workout in words — no keys, no outcome codes, no ISO dates", () => {
    const [line] = runLines([
      ev(30, "note", "The set is designed: 2 proposed, 1 left out.", {
        set: [
          { key: "hips", date: "2026-10-16", outcome: "proposed", opId: "op-1", target: { kind: "new", date: "2026-10-16" }, title: { text: "Hips and back, gently", untrusted: true }, minutes: 10, balance: { hips: 2 }, reviewMean: 4.92, mustFix: 0, rounds: 1 },
          { key: "legs", date: "2026-10-17", briefDate: "2026-10-17", outcome: "left_out", reason: "the designer finished without proposing a workout" },
          { key: "back", date: "2026-10-19", outcome: "kept_first", opId: "op-3", reason: "it scored 4.8 against 4.5" },
        ],
      }),
    ]);
    const rows = detailOf(line!).flatMap((s) => s.rows);
    expect(rows).toEqual([
      { key: "Fri 16 Oct", value: "Hips and back, gently · 10 min" },
      { key: "Sat 17 Oct", value: "Left out — the designer finished without proposing a workout" },
      { key: "Mon 19 Oct", value: "The first version kept — it scored 4.8 against 4.5" },
    ]);
    const words = JSON.stringify(rows);
    for (const raw of ["key ", "outcome", "proposed", "2026-", "balance", "must fix", "rounds", "opId", "op-1"]) expect(words).not.toContain(raw);
  });

  it("a Remembered line shows what was remembered, by its kind — never 'Body' or 'Confidence'", () => {
    const [line] = runLines([
      ev(8, "tool_result", "Remembered (you said): Knees like a long warm-up.", {
        tool: "remember",
        input: { kind: "fact", body: "Knees like a long warm-up.", confidence: "stated" },
        ok: true,
        receipt: { memoryId: "mem-1", kind: "fact", confidence: "stated", undo: { handle: "rm:run-1:t1" } },
      }),
    ]);
    const sections = detailOf(line!);
    expect(sections).toEqual([{ title: "Remembered", rows: [{ key: "Fact", value: "Knees like a long warm-up." }] }]);
    const [note] = runLines([
      ev(9, "tool_result", "Remembered (the coach inferred): Hips tight after drives.", {
        tool: "remember",
        input: { kind: "observation", body: "Hips tight after drives.", confidence: "inferred", evidence: ["two notes this week"] },
        ok: true,
        receipt: { memoryId: "mem-2", kind: "observation", confidence: "inferred" },
      }),
    ]);
    expect(detailOf(note!)).toEqual([
      { title: "Remembered", rows: [{ key: "Something the coach noticed", value: "Hips tight after drives." }, { key: "Because", value: "two notes this week" }] },
    ]);
    for (const s of [...sections, ...detailOf(note!)]) for (const r of s.rows) expect(["Body", "Confidence", "Kind"]).not.toContain(r.key);
  });

  it("a date in a detail reads as a day — never 2026-10-16", () => {
    expect(valueWords("2026-10-16")).toBe("Fri 16 Oct");
    expect(valueWords({ kind: "new", date: "2026-10-17" })).toBe("day Sat 17 Oct");
    const [line] = runLines([ev(1, "tool_result", "Read today", { tool: "read_day", input: { date: "2026-10-14" }, ok: true })]);
    expect(detailOf(line!)[0]!.rows).toEqual([{ key: "Day", value: "Wed 14 Oct" }]);
    // A date inside words is the words' own; only a whole value that is a date is read as one.
    expect(valueWords("since 2026-10-14")).toBe("since 2026-10-14");
  });

  it("the set's own grouping marks (forDay, forTitle) never show as rows", () => {
    const [line] = runLines([ev(5, "tool_result", "Read today", { tool: "read_day", input: { date: "2026-10-17" }, ok: true, ...sub("d-2", "2026-10-17", "Single-leg strength") })]);
    const keys = detailOf(line!).flatMap((s) => s.rows.map((r) => r.key));
    expect(keys).not.toContain("For day");
    expect(keys).not.toContain("For title");
  });
});

describe("a refused call is a neutral note (B-I4)", () => {
  const refused = ev(7, "note", "Adjusted the draft.", { tool: "propose_workout", input: { doc: { title: "Hips" } }, ok: false, error: "invalid_doc", why: "Tuck jumps are closed today." });

  it("its mark is –, never !, and it claims no step done", () => {
    const [line] = runLines([refused]);
    expect(line!.glyph).toBe("neutral");
    expect(line!.summary).toBe("Adjusted the draft.");
  });

  it("its detail, one tap down, says what was tried and why not — in the server's words when it gave them", () => {
    const [line] = runLines([refused]);
    const rows = detailOf(line!).flatMap((s) => s.rows);
    expect(rows).toEqual(expect.arrayContaining([{ key: "Workout", value: "Hips" }, { key: "Why not", value: "Tuck jumps are closed today." }]));
    const [coded] = runLines([ev(8, "note", "Adjusted the draft.", { tool: "propose_workout", ok: false, error: "invalid_doc" })]);
    expect(detailOf(coded!).flatMap((s) => s.rows)).toEqual(expect.arrayContaining([{ key: "Why not", value: "Invalid doc" }]));
  });

  it("Part S's own shape: the refusal nested, its why in plain words — never a document path, a code, or the model's fix", () => {
    const [line] = runLines([
      ev(9, "note", "Adjusted the draft.", {
        tool: "propose_workout",
        input: { doc: { title: "Hips and back, gently" }, target: { kind: "new", date: "2026-10-16" } },
        ok: false,
        error: "invalid_doc",
        refusal: {
          error: "invalid_doc",
          why: "parts[0].items[0].libraryId (unknown_exercise): There's no move \"notAMoveAnywhere\" in the library.; parts[0].items[1].dose (bad_dose): Two sets at most.",
          fix: "Find the move with search_library and use an id it shows",
        },
      }),
    ]);
    expect(line!.glyph).toBe("neutral");
    const rows = detailOf(line!).flatMap((s) => s.rows);
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: "Workout", value: "Hips and back, gently" },
        { key: "For", value: "day Fri 16 Oct" },
        { key: "Why not", value: "There's no move \"notAMoveAnywhere\" in the library. Two sets at most." },
      ]),
    );
    const words = JSON.stringify(rows);
    for (const raw of ["parts[", "unknown_exercise", "search_library", "Refusal", "Fix"]) expect(words).not.toContain(raw);
  });

  it("the model's fix written into the why itself — '(fix: …)', as the server sends it — is never shown either", () => {
    const [line] = runLines([
      ev(10, "note", "Adjusted the draft.", {
        tool: "propose_workout",
        ok: false,
        error: "invalid_doc",
        refusal: {
          error: "invalid_doc",
          why: "parts[0].items[0].libraryId (unknown_exercise): There's no move \"notAMoveAnywhere\" in the library. (fix: Find the move with search_library and use an id it shows)",
        },
      }),
    ]);
    const why = detailOf(line!).flatMap((s) => s.rows).find((r) => r.key === "Why not")!.value;
    expect(why).toBe("There's no move \"notAMoveAnywhere\" in the library.");
  });

  it("an error line is still an error: the loop's own stop, a tool result that failed", () => {
    expect(runLines([ev(1, "error", "The AI account is out of credits — the coach stopped here.")])[0]!.glyph).toBe("error");
    expect(runLines([ev(2, "tool_result", "Couldn't use search", { tool: "search_library", ok: false, error: "no_match" })])[0]!.glyph).toBe("error");
  });
});

describe("a set's trail, by day (B-I7)", () => {
  const events = [
    ev(1, "note", "Read your request and today's plan."),
    ev(2, "tool_result", "Planned 3 workouts", { tool: "plan_set", ok: true }),
    ev(3, "note", "Read your request and today's plan.", sub("d-1", "2026-10-16")),
    ev(4, "draft", "Draft — “Hips and back, gently”: 10 min", { tool: "propose_workout", ...sub("d-1", "2026-10-16", "Hips and back, gently") }),
    ev(5, "note", "Read your request and today's plan.", sub("d-2", "2026-10-17", "Single-leg strength")),
    ev(6, "review", "Review — 4.9 avg", { receipt: { mean: 4.9 }, by: { runId: "rv-1", role: "reviewer" }, forDay: "2026-10-16", forTitle: "Hips and back, gently" }),
    ev(7, "note", "The set is designed: 2 proposed."),
  ];

  it("each line carries its day and title from its payload; the main run's own carry neither", () => {
    const lines = runLines(events);
    expect(lines.map((l) => l.forDay)).toEqual([null, null, "2026-10-16", "2026-10-16", "2026-10-17", "2026-10-16", null]);
    expect(lines[3]!.forTitle).toBe("Hips and back, gently");
    expect(lines[2]!.forTitle).toBeNull();
  });

  it("the main run's lines stay ungrouped at the top; a day's lines under its heading, its title once known", () => {
    const { main, days } = trailSections(runLines(events));
    expect(main.map((l) => l.key)).toEqual([1, 2, 7]);
    expect(days.map((d) => [d.day, d.heading, d.lines.map((l) => l.key)])).toEqual([
      ["2026-10-16", "Fri 16 Oct · Hips and back, gently", [3, 4, 6]],
      ["2026-10-17", "Sat 17 Oct · Single-leg strength", [5]],
    ]);
  });

  it("a day's heading: the day, and its title when known", () => {
    expect(dayHeading("2026-10-17", "Single-leg strength")).toBe("Sat 17 Oct · Single-leg strength");
    expect(dayHeading("2026-10-17", null)).toBe("Sat 17 Oct");
  });

  it("days come in date order, whatever order their lines landed in", () => {
    const { days } = trailSections(runLines([ev(1, "note", "a", sub("d-2", "2026-10-19")), ev(2, "note", "b", sub("d-1", "2026-10-16"))]));
    expect(days.map((d) => d.day)).toEqual(["2026-10-16", "2026-10-19"]);
  });

  it("two workouts on one day are two groups: by the brief's key (payload.forKey), each 'Sat 17 Oct · <title>'", () => {
    const keyed = (runId: string, forKey: string, forTitle?: string) => ({ ...sub(runId, "2026-10-17", forTitle), forKey });
    const lines = runLines([
      ev(1, "tool_result", "Planned 2 workouts", { tool: "plan_set", ok: true }),
      ev(2, "note", "Read your request and today's plan.", keyed("d-1", "legs")),
      ev(3, "note", "Read your request and today's plan.", keyed("d-2", "mobility")),
      ev(4, "draft", "Draft — “Single-leg strength”", keyed("d-1", "legs", "Single-leg strength")),
      ev(5, "draft", "Draft — “Easy hips”", keyed("d-2", "mobility", "Easy hips")),
      // No key (an older trail): its day is its group.
      ev(6, "note", "Read today", sub("d-3", "2026-10-18", "Long walk")),
    ]);
    expect(lines.map((l) => l.forKey)).toEqual([null, "legs", "mobility", "legs", "mobility", null]);
    const { days } = trailSections(lines);
    expect(days.map((d) => [d.heading, d.lines.map((l) => l.key)])).toEqual([
      ["Sat 17 Oct · Single-leg strength", [2, 4]],
      ["Sat 17 Oct · Easy hips", [3, 5]],
      ["Sun 18 Oct · Long walk", [6]],
    ]);
  });

  it("once over, the trail folds to one line", () => {
    expect(TRAIL_FOLD_LINE).toBe("How the coach made this");
  });
});

describe("the athlete's answers never fold into earlier lines (M10)", () => {
  const many = [
    ev(1, "note", "Read your request and today's plan."),
    ev(2, "question", "How long do you have?", { tool: "ask_athlete", data: { questions: [{ text: "How long do you have?", chips: ["20 min"] }] } }),
    ev(3, "note", "You answered: 20 min", { answers: ["20 min"] }),
    ev(4, "note", "You skipped the question."),
    ev(5, "note", "You logged today's condition check."),
    ...Array.from({ length: 8 }, (_, i) => ev(6 + i, "note", `Line ${6 + i}`)),
  ];

  it("an answer, a skip, a logged check and the question they answer are the athlete's: kept in view", () => {
    const lines = runLines(many);
    expect(lines.filter((l) => l.mine).map((l) => l.key)).toEqual([2, 3, 4, 5]);
    const { hidden, shown } = foldLines(lines, 6);
    expect(shown.map((l) => l.key)).toEqual([2, 3, 4, 5, 8, 9, 10, 11, 12, 13]);
    expect(hidden).toBe(3);
  });

  it("nothing to fold: every line shows", () => {
    const lines = runLines(many.slice(0, 4));
    expect(foldLines(lines, 6)).toEqual({ hidden: 0, shown: lines });
  });
});

describe("the review's labels, from one map (M2)", () => {
  it("each rubric dimension in plainer words; its id stays the key", () => {
    // Task 13 (§2.10): `fit`, `request` and `words` joined; the retired `time_fit` and `equipment_fit` keep their labels.
    const ids = ["intent", "sequencing", "alignment", "balance", "progression", "diversity", "recovery", "condition_safety", "fit", "request", "words", "specificity", "honesty", "time_fit", "equipment_fit"];
    for (const id of ids) {
      expect(REVIEW_LABELS[id], id).toBeTruthy();
      expect(REVIEW_LABELS[id]).not.toMatch(/_|\bvs\b/);
    }
    expect(Object.keys(REVIEW_LABELS)).toHaveLength(ids.length);
    expect(reviewLabel("intent", "Intent clarity")).toBe(REVIEW_LABELS.intent);
    expect(reviewLabel("something_new", "Something new")).toBe("Something new");
  });

  it("a review's line in the trail opens to the same labels", () => {
    const [line] = runLines([ev(1, "review", "Review — 4.9 avg", { receipt: { mean: 4.9, scores: { intent: 5, time_fit: 4 } } })]);
    const rows = detailOf(line!)[0]!.rows;
    expect(rows).toEqual(expect.arrayContaining([{ key: REVIEW_LABELS.intent, value: "5 of 5" }, { key: REVIEW_LABELS.time_fit, value: "4 of 5" }]));
  });
});

describe("ways to train now never repeat the quick starts right below (M5)", () => {
  const quick = [
    { key: "condition_care", title: "Jaw care", minutes: 5, href: "/studio/build/quick/condition_care" },
    { key: "desk_reset", title: "Desk reset", minutes: 8, href: "/studio/build/quick/desk_reset" },
    { key: "template:t1", title: "Pinned one", minutes: 20, href: "/studio/build/template/t1" },
  ];
  const session = { todaySessions: [{ workout: { id: "w-1", origin: "program", title: "Jaw care", completionState: "scheduled", contentState: "built" }, build: { minutes: 30 } }] } as unknown as TodayResponse;

  it("today's session alone when a pinned template and the quick starts are all below", () => {
    const tiles = fallbackTiles({ today: session, quick, templates: [{ key: "template:t1", title: "Pinned one", minutes: 20, href: "/studio/build/template/t1" }] });
    expect(tiles.map((t) => [t.kind, t.title])).toEqual([["session", "Jaw care"]]);
  });

  it("a recent template not pinned among the quick starts stays", () => {
    const tiles = fallbackTiles({ today: session, quick, templates: [{ key: "template:t9", title: "Recent one", minutes: 15, href: "/studio/build/template/t9" }] });
    expect(tiles.map((t) => t.kind)).toEqual(["session", "template"]);
  });

  it("no session, no template off the quick starts: no tiles — the quick starts below are the ways", () => {
    expect(fallbackTiles({ today: null, quick, templates: [] })).toEqual([]);
  });
});

describe("the words (M4, M6, M10)", () => {
  it("the header's spend reads Spent $x", () => {
    expect(spentWords(0.164)).toBe("Spent $0.16");
    expect(spentWords(0)).toBe("Spent $0.00");
  });

  it("the check ask's primary action names the profile's check", () => {
    expect(checkAskLabel("Jaw")).toBe("Do the jaw check");
    expect(checkAskLabel("Knee / hip")).toBe("Do the knee check");
    expect(checkAskLabel("TMJ pain")).toBe("Do the TMJ check");
  });

  it("the existing run's notice says how to ask for something new; the coach pauses only while the app is closed", () => {
    expect(EXISTING_LINE).toBe("You already have the coach working on something. Here it is. Cancel it to ask for something new.");
    // The app's run keeper steps it on every screen (the robustness pass): leaving the Studio no longer pauses it.
    expect(PAUSE_LINE).toBe("The coach pauses while the app is closed.");
  });
});

describe("an applied change's outcome (B-I5)", () => {
  const before = { date: "2026-10-18", time: "08:55", title: "Jaw care", minutes: 30 };
  it("a skip, a move and a length change, each by what it did — never 'Done'", () => {
    expect(appliedChangeLine("skip", before)).toBe("Skipped · was Sun 8:55 AM, 30 min");
    expect(appliedChangeLine("move", before)).toBe("Moved · was Sun 8:55 AM, 30 min");
    expect(appliedChangeLine("adjust", before)).toBe("Changed · was Sun 8:55 AM, 30 min");
    expect(appliedChangeLine("skip", { ...before, minutes: null })).toBe("Skipped · was Sun 8:55 AM");
  });
});
