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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { DockPill } from "../src/screens/garden.js";

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

  it("an account with no program: two runs at the same minute keep the next workout's title, not today's order", () => {
    const first = runSession({ id: "run-a", effectiveTime: "07:00" });
    const second = runSession({ id: "run-b", effectiveTime: "07:00" });
    // `nextWorkout` chose run-b; today's list orders run-a first. The card follows `nextWorkout`, as it always did.
    expect(todayCardLayout(second.workout, [first, second])).toEqual({ title: { kind: "run", workout: second.workout }, lines: [] });
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

  it("a skipped session is not today's to-do: another session takes the title, and alone it is shown as skipped (ruling 2a-R15)", () => {
    const skipped = outline({ id: "a", effectiveTime: "07:00", completionState: "skipped" });
    const later = outline({ id: "b", effectiveTime: "19:00" });
    const tomorrow = workout({ id: "run-2", effectiveDate: "2026-10-06" });
    expect(todayCardLayout(later.workout, [skipped, later])).toEqual({ title: { kind: "program", session: later }, lines: [skipped] });
    expect(todayCardLayout(tomorrow, [skipped])).toEqual({ title: { kind: "program", session: skipped }, lines: [] });
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

  it("with the player: Start opens the session's sheet (its pre-check and the Start that locks it, online — 2b-R1); Continue opens the player", () => {
    features.player = true;
    for (const El of [TodayProgramLead, TodayProgramLine]) {
      const start = [...new DOMParser().parseFromString(html(createElement(El, { session: built(), today: TODAY })), "text/html").querySelectorAll("a")];
      expect(start.find((a) => a.textContent === "Start")?.getAttribute("href")).toBe("/plan?workout=slot-p1-2026-10-05");
      const cont = [
        ...new DOMParser()
          .parseFromString(html(createElement(El, { session: built({ contentState: "started" }), today: TODAY })), "text/html")
          .querySelectorAll("a"),
      ];
      expect(cont.find((a) => a.textContent === "Continue")?.getAttribute("href")).toBe("/session/slot-p1-2026-10-05");
    }
  });

  it("skipped: says so, with no play action even with the player — Open, not primary, leads to Un-skip (ruling 2a-R15)", () => {
    features.player = true;
    for (const session of [outline({ completionState: "skipped" }), built({ completionState: "skipped" })]) {
      const out = html(createElement(TodayProgramLead, { session, today: TODAY }));
      expect(text(out)).toContain("Skipped");
      expect(text(out)).not.toMatch(/Start|Continue|Done/);
      expect(out).toContain('href="/plan?workout=slot-p1-2026-10-05"');
      expect(out).not.toContain("btn-primary");
    }
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

  it("skipped: says so, never Start (ruling 2a-R15)", () => {
    features.player = true;
    for (const session of [outline({ completionState: "skipped" }), built({ completionState: "skipped" })]) {
      const out = text(html(createElement(TodayProgramLine, { session, today: TODAY })));
      expect(out).toContain("Skipped");
      expect(out).not.toMatch(/Start|Continue|Done/);
    }
  });
});

describe("the collapsed Today row (DockPill) for a skipped session", () => {
  it("names it skipped, not next (ruling 2a-R15)", () => {
    const pill = text(html(createElement(DockPill, { workout: slotWorkout({ completionState: "skipped" }), today: TODAY, onOpen: () => undefined })));
    expect(pill).not.toContain("Next");
    expect(pill).toContain("Garden program · Today · skipped");
    // A session still to do reads as it always did.
    expect(text(html(createElement(DockPill, { workout: workout(), today: TODAY, onOpen: () => undefined })))).toBe(
      "Next: Easy Run with Strides · Today 7 AM",
    );
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

describe("no condition word lives in the UI's code (audit 2a-UI M11d)", () => {
  // Paths in variables: Vite rewrites a literal `new URL("…", import.meta.url)` as an asset URL.
  const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
  const read = (rel: string) => readFileSync(here(rel), "utf8");
  const src = here("../src/");
  /** Every source file of the UI, the stylesheet included — not a list someone has to keep up to date. */
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(tsx?|css)$/.test(f)).sort();
  /**
   * The words the condition profiles themselves use — each profile's id and label, its check label's words and its
   * flag's label — read from the library, so a profile added there is covered here; plus the stems already known.
   */
  const words = (() => {
    const dir = here("../../exercise-library/src/conditions/");
    const out = new Set(["jaw", "tmj", "clench"]);
    // The profile ids: the keys of `PROFILES`.
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    for (const m of (/PROFILES = \{([^}]*)\}/.exec(index)?.[1] ?? "").matchAll(/(\w+):/g)) out.add(m[1]!.toLowerCase());
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "index.ts" && n !== "types.ts")) {
      const text = readFileSync(join(dir, f), "utf8");
      // The profile's label, its check's label and its flag's label ("TMJ", "Jaw / head", "Clenched"). "head" is
      // also a word the UI uses for other things (a sheet's head), so it is left to the first word.
      for (const m of text.matchAll(/^ {2}(?:label|check: \{ label|setFlag: \{ id: [^,]+, label):\s*"([^"]+)"/gm)) {
        for (const w of m[1]!.split(/[\s/]+/)) if (w.length >= 3 && w.toLowerCase() !== "head") out.add(w.toLowerCase());
      }
    }
    return [...out];
  })();

  it("reads the profiles' own words, and scans every UI source file", () => {
    expect(words).toEqual(expect.arrayContaining(["jaw", "tmj", "clench", "clenched"]));
    expect(files).toEqual(
      expect.arrayContaining([
        "components/today-program.tsx",
        "components/condition-check-sheet.tsx",
        "components/session-sheet.tsx",
        "components/exercise-howto.tsx",
        "components/program-settings-sheet.tsx",
        "screens/plan-cards.tsx",
        "screens/plan.tsx",
        "screens/garden.tsx",
        "styles.css",
      ]),
    );
  });

  it("finds none of them in any of those files", () => {
    const word = new RegExp(`\\b(${words.join("|")})`, "i");
    const hits = files.flatMap((f) => {
      const code = read(`../src/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const m = word.exec(code);
      return m ? [`${f}: "${m[0]}"`] : [];
    });
    expect(hits).toEqual([]);
  });
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

  function mount(c: Condition, onClose = vi.fn(), opts: { restoring?: boolean } = {}) {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        // While a restore replaces the account the server records nothing and answers `{check: null}`.
        const check = opts.restoring ? null : { profileId: c.profileId, date: TODAY, value: 3, feelingOff: true };
        return new Response(JSON.stringify({ check }), {
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
    expect(buttons().find((b) => b.getAttribute("aria-checked") === "true")?.textContent).toBe("2");
  });

  it("the scale is one choice: a radiogroup named by the profile, one tab stop, arrow keys move the choice (audit 2a-UI M3)", async () => {
    mount(condition({ today: { value: 2, feelingOff: false } }));
    const group = document.querySelector(".check-scale")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Knee / hip");
    expect(buttons().every((b) => b.getAttribute("role") === "radio")).toBe(true);
    const tabbable = () => buttons().filter((b) => b.tabIndex === 0).map((b) => b.textContent);
    const checked = () => buttons().filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent);
    expect(tabbable()).toEqual(["2"]);
    const key = async (k: string) => {
      await act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    };
    act(() => buttons()[2]!.focus());
    await key("ArrowRight");
    expect(checked()).toEqual(["3"]);
    expect(document.activeElement?.textContent).toBe("3");
    expect(tabbable()).toEqual(["3"]);
    await key("ArrowLeft");
    await key("ArrowLeft");
    expect(checked()).toEqual(["1"]);
    await key("End");
    expect(checked()).toEqual(["10"]);
    await key("ArrowRight");
    expect(checked()).toEqual(["0"]);
    await key("Home");
    expect(document.activeElement?.textContent).toBe("0");
    // The chosen number is drawn from the state a reader hears.
    const sheet = "../src/styles.css"; // a variable: Vite rewrites a literal `new URL(…, import.meta.url)` as an asset
    const css = readFileSync(fileURLToPath(new URL(sheet, import.meta.url)), "utf8");
    expect(css).toContain('.check-scale button[aria-checked="true"] {');
    expect(css).not.toContain('.check-scale button[aria-pressed="true"]');
  });

  it("tapping the chosen number clears it, so Feeling off alone can be saved (audit 2a-UI M3)", async () => {
    const { calls } = mount(condition({ today: { value: 2, feelingOff: false } }));
    act(() => byText("2").click());
    expect(buttons().filter((b) => b.getAttribute("aria-checked") === "true")).toEqual([]);
    // With nothing chosen the first number is the group's tab stop.
    expect(buttons().filter((b) => b.tabIndex === 0).map((b) => b.textContent)).toEqual(["0"]);
    expect(byText("Save").disabled).toBe(true);
    act(() => byText("Feeling off").click());
    await act(async () => {
      byText("Save").click();
    });
    expect(calls).toEqual([{ url: "/api/conditions/checks", body: { profileId: "p-x", value: null, feelingOff: true } }]);
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

  it("a check the server did not record (a restore running) is not saved: the sheet stays and says so (audit 2a-UI M7)", async () => {
    const { calls, onClose } = mount(condition(), vi.fn(), { restoring: true });
    act(() => buttons()[3]!.click());
    await act(async () => {
      byText("Save").click();
    });
    // The answer settles after the request: wait for the line rather than assume one tick is enough.
    for (let i = 0; i < 100 && !(document.body.textContent ?? "").includes("Not saved"); i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(calls).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Not saved");
  });
});
