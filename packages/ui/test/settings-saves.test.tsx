// @vitest-environment jsdom
/**
 * Settings → Saves: one row that says what the import did (and shows nothing while the feature is off), and a sheet of
 * the posts with Process anyway / Retry.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavesStatusDto } from "@rg/saves";
import { SavesSection } from "../src/screens/settings/saves.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const status = (over: Partial<SavesStatusDto> = {}): SavesStatusDto => ({
  state: "ok",
  lastCheckAt: "2026-10-23T09:00:00.000Z",
  lastImportAt: "2026-10-21T09:00:00.000Z",
  totals: { moves: 12, posts: 5 },
  checks: [],
  posts: [
    { id: "p1", key: "k1", url: "https://example.com/p/k1", creator: { handle: "someone", name: "Some One" }, status: "filtered_out", reason: "not a workout", updatedAt: "2026-10-22T00:00:00.000Z" },
    { id: "p2", key: "k2", url: "https://example.com/p/k2", creator: { handle: "other" }, status: "failed", reason: "media failed", updatedAt: "2026-10-22T00:00:00.000Z" },
  ],
  spend: { spentMicros: 0, capMicros: 5_000_000 },
  ...over,
});

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body: unknown }>;

function mount(reply: { status: number; body?: unknown }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      calls.push({ method: req?.method ?? "GET", path: url, body: req?.body ? JSON.parse(String(req.body)) : null });
      if (url === "/api/my-saves/status") return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  return act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(SavesSection))));
  });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SavesSection", () => {
  it("renders nothing while the feature is off (404)", async () => {
    await mount({ status: 404, body: { error: "not_found" } });
    await flush();
    expect(host.textContent).toBe("");
  });

  it("says when the last check was, once it is a week old", async () => {
    await mount({ status: 200, body: status({ lastCheckAt: "2026-10-15T09:00:00.000Z" }) });
    await flush();
    expect(host.textContent).toContain("Saves");
    expect(host.textContent).toContain("Last check 8 days ago");
  });

  it("says when the last import was (its batch, not the check) and what it brought", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    expect(host.textContent).toContain("Last import 2 days ago · 12 moves from 5 posts");
  });

  it("says one move from one post in the singular", async () => {
    await mount({ status: 200, body: status({ totals: { moves: 1, posts: 1 } }) });
    await flush();
    expect(host.textContent).toContain("Last import 2 days ago · 1 move from 1 post");
  });

  it("says when the last check was while nothing has been imported yet", async () => {
    await mount({ status: 200, body: status({ lastImportAt: null, totals: { moves: 0, posts: 0 } }) });
    await flush();
    expect(host.textContent).toContain("Last check today");
    expect(host.textContent).not.toContain("Last import");
  });

  it("says Paused — import budget when the state is paused_budget", async () => {
    await mount({ status: 200, body: status({ state: "paused_budget" }) });
    await flush();
    expect(host.textContent).toContain("Paused — import budget");
  });

  it("lists the posts in a sheet, each with its link", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const link = document.querySelector('a[href="https://example.com/p/k1"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.target).toBe("_blank");
    expect(document.body.textContent).toContain("Some One");
    expect(document.body.textContent).toContain("not a workout");
  });

  it("Open post is a fingertip's target (the shared saved-link class, its min-height the --tap token) and a link only to a web page (final review M6)", async () => {
    const odd = { id: "p3", key: "k3", url: "javascript:alert(1)", creator: { handle: "odd" }, status: "matched" as const, reason: null, updatedAt: "2026-10-22T00:00:00.000Z" };
    await mount({ status: 200, body: status({ posts: [...status().posts, odd] }) });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[role=dialog] a[target=_blank]")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/p/k1", "https://example.com/p/k2"]);
    for (const a of links) {
      expect(a.classList.contains("stu-saved-link")).toBe(true);
      expect(a.closest("small")).toBeNull();
      expect(a.rel).toBe("noopener noreferrer");
    }
    // The odd post is still listed, with no link.
    expect(document.body.textContent).toContain("odd");
  });

  it("the sheet links to the review screen first — From your saves, to /studio/saves (final review I2; spec §8)", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const review = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.getAttribute("href") === "/studio/saves");
    expect(review).toBeDefined();
    expect(review!.textContent).toContain("From your saves");
    // A whole row's target, before the posts.
    expect(review!.classList.contains("place-row")).toBe(true);
    const firstPost = document.querySelector('a[href="https://example.com/p/k1"]')!;
    expect(review!.compareDocumentPosition(firstPost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Process anyway calls the override", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Process anyway") as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(calls).toContainEqual({ method: "POST", path: "/api/my-saves/posts/p1/override", body: { action: "process" } });
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true);
  });
});
