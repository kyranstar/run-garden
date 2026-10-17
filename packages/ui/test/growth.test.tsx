/**
 * GROWTH (the new shape §7), rendered statically: the Month/Season switch; the body map — a front figure of eleven areas
 * tinted by level, never by colour alone, its two lines and the quiet area's button that opens the coach with the words
 * written; the quests — each objective's bar, its words and one gentle line; the records — runs, strength (the lifts'
 * top sets) and holds; and the order of the place. Synthetic data only.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { InsightsResponse } from "@rg/api-client";
import {
  addDays,
  BODY_AREAS,
  DEFAULT_SCHEDULING_PREFERENCES,
  keyResultMeasureSchema,
  type BodyAreaExposure,
  type GrowthBodyDto,
  type KeyResultDto,
  type KeyResultProgress,
  type ObjectiveBoardCard,
  type ObjectiveBoardDto,
  type ObjectiveDto,
} from "@rg/domain";
import { features } from "../src/features.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { OBJECTIVE_BOARD_QUERY, ObjectivesScreen } from "../src/screens/studio/objectives.js";
import { AREA_LABEL, areaFacts, carriedLine, figureLabel, quietLine, quietRequest } from "../src/screens/growth/body-words.js";
import { BodyCard, BodyFigure, FIGURE } from "../src/screens/growth/body-map.js";
import { bestThisWeek, questKr, questLine, questProgressWords, QuestRow } from "../src/screens/growth/quests.js";
import { GrowthRecords, holdRows, holdWords, strengthRows } from "../src/screens/growth/records.js";
import { GROWTH_BODY_QUERY, GrowthScreen, periodOf, PeriodSwitch } from "../src/screens/growth/screen.js";
import { CHART_WEEKS } from "../src/screens/growth/activity.js";
import { emptyInsights } from "./runs-units.test.js";

const TODAY = "2026-10-14"; // a Wednesday; its week began Monday 2026-10-12
const T0 = "2026-09-01T12:00:00.000Z";
const was = { coach: features.coach, studio: features.studio };
afterEach(() => {
  features.coach = was.coach;
  features.studio = was.studio;
});

const text = (html: string) => html.replace(/<!-- -->/g, "");

function areas(over: Partial<Record<(typeof BODY_AREAS)[number], Partial<BodyAreaExposure>>> = {}): BodyAreaExposure[] {
  return BODY_AREAS.map((area) => ({ area, sets: 0, runs: 0, level: 0, last: null, daysAgo: null, ...over[area] }));
}

function body(over: Partial<GrowthBodyDto> = {}): GrowthBodyDto {
  return {
    period: "month",
    today: TODAY,
    from: addDays(TODAY, -29),
    sessions: 6,
    runs: 4,
    other: 0,
    areas: areas({
      core: { sets: 50, level: 3, last: addDays(TODAY, -1), daysAgo: 1 },
      quads: { sets: 3, runs: 4, level: 2, last: addDays(TODAY, -2), daysAgo: 2 },
      hips: { sets: 0, runs: 4, level: 1, last: addDays(TODAY, -6), daysAgo: 6 },
    }),
    carried: ["core", "quads"],
    quiet: { area: "hips", daysAgo: 6 },
    holds: [],
    ...over,
  };
}

const ok = (data: GrowthBodyDto): UseQueryResult<GrowthBodyDto> => ({ data, isError: false, refetch: () => undefined }) as unknown as UseQueryResult<GrowthBodyDto>;

function render(el: ReactElement, o: { opener?: CoachOpener | null; qc?: QueryClient; path?: string } = {}): string {
  const qc = o.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const opener = o.opener === undefined ? { open: () => undefined } : o.opener;
  return text(
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CoachOpenContext.Provider, { value: opener }, createElement(MemoryRouter, { initialEntries: [o.path ?? "/growth"] }, el)),
      ),
    ),
  );
}

// ── The body map's words ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the body map's words", () => {
  it("what carried the period: one or two areas, most first; nothing logged says so; only other sports, nothing", () => {
    expect(carriedLine(body(), "month")).toBe("Core and quads carried the month.");
    expect(carriedLine(body({ carried: ["back"] }), "season")).toBe("Back carried the season.");
    expect(carriedLine(body({ sessions: 0, runs: 0, other: 0, carried: [] }), "month")).toBe("Nothing logged this month.");
    expect(carriedLine(body({ sessions: 0, runs: 0, other: 2, carried: [] }), "month")).toBeNull();
  });

  it("the quiet area: for how many days, or all the period when it was never worked in it; none, no line", () => {
    expect(quietLine({ area: "hips", daysAgo: 6 }, "month")).toBe("Hips quiet for 6 days.");
    expect(quietLine({ area: "back", daysAgo: null }, "season")).toBe("Back quiet all season.");
    expect(quietLine(null, "month")).toBeNull();
  });

  it("the request the quiet area's button writes: the athlete's words, plain", () => {
    expect(quietRequest("hips")).toBe("15 minutes for my hips");
    expect(quietRequest("hamstrings")).toBe("15 minutes for my hamstrings");
  });

  it("an area's facts in words: sets and runs, or not worked", () => {
    expect(areaFacts({ sets: 12, runs: 3 })).toBe("12 sets · 3 runs");
    expect(areaFacts({ sets: 1, runs: 0 })).toBe("1 set");
    expect(areaFacts({ sets: 0, runs: 1 })).toBe("1 run");
    expect(areaFacts({ sets: 0, runs: 0 })).toBe("Not worked");
  });

  it("the figure's name lists each level's areas, most first", () => {
    expect(figureLabel(body().areas)).toBe("Body map. A lot: core. Steadily: quads. A little: hips.");
    expect(figureLabel(areas())).toBe("Body map. Nothing worked yet.");
  });
});

// ── The figure ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the figure", () => {
  it("draws every area, head to foot, each with its level and its name in words", () => {
    const html = render(createElement(BodyFigure, { areas: body().areas, quiet: "hips" }));
    expect([...html.matchAll(/data-area="([a-z]+)"/g)].map((m) => m[1])).toEqual([...BODY_AREAS]);
    expect(html).toMatch(/class="body-area body-lvl-3" data-area="core"/);
    expect(html).toMatch(/class="body-area body-lvl-2" data-area="quads"/);
    expect(html).toMatch(/class="body-area body-lvl-0" data-area="chest"/);
    expect(html).toContain("<title>Core · a lot</title>");
    expect(html).toContain("<title>Chest · not worked</title>");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Body map. A lot: core. Steadily: quads. A little: hips."');
  });

  it("the quiet area's edge is dashed; no other's", () => {
    const html = render(createElement(BodyFigure, { areas: body().areas, quiet: "hips" }));
    expect(html.match(/is-quiet/g)).toHaveLength(1);
    expect(html).toMatch(/body-lvl-1 is-quiet" data-area="hips"/);
  });

  it("every area has a shape, and pairs mirror across the middle", () => {
    for (const a of BODY_AREAS) expect(FIGURE[a].length, a).toBeGreaterThan(0);
    const [left, right] = FIGURE.shoulders as Array<{ cx: number }>;
    expect(left!.cx + right!.cx).toBe(120);
  });

  it("no area is named in the figure's own words but by the athlete's language", () => {
    expect(Object.values(AREA_LABEL)).toEqual(["Neck", "Shoulders", "Chest", "Arms", "Back", "Core", "Hips", "Glutes", "Quads", "Hamstrings", "Calves"]);
  });
});

// ── The card ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the body map's card", () => {
  it("the two lines, the quiet area's button (its name says it opens the coach) and the legend in words", () => {
    const html = render(createElement(BodyCard, { query: ok(body()), period: "month" }));
    expect(html).toContain("Your body");
    expect(html).toContain("Core and quads carried the month.");
    expect(html).toContain("Hips quiet for 6 days.");
    expect(html).toMatch(/<button type="button" class="btn btn-small body-ask" aria-label="Ask the coach: 15 minutes for my hips">/);
    expect(html).toContain("15 minutes for my hips</button>");
    for (const word of ["A little", "Steadily", "A lot"]) expect(html).toContain(word);
    expect(html).toContain("By area");
  });

  it("no coach in the app: the quiet line stays, no button", () => {
    const html = render(createElement(BodyCard, { query: ok(body()), period: "month" }), { opener: null });
    expect(html).toContain("Hips quiet for 6 days.");
    expect(html).not.toContain("body-ask");
  });

  it("nothing quiet: no quiet line and no button", () => {
    const html = render(createElement(BodyCard, { query: ok(body({ quiet: null })), period: "season" }));
    expect(html).toContain("Core and quads carried the season.");
    expect(html).not.toContain("quiet");
    expect(html).not.toContain("body-ask");
  });

  it("nothing logged says so, over a figure at rest", () => {
    const html = render(createElement(BodyCard, { query: ok(body({ sessions: 0, runs: 0, carried: [], quiet: null, areas: areas() })), period: "month" }));
    expect(html).toContain("Nothing logged this month.");
    expect(html).not.toMatch(/body-lvl-[123]" data-area/);
  });

  it("a read that failed says so, with Try again — never an empty map", () => {
    const failed = { data: undefined, isError: true, refetch: () => undefined } as unknown as UseQueryResult<GrowthBodyDto>;
    const html = render(createElement(BodyCard, { query: failed, period: "month" }));
    expect(html).toContain("Couldn&#x27;t load your body map.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("data-area");
  });
});

// ── The period ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Month / Season", () => {
  it("one choice, pressed where it is; the page's address decides it, the month without one", () => {
    const html = render(createElement(PeriodSwitch, { period: "season", onChange: () => undefined }));
    expect(html).toContain('role="group" aria-label="Period"');
    expect(html).toMatch(/aria-pressed="false">Month<\/button>/);
    expect(html).toMatch(/aria-pressed="true">Season<\/button>/);
    expect(periodOf(null)).toBe("month");
    expect(periodOf("season")).toBe("season");
    expect(periodOf("year")).toBe("month");
  });

  it("the chart shows the period's weeks: five for the month, thirteen for the season", () => {
    expect(CHART_WEEKS).toEqual({ month: 5, season: 13 });
  });
});

// ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const lift = (exerciseId: string, name: string, best: { v: number; u: "kg" | "lb"; reps: number | null; date: string } | null) => ({
  exerciseId,
  name,
  trend: best
    ? { status: "ok", value: { series: [], best: { w: { v: best.v, u: best.u }, reps: best.reps, date: best.date }, unit: best.u }, sampleSize: 2, comparisonNote: "" }
    : { status: "insufficient_data", needed: 2, have: 1, explanation: "" },
});

describe("records", () => {
  it("a hold reads as seconds under a minute, as a clock from one", () => {
    expect(holdWords(45)).toBe("45 s");
    expect(holdWords(60)).toBe("1:00");
    expect(holdWords(95)).toBe("1:35");
  });

  it("strength: each core lift with a line, its heaviest set as typed; one without a line is left out", () => {
    const progress = { lifts: [lift("gobletSquat", "Goblet squat", { v: 24, u: "kg", reps: 8, date: "2026-10-09" }), lift("deadlift", "Deadlift", null)] } as unknown as InsightsResponse["progress"];
    expect(strengthRows(progress)).toEqual([
      { id: "lift:gobletSquat", title: "Goblet squat", value: "24 kg × 8", date: "2026-10-09", rule: "The heaviest set in the last eight weeks." },
    ]);
    expect(strengthRows(undefined)).toEqual([]);
  });

  it("holds: the period's longest, named for the period", () => {
    expect(holdRows([{ exerciseId: "wallSit", name: "Wall sit", seconds: 70, date: "2026-10-08" }], "season")).toEqual([
      { id: "hold:wallSit", title: "Wall sit", value: "1:10", date: "2026-10-08", rule: "The longest hold this season." },
    ]);
  });

  it("runs, strength and holds, each under its own label; runs capped at three until expanded", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const records = ["a", "b", "c", "d"].map((id, i) => ({ id, title: `Record ${id}`, value: `${i}`, achievedOn: "2026-06-01", rule: "", numeric: i }));
    qc.setQueryData(["insights", "run"], {
      ...emptyInsights(),
      records,
      progress: { lifts: [lift("gobletSquat", "Goblet squat", { v: 50, u: "lb", reps: 10, date: "2026-10-01" })] },
    });
    const html = render(createElement(GrowthRecords, { holds: [{ exerciseId: "sidePlank", name: "Side plank", seconds: 40, date: "2026-10-02" }], period: "month" }), { qc });
    expect(html).toContain("Records");
    const labels = [...html.matchAll(/<h3 class="dash-eyebrow">([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Runs", "Strength", "Holds"]);
    expect(html).toContain("Record c");
    expect(html).not.toContain("Record d");
    expect(html).toContain("All 4 records");
    expect(html).toContain("<b>Goblet squat</b> — 50 lb × 10");
    expect(html).toContain("<b>Side plank</b> — 40 s");
    expect(html).toContain('title="The longest hold this month."');
  });

  it("nothing at all: one quiet line", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["insights", "run"], emptyInsights());
    const html = render(createElement(GrowthRecords, { holds: [], period: "month" }), { qc });
    expect(html).toContain("No records yet.");
    expect(html).not.toContain("dash-eyebrow");
  });
});

// ── Quests ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function kr(id: string, label: string, o: Partial<KeyResultDto> = {}): KeyResultDto {
  return {
    id, objectiveId: "o", label, measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] }), direction: "up", baseline: 60, target: 120,
    unit: "s", dueDate: null, position: 0, createdAt: T0, updatedAt: T0, ...o,
  };
}
function progress(points: Array<[string, number]>, o: Partial<KeyResultProgress> = {}): KeyResultProgress {
  const series = points.map(([date, value]) => ({ date, value, display: value }));
  const current = series.length ? Math.max(...series.map((p) => p.value)) : null;
  return {
    unit: "s", current, series, lastMeasuredAt: series.at(-1)?.date ?? null, sampleSize: series.length, evidence: series.length >= 3 ? "measured" : series.length ? "sparse" : "none",
    display: { unit: "s", current }, ...o,
  };
}
const objective = (id: string, title: string, o: Partial<ObjectiveDto> = {}): ObjectiveDto => ({
  id, title, why: null, status: "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: T0, keyResults: [], ...o,
});
const WALL = kr("k1", "Wall sit hold");
const quest = (o: Partial<ObjectiveBoardCard> = {}, obj: Partial<ObjectiveDto> = {}): ObjectiveBoardCard => ({
  objective: objective("o1", "Stronger legs for ski season", { keyResults: [WALL], ...obj }),
  keyResults: [{ keyResult: WALL, progress: progress([["2026-09-20", 80], ["2026-10-01", 90], ["2026-10-13", 96]]), best: { date: "2026-10-13", value: 96, display: 96 } }],
  served: [{ workoutId: "w1", date: "2026-10-13", title: "Legs", source: "coach" }],
  streakWeeks: 3,
  note: null,
  ...o,
});

describe("a quest", () => {
  it("its bar is its first key result that can say how far it has come; in words, now of the target", () => {
    const q = quest();
    expect(questKr(q)).toMatchObject({ fraction: 0.6 });
    expect(questProgressWords(q.keyResults[0]!)).toBe("96 s of 120 s");
    expect(questProgressWords({ ...q.keyResults[0]!, progress: progress([["2026-10-13", 96]], { evidence: "capped" }) })).toBe("at least 96 s of 120 s");
    expect(questKr(quest({ keyResults: [{ keyResult: kr("k9", "No start", { baseline: null }), progress: progress([["2026-10-13", 96]]), best: null }] }))).toBeNull();
  });

  it("a best ever this week, on the trend, is its line; one from before Monday, or off the trend, is not", () => {
    expect(questLine(quest(), TODAY)).toBe("Best ever this week · Wall sit hold 96 s");
    expect(bestThisWeek(quest(), TODAY)).not.toBeNull();
    const lastWeek = quest({ keyResults: [{ ...quest().keyResults[0]!, best: { date: "2026-10-11", value: 96, display: 96 } }] });
    expect(questLine(lastWeek, TODAY)).toBe("3 weeks in a row");
    const offTrend = quest({ keyResults: [{ ...quest().keyResults[0]!, best: { date: "2026-10-13", value: 99, display: 99 } }] });
    expect(bestThisWeek(offTrend, TODAY)).toBeNull();
  });

  it("paused and completed say so; a quiet one gets a neutral nudge, never guilt; else nothing", () => {
    expect(questLine(quest({}, { status: "paused" }), TODAY)).toBe("Paused");
    expect(questLine(quest({}, { status: "done" }), TODAY)).toBe("Completed");
    const quiet = quest({ keyResults: [], served: [], streakWeeks: 0 }, { createdAt: "2026-07-01T00:00:00.000Z" });
    expect(questLine(quiet, TODAY)).toBe("Nothing toward it in 4 weeks");
    expect(questLine(quest({ keyResults: [], streakWeeks: 0 }), TODAY)).toBeNull();
  });

  it("the row: its title opens its card, its bar a real progressbar named for the measure, its line marked when a best", () => {
    const html = render(createElement(QuestRow, { card: quest(), today: TODAY, onOpen: () => undefined }));
    expect(html).toMatch(/<button type="button" class="quest-open" aria-haspopup="dialog"><span class="quest-title">Stronger legs for ski season<\/span>/);
    expect(html).toContain('role="progressbar" aria-label="Wall sit hold" aria-valuemin="0" aria-valuemax="100" aria-valuenow="60" aria-valuetext="96 s of 120 s"');
    expect(html).toContain('style="width:60%"');
    expect(html).toContain('class="quest-best"');
    expect(html).toContain("Best ever this week · Wall sit hold 96 s");
  });

  it("the athlete's words are text, never markup", () => {
    const html = render(createElement(QuestRow, { card: quest({}, { title: "<b>bold</b> legs" }), today: TODAY, onOpen: () => undefined }));
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; legs");
    expect(html).not.toContain("<b>bold</b>");
  });
});

describe("the quests: the board's objectives and its actions, under Growth", () => {
  function questsHtml(board: ObjectiveBoardDto): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(OBJECTIVE_BOARD_QUERY, board);
    qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
    return render(createElement(ObjectivesScreen, { variant: "quests" }), { qc });
  }

  it("a Quests heading with New objective, one row per objective under way, the completed ones one tap down", () => {
    const done = quest({}, { status: "done" });
    const html = questsHtml({ today: TODAY, objectives: [quest(), { ...done, objective: { ...done.objective, id: "o2", title: "Run a half" } }] });
    expect(html).toMatch(/<h2 id="[^"]+" class="rank-item growth-h">Quests<\/h2>/);
    expect(html).toContain("New objective");
    expect(html.match(/class="quest quest--/g)).toHaveLength(1);
    expect(html).toContain("1 completed");
    expect(html).not.toContain("Run a half");
    // Not the board's page: no back link to the Studio, no page title, no full cards in the list.
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("stu-build-back");
    expect(html).not.toContain("obj-card");
  });

  it("no objectives: says so, quietly, with New objective beside the heading", () => {
    const html = questsHtml({ today: TODAY, objectives: [] });
    expect(html).toContain("No objectives yet.");
    expect(html).toContain("New objective");
  });
});

// ── The place ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Growth, the place", () => {
  function page(path: string, coach: boolean): string {
    features.coach = coach;
    features.studio = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(GROWTH_BODY_QUERY("month"), body());
    qc.setQueryData(GROWTH_BODY_QUERY("season"), body({ period: "season", carried: ["back"], quiet: null }));
    qc.setQueryData(["insights", "run"], emptyInsights());
    qc.setQueryData(["runs"], { activities: [] });
    qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
    qc.setQueryData(OBJECTIVE_BOARD_QUERY, { today: TODAY, objectives: [quest()] });
    return render(createElement(GrowthScreen), { qc, path });
  }

  it("one page title, the switch, then the body, the quests, the records and the activity, in that order", () => {
    const html = page("/growth", true);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("<h1>Growth</h1>");
    const order = ["Your body", "Quests", "Records", "Activity"].map((h) => html.indexOf(`>${h}</h2>`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Core and quads carried the month.");
    expect(html).toMatch(/aria-pressed="true">Month</);
  });

  it("?period=season reads the season", () => {
    const html = page("/growth?period=season", true);
    expect(html).toContain("Back carried the season.");
    expect(html).toMatch(/aria-pressed="true">Season</);
  });

  it("with the coach off: no quests (their read is the coach's)", () => {
    const html = page("/growth", false);
    expect(html).not.toContain(">Quests</h2>");
    expect(html).toContain("Records");
  });
});
