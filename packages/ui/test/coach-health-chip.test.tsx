// @vitest-environment jsdom
/**
 * THE IMPORT'S HEALTH, WHERE THE OWNER LOOKS (audit 2026-11-06, I2): the health row showed only on the coach's saves
 * card while a batch was open. Now the coach's header carries a compact chip whenever a light is red or yellow — the
 * worst light and its word — and a tap opens the health row itself. Nothing while every light is green or grey, or the
 * health can't be read. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIGHTS, worstLight, type HealthColor, type HealthLightDto, type ImportHealthDto } from "@rg/saves";
import { CoachHealthChip } from "../src/screens/studio/coach-health.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = (colors: Partial<Record<HealthLightDto["light"], HealthColor>>, worst: string | null): ImportHealthDto => ({
  lights: HEALTH_LIGHTS.map((light) => ({ light, color: colors[light] ?? "green", line: colors[light] && colors[light] !== "grey" ? worst : null, failures: [] })),
  worst,
});

let root: Root | null = null;
let host: HTMLElement;

async function mount(answer: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/my-saves/health"
        ? new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } }),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(CoachHealthChip)));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const chip = () => host.querySelector<HTMLButtonElement>("button.coach-health-chip");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("worstLight", () => {
  it("is the first red light, else the first yellow, else none (grey is never a problem)", () => {
    expect(worstLight(health({ youtube: "yellow", reader: "red" }, "x"))?.light).toBe("reader");
    expect(worstLight(health({ youtube: "yellow", coach: "yellow" }, "x"))?.light).toBe("youtube");
    expect(worstLight(health({ youtube: "grey" }, null))).toBeNull();
    expect(worstLight(null)).toBeNull();
  });
});

describe("the coach's health chip", () => {
  it("a red light: the chip names it and its word; a tap opens the health row", async () => {
    await mount({ status: 200, body: health({ reader: "red" }, "Reader: 3 of 4 failed") });
    expect(chip()!.textContent).toBe("✕Reader failing");
    expect(chip()!.getAttribute("aria-label")).toBe("Import health: Reader failing");
    await act(async () => chip()!.click());
    const sheet = document.querySelector("[role=dialog]")!;
    expect(sheet).toBeTruthy();
    expect(sheet.querySelector("[aria-label='Import health']")!.querySelectorAll("button.health-light")).toHaveLength(7);
    expect(sheet.textContent).toContain("Reader: 3 of 4 failed");
  });

  it("a yellow light: the chip says it needs a look", async () => {
    await mount({ status: 200, body: health({ youtube: "yellow" }, "Sign in to YouTube in Chrome") });
    expect(chip()!.textContent).toBe("!YouTube needs a look");
  });

  it("all green, grey only, or no health read: no chip", async () => {
    await mount({ status: 200, body: health({}, null) });
    expect(chip()).toBeNull();
    act(() => root!.unmount());
    await mount({ status: 200, body: health({ youtube: "grey", coach: "grey" }, null) });
    expect(chip()).toBeNull();
    act(() => root!.unmount());
    await mount({ status: 404, body: { error: "not_found" } });
    expect(chip()).toBeNull();
  });
});
