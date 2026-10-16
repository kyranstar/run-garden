/**
 * Stage 3 Task 9 — the `coach` switch. Decided by the build as `studio` is: on in DEV (the dev server, the fixture stack,
 * vitest), and in a production build only with `VITE_COACH_DESIGNER=1` — the Studio is on in production, the coach not
 * yet. It shows only where the Studio shows too. Off, nothing in the app shows the composer, the run view or a designed
 * suggestion, and nothing asks the coach's routes; the Plan coach sheet's link to it is there only when on.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { coachFlag, coachOn, features } from "../src/features.js";
import { CoachPanel } from "../src/screens/coach-panel.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { COACH_CURRENT_QUERY } from "../src/screens/studio/composer.js";
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

function coachPanel(): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        null,
        createElement(CoachPanel, { messages: [], proposals: [], question: null, onSend: noop, onApprove: noop, onDecline: noop, onAnswer: noop, onDismiss: noop }),
      ),
    ),
  );
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

  it("on: the Studio home's slot holds the composer, above the quick starts", () => {
    const html = studioHome();
    expect(html).toContain('placeholder="What would help today?"');
    expect(text(html)).toContain("Later today");
    expect(html.indexOf("What would help today?")).toBeLessThan(html.indexOf(">Quick starts</h2>"));
  });

  it("off: the slot is empty — no composer, no run view, no suggestion", () => {
    features.coach = false;
    const html = studioHome();
    expect(html).toContain('<div class="stu-composer-slot" data-slot="coach-composer"></div>');
    expect(html).not.toContain("What would help today?");
    expect(html).not.toContain("coach-run");
    expect(html).not.toContain("coach-pc");
  });

  it("the Plan coach sheet links to the composer only when on", () => {
    expect(coachPanel()).toContain('href="/studio"');
    expect(text(coachPanel())).toContain("Design a workout with the coach");
    features.coach = false;
    expect(text(coachPanel())).not.toContain("Design a workout with the coach");
    features.coach = true;
    features.studio = false;
    expect(text(coachPanel())).not.toContain("Design a workout with the coach");
  });
});
