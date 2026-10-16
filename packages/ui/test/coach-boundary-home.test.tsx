// @vitest-environment jsdom
/**
 * The robustness pass (2026-10-16) — the Studio home survives its coach: with the whole coach area throwing as it
 * draws (StudioCoach replaced by one that throws), the home's own sections — quick starts, browse, themes — still show,
 * and the coach's slot says "Something went wrong showing the coach — reload". Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { StudioHome } from "../src/screens/studio/home.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { primedClient, todayDto } from "./studio-fixtures.js";

vi.mock("../src/screens/studio/composer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screens/studio/composer.js")>();
  return {
    ...actual,
    StudioCoach: () => {
      throw new Error("the coach failed to draw");
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("the coach throwing as it draws leaves the Studio home standing, and says so in its slot", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: primedClient({ today: todayDto(null) }) },
        createElement(MemoryRouter, { initialEntries: ["/studio"] }, createElement(StudioHome, { ctx: { ...emptyStudioCtx, profiles: [] }, onBrowse: () => undefined })),
      ),
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  const said = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(said).toContain("Something went wrong showing the coach — reload");
  expect(said).toContain("Quick starts");
  expect(said).toContain("Browse");
  expect(document.querySelector('[data-slot="coach-composer"] .coach-broken')).not.toBeNull();
});
