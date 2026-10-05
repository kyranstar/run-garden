// @vitest-environment jsdom
/**
 * Phase 2a Task 6 — today's program session and the condition check on the Today card (mocks §1).
 *
 *  - Layout: the run keeps the title and its actions; a program session is one line beside it; a program day
 *    gives the program session the title. An account with no program sees exactly what it saw before.
 *  - The program title and line in each content state: outline, built, started, done. Start and Continue wait
 *    for the player (`features.player`); until then "Open" leads to the session sheet.
 *  - The condition chip: "<word> check" before today's check, "<word> 2" after — the word is the profile's own
 *    (`check.label`'s first word), never one the UI holds — and the sheet that records it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse, WorkoutDto } from "@rg/api-client";
import { features } from "../src/features.js";
import {
  programName,
  todayCardLayout,
  TodayProgramLead,
  TodayProgramLine,
} from "../src/components/today-program.js";
import {
  checkWord,
  ConditionCheckSheet,
  ConditionChips,
  conditionChipLabel,
} from "../src/components/condition-check-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Session = TodayResponse["todaySessions"][number];
type Condition = TodayResponse["conditions"][number];

const TODAY = "2026-10-05";

function workout(over: Partial<WorkoutDto> = {}): WorkoutDto {
  return {
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
    ...over,
  } as WorkoutDto;
}

const slotWorkout = (over: Partial<WorkoutDto> = {}) =>
  workout({
    id: "slot-p1-2026-10-05",
    title: "Garden program",
    category: "yoga",
    sport: "yoga",
    lastVerifiedCorosDate: "",
    effectiveTime: "19:00",
    workoutSeconds: 1800,
    calendarSeconds: 1800,
    stageSummary: null,
    corosSyncState: "calendar_only",
    origin: "program",
    contentState: "outline",
    programId: "p1",
    ...over,
  });

const runSession = (over: Partial<WorkoutDto> = {}): Session => ({ workout: workout(over), build: null });
const outline = (over: Partial<WorkoutDto> = {}): Session => ({ workout: slotWorkout(over), build: null });
const built = (over: Partial<WorkoutDto> = {}, build: Partial<NonNullable<Session["build"]>> = {}): Session => ({
  workout: slotWorkout({ title: "Garden program · Hips & posture", category: "strength", contentState: "built", ...over }),
  build: {
    mode: "build",
    theme: "Hips & posture",
    minutes: 30,
    place: "Home",
    lead: {
      moves: [
        { name: "Goblet squat", dose: "3 × 6 @ 30 lb", up: true },
        { name: "KB deadlift", dose: "3 × 8", up: false },
      ],
      more: 12,
    },
    ...build,
  },
});

function html(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

/** Text only, whitespace collapsed — what a reader sees. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

afterEach(() => {
  features.player = false;
});

// ── Which session takes the title ──────────────────────────────────────────

describe("todayCardLayout", () => {
  it("an account with no program: the next workout is the title and there are no lines", () => {
    const run = runSession();
    expect(todayCardLayout(run.workout, [run])).toEqual({ title: { kind: "run", workout: run.workout }, lines: [] });
  });

  it("a run and a program session: the run keeps the title, the session is a line", () => {
    const run = runSession();
    const slot = outline();
    expect(todayCardLayout(run.workout, [run, slot])).toEqual({ title: { kind: "run", workout: run.workout }, lines: [slot] });
  });

  it("keeps the run's title even when the program session comes first in the day", () => {
    const run = runSession({ effectiveTime: "18:00" });
    const slot = outline({ effectiveTime: "07:00" });
    expect(todayCardLayout(run.workout, [slot, run])).toEqual({ title: { kind: "run", workout: run.workout }, lines: [slot] });
  });

  it("a program day: the program session takes the title, whatever comes next", () => {
    const slot = outline();
    expect(todayCardLayout(slot.workout, [slot])).toEqual({ title: { kind: "program", session: slot }, lines: [] });
    const tomorrow = workout({ id: "run-2", effectiveDate: "2026-10-06" });
    expect(todayCardLayout(tomorrow, [slot])).toEqual({ title: { kind: "program", session: slot }, lines: [] });
  });

  it("two program sessions and no run: the first takes the title, the second is a line", () => {
    const a = outline({ id: "a", effectiveTime: "07:00" });
    const b = outline({ id: "b", effectiveTime: "19:00" });
    expect(todayCardLayout(a.workout, [a, b])).toEqual({ title: { kind: "program", session: a }, lines: [b] });
  });

  it("a rest day's row is never a line, and nothing at all is nothing", () => {
    const rest = runSession({ id: "rest", category: "rest" });
    const next = workout({ id: "run-2", effectiveDate: "2026-10-06" });
    expect(todayCardLayout(next, [rest])).toEqual({ title: { kind: "run", workout: next }, lines: [] });
    expect(todayCardLayout(null, [])).toEqual({ title: null, lines: [] });
  });
});

describe("programName", () => {
  it("is the row's title without the theme the build appended", () => {
    expect(programName(built())).toBe("Garden program");
    expect(programName(outline())).toBe("Garden program");
  });
});

// ── The program session as the title (a program day) ───────────────────────

describe("TodayProgramLead", () => {
  it("outline: the name, when and how long, and Open — no Start before the player exists", () => {
    const out = html(createElement(TodayProgramLead, { session: outline(), today: TODAY }));
    expect(out).toContain("Garden program");
    expect(text(out)).toContain("7 PM · 30 min");
    expect(out).toContain('href="/plan?workout=slot-p1-2026-10-05"');
    expect(text(out)).toContain("Open");
    expect(text(out)).not.toContain("Start");
  });

  it("built: mode, theme, minutes and place, then the lead moves with the one going up marked", () => {
    const out = text(html(createElement(TodayProgramLead, { session: built(), today: TODAY })));
    expect(out).toContain("Garden program");
    expect(out).not.toContain("Garden program · Hips");
    expect(out).toContain("Build · Hips & posture · 30 min · Home");
    expect(out).toContain("Goblet squat 3 × 6 @ 30 lb ↑ · KB deadlift 3 × 8 · 12 more");
  });

  it("with the player: Start on today's session, Continue once started, neither once done", () => {
    features.player = true;
    expect(text(html(createElement(TodayProgramLead, { session: built(), today: TODAY })))).toContain("Start");
    const started = text(html(createElement(TodayProgramLead, { session: built({ contentState: "started" }), today: TODAY })));
    expect(started).toContain("Continue");
    expect(started).not.toContain("Start");
    const done = text(html(createElement(TodayProgramLead, { session: built({ contentState: "done" }), today: TODAY })));
    expect(done).toContain("Done");
    expect(done).not.toMatch(/Start|Continue/);
  });

  it("without the player a started session still opens, and a done one says so", () => {
    const started = text(html(createElement(TodayProgramLead, { session: built({ contentState: "started" }), today: TODAY })));
    expect(started).toContain("Open");
    expect(started).not.toContain("Continue");
    expect(text(html(createElement(TodayProgramLead, { session: built({ completionState: "completed" }), today: TODAY })))).toContain("Done");
  });
});

// ── The program session as a line under the run ─────────────────────────────

describe("TodayProgramLine", () => {
  it("built: dot, name, mode · minutes · time, and Open", () => {
    const out = html(createElement(TodayProgramLine, { session: built({}, { mode: "consistent" }), today: TODAY }));
    expect(out).toContain("cat-strength");
    expect(text(out)).toContain("Garden program Consistent · 30 min · 7 PM");
    expect(out).toContain('href="/plan?workout=slot-p1-2026-10-05"');
  });

  it("outline: minutes from the row, no mode yet", () => {
    expect(text(html(createElement(TodayProgramLine, { session: outline(), today: TODAY })))).toContain("Garden program 30 min · 7 PM");
  });

  it("started and done", () => {
    features.player = true;
    expect(text(html(createElement(TodayProgramLine, { session: outline(), today: TODAY })))).toContain("Start");
    expect(text(html(createElement(TodayProgramLine, { session: built({ contentState: "started" }), today: TODAY })))).toContain("Continue");
    const done = text(html(createElement(TodayProgramLine, { session: built({ contentState: "done" }), today: TODAY })));
    expect(done).toContain("Done");
    expect(done).not.toMatch(/Start|Continue/);
  });
});

// ── The condition chip and its sheet ────────────────────────────────────────

const condition = (over: Partial<Condition> = {}): Condition => ({
  profileId: "p-x",
  check: { label: "Knee / hip", min: 0, max: 10 },
  care: "Knee care",
  today: null,
  ...over,
});

describe("the condition chip", () => {
  it("takes its word from the profile's check label", () => {
    expect(checkWord("Knee / hip")).toBe("Knee");
    expect(checkWord("Back")).toBe("Back");
  });

  it("reads '<word> check' before today's check and '<word> 2' after; feeling off says so", () => {
    expect(conditionChipLabel(condition())).toBe("Knee check");
    expect(conditionChipLabel(condition({ today: { value: 2, feelingOff: false } }))).toBe("Knee 2");
    expect(conditionChipLabel(condition({ today: { value: 2, feelingOff: true } }))).toBe("Knee 2 · off");
    expect(conditionChipLabel(condition({ today: { value: null, feelingOff: true } }))).toBe("Knee · off");
  });

  it("renders nothing for an account with no conditions (no program)", () => {
    expect(html(createElement(ConditionChips, { conditions: [], onOpen: () => undefined }))).toBe("");
  });

  it("renders one chip per profile, before and after the check", () => {
    const out = html(
      createElement(ConditionChips, {
        conditions: [condition(), condition({ profileId: "p-y", check: { label: "Wrist", min: 0, max: 10 }, today: { value: 4, feelingOff: false } })],
        onOpen: () => undefined,
      }),
    );
    expect(text(out)).toContain("Knee check ›");
    expect(text(out)).toContain("Wrist 4 ›");
  });
});

describe("no condition word lives in the UI's code", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it.each(["../src/components/today-program.tsx", "../src/components/condition-check-sheet.tsx", "../src/screens/garden.tsx"])(
    "%s",
    (file) => {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/\b(jaw|tmj|clench)/i);
    },
  );
});

describe("the check sheet", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    vi.unstubAllGlobals();
  });

  function mount(c: Condition, onClose = vi.fn()) {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ check: { profileId: c.profileId, date: TODAY, value: 3, feelingOff: true } }), {
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
      root!.render(createElement(QueryClientProvider, { client: qc }, createElement(ConditionCheckSheet, { condition: c, onClose })));
    });
    return { calls, onClose };
  }

  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".check-scale button")];
  const byText = (t: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t)!;

  it("is titled by the profile's check label, with a 0–10 scale in two rows and Feeling off", () => {
    mount(condition());
    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("Knee / hip");
    expect(buttons().map((b) => b.textContent)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(byText("Feeling off")).toBeTruthy();
    expect(byText("Save").disabled).toBe(true);
  });

  it("starts from today's reading", () => {
    mount(condition({ today: { value: 2, feelingOff: false } }));
    expect(buttons().find((b) => b.getAttribute("aria-pressed") === "true")?.textContent).toBe("2");
  });

  it("Save records the check and closes", async () => {
    const { calls, onClose } = mount(condition());
    act(() => buttons()[3]!.click());
    act(() => byText("Feeling off").click());
    expect(byText("Feeling off").getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      byText("Save").click();
    });
    expect(calls).toEqual([{ url: "/api/conditions/checks", body: { profileId: "p-x", value: 3, feelingOff: true } }]);
    expect(onClose).toHaveBeenCalled();
  });
});
