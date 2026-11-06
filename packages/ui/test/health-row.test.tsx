// @vitest-environment jsdom
/**
 * THE HEALTH ROW (design 2026-11-05 §3.2; plan Task 13): seven labelled lights — each a glyph and a word as well as its
 * colour, grey (nothing to judge) never green — the worst light's line under the row when one isn't green, and a tap on
 * a light listing its failures: the post, when, why, and Retry where there is a post to retry. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIGHTS, type HealthColor, type HealthLightDto, type ImportHealthDto } from "@rg/saves";
import { HealthRow, redLine } from "../src/screens/saves/health-row.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const light = (l: HealthLightDto["light"], color: HealthColor, over: Partial<HealthLightDto> = {}): HealthLightDto => ({ light: l, color, line: null, failures: [], ...over });
const health = (colors: Partial<Record<HealthLightDto["light"], HealthColor>> = {}, over: Partial<Record<HealthLightDto["light"], Partial<HealthLightDto>>> = {}, worst: string | null = null): ImportHealthDto => ({
  lights: HEALTH_LIGHTS.map((l) => light(l, colors[l] ?? "green", over[l])),
  worst,
});

const AT = "2026-11-03T12:00:00.000Z";
const RED_READER = health(
  { reader: "red", youtube: "grey" },
  {
    reader: {
      line: "Reader: 3 of 4 failed",
      failures: [
        { postId: "p1", title: "Zorbex hip flow", at: AT, why: "The reply didn't match the format: moves.0.dose: Required" },
        { postId: null, title: "Reader", at: AT, why: "The model gateway answered 402" },
      ],
    },
  },
  "Reader: 3 of 4 failed",
);

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body: unknown }>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function mount(h: ImportHealthDto, compact = false) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      calls.push({ method: req?.method ?? "GET", path: url, body: req?.body ? JSON.parse(String(req.body)) : null });
      if (url === "/api/my-saves/posts/p1/override") return json({ ok: true });
      if (url === "/api/my-saves/posts/p1/trail") return json({ error: "not_found" }, 404);
      return json({ error: "not_found" }, 404);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(HealthRow, { health: h, compact })));
  });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const lights = () => [...host.querySelectorAll<HTMLButtonElement>("button.health-light")];
const lightOf = (label: string) => lights().find((b) => b.textContent?.includes(label))!;
const click = (b: HTMLElement) => act(async () => { b.click(); });

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the health row", () => {
  it("all green: the row alone — seven labelled lights in order, no line under it", async () => {
    await mount(health());
    expect(lights().map((b) => b.querySelector(".health-label")!.textContent)).toEqual(["Instagram", "YouTube", "Screening", "Reader", "Matching", "Coach", "Budget"]);
    for (const b of lights()) {
      expect(b.querySelector(".health-mark")!.textContent).toBe("✓");
      expect(b.textContent).toContain("working");
      expect(b.getAttribute("aria-expanded")).toBe("false");
    }
    expect(host.querySelector(".health-line")).toBeNull();
  });

  it("grey — nothing to judge — is never green: its own mark and word (Review Focus 4)", async () => {
    await mount(health(Object.fromEntries(HEALTH_LIGHTS.map((l) => [l, "grey"]))));
    for (const b of lights()) {
      expect(b.classList.contains("health-light--grey")).toBe(true);
      expect(b.querySelector(".health-mark")!.textContent).toBe("–");
      expect(b.textContent).toContain("nothing to judge yet");
      expect(b.textContent).not.toContain("working");
    }
    expect(host.querySelector(".health-line")).toBeNull();
  });

  it("a red light: the worst line under the row, the light saying it is failing", async () => {
    await mount(RED_READER);
    expect(host.querySelector(".health-line")!.textContent).toBe("Reader: 3 of 4 failed");
    const reader = lightOf("Reader");
    expect(reader.classList.contains("health-light--red")).toBe(true);
    expect(reader.querySelector(".health-mark")!.textContent).toBe("✕");
    expect(reader.textContent).toContain("failing");
    expect(lightOf("YouTube").textContent).toContain("nothing to judge yet");
  });

  it("tapping a light lists its failures — the post, when, why — with Retry where there is a post to retry", async () => {
    await mount(RED_READER);
    const reader = lightOf("Reader");
    await click(reader);
    expect(reader.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(reader.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    const items = [...panel.querySelectorAll("li.health-failure")];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Zorbex hip flow");
    expect(items[0]!.textContent).toContain("Tue 3 Nov");
    expect(items[0]!.textContent).toContain("The reply didn't match the format: moves.0.dose: Required");
    const retry = [...items[0]!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    expect(retry).toBeTruthy();
    // A failure before any post (the gateway refusing the key): nothing to retry.
    expect([...items[1]!.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
    await click(retry);
    await flush();
    expect(calls).toContainEqual({ method: "POST", path: "/api/my-saves/posts/p1/override", body: { action: "process" } });
    expect(items[0]!.textContent).toContain("Sent to be read again");
  });

  it("a failure's post opens its trail", async () => {
    await mount(RED_READER);
    await click(lightOf("Reader"));
    const title = [...host.querySelectorAll<HTMLButtonElement>("button.health-failure-title")].find((b) => b.textContent === "Zorbex hip flow")!;
    await click(title);
    await flush();
    expect(calls.map((c) => c.path)).toContain("/api/my-saves/posts/p1/trail");
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
  });

  it("a light with nothing failed says so when tapped; a second tap folds it", async () => {
    await mount(health());
    const ig = lightOf("Instagram");
    await click(ig);
    const panel = document.getElementById(ig.getAttribute("aria-controls")!)!;
    expect(panel.textContent).toContain("Nothing failed in the last 7 days.");
    await click(ig);
    expect(ig.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
  });

  it("redLine: the worst line while any light is red, else nothing", () => {
    expect(redLine(RED_READER)).toBe("Reader: 3 of 4 failed");
    expect(redLine(health({ reader: "yellow" }, {}, "Reader: retried"))).toBeNull();
    expect(redLine(health({ budget: "red" }))).toBe("Something in the import needs a look");
    expect(redLine(null)).toBeNull();
  });
});
