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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgramDto, WorkoutDto } from "@rg/api-client";
import { features } from "../src/features.js";
import { ProgramCard, ProgramCards } from "../src/screens/plan-cards.js";
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

afterEach(() => {
  features.player = false;
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

describe("the Plan page waits for the programs before its first paint", () => {
  it("the programs query is in the gate", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/screens/plan.tsx"), "utf8");
    const gate = src.slice(src.indexOf("if (settling("), src.indexOf("\n", src.indexOf("if (settling(")));
    expect(gate).toContain("programs");
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
    await press("Garden program settings");
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
    await press("Garden program settings");
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

  it("the last mode cannot be switched off", async () => {
    mount(program({ config: { ...program().config, modes: ["consistent"] } }));
    await press("Garden program settings");
    expect((byName("Consistent") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Retire asks first, then retires", async () => {
    const { calls } = mount();
    await press("Garden program settings");
    await press("Retire…");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await press("Retire program");
    await until(() => calls.some((c) => c.method === "PATCH"), "the retire");
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "retired" });
  });
});
