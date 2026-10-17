/**
 * THE NEW SHAPE, THE COPY (stream B): the app describes what it is now — runs, strength and mobility, with a coach and
 * a garden — in the manifest, the welcome, onboarding and the empty states. One tagline everywhere it is said.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WelcomeScreen } from "../src/screens/welcome.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TAGLINE = "Runs, strength and mobility, fitted to your real week.";

describe("one tagline that names all three", () => {
  it("the installed app's description", () => {
    expect(read("../../../apps/web/vite.config.ts")).toContain(`description: "${TAGLINE}"`);
  });

  it("the welcome", () => {
    expect(renderToStaticMarkup(createElement(WelcomeScreen, {}))).toContain(TAGLINE);
  });

  it("onboarding's first step, and what it says the app does", () => {
    const src = read("../src/screens/onboarding.tsx");
    expect(src).toContain(TAGLINE);
    expect(src).not.toContain("Your COROS plan, fitted to your real week.");
    expect(src).toMatch(/coach/i);
  });
});

describe("the garden is fed by every kind of session", () => {
  it("onboarding's garden step speaks of sessions, not runs alone", () => {
    const src = read("../src/screens/onboarding.tsx");
    expect(src).toContain("Every planned session you finish waters the garden");
    expect(src).toContain("A few missed sessions are easy to recover from.");
    expect(src).not.toContain("Every completed planned run waters the garden.");
  });
});

describe("the empty states invite all three", () => {
  it("Today with nothing planned: the coach for a run, strength or mobility — or a plan in COROS", () => {
    const src = read("../src/screens/garden.tsx");
    expect(src).toContain('title="Nothing planned yet"');
    expect(src).toContain("Ask the coach for a run, a strength session or some mobility");
    expect(src).not.toContain("No active COROS training plan was found");
  });

  it("Plan with nothing planned: the coach first", () => {
    expect(read("../src/screens/plan.tsx")).toContain("Ask the coach for a plan, or start one in COROS");
  });
});
