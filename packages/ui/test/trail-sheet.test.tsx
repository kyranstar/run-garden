// @vitest-environment jsdom
/**
 * THE TRAIL SHEET (design 2026-11-05 §3.4; plan Task 13): one post's trail — the account open, each stage folded under
 * its one-line result, a step's facts one tap down, "Show all" for a long value, the raw reply last, monospace and
 * copyable. Every word came from a stage, a model or a stranger's post: drawn as text, never markup. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportBlobDto, ImportTrailDto, TrailEventDto } from "@rg/saves";
import { TrailSheet } from "../src/screens/saves/trail-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-03T12:00:00.000Z";
const HOSTILE = "<b>bold</b> <img src=x onerror=alert(1)>";
const LONG = `${"a slow and careful reason ".repeat(10)}end`;

const ev = (id: string, stage: TrailEventDto["stage"], over: Partial<TrailEventDto> = {}): TrailEventDto => ({
  id, stage, source: "worker", status: "ok", summary: `${stage} done`, detail: null, moveId: null, model: null, promptVersion: null,
  costMicros: null, latencyMs: null, attempt: null, runId: null, proposalId: null, rebuilt: false, blobs: [], at: AT, ...over,
});

const TRAIL = (over: Partial<ImportTrailDto> = {}): ImportTrailDto => ({
  post: {
    id: "p1", source: "instagram", url: "https://example.com/p/k1", title: null, creator: { handle: "maker" }, mediaType: "video",
    postedAt: null, firstSeenAt: AT, status: "matched", origin: "saved", durationSec: null, videoSeen: null,
  },
  account: {
    kind: "routine",
    summary: `Three slow hip moves ${HOSTILE}`,
    moves: [{ position: 0, name: "Zorbex hip lift", outcome: "new", moveId: "myZorbexHipLift1a2b", purpose: "Opens the hips." }],
    health: { status: "ok", line: "Read cleanly" },
  },
  events: [
    ev("e1", "submit", { source: "extension", summary: "Found by the extension" }),
    ev("e2", "screen", { source: "gateway", summary: "Kept: a hip routine", model: "google/gemini-3.6-flash", detail: { verdict: "training", reason: LONG, stage: "model" }, blobs: [{ id: "b0", kind: "raw_reply", chars: 40 }] }),
    ev("e3", "extract", { source: "gateway", summary: "Read 1 move (a routine)", detail: { kind: "routine", moves: 1 }, blobs: [{ id: "b1", kind: "raw_reply", chars: 812 }] }),
    ev("e4", "match", { summary: "1 move: 1 new", detail: { moves: [{ position: 0, name: "Zorbex hip lift", outcome: "new", by: "new", confidence: 0.3, candidates: [], judge: "not_needed", judgeAnswer: null, like: null, check: false }] }, blobs: [{ id: "bd", kind: "detail", chars: 90 }] }),
  ],
  rebuilt: false,
  ...over,
});

const RAW = `{"kind":"routine","moves":[{"name":"Zorbex hip lift"}]} ${HOSTILE}`;
const BLOBS: Record<string, ImportBlobDto> = {
  b1: { id: "b1", kind: "raw_reply", text: RAW, cut: false },
  bd: { id: "bd", kind: "detail", text: JSON.stringify({ judge: "not_needed", moves: [{ position: 0, name: "Zorbex hip lift", outcome: "new" }] }), cut: false },
};

let root: Root;
let host: HTMLElement;
let calls: string[];
let onClose: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function mount(trail: ImportTrailDto | null = TRAIL()) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/my-saves/posts/p1/trail") return trail ? json(trail) : json({ error: "not_found" }, 404);
      if (url === "/api/my-saves/posts/p1/watch") return json({ ok: true });
      const blob = /^\/api\/my-saves\/blobs\/(.+)$/.exec(url);
      if (blob && BLOBS[blob[1]!]) return json(BLOBS[blob[1]!]);
      return json({ error: "not_found" }, 404);
    }),
  );
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(TrailSheet, { postId: "p1", onClose })));
  });
  await flush();
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement;
const button = (text: string | RegExp) =>
  [...dialog().querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.includes(text) : text.test(b.textContent ?? ""))) as HTMLButtonElement;
const click = (b: HTMLElement) => act(async () => { b.click(); });
const controlled = (b: HTMLElement) => document.getElementById(b.getAttribute("aria-controls")!)!;

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

describe("the trail sheet", () => {
  it("opens on the account, every stage folded under its one-line result", async () => {
    await mount();
    expect(calls).toEqual(["/api/my-saves/posts/p1/trail"]);
    const text = dialog().textContent!;
    expect(text).toContain("From maker · Instagram · Tue 3 Nov");
    expect(text).toContain("Zorbex hip lift — new");
    expect(text).toContain("Read cleanly");
    const stages = ["Reading", "Screening", "Reading the moves", "Matching"].map((t) => button(t));
    for (const b of stages) {
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(controlled(b).hidden).toBe(true);
    }
    expect(button("Screening").textContent).toContain("Kept: a hip routine");
    // Nothing raw is read until it is asked for.
    expect(calls.some((c) => c.includes("/blobs/"))).toBe(false);
  });

  it("opening a stage shows its steps' facts as key: value rows", async () => {
    await mount();
    const screening = button("Screening");
    await click(screening);
    expect(screening.getAttribute("aria-expanded")).toBe("true");
    const detail = controlled(screening);
    expect(detail.hidden).toBe(false);
    const rows = [...detail.querySelectorAll(".coach-detail-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.firstChild!.textContent]);
    expect(rows).toEqual(expect.arrayContaining([["Verdict", "training"], ["Decided by", "the model"], ["Model", "google/gemini-3.6-flash"]]));
  });

  it("Show all opens a long value whole, and Show less folds it again", async () => {
    await mount();
    await click(button("Screening"));
    const why = [...dialog().querySelectorAll(".coach-detail-row")].find((r) => r.querySelector("dt")!.textContent === "Why")!;
    const value = why.querySelector(".trail-value-text")!;
    expect(value.textContent!.endsWith("…")).toBe(true);
    const all = [...why.querySelectorAll("button")].find((b) => b.textContent === "Show all")!;
    await click(all);
    expect(value.textContent).toBe(LONG);
    expect(all.textContent).toBe("Show less");
    expect(all.getAttribute("aria-expanded")).toBe("true");
  });

  it("a raw reply opens last, monospace and whole, and copies", async () => {
    await mount();
    await click(button("Reading the moves"));
    const raw = button("The raw reply · 812 characters");
    expect(raw.getAttribute("aria-expanded")).toBe("false");
    await click(raw);
    await flush();
    expect(calls).toContain("/api/my-saves/blobs/b1");
    const pre = controlled(raw).querySelector("pre.trail-raw-text") as HTMLPreElement;
    expect(pre.textContent).toBe(RAW);
    await click([...controlled(raw).querySelectorAll("button")].find((b) => b.textContent === "Copy")!);
    expect(writeText).toHaveBeenCalledWith(RAW);
    expect(controlled(raw).textContent).toContain("Copied");
    // Monospace, from the stylesheet's own token.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    const at = css.indexOf("\n.trail-raw-text {");
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toContain("font-family: var(--font-mono)");
  });

  it("a detail too long for its event opens as rows, never its JSON", async () => {
    await mount();
    await click(button("Matching"));
    await click(button("The whole detail"));
    await flush();
    const whole = controlled(button("The whole detail"));
    expect(whole.querySelector("pre")).toBeNull();
    expect(whole.textContent).toContain("Came out");
    expect(whole.textContent).toContain("a new move");
    expect(whole.textContent).not.toContain('"moves"');
  });

  it("a move's account line opens that move's own section", async () => {
    await mount();
    const line = button("Zorbex hip lift — new");
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(controlled(line).textContent).toContain("Matching");
    expect(controlled(line).textContent).toContain("a new move");
  });

  it("draws a stranger's words as text, never markup — a summary, a raw reply", async () => {
    await mount();
    expect(dialog().textContent).toContain(HOSTILE);
    await click(button("Reading the moves"));
    await click(button("The raw reply · 812 characters"));
    await flush();
    expect(dialog().querySelector("pre.trail-raw-text")!.textContent).toContain(HOSTILE);
    expect(dialog().querySelector("b")).toBeNull();
    expect(dialog().querySelector("img")).toBeNull();
  });

  it("an old post's rebuilt trail says its raw replies weren't kept (Review Focus 3)", async () => {
    await mount(TRAIL({ rebuilt: true, events: [ev("rebuilt:screen", "screen", { rebuilt: true, summary: "Kept: a hip routine" })] }));
    expect(dialog().textContent).toContain("Kept from before the trail: the raw replies weren't kept then.");
  });

  it("another account's post, or one gone, says so", async () => {
    await mount(null);
    expect(dialog().textContent).toContain("That post isn't there.");
  });

  it("Close closes it", async () => {
    await mount();
    await click(dialog().querySelector('button[aria-label="Close"]') as HTMLButtonElement);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Watch it too (phase 2)", () => {
  it("a long video read from its words offers to be watched, at its cost; the tap asks the app", async () => {
    const t = TRAIL();
    t.post = { ...t.post, source: "youtube", title: "Zorbex hip flow", durationSec: 2_400, video: { watched: false, watchAsked: false, offerWatch: true, watchCostMicros: 185_625 } };
    await mount(t);
    expect(dialog().textContent).toContain("Read from the transcript only (over 20 minutes)");
    const watch = button("Watch it too");
    expect(watch.textContent).toBe("Watch it too (about $0.19)");
    await click(watch);
    await flush();
    expect(calls).toContain("/api/my-saves/posts/p1/watch");
  });
});

describe("Watch it too that doesn't go through (final audit G19)", () => {
  async function tapWith(answer: () => Promise<Response>) {
    const t = TRAIL();
    t.post = { ...t.post, source: "youtube", title: "Zorbex hip flow", durationSec: 2_400, video: { watched: false, watchAsked: false, offerWatch: true, watchCostMicros: 185_625 } };
    await mount(t);
    const orig = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (u: string | URL | Request, r?: RequestInit) => (String(u).endsWith("/watch") ? answer() : orig(u as string, r)));
    await click(button("Watch it too"));
    await flush();
  }
  it("a 409 says it can't be watched now, and the button stays", async () => {
    await tapWith(async () => json({ error: "not_watchable" }, 409));
    expect(dialog().textContent).toContain("It can't be watched now — a move of it may be saved or being fitted in.");
    expect(button("Watch it too").disabled).toBe(false);
  });
  it("no network says so", async () => {
    await tapWith(async () => {
      throw new TypeError("offline");
    });
    expect(dialog().textContent).toContain("Couldn't reach the app — try again.");
  });
});
