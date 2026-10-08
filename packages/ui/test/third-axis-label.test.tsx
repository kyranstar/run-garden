/**
 * The third garden axis reads "Yoga & mobility" wherever it is rendered (Phase 2d Task 4; spec §2d): the balance
 * meters, an axis's detail panel, the weakest-axis line, the codex's discipline chip, the life-tended arrival line and
 * the Activity page's discipline filter. Display strings only — the `yoga` key, ids and the garden's discipline stay,
 * and a yoga SESSION is still "Yoga" (its category, its sport, its noun).
 */
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DisciplineBalance, InsightsResponse } from "@rg/api-client";
import { disciplineLabel, sessionNoun } from "@rg/analytics";
import { sportLabel } from "@rg/domain";
import { initialSnapshot, type GardenEvent } from "@rg/garden-engine";
import { CATEGORY_LABELS } from "../src/components.js";
import { BalanceDetail, BalanceStrip } from "../src/screens/garden.js";
import { NUDGE_DISCIPLINE_LABEL } from "../src/screens/codex.js";
import { eventSentence } from "../src/screens/arrival.js";
import { RunsScreen } from "../src/screens/runs.js";

const LABEL = "Yoga &amp; mobility"; // as React escapes it in markup

/** The dashboard's structural query, empty (the runs-units.test.tsx shape). */
const emptyInsights = () =>
  ({
    discipline: "run",
    availableDisciplines: ["run"],
    consistency: {
      planned: 0, completed: 0, skipped: 0, missed: 0, moved: 0, pending: 0,
      unresolved: 0, adherenceRate: 0, weeklyBreakdown: [], days: [],
    },
    weekly: { weeks: [], fourWeekAvgDuration: null },
    records: [],
    evidence: null,
    reviews: [],
    interpreted: [],
  }) as unknown as InsightsResponse;

const balance = (over: Partial<DisciplineBalance> = {}): DisciplineBalance => ({
  run: { days: 4, health: 0.6 },
  strength: { days: 2, health: 0.8 },
  yoga: { days: 1, health: 0.9 },
  overall: 0.75,
  ...over,
});

const withClient = (child: ReturnType<typeof createElement>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["settings"], { prefs: { units: "km" } });
  qc.setQueryData(["runs"], { activities: [] });
  qc.setQueryData(["insights", "run"], emptyInsights());
  // React separates adjacent text nodes with `<!-- -->`; the words are what is asserted.
  return render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, child))).replace(
    /<!-- -->/g,
    "",
  );
};

describe('the third axis is "Yoga & mobility" wherever it is rendered', () => {
  it("the balance meters: Run, Lift, Yoga & mobility — and the bar's accessible name says so too", () => {
    const html = render(createElement(BalanceStrip, { balance: balance() }));
    const labels = [...html.matchAll(/<div class="balance-bar-label"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Run", "Lift", LABEL]);
    expect(html).toContain(`aria-label="${LABEL}: `);
    expect(html).toContain("last yoga &amp; mobility 1 d ago");
  });

  it("the weakest-axis line names it", () => {
    const html = render(
      createElement(BalanceStrip, { balance: balance({ yoga: { days: 9, health: 0.1 }, overall: 0.3 }) }),
    );
    expect(html).toContain("The garden misses your yoga &amp; mobility.");
  });

  it("the axis's detail panel: its heading, what it feeds, and the week's line", () => {
    const html = withClient(
      createElement(BalanceDetail, {
        k: "yoga",
        balance: balance(),
        snapshot: initialSnapshot("2026-10-01"),
        trio: {},
        todayDate: "2026-10-07",
        onOpenSpecies: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain(`aria-label="${LABEL} details"`);
    expect(html).toContain(`<strong>${LABEL}</strong>`);
    expect(html).toContain("Yoga &amp; mobility tend the meadow&#x27;s life");
    expect(html).toContain(`Lift – · ${LABEL} –`);
  });

  it("the codex's discipline chip, the arrival line and the shared discipline label", () => {
    expect(NUDGE_DISCIPLINE_LABEL).toEqual({ run: "Run", strength: "Lift", yoga: "Yoga & mobility" });
    expect(eventSentence({ kind: "life_tended", date: "2026-10-07", seq: 1 } as GardenEvent)).toBe(
      "Yoga & mobility brought the meadow back to life.",
    );
    expect(disciplineLabel("yoga")).toBe("Yoga & mobility");
    expect(disciplineLabel("run")).toBe("Running");
    expect(disciplineLabel("strength")).toBe("Strength");
  });

  it("the Activity page's discipline filter", () => {
    const html = withClient(createElement(RunsScreen));
    const chips = [...html.matchAll(/role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(chips).toEqual(["All", "Runs", "Lifting", LABEL, "Adventures"]);
  });

  it("a yoga SESSION keeps its own words: category, sport and noun stay yoga", () => {
    expect(CATEGORY_LABELS.yoga).toBe("Yoga");
    expect(sportLabel("yoga")).toBe("Yoga");
    expect(sessionNoun("yoga")).toBe("yoga session");
  });
});
