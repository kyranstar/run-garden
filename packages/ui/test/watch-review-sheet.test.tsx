// @vitest-environment jsdom
/**
 * LOG YOUR SESSION — the quick review after a watch session (Phase 3 Task 10; spec §5; approved mocks §3, owner call
 * 12: the post-check, the sets and a note; no 👍 / 👎, no block switch, no records).
 *
 *  - Opens prefilled from the basis: each move's sets as a line, opening to steppers on tap, as in the player's review.
 *    Watch values and targets look the same — nothing labels where a value came from.
 *  - Save puts ONE entry in the outbox (`source: "watch_review"`, the basis's `sourceRef`, `buildId`, `localDate`), and
 *    sends it when it can: offline it waits ("will sync"); a 409 `slot_done` leaves it as a conflict for Settings → Data.
 *  - Not now closes and keeps nothing.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchReviewBasisDto } from "@rg/api-client";
import { WatchReviewSheet } from "../src/components/watch-review-sheet.js";
import { offlineDb } from "../src/offline/idb.js";
import { discardEntry, outboxEntries } from "../src/offline/outbox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLOT = "slot-p1-2026-10-08";
const USER = "user-1";

const BASIS: WatchReviewBasisDto & { entries: Array<WatchReviewBasisDto["entries"][number] & { name: string }> } = {
  workoutId: SLOT,
  buildId: "b1",
  activityId: "act-1",
  sourceRef: "lbl-strength-1",
  localDate: "2026-10-08",
  startedAt: "2026-10-08T18:00:00.000Z",
  endedAt: "2026-10-08T18:32:00.000Z",
  seconds: 1920,
  newMove: null,
  unit: "lb",
  before: { "p-x": { pre: 1, feelingOff: false } },
  profiles: [{ profileId: "p-x", check: { label: "Knee / hip", min: 0, max: 10 }, care: "Knee care" }],
  entries: [
    {
      exerciseId: "goblet",
      name: "Goblet squat",
      perSide: false,
      format: "straight",
      implement: null,
      sets: [
        { setIndex: 0, side: null, reps: 6, seconds: null, load: { v: 30, u: "lb" }, done: true, flags: [], from: "watch" },
        { setIndex: 1, side: null, reps: 6, seconds: null, load: { v: 30, u: "lb" }, done: true, flags: [], from: "watch" },
        { setIndex: 2, side: null, reps: 5, seconds: null, load: { v: 30, u: "lb" }, done: true, flags: [], from: "watch" },
      ],
    },
    {
      exerciseId: "plank",
      name: "Side plank",
      perSide: true,
      format: "holds",
      implement: null,
      sets: [
        { setIndex: 0, side: "left", reps: null, seconds: 30, load: null, done: true, flags: [], from: "watch" },
        { setIndex: 1, side: "right", reps: null, seconds: 28, load: null, done: true, flags: [], from: "watch" },
      ],
    },
    {
      exerciseId: "twist",
      name: "Supine twist",
      perSide: false,
      format: "flow",
      implement: null,
      sets: [{ setIndex: 0, side: null, reps: null, seconds: 45, load: null, done: false, flags: [], from: "target" }],
    },
  ],
} as never;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T19:00:00"));
  vi.stubGlobal("indexedDB", new IDBFactory());
  // The page's offline database is opened once and shared: each case starts with an empty outbox.
  const db = await offlineDb();
  for (const e of await outboxEntries(db)) await discardEntry(db, e.key);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function mount(opts: { put?: () => Response | Promise<Response> } = {}) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/\?.*$/, "");
      if (path === `/api/sessions/${SLOT}/watch-review`) return json(BASIS);
      if (path.startsWith("/api/sessions/performed/") && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return opts.put ? opts.put() : json({ status: "saved", performedId: "x", activityId: "act-1", matched: true, notes: [] });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
  const onClose = vi.fn();
  const onSaved = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["me"], { userId: USER });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(WatchReviewSheet, { workoutId: SLOT, title: "Strength program", onClose, onSaved, saveWaitMs: 200 }),
      ),
    );
  });
  return { puts, onClose, onSaved };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
    const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
const click = async (name: string | RegExp) => {
  const b = button(name);
  if (!b) throw new Error(`no control ${String(name)}\n${document.body.textContent}`);
  await act(async () => b.click());
};
const entries = async () => outboxEntries(await offlineDb());

describe("Log your session — the sheet", () => {
  it("opens prefilled: the session line, the post-check per profile with its before, each move's sets as a line", async () => {
    mount();
    await until(() => !!document.querySelector(".review-move"), "the moves");
    expect(text(document.querySelector("[role=dialog] h2"))).toBe("Log your session");
    expect(text(document.querySelector(".watch-review-when"))).toBe("Strength program · Thursday, October 8 · 32 min");
    expect(document.body.textContent).toContain("Knee / hip now");
    expect(document.body.textContent).toContain("Before 1");
    expect(document.querySelectorAll("[role=radiogroup] [role=radio]")).toHaveLength(11);
    const rows = () => [...document.querySelectorAll(".review-move-name")].map((b) => text(b));
    // The moves the watch logged show; the rest wait behind "N more" (approved mocks §3).
    expect(rows()).toEqual(["Goblet squat 30 lb × 6 · 30 lb × 6 · 30 lb × 5", "Side plank 30 s each side"]);
    await click(/^1 more/);
    expect(rows()).toEqual(["Goblet squat 30 lb × 6 · 30 lb × 6 · 30 lb × 5", "Side plank 30 s each side", "Supine twist 45 s"]);
    // Nothing labels where a value came from: the watch's and the targets' rows look the same.
    expect(document.body.textContent).not.toMatch(/watch|target/i);
    expect(document.querySelector("textarea.review-note")).not.toBeNull();
  });

  it("a row opens to its steppers, as the player's review does; an edit and Done go into the save", async () => {
    const { onSaved, puts } = mount();
    await until(() => !!document.querySelector(".review-move"), "the moves");
    await click(/^Goblet squat/);
    expect(document.querySelectorAll(".review-set")).toHaveLength(3);
    await click(/^1 more/);
    await click(/^Supine twist/);
    await click("Done");
    await click("Save");
    await until(() => onSaved.mock.calls.length === 1, "onSaved");
    const sent = puts[0] as { entries: Array<{ exerciseId: string; sets: Array<Record<string, unknown>> }> };
    expect(sent.entries.find((e) => e.exerciseId === "twist")!.sets[0]).toMatchObject({ seconds: 45, done: true });
  });

  it("Save: one outbox entry — watch_review, the basis's sourceRef, buildId and day — sent at once", async () => {
    const { puts, onSaved } = mount();
    await until(() => !!document.querySelector(".review-move"), "the moves");
    await click("3");
    const note = document.querySelector<HTMLTextAreaElement>("textarea.review-note")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(note, "felt strong");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");
    await until(() => onSaved.mock.calls.length === 1, "onSaved");
    expect(onSaved).toHaveBeenCalledWith("saved");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      source: "watch_review",
      sourceRef: "lbl-strength-1",
      workoutId: SLOT,
      buildId: "b1",
      localDate: "2026-10-08",
      startedAt: "2026-10-08T18:00:00.000Z",
      seconds: 1920,
      note: "felt strong",
      checks: [{ profileId: "p-x", kind: "post", value: 3, feelingOff: false }],
    });
    const sent = puts[0] as { entries: Array<{ exerciseId: string; perSide: boolean; sets: Array<Record<string, unknown>> }> };
    expect(sent.entries.map((e) => [e.exerciseId, e.perSide, e.sets.length])).toEqual([
      ["goblet", false, 3],
      ["plank", true, 2],
      ["twist", false, 1],
    ]);
    expect(sent.entries[1]!.sets.map((s) => s.side)).toEqual(["left", "right"]);
    expect(sent.entries[0]!.sets.every((s) => !("from" in s))).toBe(true);
    // Sent: nothing waits in the outbox.
    expect(await entries()).toEqual([]);
  });

  it("offline: the save waits in the outbox — 'will sync'", async () => {
    const { onSaved } = mount({ put: () => Promise.reject(new TypeError("Failed to fetch")) });
    await until(() => !!document.querySelector(".review-move"), "the moves");
    await click("Save");
    await until(() => onSaved.mock.calls.length === 1, "onSaved");
    expect(onSaved).toHaveBeenCalledWith("pending");
    const waiting = await entries();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ state: "pending", userId: USER, payload: { source: "watch_review", workoutId: SLOT } });
  });

  it("409 slot_done (another session of the slot was saved first): the entry is a conflict, for Settings → Data", async () => {
    const { onSaved } = mount({ put: () => json({ error: "slot_done" }, 409) });
    await until(() => !!document.querySelector(".review-move"), "the moves");
    await click("Save");
    await until(() => onSaved.mock.calls.length === 1, "onSaved");
    await until(async () => (await entries())[0]?.state === "conflict", "the conflict");
    expect((await entries())[0]).toMatchObject({ state: "conflict", lastError: "slot_done" });
  });

  it("each move's row is named by what it shows — the move and the values to check (audit 3-B UI-10; WCAG 2.5.3)", async () => {
    mount();
    await until(() => !!document.querySelector(".review-move"), "the moves");
    const row = document.querySelector<HTMLButtonElement>(".review-move-name")!;
    expect(row.hasAttribute("aria-label")).toBe(false);
    expect(text(row)).toBe("Goblet squat 30 lb × 6 · 30 lb × 6 · 30 lb × 5");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("Not now closes and keeps nothing", async () => {
    const { onClose, puts } = mount();
    await until(() => !!document.querySelector(".review-move"), "the moves");
    await click("Not now");
    expect(onClose).toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(await entries()).toEqual([]);
  });
});
