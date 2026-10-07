// @vitest-environment jsdom
/**
 * Phase 2a Task 7 — the session sheet for program slots (mocks §2–3), driven against a stubbed worker.
 *
 *  - The pre-check comes first when today's reading is missing; answering it builds. With it answered, opening
 *    the sheet builds (or returns the stored build) without asking.
 *  - Built: mode · theme · time · place chips, each a short picker that rebuilds; one reason line; the moves by
 *    block with their format, dose, ↑ and New; ⇄ offers the alternatives and Use rebuilds with the swap; ⓘ opens
 *    the how-to (its rating controls wait for 2c — absent, not dead).
 *  - Start waits for the player (`features.player`); a day ahead is a preview; a day gone offers a move; a started
 *    session is read-only.
 *  - The words are the profile's own: the pre-check, the reading on the meta line, the care block, the note.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, SessionExerciseDto, WorkoutDto } from "@rg/api-client";
import { features } from "../src/features.js";
import { SessionSheet } from "../src/components/session-sheet.js";
import { WorkoutDetail } from "../src/screens/plan.js";
import { IDBFactory } from "fake-indexeddb";
import { offlineDb } from "../src/offline/idb.js";
import { loadBuild } from "../src/offline/builds.js";
import { loadExtras } from "../src/player/stored.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";
const SLOT = "slot-p1-2026-10-05";

function ex(id: string, name: string, over: Partial<SessionExerciseDto> = {}): SessionExerciseDto {
  return {
    id,
    legacyIds: [],
    name,
    family: "x",
    patterns: [],
    regions: [],
    roles: [],
    equipment: { all: [], oneOf: [] },
    position: "standing",
    laterality: "bilateral",
    load: "external",
    dose: { type: "reps", range: [5, 8], sets: [3, 3], restSec: 75 },
    difficulty: 2,
    easier: [],
    harder: [],
    tags: [],
    text: { summary: `${name} summary.`, setup: [], steps: [], focus: [], mistakes: [], breathing: "", why: "", conditions: {} },
    conditions: {},
    ...over,
  } as SessionExerciseDto;
}

const timed = (slotKey: string, block: string, exerciseId: string, seconds: number, format = "flow", side: "Left" | "Right" | null = null) => ({
  kind: "timed", slotKey, block, exerciseId, side, setIndex: 0, setCount: 1, seconds, prepGap: 0, target: null,
  format: { id: format, group: null, round: null }, why: [], isNew: false, log: false,
});
const setStep = (slotKey: string, exerciseId: string, group: string, i: number) => ({
  kind: "set", slotKey, block: "core", exerciseId, side: null, setIndex: i, setCount: 3, seconds: 50, prepGap: 0, target: null,
  format: { id: "superset", group, round: null }, why: [], isNew: false, log: true,
});
const target = (reps: number, v: number, action = "start") => ({
  lo: 5, hi: 10, type: "reps", w: { v, u: "lb" }, reps, secs: null, graduate: null, last: null, lastDate: null, action, note: "",
});

function session(over: Partial<SessionDto> = {}): SessionDto {
  return {
    workoutId: SLOT,
    date: TODAY,
    contentState: "built",
    locked: false,
    checks: { "p-x": { pre: 1, feelingOff: false } },
    profiles: [{ profileId: "p-x", check: { label: "Knee / hip", min: 0, max: 10 }, care: "Knee care" }],
    choices: {
      modes: ["recovery", "consistent", "build"],
      themes: [
        { id: "hipsPosture", name: "Hips & posture", modes: ["consistent", "build"] },
        { id: "deskUnwind", name: "Desk unwind", modes: ["recovery", "consistent", "build"] },
      ],
      locations: [
        { id: "home", name: "Home" },
        { id: "gym", name: "Gym" },
      ],
    },
    view: {
      mode: "build",
      proposedMode: "build",
      modeReasons: ["Knee calm (1) · 3 sessions in the last 7 days."],
      theme: { id: "hipsPosture", name: "Hips & posture" },
      proposedTheme: { id: "hipsPosture", name: "Hips & posture" },
      themeReasons: [],
      minutes: 30,
      location: { id: "home", name: "Home" },
      block: { number: 2, week: 3, weeks: 5, core: [{ family: "squat", name: "Goblet squat" }], events: [] },
      newMove: "rowX",
    },
    build: {
      buildId: "b1",
      version: 1,
      engineVersion: "e",
      inputsHash: "h",
      builtAt: "2026-10-05T12:00:00.000Z",
      date: TODAY,
      mode: "build",
      modeReasons: [],
      theme: "hipsPosture",
      themeReasons: [],
      minutes: 30,
      locationId: "home",
      blockRef: "blk",
      weekOfBlock: 3,
      plannedSeconds: 1800,
      steps: [
        timed("arrive:0", "arrive", "breath", 90, "holds"),
        timed("prep:0", "prep", "catCow", 50),
        setStep("core:0", "goblet", "A", 0),
        setStep("core:1", "rowX", "B", 0),
        timed("care:0", "care", "chinTuck", 40, "holds"),
        timed("cooldown:0", "cooldown", "twist", 45, "flow", "Left"),
        timed("cooldown:0", "cooldown", "twist", 45, "flow", "Right"),
      ],
      items: [
        { slotKey: "arrive:0", block: "arrive", exerciseId: "breath", format: "holds", sets: 1, group: null, coreFamily: null, isNew: false, why: [] },
        { slotKey: "prep:0", block: "prep", exerciseId: "catCow", format: "flow", sets: 1, group: null, coreFamily: null, isNew: false, why: [] },
        { slotKey: "core:0", block: "core", exerciseId: "goblet", format: "superset", sets: 3, group: "A", coreFamily: "squat", isNew: false, why: ["Core lift · block 2 · week 3 of 5"] },
        { slotKey: "core:1", block: "core", exerciseId: "rowX", format: "superset", sets: 3, group: "B", coreFamily: "row", isNew: true, why: [] },
        { slotKey: "care:0", block: "care", exerciseId: "chinTuck", format: "holds", sets: 1, group: null, coreFamily: null, isNew: false, why: [] },
        { slotKey: "cooldown:0", block: "cooldown", exerciseId: "twist", format: "flow", sets: 1, group: null, coreFamily: null, isNew: false, why: [] },
      ],
      exercises: {
        breath: ex("breath", "Physiological sigh"),
        catCow: ex("catCow", "Cat-cow"),
        goblet: ex("goblet", "Goblet squat", {
          equipment: { all: ["kettlebell"], oneOf: [] },
          easier: ["boxSquat"],
          harder: ["frontRackSquat"],
          text: {
            summary: "Hold the weight at your chest and sit down between your heels.",
            setup: ["Feet a little wider than hips."],
            steps: ["Breathe in and sit.", "Stand by pushing the floor away."],
            focus: ["Knees track over toes"],
            mistakes: ["Weight pulls the shoulders forward"],
            breathing: "In on the way down",
            why: "",
            conditions: { "p-x": "Keep the knee soft at the bottom." },
          },
        }),
        rowX: ex("rowX", "Supported row", { laterality: "unilateral" }),
        chinTuck: ex("chinTuck", "Chin tucks"),
        twist: ex("twist", "Supine twist", { laterality: "unilateral" }),
        boxSquat: ex("boxSquat", "Goblet box squat"),
      },
      alternatives: {
        "core:0": [{ id: "boxSquat", name: "Goblet box squat", reasons: ["Same weight", "Hips: 5 days since trained"], steps: [], moveKey: "squat|hips", pairing: "any" }],
      },
      targets: {
        goblet: { ...target(6, 30, "up"), last: "25 lb × 8 · 25 lb × 8", lastDate: "2026-09-28" },
        rowX: target(10, 20),
      },
      newMove: "rowX",
      params: { checks: { "p-x": { pre: 1, feelingOff: false } }, overrides: {}, swaps: {} },
    },
    ...over,
  } as unknown as SessionDto;
}

function slot(over: Partial<WorkoutDto> = {}): WorkoutDto {
  return {
    id: SLOT,
    title: "Garden program · Hips & posture",
    category: "strength",
    qualitySubtype: null,
    sport: "strength",
    originalPlanDate: TODAY,
    lastVerifiedCorosDate: "",
    effectiveDate: TODAY,
    effectiveTime: "19:00",
    workoutSeconds: 1800,
    calendarSeconds: 1800,
    stageSummary: null,
    calendarSyncState: "synced",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    archived: false,
    origin: "program",
    contentState: "built",
    programId: "p1",
    ...over,
  } as WorkoutDto;
}

const PROGRAMS = {
  programs: [
    {
      id: "p1",
      kind: "adaptive",
      name: "Garden program",
      status: "active",
      config: { weeklyGoal: 4, preferredDays: [0, 2], defaultMinutes: 30, defaultLocationId: null, blockWeeks: 5, modes: ["recovery", "consistent", "build"], careProfiles: ["p-x"], placementWeeksAhead: 2 },
      block: { number: 2, week: 3, weeks: 5, core: [{ family: "squat", exerciseId: "goblet", name: "Goblet squat" }, { family: "hinge", exerciseId: "dl", name: "KB deadlift" }] },
      week: { placed: 4, done: 1, goal: 4 },
    },
  ],
  places: [],
  profiles: [],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

// The sheet writes the year only when it is not the current one ("Monday, October 5"), so the clock is pinned to TODAY's
// year (Date alone: timers stay real). Unpinned, the date assertions fail from 2027-01-01 (audit 2a-UI M9).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  // Written against the dark state: each case starts with the player off and turns it on where it says so.
  features.player = false;
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  features.player = true;
  vi.unstubAllGlobals();
});

function mount(
  first: SessionDto,
  opts: {
    afterBuild?: (body: Record<string, unknown>) => SessionDto;
    stale?: SessionDto;
    today?: string;
    w?: WorkoutDto;
    detail?: boolean;
    /** The GET answers with this status (and no session) instead. */
    getStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  let current = first;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/\?.*$/, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body });
      if (path === `/api/sessions/${SLOT}` && method === "GET") {
        return opts.getStatus ? json({ error: opts.getStatus === 404 ? "not_found" : "internal" }, opts.getStatus) : json(current);
      }
      if (path === `/api/sessions/${SLOT}/build`) {
        current = opts.afterBuild ? opts.afterBuild(body ?? {}) : { ...current, contentState: "built" };
        return json(current);
      }
      if (path === `/api/sessions/${SLOT}/start`) {
        // The day's inputs changed since the shown build: the server answers with the fresh one, once.
        if (opts.stale && (body as { buildId?: string } | null)?.buildId !== opts.stale.build?.buildId) {
          current = opts.stale;
          return json({ error: "stale", session: opts.stale }, 409);
        }
        current = { ...current, contentState: "started", locked: true };
        return json(current);
      }
      if (path === "/api/programs") return json(PROGRAMS);
      if (path === "/api/sync/notes") return json({ notes: [] });
      if (path.startsWith("/api/plan/workouts/")) return json({ ok: true, workout: opts.w ?? slot(), stages: [], match: null });
      return json({ error: "not_found" }, 404);
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sheet = opts.detail
    ? createElement(WorkoutDetail, { w: opts.w ?? slot(), today: opts.today ?? TODAY, corosWritesEnabled: false, onClose: () => undefined })
    : createElement(SessionSheet, { w: opts.w ?? slot(), today: opts.today ?? TODAY, onClose: () => undefined });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: ["/plan"] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/plan", element: sheet }),
            createElement(Route, { path: "/session/:id", element: createElement("p", null, "the player") }),
          ),
        ),
      ),
    );
  });
  return { calls };
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

const body = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a")].find((b) => {
    const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
const click = async (name: string | RegExp) => {
  const b = button(name);
  if (!b) throw new Error(`no control ${String(name)}\n${body()}`);
  await act(async () => {
    b.click();
  });
};
const builds = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/build"));

// ── The pre-check ──────────────────────────────────────────────────────────

describe("the pre-check", () => {
  it("comes first when today's reading is missing — in the profile's words — and nothing is built until it is answered", async () => {
    const { calls } = mount(session({ contentState: "outline", checks: {}, build: null, view: null }), {
      afterBuild: () => session(),
    });
    await until(() => body().includes("Knee / hip right now"), "the pre-check");
    expect(document.querySelectorAll(".check-scale button")).toHaveLength(11);
    expect(body()).toContain("Block 2 · week 3 of 5");
    expect(body()).toContain("Goblet squat · KB deadlift");
    expect(button("Move")).toBeTruthy();
    expect(button("Skip")).toBeTruthy();
    expect(builds(calls)).toHaveLength(0);
    // The number first, then Feeling off: both count — nothing is sent until Build (ruling 2a-R14; audit 2a-UI I3).
    expect((button("Build") as HTMLButtonElement).disabled).toBe(true);
    await click("3");
    expect(builds(calls)).toHaveLength(0);
    await click("Feeling off");
    expect(builds(calls)).toHaveLength(0);
    await click("Build");
    await until(() => body().includes("Goblet squat"), "the built session");
    expect(builds(calls).map((c) => c.body)).toEqual([{ checks: { "p-x": { pre: 3, feelingOff: true } } }]);
  });

  it("Feeling off alone is an answer (ruling 2a-R14)", async () => {
    const { calls } = mount(session({ contentState: "outline", checks: {}, build: null, view: null }), { afterBuild: () => session() });
    await until(() => body().includes("Knee / hip right now"), "the pre-check");
    await click("Feeling off");
    await click("Build");
    await until(() => body().includes("Goblet squat"), "the built session");
    expect(builds(calls).map((c) => c.body)).toEqual([{ checks: { "p-x": { pre: null, feelingOff: true } } }]);
  });

  it("Build waits for every profile: a number or Feeling off each (ruling 2a-R14)", async () => {
    const two = {
      profiles: [
        { profileId: "p-x", check: { label: "Knee / hip", min: 0, max: 10 }, care: "Knee care" },
        { profileId: "p-y", check: { label: "Wrist", min: 0, max: 10 }, care: null },
      ],
    };
    const { calls } = mount(session({ ...two, contentState: "outline", checks: {}, build: null, view: null }), {
      afterBuild: () => session(two),
    });
    await until(() => body().includes("Wrist right now"), "the pre-check");
    const scale = (label: string) => document.querySelector<HTMLElement>(`[role=radiogroup][aria-label="${label}"]`)!;
    await act(async () => {
      [...scale("Knee / hip").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "2")!.click();
    });
    expect((button("Build") as HTMLButtonElement).disabled).toBe(true);
    const offs = [...document.querySelectorAll<HTMLButtonElement>(".check-off")];
    await act(async () => {
      offs[1]!.click();
    });
    expect((button("Build") as HTMLButtonElement).disabled).toBe(false);
    await click("Build");
    await until(() => builds(calls).length === 1, "the build");
    expect(builds(calls)[0]!.body).toEqual({ checks: { "p-x": { pre: 2, feelingOff: false }, "p-y": { pre: null, feelingOff: true } } });
  });

  it("the reading on the when-line reopens the pre-check with that reading; Build rebuilds with the change (ruling 2a-R14)", async () => {
    const { calls } = mount(session(), {
      afterBuild: (b) => session({ checks: (b as { checks?: SessionDto["checks"] }).checks ?? session().checks }),
    });
    await until(() => body().includes("Supported row"), "the built session");
    const reading = button("Knee 1")!;
    expect(reading.getAttribute("aria-expanded")).toBe("false");
    await click("Knee 1");
    expect(button("Knee 1")!.getAttribute("aria-expanded")).toBe("true");
    expect(body()).toContain("Knee / hip right now");
    expect(body()).not.toContain("Supported row");
    expect([...document.querySelectorAll(".check-scale [aria-checked=true]")].map((b) => b.textContent)).toEqual(["1"]);
    await click("Feeling off");
    await click("Build");
    await until(() => body().includes("Supported row"), "the rebuilt session");
    expect(builds(calls).slice(1).map((c) => c.body)).toEqual([{ checks: { "p-x": { pre: 1, feelingOff: true } } }]);
    expect(body()).toContain("Knee 1 · off");
    expect(body()).not.toContain("right now");
  });

  it("the reading is plain text where nothing can be rebuilt: a started session, a day gone", async () => {
    mount(session({ contentState: "started", locked: true }), { w: slot({ contentState: "started" }) });
    await until(() => body().includes("Supported row"), "the moves");
    expect(body()).toContain("Knee 1");
    expect(button("Knee 1")).toBeUndefined();
  });

  it("answered already (the Today chip): opening builds with what the day holds, without asking", async () => {
    const { calls } = mount(session({ contentState: "outline", build: null, view: null }), { afterBuild: () => session() });
    await until(() => body().includes("Supported row"), "the built session");
    expect(body()).not.toContain("right now");
    expect(builds(calls).map((c) => c.body)).toEqual([{}]);
  });
});

// ── Built ──────────────────────────────────────────────────────────────────

describe("a built session", () => {
  it("chips, one reason line, the moves by block with format, dose, ↑ and New; the reading on the meta line", async () => {
    mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    const chips = [...document.querySelectorAll(".session-chips button")].map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    expect(chips).toEqual(["Build ▾", "Hips & posture ▾", "30 min ▾", "Home ▾"]);
    expect(body()).toContain("Knee calm (1) · 3 sessions in the last 7 days.");
    expect(body()).toContain("Monday, October 5 at 7 PM · Knee 1");
    const heads = [...document.querySelectorAll(".session-block-head")].map((h) => h.textContent?.replace(/\s+/g, " ").trim());
    expect(heads).toEqual(["Arrive", "Prep · Flow", "Core · Superset", "Knee care", "Cool-down · Flow"]);
    const rows = [...document.querySelectorAll(".session-move")].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toContain("A Goblet squat 3 × 6 @ 30 lb ↑");
    expect(rows).toContain("B Supported row New 3 × 10 @ 20 lb each side");
    expect(rows).toContain("Supine twist 45 s each side");
  });

  it("⇄ only where the slot has alternatives", async () => {
    mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    expect(button("Swap Goblet squat")).toBeTruthy();
    expect(button("Swap Supported row")).toBeUndefined();
    expect(button("How to do Supported row")).toBeTruthy();
  });

  it("the mode chip opens a short picker of the program's modes; picking one rebuilds", async () => {
    const { calls } = mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    await click("Build ▾");
    expect([...document.querySelectorAll(".choice-list button")].map((b) => b.textContent)).toEqual(["Recovery", "Consistent", "Build"]);
    await click("Recovery");
    await until(() => builds(calls).length === 2, "the rebuild");
    expect(builds(calls)[1]!.body).toEqual({ overrides: { mode: "recovery" } });
  });

  it("the theme picker offers the themes the session's mode can take; time and place rebuild too", async () => {
    const { calls } = mount(session({ view: { ...session().view!, mode: "recovery" } }));
    await until(() => body().includes("Supported row"), "the moves");
    await click("Hips & posture ▾");
    expect([...document.querySelectorAll(".choice-list button")].map((b) => b.textContent)).toEqual(["Desk unwind"]);
    await click("Desk unwind");
    await click("30 min ▾");
    await click("45 min");
    await click("Home ▾");
    await click("Gym");
    await until(() => builds(calls).length === 4, "three rebuilds");
    expect(builds(calls).slice(1).map((c) => c.body)).toEqual([
      { overrides: { theme: "deskUnwind" } },
      { overrides: { minutes: 45 } },
      { overrides: { locationId: "gym" } },
    ]);
  });

  it("⇄ lists the alternatives with their reasons; Use rebuilds with the swap; no 'Don't show again' before 2c", async () => {
    const { calls } = mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    await click("Swap Goblet squat");
    expect(body()).toContain("Goblet box squat");
    expect(body()).toContain("Same weight · Hips: 5 days since trained");
    expect(body()).not.toContain("Don't show again");
    // A full-size button, 44px tall (styles.css `.choice-move > .btn`), as on the player's ⇄ sheet (audit 2b-B I-1).
    const uses = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Use");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect([...u.classList]).toEqual(["btn"]);
    await click("Use");
    await until(() => builds(calls).length === 2, "the rebuild");
    expect(builds(calls)[1]!.body).toEqual({ swaps: { "core:0": { from: "goblet", to: "boxSquat" } } });
  });

  it("ⓘ opens the how-to: dose, why, summary, setup, steps, cues, the profile's note, easier/harder, last time — no rating controls yet", async () => {
    mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    await click("How to do Goblet squat");
    const how = document.querySelector(".howto")!.textContent!.replace(/\s+/g, " ");
    expect(how).toContain("3 × 5–8 · rest 75 s · kettlebell");
    expect(how).toContain("Core lift · block 2 · week 3 of 5");
    expect(how).toContain("Hold the weight at your chest and sit down between your heels.");
    expect(how).toContain("Feet a little wider than hips.");
    expect(how).toContain("Breathe in and sit.");
    expect(how).toContain("Knees track over toes · Weight pulls the shoulders forward · In on the way down");
    expect(how).toContain("Knee");
    expect(how).toContain("Keep the knee soft at the bottom.");
    expect(how).toContain("Easier · Goblet box squat");
    expect(how).toContain("Harder · Front rack squat");
    expect(how).toContain("Last time · Sep 28");
    expect(how).toContain("25 lb × 8 · 25 lb × 8");
    for (const word of ["👍", "👎", "Not for me", "Pin"]) expect(how).not.toContain(word);
  });
});

// ── Start, and the days around today ────────────────────────────────────────

describe("Start", () => {
  it("is hidden until the player ships", async () => {
    mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    expect(button(/^Start/)).toBeUndefined();
  });

  it("with the player: Start · 30 min locks the session and goes to the player", async () => {
    features.player = true;
    const { calls } = mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    await click("Start · 30 min");
    await until(() => body().includes("the player"), "the player route");
    const start = calls.find((c) => c.path.endsWith("/start") && c.method === "POST");
    expect(start?.body).toEqual({ buildId: session().build!.buildId });
  });

  it("with the player: Start leaves the locked build, its name and the profiles on the device for the player (2b-R1)", async () => {
    features.player = true;
    vi.stubGlobal("indexedDB", new IDBFactory());
    mount(session());
    await until(() => body().includes("Supported row"), "the moves");
    await click("Start · 30 min");
    await until(() => body().includes("the player"), "the player route");
    const db = await offlineDb();
    const stored = await loadBuild(db, SLOT);
    expect(stored?.build.buildId).toBe(session().build!.buildId);
    expect(await loadExtras(db, SLOT)).toMatchObject({ title: "Garden program", profiles: session().profiles });
  });

  it("with the player: a stale build is replaced by the fresh one, and Start names it", async () => {
    features.player = true;
    const first = session();
    const fresh: SessionDto = {
      ...first,
      build: { ...first.build!, buildId: "b-fresh", version: first.build!.version + 1 },
      view: { ...first.view!, minutes: 25 },
    };
    const { calls } = mount(first, { stale: fresh });
    await until(() => body().includes("Supported row"), "the moves");
    await click("Start · 30 min");
    await until(() => !!button("Start · 25 min"), "the fresh build's Start");
    expect(body()).not.toContain("the player");
    await click("Start · 25 min");
    await until(() => body().includes("the player"), "the player route");
    expect(calls.filter((c) => c.path.endsWith("/start")).map((c) => c.body)).toEqual([
      { buildId: first.build!.buildId },
      { buildId: "b-fresh" },
    ]);
  });
});

describe("a day ahead, a day gone, a started session", () => {
  it("a day ahead: no pre-check, a preview build, no Start even with the player", async () => {
    features.player = true;
    const tomorrow = "2026-10-06";
    const { calls } = mount(session({ date: tomorrow, contentState: "outline", checks: {}, build: null, view: null }), {
      w: slot({ effectiveDate: tomorrow, contentState: "outline" }),
      afterBuild: () => session({ date: tomorrow, contentState: "outline", checks: {} }),
    });
    await until(() => body().includes("Supported row"), "the preview");
    expect(body()).not.toContain("right now");
    expect(builds(calls).map((c) => c.body)).toEqual([{}]);
    expect(button(/^Start/)).toBeUndefined();
  });

  it("a day gone: Move to today, and nothing is built", async () => {
    const { calls } = mount(session({ date: "2026-10-03", contentState: "outline", checks: {}, build: null, view: null }), {
      w: slot({ effectiveDate: "2026-10-03", contentState: "outline" }),
    });
    await until(() => !!button("Move to today"), "the move offer");
    // A static line, never a spinner for a build that will never start (audit 2a-UI I2, M11b).
    await until(() => !document.querySelector("[role=status]"), "the session loaded");
    expect(document.querySelector(".spinner")).toBeNull();
    expect(body()).toContain("Nothing was built for this day");
    expect(builds(calls)).toHaveLength(0);
    await click("Move to today");
    await until(() => calls.some((c) => c.path.endsWith("/move")), "the move");
    expect(calls.find((c) => c.path.endsWith("/move"))!.body).toEqual({ toDate: TODAY, toTime: "19:00" });
  });

  it("a day gone that was built on its day: that build, read-only, with Move to today", async () => {
    const gone = "2026-10-03";
    const { calls } = mount(session({ date: gone, build: { ...session().build!, date: gone } }), { w: slot({ effectiveDate: gone }) });
    await until(() => body().includes("Supported row"), "the day's build");
    expect(document.querySelectorAll(".session-chips button")).toHaveLength(0);
    expect(button("Swap Goblet squat")).toBeUndefined();
    expect(button("Move to today")).toBeTruthy();
    expect(builds(calls)).toHaveLength(0);
  });

  it("started: read-only — no swaps, no pickers, nothing built; Continue only with the player", async () => {
    const started = session({ contentState: "started", locked: true });
    const { calls } = mount(started, { w: slot({ contentState: "started" }) });
    await until(() => body().includes("Supported row"), "the moves");
    expect(button("Swap Goblet squat")).toBeUndefined();
    expect(document.querySelectorAll(".session-chips button")).toHaveLength(0);
    expect(builds(calls)).toHaveLength(0);
    expect(button("Continue")).toBeUndefined();
    expect(button("How to do Goblet squat")).toBeTruthy();
  });
});

describe("pins from the 2a UI re-review (U3, U5, U7, U8)", () => {
  it("U3: a started session's when-line shows the reading it was built with, not a later one", async () => {
    const started = session({
      contentState: "started",
      locked: true,
      checks: { "p-x": { pre: 5, feelingOff: true } },
      build: { ...session().build!, params: { ...session().build!.params, checks: { "p-x": { pre: 1, feelingOff: false } } } },
    });
    mount(started, { w: slot({ contentState: "started" }) });
    await until(() => body().includes("Supported row"), "the moves");
    expect(body()).toContain("Knee 1");
    expect(body()).not.toContain("Knee 5");
  });

  it("U5: a build that adopts the stored one (same build, the row now built) refreshes Today and Plan", async () => {
    const { calls } = mount(session({ contentState: "outline" }), { afterBuild: () => session({ contentState: "built" }) });
    await until(() => builds(calls).length === 1, "the build");
    await until(() => calls.filter((c) => c.path === "/api/programs").length === 2, "the program card refetched");
  });

  it("U5: a build that changes nothing refreshes nothing", async () => {
    const { calls } = mount(session(), { afterBuild: () => session() });
    await until(() => builds(calls).length === 1, "the build");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls.filter((c) => c.path === "/api/programs")).toHaveLength(1);
  });

  it("U7: after Build, focus stays in the sheet — on the reading", async () => {
    const { calls } = mount(session({ checks: {}, contentState: "outline", build: null, view: null }), { afterBuild: () => session() });
    await until(() => body().includes("right now"), "the pre-check");
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".check-scale [role=radio]")!.click();
    });
    await click("Build");
    await until(() => builds(calls).length === 1 && body().includes("Supported row"), "the build");
    await until(() => document.activeElement?.classList.contains("session-reading") === true, "focus on the reading");
  });

  it("U8 (S3): a skipped session's reading is plain text — nothing there can be rebuilt", async () => {
    mount(session(), { w: slot({ completionState: "skipped" }) });
    await until(() => body().includes("Supported row"), "the moves");
    expect(body()).toContain("Knee 1");
    expect(button("Knee 1")).toBeUndefined();
  });

  it("U8 (S8b): reopening the pre-check from the reading fills in Feeling off as it stands", async () => {
    mount(session({ checks: { "p-x": { pre: 1, feelingOff: true } } }));
    await until(() => body().includes("Supported row"), "the moves");
    await click("Knee 1 · off");
    expect(button("Feeling off")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("U8 (S15): Un-skip refreshes Today and Plan", async () => {
    const { calls } = mount(session({ contentState: "outline", checks: {}, build: null, view: null }), {
      w: slot({ contentState: "outline", completionState: "skipped" }),
    });
    await until(() => body().includes("Skipped"), "the skipped session");
    const before = calls.filter((c) => c.path === "/api/programs").length;
    await click("Un-skip");
    await until(() => calls.filter((c) => c.path === "/api/programs").length > before, "the program card refetched");
  });
});

describe("a skipped session (ruling 2a-R15)", () => {
  it("shows Skipped and Un-skip: no pre-check, nothing built on open, no Skip or Move", async () => {
    const { calls } = mount(session({ contentState: "outline", checks: {}, build: null, view: null }), {
      w: slot({ contentState: "outline", completionState: "skipped" }),
    });
    await until(() => body().includes("Skipped"), "the skipped session");
    expect(button("Un-skip")).toBeTruthy();
    expect(body()).not.toContain("right now");
    expect(document.querySelector(".spinner")).toBeNull();
    expect(button("Skip")).toBeUndefined();
    expect(button("Move")).toBeUndefined();
    expect(builds(calls)).toHaveLength(0);
    await click("Un-skip");
    await until(() => calls.some((c) => c.path.endsWith("/unskip")), "the un-skip");
    expect(calls.find((c) => c.path.endsWith("/unskip"))).toMatchObject({ method: "POST", path: `/api/plan/workouts/${SLOT}/unskip` });
    expect(builds(calls)).toHaveLength(0);
  });

  it("built before it was skipped: the build is shown read-only, never rebuilt", async () => {
    features.player = true;
    const { calls } = mount(session(), { w: slot({ completionState: "skipped" }) });
    await until(() => body().includes("Supported row"), "the moves");
    expect(document.querySelectorAll(".session-chips button")).toHaveLength(0);
    expect(button("Swap Goblet squat")).toBeUndefined();
    expect(button(/^Start/)).toBeUndefined();
    expect(button("Un-skip")).toBeTruthy();
    expect(builds(calls)).toHaveLength(0);
  });
});

describe("the sheet's edges (audit 2a-UI M6, M7)", () => {
  it("no pinned foot when there is nothing to do: while loading, and on a started session without the player", async () => {
    mount(session({ contentState: "started", locked: true }), { w: slot({ contentState: "started" }) });
    expect(body()).toContain("Loading the session");
    expect(document.querySelector(".sheet-foot")).toBeNull();
    await until(() => body().includes("Supported row"), "the moves");
    expect(document.querySelector(".sheet-foot")).toBeNull();
  });

  it("a session gone from the plan (404) says so; any other failure says it couldn't load", async () => {
    mount(session(), { getStatus: 404 });
    await until(() => !body().includes("Loading the session"), "the answer");
    expect(body()).toContain("This session is no longer in the plan");
    act(() => root?.unmount());
    host?.remove();
    mount(session(), { getStatus: 500 });
    await until(() => !body().includes("Loading the session"), "the answer");
    expect(body()).not.toContain("no longer in the plan");
    expect(body()).toContain("Couldn't load this session");
  });
});

describe("WorkoutDetail branches on origin", () => {
  it("a program slot opens the session sheet, titled by its program", async () => {
    const { calls } = mount(session(), { detail: true });
    await until(() => body().includes("Supported row"), "the session sheet");
    expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("Garden program");
    expect(calls.some((c) => c.path === `/api/sessions/${SLOT}`)).toBe(true);
    expect(calls.some((c) => c.path === `/api/plan/workouts/${SLOT}`)).toBe(false);
  });

  it("a run keeps the workout sheet", async () => {
    const run = slot({ id: "run-1", title: "Threshold 5x5", category: "quality", sport: "run", origin: null, contentState: null, programId: null });
    const { calls } = mount(session(), { detail: true, w: run });
    await until(() => body().includes("Threshold 5x5"), "the workout sheet");
    expect(calls.some((c) => c.path.startsWith("/api/sessions/"))).toBe(false);
  });
});
