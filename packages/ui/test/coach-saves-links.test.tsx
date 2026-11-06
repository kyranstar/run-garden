// @vitest-environment jsdom
/**
 * PASTED LINKS BEHIND AN OPEN BATCH (audit 2026-11-06, I6): a new batch is cut only when none is open, so a fresh paste
 * waits behind last week's batch while the coach showed only that. The coach's saves card now lists the recent pasted
 * links that aren't in the open batch — each its title and where it stands — and how many more wait for the next batch.
 * The links come from the link list the app already reads (one statement). Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkDto, OpenSavesBatchDto } from "@rg/saves";
import { CoachSavesCard } from "../src/screens/studio/coach-saves.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = ["ht", "tps://"].join("");
const yt = (v: string) => `${S}www.${["you", "tube.com"].join("")}/watch?v=${v}`;
const OPEN: OpenSavesBatchDto = { id: "b1", counts: { new: 3, linked: 0 }, groups: [{ group: "hip", count: 3 }], line: "Three new moves came in from your saves.", fitting: false };
const link = (n: number, over: Partial<LinkDto> = {}): LinkDto => ({
  id: `l${n}`, source: "youtube", key: `Zorbex${n}vid0`.slice(0, 11), url: yt(`Zorbex${n}vid0`.slice(0, 11)), title: `Zorbex flow ${n}`,
  addedAt: `2026-11-06T0${9 - n}:00:00.000Z`, addedFrom: "extension", postId: `p${n}`, state: "moves", words: "2 moves", moves: 2, action: null,
  batchId: null, ...over,
});

let root: Root | null = null;
let host: HTMLElement;

async function mount(links: LinkDto[] | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/my-saves/open") return json({ open: OPEN });
      if (url === "/api/my-saves/links") return links ? json({ links }) : json({ error: "not_found" }, 404);
      return json({ error: "not_found" }, 404);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(CoachSavesCard, { busy: false, onFit: () => undefined }))));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const section = () => host.querySelector<HTMLElement>("[aria-label='Pasted links']");

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

describe("the coach's saves card lists the pasted links the open batch doesn't hold", () => {
  it("the newest three with their words, and how many more wait for the next batch", async () => {
    await mount([
      link(1, { state: "reading_moves", words: "Reading the moves", moves: null, postId: "p1" }),
      link(2, { postId: null, state: "reading", words: "Reading" }),
      link(3),
      link(4, { batchId: "b1" }), // in the open batch: the card says it already
      link(5),
      link(6),
      link(7, { state: "failed", words: "Failed: Sign in to YouTube in Chrome", moves: null, action: "retry" }),
    ]);
    const s = section()!;
    expect(s).toBeTruthy();
    const rows = [...s.querySelectorAll("li")].map((li) => [li.querySelector(".coach-saves-link-title")!.textContent, li.querySelector(".coach-saves-link-words")!.textContent]);
    expect(rows).toEqual([
      ["Zorbex flow 1", "Reading the moves"],
      ["Zorbex flow 2", "Reading"],
      ["Zorbex flow 3", "2 moves · for the next batch"],
    ]);
    expect(s.textContent).toContain("2 more waiting for the next batch");
  });

  it("nothing pasted outside the batch, or no link list: no section", async () => {
    await mount([link(1, { batchId: "b1" })]);
    expect(section()).toBeNull();
    act(() => root!.unmount());
    await mount(null);
    expect(section()).toBeNull();
    expect(host.textContent).toContain("Three new moves came in from your saves.");
  });
});
