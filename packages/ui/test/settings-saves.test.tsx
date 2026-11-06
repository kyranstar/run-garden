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
import { HEALTH_LIGHTS, type ImportHealthDto, type ImportTrailDto, type SavesStatusDto } from "@rg/saves";
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
    { id: "p1", key: "k1", url: "https://example.com/p/k1", creator: { handle: "someone", name: "Some One" }, status: "filtered_out", reason: "not a workout", errorCode: null, error: null, updatedAt: "2026-10-22T00:00:00.000Z" },
    { id: "p2", key: "k2", url: "https://example.com/p/k2", creator: { handle: "other" }, status: "failed", reason: "training (first capture)", errorCode: "media_failed", error: "The video wouldn't download", updatedAt: "2026-10-22T00:00:00.000Z" },
  ],
  spend: { spentMicros: 0, capMicros: 5_000_000 },
  ...over,
});

const LINKS = [
  {
    id: "l1", source: "youtube", key: "Zx9_-QaB3cD", url: "https://example.com/v/1", title: "Zorbex hip flow", addedAt: "2026-10-23T10:00:00.000Z",
    addedFrom: "app", postId: null, state: "waiting", words: "Waiting for your computer's extension", moves: null, action: null,
  },
  {
    id: "l2", source: "instagram", key: "ZorbexPost1", url: "https://example.com/reel/2", title: null, addedAt: "2026-10-22T10:00:00.000Z",
    addedFrom: "extension", postId: "p1", state: "not_training", words: "Not training", moves: null, action: "import_anyway",
  },
];
let linkAnswer: unknown = { state: "added", link: LINKS[0] };

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body: unknown }>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const health = (red = false): ImportHealthDto => ({
  lights: HEALTH_LIGHTS.map((light) => ({
    light,
    color: red && light === "reader" ? "red" : "green",
    line: red && light === "reader" ? "Reader: 3 of 4 failed" : null,
    failures: [],
  })),
  worst: red ? "Reader: 3 of 4 failed" : null,
});
const TRAIL: ImportTrailDto = {
  post: { id: "p1", source: "instagram", url: "https://example.com/p/k1", title: null, creator: { handle: "someone", name: "Some One" }, mediaType: "video", postedAt: null, firstSeenAt: "2026-10-22T12:00:00.000Z", status: "filtered_out", origin: "saved", durationSec: null, videoSeen: null },
  account: { kind: null, summary: null, moves: [], health: { status: "ok", line: "Read cleanly" } },
  events: [],
  rebuilt: false,
};

function mount(reply: { status: number; body?: unknown }, healthReply: { status: number; body?: unknown } = { status: 200, body: health() }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      calls.push({ method: req?.method ?? "GET", path: url, body: req?.body ? JSON.parse(String(req.body)) : null });
      if (url === "/api/my-saves/status") return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/my-saves/health") return json(healthReply.body ?? {}, healthReply.status);
      if (url === "/api/my-saves/posts/p1/trail") return json(TRAIL);
      if (url === "/api/my-saves/links" && req?.method === "POST") return json(linkAnswer);
      if (url === "/api/my-saves/links") return json({ links: LINKS });
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

  it("a failed post's row says why it failed, not why the filter kept it (audit bug 2)", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain("The video wouldn't download");
    expect(document.body.textContent).not.toContain("training (first capture)");
  });

  it("Open post is a fingertip's target (the shared saved-link class, its min-height the --tap token) and a link only to a web page (final review M6)", async () => {
    const odd = { id: "p3", key: "k3", url: "javascript:alert(1)", creator: { handle: "odd" }, status: "matched" as const, reason: null, errorCode: null, error: null, updatedAt: "2026-10-22T00:00:00.000Z" };
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

  it("never reads as all is well while a health light is red: the line is the worst light's (audit bug 7)", async () => {
    await mount({ status: 200, body: status() }, { status: 200, body: health(true) });
    await flush();
    expect(host.textContent).toContain("Reader: 3 of 4 failed");
    expect(host.textContent).not.toContain("Last import");
  });

  it("the sheet opens on the health row, above the review screen's row", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const row = document.querySelector("[role=dialog] [aria-label='Import health']")!;
    expect(row).toBeTruthy();
    expect(row.querySelectorAll("button.health-light")).toHaveLength(7);
    const review = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.getAttribute("href") === "/studio/saves")!;
    expect(row.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a health read that fails leaves the row out, and the line as it was", async () => {
    await mount({ status: 200, body: status() }, { status: 404, body: { error: "not_found" } });
    await flush();
    expect(host.textContent).toContain("Last import 2 days ago");
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    expect(document.querySelector("[aria-label='Import health']")).toBeNull();
  });

  it("a post's How it came in opens its trail", async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => { (host.querySelector("button.place-row") as HTMLButtonElement).click(); });
    const open = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("How it came in") && b.textContent.includes("Some One"))!;
    expect(open).toBeTruthy();
    await act(async () => { open.click(); });
    await flush();
    expect(calls.map((c) => c.path)).toContain("/api/my-saves/posts/p1/trail");
    expect(document.body.textContent).toContain("From Some One · Instagram");
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

describe("Settings -> Saves: a link from the phone (design 2026-11-05 §15.2)", () => {
  const openSheet = async () => {
    await mount({ status: 200, body: status() });
    await flush();
    await act(async () => {
      (host.querySelector("button.place-row") as HTMLButtonElement).click();
    });
    await flush();
  };
  const sheet = () => document.querySelector("[role=dialog]") as HTMLElement;
  const input = () => sheet().querySelector("input") as HTMLInputElement;
  // A watch link assembled at runtime, a fake video id: the privacy grep never sees a real one.
  const watch = ["ht", "tps://www.", "you", "tube.com/watch?v=", "Zx9_-QaB3cD"].join("");
  const type = (value: string) =>
    act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("a field adds the link; the app says it's waiting for the computer's extension", async () => {
    linkAnswer = { state: "added", link: LINKS[0] };
    await openSheet();
    expect(input().placeholder).toBe("Paste a YouTube or Instagram link");
    await type(watch);
    await act(async () => {
      (sheet().querySelector("form button") as HTMLButtonElement).click();
    });
    await flush();
    expect(calls).toContainEqual({ method: "POST", path: "/api/my-saves/links", body: { url: watch } });
    expect(sheet().textContent).toContain("Added — it'll be waiting in the coach.");
  });

  it("a link already in says when it came in", async () => {
    linkAnswer = { state: "known", postId: "p1", firstSeenAt: "2026-10-20T12:00:00.000Z" };
    await openSheet();
    await type(watch);
    await act(async () => {
      (sheet().querySelector("form button") as HTMLButtonElement).click();
    });
    await flush();
    expect(sheet().textContent).toContain("Already in — imported Tue 20 Oct.");
  });

  it("anything else is refused before it is sent", async () => {
    await openSheet();
    await type("https://example.com/v/1");
    await act(async () => {
      (sheet().querySelector("form button") as HTMLButtonElement).click();
    });
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/my-saves/links")).toBe(false);
    expect(sheet().textContent).toContain("Only YouTube and Instagram links for now.");
  });

  it("recent links: each with its words, and Import anyway on one screened out", async () => {
    await openSheet();
    expect(sheet().textContent).toContain("Recent links");
    expect(sheet().textContent).toContain("Waiting for your computer's extension");
    const anyway = [...sheet().querySelectorAll("button")].find((b) => b.textContent === "Import anyway")!;
    await act(async () => {
      anyway.click();
    });
    await flush();
    expect(calls).toContainEqual({ method: "POST", path: "/api/my-saves/posts/p1/override", body: { action: "process" } });
  });
});
