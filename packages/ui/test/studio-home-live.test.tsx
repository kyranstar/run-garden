// @vitest-environment jsdom
/**
 * The Studio home holds still while it is read (UX System 4: a query resolving moves nothing at or above what the
 * reader can touch). Which quick starts it offers is decided by its reads — a switched-on profile's care tile (the
 * library and today reads), a pinned template (the templates read) — and a tile that arrives late wraps the row and pushes
 * everything under it down: on a slow phone (CI's WebKit, 2026-10-19) the profile's tile landed between the tap's aim
 * and the tap, and "Templates" was tapped where it no longer was. So nothing under the field is drawn until those
 * reads have answered, and then it is drawn once.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { libraryDto, placesDto, profileDto, TODAY, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

/**
 * The Studio at /studio, every read answered at once but the library's, which waits for `release`. `templatesFail`: the
 * templates read answers 503, every time.
 */
function mountHeld({ templatesFail = false } = {}) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      if (path === "/api/library") {
        await held;
        return json(libraryDto({ tmj: true }));
      }
      if (path === "/api/templates") return templatesFail ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }) : json({ templates: [] });
      // Today names no profile here: the care tile is the library's to decide.
      if (path === "/api/plan/today") return json(todayDto(null, false));
      if (path === "/api/places") return json(placesDto(["dumbbells"]));
      if (path === "/api/profile") return json(profileDto());
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: ["/studio"] }, createElement(StudioScreen))));
  });
  return { release: async () => act(async () => release()) };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}

const tiles = () => [...document.querySelectorAll(".stu-qs")].map((t) => t.textContent ?? "");
const templatesLink = () => document.querySelector(".stu-tpl-link");

describe("the Studio home holds still while it is read (2026-10-19)", () => {
  it("draws nothing under the field — no tiles, no Templates link — until the reads that decide them answer; then once, with the care tile first", async () => {
    const { release } = mountHeld();
    // Everything else has answered; the library (the switched-on profiles) has not.
    await until(() => (vi.mocked(fetch).mock.calls as unknown[][]).some(([u]) => String(u).startsWith("/api/templates")), "the reads to go out");
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.querySelector('[role="search"]')).not.toBeNull();
    expect(tiles()).toEqual([]);
    expect(templatesLink()).toBeNull();
    expect(document.querySelector(".stu-home [role=status]")?.textContent).toBe("Loading the Studio");

    await release();
    await until(() => templatesLink() !== null, "the Templates link");
    expect(tiles()[0]).toMatch(/^Jaw care/);
    expect(templatesLink()!.textContent).toBe("Templates (0)");
  });

  it("drawn, it stays drawn: a templates read that fails is no spinner again, nor a read over and over", async () => {
    const { release } = mountHeld({ templatesFail: true });
    await release();
    await until(() => templatesLink() !== null, "the Templates link");
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    expect(templatesLink()!.textContent).toBe("Templates");
    expect(document.querySelector(".stu-home [role=status]")).toBeNull();
    // Read when the home asked, and once more when the quick starts mounted and found it failed: no more.
    const reads = (vi.mocked(fetch).mock.calls as unknown[][]).filter(([u]) => String(u).startsWith("/api/templates")).length;
    expect(reads).toBeLessThanOrEqual(2);
  });
});
