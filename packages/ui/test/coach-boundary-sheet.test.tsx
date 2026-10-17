// @vitest-environment jsdom
/**
 * The robustness pass (2026-10-16), in the new shape: the screen survives its coach. With the whole conversation
 * throwing as it draws (CoachConversation replaced by one that throws), the coach's sheet still opens — its title and
 * ✕ — and says "Something went wrong showing the coach — reload"; the screen under it stands, and ✕ closes the sheet.
 * Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useCoach } from "../src/screens/studio/coach-ask.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { click, dialog, settle, text } from "./coach-live-harness.js";
import { primedClient, todayDto } from "./studio-fixtures.js";

vi.mock("../src/screens/studio/coach-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screens/studio/coach-conversation.js")>();
  return {
    ...actual,
    CoachConversation: () => {
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

function Screen() {
  const coach = useCoach();
  return createElement("div", null, createElement("p", null, "The rest of the screen"), createElement("button", { type: "button", id: "coach", onClick: () => coach?.open() }, "Coach"));
}

it("the conversation throwing as it draws: the sheet says so, the screen under it stands, and ✕ still closes it", async () => {
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
        createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(CoachSheetProvider, null, createElement(Screen))),
      ),
    );
  });
  await click(document.getElementById("coach"), "the Coach button");
  await settle(10);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Coach");
  expect(dialog()?.querySelector(".coach-broken")?.textContent).toContain("Something went wrong showing the coach — reload");
  expect(text()).toContain("The rest of the screen");
  await click(dialog()!.querySelector('button[aria-label="Close"]'), "✕");
  expect(dialog()).toBeNull();
});
