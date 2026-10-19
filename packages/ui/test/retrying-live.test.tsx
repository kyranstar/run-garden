// @vitest-environment jsdom
/**
 * A read that failed, read again: while the new read is out the screen says it is trying again, in the failure's own
 * place — never the failure's words, no longer true, then a jump to the content (2026-10-19). `settling` counts a failed
 * read as answered (so no gate loops), which left the old failure on the screen for as long as the read again took.
 * The read again is held back here, so the in-between is certain.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GardenScreen } from "../src/screens/garden.js";
import { GrowthActivity } from "../src/screens/growth/activity.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const failed = () => new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "Content-Type": "application/json" } });

/**
 * Every read fails; `path`'s reads are counted, and once `hold()` is called the next of them waits for `release()` (and
 * then fails too).
 */
function serve(path: string) {
  let reads = 0;
  let held: Promise<void> | null = null;
  let release: () => void = () => undefined;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.replace(/\?.*$/, "") === path) {
        reads += 1;
        if (held) await held;
      }
      return failed();
    }),
  );
  return {
    reads: () => reads,
    hold: () => {
      held = new Promise<void>((r) => (release = r));
    },
    release: async () => {
      const go = release;
      held = null;
      await act(async () => go());
    },
  };
}

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function show(client: QueryClient, el: ReactElement) {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, el)));
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${host?.textContent}`);
}
const text = () => (host?.textContent ?? "").replace(/\s+/g, " ");
const pause = () => act(async () => new Promise((r) => setTimeout(r, 50)));

describe("a failed read, read again (2026-10-19)", () => {
  it("the garden, come back to: “Trying again…” in the failure's place while the read is out, never the old failure", async () => {
    const api = serve("/api/garden");
    const client = qc();
    show(client, createElement(GardenScreen));
    await until(() => text().includes("Couldn't load the garden"), "the failure");
    const box = () => host!.querySelector(".empty")?.textContent ?? null;
    // Away, then back: the garden is read again, and that read is held.
    api.hold();
    show(client, createElement(GardenScreen));
    await pause();
    expect(api.reads()).toBe(2);
    expect(text()).not.toContain("Couldn't load the garden");
    expect(box()).toBe("Trying again…");
    // It fails again: said again, in the same place — and read no more.
    await api.release();
    await until(() => text().includes("Couldn't load the garden"), "the failure again");
    await pause();
    expect(api.reads()).toBe(2);
  });

  it("the activity, Try again: “Trying again…” in the banner's place while the read is out, the button waiting", async () => {
    const api = serve("/api/activities");
    show(qc(), createElement(GrowthActivity, { period: "month" }));
    // What the banner says (the unsaid one keeps its room, hidden from sight and from a screen reader).
    const said = () =>
      [...host!.querySelectorAll(".banner span")].filter((t) => t.getAttribute("aria-hidden") !== "true" && t.children.length === 0).map((t) => t.textContent).join(" ");
    const failure = "Couldn't load your activity — check your connection.";
    await until(() => said() === failure, "the failure");
    const banner = host!.querySelector(".banner");
    const again = () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Try again")!;
    api.hold();
    await act(async () => again().click());
    await pause();
    expect(api.reads()).toBe(2);
    expect(said()).toBe("Trying again…");
    // The same banner, in the same place: only its words changed.
    expect(host!.querySelector(".banner")).toBe(banner);
    expect(again().disabled).toBe(true);
    await api.release();
    await until(() => said() === failure, "the failure again");
    expect(host!.querySelector(".banner")).toBe(banner);
    expect(again().disabled).toBe(false);
  });
});
