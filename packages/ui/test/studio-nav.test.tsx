/**
 * Stage 2 Task 4 — the Studio is the fifth tab (spec §2): Garden · Plan · Studio · Activity · Settings, in the bottom
 * bar and the side rail alike, with the wide treatment `/plan` has, on `/studio` and everything under it.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
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

/** The links of one nav (`bottom-nav` or `side-nav`), in order, as [href, text]. */
function links(html: string, nav: string): Array<[string, string]> {
  const at = html.indexOf(`class="${nav}"`);
  expect(at, nav).toBeGreaterThan(-1);
  const body = html.slice(at, html.indexOf("</nav>", at));
  return [...body.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]+>/g, "").trim()]);
}

describe("the Studio tab", () => {
  it("NAV has five entries, Studio between Plan and Activity", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Garden", "Plan", "Studio", "Activity", "Settings"]);
    expect(NAV.map((n) => n.to)).toEqual(["/", "/plan", "/studio", "/runs", "/settings"]);
  });

  it("both navs carry it, in that order, and mark it current on /studio", () => {
    const html = shellAt("/studio");
    const expected: Array<[string, string]> = [
      ["/", "Garden"],
      ["/plan", "Plan"],
      ["/studio", "Studio"],
      ["/runs", "Activity"],
      ["/settings", "Settings"],
    ];
    expect(links(html, "bottom-nav")).toEqual(expected);
    expect(links(html, "side-nav")).toEqual(expected);
    expect(html).toMatch(/<a aria-current="page" class="active" href="\/studio">/);
  });

  it("the labels stay short enough for five equal links at 320px", () => {
    // 320 / 5 = 64px a link; the 11.2px label must fit inside it (spec §15).
    for (const n of NAV) expect(n.label.length, n.label).toBeLessThanOrEqual(8);
  });

  it("gets the wide treatment on /studio and below it, like /plan", () => {
    for (const path of ["/studio", "/studio/move/gobletSquat", "/plan"]) {
      expect(shellAt(path), path).toContain("shell-main--wide");
    }
    for (const path of ["/runs", "/settings", "/studios"]) {
      expect(shellAt(path), path).not.toContain("shell-main--wide");
    }
  });

  it("the app routes /studio to the Studio screen", () => {
    const app = readFileSync(fileURLToPath(new URL("../src/app.tsx", import.meta.url)), "utf8");
    expect(app).toContain('<Route path="/studio" element={<StudioScreen />} />');
    expect(app).toMatch(/import \{ StudioScreen \} from "\.\/screens\/studio\/screen\.js";/);
  });
});
