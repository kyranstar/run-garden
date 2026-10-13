// @vitest-environment jsdom
/**
 * A place's save sends only what the sheet changed (whole-branch review, server finding 4): `/api/places` is cached for
 * the Studio, so the sheet can open on a stale list; the server's PATCH keeps every field it is not sent, so gear
 * changed on another device since is never written over by a field this sheet did not touch. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceDto, PlacesResponse } from "@rg/api-client";
import { PlaceSheet, placePatch } from "../src/components/place-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const home: PlaceDto = { id: "p1", name: "Home", equipment: ["mat", "kettlebell", "band"], implements: { kettlebell: "12, 16 kg" }, isDefault: true };
const same = { name: "Home", equipment: ["band", "mat", "kettlebell"], implements: { kettlebell: "12, 16 kg" } };

describe("placePatch", () => {
  it("nothing changed: nothing sent (the order of the gear is no change)", () => {
    expect(placePatch(home, same)).toEqual({});
  });

  it("each field only when it changed", () => {
    expect(placePatch(home, { ...same, name: "Flat" })).toEqual({ name: "Flat" });
    expect(placePatch(home, { ...same, equipment: ["mat", "kettlebell"] })).toEqual({ equipment: ["mat", "kettlebell"] });
    expect(placePatch(home, { ...same, implements: { kettlebell: "12, 16, 20 kg" } })).toEqual({ implements: { kettlebell: "12, 16, 20 kg" } });
    expect(placePatch(home, { ...same, implements: {} })).toEqual({ implements: {} });
    expect(placePatch(home, { ...same, isDefault: true })).toEqual({ isDefault: true });
  });

  it("a rename from a stale list (read before a kettlebell was added elsewhere) never sends the gear it read", () => {
    const stale: PlaceDto = { ...home, equipment: ["mat", "band"], implements: {} };
    expect(placePatch(stale, { name: "Home gym", equipment: ["band", "mat"], implements: {} })).toEqual({ name: "Home gym" });
  });
});

describe("the place sheet's save", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
  });

  it("a rename sends the name alone", async () => {
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        sent.push({ method: init?.method ?? "GET", path: String(input), body });
        return new Response(JSON.stringify({ place: { ...home, ...(body ?? {}) } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    const vocabulary: PlacesResponse["equipment"] = [
      { id: "mat", label: "Mat", weighted: false },
      { id: "kettlebell", label: "Kettlebell", weighted: true },
      { id: "band", label: "Band", weighted: false },
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const closed = vi.fn();
    act(() => {
      root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PlaceSheet, { place: home, vocabulary, onClose: closed })));
    });
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Home gym");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save")!;
    await act(async () => save.click());
    for (let i = 0; i < 50 && !closed.mock.calls.length; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    const patch = sent.find((s) => s.method === "PATCH")!;
    expect(patch.path).toBe("/api/places/p1");
    expect(patch.body).toEqual({ name: "Home gym" });
  });
});
