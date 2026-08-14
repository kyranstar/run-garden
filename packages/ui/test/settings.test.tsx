/**
 * Settings — the "Distance & pace units" selector (units sweep, 2026-08).
 * SchedulingSection binds the select to draft.units like every other field;
 * the save mutation already sends the whole draft, so no new wiring exists
 * to test beyond the render: both options, the hint, and the bound value.
 * Static-markup render, same harness as studio-modal.test.tsx.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import { SchedulingSection } from "../src/screens/settings.js";

function render(prefs: UserPreferences): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(SchedulingSection, { prefs })),
  );
}

describe("SchedulingSection units selector", () => {
  it("renders the select with both options and the everywhere-follows hint", () => {
    const html = render(DEFAULT_USER_PREFERENCES);
    expect(html).toContain("Distance &amp; pace units");
    expect(html).toContain('id="s-units"');
    expect(html).toContain(">Kilometers<");
    expect(html).toContain(">Miles<");
    expect(html).toContain("Paces and distances everywhere follow this.");
  });

  it("binds to draft.units — km prefs select Kilometers, mi prefs select Miles", () => {
    const km = render(DEFAULT_USER_PREFERENCES); // schema default is km
    expect(km).toMatch(/<option value="km" selected="">/);
    const mi = render({ ...DEFAULT_USER_PREFERENCES, units: "mi" });
    expect(mi).toMatch(/<option value="mi" selected="">/);
  });
});

describe("race course climb field", () => {
  it("labels the unit beside the input and converts for a miles athlete", () => {
    // 140 ft typed into a field that silently meant metres is off by 3.3×
    // (live-reported 2026-08-14) — the unit must stay visible once the box
    // has a value in it.
    const mi = render({ ...DEFAULT_USER_PREFERENCES, units: "mi", raceCourseClimbMetres: 42.7 });
    expect(mi).toContain(">ft</b>");
    expect(mi).toContain('value="140"');

    const km = render({ ...DEFAULT_USER_PREFERENCES, units: "km", raceCourseClimbMetres: 140 });
    expect(km).toContain(">m</b>");
    expect(km).toContain('value="140"');
  });
});
