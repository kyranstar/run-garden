// @vitest-environment jsdom
/**
 * THE NEW SHAPE, THE NAV (2026-10-17 design §3): three places — Today, Plan, Growth — and one coach in the middle.
 *
 *  - Phones: a bottom bar of four: Today · Plan · Coach (a filled sprout pill, a real button) · Growth. Settings is the
 *    athlete's mark at the top right of each place.
 *  - From lg: the rail — Today, Plan, Coach, Growth — with Settings at its foot.
 *  - Routes: `/` Today, `/plan`, `/growth` (`/runs`, `/insights` and `/studio/objectives` go there), `/settings`; the
 *    Studio's pages keep their routes but `/studio` is no tab; `/garden` is gone (one home).
 *
 * The Coach button opens the app's one coach sheet (`useCoach().open`), and is not drawn without it.
 */
import { act, createElement, useContext, type ReactElement } from "react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell, NAV } from "../src/shell.js";
import { SceneMarkContext } from "../src/scene-mark.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });

function wrap(path: string, el: ReactElement, coach: CoachOpener | null): ReactElement {
  const routed = createElement(MemoryRouter, { initialEntries: [path] }, el);
  return createElement(QueryClientProvider, { client: client() }, coach ? createElement(CoachOpenContext.Provider, { value: coach }, routed) : routed);
}

/** The page: on Today, it wears whatever mark the shell hands its picture (scene-mark.ts). */
const Page = () => createElement("div", { className: "probe-page" }, useContext(SceneMarkContext));

function shellAt(path: string, coach: CoachOpener | null = { open: () => undefined }, who: string | null = "sam@example.test"): string {
  return renderToStaticMarkup(wrap(path, createElement(AppShell, { who, children: createElement(Page) }), coach));
}

/** One nav's controls, in order, as [kind, href or "", text] — links and buttons alike. */
function controls(html: string, nav: string): Array<[string, string, string]> {
  const at = html.indexOf(`class="${nav}"`);
  expect(at, nav).toBeGreaterThan(-1);
  const body = html.slice(at, html.indexOf("</nav>", at));
  return [...body.matchAll(/<(a|button) ([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => [
    m[1]!,
    /href="([^"]+)"/.exec(m[2]!)?.[1] ?? "",
    m[3]!.replace(/<[^>]+>/g, "").trim(),
  ]);
}

const src = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");
const app = src("app.tsx");
const css = src("styles.css");

describe("three places and one coach", () => {
  it("NAV is the three places: Today, Plan, Growth", () => {
    expect(NAV.map((n) => [n.to, n.label])).toEqual([
      ["/", "Today"],
      ["/plan", "Plan"],
      ["/growth", "Growth"],
    ]);
  });

  it("the phone's bar: Today · Plan · Coach · Growth, the Coach a button in the middle", () => {
    expect(controls(shellAt("/"), "bottom-nav")).toEqual([
      ["a", "/", "Today"],
      ["a", "/plan", "Plan"],
      ["button", "", "Coach"],
      ["a", "/growth", "Growth"],
    ]);
  });

  it("the rail: the same four, then Settings at its foot", () => {
    const rail = controls(shellAt("/plan"), "side-nav");
    expect(rail).toEqual([
      ["a", "/", "Today"],
      ["a", "/plan", "Plan"],
      ["button", "", "Coach"],
      ["a", "/growth", "Growth"],
      ["a", "/settings", "Settings"],
    ]);
    const html = shellAt("/plan");
    const foot = html.slice(html.indexOf('class="nav-footer"'));
    expect(foot).toContain('href="/settings"');
  });

  it("no Studio tab, no Activity tab, no Settings tab in the phone's bar", () => {
    const html = shellAt("/");
    for (const nav of ["bottom-nav", "side-nav"]) {
      const texts = controls(html, nav).map(([, , t]) => t);
      expect(texts, nav).not.toContain("Studio");
      expect(texts, nav).not.toContain("Activity");
      expect(texts, nav).not.toContain("Garden");
    }
    expect(controls(html, "bottom-nav").map(([, h]) => h)).not.toContain("/settings");
  });

  it("the Coach is a filled sprout pill: a real button, named Coach, its sprout hidden from readers", () => {
    const html = shellAt("/");
    const at = html.indexOf('class="bottom-nav"');
    const bar = html.slice(at, html.indexOf("</nav>", at));
    const button = /<button ([^>]*)>([\s\S]*?)<\/button>/.exec(bar)!;
    expect(button[1]).toContain('type="button"');
    expect(button[1]).toContain('class="nav-coach"');
    expect(button[2]).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(button[2].replace(/<[^>]+>/g, "")).toBe("Coach");
    // Filled: the green fill and the ink that sits on an accent fill, in both themes (tokens only).
    const rule = /\n\.nav-coach-pill \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("background: var(--green)");
    expect(rule).toContain("color: var(--on-accent)");
    expect(rule).toContain("border-radius: var(--radius-pill)");
  });

  it("the Coach is the place marked current never: it is a button, not a page", () => {
    expect(shellAt("/")).toMatch(/<a aria-current="page" class="active" href="\/">/);
    expect(shellAt("/growth")).toMatch(/<a aria-current="page" class="active" href="\/growth">/);
  });

  it("without the coach's sheet in the app, no Coach button: the three places alone", () => {
    expect(controls(shellAt("/", null), "bottom-nav")).toEqual([
      ["a", "/", "Today"],
      ["a", "/plan", "Plan"],
      ["a", "/growth", "Growth"],
    ]);
  });

  it("the Coach button keeps the run keeper's quiet mark beside its word (a run going on any screen)", () => {
    const shell = src("shell.tsx");
    expect(shell).toContain("<CoachNavMark />");
    expect(shell).not.toContain("StudioMark");
  });
});

describe("Settings is the athlete's mark (phones)", () => {
  it("each place carries the mark at its top right (Today's on its picture): a link to Settings, named so, showing the athlete's initial", () => {
    for (const path of ["/", "/plan", "/growth"]) {
      const html = shellAt(path);
      const mark = /<a ([^>]*class="athlete-mark"[^>]*)>([\s\S]*?)<\/a>/.exec(html);
      expect(mark, path).not.toBeNull();
      expect(mark![1]).toContain('href="/settings"');
      expect(mark![1]).toContain('aria-label="Settings"');
      expect(mark![2].replace(/<[^>]+>/g, "")).toBe("S");
    }
  });

  it("with no address known, the mark is the settings glyph", () => {
    const html = shellAt("/", { open: () => undefined }, null);
    const mark = /<a ([^>]*class="athlete-mark"[^>]*)>([\s\S]*?)<\/a>/.exec(html)!;
    expect(mark[2]).toContain("<svg");
  });

  it("not on Settings itself, nor on the Studio's pages (they are not places)", () => {
    for (const path of ["/settings", "/studio", "/studio/move/gobletSquat"]) {
      expect(shellAt(path), path).not.toContain('class="athlete-mark"');
    }
  });

  it("the mark leaves at lg, where the rail's foot holds Settings", () => {
    const lg = [...css.matchAll(/@media \(min-width: 1024px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]!).join("\n");
    expect(lg).toMatch(/\.athlete-row \{\s*display: none;/);
  });

  it("on a row of its own above the page: never over a banner or a place's title row", () => {
    const html = shellAt("/plan");
    expect(html).toMatch(/<div class="athlete-row"><a [^>]*class="athlete-mark"/);
    const rule = /\.athlete-mark \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).not.toContain("position: absolute");
    // First in the page's column: before the banners (staging, fixture, an unfinished restore).
    expect(html.indexOf('class="athlete-row"')).toBeLessThan(html.indexOf("A restore") === -1 ? html.length : html.indexOf("A restore"));
  });

  it("a 44 px target", () => {
    const rule = /\.athlete-mark \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("min-width: var(--tap)");
    expect(rule).toContain("min-height: var(--tap)");
  });
});

describe("the routes", () => {
  it("/growth is a place; /runs, /insights and /studio/objectives go there", () => {
    expect(app).toMatch(/<Route\s+path="\/growth"\s+element=\{/);
    expect(app).toContain('<Route path="/runs" element={<Navigate to="/growth" replace />} />');
    expect(app).toContain('<Route path="/insights" element={<Navigate to="/growth" replace />} />');
    expect(app).toContain('<Route path="objectives" element={<Navigate to="/growth" replace />} />');
  });

  it("/growth is Growth's own screen; Activity's file is gone", () => {
    const route = app.slice(app.indexOf('path="/growth"'), app.indexOf('path="/runs"'));
    expect(route).toContain("<GrowthScreen />");
    expect(app).toContain('import { GrowthScreen } from "./screens/growth/index.js";');
    expect(app).not.toContain("RunsScreen");
    expect(existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/screens/runs.tsx"))).toBe(false);
    // A retry reads again what Growth draws: its activity, its signals, the body map and the quests.
    for (const key of ['["runs"]', '["insights"]', '["growth"]', '["objectives", "board"]']) expect(route).toContain(`queryKey: ${key}`);
  });

  it("one home: /garden is no route of its own", () => {
    expect(app).not.toContain('path="/garden"');
  });

  it("the Studio's pages keep their routes, though /studio is no tab", () => {
    expect(app).toContain('<Route path="/studio/*" element={<StudioRoute />} />');
    expect(app).toContain('<Route path="build/*" element={<BuilderRoute />} />');
    expect(app).toContain('<Route path="templates" element={<TemplatesScreen />} />');
  });

  it("the immersive home is / alone", () => {
    expect(shellAt("/")).toContain("shell-main--immersive");
    expect(shellAt("/garden")).not.toContain("shell-main--immersive");
  });
});

describe("the Coach button opens the coach", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("a tap opens the sheet with nothing written (what the screen shows, the sheet picks up itself)", () => {
    const calls: unknown[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(wrap("/plan", createElement(AppShell, { who: null, children: null }), { open: (a) => calls.push(a) })));
    const buttons = host.querySelectorAll<HTMLButtonElement>("button.nav-coach");
    expect(buttons.length).toBe(2); // the bar's and the rail's: CSS shows one per tier
    act(() => buttons[0]!.click());
    expect(calls).toEqual([undefined]);
  });
});
