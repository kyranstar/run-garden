// @vitest-environment jsdom
/**
 * Phase 2a Task 8 — a program on Plan and its settings (mocks §6, open call "program settings live on the program"),
 * as one row of "Your plans" since the new shape (2026-10-17 §6).
 *
 *  - The row: name, then its kind and state — the block and week, this week's done of the goal. Nothing for an
 *    account with no active program; "New program…" at the list's foot (the player ships: ruling 2a-R5 is met).
 *  - The settings sheet, from the row: weekly goal, preferred days, minutes, place, block length, modes, care
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
import { YourPlans } from "../src/screens/plan-cards.js";
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

const plans = (data: { programs: ProgramDto[]; places: typeof PLACES; profiles: typeof PROFILES } | undefined) =>
  createElement(YourPlans, { plans: [], programs: data, today: "2026-10-05", onOpenPlan: () => undefined });
const rows = (markup: string) => [...markup.matchAll(/<button type="button" class="plan-row"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));

describe("a program's row", () => {
  it("name, then its kind and state: the block and week, this week's done of the goal", () => {
    expect(rows(html(plans({ programs: [program()], places: PLACES, profiles: PROFILES })))).toEqual([
      "Garden program Program · Block 2 · week 3 of 5 · 1 of 4 this week",
    ]);
  });

  it("its accessible name is what it shows, and it says it opens a dialog (audit 2a-UI M15)", () => {
    const out = html(plans({ programs: [program()], places: PLACES, profiles: PROFILES }));
    // No aria-label: it would replace what the row shows for anyone who hears it.
    const row = /<button type="button" class="plan-row"[^>]*>/.exec(out)![0]!;
    expect(row).not.toContain("aria-label");
    expect(row).toContain('aria-haspopup="dialog"');
  });

  it("before its first session: no block, just the week's count", () => {
    expect(rows(html(plans({ programs: [program({ block: null, week: { placed: 2, done: 0, goal: 2 } })], places: [], profiles: [] })))).toEqual([
      "Garden program Program · 0 of 2 this week",
    ]);
  });

  it("no row for an account with no active program — a retired one included — and New program… at the foot", () => {
    const none = { programs: [], places: [], profiles: [] };
    expect(rows(html(plans(none)))).toEqual([]);
    expect(rows(html(plans({ ...none, programs: [program({ status: "retired" })] })))).toEqual([]);
    expect(text(html(plans(none)))).toContain("New program…");
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
    expect(host!.textContent).not.toContain("Your plans");
    answer(ok({ programs: [program()], places: PLACES, profiles: PROFILES }));
    await settle();
    expect(host!.textContent).not.toContain("Loading plan");
    expect(host!.textContent).toContain("Your plans");
    expect(host!.querySelector(".plan-row")?.textContent).toContain("1 of 4 this week");
  });

  it("an account with no program: no row", async () => {
    mountPlan(async () => ok({ programs: [], places: [], profiles: [] }));
    await settle();
    expect(host!.textContent).toContain("Your plans");
    expect(host!.querySelector(".plan-row")).toBeNull();
  });

  it("the programs failing paints the page at once, without the card — one attempt, no retries (audit 2a-UI M8)", async () => {
    const { calls } = mountPlan(async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
    await settle();
    expect(host!.textContent).toContain("Your plans");
    expect(host!.querySelector(".plan-row")).toBeNull();
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

  /** `patches`: what the server says to each PATCH in turn (then plain answers), each after `held` resolves when given. */
  function mount(p: ProgramDto = program(), patches: Array<{ placing?: boolean; held?: Promise<void> }> = []) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method: init?.method ?? "GET", path: url, body });
        const answer = init?.method === "PATCH" ? patches.shift() : undefined;
        if (answer?.held) await answer.held;
        return new Response(JSON.stringify({ program: p, ...(answer?.placing ? { placing: true } : {}) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
          createElement(MemoryRouter, null, plans({ programs: [p], places: PLACES, profiles: PROFILES })),
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
  /** The row opens its settings. */
  const openSettings = async () => {
    const card = document.querySelector<HTMLButtonElement>(".plan-row");
    if (!card) throw new Error(`no program row\n${document.body.textContent}`);
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

  it("opens from the row with the program's settings, in plain labels, the care switch named by the profile", async () => {
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

  it("a save the server is still placing (`placing`, every request within its budget) asks again until it isn't, saying so meanwhile", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { calls } = mount(program(), [{ placing: true }, { placing: true, held }, {}]);
    await openSettings();
    await press("F");
    await press("Save");
    await until(() => calls.filter((c) => c.method === "PATCH").length === 2, "the second request");
    // While the server moves them, the sheet says so, and Save can't be pressed twice.
    const footer = () => document.querySelector("[role=dialog] .btn-primary") as HTMLButtonElement;
    expect(footer().textContent).toBe("Moving your sessions…");
    expect(footer().disabled).toBe(true);
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    release();
    await until(() => document.querySelector("[role=dialog]") === null, "the sheet closed once placed");
    const patches = calls.filter((c) => c.method === "PATCH");
    // The save once; then the rest asked for with nothing to change.
    expect(patches.map((c) => c.body)).toEqual([
      expect.objectContaining({ config: expect.objectContaining({ preferredDays: [0, 2, 4] }) }),
      {},
      {},
    ]);
    expect(new Set(patches.map((c) => c.path))).toEqual(new Set(["/api/programs/p1"]));
  });

  it("Retire, when the server is still taking sessions back, asks again until it isn't", async () => {
    const { calls } = mount(program(), [{ placing: true }, {}]);
    await openSettings();
    await press("Retire…");
    await press("Retire program");
    await until(() => document.querySelector("[role=dialog]") === null, "the sheet closed once retired");
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ status: "retired" }, {}]);
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
