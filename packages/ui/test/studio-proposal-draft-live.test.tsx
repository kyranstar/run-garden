// @vitest-environment jsdom
/**
 * Stage 3 Task 8 — Edit before approve, live (spec §8): the builder opens a coach's draft at
 * `/studio/build/proposal/:id/:opId`, loaded from the server; saving it there — Schedule for a new workout, on the
 * coach's day unless the athlete picks another, or Save changes for a revision — approves THAT op with the edited
 * document through the coach's approve, and the builder is on the workout it became. A refusal says why in place. No
 * Start now on a draft: starting would make a workout the proposal never approved. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignDraftResponse, DocWorkoutDto } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { suggestedItem } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { editDraftHref, sourceKey, sourceOfPath } from "../src/screens/studio/build-model.js";
import { useEditBeforeApprove } from "../src/screens/studio/use-build-flows.js";
import { DEVICE_PREFS, placesDto, primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_GEAR = ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"];
const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;
/** Tuesday, two days on. */
const TUESDAY = addDays(TODAY, 2);

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** The coach's document: one lift in its main part. */
const coachDoc = (title: string): WorkoutDoc => ({
  version: 1,
  title,
  intent: { summary: "Open the hips, then load them.", goals: [], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [suggestedItem(rec("gobletSquat"), "main")] }],
  source: { kind: "coach", ref: "run:main-1" },
});

function draftOf(over: Partial<DesignDraftResponse> = {}): DesignDraftResponse {
  return {
    proposalId: "dp-1",
    opId: "run-a",
    status: "pending",
    doc: coachDoc("Coach's hips"),
    derived: { estimatedMinutes: 20, discipline: "strength", category: "strength", mode: "consistent", watchStepCount: 4 },
    rev: null,
    target: { kind: "new", date: TUESDAY, time: "17:30" },
    date: TUESDAY,
    time: "17:30",
    outcome: null,
    ...over,
  };
}

const workout = (id: string, date: string, time: string, title: string): DocWorkoutDto => ({
  id, date, time, title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: "outline",
  completionState: "scheduled", docRev: 1, minutes: 20,
});

interface Call {
  method: string;
  path: string;
  body: any;
}

/** The server: the draft (null: gone), and the approve's answers in turn (an error, or the workout it made). */
function serve(s: {
  draft: DesignDraftResponse | null;
  /** The approve's answers in turn: an error, the op decided elsewhere meanwhile, or the workout it made. */
  approve?: Array<{ error: string; status: number } | { settled: "applied" | "declined" } | DocWorkoutDto>;
}): Call[] {
  const calls: Call[] = [];
  let approved = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      // Any op of the proposal: the same draft, under that op's id.
      const draftOp = /^\/api\/coach\/proposals\/dp-1\/ops\/([^/]+)\/draft$/.exec(path)?.[1];
      if (method === "GET" && draftOp) return s.draft ? json({ ...s.draft, opId: draftOp }) : json({ error: "not_found" }, 404);
      if (method === "POST" && path === "/api/coach/proposals/dp-1/approve") {
        const a = s.approve?.[Math.min(approved++, (s.approve?.length ?? 1) - 1)];
        if (!a) return json({ error: "offline" }, 503);
        if ("error" in a) return json({ error: a.error }, a.status);
        if ("settled" in a) {
          return json({ ok: true, status: a.settled === "applied" ? "approved" : "declined", applied: [], refused: [], settled: [{ opId: body.edit.opId, outcome: a.settled, ...(a.settled === "applied" ? { workoutId: "w-theirs" } : {}) }], remaining: [] });
        }
        return json({ ok: true, status: "partially_approved", applied: [{ opId: body.edit.opId, workout: { ...a, title: body.edit.doc.title }, warnings: [] }], refused: [], settled: [], remaining: [] });
      }
      // Scheduled as a new workout of the athlete's own.
      if (method === "POST" && path === "/api/workouts") {
        return json({ workout: workout("w-own", body.date, body.time ?? "18:00", body.doc.title), warnings: [] }, 201);
      }
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: [] });
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

function mount(path: string, extra?: ReturnType<typeof createElement>, everywhere?: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(HOME_GEAR), today: todayDto(null, false) });
  qc.setQueryData(["settings"], { prefs: DEVICE_PREFS });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/studio/build/*", element: createElement(BuilderRoute) }),
            createElement(Route, { path: "/coach", element: extra ?? null }),
          ),
          createElement(Where),
          everywhere ?? null,
        ),
      ),
    );
  });
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}
async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string, scope: ParentNode = document) => buttons(scope).find((b) => b.textContent?.trim() === name) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;
const titleField = () => document.querySelector<HTMLInputElement>(".stu-build-title");
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function retype(input: HTMLInputElement, value: string) {
  act(() => input.focus());
  await act(async () => setValue(input, value));
  act(() => input.blur());
  await settle();
}
const approvals = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/proposals/dp-1/approve");

// ── Where it opens ─────────────────────────────────────────────────────────

describe("the draft's address", () => {
  it("/studio/build/proposal/:id/:opId is the builder on that op's draft", () => {
    expect(sourceOfPath("/studio/build/proposal/dp-1/run-a")).toEqual({ kind: "proposal", id: "dp-1", opId: "run-a" });
    expect(sourceKey({ kind: "proposal", id: "dp-1", opId: "run-a" })).toBe("proposal:dp-1:run-a");
    expect(sourceOfPath("/studio/build/proposal/dp-1")).toBeNull();
    expect(sourceOfPath("/studio/build/proposal/%E0%A4%A/run-a")).toBeNull();
    expect(editDraftHref("dp 1", "run/a")).toBe("/studio/build/proposal/dp%201/run%2Fa");
    expect(sourceOfPath(editDraftHref("dp 1", "run/a"))).toEqual({ kind: "proposal", id: "dp 1", opId: "run/a" });
  });

  it("useEditBeforeApprove opens it", async () => {
    serve({ draft: draftOf() });
    function Opener() {
      const edit = useEditBeforeApprove();
      return createElement("button", { type: "button", onClick: () => edit("dp-1", "run-a") }, "Edit before approve");
    }
    mount("/coach", createElement(Opener));
    await click(button("Edit before approve"), "the hook's button");
    expect(where).toBe("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
  });
});

// ── Saving it approves it ──────────────────────────────────────────────────

describe("Edit before approve", () => {
  it("a new workout's draft: changed, then Schedule — on the coach's day and time — approves THAT op with the edited document, and the builder is on the workout", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    const calls = serve({ draft: draftOf(), approve: [workout("w-9", TUESDAY, "17:30", "")] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    // Starting a draft would make a workout the proposal never approved.
    expect(document.querySelector(".stu-build-start")).toBeNull();
    expect(document.querySelector(".stu-build-when")?.textContent).toBe("Tue Oct 13 · 5:30 PM");
    await retype(titleField()!, "My hips");
    await click(button("Approve my version…"), "Approve my version…");
    const sheet = dialog("Schedule")!;
    expect(sheet.querySelector<HTMLInputElement>('input[type="radio"][value="day"]')!.checked).toBe(true);
    expect(sheet.querySelector<HTMLInputElement>('input[aria-label="Day"]')!.value).toBe(TUESDAY);
    expect(sheet.querySelector<HTMLInputElement>('input[aria-label="Time (optional)"]')!.value).toBe("17:30");
    await click(button("Schedule", sheet), "Schedule");
    await until(() => text().includes("Scheduled for Tue Oct 13 at 5:30 PM."), "the line");
    const [approve] = approvals(calls);
    expect(approve!.body).toEqual({ edit: { opId: "run-a", doc: expect.objectContaining({ title: "My hips" }), date: TUESDAY, time: "17:30" } });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workouts")).toBe(false);
    expect(where).toBe("/studio/build/workout/w-9");
  });

  it("a revision's draft: Save changes approves it, changed or not; a refusal says why in place, and saving again goes on", async () => {
    const calls = serve({
      draft: draftOf({ target: { kind: "revise", workoutId: "w1", baseRev: 3 }, date: TODAY, time: "18:00" }),
      approve: [{ error: "stale_revision", status: 409 }, workout("w1", TODAY, "18:00", "")],
    });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    expect(button("Schedule…")).toBeNull();
    expect(button("Approve my version")!.disabled).toBe(false);
    await click(button("Approve my version"), "Approve my version");
    await until(() => text().includes("This workout changed after the coach drafted this, so the draft can't be applied."), "the refusal");
    expect(where).toBe("/studio/build/proposal/dp-1/run-a");
    expect(button("Schedule it as a new workout")).not.toBeNull();
    await click(button("Approve my version"), "Approve my version");
    await until(() => where === "/studio/build/workout/w1", "the workout");
    expect(text()).toContain("Saved.");
    expect(approvals(calls).map((c) => c.body)).toEqual([
      { edit: { opId: "run-a", doc: expect.objectContaining({ title: "Coach's hips" }) } },
      { edit: { opId: "run-a", doc: expect.objectContaining({ title: "Coach's hips" }) } },
    ]);
  });

  it("a draft already approved says so and opens the workout; one gone says so", async () => {
    serve({ draft: draftOf({ outcome: { status: "applied", at: "2026-10-11T09:00:00Z", workoutId: "w-7", rev: 1, written: { date: TUESDAY, time: "17:30", title: "Coach's hips", minutes: 20 } } }) });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => text().includes("This one is in your plan already."), "the line");
    expect(document.querySelector<HTMLAnchorElement>('a[href="/studio/build/workout/w-7"]')?.textContent).toBe("Open it");
    act(() => root?.unmount());
    serve({ draft: null });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => text().includes("That draft is gone."), "the line");
  });

  it("approved elsewhere meanwhile: the edits stay, it says so plainly, and Open it goes to the workout in the plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    serve({ draft: draftOf(), approve: [{ settled: "applied" }] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await retype(titleField()!, "My hips");
    await click(button("Approve my version…"), "Approve my version…");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => text().includes("The coach's version was approved already."), "the line");
    expect(titleField()!.value).toBe("My hips");
    expect(document.querySelector<HTMLAnchorElement>('.stu-build-status a[href="/studio/build/workout/w-theirs"]')?.textContent).toBe("Open it");
    expect(button("Schedule it as a new workout")).toBeNull();
  });

  it("declined elsewhere meanwhile: the edits stay, and Schedule it as a new workout makes one of the athlete's own — written in the Studio, its lineage the proposal's", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    const calls = serve({ draft: draftOf(), approve: [{ settled: "declined" }] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await retype(titleField()!, "My hips");
    await click(button("Approve my version…"), "Approve my version…");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => text().includes("The coach's version was declined already."), "the line");
    // Nothing lost, nowhere else.
    expect(titleField()!.value).toBe("My hips");
    expect(where).toBe("/studio/build/proposal/dp-1/run-a");
    await click(button("Schedule it as a new workout"), "Schedule it as a new workout");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => where === "/studio/build/workout/w-own", "the new workout");
    const created = calls.filter((c) => c.method === "POST" && c.path === "/api/workouts");
    expect(created.map((c) => c.body)).toEqual([
      expect.objectContaining({
        date: TUESDAY,
        time: "17:30",
        doc: expect.objectContaining({ title: "My hips", source: { kind: "studio" }, basedOn: { kind: "proposal", id: "dp-1", opId: "run-a" } }),
      }),
    ]);
    expect(approvals(calls)).toHaveLength(1);
    // On the workout it became, nothing reads as changed since it was made.
    expect(button("Save changes")!.disabled).toBe(true);
  });

  it("the draft's own refusals in its own words: declined elsewhere, a revision's day gone, a draft no longer open", async () => {
    const say = async (draft: DesignDraftResponse, answer: { error: string; status: number } | { settled: "declined" }, button_: string, words: string) => {
      serve({ draft, approve: [answer] });
      mount("/studio/build/proposal/dp-1/run-a");
      await until(() => titleField()?.value === "Coach's hips", "the draft");
      await click(button(button_), button_);
      if (button_ === "Approve my version…") await click(button("Schedule", dialog("Schedule")!), "Schedule");
      await until(() => text().includes(words), words);
      expect(button("Schedule it as a new workout")).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
    };
    const revise = draftOf({ target: { kind: "revise", workoutId: "w1", baseRev: 3 }, date: TODAY, time: "18:00" });
    await say(revise, { settled: "declined" }, "Approve my version", "The coach's version was declined already.");
    await say(revise, { error: "past_date", status: 422 }, "Approve my version", "This workout's day has passed, so the draft can't be applied any more.");
    await say(revise, { error: "not_pending", status: 409 }, "Approve my version", "This draft isn't open any more, so it can't be approved.");
    await say(revise, { error: "not_found", status: 404 }, "Approve my version", "The workout this draft revises is no longer in your plan.");
  });

  it("a revision's draft taken as a new workout schedules one: Schedule… stands where Save changes was", async () => {
    serve({ draft: draftOf({ target: { kind: "revise", workoutId: "w1", baseRev: 3 }, date: TODAY, time: "18:00" }), approve: [{ settled: "declined" }] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await click(button("Approve my version"), "Approve my version");
    await until(() => !!button("Schedule it as a new workout"), "the offer");
    await click(button("Schedule it as a new workout"), "Schedule it as a new workout");
    expect(dialog("Schedule")).not.toBeNull();
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]'), "Close");
    expect(button("Save changes")).toBeNull();
    expect(button("Schedule…")).not.toBeNull();
  });

  it("taking one draft as a new workout is forgotten when the builder opens another: that one's Schedule approves it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    const calls = serve({ draft: draftOf(), approve: [{ settled: "declined" }, workout("w-b", TUESDAY, "17:30", "")] });
    function Next() {
      const edit = useEditBeforeApprove();
      return createElement("button", { type: "button", onClick: () => edit("dp-1", "run-b") }, "Next draft");
    }
    mount("/studio/build/proposal/dp-1/run-a", undefined, createElement(Next));
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await click(button("Approve my version…"), "Approve my version…");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => !!button("Schedule it as a new workout"), "the offer");
    await click(button("Schedule it as a new workout"), "Schedule it as a new workout");
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]'), "Close");
    // The next draft, on the same builder.
    await click(button("Next draft"), "Next draft");
    await until(() => where === "/studio/build/proposal/dp-1/run-b" && titleField()?.value === "Coach's hips", "the next draft");
    await click(button("Approve my version…"), "Approve my version…");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => approvals(calls).length === 2, "its approve");
    expect(approvals(calls)[1]!.body).toMatchObject({ edit: { opId: "run-b" } });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workouts")).toBe(false);
  });

  it("a new workout's draft refused for its day is the Studio's own words, in the sheet: pick another day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    serve({ draft: draftOf(), approve: [{ error: "past_date", status: 422 }] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await click(button("Approve my version…"), "Approve my version…");
    await click(button("Schedule", dialog("Schedule")!), "Schedule");
    await until(() => text().includes("That day has passed — pick today or a later day."), "the sheet's line");
    expect(button("Schedule it as a new workout")).toBeNull();
  });

  it("a draft the athlete declined, or a proposal no longer open, is closed", async () => {
    serve({ draft: draftOf({ status: "expired" }) });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => text().includes("This draft is closed."), "the line");
  });
});

// ── Fix wave 3B, Part U ─────────────────────────────────────────────────────

describe("fix wave 3B: Edit before approve (B-I8) and the goal line (A-M2, LIVE)", () => {
  it("the builder says it is the coach's suggestion, and its save button approves the athlete's version", async () => {
    serve({ draft: draftOf() });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    expect(document.querySelector(".stu-build-head .eyebrow")?.textContent).toBe("Coach's suggestion");
    expect(button("Approve my version…")).not.toBeNull();
    expect(button("Schedule…")).toBeNull();
  });

  it("a revision's draft: its save button approves it too, in the same words", async () => {
    serve({ draft: draftOf({ target: { kind: "revise", workoutId: "w1", baseRev: 3 }, date: TODAY, time: "18:00" }) });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    expect(button("Approve my version")).not.toBeNull();
    expect(button("Save changes")).toBeNull();
  });

  it("a draft dated today with no time opens the sheet on Later today — a time already in it, ready to approve", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 9, 0) });
    const calls = serve({ draft: draftOf({ target: { kind: "new", date: TODAY }, date: TODAY, time: null }), approve: [workout("w-9", TODAY, "11:00", "")] });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    await click(button("Approve my version…"), "Approve my version…");
    const sheet = dialog("Schedule")!;
    expect(sheet.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.checked).toBe(true);
    const time = sheet.querySelector<HTMLInputElement>('input[aria-label="Time today"]')!.value;
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(text()).not.toContain("Your usual time today has passed");
    const go = button("Schedule", sheet)!;
    expect(go.disabled).toBe(false);
    await click(go, "Schedule");
    await until(() => approvals(calls).length === 1, "the approve");
    expect(approvals(calls)[0]!.body).toMatchObject({ edit: { opId: "run-a", date: TODAY, time } });
  });

  it("the goal line names each goal in plain words (GOAL_LABELS), never its id", async () => {
    const doc = { ...coachDoc("Coach's hips"), intent: { ...coachDoc("x").intent, goals: ["aerobic-base", "condition-care"] as WorkoutDoc["intent"]["goals"] } };
    serve({ draft: draftOf({ doc }) });
    mount("/studio/build/proposal/dp-1/run-a");
    await until(() => titleField()?.value === "Coach's hips", "the draft");
    expect(document.querySelector(".stu-build-goal-list")?.textContent).toBe("Aerobic base · Condition care");
  });
});
