/**
 * Settings — the distance unit (units sweep, 2026-08), which Phase 2c moved
 * from Scheduling to the Units card (mocks §7; its saving is tested in
 * settings-cards.test.tsx), and the race course climb's unit beside its box
 * (the Race card since the new shape). Static-markup render.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import { RaceSection, SchedulingSection, UnitsSection } from "../src/screens/settings.js";
import { CoachAiSection } from "../src/screens/settings/coach-settings.js";

function render(prefs: UserPreferences, card: typeof SchedulingSection | typeof RaceSection = SchedulingSection): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(card, { prefs })),
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
    const mi = render({ ...DEFAULT_USER_PREFERENCES, units: "mi", raceCourseClimbMetres: 42.7 }, RaceSection);
    expect(mi).toContain(">ft</b>");
    expect(mi).toContain('value="140"');

    const km = render({ ...DEFAULT_USER_PREFERENCES, units: "km", raceCourseClimbMetres: 140 }, RaceSection);
    expect(km).toContain(">m</b>");
    expect(km).toContain('value="140"');
  });
});

describe("the Coach & AI card", () => {
  // The AI plan generator that sat in the Plan screen's plan modal is retired (Stage 2 spec §2); the card no longer
  // lists it among what is AI-powered. Its switch names the AI that runs unasked, in a short line (the new shape).
  it("its switch names the AI that runs without asking — and not the retired plan generator", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(CoachAiSection, { prefs: DEFAULT_USER_PREFERENCES })));
    expect(html).toContain('role="switch"');
    expect(html).toContain("The only AI that runs without you asking.");
    expect(html).not.toContain("plan generation");
  });
});
