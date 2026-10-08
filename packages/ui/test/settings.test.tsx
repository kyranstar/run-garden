/**
 * Settings — the distance unit (units sweep, 2026-08), which Phase 2c moved
 * from Scheduling to the Units card (mocks §7; its saving is tested in
 * settings-cards.test.tsx), and the race course climb's unit beside its box.
 * Static-markup render, same harness as studio-modal.test.tsx.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import { SchedulingSection, UnitsSection } from "../src/screens/settings.js";

function render(prefs: UserPreferences): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(SchedulingSection, { prefs })),
  );
}

describe("the distance unit (moved to the Units card, Phase 2c)", () => {
  const units = (prefs: UserPreferences) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(UnitsSection, { prefs })));
  };

  it("Scheduling no longer carries it; the Units card offers km and mi", () => {
    expect(render(DEFAULT_USER_PREFERENCES)).not.toContain('id="s-units"');
    const html = units(DEFAULT_USER_PREFERENCES);
    expect(html).toContain('aria-label="Distance"');
    expect(html).toMatch(/>km</);
    expect(html).toMatch(/>mi</);
  });

  it("binds to prefs.units — km prefs press km, mi prefs press mi", () => {
    expect(units(DEFAULT_USER_PREFERENCES)).toMatch(/aria-label="Distance"><button type="button" aria-pressed="true">km</);
    expect(units({ ...DEFAULT_USER_PREFERENCES, units: "mi" })).toMatch(/aria-pressed="true">mi</);
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
