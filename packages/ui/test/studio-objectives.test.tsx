/**
 * Stage 3 Task 11 — the objectives board (`/studio/objectives`; spec §11; principles §2.10 gentle gamification, §2.9
 * honesty), rendered statically:
 *
 *  - one card per objective, in board order (the completed ones under their own heading): the title and the why as the
 *    athlete's own text, each key result as progress toward its target — now, start, target, the trend over its window
 *    (the chart kit), and how far its figure can be trusted in the read_objectives legend's words (measured, sparse,
 *    capped, none), never by colour alone;
 *  - a "best ever" marker on a key result's best ever measurement when it is on the trend, a quiet progress ring, the
 *    streak of weeks — and never guilt: no streak at zero, no red, a stalled objective only its facts and a neutral line;
 *  - the workouts that served it (up to three, each linking to its day on the Plan) and the coach's line;
 *  - units from the athlete's settings; labels from the vocabularies' LABELS; the athlete's words as text;
 *  - the Studio home has no link to the board, on or off: the objectives are Growth's (the new shape §7);
 *  - reduced motion: the ring moves only for a reader who has not asked for less.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULING_PREFERENCES,
  keyResultMeasureSchema,
  type KeyResultDto,
  type KeyResultMeasureInput,
  type KeyResultProgress,
  type KeyResultUnit,
  type ObjectiveBoardCard,
  type ObjectiveBoardDto,
  type ObjectiveDto,
} from "@rg/domain";
import { features } from "../src/features.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { COACH_CURRENT_QUERY } from "../src/screens/studio/run-keeper.js";
import { ObjectivesScreen, OBJECTIVE_BOARD_QUERY } from "../src/screens/studio/objectives.js";
import { CoachOpenContext } from "../src/screens/studio/coach-ask.js";
import { ObjectiveSheet } from "../src/screens/studio/objectives-sheet.js";
import { GoalsSheet } from "../src/screens/studio/goals-sheet.js";
import { newDoc } from "@rg/workout";
import {
  evidenceWord,
  formatKr,
  krFraction,
  measureWords,
  objectiveFraction,
  objectiveInputOf,
  parseKr,
  stalled,
  streakWords,
  testRequest,
} from "../src/screens/studio/objectives-model.js";
import { primedClient, staticRouter, text } from "./studio-fixtures.js";

const TODAY = "2026-10-14";
const T0 = "2026-09-01T12:00:00.000Z";
const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

const was = { coach: features.coach, studio: features.studio };
afterEach(() => {
  features.coach = was.coach;
  features.studio = was.studio;
});

// ── Fixtures (generic) ───────────────────────────────────────────────────────────────────────────────────────────────

function kr(id: string, label: string, measure: KeyResultMeasureInput, o: Partial<KeyResultDto> = {}): KeyResultDto {
  return {
    id, objectiveId: "o", label, measure: keyResultMeasureSchema.parse(measure), direction: "up", baseline: null, target: null, unit: "s",
    dueDate: null, position: 0, createdAt: T0, updatedAt: T0, ...o,
  };
}

function progress(points: Array<[string, number, boolean?]>, o: Partial<KeyResultProgress> = {}): KeyResultProgress {
  const series = points.map(([date, value, capped]) => ({ date, value, display: value, ...(capped ? { capped: true as const } : {}) }));
  return {
    unit: "s",
    current: series.length ? Math.max(...series.map((p) => p.value)) : null,
    series,
    lastMeasuredAt: series.length ? series[series.length - 1]!.date : null,
    sampleSize: series.length,
    evidence: series.length >= 3 ? "measured" : series.length ? "sparse" : "none",
    display: { unit: "s", current: series.length ? Math.max(...series.map((p) => p.value)) : null },
    ...o,
  };
}

function objective(id: string, title: string, o: Partial<ObjectiveDto> = {}): ObjectiveDto {
  return { id, title, why: null, status: "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: T0, keyResults: [], ...o };
}

function card(o: ObjectiveDto, rest: Partial<ObjectiveBoardCard> = {}): ObjectiveBoardCard {
  return { objective: o, keyResults: [], served: [], streakWeeks: 0, note: null, ...rest };
}

const WALL = kr("k1", "Wall sit hold", { kind: "hold_max", libraryIds: ["wallSit"] }, { baseline: 60, target: 120 });
const FIVE_K = kr("k2", "5K time", { kind: "run_best", distanceM: 5000 }, { direction: "down", target: 1440 });
const SQUAT = kr("k3", "Squat estimated max", { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm" }, { unit: "kg", target: 40 });
const EASY = kr("k4", "Easy pace", { kind: "pace_at_hr", hrLow: 130, hrHigh: 145 }, { direction: "down", unit: "s/mi", target: 570 });

const LEGS = objective("o1", "Stronger legs for ski season", {
  why: "Ski the whole day",
  goalIds: ["ski", "strength"],
  keyResults: [WALL, FIVE_K, SQUAT, EASY],
});
const LEGS_CARD = card(LEGS, {
  keyResults: [
    { keyResult: WALL, progress: progress([["2026-09-20", 80], ["2026-10-01", 90], ["2026-10-12", 95]]), best: { date: "2026-10-12", value: 95, display: 95 } },
    { keyResult: FIVE_K, progress: progress([["2026-10-05", 1530]]), best: { date: "2026-05-01", value: 1500, display: 1500 } },
    {
      keyResult: SQUAT,
      progress: { ...progress([["2026-10-02", 30, true], ["2026-10-09", 32.5, true]]), unit: "kg", evidence: "capped", display: { unit: "kg", current: 32.5 } },
      best: { date: "2026-10-09", value: 32.5, display: 32.5 },
    },
    {
      keyResult: EASY,
      progress: { ...progress([]), unit: "s/km", missing: "No run long enough with its average heart rate in this range in the last 90 days.", display: { unit: "s/mi", current: null } },
      best: null,
    },
  ],
  served: [
    { workoutId: "w1", date: "2026-10-12", title: "Lower body strength", source: "coach" },
    { workoutId: "w2", date: "2026-10-08", title: "Hip hold test", source: "studio" },
  ],
  streakWeeks: 3,
  note: { text: "Single-leg strength, with a hold test on Thursday.", workoutId: "w3", date: "2026-10-16" },
});

const UNTRUSTED = card(objective("o2", "<script>alert(1)</script> Posture", { status: "paused", why: "<b>sit tall</b> at work", goalIds: ["posture"] }));
const DONE = card(objective("o3", "Run a half marathon", { status: "done", goalIds: ["aerobic-base", "condition-care"] }), { streakWeeks: 0 });
/** Measured, with targets, but no start: no key result can say how far it has come. */
const NO_START = card(objective("o5", "Faster 5K", { keyResults: [FIVE_K] }), {
  keyResults: [{ keyResult: FIVE_K, progress: progress([["2026-10-05", 1530], ["2026-10-09", 1500], ["2026-10-12", 1490]]), best: null }],
});
const STALLED = card(objective("o4", "Mobility every week", { keyResults: [WALL] }), {
  keyResults: [{ keyResult: WALL, progress: progress([["2026-08-20", 70]]), best: null }],
  served: [{ workoutId: "w9", date: "2026-08-20", title: "Old mobility", source: "studio" }],
});

const BOARD: ObjectiveBoardDto = { today: TODAY, objectives: [LEGS_CARD, UNTRUSTED, DONE, STALLED] };

function boardHtml(board: ObjectiveBoardDto = BOARD, units: { units?: "km" | "mi"; weightUnit?: "kg" | "lb" } = {}, coach = true): string {
  const qc = primedClient();
  qc.setQueryData(OBJECTIVE_BOARD_QUERY, board);
  qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: units.units ?? "km", weightUnit: units.weightUnit ?? "kg" } });
  // The app's coach sheet is mounted with the coach on (the board's only), and its Asks open it (coach everywhere, A3).
  const opener = coach ? { open: () => undefined } : null;
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(CoachOpenContext.Provider, { value: opener }, staticRouter("/studio/objectives", createElement(ObjectivesScreen)))),
  );
}

/** One card's markup, by its objective id. */
function cardOf(html: string, id: string): string {
  const at = html.lastIndexOf("<article", html.indexOf(`data-id="${id}"`));
  expect(at, `no card ${id}`).toBeGreaterThan(-1);
  const end = html.indexOf("</article>", at);
  return html.slice(at, end);
}
/** One key result's markup within a card, by its label. */
function krOf(cardHtml: string, label: string): string {
  const at = cardHtml.indexOf(`>${label}</h3>`);
  expect(at, `no key result ${label}`).toBeGreaterThan(-1);
  const end = cardHtml.indexOf("</li>", at);
  return cardHtml.slice(at, end);
}

const GUILT = /missed|broken|you didn't|you did not|lost (your|the) streak|streak ended|behind|overdue|failing|0 weeks/i;

// ── The model ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the board's words and numbers", () => {
  const hold = keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] });
  const fiveK = keyResultMeasureSchema.parse({ kind: "run_best", distanceM: 5000 });
  it("formats a value in its key result's unit: holds in seconds, race times and paces as clocks, loads and reps", () => {
    expect(formatKr(95, "s", hold)).toBe("95 s");
    expect(formatKr(1530, "s", fiveK)).toBe("25:30");
    expect(formatKr(3750, "s", fiveK)).toBe("1:02:30");
    expect(formatKr(273, "s/km", null)).toBe("4:33 /km");
    expect(formatKr(440, "s/mi", null)).toBe("7:20 /mi");
    expect(formatKr(1.5, "min", hold)).toBe("1.5 min");
    expect(formatKr(82.5, "kg", null)).toBe("82.5 kg");
    expect(formatKr(180, "lb", null)).toBe("180 lb");
    expect(formatKr(1, "reps", null)).toBe("1 rep");
    expect(formatKr(12, "reps", null)).toBe("12 reps");
    expect(formatKr(7, "score", null)).toBe("7");
  });

  it("reads what the athlete types the way it is shown: a clock for times and paces, a number otherwise; unclear is refused", () => {
    expect(parseKr("25:30", "s", fiveK)).toBe(1530);
    expect(parseKr("1:02:30", "s", fiveK)).toBe(3750);
    expect(parseKr("4:33", "s/km", null)).toBe(273);
    expect(parseKr("95", "s", hold)).toBe(95);
    expect(parseKr(" 82.5 ", "kg", null)).toBe(82.5);
    expect(parseKr("", "kg", null)).toBeNull();
    expect(parseKr("25", "s", fiveK)).toBe("bad");
    expect(parseKr("4:75", "s/km", null)).toBe("bad");
    expect(parseKr("fast", "kg", null)).toBe("bad");
    expect(parseKr("-3", "reps", null)).toBe("bad");
  });

  it("names a measure in plain words, with move names, the athlete's distance and weight units", () => {
    expect(measureWords(hold, { units: "km", weightUnit: "kg" })).toBe("Longest hold · Wall sit");
    expect(measureWords(fiveK, { units: "km", weightUnit: "kg" })).toBe("Fastest 5 km");
    expect(measureWords(fiveK, { units: "mi", weightUnit: "kg" })).toBe("Fastest 3.1 mi");
    expect(measureWords(keyResultMeasureSchema.parse({ kind: "best_set", libraryIds: ["gobletSquat"], metric: "reps_at_load", loadKg: 20 }), { units: "km", weightUnit: "lb" })).toBe(
      "Most reps at 44.1 lb · Goblet squat",
    );
    expect(measureWords(keyResultMeasureSchema.parse({ kind: "pace_at_hr", hrLow: 130, hrHigh: 145 }), { units: "km", weightUnit: "kg" })).toBe("Pace at heart rate 130–145");
  });

  it("says evidence in plain words, never the model's (fix wave 3B, B-I11)", () => {
    expect((["measured", "sparse", "capped", "none"] as const).map(evidenceWord)).toEqual(["Measured", "Few readings", "At least", "Not measured yet"]);
  });

  it("measures progress from the start to the target, either way, clamped to 0–100%", () => {
    const up = { ...WALL, baseline: 60, target: 120 };
    expect(krFraction(up, 90)).toBe(0.5);
    expect(krFraction(up, 150)).toBe(1);
    expect(krFraction(up, 40)).toBe(0);
    expect(krFraction({ ...FIVE_K, baseline: 1600, target: 1400 }, 1500)).toBe(0.5);
    expect(krFraction({ ...WALL, target: null }, 60)).toBeNull();
    expect(krFraction(up, null)).toBeNull();
  });

  it("a key result with no start can't say how far it has come: it counts for nothing, either way", () => {
    // Lower is better: "from zero" means nothing for a time or a pace.
    expect(krFraction({ ...FIVE_K, baseline: null, target: 1440 }, 1600)).toBeNull();
    expect(krFraction({ ...EASY, baseline: null, target: 360 }, 350)).toBeNull();
    // Higher is better: only loosely meaningful, so not counted either.
    expect(krFraction({ ...WALL, baseline: null, target: 120 }, 60)).toBeNull();
  });

  it("a pace at or below its target is 100%, and never more", () => {
    const pace = { ...EASY, direction: "down" as const, baseline: 400, target: 360 };
    expect(krFraction(pace, 360)).toBe(1);
    expect(krFraction(pace, 340)).toBe(1);
    expect(krFraction(pace, 380)).toBe(0.5);
    expect(krFraction(pace, 420)).toBe(0);
  });

  it("a start on the wrong side of its target for the key result's way counts for nothing", () => {
    expect(krFraction({ ...EASY, direction: "down" as const, baseline: 360, target: 400 }, 380)).toBeNull();
    expect(krFraction({ ...WALL, direction: "up" as const, baseline: 120, target: 60 }, 90)).toBeNull();
    expect(krFraction({ ...WALL, baseline: 120, target: 120 }, 120)).toBeNull();
  });

  it("an objective's ring is the mean of the key results that can say: here only the one with a start", () => {
    // The 5K and the squat have no start; the easy pace has no current value.
    expect(objectiveFraction(LEGS_CARD)).toBeCloseTo(35 / 60, 5);
    expect(objectiveFraction(UNTRUSTED)).toBeNull();
    expect(objectiveFraction(NO_START)).toBeNull();
  });

  it("what is sent: the title trimmed, an empty why null, the goals in the goal list's order", () => {
    expect(objectiveInputOf({ title: "  Legs ", why: "  ", goalIds: ["strength", "ski"], krs: [] }, { units: "km", weightUnit: "kg" })).toEqual({
      body: { title: "Legs", why: null, goalIds: ["ski", "strength"], keyResults: [] },
    });
  });

  it("a streak shows from one week, never at zero", () => {
    expect(streakWords(0)).toBeNull();
    expect(streakWords(1)).toBe("1 week");
    expect(streakWords(3)).toBe("3 weeks in a row");
  });

  it("stalled: an active objective, four weeks old or more, with nothing done toward it in four weeks; never a paused or completed one", () => {
    expect(stalled(STALLED, TODAY)).toBe(true);
    expect(stalled(LEGS_CARD, TODAY)).toBe(false);
    expect(stalled(card(objective("x", "Older")), TODAY)).toBe(true);
    // A new objective has had no four weeks yet: nothing to notice.
    expect(stalled(card(objective("y", "New", { createdAt: "2026-10-13T08:00:00.000Z" })), TODAY)).toBe(false);
    expect(stalled(UNTRUSTED, TODAY)).toBe(false);
    expect(stalled(DONE, TODAY)).toBe(false);
  });
});

// ── The board ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the board", () => {
  it("one card per objective in board order, the completed ones under their own heading", () => {
    const html = boardHtml();
    const order = ["o1", "o2", "o4", "o3"].map((id) => html.indexOf(`data-id="${id}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf(">Completed</h2>")).toBeGreaterThan(order[2]!);
    expect(html.indexOf(">Completed</h2>")).toBeLessThan(order[3]!);
    expect(text(html)).toContain("Objectives");
    expect(html).toContain('href="/studio"');
  });

  it("a measured key result: now, start, target, its trend on the chart kit, and its evidence in words", () => {
    const k = krOf(cardOf(boardHtml(), "o1"), "Wall sit hold");
    expect(text(k)).toContain("Measured");
    expect(text(k)).toContain("Longest hold · Wall sit");
    expect(text(k)).toContain("3 points");
    expect(text(k)).toMatch(/Now 95 s/);
    expect(text(k)).toMatch(/Start 60 s/);
    expect(text(k)).toMatch(/Target 120 s/);
    // The chart kit's frame: a measured, labelled SVG, the target a reference line keyed in the header strip.
    expect(k).toContain('class="chart-tip-wrap"');
    expect(k).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Wall sit hold: 80 s on Sep 20 to 95 s on Oct 12"/);
    expect(k).toContain("target 120 s");
  });

  it("a time's axis steps in whole quarter-minutes, never at odd seconds", () => {
    const k = krOf(cardOf(boardHtml(), "o1"), "5K time");
    const ticks = [...k.matchAll(/<text[^>]*>(\d+):(\d{2})<\/text>/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
    expect(ticks.length).toBeGreaterThan(1);
    for (const t of ticks) expect(t % 15, `${t}`).toBe(0);
  });

  it("a sparse key result says how few points it has", () => {
    const k = krOf(cardOf(boardHtml(), "o1"), "5K time");
    expect(text(k)).toContain("Few readings");
    expect(text(k)).toContain("1 point");
    expect(text(k)).toContain("25:30");
    expect(text(k)).toContain("Fastest 5 km");
  });

  it("a capped key result reads as a floor: at least this much", () => {
    const k = krOf(cardOf(boardHtml(), "o1"), "Squat estimated max");
    expect(text(k)).toContain("At least");
    expect(text(k)).toContain("Now at least 32.5 kg");
  });

  it("a key result not measured yet offers to ask the coach for a test; a measured one doesn't (fix wave 3B, B-I11)", () => {
    const none = krOf(cardOf(boardHtml(), "o1"), "Easy pace");
    // A button that opens the coach's sheet about the objective, the request in it (coach everywhere, A3).
    expect(none).toMatch(/<button type="button" class="linklike tap-pad ask-coach-link obj-ask-test" data-focus="objective:o1" aria-label="Ask the coach for a test: [^"]+"><span>Ask the coach for a test<\/span><\/button>/);
    expect(krOf(cardOf(boardHtml(), "o1"), "5K time")).not.toContain("Ask the coach for a test");
    expect(krOf(cardOf(boardHtml(), "o1"), "Squat estimated max")).not.toContain("Ask the coach for a test");
  });

  it("the request a test asks for, in plain words, naming the measure", () => {
    expect(testRequest("Easy pace")).toBe("Plan a test so I can measure: Easy pace");
  });

  it("'Key result' is 'Measure' wherever the athlete reads it (fix wave 3B, M10)", () => {
    expect(text(boardHtml())).not.toMatch(/key result/i);
  });

  it("a key result with nothing measured says why, with no chart and no number", () => {
    const k = krOf(cardOf(boardHtml(), "o1"), "Easy pace");
    expect(text(k)).toContain("Not measured yet");
    expect(text(k)).toContain("No run long enough with its average heart rate in this range in the last 90 days.");
    expect(k).not.toContain("<svg");
    expect(text(k)).not.toMatch(/Now /);
    // Its target in the key result's own unit (the athlete's: miles).
    expect(text(k)).toContain("Target 9:30 /mi");
  });

  it("evidence is never colour alone: every pill carries its word", () => {
    const html = cardOf(boardHtml(), "o1");
    const pills = [...html.matchAll(/<span class="pill obj-ev obj-ev--(\w+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(pills).toEqual([
      ["measured", "Measured"],
      ["sparse", "Few readings"],
      ["capped", "At least"],
      ["none", "Not measured yet"],
    ]);
  });

  it("a best ever on the trend is marked, on the chart and in words; one off the trend shows nothing", () => {
    const c = cardOf(boardHtml(), "o1");
    const wall = krOf(c, "Wall sit hold");
    expect(wall).toContain('class="obj-best-mark"');
    expect(text(wall)).toContain("Best ever 95 s · Oct 12");
    // The 5K's best was months ago, outside the trend: no marker, no comparison.
    const five = krOf(c, "5K time");
    expect(five).not.toContain("obj-best-mark");
    expect(text(five)).not.toContain("Best ever");
  });

  it("a quiet progress ring, its share in words for a screen reader", () => {
    const c = cardOf(boardHtml(), "o1");
    expect(c).toContain('aria-label="58% of the way to its targets"');
    expect(c).toContain('class="obj-ring"');
  });

  it("with no key result that can say, no ring at all", () => {
    const c = cardOf(boardHtml({ today: TODAY, objectives: [NO_START] }), "o5");
    expect(c).not.toContain("obj-ring");
    expect(c).not.toContain("of the way");
  });

  it("the streak in words; at zero nothing at all — no count, no alarm, no red", () => {
    const html = boardHtml();
    expect(text(cardOf(html, "o1"))).toContain("3 weeks in a row");
    for (const id of ["o2", "o3", "o4"]) {
      const c = cardOf(html, id);
      expect(c).not.toContain("obj-streak");
      expect(text(c)).not.toMatch(GUILT);
    }
    expect(html).not.toContain("pill-danger");
    expect(html).not.toMatch(/danger/);
    expect(text(html)).not.toMatch(GUILT);
  });

  it("a stalled objective shows its facts and one neutral line, with a next step", () => {
    const c = cardOf(boardHtml(), "o4");
    expect(text(c)).toContain("Nothing done toward this in the last 4 weeks.");
    expect(c).toMatch(/<button type="button" class="linklike tap-pad ask-coach-link" data-focus="objective:o4"[^>]*><span>Ask the coach<\/span><\/button>/);
    expect(text(cardOf(boardHtml(), "o1"))).not.toContain("Nothing done toward this");
  });

  it("a paused objective says so in words, and keeps its facts", () => {
    const c = cardOf(boardHtml(), "o2");
    expect(c).toContain("obj-card--paused");
    expect(text(c)).toContain("Paused");
    expect(text(c)).not.toContain("Nothing done toward this");
  });

  it("a completed one says so in words", () => {
    const c = cardOf(boardHtml(), "o3");
    expect(c).toContain("obj-card--done");
    expect(text(c)).toContain("Completed");
  });

  it("the athlete's words are text, never markup", () => {
    const html = boardHtml();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>sit tall</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Posture");
    expect(html).toContain("&lt;b&gt;sit tall&lt;/b&gt; at work");
  });

  it("goals in plain words, never their ids", () => {
    const c = text(cardOf(boardHtml(), "o3"));
    expect(c).toContain("Condition care · Aerobic base");
    expect(c).not.toMatch(/aerobic-base|Aerobic-base/);
  });

  it("the edit sheet's goals and the Studio's goals sheet say them in the same words", () => {
    const qc = primedClient();
    const sheet = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        staticRouter(
          "/studio/objectives",
          createElement(ObjectiveSheet, {
            initial: { title: "T", why: "", goalIds: ["aerobic-base"], krs: [] },
            editing: true,
            units: { units: "km", weightUnit: "kg" },
            onSave: async () => null,
            onClose: () => undefined,
          }),
        ),
      ),
    );
    expect(sheet).toMatch(/aria-pressed="true"[^>]*>Aerobic base<\/button>/);
    expect(text(sheet)).toContain("Condition care");
    const goals = renderToStaticMarkup(
      createElement(GoalsSheet, { doc: newDoc("structured", { title: "T", source: { kind: "studio" } }), onEdit: () => undefined, onClose: () => undefined }),
    );
    expect(text(goals)).toContain("Aerobic base");
    expect(goals).not.toContain(">Aerobic-base<");
  });

  it("the title, the why and the goals (their LABELS)", () => {
    const c = text(cardOf(boardHtml(), "o1"));
    expect(c).toContain("Stronger legs for ski season");
    expect(c).toContain("Ski the whole day");
    expect(c).toContain("Ski · Strength");
  });

  it("the workouts that served it, each a link to its day on the Plan, and the coach's line", () => {
    const c = cardOf(boardHtml(), "o1");
    expect(c).toContain('href="/plan?week=2026-10-12&amp;workout=w1"');
    expect(c).toContain('href="/plan?week=2026-10-05&amp;workout=w2"');
    expect(text(c)).toContain("Mon Oct 12 · Lower body strength");
    expect(text(c)).toContain("Single-leg strength, with a hold test on Thursday.");
  });

  it("units come from the key result, which the athlete's settings set: a pace per mile, a load in kilograms", () => {
    const c = text(cardOf(boardHtml(BOARD, { units: "mi" }), "o1"));
    expect(c).toContain("9:30 /mi");
    expect(c).toContain("Fastest 3.1 mi");
  });

  it("no objectives: says so, and offers the first", () => {
    const html = boardHtml({ today: TODAY, objectives: [] });
    expect(text(html)).toContain("No objectives yet.");
    expect(text(html)).toContain("New objective");
  });
});

// ── The switch, and motion ───────────────────────────────────────────────────────────────────────────────────────────

describe("the coach switch", () => {
  function home(): string {
    const qc = primedClient();
    qc.setQueryData(COACH_CURRENT_QUERY, { run: null });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter("/studio", createElement(StudioScreen))));
  }

  it("on: no link to the board in the Studio — the objectives are Growth's, in the nav (the new shape §7)", () => {
    expect(home()).not.toContain("/studio/objectives");
  });

  it("off: no link", () => {
    features.coach = false;
    expect(home()).not.toContain("/studio/objectives");
  });
});

describe("reduced motion", () => {
  it("the ring sweeps in only for a reader who has not asked for less motion", () => {
    const ruleAt = css.indexOf("\n.obj-ring-arc {");
    expect(ruleAt).toBeGreaterThan(-1);
    const base = css.slice(ruleAt, css.indexOf("}", ruleAt));
    expect(base).not.toMatch(/animation|transition/);
    const animated = [...css.matchAll(/obj-ring-(?:sweep|arc)[^{]*\{[^}]*animation/g)];
    expect(animated.length).toBeGreaterThan(0);
    for (const m of animated) {
      const before = css.slice(0, m.index);
      const open = before.lastIndexOf("@media (prefers-reduced-motion: no-preference)");
      expect(open, "the sweep sits inside a no-preference block").toBeGreaterThan(-1);
      expect(before.slice(open).split("{").length - before.slice(open).split("}").length).toBeGreaterThan(0);
    }
  });
});

/** Units of a key result, for the record: the four kept here are the athlete's own. */
const _units: KeyResultUnit[] = ["s", "kg", "s/mi"];
void _units;
