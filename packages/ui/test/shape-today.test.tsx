// @vitest-environment jsdom
/**
 * THE NEW SHAPE, TODAY (2026-10-17 design §4): one card and the garden behind it.
 *
 *  - The card, in order: the eyebrow ("Today · Mon 5 Oct"), the session's title, one line of facts, one coach line
 *    (one sentence), the body check, then its actions (View workout, or the session's Start, and Ask). Another session
 *    today is one quiet row under "Also today". A rest day says so, with one gentle suggestion.
 *  - Gone from the home: the week ribbon, Minimize and the pill it folded into, the "grows the X" line, the Lately
 *    strip, the streak band, the scene's tool chips and "How the garden works" under the page.
 *  - The garden drawer: a handle at the card's foot — tap it or pull it up — opens "Your garden": next to bloom, twelve
 *    weeks, last trained, the collection, the log and the timeline, Growth, and how the garden works.
 *  - The coach sees today's session (useCoachSeeing).
 *
 * The garden home is rendered whole against a stubbed worker (only the canvas scene is stubbed). Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { GardenScreen } from "../src/screens/garden.js";
import { CoachOpenContext, CoachSeeingContext, SeeingRegistry, type CoachOpener } from "../src/screens/studio/coach-ask.js";

vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";

const run = {
  id: "run-1",
  title: "Easy Run with Strides",
  category: "easy",
  qualitySubtype: null,
  sport: "run",
  originalPlanDate: TODAY,
  lastVerifiedCorosDate: TODAY,
  effectiveDate: TODAY,
  effectiveTime: "07:00",
  workoutSeconds: 2700,
  calendarSeconds: 2700,
  stageSummary: "40 min · 4 × 15s / 45s recovery",
  calendarSyncState: "synced",
  corosSyncState: "synced",
  completionState: "scheduled",
  archived: false,
  origin: null,
  contentState: null,
  programId: null,
};

const slot = {
  ...run,
  id: "slot-1",
  title: "Garden program",
  category: "strength",
  sport: "strength",
  effectiveTime: "18:00",
  workoutSeconds: 1800,
  origin: "program",
  contentState: "outline",
  programId: "p1",
};

const rest = { ...run, id: "rest-1", title: "Rest", category: "rest", workoutSeconds: null, stageSummary: null };

function todayPayload(over: Record<string, unknown> = {}) {
  return {
    today: TODAY,
    nextWorkout: run,
    upcoming: [run],
    todaySessions: [{ workout: run, build: null }],
    conditions: [],
    unresolved: [],
    needsAttention: [],
    sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
    readiness: { latest: null, baseline: null, sampleDays: 10, verdict: { level: "good", reasons: ["HRV in your usual range"] } },
    focus: { text: "Keep the easy days easy. Saturday's long run anchors the week.", at: "2026-10-04T08:00:00Z" },
    consistency: {
      weeks: Array.from({ length: 12 }, (_, i) => ({ weekStart: `2026-07-${String(13 + i).padStart(2, "0")}`, band: i % 3 === 0 ? "partial" : "full" })),
      adherencePct: 84,
      streakWeeks: 3,
    },
    ...over,
  };
}

const garden = {
  snapshot: initialSnapshot("2026-09-01"),
  events: [],
  seen: null,
  restMode: { active: false },
  balance: { run: { days: 1, health: 1 }, strength: { days: 3, health: 0.8 }, yoga: { days: 5, health: 0.6 }, overall: 0.8 },
  codex: [],
  species: [],
  wildlife: [],
  visitors: [],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00`));
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`waited for ${what}\n${host?.textContent}`);
}

/** The home against `today`, with the coach's sheet in the app (or not) and a registry for what it sees. */
async function mount(today: Record<string, unknown>, o: { coach?: CoachOpener | null; seeing?: SeeingRegistry } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      const body =
        path === "/api/plan/today"
          ? today
          : path === "/api/garden"
            ? garden
            : path === "/api/settings"
              ? { prefs: { units: "km", timezone: "America/Los_Angeles" } }
              : path === "/api/plan/workouts"
                ? { today: TODAY, workouts: [run], plan: null }
                : path === "/api/today/body"
                  ? { workoutId: "run-1", answer: null, change: null, open: true, areas: [] }
                  : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  const coach = o.coach === undefined ? { open: () => undefined } : o.coach;
  let el = createElement(MemoryRouter, null, createElement(GardenScreen));
  if (coach) el = createElement(CoachOpenContext.Provider, { value: coach }, el);
  if (o.seeing) el = createElement(CoachSeeingContext.Provider, { value: o.seeing }, el);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, el));
  });
  await until(() => !!host!.querySelector(".garden-handle"), "the home");
  return host!;
}

const card = () => host!.querySelector<HTMLElement>("#dock-panel")!;
const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => [...document.querySelectorAll<HTMLElement>("[role=dialog]")].at(-1) ?? null;

describe("the one card", () => {
  it("in order: the eyebrow, the title, the facts, one coach line, the body check, then View workout and Ask", async () => {
    await mount(todayPayload());
    const parts = [...card().children].map((c) => c.className.split(" ")[0]);
    expect(parts).toEqual(["today-head", "today-title", "today-facts", "today-coach", "body-check", "btn-row"]);
    expect(words(card().querySelector(".today-eyebrow"))).toBe("Today · Mon 5 Oct");
    expect(words(card().querySelector(".today-title"))).toBe("Easy Run with Strides");
    // One sentence of the coach's, never the paragraph.
    expect(words(card().querySelector(".today-coach-body"))).toBe("Coach — Keep the easy days easy.");
    expect(words(card().querySelector(".body-check-q"))).toBe("How’s your body?");
    expect([...card().querySelectorAll(".today-actions > a, .today-actions > button")].map(words)).toEqual(["View workout", "Ask"]);
    expect(card().querySelector(".today-actions a")?.getAttribute("href")).toBe("/plan?workout=run-1");
  });

  it("with no weekly line, the coach line is the morning's verdict applied to the day", async () => {
    await mount(todayPayload({ focus: null }));
    expect(words(card().querySelector(".today-coach-body"))).toBe("Coach — Green lights this morning — today can take its full effort.");
  });

  it("a workout needing attention is folded into the facts", async () => {
    await mount(todayPayload({ needsAttention: [{ ...run, id: "w-9" }] }));
    const facts = card().querySelector(".today-facts")!;
    expect(words(facts.querySelector(".today-attention"))).toContain("1 workout needs attention");
  });

  it("another session today is one quiet row under the card's own, headed Also today", async () => {
    await mount(todayPayload({ todaySessions: [{ workout: run, build: null }, { workout: slot, build: null }] }));
    const also = card().querySelector(".today-also")!;
    expect(words(also.querySelector(".today-also-h"))).toBe("Also today");
    expect(also.querySelectorAll(".today-session")).toHaveLength(1);
    expect(words(also)).toContain("Garden program");
  });

  it("a rest day says so, with one gentle suggestion, no body check, and asks about the day", async () => {
    await mount(todayPayload({ nextWorkout: rest, todaySessions: [{ workout: rest, build: null }] }));
    expect(words(card().querySelector(".today-title"))).toBe("Rest day");
    expect(card().querySelectorAll(".today-rest-line")).toHaveLength(1);
    expect(card().querySelector(".body-check")).toBeNull();
    expect([...card().querySelectorAll("button")].map(words)).toContain("Ask");
  });

  it("the body check asks only of today's session still to do: not tomorrow's, not one already done", async () => {
    const tomorrow = { ...run, id: "run-2", effectiveDate: "2026-10-06" };
    await mount(todayPayload({ nextWorkout: tomorrow, todaySessions: [] }));
    expect(words(card().querySelector(".today-eyebrow"))).toBe("Tomorrow · Tue 6 Oct");
    expect(card().querySelector(".body-check")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const done = { ...run, completionState: "completed" };
    await mount(todayPayload({ nextWorkout: done, todaySessions: [{ workout: done, build: null }] }));
    expect(card().querySelector(".body-check")).toBeNull();
  });

  it("a programme day: the session's own Start, then Ask, in one row; the body check and the coach line before them", async () => {
    await mount(todayPayload({ nextWorkout: slot, todaySessions: [{ workout: slot, build: null }] }));
    const parts = [...card().children].map((c) => c.className.split(" ")[0]);
    expect(parts.slice(parts.indexOf("today-coach"))).toEqual(["today-coach", "body-check", "btn-row"]);
    expect([...card().querySelectorAll(".today-actions > a, .today-actions > button")].map(words)).toEqual(["Start", "Ask"]);
  });

  it("gone from the home: the week ribbon, Minimize and its pill, the grows line, Lately, the streak band, the scene's chips, the foot", async () => {
    await mount(todayPayload());
    for (const gone of [".week-ribbon", ".dock-collapse", ".dock-pill", ".dock-grows", ".lately", ".streak-band", ".garden-below", ".howworks"]) {
      expect(host!.querySelector(gone), gone).toBeNull();
    }
    const chips = [...host!.querySelectorAll(".scene-chip")].map((c) => c.getAttribute("aria-label") ?? "");
    expect(chips.some((c) => /Collection|Garden log|Timeline/.test(c))).toBe(false);
  });

  it("the coach sees today's session; with no coach in the app there is no Ask, and no way round to the Plan", async () => {
    const seeing = new SeeingRegistry();
    await mount(todayPayload(), { seeing });
    expect(seeing.current).toMatchObject({ kind: "workout", id: "run-1" });
    act(() => root?.unmount());
    host?.remove();
    await mount(todayPayload(), { coach: null });
    expect([...card().querySelectorAll("button, a")].map(words)).not.toContain("Ask");
    expect(card().querySelector('a[href^="/plan?coach"]')).toBeNull();
  });

  it("on a rest day the coach sees the day", async () => {
    const seeing = new SeeingRegistry();
    await mount(todayPayload({ nextWorkout: rest, todaySessions: [{ workout: rest, build: null }] }), { seeing });
    expect(seeing.current).toMatchObject({ kind: "day", id: TODAY });
  });
});

describe("the garden drawer", () => {
  it("a handle at the card's foot opens Your garden: next to bloom, twelve weeks, last trained, the collection, the log, the timeline, Growth and how it works", async () => {
    await mount(todayPayload());
    const handle = host!.querySelector<HTMLButtonElement>(".garden-handle")!;
    expect(handle.tagName).toBe("BUTTON");
    expect(handle.getAttribute("aria-haspopup")).toBe("dialog");
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    // At the card's foot: after the card in the same column.
    expect(card().compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => handle.click());
    const d = dialog()!;
    expect(words(d.querySelector("h2"))).toBe("Your garden");
    const heads = [...d.querySelectorAll(".garden-drawer-h")].map(words);
    expect(heads).toEqual(["Next to bloom", "Twelve weeks", "Last trained"]);
    expect(d.querySelector(".streak-weeks")?.children).toHaveLength(12);
    expect(d.querySelectorAll(".balance-bar")).toHaveLength(3);
    const buttons = [...d.querySelectorAll("button")].map(words);
    expect(buttons).toEqual(expect.arrayContaining(["Collection · 0 of 0", "Garden log", "Timeline", "How the garden works▸"]));
    expect(d.querySelector('a[href="/growth"]')).not.toBeNull();
    expect(handle.getAttribute("aria-expanded")).toBe("true");
  });

  it("pulled up, the handle opens it too", async () => {
    await mount(todayPayload());
    const handle = host!.querySelector<HTMLButtonElement>(".garden-handle")!;
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 600 }));
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 560 }));
    });
    expect(words(dialog()?.querySelector("h2"))).toBe("Your garden");
  });

  it("a small wobble is not a pull", async () => {
    await mount(todayPayload());
    const handle = host!.querySelector<HTMLButtonElement>(".garden-handle")!;
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 600 }));
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 594 }));
    });
    expect(dialog()).toBeNull();
  });

  it("the timeline opens on the scene; the card steps aside until it closes", async () => {
    await mount(todayPayload());
    await act(async () => host!.querySelector<HTMLButtonElement>(".garden-handle")!.click());
    const timeline = [...dialog()!.querySelectorAll("button")].find((b) => words(b) === "Timeline")!;
    await act(async () => timeline.click());
    expect(dialog()).toBeNull();
    expect(host!.querySelector(".timeline-panel")).not.toBeNull();
    expect(host!.querySelector("#dock-panel")).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Close timeline"]')!.click());
    expect(host!.querySelector("#dock-panel")).not.toBeNull();
  });

  it("the collection opens its own panel", async () => {
    await mount(todayPayload());
    await act(async () => host!.querySelector<HTMLButtonElement>(".garden-handle")!.click());
    const collection = [...dialog()!.querySelectorAll("button")].find((b) => words(b).startsWith("Collection"))!;
    await act(async () => collection.click());
    // The drawer gives way to the panel: one dialog at a time.
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
    expect(words(dialog()?.querySelector("h2"))).toMatch(/^Collection/);
  });
});
