// @vitest-environment jsdom
/**
 * Stage 3 Task 11 — the objectives board, live: add, edit, pause and complete objectives with their key results through
 * the existing routes (`POST /api/objectives`, `PUT /api/objectives/:id`), in one sheet in the Studio's pattern, every
 * request body asserted; complete asks once, plainly; a refusal is said in plain words; and the coach switch — off, the
 * route goes back to the Studio.
 */
// The new shape (2026-10-17) sends the app's /studio/objectives to Growth, whose quests take the board's place; until
// Growth holds them the board is mounted here at its old path directly, so its behaviour stays pinned.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCHEDULING_PREFERENCES,
  keyResultMeasureSchema,
  type KeyResultDto,
  type KeyResultProgress,
  type ObjectiveBoardDto,
  type ObjectiveDto,
} from "@rg/domain";
import { StudioRoute } from "../src/app.js";
import { ObjectivesRoute } from "../src/screens/studio/objectives.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { features } from "../src/features.js";
import { libraryDto, placesDto, primedClient, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-14";
const T0 = "2026-09-01T12:00:00.000Z";

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";
const was = { coach: features.coach, studio: features.studio };

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  features.coach = was.coach;
  features.studio = was.studio;
});

function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}

// ── The server ─────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: any;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function kr(id: string, objectiveId: string, label: string, o: Partial<KeyResultDto> = {}): KeyResultDto {
  return {
    id, objectiveId, label, measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] }), direction: "up", baseline: 60,
    target: 120, unit: "s", dueDate: null, position: 0, createdAt: T0, updatedAt: T0, ...o,
  };
}

/** Nothing measured yet. */
const unmeasured = (k: KeyResultDto): KeyResultProgress => ({
  unit: "s", current: null, series: [], lastMeasuredAt: null, sampleSize: 0, evidence: "none", missing: "Nothing logged yet.", display: { unit: k.unit, current: null },
});

function objective(id: string, title: string, o: Partial<ObjectiveDto> = {}): ObjectiveDto {
  return { id, title, why: null, status: "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: T0, keyResults: [], ...o };
}

/** An objectives server that keeps what it is told; `refuse` answers the next write with that status and body. */
function serve(initial: ObjectiveDto[] = [], refuse: { status: number; body: unknown } | null = null): Call[] {
  const calls: Call[] = [];
  let objectives = [...initial];
  let refusal = refuse;
  const board = (): ObjectiveBoardDto => ({
    today: TODAY,
    objectives: objectives.map((o) => ({
      objective: o,
      keyResults: o.keyResults.map((k) => ({ keyResult: k, progress: unmeasured(k), best: null })),
      served: [],
      streakWeeks: 0,
      note: null,
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/objectives/board") return json(board());
      if (method === "GET" && path === "/api/settings") return json({ prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
      if ((method === "POST" || method === "PUT") && refusal) {
        const r = refusal;
        refusal = null;
        return json(r.body, r.status);
      }
      if (method === "POST" && path === "/api/objectives") {
        const id = `o${objectives.length + 1}`;
        const made = objective(id, body.title, {
          why: body.why ?? null,
          goalIds: body.goalIds ?? [],
          keyResults: (body.keyResults ?? []).map((k: any, i: number) => kr(`${id}-k${i}`, id, k.label, { ...k, measure: keyResultMeasureSchema.parse(k.measure), position: i })),
        });
        objectives = [...objectives, made];
        return json({ objective: made }, 201);
      }
      const one = /^\/api\/objectives\/([^/]+)$/.exec(path);
      if (method === "PUT" && one) {
        const id = decodeURIComponent(one[1]!);
        const o = objectives.find((x) => x.id === id);
        if (!o) return json({ error: "not_found" }, 404);
        const next: ObjectiveDto = {
          ...o,
          ...body,
          keyResults: body.keyResults
            ? body.keyResults.map((k: any, i: number) => kr(k.id ?? `${id}-n${i}`, id, k.label, { ...k, measure: keyResultMeasureSchema.parse(k.measure), position: i }))
            : o.keyResults,
        };
        objectives = objectives.map((x) => (x.id === id ? next : x));
        return json({ objective: next });
      }
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

// ── Mounting and driving ───────────────────────────────────────────────────

/** With `coach`, the app's coach sheet is mounted around the routes, as app.tsx mounts it with the coach on. */
function mount(path: string, o: { coach?: boolean } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(["mat"]), today: todayDto(null, false), library: libraryDto() });
  qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
  qc.setQueryData(["coach-run-current"], { run: null });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          o.coach
            ? createElement(CoachSheetProvider, null, createElement(Routes, null, createElement(Route, { path: "/studio/objectives", element: createElement(ObjectivesRoute) }), createElement(Route, { path: "/studio/*", element: createElement(StudioRoute) })))
            : createElement(Routes, null, createElement(Route, { path: "/studio/objectives", element: createElement(ObjectivesRoute) }), createElement(Route, { path: "/studio/*", element: createElement(StudioRoute) })),
          createElement(Where),
        ),
      ),
    );
  });
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const pageText = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${pageText()}`);
}

async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${pageText()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;
const field = (label: string, scope: ParentNode = document) => {
  const l = [...scope.querySelectorAll("label")].find((x) => x.textContent?.trim().startsWith(label));
  const id = l?.getAttribute("for");
  return (id ? document.getElementById(id) : l?.querySelector("input, textarea, select")) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
};

function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string, what: string) {
  if (!el) throw new Error(`no ${what} in: ${pageText()}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const cardOf = (title: string) => [...document.querySelectorAll<HTMLElement>("article.obj-card")].find((a) => a.querySelector("h2")?.textContent === title) ?? null;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

// ── The switch ─────────────────────────────────────────────────────────────

describe("the coach switch", () => {
  it("off: /studio/objectives goes back to the Studio, and nothing reads the board", async () => {
    features.coach = false;
    const calls = serve([objective("o1", "Legs")]);
    mount("/studio/objectives");
    await until(() => where === "/studio", "the redirect");
    expect(calls.some((c) => c.path === "/api/objectives/board")).toBe(false);
  });

  it("on: the board", async () => {
    serve([objective("o1", "Legs")]);
    mount("/studio/objectives");
    await until(() => !!cardOf("Legs"), "the card");
    expect(where).toBe("/studio/objectives");
  });

  it("a measure not measured yet: 'Ask the coach for a test' opens the coach's sheet on the board, about the objective, the request in it (fix wave 3B, B-I11; coach everywhere, A3)", async () => {
    serve([objective("o1", "Legs", { keyResults: [kr("k1", "o1", "Wall sit")] })]);
    mount("/studio/objectives", { coach: true });
    await until(() => !!cardOf("Legs"), "the card");
    expect(cardOf("Legs")!.textContent).toContain("Not measured yet");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Ask the coach for a test"), "Ask the coach for a test");
    await until(() => !!document.querySelector('[role="dialog"] .coach-composer-field'), "the coach's sheet");
    // In place: the board stays, the sheet over it.
    expect(where).toBe("/studio/objectives");
    expect(document.querySelector<HTMLTextAreaElement>(".coach-composer-field")!.value).toBe("Plan a test so I can measure: Wall sit");
    expect(document.querySelector(".coach-about")!.textContent).toContain("About: Legs");
  });

  it("a stalled objective: 'Ask the coach' opens the coach's sheet about it, a request toward it filled in (Task 13, D13; coach everywhere, A3)", async () => {
    serve([objective("o1", "Stronger legs for ski season")]);
    mount("/studio/objectives", { coach: true });
    await until(() => !!cardOf("Stronger legs for ski season"), "the card");
    expect(cardOf("Stronger legs for ski season")!.textContent).toContain("Nothing done toward this");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Ask the coach"), "Ask the coach");
    await until(() => !!document.querySelector('[role="dialog"] .coach-composer-field'), "the coach's sheet");
    expect(where).toBe("/studio/objectives");
    expect(document.querySelector<HTMLTextAreaElement>(".coach-composer-field")!.value).toBe("Plan a session toward my objective: Stronger legs for ski season");
    expect(document.querySelector(".coach-about")!.textContent).toContain("About: Stronger legs for ski season");
  });
});

// ── Writes ─────────────────────────────────────────────────────────────────

describe("add", () => {
  it("a new objective with a key result: one POST, its body what was typed, in the athlete's units", async () => {
    const calls = serve();
    mount("/studio/objectives");
    await until(() => pageText().includes("No objectives yet."), "the empty board");
    await click(button("New objective"), "New objective");
    const sheet = dialog("New objective")!;
    expect(sheet).not.toBeNull();
    type(field("Title", sheet), "  Stronger legs ", "the title");
    type(field("Why", sheet), "Ski the whole day", "the why");
    await click(button("Ski", sheet), "the Ski goal");
    await click(button("Add a measure", sheet), "Add a measure");
    const k = dialog("Measure")!;
    type(field("Name", k), "Wall sit hold", "the name");
    type(field("What it measures", k), "hold_max", "the measure");
    await settle();
    type(k.querySelector<HTMLInputElement>('input[type="search"]'), "wall sit", "the move search");
    await settle();
    await click(buttons(k).find((b) => b.classList.contains("obj-pick") && b.textContent?.startsWith("Wall sit")), "Wall sit");
    type(field("Target", k), "120", "the target");
    type(field("Start", k), "60", "the start");
    await click(button("Done", k), "Done");
    const back = dialog("New objective")!;
    expect(back.textContent).toContain("Wall sit hold");
    await click(button("Save", back), "Save");
    await until(() => !!cardOf("Stronger legs"), "the new card");
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: "/api/objectives",
        body: {
          title: "Stronger legs",
          why: "Ski the whole day",
          goalIds: ["ski"],
          keyResults: [
            { label: "Wall sit hold", measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 }, unit: "s", target: 120, baseline: 60, dueDate: null },
          ],
        },
      },
    ]);
    expect(dialog("New objective")).toBeNull();
    expect(pageText()).toContain("Added “Stronger legs”.");
  });

  it("a race time is typed as a clock and sent in seconds; a distance in the athlete's unit, sent in metres", async () => {
    const calls = serve();
    mount("/studio/objectives");
    await until(() => pageText().includes("No objectives yet."), "the empty board");
    await click(button("New objective"), "New objective");
    const sheet = dialog("New objective")!;
    type(field("Title", sheet), "Faster 10K", "the title");
    await click(button("Add a measure", sheet), "Add a measure");
    const k = dialog("Measure")!;
    type(field("Name", k), "10K time", "the name");
    type(field("What it measures", k), "run_best", "the measure");
    await settle();
    type(field("Distance", k), "10", "the distance");
    type(field("Target", k), "48:30", "the target");
    await click(button("Done", k), "Done");
    await click(button("Save", dialog("New objective")!), "Save");
    await until(() => writes(calls).length === 1, "the POST");
    expect(writes(calls)[0]!.body.keyResults).toEqual([
      { label: "10K time", measure: { kind: "run_best", distanceM: 10000, windowDays: 180 }, unit: "s", target: 2910, baseline: null, dueDate: null },
    ]);
  });

  it("what can't be sent is said in plain words before anything is sent, brought into view", async () => {
    const calls = serve();
    const seen: Element[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    mount("/studio/objectives");
    await until(() => pageText().includes("No objectives yet."), "the empty board");
    await click(button("New objective"), "New objective");
    await click(button("Save", dialog("New objective")!), "Save");
    expect(dialog("New objective")!.textContent).toContain("Give it a title.");
    await click(button("Add a measure", dialog("New objective")!), "Add a measure");
    const k = dialog("Measure")!;
    type(field("What it measures", k), "hold_max", "the measure");
    await settle();
    type(field("Target", k), "fast", "the target");
    await click(button("Done", k), "Done");
    const said = dialog("Measure")!.textContent ?? "";
    expect(said).toContain("Give it a name.");
    expect(said).toContain("Pick at least one move.");
    expect(said).toContain("The target isn't a number.");
    expect(writes(calls)).toEqual([]);
    // Below the fold on a phone: each time, the words are scrolled to.
    expect(seen.filter((el) => el.getAttribute("role") === "alert").map((el) => el.textContent)).toEqual([
      "Give it a title.",
      expect.stringContaining("Give it a name."),
    ]);
    Element.prototype.scrollIntoView = was;
  });

  it("a refusal from the server is said in plain words, and the sheet stays open", async () => {
    serve([], {
      status: 422,
      body: { error: "invalid_objective", issues: [{ code: "custom", path: ["keyResults", 0, "measure", "libraryIds", 0], message: "not a move the library holds" }] },
    });
    mount("/studio/objectives");
    await until(() => pageText().includes("No objectives yet."), "the empty board");
    await click(button("New objective"), "New objective");
    const sheet = dialog("New objective")!;
    type(field("Title", sheet), "Legs", "the title");
    await click(button("Add a measure", sheet), "Add a measure");
    const k = dialog("Measure")!;
    type(field("Name", k), "Hold", "the name");
    type(field("What it measures", k), "hold_max", "the measure");
    await settle();
    type(k.querySelector<HTMLInputElement>('input[type="search"]'), "wall sit", "the move search");
    await settle();
    await click(buttons(k).find((b) => b.classList.contains("obj-pick") && b.textContent?.startsWith("Wall sit")), "Wall sit");
    await click(button("Done", k), "Done");
    await click(button("Save", dialog("New objective")!), "Save");
    await until(() => (dialog("New objective")?.textContent ?? "").includes("“Hold”: not a move the library holds"), "the refusal");
  });
});

describe("edit", () => {
  it("the sheet opens on the objective; Save sends the whole of it, each key result with its id and its own unit", async () => {
    const legs = objective("o1", "Legs", { why: "Ski", goalIds: ["ski"], keyResults: [kr("k1", "o1", "Wall sit hold", { unit: "min", target: 2, baseline: 1 })] });
    const calls = serve([legs]);
    mount("/studio/objectives");
    await until(() => !!cardOf("Legs"), "the card");
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Edit…", dialog("Legs")!), "Edit…");
    const sheet = dialog("Edit objective")!;
    expect((field("Title", sheet) as HTMLInputElement).value).toBe("Legs");
    type(field("Title", sheet), "Stronger legs", "the title");
    type(field("Why", sheet), "", "the why");
    await click(button("Strength", sheet), "the Strength goal");
    await click(button("Save", sheet), "Save");
    await until(() => !!cardOf("Stronger legs"), "the changed card");
    expect(writes(calls)).toEqual([
      {
        method: "PUT",
        path: "/api/objectives/o1",
        body: {
          title: "Stronger legs",
          why: null,
          goalIds: ["ski", "strength"],
          keyResults: [{ id: "k1", label: "Wall sit hold", measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 }, unit: "min", target: 2, baseline: 1, dueDate: null }],
        },
      },
    ]);
  });

  it("a key result removed is left out of the list sent", async () => {
    const legs = objective("o1", "Legs", { keyResults: [kr("k1", "o1", "Wall sit hold"), kr("k2", "o1", "Second hold")] });
    const calls = serve([legs]);
    mount("/studio/objectives");
    await until(() => !!cardOf("Legs"), "the card");
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Edit…", dialog("Legs")!), "Edit…");
    const sheet = dialog("Edit objective")!;
    await click(button("Remove Wall sit hold", sheet), "Remove");
    await click(button("Save", sheet), "Save");
    await until(() => writes(calls).length === 1, "the PUT");
    expect(writes(calls)[0]!.body.keyResults.map((k: any) => k.id)).toEqual(["k2"]);
  });
});

describe("pause and complete", () => {
  it("Pause is one status change, and Resume another", async () => {
    const calls = serve([objective("o1", "Legs")]);
    mount("/studio/objectives");
    await until(() => !!cardOf("Legs"), "the card");
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Pause", dialog("Legs")!), "Pause");
    await until(() => cardOf("Legs")?.classList.contains("obj-card--paused") === true, "the paused card");
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Resume", dialog("Legs")!), "Resume");
    await until(() => cardOf("Legs")?.classList.contains("obj-card--active") === true, "the active card");
    expect(writes(calls)).toEqual([
      { method: "PUT", path: "/api/objectives/o1", body: { status: "paused" } },
      { method: "PUT", path: "/api/objectives/o1", body: { status: "active" } },
    ]);
  });

  it("Mark complete asks once, plainly; Not yet sends nothing; then it is done", async () => {
    const calls = serve([objective("o1", "Legs")]);
    mount("/studio/objectives");
    await until(() => !!cardOf("Legs"), "the card");
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Mark complete…", dialog("Legs")!), "Mark complete…");
    const ask = dialog("Mark it complete?")!;
    expect(ask.textContent).toContain("“Legs” moves to Completed. You can reopen it.");
    // Not destructive: never the danger button.
    expect(ask.querySelector(".btn-danger")).toBeNull();
    await click(button("Not yet", ask), "Not yet");
    expect(writes(calls)).toEqual([]);
    await click(cardOf("Legs")!.querySelector(".obj-more"), "the card's ⋯");
    await click(button("Mark complete…", dialog("Legs")!), "Mark complete…");
    await click(button("Mark complete", dialog("Mark it complete?")!), "Mark complete");
    await until(() => cardOf("Legs")?.classList.contains("obj-card--done") === true, "the completed card");
    expect(writes(calls)).toEqual([{ method: "PUT", path: "/api/objectives/o1", body: { status: "done" } }]);
    expect(dialog("Mark it complete?")).toBeNull();
    expect(pageText()).toContain("Completed “Legs”.");
  });
});
