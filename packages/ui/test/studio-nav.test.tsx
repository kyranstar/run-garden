/**
 * The Studio's pages (Stage 2 Task 4, reshaped 2026-10-17 by the new shape §3): the Studio is no tab any more — its
 * library is reached from the coach's opening screen and search — but every page keeps its route, with the wide
 * treatment `/plan` has, on `/studio` and everything under it. The flag that shipped the tab dark is gone from the
 * routes: the Studio is on in production (the owner's call, 2026-10-16), so its "off" branches were dead.
 */
import { Children, createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { Navigate, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { StudioRoute } from "../src/app.js";
import { features, studioFlag } from "../src/features.js";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { TemplatesScreen } from "../src/screens/studio/templates.js";
import { SaveBatchScreen, SavesScreen } from "../src/screens/studio/saves.js";
import { AppShell, NAV } from "../src/shell.js";
import { staticRouter } from "./studio-fixtures.js";

function shellAt(path: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      staticRouter(path, createElement(AppShell, { children: null })),
    ),
  );
}

describe("the Studio's pages", () => {
  it("are no tab: no nav entry leads to /studio", () => {
    expect(NAV.map((n) => n.to)).not.toContain("/studio");
    const html = shellAt("/studio");
    expect(html).not.toContain('href="/studio"');
  });

  it("the places' labels stay short enough for four equal controls at 320px", () => {
    // 320 / 4 = 80px a control; the 11.2px label must fit inside it (spec §15).
    for (const n of NAV) expect(n.label.length, n.label).toBeLessThanOrEqual(8);
  });

  it("get the wide treatment on /studio and below it, like /plan", () => {
    for (const path of ["/studio", "/studio/move/gobletSquat", "/plan"]) {
      expect(shellAt(path), path).toContain("shell-main--wide");
    }
    for (const path of ["/growth", "/settings", "/studios"]) {
      expect(shellAt(path), path).not.toContain("shell-main--wide");
    }
  });

  it("the app routes /studio, and everything under it, through one route", () => {
    const app = readFileSync(fileURLToPath(new URL("../src/app.tsx", import.meta.url)), "utf8");
    expect(app).toContain('<Route path="/studio/*" element={<StudioRoute />} />');
    expect(app).toMatch(/import \{ StudioScreen \} from "\.\/screens\/studio\/screen\.js";/);
  });

  it("/studio is the library, /studio/build/* the builder (Task 6), /studio/templates the templates (Task 7), /studio/saves[/:batchId] From your saves (saved-posts import); the objectives board's address goes to Growth", () => {
    const el = StudioRoute();
    expect(el.type).toBe(Routes);
    const routes = Children.toArray((el.props as { children: unknown }).children) as ReactElement<{ path: string; element: ReactElement }>[];
    expect(routes.map((r) => [r.props.path, r.props.element.type])).toEqual([
      ["build/*", BuilderRoute],
      ["templates", TemplatesScreen],
      ["saves", SavesScreen],
      ["saves/:batchId", SaveBatchScreen],
      ["objectives", Navigate],
      ["*", StudioScreen],
    ]);
    expect(routes.find((r) => r.props.path === "objectives")!.props.element.props).toEqual({ to: "/growth", replace: true });
  });

  it("the route no longer asks the build's flag: the Studio's pages answer whatever it says", () => {
    const was = features.studio;
    try {
      features.studio = false;
      expect(StudioRoute().type).toBe(Routes);
    } finally {
      features.studio = was;
    }
  });
});

describe("the `studio` build flag (still read by the session sheet's Edit)", () => {
  it("is decided by the build: on in dev, tests and the fixture stack; off in a production build unless VITE_STUDIO=1", () => {
    expect(studioFlag({ DEV: true, PROD: false })).toBe(true);
    expect(studioFlag({ DEV: false, PROD: true })).toBe(false);
    expect(studioFlag({ DEV: false, PROD: true, VITE_STUDIO: "1" })).toBe(true);
    expect(studioFlag({ DEV: false, PROD: true, VITE_STUDIO: "0" })).toBe(false);
    expect(studioFlag(undefined)).toBe(false);
    expect(features.studio).toBe(true);
  });
});
