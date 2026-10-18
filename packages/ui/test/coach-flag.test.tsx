/**
 * Stage 3 Task 9 — the `coach` switch. Decided by the build as `studio` is: on in DEV (the dev server, the fixture stack,
 * vitest), and in a production build only with `VITE_COACH_DESIGNER=1` — production's build sets it since 2026-10-16.
 * It shows only where the Studio shows too. On or off, the Studio home holds no coach (the new shape: it is one
 * conversation, opened from the nav).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { coachFlag, coachOn, features } from "../src/features.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { COACH_CURRENT_QUERY } from "../src/screens/studio/run-keeper.js";
import { primedClient, staticRouter, text } from "./studio-fixtures.js";

const was = { coach: features.coach, studio: features.studio };
afterEach(() => {
  features.coach = was.coach;
  features.studio = was.studio;
});

/** The Studio home, the current run read as none. */
function studioHome(): string {
  const qc = primedClient();
  qc.setQueryData(COACH_CURRENT_QUERY, { run: null });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter("/studio", createElement(StudioScreen))));
}

describe("the coach switch", () => {
  it("is decided by the build: on in dev, tests and the fixture stack; off in a production build unless VITE_COACH_DESIGNER=1", () => {
    expect(coachFlag({ DEV: true, PROD: false })).toBe(true);
    expect(coachFlag({ DEV: false, PROD: true })).toBe(false);
    // The Studio on in production does not turn the coach on.
    expect(coachFlag({ DEV: false, PROD: true, VITE_STUDIO: "1" })).toBe(false);
    expect(coachFlag({ DEV: false, PROD: true, VITE_COACH_DESIGNER: "1" })).toBe(true);
    expect(coachFlag({ DEV: false, PROD: true, VITE_COACH_DESIGNER: "0" })).toBe(false);
    expect(coachFlag(undefined)).toBe(false);
    // vitest is a dev build.
    expect(features.coach).toBe(true);
  });

  it("shows only where the Studio does", () => {
    features.coach = true;
    features.studio = true;
    expect(coachOn()).toBe(true);
    features.studio = false;
    expect(coachOn()).toBe(false);
    features.studio = true;
    features.coach = false;
    expect(coachOn()).toBe(false);
  });

  it("on or off, the Studio home holds no coach: the coach is one conversation, opened from the nav (the new shape)", () => {
    for (const on of [true, false]) {
      features.coach = on;
      const html = studioHome();
      expect(html).not.toContain("coach-composer");
      expect(html).not.toContain("coach-run");
      expect(html).not.toContain("coach-pc");
      expect(text(html)).toContain("Quick starts");
    }
  });

  });
