// @vitest-environment jsdom
/**
 * Stage 2 Task 6 — the builder, live (spec §8, §10): a hinge added to the main part brings a glute activation to the
 * page, and its ＋ makes the part; an error keeps Start off until its Fix swaps the alternate in; Save as template and
 * Save changes reach the server (a stale base says so, with Reload); reordering is by buttons, and Undo takes it back;
 * Start now makes the workout for today, builds and starts it, and opens the player — asking today's check first, in
 * place, when the workout waits on it; a build the day changed is shown before it locks; Schedule puts it on a day.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, WorkoutDto } from "@rg/api-client";
import { DEFAULT_SCHEDULING_PREFERENCES, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, type DraftDoc, type EditAction } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { draftStore } from "../src/studio-drafts.js";
import { offlineDb } from "../src/offline/idb.js";
import { libraryDto, placesDto, primedClient, todayDto, TODAY, type Primed } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_GEAR = ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"];
const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

beforeEach(async () => {
  await draftStore().clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
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
  body: unknown;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function built(id: string, over: { buildId?: string; swaps?: Array<{ path: string; from: string; to: string; reason: string }>; blocked?: unknown[] } = {}): SessionDto {
  return {
    workoutId: id,
    date: TODAY,
    contentState: "built",
    locked: false,
    checks: {},
    profiles: [],
    choices: { modes: [], themes: [], locations: [] },
    view: {
      mode: "consistent",
      proposedMode: "consistent",
      modeReasons: [],
      theme: null,
      proposedTheme: null,
      themeReasons: [],
      minutes: 20,
      location: { id: "home", name: "Home", equipment: [], implements: {} },
      block: null,
      newMove: null,
    },
    build: {
      buildId: over.buildId ?? "b1",
      version: 1,
      date: TODAY,
      steps: [],
      items: [],
      exercises: {},
      alternatives: {},
      targets: {},
      newMove: null,
      params: { checks: {}, overrides: {}, swaps: {} },
      fromDoc: { rev: 1, swaps: over.swaps ?? [], blocked: over.blocked ?? [] },
    },
    watch: null,
  } as unknown as SessionDto;
}

function plannedRow(id: string, date = TODAY): WorkoutDto {
  return {
    id,
    title: "Hips & posture",
    category: "strength",
    sport: "strength",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "18:00",
    workoutSeconds: 1800,
    calendarSeconds: 1800,
    calendarSyncState: "synced",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    archived: false,
    origin: "studio",
    contentState: "outline",
    programId: "studio-u1",
  } as WorkoutDto;
}

interface Server {
  /** GET /api/workouts/:id/doc, in turn (the last repeats). */
  docs?: Array<{ doc: WorkoutDoc; rev: number }>;
  /** PUT /api/workouts/:id/doc, in turn: an error, or OK. */
  revise?: Array<{ error: string; status: number } | "ok">;
  planned?: WorkoutDto[];
  /** POST /api/sessions/:id/start answers, in turn. */
  start?: Array<SessionDto | { status: number; body: unknown }>;
  build?: SessionDto;
}

function serve(s: Server = {}): Call[] {
  const calls: Call[] = [];
  let docRead = 0;
  let revised = 0;
  let started = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: s.planned ?? [] });
      if (method === "GET" && path === "/api/templates") return json({ templates: [] });
      if (method === "POST" && path === "/api/templates") {
        return json({ template: { id: "t-new", name: body.name, doc: body.doc, pinned: false, uses: 0, lastUsedAt: null, createdAt: "", updatedAt: "", minutes: 20, discipline: "strength" }, warnings: [] }, 201);
      }
      const doc = /^\/api\/workouts\/([^/]+)\/doc$/.exec(path);
      if (doc && method === "GET") {
        const d = s.docs?.[Math.min(docRead++, (s.docs?.length ?? 1) - 1)];
        if (!d) return json({ error: "not_found" }, 404);
        return json({ doc: d.doc, derived: { estimatedMinutes: 20, discipline: "strength", category: "strength", mode: "consistent", watchStepCount: 4 }, rev: d.rev });
      }
      if (doc && method === "PUT") {
        const a = s.revise?.[Math.min(revised++, (s.revise?.length ?? 1) - 1)] ?? "ok";
        if (a !== "ok") return json({ error: a.error, rev: body.baseRev + 1 }, a.status);
        return json({ workout: { id: doc[1], date: TODAY, time: "18:00", title: body.doc.title, docRev: body.baseRev + 1 }, rev: body.baseRev + 1, watchHasOlder: false, warnings: [] });
      }
      if (method === "POST" && path === "/api/workouts") {
        return json(
          {
            workout: { id: "w-new", date: body.date, time: body.time ?? "18:00", title: body.doc.title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: 20 },
            warnings: [],
          },
          201,
        );
      }
      if (method === "POST" && path === "/api/conditions/checks") return json({ check: { ...body, date: TODAY } });
      const session = /^\/api\/sessions\/([^/]+)\/(build|start)$/.exec(path);
      if (session && method === "POST" && session[2] === "build") return json(s.build ?? built(session[1]!));
      if (session && method === "POST" && session[2] === "start") {
        const a = s.start?.[Math.min(started++, (s.start?.length ?? 1) - 1)];
        if (a && "status" in a) return json(a.body, a.status);
        const next = a ?? built(session[1]!, { buildId: body.buildId });
        return json({ ...next, contentState: "started", locked: true });
      }
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

// ── Mounting and driving ───────────────────────────────────────────────────

function mount(path: string, primed: Primed = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // Today is the fixtures' day (no programme, so no condition chips) unless a case says otherwise.
  const qc = primedClient({ places: placesDto(HOME_GEAR), today: todayDto(null, false), ...primed });
  qc.setQueryData(["settings"], { prefs: DEFAULT_SCHEDULING_PREFERENCES });
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
            createElement(Route, { path: "/session/:id", element: createElement("p", null, "the player") }),
          ),
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
const button = (name: string | RegExp, scope: ParentNode = document) =>
  buttons(scope).find((b) => (typeof name === "string" ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name : name.test(b.textContent ?? ""))) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;
const startButton = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
/** A part's name: the term's own word, not its popover's sentence. */
const partName = (p: Element) => (p.querySelector(".stu-part-name .term") ?? p.querySelector(".stu-part-name"))?.textContent?.trim() ?? "";
/** The workout's parts as drawn (a prompted part not made yet left out): [name, the items' names]. */
const partsShown = () =>
  [...document.querySelectorAll<HTMLElement>(".stu-part:not(.stu-part--ghost)")].map((p) => [
    partName(p),
    [...p.querySelectorAll(".stu-item-name")].map((n) => n.firstChild?.textContent?.trim()),
  ]);

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function type(input: Element | null, value: string, what: string) {
  if (!input) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    setValue(input as HTMLInputElement, value);
  });
  await settle();
}

function draft(...actions: EditAction[]): DraftDoc {
  let s = startEditing(newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } }));
  for (const a of actions) s = edit(s, a, EXERCISES);
  return s.doc;
}
const into = (part: number, id: string, extra: object = {}): EditAction => ({ type: "addItem", part, item: { ...suggestedItem(rec(id), "main"), ...extra } as never });
const saved = async () => (await draftStore().load())?.doc ?? null;
const ids = (doc: WorkoutDoc | null, purpose: string) => doc?.parts.find((p) => p.purpose === purpose)?.items.map((i) => (i.kind === "exercise" ? i.libraryId : i.kind)) ?? null;

// ── Parts and suggestions ──────────────────────────────────────────────────

describe("activate before loading", () => {
  it("a hinge added to the main part brings a glute activation; its ＋ makes the part, in its place", async () => {
    serve();
    mount("/studio/build/new");
    await until(() => partsShown().length === 3, "the three parts");
    expect(document.querySelector(".stu-part--ghost")).toBeNull();

    // Add a move → the picker for Main → search → the deadlift.
    const main = document.querySelectorAll<HTMLElement>(".stu-part")[1]!;
    await click(button("Add a move", main), "Add a move in Main");
    await until(() => !!dialog("Add to Main"), "the picker");
    await type(dialog("Add to Main")!.querySelector('input[type="search"]'), "deadlift", "the search");
    await click(buttons(dialog("Add to Main")!).find((b) => b.querySelector(".stu-pick-name")?.textContent === "Deadlift"), "the Deadlift row");
    await until(() => !dialog("Add to Main"), "the picker to close");
    expect(partsShown()[1]).toEqual(["Main", ["Deadlift"]]);

    // The prompt: an activation part, not made yet, between the warm-up and the main part.
    const ghost = document.querySelector<HTMLElement>(".stu-part--ghost");
    expect(ghost).not.toBeNull();
    expect(ghost!.textContent).toContain("Wakes the glutes before Deadlift.");
    const add = buttons(ghost!).find((b) => b.getAttribute("aria-label")?.startsWith("Add "))!;
    const name = add.getAttribute("aria-label")!.slice("Add ".length);
    expect(rec(EXERCISES.find((r) => r.name === name)!.id).muscles.primary).toEqual(expect.arrayContaining([expect.stringMatching(/^glute-/)]));
    await click(add, "the activation's ＋");
    expect(partsShown().map(([n]) => n)).toEqual(["Warm-up", "Activation", "Main", "Cool-down"]);
    expect(partsShown()[1]![1]).toEqual([name]);
    expect(document.querySelector(".stu-part--ghost")).toBeNull();
    // On this device at once: the draft holds the part, the move dosed for it, its reason as its why.
    await until(() => true, "");
    const doc = await saved();
    const item = doc!.parts[1]!.items[0]!;
    expect(doc!.parts.map((p) => p.purpose)).toEqual(["warmup", "activation", "main", "cooldown"]);
    expect(item.kind === "exercise" && item.why).toBe("wakes the glutes before Deadlift");
    expect(item.kind === "exercise" && item.dose.sets).toBe(1);
  });
});

describe("Add a move", () => {
  it("searches the whole library from the part, leaving out the moves already in the workout", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 1, "the workout");
    await click(button("Add a move", document.querySelectorAll<HTMLElement>(".stu-part:not(.stu-part--ghost)")[1]!), "Add a move in Main");
    const picker = () => dialog("Add to Main")!;
    await type(picker().querySelector('input[type="search"]'), "squat", "the search");
    const names = [...picker().querySelectorAll(".stu-pick-name")].map((n) => n.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("Goblet squat");
  });
});

// ── Errors block, with a Fix ───────────────────────────────────────────────

describe("an error", () => {
  it("keeps Start off with its reason beside it; Fix swaps in the alternate and Start comes on", async () => {
    await draftStore().save(draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] })));
    serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) });
    await until(() => !!startButton() && partsShown()[1]?.[1]?.length === 1, "the workout");
    expect(startButton()!.disabled).toBe(true);
    const why = "Half-kneeling one-arm press isn't allowed with today's Jaw / head check at 3.";
    expect(document.getElementById(startButton()!.getAttribute("aria-describedby")!)!.textContent).toBe(why);

    await click(button("Swap in Floor press"), "Fix");
    expect(partsShown()[1]).toEqual(["Main", ["Floor press"]]);
    expect(startButton()!.disabled).toBe(false);
    expect(text()).not.toContain(why);
  });
});

// ── Save ───────────────────────────────────────────────────────────────────

describe("Save", () => {
  it("as a template: Save ▾ → a name → the server keeps the workout as it would be saved", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 1, "the workout");
    await click(button(/^Save/), "Save ▾");
    await click(document.querySelector('[role="menuitem"]'), "Save as template…");
    const sheet = dialog("Save as template")!;
    expect(sheet.querySelector<HTMLInputElement>("input")!.value).toBe("Hips & posture");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("Saved “Hips & posture” as a template."), "the line");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/templates")!;
    const body = post.body as { name: string; doc: WorkoutDoc };
    expect(body.name).toBe("Hips & posture");
    // What saves is the document without its empty parts.
    expect(body.doc.parts.map((p) => p.purpose)).toEqual(["main"]);
    expect(ids(body.doc, "main")).toEqual(["gobletSquat"]);
  });

  it("a planned workout's changes, on a base changed elsewhere: it says so, and Reload brings the new one", async () => {
    const stored = (title: string): WorkoutDoc => ({ ...(draft(into(1, "gobletSquat")) as WorkoutDoc), title, intent: { summary: title, goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "main", format: "straight", items: [suggestedItem(rec("gobletSquat"), "main")] }] });
    const calls = serve({ docs: [{ doc: stored("Thursday lift"), rev: 3 }, { doc: stored("Thursday lift, changed"), rev: 4 }], revise: [{ error: "stale_revision", status: 409 }], planned: [plannedRow("w1", "2026-10-15")] });
    mount("/studio/build/workout/w1");
    await until(() => !!document.querySelector<HTMLInputElement>(".stu-build-title") && document.querySelector<HTMLInputElement>(".stu-build-title")!.value === "Thursday lift", "the workout");
    const saveChanges = () => button("Save changes");
    expect(saveChanges()!.disabled).toBe(true);
    // A change: effort up one.
    await click([...document.querySelectorAll<HTMLInputElement>('.stu-seg input[type="radio"]')].find((r) => r.value === "develop"), "Develop");
    expect(saveChanges()!.disabled).toBe(false);
    await click(saveChanges(), "Save changes");
    await until(() => text().includes("This workout changed elsewhere."), "the stale line");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/workouts/w1/doc")!;
    expect((put.body as { baseRev: number }).baseRev).toBe(3);
    await click(button("Reload"), "Reload");
    await until(() => document.querySelector<HTMLInputElement>(".stu-build-title")!.value === "Thursday lift, changed", "the new version");
    expect(text()).not.toContain("This workout changed elsewhere.");
    expect(saveChanges()!.disabled).toBe(true);
  });
});

// ── Reordering ─────────────────────────────────────────────────────────────

describe("reordering", () => {
  it("is by buttons: Move up in the item's sheet, across parts at an edge — and Undo takes it back", async () => {
    await draftStore().save(draft(into(0, "catCow"), into(1, "gobletSquat"), into(1, "deadlift")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 2, "the workout");
    expect(partsShown()[1]).toEqual(["Main", ["Goblet squat", "Deadlift"]]);

    await click([...document.querySelectorAll(".stu-item")].find((b) => b.textContent?.includes("Deadlift")), "the Deadlift row");
    const sheet = () => dialog("Deadlift")!;
    await click(button("Move up", sheet()), "Move up");
    expect(partsShown()[1]).toEqual(["Main", ["Deadlift", "Goblet squat"]]);
    // Again: past the part's top edge, into the warm-up's end. The sheet follows the move.
    await click(button("Move up", sheet()), "Move up");
    expect(partsShown()[0]).toEqual(["Warm-up", ["Cat-cow", "Deadlift"]]);
    expect(partsShown()[1]).toEqual(["Main", ["Goblet squat"]]);
    await until(() => true, "");
    expect(ids(await saved(), "warmup")).toEqual(["catCow", "deadlift"]);

    await click(button("Done", sheet()), "Done");
    await click(button("Undo"), "Undo");
    expect(partsShown()[1]).toEqual(["Main", ["Deadlift", "Goblet squat"]]);
    await click(button("Redo"), "Redo");
    expect(partsShown()[0]).toEqual(["Warm-up", ["Cat-cow", "Deadlift"]]);
  });
});

// ── Start now ──────────────────────────────────────────────────────────────

describe("Start now", () => {
  it("makes the workout for today, builds it, starts it, and opens the player — the builder now on that workout", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve();
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    expect(where).toBe("/session/w-new");
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
    expect((create.body as { date: string }).date).toBe(TODAY);
    expect(ids((create.body as { doc: WorkoutDoc }).doc, "main")).toEqual(["gobletSquat"]);
    const order = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(order).toEqual(["/api/workouts", "/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
    expect(calls.find((c) => c.path.endsWith("/start"))!.body).toEqual({ buildId: "b1" });
    // Made: the device's draft is that workout now, not one still being built.
    expect(await saved()).toBeNull();
  });

  it("asks today's check first, in place, when the workout waits on it — a Studio-only athlete has no check chip — then goes on", async () => {
    await draftStore().save(draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress")));
    const calls = serve();
    // TMJ on, and no programme: Today carries no condition (no check chip), so the reading is unknown here.
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto(null, false) });
    await until(() => !!startButton(), "Start now");
    // Not a dead end: Start is on, and the note offers the check.
    expect(startButton()!.disabled).toBe(false);
    expect(text()).toContain("Half-kneeling one-arm press needs today's Jaw / head check answered first.");
    expect(button("Jaw check")).not.toBeNull();

    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workouts")).toBe(false);
    await click(buttons(dialog("Jaw / head")!).find((b) => b.textContent === "0"), "0");
    await click(button("Save", dialog("Jaw / head")!), "Save");
    await until(() => text().includes("the player"), "the player");
    expect(calls.find((c) => c.path === "/api/conditions/checks")!.body).toEqual({ profileId: "tmj", value: 0, feelingOff: false });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/conditions/checks",
      "/api/workouts",
      "/api/sessions/w-new/build",
      "/api/sessions/w-new/start",
    ]);
  });

  it("a build the day's reading changed is shown before it locks, and starts only when the athlete says so", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const swaps = [{ path: "parts[0].items[0]", from: "gobletSquat", to: "boxSquat", reason: "Not with today's check." }];
    const calls = serve({ start: [{ status: 409, body: { error: "stale", session: built("w-new", { buildId: "b2", swaps }) } }, built("w-new", { buildId: "b2" })] });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("Goblet squat → Box squat to bench. Not with today's check."), "the swap");
    expect(where).toBe("/studio/build/workout/w-new");
    await click(button("Start with these changes"), "Start with these changes");
    await until(() => text().includes("the player"), "the player");
    expect(calls.filter((c) => c.path.endsWith("/start")).map((c) => c.body)).toEqual([{ buildId: "b1" }, { buildId: "b2" }]);
  });

  it("started, but this device can't keep it: it says so first, and Continue goes on to the player", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve();
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    const db = await offlineDb();
    // The storage is full: what Start leaves on the device can't be written.
    const put = vi.spyOn(db, "put").mockRejectedValue(new DOMException("The quota has been exceeded.", "QuotaExceededError"));
    try {
      await click(startButton(), "Start now");
      await until(() => text().includes("isn't being kept on this device"), "the warning");
      expect(text()).not.toContain("the player");
      expect(calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
      await click(button("Continue"), "Continue");
      await until(() => text().includes("the player"), "the player");
    } finally {
      put.mockRestore();
    }
  });

  it("a day that refuses the build says why, and nothing starts", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve({ build: built("w-new", { blocked: [{ path: "parts[0].items[0].libraryId", code: "condition_gate", message: "Goblet squat isn't allowed today.", severity: "error" }] }) });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("Goblet squat isn't allowed today."), "the refusal");
    expect(calls.some((c) => c.path.endsWith("/start"))).toBe(false);
    expect(text()).not.toContain("the player");
  });
});

// ── Schedule ───────────────────────────────────────────────────────────────

describe("Schedule", () => {
  it("Later today: the next sensible slot, said; the workout is made for it, and the builder is on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      const calls = serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      // A Sunday at 2:20 PM, the usual morning gone: the next whole hour and one more.
      expect(sheet.querySelector<HTMLInputElement>('input[aria-label="Time today"]')!.value).toBe("16:00");
      expect(sheet.textContent).toContain("Today at 4 PM");
      await click(buttons(sheet).find((b) => b.textContent === "Schedule"), "Schedule");
      await until(() => text().includes("Scheduled for today at 4 PM."), "the line");
      const create = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
      expect(create.body).toMatchObject({ date: TODAY, time: "16:00" });
      expect(where).toBe("/studio/build/workout/w-new");
      expect(await saved()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
