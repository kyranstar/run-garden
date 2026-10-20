// @vitest-environment jsdom
/**
 * A TRAINING LINE'S SHEET (training lines §3.3, 2026-10-20): the line's phases in order — ended ones collapsed, the
 * current one open with its detail, later ones a heading and dates; Rename on each phase's heading; Change race on the
 * last phase; Extend and Wind down written for the line's end ("Extend my running plan by two weeks"); Retire become
 * "Stop this plan", which retires the current phase and every later one — never one that has ended — after one confirm
 * that counts the sessions leaving the calendar. A one-phase line keeps the per-plan sheet, Retire become Stop; an
 * ended line is read-only. An old `?plan=<coach block id>` link opens the block's line, scrolled to that phase.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CoachPlanDto, type PlanDetailResponse, type TrainingLineDto } from "@rg/api-client";
import { CoachOpenContext } from "../src/screens/studio/coach-ask.js";
import { LineSheet, linePhaseState, stopCount, stopLine } from "../src/screens/plan-sheet.js";
import { PlanScreen } from "../src/screens/plan.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Phase = TrainingLineDto["phases"][number];
const phase = (id: string, name: string, startDate: string, endDate: string, over: Partial<Phase> = {}): Phase => ({
  id,
  discipline: "run",
  status: "active",
  name,
  startDate,
  endDate,
  planRaceDate: null,
  futureSessions: 0,
  ...over,
});
const mkLine = (phases: Phase[], over: Partial<TrainingLineDto> = {}): TrainingLineDto => ({
  key: `${phases[0]!.discipline}:${phases[0]!.id}`,
  discipline: phases[0]!.discipline,
  name: "Running",
  phases,
  currentPhaseId: phases[0]!.id,
  startDate: phases[0]!.startDate,
  endDate: phases[phases.length - 1]!.endDate,
  goalRaceDate: null,
  ended: false,
  ...over,
});
const asPlan = (p: Phase): CoachPlanDto => ({
  id: p.id,
  discipline: p.discipline,
  name: p.name,
  status: p.status,
  startDate: p.startDate,
  endDate: p.endDate,
  raceDate: p.planRaceDate ?? null,
  planRaceDate: p.planRaceDate ?? null,
  source: "coach",
  kind: "block",
});

/** Three blocks in a row: the bridge has ended (a session moved past its end still counts in it, so a Stop that touched
 * it would say 19, not 14), the base block is today's, the race build is ahead. */
const bridge = phase("r1", "Bridge block", "2026-09-28", "2026-10-11", { status: "completed", futureSessions: 5 });
const base = phase("r2", "Base block", "2026-10-12", "2026-11-08", { futureSessions: 9 });
const build = phase("r3", "Race build", "2026-11-09", "2026-12-06", { planRaceDate: "2026-12-06", futureSessions: 5 });
const running = mkLine([bridge, base, build], { currentPhaseId: "r2", goalRaceDate: "2026-12-06" });

const detailOf = (p: Phase, over: Partial<PlanDetailResponse> = {}): PlanDetailResponse => ({
  plan: asPlan(p),
  weeks: [{ weekStart: p.startDate, index: 1, state: "firm", volumeTarget: null, keySessions: [], summary: `${p.name} week one`, done: false, current: true }],
  progressions: [],
  sessions: { planned: 12, done: 4 },
  adherencePct: 80,
  ...over,
});

function mountSheet(
  line: TrainingLineDto,
  opts: {
    today?: string;
    focusPhaseId?: string | null;
    details?: Record<string, PlanDetailResponse>;
    onRename?: (id: string, name: string) => void;
    open?: (args?: { request?: string }) => void;
  } = {},
): { qc: QueryClient; rerender: (lines: TrainingLineDto[]) => void } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const p of line.phases) qc.setQueryData(["plan-detail", p.id], opts.details?.[p.id] ?? detailOf(p));
  // Nothing else is asked of the server here; an unexpected read is a 404, never a hang.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = (lines: TrainingLineDto[]) =>
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        CoachOpenContext.Provider,
        { value: { open: opts.open ?? (() => undefined) } },
        createElement(
          MemoryRouter,
          null,
          createElement(LineSheet, {
            lineKey: line.key,
            lines,
            plans: line.phases.map(asPlan),
            today: opts.today ?? TODAY,
            focusPhaseId: opts.focusPhaseId ?? null,
            onClose: () => undefined,
            onRename: opts.onRename ?? (() => undefined),
          }),
        ),
      ),
    );
  act(() => root!.render(tree([line])));
  return { qc, rerender: (lines) => act(() => root!.render(tree(lines))) };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")];
const findButton = (name: string, within: ParentNode = document) => buttons(within).find((b) => text(b) === name);
const button = (name: string, within: ParentNode = document): HTMLButtonElement => {
  const b = findButton(name, within);
  if (!b) throw new Error(`no button "${name}" in: ${text(within as Element)}`);
  return b;
};
const phaseEl = (id: string): HTMLElement => {
  const el = document.getElementById(`line-phase-${id}`);
  if (!el) throw new Error(`no phase ${id}`);
  return el;
};
/** The phase's heading, when it is a disclosure (an ended phase's): the button inside its `<h3>`. */
const toggle = (id: string) => phaseEl(id).querySelector<HTMLButtonElement>("h3 button[aria-expanded]");
const dialog = (name: string) =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) => text(d.querySelector("h2")) === name) ?? null;
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => void (await Promise.resolve()));
};
/** Types into a field the way a person does (React reads the native setter's value). */
function type(field: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ── The pure parts ─────────────────────────────────────────────────────────

describe("stopCount and stopLine", () => {
  it("count the current phase and every later one: never an ended phase", () => {
    expect(stopCount(running, TODAY)).toBe(14);
  });

  it("stopLine retires the current phase, then each later one, in order, and says which", async () => {
    const asked: string[] = [];
    const out = await stopLine(running, TODAY, async (id) => {
      asked.push(id);
      return { ok: true };
    });
    expect(asked).toEqual(["r2", "r3"]);
    expect(out).toEqual({ stopped: ["r2", "r3"] });
  });

  it("a later phase that has already ended (it overlapped the current one) is never retired or counted", () => {
    const long = phase("o1", "Long block", "2026-10-01", "2026-11-30", { futureSessions: 7 });
    const deload = phase("o2", "Deload", "2026-10-05", "2026-10-10", { futureSessions: 2 });
    const line = mkLine([long, deload], { currentPhaseId: "o1" });
    expect(stopCount(line, TODAY)).toBe(7);
    const asked: string[] = [];
    return stopLine(line, TODAY, async (id) => {
      asked.push(id);
      return { ok: true };
    }).then((out) => {
      expect(asked).toEqual(["o1"]);
      expect(out.stopped).toEqual(["o1"]);
    });
  });

  it("a line not yet started stops every phase; an ended line stops none", async () => {
    const ahead = mkLine([phase("a1", "First", "2026-11-02", "2026-11-29", { futureSessions: 8 }), phase("a2", "Second", "2026-11-30", "2026-12-27", { futureSessions: 6 })]);
    expect(stopCount(ahead, TODAY)).toBe(14);
    const asked: string[] = [];
    await stopLine(ahead, TODAY, async (id) => (asked.push(id), { ok: true }));
    expect(asked).toEqual(["a1", "a2"]);

    const over = mkLine([phase("e1", "Old", "2026-08-03", "2026-08-30", { futureSessions: 1 }), phase("e2", "Older", "2026-08-31", "2026-09-27", { futureSessions: 1 })], {
      currentPhaseId: "e2",
      ended: true,
    });
    expect(stopCount(over, TODAY)).toBe(0);
    const none: string[] = [];
    expect(await stopLine(over, TODAY, async (id) => (none.push(id), { ok: true }))).toEqual({ stopped: [] });
    expect(none).toEqual([]);
  });

  it("only the current phase and those after it: an earlier phase still running beside it (they overlap) is left", async () => {
    // The spec's rule as written (§3.3, §7: "retires only the current and later phases"); `linesOf` makes the
    // later-starting of two phases covering today the current one.
    const long = phase("v1", "Long block", "2026-10-01", "2026-11-30", { futureSessions: 7 });
    const sharpen = phase("v2", "Sharpening", "2026-10-15", "2026-11-15", { futureSessions: 3 });
    const line = mkLine([long, sharpen], { currentPhaseId: "v2" });
    expect(stopCount(line, TODAY)).toBe(3);
    const asked: string[] = [];
    await stopLine(line, TODAY, async (id) => (asked.push(id), { ok: true }));
    expect(asked).toEqual(["v2"]);
  });

  it("a line naming no phase of its own as current stops every phase that has not ended — never only its last", async () => {
    const odd = { ...running, currentPhaseId: "gone" };
    expect(stopCount(odd, TODAY)).toBe(14);
    const asked: string[] = [];
    await stopLine(odd, TODAY, async (id) => (asked.push(id), { ok: true }));
    expect(asked).toEqual(["r2", "r3"]);
  });

  it("a retire that fails stops the walk there: nothing after it is asked, and stopLine fails", async () => {
    const asked: string[] = [];
    await expect(
      stopLine(running, TODAY, async (id) => {
        asked.push(id);
        throw new Error("offline");
      }),
    ).rejects.toThrow();
    expect(asked).toEqual(["r2"]);

    const refused: string[] = [];
    await expect(stopLine(running, TODAY, async (id) => (refused.push(id), { ok: false }))).rejects.toThrow();
    expect(refused).toEqual(["r2"]);
  });
});

describe("linePhaseState", () => {
  it("ended, current, later — and every phase of an ended line has ended, its last one too", () => {
    expect(running.phases.map((p) => linePhaseState(running, p, TODAY))).toEqual(["ended", "current", "later"]);
    const over = mkLine([phase("e1", "Old", "2026-08-03", "2026-08-30"), phase("e2", "Older", "2026-08-31", "2026-09-27")], { currentPhaseId: "e2", ended: true });
    expect(over.phases.map((p) => linePhaseState(over, p, TODAY))).toEqual(["ended", "ended"]);
    // On its last day a phase is still today's.
    expect(linePhaseState(running, base, "2026-11-08")).toBe("current");
    expect(linePhaseState(running, base, "2026-11-09")).toBe("ended");
  });
});

// ── The sheet ──────────────────────────────────────────────────────────────

describe("a line's sheet lists its phases", () => {
  it("in order: the ended one collapsed, the current one open with its detail, the later one a heading and dates", () => {
    mountSheet(running);
    expect(text(dialog("Running")?.querySelector("h2"))).toBe("Running");
    const phases = [...document.querySelectorAll(".line-phase")].map((el) => el.id);
    expect(phases).toEqual(["line-phase-r1", "line-phase-r2", "line-phase-r3"]);
    // Ended: its heading is a disclosure, closed, and none of its detail is drawn.
    expect(text(phaseEl("r1"))).toContain("Bridge block");
    expect(text(phaseEl("r1"))).toContain("Sep 28 → Oct 11");
    expect(toggle("r1")?.getAttribute("aria-expanded")).toBe("false");
    expect(text(phaseEl("r1"))).not.toContain("sessions done");
    // Current: open, with its weeks and its numbers, as the per-plan sheet draws them.
    expect(text(phaseEl("r2"))).toContain("Base block");
    expect(text(phaseEl("r2"))).toContain("4 of 12 sessions done · adherence 80%");
    expect(text(phaseEl("r2"))).toContain("Base block week one");
    expect(phaseEl("r2").classList.contains("is-current")).toBe(true);
    // Later: a heading and its dates, nothing more.
    expect(text(phaseEl("r3"))).toContain("Race build");
    expect(text(phaseEl("r3"))).toContain("Nov 9 → Dec 6");
    expect(text(phaseEl("r3"))).not.toContain("sessions done");
    expect(toggle("r3")).toBeNull();
  });

  it("an ended phase opens to its own detail", () => {
    mountSheet(running, { details: { r1: detailOf(bridge, { sessions: { planned: 10, done: 9 }, adherencePct: 91 }) } });
    act(() => toggle("r1")!.click());
    expect(toggle("r1")?.getAttribute("aria-expanded")).toBe("true");
    expect(text(phaseEl("r1"))).toContain("9 of 10 sessions done · adherence 91%");
  });

  it("Rename sits on each phase's heading and renames that phase", () => {
    const onRename = vi.fn();
    mountSheet(running, { onRename });
    for (const id of ["r1", "r2", "r3"]) expect(findButton("Rename", phaseEl(id)), id).toBeDefined();
    act(() => button("Rename", phaseEl("r3")).click());
    const field = phaseEl("r3").querySelector<HTMLInputElement>("input");
    expect(field?.value).toBe("Race build");
    type(field!, "Taper to the half");
    act(() => button("Save", phaseEl("r3")).click());
    expect(onRename).toHaveBeenCalledWith("r3", "Taper to the half");
    expect(phaseEl("r3").querySelector("input")).toBeNull();
  });

  it("Change race acts on the last phase, and the race is said once", async () => {
    const asked = vi.spyOn(api, "coachPlanRace").mockResolvedValue({ ok: true, raceDate: "2026-12-13", demoted: 0 });
    mountSheet(running);
    expect(text(document.body).match(/Race · /g)?.length).toBe(1);
    expect(text(document.body)).toContain("Race · Sun 6 Dec");
    act(() => button("Change").click());
    const field = document.querySelector<HTMLInputElement>('input[type="date"][aria-label="Race day"]')!;
    expect(field.min).toBe("2026-11-09");
    type(field, "2026-12-13");
    await act(async () => button("Save").click());
    expect(asked.mock.calls).toEqual([["r3", "2026-12-13"]]);
  });

  it("Extend and Wind down write the line's end in the box", () => {
    const open = vi.fn();
    mountSheet(running, { open });
    act(() => button("Extend").click());
    act(() => button("Wind down").click());
    expect(open.mock.calls).toEqual([[{ request: "Extend my running plan by two weeks" }], [{ request: "Wind down my running plan" }]]);
  });
});

describe("Stop this plan", () => {
  it("its confirm counts the sessions leaving the calendar; confirming retires the current and later phases only", async () => {
    const retire = vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    mountSheet(running);
    expect(findButton("Retire…")).toBeUndefined();
    act(() => button("Stop this plan…").click());
    const confirm = dialog("Stop this plan?");
    expect(confirm).not.toBeNull();
    expect(text(confirm)).toContain("14 sessions leave your calendar.");
    await act(async () => button("Stop the plan", confirm!).click());
    await flush();
    expect(retire.mock.calls).toEqual([["r2"], ["r3"]]);
    expect(dialog("Stop this plan?")).toBeNull();
  });

  it("the focus goes to the result line, not to the page, without a scroll", async () => {
    vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    mountSheet(running);
    act(() => button("Stop this plan…").click());
    await act(async () => button("Stop the plan", dialog("Stop this plan?")!).click());
    await flush();
    const said = document.querySelector<HTMLElement>(".line-stopped");
    expect(said).not.toBeNull();
    expect(text(said)).toBe("Stopped. 14 sessions left your calendar.");
    expect(said!.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(said);
    expect(focus.mock.contexts.includes(said!)).toBe(true);
    expect(focus.mock.calls[focus.mock.contexts.lastIndexOf(said!)]).toEqual([{ preventScroll: true }]);
    // Stopped, it is read-only: nothing more to stop, extend or rename.
    for (const gone of ["Stop this plan…", "Extend", "Wind down", "Rename"]) expect(findButton(gone), gone).toBeUndefined();
  });

  it("a second retire that fails: the first stays retired, the sheet says so, and a second tap retires only what is left", async () => {
    const retire = vi
      .spyOn(api, "coachPlanRetire")
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true });
    mountSheet(running);
    act(() => button("Stop this plan…").click());
    await act(async () => button("Stop the plan", dialog("Stop this plan?")!).click());
    await flush();
    expect(retire.mock.calls).toEqual([["r2"], ["r3"]]);
    const confirm = dialog("Stop this plan?");
    expect(confirm).not.toBeNull();
    expect(text(confirm!.querySelector('[role="alert"]'))).toBe("That didn't go through — try again.");
    expect(button("Stop the plan", confirm!).disabled).toBe(false);
    await act(async () => button("Stop the plan", confirm!).click());
    await flush();
    expect(retire.mock.calls).toEqual([["r2"], ["r3"], ["r3"]]);
    expect(dialog("Stop this plan?")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".line-stopped"));
  });

  it("the plan's reads are asked again once it stops", async () => {
    vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    const { qc } = mountSheet(running);
    const reread = vi.spyOn(qc, "invalidateQueries");
    act(() => button("Stop this plan…").click());
    await act(async () => button("Stop the plan", dialog("Stop this plan?")!).click());
    await flush();
    const keys = reread.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const key of [["coach-plans"], ["plan-detail"], ["plan"], ["plan-week"], ["coach-state"]]) expect(keys, JSON.stringify(key)).toContain(JSON.stringify(key));
  });

  it("the sheet stays, saying so, when the stopped line leaves the plans read", async () => {
    vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    const sheet = mountSheet(running);
    act(() => button("Stop this plan…").click());
    await act(async () => button("Stop the plan", dialog("Stop this plan?")!).click());
    await flush();
    // The page draws the sheet again from a read that no longer has the line.
    sheet.rerender([]);
    expect(text(document.querySelector(".line-stopped"))).toBe("Stopped. 14 sessions left your calendar.");
    expect(dialog("Running")).not.toBeNull();
  });
});

describe("an ended line, opened from Past plans", () => {
  const old1 = phase("e1", "Spring base", "2026-03-02", "2026-03-29", { status: "completed" });
  const old2 = phase("e2", "Spring race build", "2026-03-30", "2026-04-26", { status: "completed", planRaceDate: "2026-04-26" });
  const over = mkLine([old1, old2], { currentPhaseId: "e2", ended: true });

  it("is read-only: no Extend, Wind down, Stop, Change race or Rename", () => {
    mountSheet(over);
    expect(text(document.body)).toContain("Race · Sun 26 Apr");
    for (const gone of ["Extend", "Wind down", "Stop this plan…", "Change", "Rename", "Retire…"]) expect(findButton(gone), gone).toBeUndefined();
  });

  it("each phase's adherence is its own, from its own detail", () => {
    mountSheet(over, {
      details: {
        e1: detailOf(old1, { sessions: { planned: 12, done: 11 }, adherencePct: 92 }),
        e2: detailOf(old2, { sessions: { planned: 10, done: 7 }, adherencePct: 70 }),
      },
    });
    expect(toggle("e1")?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle("e2")?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle("e1")!.click());
    act(() => toggle("e2")!.click());
    expect(text(phaseEl("e1"))).toContain("11 of 12 sessions done · adherence 92%");
    expect(text(phaseEl("e2"))).toContain("7 of 10 sessions done · adherence 70%");
  });
});

describe("a one-phase line", () => {
  const only = phase("s1", "Autumn 10K", "2026-10-05", "2026-11-01", { planRaceDate: "2026-10-31", futureSessions: 6 });
  const solo = mkLine([only], { goalRaceDate: "2026-10-31" });

  it("is the per-plan sheet, with Stop this plan in place of Retire", async () => {
    const retire = vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    mountSheet(solo);
    expect(dialog("Autumn 10K")).not.toBeNull();
    expect(document.querySelector(".line-phase")).toBeNull();
    expect(text(document.body)).toContain("4 of 12 sessions done · adherence 80%");
    for (const kept of ["Extend", "Wind down", "Rename", "Change"]) expect(findButton(kept), kept).toBeDefined();
    expect(findButton("Retire…")).toBeUndefined();
    act(() => button("Stop this plan…").click());
    expect(text(dialog("Stop this plan?"))).toContain("6 sessions leave your calendar.");
    await act(async () => button("Stop the plan", dialog("Stop this plan?")!).click());
    await flush();
    expect(retire.mock.calls).toEqual([["s1"]]);
    expect(document.activeElement).toBe(document.querySelector(".line-stopped"));
    expect(text(document.querySelector(".line-stopped"))).toBe("Stopped. 6 sessions left your calendar.");
    // Stopped, it is read-only.
    for (const gone of ["Stop this plan…", "Extend", "Wind down", "Rename", "Change"]) expect(findButton(gone), gone).toBeUndefined();
  });

  it("one session says so in the singular", () => {
    mountSheet(mkLine([{ ...only, futureSessions: 1 }]));
    act(() => button("Stop this plan…").click());
    expect(text(dialog("Stop this plan?"))).toContain("1 session leaves your calendar.");
  });

  it("ended, it is read-only", () => {
    mountSheet(mkLine([{ ...only, status: "completed" }], { ended: true }), { today: "2026-11-20" });
    expect(dialog("Autumn 10K")).not.toBeNull();
    for (const gone of ["Extend", "Wind down", "Stop this plan…", "Change", "Rename", "Retire…"]) expect(findButton(gone), gone).toBeUndefined();
  });
});

// ── The page's links ───────────────────────────────────────────────────────

describe("the Plan routes a line's sheet", () => {
  const WEEK = {
    weekStart: "2026-10-19",
    days: ["19", "20", "21", "22", "23", "24", "25"].map((d) => ({ date: `2026-10-${d}`, workouts: [] })),
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
  const studio: CoachPlanDto = { id: "sp1", discipline: "lift", name: "Studio strength", status: "active", startDate: "2026-10-05", endDate: "2026-12-27", raceDate: null, source: "studio" };

  const scrollWas = Element.prototype.scrollIntoView;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  });
  afterEach(() => {
    vi.useRealTimers();
    Element.prototype.scrollIntoView = scrollWas;
  });

  let search = "";
  function Where() {
    search = useLocation().search;
    return null;
  }

  function mountPlan(entry: string) {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace(/\?.*$/, "");
        if (path === "/api/plan/week") return json(WEEK);
        if (path === "/api/plan/workouts") return json({ today: TODAY, workouts: [], plan: null });
        if (path === "/api/coach/plans") return json({ plans: [...running.phases.map(asPlan), studio], lines: [running] });
        if (path === "/api/programs") return json({ programs: [], places: [], profiles: [] });
        if (path === "/api/coach/state") return json({ messages: [], pendingProposals: [], settledProposals: [], openQuestion: null, memoryCount: 0, lastCoachAt: null, wakeAdvised: false });
        if (path === "/api/plan/race") return json({ race: null });
        if (path === "/api/settings") return json({ prefs: { units: "km", timezone: "America/Los_Angeles" } });
        const detail = /^\/api\/coach\/plans\/([^/]+)\/detail$/.exec(path);
        if (detail) {
          const p = running.phases.find((x) => x.id === decodeURIComponent(detail[1]!));
          return p ? json(detailOf(p)) : json({ plan: studio, weeks: [], progressions: [], sessions: { planned: 8, done: 2 }, adherencePct: null });
        }
        return json({ error: "not_found" }, 404);
      }),
    );
    const seen = vi.fn();
    Element.prototype.scrollIntoView = function (this: Element) {
      seen(this);
    } as Element["scrollIntoView"];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const page: ReactElement = createElement("div", null, createElement(PlanScreen), createElement(Where));
    act(() =>
      root!.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(MemoryRouter, { initialEntries: [entry] }, page),
        ),
      ),
    );
    return { seen };
  }
  const settle = async (n = 30) => {
    for (let i = 0; i < n; i += 1) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
  };

  it("an old ?plan=<coach block> link opens that block's line, scrolled to that phase", async () => {
    const { seen } = mountPlan("/plan?plan=r3");
    await settle();
    expect(dialog("Running")).not.toBeNull();
    expect(document.querySelectorAll(".line-phase")).toHaveLength(3);
    expect(seen.mock.calls.some(([el]) => el === phaseEl("r3"))).toBe(true);
    // The address now names the line, so the sheet outlives a Stop that takes its block away.
    expect(new URLSearchParams(search).get("line")).toBe("run:r1");
    expect(new URLSearchParams(search).get("plan")).toBeNull();
  });

  it("an old link to an ended phase opens it", async () => {
    mountPlan("/plan?plan=r1");
    await settle();
    expect(toggle("r1")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a Studio plan's ?plan= link opens the sheet it always did", async () => {
    mountPlan("/plan?plan=sp1");
    await settle();
    expect(dialog("Studio strength")).not.toBeNull();
    expect(document.querySelector(".line-phase")).toBeNull();
    expect(findButton("Retire…")).toBeDefined();
  });

  it("a line's row in Your plans opens the line's sheet", async () => {
    mountPlan("/plan");
    await settle();
    const row = [...document.querySelectorAll<HTMLButtonElement>(".your-plans .plan-row")].find((b) => text(b.querySelector(".plan-row-name")) === "Running")!;
    act(() => row.click());
    await settle(5);
    expect(dialog("Running")).not.toBeNull();
    expect(new URLSearchParams(search).get("line")).toBe("run:r1");
  });
});
