// @vitest-environment jsdom
/**
 * WHAT THE WATCH WILL SHOW (Phase 3 Task 8; approved mocks §1 "Preview · from Send to watch", §2 "Preview · over 200
 * steps"; owner calls 2–6, 8). The preview lists every step the watch runs, numbered, in order — read off the very
 * program the push writes. Each row: the name (a move the watch doesn't know keeps its real name and a small "Free
 * text" tag), the target, the kg the watch shows and the athlete's unit beside it, the cue, and the rest on the right.
 * Headed by the stamp the watch shows. Send posts the digest of the preview shown; a 409 `stale_preview` swaps the
 * fresh preview in and sends nothing until Send is tapped again. "Too long for the watch" takes Send's place.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, WatchPreviewDto } from "@rg/api-client";
import { WatchPreviewSheet } from "../src/components/watch-preview-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = "slot-p1-2026-10-08";

const PREVIEW: WatchPreviewDto = {
  buildId: "b1",
  stamp: "Strength program — 2026-10-08",
  steps: [
    { name: "Physiological sigh", freeText: true, target: { kind: "hold", seconds: 60 }, grams: null, load: null, overview: "The exhale is the important part.", restSeconds: 0 },
    { name: "Goblet Squat", freeText: false, target: { kind: "reps", reps: 6 }, grams: 13608, load: { v: 30, u: "lb" }, overview: "Knees track over your toes.", restSeconds: 0 },
    { name: "Supported one-arm row", freeText: true, target: { kind: "reps", reps: 10 }, grams: 9072, load: { v: 20, u: "lb" }, overview: "left side · The shoulder blade moves.", restSeconds: 0 },
    { name: "Supported one-arm row", freeText: true, target: { kind: "reps", reps: 10 }, grams: 9072, load: { v: 20, u: "lb" }, overview: "right side · The shoulder blade moves.", restSeconds: 75 },
    { name: "Dead Bug", freeText: false, target: { kind: "reps", reps: 8 }, grams: null, load: null, overview: "", restSeconds: 45 },
  ],
  freeText: 3,
  refusal: null,
  digest: "d-1",
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00"));
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function mount(opts: { preview?: WatchPreviewDto; send?: (c: Call, n: number) => Response; minutes?: number } = {}) {
  const calls: Call[] = [];
  let sends = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      const call = { method, path, body };
      calls.push(call);
      if (path === `/api/sessions/${SLOT}/watch-preview`) return json(opts.preview ?? PREVIEW);
      if (path === `/api/sessions/${SLOT}/send-to-watch`) {
        sends += 1;
        return opts.send ? opts.send(call, sends) : json({ workoutId: SLOT, watch: { state: "sending" } });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
  const onClose = vi.fn();
  const onSent = vi.fn();
  const onStale = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(WatchPreviewSheet, { workoutId: SLOT, minutes: opts.minutes ?? 30, onClose, onSent, onStale }),
      ),
    );
  });
  return { calls, onClose, onSent, onStale };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const rows = () => [...document.querySelectorAll(".wstep")];
const sendButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === "Send");
const sends = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/send-to-watch"));

describe("the preview of what the watch will show", () => {
  it("is headed by the stamp the watch shows, then how many steps and minutes", async () => {
    mount();
    await until(() => rows().length > 0, "the steps");
    expect(text(document.querySelector("[role=dialog] h2"))).toBe("Strength program — 2026-10-08");
    expect(text(document.querySelector(".watch-preview-when"))).toBe("5 steps · 30 min");
  });

  it("each row: its number, the name (Free text where the watch doesn't know the move), target · kg · the athlete's unit, the cue, the rest", async () => {
    mount();
    await until(() => rows().length > 0, "the steps");
    const shown = rows().map((r) => ({
      n: text(r.querySelector(".wstep-n")),
      name: text(r.querySelector(".wstep-name")),
      free: !!r.querySelector(".wstep-free"),
      target: text(r.querySelector(".wstep-target")),
      cue: text(r.querySelector(".wstep-cue")),
      rest: text(r.querySelector(".wstep-rest")),
    }));
    expect(shown).toEqual([
      { n: "1", name: "Physiological sigh Free text", free: true, target: "60 s", cue: "The exhale is the important part.", rest: "" },
      { n: "2", name: "Goblet Squat", free: false, target: "6 reps · 13.6 kg · 30 lb", cue: "Knees track over your toes.", rest: "" },
      { n: "3", name: "Supported one-arm row Free text", free: true, target: "10 reps · 9.1 kg · 20 lb", cue: "left side · The shoulder blade moves.", rest: "" },
      { n: "4", name: "Supported one-arm row Free text", free: true, target: "10 reps · 9.1 kg · 20 lb", cue: "right side · The shoulder blade moves.", rest: "Rest 75 s" },
      { n: "5", name: "Dead Bug", free: false, target: "8 reps", cue: "", rest: "Rest 45 s" },
    ]);
  });

  it("a kg athlete reads the kg once", async () => {
    mount({ preview: { ...PREVIEW, steps: [{ ...PREVIEW.steps[1]!, load: { v: 13.5, u: "kg" } }] } });
    await until(() => rows().length > 0, "the steps");
    expect(text(rows()[0]!.querySelector(".wstep-target"))).toBe("6 reps · 13.6 kg");
  });

  it("Send posts the shown preview's buildId and digest; the sheet hears the session", async () => {
    const { calls, onSent } = mount();
    await until(() => !!sendButton(), "Send");
    await act(async () => sendButton()!.click());
    await until(() => onSent.mock.calls.length === 1, "onSent");
    expect(sends(calls).map((c) => c.body)).toEqual([{ buildId: "b1", digest: "d-1" }]);
    expect(onSent.mock.calls[0]![0]).toMatchObject({ workoutId: SLOT, watch: { state: "sending" } });
  });

  it("409 stale_preview: the fresh preview takes the shown one's place, nothing more is sent until Send again — with its digest", async () => {
    const fresh: WatchPreviewDto = { ...PREVIEW, stamp: "Strength program — 2026-10-08 (2)", digest: "d-2" };
    const { calls, onSent } = mount({
      send: (_c, n) => (n === 1 ? json({ error: "stale_preview", preview: fresh }, 409) : json({ workoutId: SLOT, watch: { state: "sending" } })),
    });
    await until(() => !!sendButton(), "Send");
    await act(async () => sendButton()!.click());
    await until(() => text(document.querySelector("[role=dialog] h2")).endsWith("(2)"), "the fresh preview");
    expect(sends(calls)).toHaveLength(1);
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => sendButton()!.click());
    await until(() => onSent.mock.calls.length === 1, "onSent");
    expect(sends(calls).map((c) => c.body)).toEqual([
      { buildId: "b1", digest: "d-1" },
      { buildId: "b1", digest: "d-2" },
    ]);
  });

  it("409 stale: the sheet hears the fresh session (and shows it, as Start does)", async () => {
    const session = { workoutId: SLOT, watch: { state: "ready" } } as unknown as SessionDto;
    const { onStale } = mount({ send: () => json({ error: "stale", session }, 409) });
    await until(() => !!sendButton(), "Send");
    await act(async () => sendButton()!.click());
    await until(() => onStale.mock.calls.length === 1, "onStale");
    expect(onStale.mock.calls[0]![0]).toEqual(session);
  });

  it("too long for the watch: every step listed, and Too long for the watch where Send would be", async () => {
    const many = Array.from({ length: 212 }, () => PREVIEW.steps[1]!);
    mount({ preview: { ...PREVIEW, steps: many, refusal: "too_long" } });
    await until(() => rows().length > 0, "the steps");
    expect(rows()).toHaveLength(212);
    expect(text(document.querySelector(".watch-preview-when"))).toBe("212 steps · 30 min");
    expect(text(document.querySelector(".sheet-foot"))).toBe("Too long for the watch");
    expect(sendButton()).toBeUndefined();
  });

  it("keyboard: Send takes the focus once the steps are in (Enter sends); Escape closes the preview", async () => {
    const { onClose } = mount();
    await until(() => !!sendButton(), "Send");
    await until(() => document.activeElement === sendButton(), "Send focused");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
