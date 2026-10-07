// @vitest-environment jsdom
/**
 * Phase 2a Task 8 — the program card on Plan and its settings (mocks §6, open call "program settings live on the
 * program card").
 *
 *  - The card: name, this week's done of the goal, the block and week, the block's core lifts. Nothing renders
 *    for an account with no active program; "New program…" waits for the player (ruling 2a-R5).
 *  - The settings sheet, from the card: weekly goal, preferred days, minutes, place, block length, modes, care
 *    on/off, name — Save patches the program; Retire asks first. Every label is plain; the care switch is named
 *    by the profile.
 *  - Program slots in the week take the yoga / strength hue by category.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramDto, WorkoutDto } from "@rg/api-client";
import { features } from "../src/features.js";
import { ProgramCard, ProgramCards } from "../src/screens/plan-cards.js";
import { PlanScreen } from "../src/screens/plan.js";
import { WorkoutCell } from "../src/screens/week-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function program(over: Partial<ProgramDto> = {}): ProgramDto {
  return {
    id: "p1",
    kind: "adaptive",
    name: "Garden program",
    status: "active",
    config: {
      weeklyGoal: 4,
      preferredDays: [0, 2],
      defaultMinutes: 30,
      defaultLocationId: null,
      blockWeeks: 5,
      modes: ["recovery", "consistent", "build"],
      careProfiles: ["p-x"],
      placementWeeksAhead: 2,
    },
    block: {
      number: 2,
      week: 3,
      weeks: 5,
      core: [
        { family: "squat", exerciseId: "goblet", name: "Goblet squat" },
        { family: "hinge", exerciseId: "kbdl", name: "KB deadlift" },
        { family: "row", exerciseId: "row", name: "Supported row" },
        { family: "press", exerciseId: "fp", name: "Floor press" },
        { family: "carry", exerciseId: "sc", name: "Suitcase carry" },
      ],
    },
    week: { placed: 4, done: 1, goal: 4 },
    ...over,
  };
}

const PLACES = [
  { id: "home", name: "Home", isDefault: true },
  { id: "gym", name: "Gym", isDefault: false },
];
const PROFILES = [{ profileId: "p-x", check: { label: "Knee / hip", min: 0, max: 10 }, care: "Knee care" }];

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function html(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)));
}

// These cases were written against the dark state: each starts with the player off and turns it on where it says
// so; afterwards the shipped default (on) is back.
beforeEach(() => {
  features.player = false;
});
afterEach(() => {
  features.player = true;
});

describe("the program card", () => {
  it("name, this week's done of the goal, the block and week, and the core lifts", () => {
    const out = text(html(createElement(ProgramCard, { program: program(), onOpen: () => undefined })));
    expect(out).toContain("Garden program");
    expect(out).toContain("1 of 4 this week");
    expect(out).toContain("Block 2 · week 3 of 5");
    expect(out).toContain("Squat Goblet squat");
    expect(out).toContain("Hinge KB deadlift");
    expect(out).toContain("Row · Press · Carry Supported row · Floor press · Suitcase carry");
  });

  it("its accessible name is what it shows, then that it opens the settings (audit 2a-UI M15)", () => {
    const out = html(createElement(ProgramCard, { program: program(), onOpen: () => undefined }));
    // No aria-label: it would replace the count, the block and the lifts for anyone who hears the card.
    expect(out).not.toContain("aria-label");
    expect(out).toMatch(/<span class="visually-hidden"> settings<\/span><\/button>$/);
    const name = text(out);
    expect(name.startsWith("Garden program 1 of 4 this week Block 2 · week 3 of 5 Squat Goblet squat")).toBe(true);
    expect(name.endsWith("settings")).toBe(true);
  });

  it("before its first session: no block line, no lifts", () => {
    const out = text(html(createElement(ProgramCard, { program: program({ block: null, week: { placed: 2, done: 0, goal: 2 } }), onOpen: () => undefined })));
    expect(out).toContain("0 of 2 this week");
    expect(out).not.toContain("Block");
  });

  it("renders nothing for an account with no active program — a retired one included — and no New program… before the player", () => {
    const none = { programs: [], places: [], profiles: [] };
    expect(html(createElement(ProgramCards, { data: none }))).toBe("");
    expect(html(createElement(ProgramCards, { data: { ...none, programs: [program({ status: "retired" })] } }))).toBe("");
    expect(text(html(createElement(ProgramCards, { data: { ...none, programs: [program()] } })))).not.toContain("New program");
  });

  it("with the player, New program… is offered", () => {
    features.player = true;
    expect(text(html(createElement(ProgramCards, { data: { programs: [], places: [], profiles: [] } })))).toContain("New program…");
  });
});

describe("program slots in the week", () => {
  it("take the yoga or strength hue by category", () => {
    const slot = (category: string) =>
      ({
        id: `s-${category}`, title: "Garden program", category, sport: category, originalPlanDate: "2026-10-05", lastVerifiedCorosDate: "",
        effectiveDate: "2026-10-05", effectiveTime: "19:00", workoutSeconds: 1800, calendarSeconds: 1800, calendarSyncState: "synced",
        corosSyncState: "calendar_only", completionState: "scheduled", archived: false, origin: "program", contentState: "outline", programId: "p1",
      }) as WorkoutDto;
    expect(html(createElement(WorkoutCell, { w: slot("yoga"), today: "2026-10-05", onOpen: () => undefined }))).toContain("cat-yoga");
    expect(html(createElement(WorkoutCell, { w: slot("strength"), today: "2026-10-05", onOpen: () => undefined }))).toContain("cat-strength");
  });
});

describe("the Plan page waits for the programs before its first paint (audit 2a-UI M11e)", () => {
  // The page itself, against a stubbed worker: what it shows while the programs are in flight, and after.
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T08:00:00"));
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
    vi.unstubAllGlobals();
  });

  const WEEK = {
    weekStart: "2026-10-05",
    days: ["05", "06", "07", "08", "09", "10", "11"].map((d) => ({ date: `2026-10-${d}`, workouts: [] })),
    plannedSeconds: 0,
    doneCount: 0,
    sessionCount: 0,
    weekIndex: null,
    weekTotal: null,
    adherence4w: { pct: null, trend: null },
    loadRatio: null,
    adventureDays: 0,
    headline: "on_track",
    focus: null,
  };

  /** Mounts the Plan page; `programs` answers `/api/programs` when the test says so. */
  function mountPlan(programs: () => Promise<Response>) {
    const calls: string[] = [];
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace(/\?.*$/, "");
        calls.push(path);
        if (path === "/api/programs") return programs();
        if (path === "/api/plan/week") return json(WEEK);
        if (path === "/api/plan/workouts") return json({ today: "2026-10-05", workouts: [], plan: null });
        if (path === "/api/coach/plans") return json({ plans: [] });
        if (path === "/api/coach/state") {
          return json({ messages: [], pendingProposals: [], settledProposals: [], openQuestion: null, memoryCount: 0, lastCoachAt: null, wakeAdvised: false });
        }
        if (path === "/api/plan/race") return json({ race: null });
        if (path === "/api/settings") return json({ prefs: { units: "km", timezone: "America/Los_Angeles" } });
        return json({});
      }),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    // The app's own retry rule (app.tsx: up to two retries), quickly: a query that should not retry has to say so.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: (count) => count < 2, retryDelay: 1 } } });
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: ["/plan"] }, createElement(PlanScreen))),
      );
    });
    return { calls };
  }
  const settle = async (n = 20) => {
    for (let i = 0; i < n; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
  };
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

  it("holds its first paint while the programs are in flight, then paints the week and the program card together", async () => {
    let answer: (r: Response) => void = () => undefined;
    const { calls } = mountPlan(() => new Promise<Response>((resolve) => (answer = resolve)));
    await settle();
    // Everything else has answered; the page is still the one spinner, with no week drawn above a card to come.
    expect(calls).toEqual(expect.arrayContaining(["/api/plan/week", "/api/plan/workouts", "/api/coach/plans", "/api/plan/race"]));
    expect(host!.textContent).toContain("Loading plan");
    expect(host!.textContent).not.toContain("This week");
    answer(ok({ programs: [program()], places: PLACES, profiles: PROFILES }));
    await settle();
    expect(host!.textContent).not.toContain("Loading plan");
    expect(host!.textContent).toContain("This week");
    expect(host!.querySelector(".program-card")?.textContent).toContain("1 of 4 this week");
  });

  it("an account with no program: no card, no program section", async () => {
    mountPlan(async () => ok({ programs: [], places: [], profiles: [] }));
    await settle();
    expect(host!.textContent).toContain("This week");
    expect(host!.querySelector(".program-card, .program-cards")).toBeNull();
  });

  it("the programs failing paints the page at once, without the card — one attempt, no retries (audit 2a-UI M8)", async () => {
    const { calls } = mountPlan(async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
    await settle();
    expect(host!.textContent).toContain("This week");
    expect(host!.querySelector(".program-card")).toBeNull();
    expect(calls.filter((c) => c === "/api/programs")).toHaveLength(1);
  });
});

describe("program settings", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    vi.unstubAllGlobals();
  });

  function mount(p: ProgramDto = program()) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method: init?.method ?? "GET", path: url, body });
        return new Response(JSON.stringify({ program: p }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(MemoryRouter, null, createElement(ProgramCards, { data: { programs: [p], places: PLACES, profiles: PROFILES } })),
        ),
      );
    });
    return { calls };
  }

  const all = () => [...document.querySelectorAll<HTMLElement>("button, input, select")];
  const byName = (name: string) =>
    all().find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim() === name);
  const press = async (name: string) => {
    const b = byName(name);
    if (!b) throw new Error(`no control ${name}\n${document.body.textContent}`);
    await act(async () => {
      b.click();
    });
  };
  /** The card opens its settings (its name is its content, then "settings": see M15 above). */
  const openSettings = async () => {
    const card = document.querySelector<HTMLButtonElement>(".program-card");
    if (!card) throw new Error(`no program card\n${document.body.textContent}`);
    await act(async () => {
      card.click();
    });
  };
  const pressed = (group: string) =>
    [...document.querySelectorAll(`[aria-label="${group}"] [aria-pressed="true"]`)].map((b) => b.textContent);
  const setValue = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  };
  async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200; i += 1) {
      if (check()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  it("opens from the card with the program's settings, in plain labels, the care switch named by the profile", async () => {
    mount();
    await openSettings();
    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("Garden program");
    expect((byName("Name") as HTMLInputElement).value).toBe("Garden program");
    expect(pressed("Sessions a week")).toEqual(["4"]);
    expect(pressed("Days")).toEqual(["M", "W"]);
    expect((byName("Minutes") as HTMLSelectElement).value).toBe("30");
    expect((byName("Place") as HTMLSelectElement).value).toBe("");
    expect(pressed("Block length")).toEqual(["5 weeks"]);
    expect(pressed("Modes")).toEqual(["Recovery", "Consistent", "Build"]);
    expect(byName("Knee care")?.getAttribute("aria-checked")).toBe("true");
  });

  it("Save patches what changed into the program's config", async () => {
    const { calls } = mount();
    await openSettings();
    await setValue(byName("Name") as HTMLInputElement, "Evening care");
    await press("3");
    await press("F");
    await setValue(byName("Minutes") as HTMLSelectElement, "45");
    await setValue(byName("Place") as HTMLSelectElement, "gym");
    await press("6 weeks");
    await press("Recovery");
    await press("Knee care");
    await press("Save");
    await until(() => calls.some((c) => c.method === "PATCH"), "the patch");
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      method: "PATCH",
      path: "/api/programs/p1",
      body: {
        name: "Evening care",
        config: {
          weeklyGoal: 3,
          preferredDays: [0, 2, 4],
          defaultMinutes: 45,
          defaultLocationId: "gym",
          blockWeeks: 6,
          modes: ["consistent", "build"],
          careProfiles: [],
        },
      },
    });
  });

  it("the days go in week order, whatever order they were tapped in — placement fills them in that order (audit 2a-UI M4)", async () => {
    const { calls } = mount();
    await openSettings();
    await press("W"); // off
    await press("F");
    await press("W"); // on again, after F
    await press("Save");
    await until(() => calls.some((c) => c.method === "PATCH"), "the patch");
    expect((calls.find((c) => c.method === "PATCH")!.body as { config: { preferredDays: number[] } }).config.preferredDays).toEqual([0, 2, 4]);
  });

  it("the last mode cannot be switched off", async () => {
    mount(program({ config: { ...program().config, modes: ["consistent"] } }));
    await openSettings();
    expect((byName("Consistent") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Retire asks first, then retires", async () => {
    const { calls } = mount();
    await openSettings();
    await press("Retire…");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // What stays is named, today's session first: it stays on Today under the program's name (audit 2a-UI M5).
    const question = [...document.querySelectorAll("[role=dialog]")].at(-1)!.textContent!.replace(/\s+/g, " ");
    expect(question).toContain("Today's session stays");
    expect(question).toContain("after today");
    await press("Retire program");
    await until(() => calls.some((c) => c.method === "PATCH"), "the retire");
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "retired" });
  });
});
