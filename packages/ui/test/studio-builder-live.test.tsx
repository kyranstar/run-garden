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
import type { DocIssueDto, SessionDto, TemplateDto, WorkoutDto } from "@rg/api-client";
import { DEFAULT_SCHEDULING_PREFERENCES, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, type DraftDoc, type EditAction } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { draftStore } from "../src/studio-drafts.js";
import { offlineDb } from "../src/offline/idb.js";
import { loadExtras } from "../src/player/stored.js";
import { libraryDto, placesDto, primedClient, profileDto, todayDto, twoPlacesDto, TODAY, type Primed } from "./studio-fixtures.js";

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
  /** What `POST /api/workouts` warns of (what the server could see that the page could not). */
  warnings?: DocIssueDto[];
  /** GET /api/templates, in turn (the last repeats). */
  templates?: TemplateDto[][];
  /** PUT /api/templates/:id, in turn (the last repeats): `stale` (409 stale_revision), else OK. */
  tplPut?: Array<"stale" | "ok">;
  /** PUT /api/workouts/:id/doc says the watch holds an older copy. */
  watchHasOlder?: boolean;
  /** POST /api/workouts with `startNow` answers 409 `started_today` with this row (I3). */
  startedToday?: { id: string; contentState: "outline" | "built" | "started" };
}

function serve(s: Server = {}): Call[] {
  const calls: Call[] = [];
  let docRead = 0;
  let revised = 0;
  let started = 0;
  let tplRead = 0;
  let tplPut = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: s.planned ?? [] });
      if (method === "GET" && path === "/api/templates") return json({ templates: s.templates?.[Math.min(tplRead++, s.templates.length - 1)] ?? [] });
      const tpl = /^\/api\/templates\/([^/]+)$/.exec(path);
      if (tpl && method === "PUT") {
        if (s.tplPut?.[Math.min(tplPut++, s.tplPut.length - 1)] === "stale") return json({ error: "stale_revision", updatedAt: "2026-10-11T09:00:00Z" }, 409);
        return json({ template: { id: tpl[1], name: "Thursday lift", doc: body.doc, pinned: false, uses: 0, lastUsedAt: null, createdAt: "", updatedAt: "2026-10-12T10:00:00Z", minutes: 20, discipline: "strength" }, warnings: [] });
      }
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
        return json({ workout: { id: doc[1], date: TODAY, time: "18:00", title: body.doc.title, docRev: body.baseRev + 1 }, rev: body.baseRev + 1, watchHasOlder: s.watchHasOlder ?? false, warnings: [] });
      }
      if (method === "POST" && path === "/api/workouts" && body.startNow && s.startedToday) {
        const w = s.startedToday;
        return json(
          { error: "started_today", workout: { id: w.id, date: TODAY, time: "09:00", title: body.doc.title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: w.contentState, completionState: "scheduled", docRev: 1, minutes: 8 } },
          409,
        );
      }
      if (method === "POST" && path === "/api/workouts") {
        return json(
          {
            workout: { id: "w-new", date: body.date, time: body.time ?? "18:00", title: body.doc.title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: 20 },
            warnings: s.warnings ?? [],
          },
          201,
        );
      }
      if (method === "POST" && path === "/api/conditions/checks") return json({ check: { ...body, date: TODAY } });
      // The session under way that Start now's 409 names: started (on this device or another), as the server reads it.
      if (method === "GET" && s.startedToday?.contentState === "started" && path === `/api/sessions/${s.startedToday.id}`) {
        return json({ ...built(s.startedToday.id), contentState: "started", locked: true });
      }
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

function mount(path: string, primed: Primed = {}, prefs: typeof DEFAULT_SCHEDULING_PREFERENCES = DEFAULT_SCHEDULING_PREFERENCES) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // Today is the fixtures' day (no programme, so no condition chips) unless a case says otherwise.
  const qc = primedClient({ places: placesDto(HOME_GEAR), today: todayDto(null, false), ...primed });
  qc.setQueryData(["settings"], { prefs });
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
/** A planned workout's stored document: one lift in its main part. */
const storedDoc = (title: string): WorkoutDoc => ({
  version: 1,
  title,
  intent: { summary: title, goals: [], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [suggestedItem(rec("gobletSquat"), "main")] }],
  source: { kind: "studio" },
});
const titleField = () => document.querySelector<HTMLInputElement>(".stu-build-title")!;
const effort = (value: string) => [...document.querySelectorAll<HTMLInputElement>('.stu-seg input[type="radio"]')].find((r) => r.value === value);
/** Focus a control as a keyboard would (jsdom does not focus what it clicks), then press it. */
async function press(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  act(() => (el as HTMLElement).focus());
  await click(el, what);
}
/** Type into a field that commits when left: focus, the new text, then leave it. */
async function retype(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => input.focus());
  await act(async () => setValue(input, value));
  act(() => input.blur());
  await settle();
}
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
    // The picker's gone: focus is on the move it added, not back on Add a move or the page.
    expect(document.activeElement).toBe(document.querySelector('[data-at="1-0"]'));

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
  it("keeps Start off — its reason Start's own description — and Fix swaps in the alternate and Start comes on", async () => {
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

describe("a template's changes (Task 9 fix round 1)", () => {
  const tpl = (title: string, updatedAt: string): TemplateDto => ({
    id: "t1",
    name: "Thursday lift",
    doc: storedDoc(title),
    pinned: false,
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt,
    minutes: 20,
    discipline: "strength",
  });
  const saveTemplate = async () => {
    await click(button("Save"), "Save");
    await click([...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent === "Save template"), "Save template");
  };

  it("are saved on the version opened; changed elsewhere since, it says so, and Reload brings the new one", async () => {
    const calls = serve({
      templates: [[tpl("Thursday lift", "2026-10-01T00:00:00Z")], [tpl("Thursday lift, changed", "2026-10-11T09:00:00Z")]],
      tplPut: ["stale", "ok"],
    });
    mount("/studio/build/template/t1");
    await until(() => document.querySelector<HTMLInputElement>(".stu-build-title")?.value === "Thursday lift", "the template");
    await click(effort("develop"), "Develop");
    await saveTemplate();
    await until(() => text().includes("This template changed elsewhere."), "the stale line");
    const puts = () => calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1").map((c) => c.body as { baseUpdatedAt?: string });
    expect(puts().map((b) => b.baseUpdatedAt)).toEqual(["2026-10-01T00:00:00Z"]);
    expect(text()).not.toContain("Saved.");

    await click(button("Reload"), "Reload");
    await until(() => titleField().value === "Thursday lift, changed", "the new version");
    expect(text()).not.toContain("This template changed elsewhere.");
    // The next save is on the version Reload brought.
    await click(effort("develop"), "Develop");
    await saveTemplate();
    await until(() => text().includes("Saved."), "Saved.");
    expect(puts().map((b) => b.baseUpdatedAt)).toEqual(["2026-10-01T00:00:00Z", "2026-10-11T09:00:00Z"]);
    // And the one after it, on the version that save made — never refused by the builder's own last save.
    await click(effort("peak"), "Peak");
    await saveTemplate();
    await until(() => puts().length === 3, "the third save");
    expect(puts()[2]!.baseUpdatedAt).toBe("2026-10-12T10:00:00Z");
  });

  it("only renamed or pinned elsewhere since it opened: saved again on the version there now, nothing to reload (fix round 2)", async () => {
    const renamed = { ...tpl("Thursday lift", "2026-10-11T09:00:00Z"), name: "Thursday lift, renamed", pinned: true };
    const calls = serve({ templates: [[tpl("Thursday lift", "2026-10-01T00:00:00Z")], [renamed]], tplPut: ["stale", "ok"] });
    mount("/studio/build/template/t1");
    await until(() => document.querySelector<HTMLInputElement>(".stu-build-title")?.value === "Thursday lift", "the template");
    await click(effort("develop"), "Develop");
    await saveTemplate();
    await until(() => text().includes("Saved."), "Saved.");
    expect(text()).not.toContain("This template changed elsewhere.");
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1").map((c) => c.body as Record<string, unknown>);
    expect(puts.map((b) => b.baseUpdatedAt)).toEqual(["2026-10-01T00:00:00Z", "2026-10-11T09:00:00Z"]);
    // Only the document is sent: the name and pin made elsewhere stay.
    expect(puts.every((b) => !("name" in b) && !("pinned" in b))).toBe(true);
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
      // TODAY (2026-10-11) is a Sunday; at 2:20 PM the weekend's usual 8 AM is gone: the next whole hour and one more.
      expect(sheet.querySelector<HTMLInputElement>('input[aria-label="Time today"]')!.value).toBe("16:00");
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

  it("Later today needs the workout to finish by the athlete's latest evening finish: too long for the slot, it isn't offered", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 18, 10) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      // The next slot is 8 PM; a finish at 8:01 leaves no room for a workout of a few minutes.
      mount("/studio/build/new", {}, { ...DEFAULT_SCHEDULING_PREFERENCES, latestEveningFinish: "20:01" });
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      expect(sheet.textContent).not.toContain("Later today");
      expect(sheet.querySelector<HTMLInputElement>('input[type="radio"][value="day"]')!.checked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a time today that has passed is refused in plain words, and Schedule stays off", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      await type(sheet.querySelector('input[aria-label="Time today"]'), "13:00", "the time");
      expect(sheet.textContent).toContain("That time has passed.");
      expect(buttons(sheet).find((b) => b.textContent === "Schedule")!.disabled).toBe(true);
      await type(sheet.querySelector('input[aria-label="Time today"]'), "15:00", "the time");
      expect(sheet.textContent).not.toContain("That time has passed.");
      expect(buttons(sheet).find((b) => b.textContent === "Schedule")!.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Fix round 1: the footer says one thing at a time ───────────────────────

describe("the footer", () => {
  it("a base changed elsewhere during Start says so once — the stale line, no second refusal — and Reload clears it", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }, { doc: storedDoc("Thursday lift, changed"), rev: 4 }], revise: [{ error: "stale_revision", status: 409 }], planned: [plannedRow("w1")] });
    mount("/studio/build/workout/w1");
    await until(() => titleField()?.value === "Thursday lift" && !!startButton(), "the workout");
    await click(effort("develop"), "Develop");
    await click(startButton(), "Start now");
    await until(() => text().includes("This workout changed elsewhere."), "the stale line");
    expect(document.querySelector(".stu-build-error")).toBeNull();
    await click(button("Reload"), "Reload");
    await until(() => titleField().value === "Thursday lift, changed", "the new version");
    expect(text()).not.toContain("This workout changed elsewhere.");
    expect(document.querySelector(".stu-build-error")).toBeNull();
  });

  it("an edit moves on from a refusal", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve({ build: built("w-new", { blocked: [{ path: "parts[0].items[0].libraryId", code: "condition_gate", message: "Goblet squat isn't allowed today.", severity: "error" }] }) });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("Goblet squat isn't allowed today."), "the refusal");
    await click(effort("develop"), "Develop");
    expect(text()).not.toContain("Goblet squat isn't allowed today.");
  });

  it("Undo after a removal is offered only until the next edit", async () => {
    await draftStore().save(draft(into(0, "catCow"), into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 1, "the workout");
    await click([...document.querySelectorAll(".stu-item")].find((b) => b.textContent?.includes("Goblet squat")), "the row");
    await click(button("Remove", dialog("Goblet squat")!), "Remove");
    expect(text()).toContain("Removed Goblet squat.");
    expect(buttons(document.querySelector(".stu-build-status")!).map((b) => b.textContent)).toEqual(["Undo"]);
    await click(effort("develop"), "Develop");
    expect(text()).not.toContain("Removed Goblet squat.");
    expect(document.querySelector(".stu-build-status")!.textContent).toBe("");
  });

  it("the server's own warnings are shown with the build before it locks: Start anyway, or Not now — it stays on today's plan", async () => {
    const warning: DocIssueDto = { path: "parts[1].items[0].libraryId", code: "progression_jump", message: "A note only the server could see.", severity: "warning" };
    await draftStore().save(draft(into(1, "gobletSquat")));
    let calls = serve({ warnings: [warning] });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("A note only the server could see."), "the warning");
    expect(calls.some((c) => c.path.endsWith("/start"))).toBe(false);
    expect(button("Start with these changes")).toBeNull();
    await click(button("Not now"), "Not now");
    expect(text()).toContain("It stays on today's plan.");
    expect(calls.some((c) => c.path.endsWith("/start"))).toBe(false);

    // Again, and this time Start anyway.
    act(() => root?.unmount());
    host?.remove();
    await draftStore().save(draft(into(1, "gobletSquat")));
    calls = serve({ warnings: [warning] });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!button("Start anyway"), "Start anyway");
    await click(button("Start anyway"), "Start anyway");
    await until(() => text().includes("the player"), "the player");
  });
});

// ── Fix round 1: focus never falls to the page ─────────────────────────────

describe("focus", () => {
  const atRow = (p: number, i: number) => document.querySelector(`[data-at="${p}-${i}"]`);

  it("after a suggestion's ＋, on the move's new row", async () => {
    serve();
    mount("/studio/build/new");
    await until(() => partsShown().length === 3, "the parts");
    const warmup = document.querySelectorAll<HTMLElement>(".stu-part:not(.stu-part--ghost)")[0]!;
    await press(warmup.querySelector(".stu-sug-add"), "a warm-up ＋");
    expect(document.activeElement).toBe(atRow(0, 0));
  });

  it("after a Fix in the summary, on the item it fixed; after a Fix in the item's sheet, still in the sheet", async () => {
    const d = () => draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    await draftStore().save(d());
    serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) });
    await until(() => !!button("Swap in Floor press"), "the Fix");
    await press(button("Swap in Floor press"), "Fix");
    expect(document.activeElement).toBe(atRow(1, 0));
    expect(atRow(1, 0)!.textContent).toContain("Floor press");

    act(() => root?.unmount());
    host?.remove();
    await draftStore().save(d());
    serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) });
    await until(() => !!atRow(1, 0), "the row");
    await click(atRow(1, 0), "the row");
    const sheet = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')][0]!;
    await press(button("Swap in Floor press", sheet()), "Fix in the sheet");
    expect(sheet().querySelector("h2")!.textContent).toBe("Floor press");
    expect(document.activeElement).not.toBe(document.body);
    expect(sheet().contains(document.activeElement)).toBe(true);
  });

  it("a part moved down to the very end hands focus to Move up", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown().length === 3, "the parts");
    await click(button("Main: options"), "Main's ⋯");
    const sheet = dialog("Main")!;
    await press(button("Move down", sheet), "Move down");
    expect(partsShown().map(([n]) => n)).toEqual(["Warm-up", "Cool-down", "Main"]);
    expect(button("Move down", sheet)!.disabled).toBe(true);
    expect(document.activeElement).toBe(button("Move up", sheet));
  });

  it("Move up to the very top hands focus to Move down", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => !!atRow(1, 0), "the row");
    await click(atRow(1, 0), "the row");
    const sheet = dialog("Goblet squat")!;
    await press(button("Move up", sheet), "Move up");
    // Into the empty warm-up: now the first move of the first part, with nowhere further up.
    expect(partsShown()[0]).toEqual(["Warm-up", ["Goblet squat"]]);
    expect(button("Move up", sheet)!.disabled).toBe(true);
    expect(document.activeElement).toBe(button("Move down", sheet));
  });

  it("a Save menu choice that opens a sheet returns focus to Save when it closes", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 1, "the workout");
    const save = button(/^Save/)!;
    await press(save, "Save ▾");
    await press(document.querySelector('[role="menuitem"]'), "Save as template…");
    expect(dialog("Save as template")!.contains(document.activeElement)).toBe(true);
    await click(button("Close", dialog("Save as template")!), "Close");
    expect(document.activeElement).toBe(save);
  });
});

// ── Fix round 1: the rest ──────────────────────────────────────────────────

describe("a planned workout that can't change", () => {
  it("opens read-only and says why: no Start, no saving changes, no adding, no undo", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }], planned: [{ ...plannedRow("w1"), completionState: "completed" } as WorkoutDto] });
    mount("/studio/build/workout/w1");
    await until(() => text().includes("This workout is done, so it can't be changed."), "the line");
    expect(startButton()).toBeNull();
    expect(button("Save changes")).toBeNull();
    expect(button("Add a move")).toBeNull();
    expect(button("Undo")).toBeNull();
    expect(document.querySelector("button.stu-item")).toBeNull();
    expect(document.querySelector(".stu-item")!.textContent).toContain("Goblet squat");
    expect(titleField().readOnly).toBe(true);
  });
});

describe("suggestions on one line", () => {
  it("once a part has a move, its ＋ opens the part's Add a move, the suggestions first", async () => {
    await draftStore().save(draft(into(0, "catCow")));
    serve();
    mount("/studio/build/new");
    await until(() => !!button("Add a move to Warm-up"), "the line");
    // One control per action: the line's ＋ is the part's Add a move — there is no second.
    expect(button("Add a move", document.querySelector('[data-part="0"]')!)).toBeNull();
    await click(button("Add a move to Warm-up"), "＋");
    await until(() => !!dialog("Add to Warm-up"), "the picker");
    expect(dialog("Add to Warm-up")!.querySelector("h3")!.textContent).toBe("Suggested");
  });

  it("a move removed from a part that still has others hands focus to the part's ＋", async () => {
    await draftStore().save(draft(into(0, "catCow"), into(0, "ankleRocks")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[0]?.[1]?.length === 2, "the warm-up");
    await click(document.querySelector('[data-at="0-1"]'), "the second row");
    await press(button("Remove", [...document.querySelectorAll<HTMLElement>('[role="dialog"]')][0]!), "Remove");
    await until(() => partsShown()[0]?.[1]?.length === 1, "the removal");
    expect(document.activeElement).toBe(button("Add a move to Warm-up"));
  });
});

describe("a title", () => {
  it("renamed while the why still follows it is one edit: one Undo takes back both", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => titleField()?.value === "Hips & posture", "the title");
    await retype(titleField(), "Legs");
    expect(titleField().value).toBe("Legs");
    expect(document.querySelector<HTMLTextAreaElement>(".stu-build-why-field")!.value).toBe("");
    await click(button("Undo"), "Undo");
    expect(titleField().value).toBe("Hips & posture");
    expect(document.querySelector<HTMLTextAreaElement>(".stu-build-why-field")!.value).toBe("");
    expect(button("Undo")!.disabled).toBe(true);
  });
});

// ── Fix round 2 ────────────────────────────────────────────────────────────

/** The summary's notes in view: none inside a folded part of the card. */
const listedNotes = () => [...document.querySelectorAll<HTMLElement>(".stu-sum .stu-note")].filter((n) => !n.closest("[hidden]"));

/** A stored workout today's Jaw / head check at 3 rules a move out of: a half-kneeling press, a floor press its alternate. */
const pressDoc = (title: string): WorkoutDoc => ({
  ...storedDoc(title),
  intent: { summary: title, goals: [], focus: [], effort: "develop" },
  parts: [{ purpose: "main", format: "straight", items: [{ ...suggestedItem(rec("halfKneelingPress"), "main"), alternates: [{ libraryId: "floorPress" }] }] }],
});

describe("a planned workout that can't change, judged by today", () => {
  it("under way today, and today's check rules a move out: the note says so, but offers no Fix, and nothing waits to start", async () => {
    serve({ docs: [{ doc: pressDoc("Thursday press"), rev: 2 }], planned: [{ ...plannedRow("w1"), contentState: "started" } as WorkoutDto] });
    mount("/studio/build/workout/w1", { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) });
    await until(() => text().includes("This workout is under way, so it can't be changed."), "the line");
    await until(() => text().includes("Half-kneeling one-arm press isn't allowed with today's Jaw / head check at 3."), "the note");
    expect(button("Swap in Floor press")).toBeNull();
    expect(document.querySelector(".stu-note-actions")).toBeNull();
    expect(text()).not.toContain("Fix the note above to start.");
    expect(startButton()).toBeNull();
    expect(document.querySelector(".stu-build-foot [hidden]")).toBeNull();
    // Nothing here can be fixed, so nothing says "to fix": the count is of notes — the rule-out, and the Develop day's
    // cost ("A Develop or Peak day needs a calm jaw…") — in the neutral style, and the rule-out is a note to a screen reader too.
    const count = document.querySelector(".stu-sum-count")!;
    expect(count.textContent).toBe("2 notes");
    expect(count.classList.contains("stu-sum-count--error")).toBe(false);
    expect(document.querySelector('.stu-sum [role="status"]')!.textContent).toBe("2 notes");
    expect(document.querySelector(".stu-note .stu-note-text .visually-hidden")!.textContent).toBe("Note: ");
    expect(text()).not.toContain("to fix");
    expect(text()).not.toContain("To fix");
    // …and no red triangle anywhere: each note, and the move it is about, wears the neutral note marker.
    expect(document.querySelector(".stu-note--error")).toBeNull();
    expect([...document.querySelectorAll(".stu-note")].every((n) => n.classList.contains("stu-note--note"))).toBe(true);
    const flag = document.querySelector(".stu-item-flag")!;
    expect(flag.classList.contains("stu-item-flag--note")).toBe(true);
    expect(flag.textContent).toBe(", has a note");
    expect(text()).not.toContain("needs a fix");
    // The count is of the notes listed with it: none folded away out of sight, none said twice.
    expect(listedNotes().length).toBe(2);
    expect(document.querySelectorAll(".stu-sum .stu-note").length).toBe(2);
  });

  it("…and today's check unanswered: the note says so, with no check to answer from here", async () => {
    serve({ docs: [{ doc: pressDoc("Thursday press"), rev: 2 }], planned: [{ ...plannedRow("w1"), contentState: "started" } as WorkoutDto] });
    mount("/studio/build/workout/w1", { library: libraryDto({ tmj: true }), today: todayDto(null, false) });
    await until(() => text().includes("Half-kneeling one-arm press needs today's Jaw / head check answered first."), "the note");
    expect(button("Jaw check")).toBeNull();
    expect(document.querySelector(".stu-note-actions")).toBeNull();
    expect(text()).not.toContain("to start.");
  });

  it("its day passed: today's reading says nothing of it — only the static rules speak, and the count is what is listed", async () => {
    serve({ docs: [{ doc: pressDoc("Thursday press"), rev: 2 }], planned: [plannedRow("w1", "2026-10-08")] });
    // Today's jaw reading is high, and this place has no kettlebell or dumbbells.
    mount("/studio/build/workout/w1", { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }), places: placesDto(["mat"]) });
    await until(() => text().includes("This workout's day has passed, so it can't be changed."), "the line");
    await until(() => text().includes("Half-kneeling one-arm press needs kettlebell or dumbbells, which this place doesn't have."), "the gear note");
    expect(text()).not.toContain("today's Jaw / head check");
    expect(text()).not.toContain("calm jaw");
    // The press and its alternate both want gear this place lacks: two notes, both listed, and the count says two.
    expect(listedNotes().map((n) => n.querySelector(".stu-note-text")!.textContent)).toEqual([
      "Note: Half-kneeling one-arm press needs kettlebell or dumbbells, which this place doesn't have.",
      "Note: Floor press needs kettlebell or dumbbells, which this place doesn't have.",
    ]);
    expect(document.querySelector(".stu-sum-count")!.textContent).toBe("2 notes");
    expect(document.querySelectorAll(".stu-sum .stu-note").length).toBe(2);
  });
});

describe("a planned workout on another day, with something to fix", () => {
  it("offers the Fix, but says nothing of starting: it starts on its own day", async () => {
    const lone: WorkoutDoc = { ...storedDoc("Thursday lift"), parts: [{ ...storedDoc("Thursday lift").parts[0]!, format: "superset" }] };
    serve({ docs: [{ doc: lone, rev: 2 }], planned: [plannedRow("w1", "2026-10-15")] });
    mount("/studio/build/workout/w1");
    await until(() => text().includes("A superset pairs exactly two moves; this one has 1."), "the note");
    expect(document.querySelector(".stu-note-fix")).not.toBeNull();
    expect(startButton()).toBeNull();
    expect(text()).not.toContain("Fix the note above to start.");
    expect(document.querySelector(".stu-build-foot [hidden]")).toBeNull();
  });
});

describe("the footer, after an edit", () => {
  it("moves on from what it said of the last state: Saved. goes with the next edit", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }], planned: [plannedRow("w1", "2026-10-15")] });
    mount("/studio/build/workout/w1");
    await until(() => titleField()?.value === "Thursday lift", "the workout");
    await click(effort("develop"), "Develop");
    await click(button("Save changes"), "Save changes");
    await until(() => text().includes("Saved."), "Saved.");
    await click(effort("maintain"), "Maintain");
    expect(text()).not.toContain("Saved.");
    expect(document.querySelector(".stu-build-status")!.textContent).toBe("");
  });

  it("…and a template saved: its line goes with the next edit too", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 1, "the workout");
    await click(button(/^Save/), "Save ▾");
    await click(document.querySelector('[role="menuitem"]'), "Save as template…");
    // Its pin row is the Studio's shared choice row (the Add sheet's too), named for neither.
    expect(dialog("Save as template")!.querySelector("label.stu-choice input[type=checkbox]")).not.toBeNull();
    expect(dialog("Save as template")!.querySelector(".stu-add-choice")).toBeNull();
    await click(button("Save", dialog("Save as template")!), "Save");
    await until(() => text().includes("as a template."), "the line");
    await click(effort("develop"), "Develop");
    expect(text()).not.toContain("as a template.");
  });

  it("…but the watch's offer stays until the new version is sent or the workout is saved again", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }], planned: [plannedRow("w1", "2026-10-15")], watchHasOlder: true });
    mount("/studio/build/workout/w1");
    await until(() => titleField()?.value === "Thursday lift", "the workout");
    await click(effort("develop"), "Develop");
    await click(button("Save changes"), "Save changes");
    await until(() => !!button("Send the new version"), "the offer");
    expect(document.querySelector(".stu-build-status")!.textContent).toContain("Saved. Your watch has the older version.");
    // An edit: "Saved." is no longer true and goes; the watch still holds the older copy, and the offer stays.
    await click(effort("maintain"), "Maintain");
    expect(text()).not.toContain("Saved.");
    expect(document.querySelector(".stu-build-status-text")!.textContent).toBe("Your watch has the older version.");
    expect(button("Send the new version")).not.toBeNull();
    // Saved again: the save's own line, and its own word on the watch.
    await click(effort("peak"), "Peak");
    await click(button("Save changes"), "Save changes");
    await until(() => text().includes("Saved."), "Saved. again");
    expect(document.querySelector(".stu-build-status-text")!.textContent).toBe("Saved. Your watch has the older version.");
  });
});

describe("the activation prompt's ✕", () => {
  it("hands focus to the next part's options — a control a keyboard user can see — not the page or a hidden heading", async () => {
    await draftStore().save(draft(into(1, "deadlift")));
    serve();
    mount("/studio/build/new");
    await until(() => !!document.querySelector(".stu-part--ghost"), "the prompt");
    await press(button("No activation part"), "✕");
    expect(document.querySelector(".stu-part--ghost")).toBeNull();
    expect(document.activeElement).toBe(button("Main: options"));
    expect(document.querySelector("h1")!.hasAttribute("tabindex")).toBe(false);
  });
});

describe("Schedule, another day set to today", () => {
  it("with no time, once the athlete's usual time today has passed: it asks for a time later today, and Schedule waits", async () => {
    // TODAY (2026-10-11) is a Sunday: the usual time is the weekend's 8 AM, gone by 2:20 PM.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      const scheduleBtn = () => buttons(sheet).find((b) => b.textContent === "Schedule")!;
      await type(sheet.querySelector('input[aria-label="Day"]'), TODAY, "the day");
      expect(sheet.textContent).toContain("Your usual time today has passed. Pick a time later today.");
      expect(scheduleBtn().disabled).toBe(true);
      await type(sheet.querySelector('input[aria-label="Time (optional)"]'), "17:00", "the time");
      expect(sheet.textContent).not.toContain("Your usual time today has passed.");
      expect(scheduleBtn().disabled).toBe(false);
      // Another day, no time: the usual time is that day's, and nothing is asked.
      await type(sheet.querySelector('input[aria-label="Time (optional)"]'), "", "no time");
      await type(sheet.querySelector('input[aria-label="Day"]'), "2026-10-13", "the day");
      expect(sheet.textContent).not.toContain("Your usual time today has passed.");
      expect(scheduleBtn().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("its lines are status regions in the page from the start — hidden while empty — so the first thing said is heard", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      const statuses = () => [...sheet.querySelectorAll<HTMLElement>('[role="status"]')];
      // Nothing to say yet: both regions are there, empty and visually hidden.
      expect(statuses().length).toBe(2);
      for (const s of statuses()) {
        expect(s.textContent).toBe("");
        expect(s.classList.contains("visually-hidden")).toBe(true);
      }
      const [timeLine, dayLine] = statuses();
      await type(sheet.querySelector('input[aria-label="Time today"]'), "13:00", "the time");
      // The same node speaks: it was in the page all along.
      expect(statuses()[0]).toBe(timeLine);
      expect(timeLine!.textContent).toBe("That time has passed.");
      expect(timeLine!.classList.contains("visually-hidden")).toBe(false);
      expect(statuses()[1]).toBe(dayLine);
      expect(dayLine!.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("…and before the usual time, today with no time is fine", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 6, 30) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      const sheet = dialog("Schedule")!;
      await type(sheet.querySelector('input[aria-label="Day"]'), TODAY, "the day");
      expect(sheet.textContent).not.toContain("Your usual time today has passed.");
      expect(buttons(sheet).find((b) => b.textContent === "Schedule")!.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Stage 2 whole-branch review: a part's why, and activation offered once (M7, M8)", () => {
  it("a part's why asks plainly whatever the part is: 'Why this part'", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown().length === 3, "the parts");
    for (const name of ["Warm-up", "Main", "Cool-down"]) {
      await click(button(`${name}: options`), `${name}'s ⋯`);
      const sheet = dialog(name)!;
      expect(sheet.querySelector<HTMLTextAreaElement>("textarea")!.placeholder).toBe("Why this part");
      await click(button("Close", sheet), "Close");
    }
  });

  it("the activation prompt declined, Add a part offers Activation again", async () => {
    await draftStore().save(draft(into(1, "deadlift")));
    serve();
    mount("/studio/build/new");
    await until(() => !!document.querySelector(".stu-part--ghost"), "the prompt");
    const chips = () => [...document.querySelectorAll(".stu-add-part")].map((c) => c.textContent);
    expect(chips()).not.toContain("Activation");
    await click(button("No activation part"), "✕");
    expect(chips()).toContain("Activation");
  });
});

describe("Start now of what today already holds (Stage 2 whole-branch review I3)", () => {
  it("under way: says so, and Continue it goes back into that session — no second workout", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve({ startedToday: { id: "w-old", contentState: "started" } });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("You've started this today already."), "the offer");
    await click(button("Continue it"), "Continue it");
    await until(() => text().includes("the player"), "the player");
    expect(where).toBe("/session/w-old");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/workouts")).toHaveLength(1);
    // Under way already: nothing is built or started again — the player picks it up where it is.
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/api/sessions/w-old/"))).toBe(false);
  });

  it("under way on another device: Continue it leaves it on this one under the workout's title, as Start does — never \"Session\"", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve({ startedToday: { id: "w-old", contentState: "started" } });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!button("Continue it"), "Continue it");
    await click(button("Continue it"), "Continue it");
    await until(() => text().includes("the player"), "the player");
    // What the player names it by: the workout's title, kept with the session on this device.
    expect((await loadExtras(await offlineDb(), "w-old"))?.title).toBe("Hips & posture");
  });

  it("not started yet: Continue it builds and starts that one", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve({ startedToday: { id: "w-old", contentState: "built" } });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("Today already has this one."), "the offer");
    await click(button("Continue it"), "Continue it");
    await until(() => text().includes("the player"), "the player");
    expect(calls.some((c) => c.path === "/api/sessions/w-old/build")).toBe(true);
    expect(calls.some((c) => c.path === "/api/sessions/w-old/start")).toBe(true);
  });

  it("Not now leaves the builder as it was", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve({ startedToday: { id: "w-old", contentState: "started" } });
    mount("/studio/build/new");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!button("Not now"), "Not now");
    await click(button("Not now"), "Not now");
    expect(text()).not.toContain("You've started this today already.");
    expect(startButton()!.disabled).toBe(false);
  });
});

describe("focus after Schedule and Save changes (Stage 2 whole-branch review M4)", () => {
  it("scheduled: focus is on See it in Plan — the Schedule button is gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(draft(into(1, "gobletSquat")));
      serve();
      mount("/studio/build/new");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await press(button("Schedule…"), "Schedule…");
      await press(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
      await until(() => text().includes("Scheduled for today"), "the line");
      await settle(20);
      expect(document.activeElement?.textContent).toBe("See it in Plan");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a template saved: focus is on the line that says so", async () => {
    const t1: TemplateDto = { id: "t1", name: "Thursday lift", doc: storedDoc("Thursday lift"), pinned: false, uses: 0, lastUsedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", minutes: 20, discipline: "strength" };
    serve({ templates: [[t1]], tplPut: ["ok"] });
    mount("/studio/build/template/t1");
    await until(() => titleField()?.value === "Thursday lift", "the template");
    await click(effort("develop"), "Develop");
    await press(button("Save"), "Save");
    await press([...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent === "Save template"), "Save template");
    await until(() => text().includes("Saved."), "Saved.");
    await settle(20);
    expect(document.activeElement).toBe(document.querySelector(".stu-build-status-text"));
  });

  it("saved: focus is on the line that says so — Save changes greys out", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }], planned: [plannedRow("w1", "2026-10-15")] });
    mount("/studio/build/workout/w1");
    await until(() => titleField()?.value === "Thursday lift", "the workout");
    await click(effort("develop"), "Develop");
    await press(button("Save changes"), "Save changes");
    await until(() => text().includes("Saved."), "Saved.");
    await settle(20);
    expect(document.activeElement).toBe(document.querySelector(".stu-build-status-text"));
  });
});

describe("a hold to max in the item's sheet (CUJ R17)", () => {
  it("a timed hold offers To max, which writes the dose's max — and takes it off again; a move of reps doesn't", async () => {
    const hold = EXERCISES.find((e) => e.dose.type === "time" && e.laterality === "bilateral" && e.purposes.includes("strength"))!;
    await draftStore().save(draft(into(1, hold.id), into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new");
    await until(() => partsShown()[1]?.[1]?.length === 2, "the workout");
    await click(document.querySelector('[data-at="1-0"]'), "the hold's row");
    const sheet = dialog(hold.name)!;
    const toMax = () => buttons(sheet).find((b) => b.textContent?.trim() === "To max")!;
    expect(toMax().getAttribute("aria-pressed")).toBe("false");
    await click(toMax(), "To max");
    expect(toMax().getAttribute("aria-pressed")).toBe("true");
    await until(() => true, "");
    expect(((await saved())!.parts[1]!.items[0] as { dose: { max?: true } }).dose.max).toBe(true);
    await click(toMax(), "To max");
    expect(((await saved())!.parts[1]!.items[0] as { dose: { max?: true } }).dose.max).toBeUndefined();
    await click(button("Close", sheet), "Close");
    await click(document.querySelector('[data-at="1-1"]'), "the squat's row");
    expect(buttons(dialog("Goblet squat")!).some((b) => b.textContent?.trim() === "To max")).toBe(false);
  });
});

describe("Do it again (CUJ B2)", () => {
  it("opens a copy of a done workout as a new one: Start makes a new workout from it, the old one untouched", async () => {
    const calls = serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }], planned: [{ ...plannedRow("w1", "2026-10-08"), completionState: "completed" } as WorkoutDto] });
    mount("/studio/build/again/w1");
    await until(() => titleField()?.value === "Thursday lift", "the copy");
    // A new workout: changeable, Start on offer, no Save changes (nothing saved yet).
    expect(titleField().readOnly).toBe(false);
    expect(button("Save changes")).toBeNull();
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const made = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
    expect((made.body as { doc: WorkoutDoc }).doc.title).toBe("Thursday lift");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("its menu offers no Start over, which would clear the device's own draft", async () => {
    serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }] });
    mount("/studio/build/again/w1");
    await until(() => titleField()?.value === "Thursday lift", "the copy");
    await click(document.querySelector(".stu-save-btn"), "Save");
    expect(buttons(document.querySelector(".stu-save-menu")!).map((b) => b.textContent)).toEqual(["Save as template…"]);
  });

  it("scheduled, the copy is that new planned workout in the builder — a later Start never makes a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      const calls = serve({ docs: [{ doc: storedDoc("Thursday lift"), rev: 3 }] });
      mount("/studio/build/again/w1");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
      await until(() => text().includes("Scheduled for today at 4 PM."), "the line");
      expect(where).toBe("/studio/build/workout/w-new");
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/workouts")).toHaveLength(1);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a workout gone says so", async () => {
    serve();
    mount("/studio/build/again/w1");
    await until(() => text().includes("That workout is gone."), "the problem");
  });

  it("a workout with no document of its own says it can't be opened", async () => {
    serve({ docs: [{ doc: null as unknown as WorkoutDoc, rev: 1 }] });
    mount("/studio/build/again/w1");
    await until(() => text().includes("This workout can't be opened in the Studio."), "the problem");
  });
});

describe("Start offers today's before reading (CUJ R5)", () => {
  // A calm move nothing waits on: TMJ on, Today carrying its chip, today unanswered.
  const calm = () => draftStore().save(draft(into(1, "catCow")));

  it("unanswered, though nothing waits on it: offered first, in place — Save keeps it, then Start goes on", async () => {
    await calm();
    const calls = serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto(null) });
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    expect(sheet.textContent).toContain("Before you start, so this session has a before and an after.");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workouts")).toBe(false);
    await click(buttons(sheet).find((b) => b.textContent === "2"), "2");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("the player"), "the player");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/conditions/checks",
      "/api/workouts",
      "/api/sessions/w-new/build",
      "/api/sessions/w-new/start",
    ]);
    expect(calls.find((c) => c.path === "/api/conditions/checks")!.body).toEqual({ profileId: "tmj", value: 2, feelingOff: false });
  });

  it("one tap skips it: Start goes on without it, and nothing is recorded", async () => {
    await calm();
    const calls = serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto(null) });
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    await click(button("Skip", dialog("Jaw / head")!), "Skip");
    await until(() => text().includes("the player"), "the player");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/workouts", "/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
  });

  it("closed instead, nothing starts, and the next Start offers it again", async () => {
    await calm();
    const calls = serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto(null) });
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    await click(button("Close", dialog("Jaw / head")!), "Close");
    await settle(20);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(text()).not.toContain("the player");
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check again");
    await click(button("Skip", dialog("Jaw / head")!), "Skip");
    await until(() => text().includes("the player"), "the player");
  });

  it("a check today's errors wait on is asked, never offered: no Skip", async () => {
    await draftStore().save(draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress")));
    serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto(null) });
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    expect(button("Skip", dialog("Jaw / head")!)).toBeNull();
    expect(dialog("Jaw / head")!.textContent).not.toContain("Before you start");
  });

  it("answered today already, or no profile on: Start asks nothing", async () => {
    await calm();
    const calls = serve();
    mount("/studio/build/new", { library: libraryDto({ tmj: true }), today: todayDto({ value: 1 }) });
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    expect(calls.some((c) => c.path === "/api/conditions/checks")).toBe(false);
  });
});

describe("the place (CUJ R8)", () => {
  const chip = () => document.querySelector<HTMLButtonElement>(".stu-place-btn");
  const choices = () => [...document.querySelectorAll<HTMLElement>('.stu-place-menu [role="menuitemradio"]')];
  const choice = (name: string) => choices().find((c) => c.textContent === name);
  const sumLine = () => document.querySelector(".stu-sum-line")?.textContent ?? "";

  it("the chip says the default place; No equipment judges bodyweight only, suggests nothing that needs gear, and is kept with the workout", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    serve();
    mount("/studio/build/new", { places: twoPlacesDto(HOME_GEAR) });
    await until(() => !!chip(), "the chip");
    expect(chip()!.textContent).toContain("Home");
    expect(chip()!.getAttribute("aria-label")).toBe("Place: Home");
    expect(text()).not.toContain("which this place doesn't have");
    await click(chip(), "the chip");
    expect(choices().map((c) => c.textContent)).toEqual(["Home", "Gym", "No equipment"]);
    expect(choices().map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await click(choice("No equipment"), "No equipment");
    await until(() => text().includes("Goblet squat needs kettlebell or dumbbells, which this place doesn't have."), "the gear note");
    expect(chip()!.textContent).toContain("No equipment");
    expect(sumLine()).toContain("No equipment");
    const sugs = [...document.querySelectorAll(".stu-sug-name, .stu-sug .term")].map((n) => n.textContent?.trim());
    for (const name of sugs) {
      const r = EXERCISES.find((e) => e.name === name);
      if (r) expect(r.equipment.all.length + r.equipment.oneOf.length, name).toBe(0);
    }
    await settle(400);
    expect((await saved())?.setting?.placeId).toBe("none");
    // One edit: Undo is the default place again.
    await click(button("Undo"), "Undo");
    expect(chip()!.textContent).toContain("Home");
    expect(text()).not.toContain("which this place doesn't have");
  });

  it("a place picked is the one judged and the one sent: the gym's cable machine, and its id on Start", async () => {
    await draftStore().save(draft(into(1, "cableRow")));
    const calls = serve();
    mount("/studio/build/new", { places: twoPlacesDto(HOME_GEAR) });
    await until(() => text().includes("Seated cable row needs cable machine, which this place doesn't have."), "Home's gear note");
    await click(chip(), "the chip");
    await click(choice("Gym"), "Gym");
    await until(() => !text().includes("which this place doesn't have"), "the gym's gear");
    expect(sumLine()).toContain("Gym");
    await until(() => !!startButton() && !startButton()!.disabled, "Start now");
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const made = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
    expect((made.body as { doc: WorkoutDoc }).doc.setting?.placeId).toBe("p2");
  });

  it("a workout that can't change says its place, with nothing to choose", async () => {
    serve({ docs: [{ doc: { ...storedDoc("Thursday lift"), setting: { placeId: "p2" } }, rev: 2 }], planned: [{ ...plannedRow("w1"), contentState: "started" } as WorkoutDto] });
    mount("/studio/build/workout/w1", { places: twoPlacesDto(HOME_GEAR) });
    await until(() => text().includes("This workout is under way, so it can't be changed."), "the line");
    expect(chip()).toBeNull();
    expect(document.querySelector(".stu-build-place")!.textContent).toContain("Gym");
  });
});

describe("the athlete's focus areas (CUJ R7)", () => {
  it("are read with the Studio's other reads and kept for offline: GET /api/profile", async () => {
    await draftStore().save(draft(into(1, "gobletSquat")));
    const calls = serve();
    mount("/studio/build/new");
    await until(() => calls.some((c) => c.method === "GET" && c.path === "/api/profile"), "the profile read");
  });
});
