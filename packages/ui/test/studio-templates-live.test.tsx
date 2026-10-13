// @vitest-environment jsdom
/**
 * Stage 2 Task 7 — templates and instant quick starts, live (spec §9):
 *
 *  - a template opens the builder, and its way back is the list; Start goes straight on to the player (the builder's own
 *    Start, the template stamped and its uses bumped); Schedule… opens the builder's schedule sheet;
 *  - Rename and Pin change the row in place (a pin moves it first); Delete asks first, and only Delete deletes;
 *  - a quick start is two taps to a running session: its tile opens the builder pre-filled, with nothing asked of the
 *    network, and Start now starts it — the workout being built on this device left as it was.
 */
import "fake-indexeddb/auto";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, TemplateDto } from "@rg/api-client";
import { DEFAULT_SCHEDULING_PREFERENCES, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, toProposable } from "@rg/workout";
import { StudioRoute } from "../src/app.js";
import { draftStore } from "../src/studio-drafts.js";
import { quickStartFor } from "../src/screens/studio/templates-model.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { libraryDto, placesDto, primedClient, todayDto, TODAY, type Primed } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_GEAR = ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"];

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";
let whereState: unknown = null;

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
  whereState = loc.state;
  return null;
}

const goblet = (title = "Legs"): WorkoutDoc =>
  toProposable(
    edit(startEditing(newDoc("structured", { title, source: { kind: "studio" } })), {
      type: "addItem",
      part: 1,
      item: suggestedItem(EXERCISES.find((r) => r.id === "gobletSquat")!, "main"),
    }, EXERCISES).doc,
  )!;

function tpl(id: string, name: string, over: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id,
    name,
    doc: goblet(name),
    pinned: false,
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    minutes: 14,
    discipline: "strength",
    ...over,
  };
}

// ── The server ─────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function built(id: string): SessionDto {
  return {
    workoutId: id,
    date: TODAY,
    contentState: "built",
    locked: false,
    checks: {},
    profiles: [],
    choices: { modes: [], themes: [], locations: [] },
    view: { mode: "consistent", proposedMode: "consistent", modeReasons: [], theme: null, proposedTheme: null, themeReasons: [], minutes: 10, location: { id: "home", name: "Home", equipment: [], implements: {} }, block: null, newMove: null },
    build: {
      buildId: "b1",
      version: 1,
      date: TODAY,
      steps: [],
      items: [],
      exercises: {},
      alternatives: {},
      targets: {},
      newMove: null,
      params: { checks: {}, overrides: {}, swaps: {} },
      fromDoc: { rev: 1, swaps: [], blocked: [] },
    },
    watch: null,
  } as unknown as SessionDto;
}

/**
 * A templates server that keeps what it is told; `fail` makes the named writes fail with no connection (`start`: the
 * session's start); `library` is the athlete's library read, answered after `ms`.
 */
function serve(initial: TemplateDto[] = [], fail: { delete?: boolean; start?: boolean; reads?: number } = {}, library?: { dto: unknown; ms: number }): Call[] {
  const calls: Call[] = [];
  let templates = [...initial];
  let failedReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/templates") {
        if (failedReads < (fail.reads ?? 0)) {
          failedReads++;
          return json({ error: "internal" }, 500);
        }
        return json({ templates });
      }
      if (method === "POST" && path === "/api/templates") {
        const made = tpl("t-made", body.name, { doc: body.doc, pinned: body.pinned ?? false });
        templates = [...templates, made];
        return json({ template: made, warnings: [] }, 201);
      }
      if (method === "GET" && path === "/api/library" && library) {
        await new Promise((r) => setTimeout(r, library.ms));
        return json(library.dto);
      }
      if (method === "POST" && path === "/api/conditions/checks") return json({ check: { ...body, date: TODAY } });
      const one = /^\/api\/templates\/([^/]+)(\/use)?$/.exec(path);
      if (one) {
        const id = decodeURIComponent(one[1]!);
        const t = templates.find((x) => x.id === id);
        if (!t) return json({ error: "not_found" }, 404);
        if (method === "PUT") {
          const next = { ...t, ...body, updatedAt: "2026-10-11T13:00:00.000Z" };
          templates = templates.map((x) => (x.id === id ? next : x));
          return json({ template: next, warnings: [] });
        }
        if (method === "DELETE") {
          if (fail.delete) throw new TypeError("Failed to fetch");
          templates = templates.filter((x) => x.id !== id);
          return json({ ok: true });
        }
        if (method === "POST" && one[2]) return json({ template: { ...t, uses: t.uses + 1 }, doc: { ...t.doc, basedOn: { kind: "template", id } } });
      }
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: [] });
      if (method === "POST" && path === "/api/workouts") {
        return json(
          {
            workout: { id: "w-new", date: body.date, time: body.time ?? "18:00", title: body.doc.title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: 10 },
            warnings: [],
          },
          201,
        );
      }
      const session = /^\/api\/sessions\/([^/]+)\/(build|start)$/.exec(path);
      if (session && method === "POST" && session[2] === "build") return json(built(session[1]!));
      if (session && method === "POST" && session[2] === "start" && !fail.start) return json({ ...built(session[1]!), contentState: "started", locked: true });
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

// ── Mounting and driving ───────────────────────────────────────────────────

function mount(path: string, primed: Primed & { templates?: TemplateDto[]; strict?: boolean } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(HOME_GEAR), today: todayDto(null, false), library: libraryDto(), ...primed });
  qc.setQueryData(["settings"], { prefs: DEFAULT_SCHEDULING_PREFERENCES });
  if (primed.templates) qc.setQueryData(["templates"], { templates: primed.templates });
  const app = createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/studio/*", element: createElement(StudioRoute) }),
        createElement(Route, { path: "/session/:id", element: createElement("p", null, "the player") }),
      ),
      createElement(Where),
    ),
  );
  // The app runs under StrictMode, which runs a mount's effects twice.
  act(() => {
    root!.render(primed.strict ? createElement(StrictMode, null, app) : app);
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
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;
const rowNames = () => [...document.querySelectorAll(".stu-tpl-open")].map((a) => a.textContent);
const rowOf = (name: string) => [...document.querySelectorAll<HTMLElement>(".stu-tpl")].find((r) => r.querySelector(".stu-tpl-open")?.textContent === name) ?? null;
const startButton = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
/** A row's Start ("Start", and to a screen reader "Start: <name>"). */
const startOf = (name: string) => rowOf(name)?.querySelector<HTMLButtonElement>(".stu-tpl-start") ?? null;
const nameOf = (name: string) => rowOf(name)?.querySelector<HTMLElement>("a.stu-tpl-open") ?? null;

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── The list ───────────────────────────────────────────────────────────────

describe("a template from the list", () => {
  it("its name opens the builder on it, and the builder's way back is the list", async () => {
    serve([tpl("t1", "Hips & posture")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(rowOf("Hips & posture")!.querySelector(".stu-tpl-open"), "the name");
    await until(() => !!document.querySelector(".stu-build-title"), "the builder");
    expect(where).toBe("/studio/build/template/t1");
    expect(document.querySelector<HTMLInputElement>(".stu-build-title")!.value).toBe("Hips & posture");
    const back = document.querySelector<HTMLAnchorElement>(".stu-build-back")!;
    expect(back.textContent).toBe("Templates");
    await click(back, "the way back");
    expect(where).toBe("/studio/templates");
  });

  it("Start goes on to the player: the workout made for today from the template, which says so, its uses bumped", async () => {
    const calls = serve([tpl("t1", "Hips & posture")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(startOf("Hips & posture"), "Start");
    await until(() => text().includes("the player"), "the player");
    expect(where).toBe("/session/w-new");
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
    expect((create.body as { date: string }).date).toBe(TODAY);
    expect((create.body as { doc: WorkoutDoc }).doc.basedOn).toEqual({ kind: "template", id: "t1" });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path).sort()).toEqual(
      ["/api/workouts", "/api/templates/t1/use", "/api/sessions/w-new/build", "/api/sessions/w-new/start"].sort(),
    );
  });

  it("Start waits for what the day is judged with: a check the template's move needs is asked first, never skipped", async () => {
    // A press on a develop day needs today's jaw check (TMJ on) — known only once the library read answers.
    const pressDay = toProposable(
      edit(
        edit(startEditing(newDoc("structured", { title: "Press day", source: { kind: "studio" } })), { type: "setIntent", intent: { effort: "develop" } }, EXERCISES),
        { type: "addItem", part: 1, item: suggestedItem(EXERCISES.find((r) => r.id === "halfKneelingPress")!, "main") },
        EXERCISES,
      ).doc,
    )!;
    const calls = serve([tpl("t1", "Press day", { doc: pressDay })], {}, { dto: libraryDto({ tmj: true }), ms: 60 });
    mount("/studio/templates", { library: undefined });
    await until(() => rowNames().length === 1, "the list");
    await click(startOf("Press day"), "Start");
    await until(() => !!dialog("Jaw / head"), "the check");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/workouts")).toBe(false);
  });

  it("Start, under StrictMode (the app's), makes one workout and starts it once", async () => {
    // The template is already read when the builder opens, so Start's moment comes in the builder's first mount.
    const calls = serve([tpl("t1", "Hips & posture")]);
    mount("/studio/templates", { strict: true, templates: [tpl("t1", "Hips & posture")] });
    await until(() => rowNames().length === 1, "the list");
    await click(startOf("Hips & posture"), "Start");
    await until(() => text().includes("the player"), "the player");
    await settle(30);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/workouts")).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
  });

  it("Schedule… opens the builder on it with the schedule sheet open — once: Back to it does not open it again", async () => {
    serve([tpl("t1", "Hips & posture")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Schedule…", dialog("Hips & posture")!), "Schedule…");
    await until(() => !!dialog("Schedule"), "the schedule sheet");
    expect(where).toBe("/studio/build/template/t1");
    // Done once: the entry no longer asks for it (Back to it, or a reload, opens the builder only), and it still knows
    // the way back is the list.
    expect(whereState).toEqual({ from: "templates" });
    await click(button("Close", dialog("Schedule")!), "close");
    await until(() => !dialog("Schedule"), "the sheet to close");
    await settle(20);
    expect(dialog("Schedule")).toBeNull();
  });

  it("after Start, the planned workout it made still goes back to the list", async () => {
    // The start is refused, so the builder stays on the workout it made (Back from the player lands on the same entry).
    serve([tpl("t1", "Hips & posture")], { start: true });
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(startOf("Hips & posture"), "Start");
    await until(() => where === "/studio/build/workout/w-new" && !text().includes("Starting…"), "the planned workout");
    expect(whereState).toEqual({ from: "templates" });
    const back = document.querySelector<HTMLAnchorElement>(".stu-build-back")!;
    expect(back.textContent).toBe("Templates");
    expect(back.getAttribute("href")).toBe("/studio/templates");
  });
});

describe("the list with no connection", () => {
  it("says so — never a wait that does not end — and fills in by itself once the connection is back", async () => {
    serve([tpl("t1", "Hips & posture")]);
    onlineManager.setOnline(false);
    try {
      // Nothing kept on the device: the read can't go out, and waits (paused).
      mount("/studio/templates");
      await until(() => text().includes("Your templates need a connection."), "the reason");
      expect(text()).not.toContain("Loading your templates");
      // No Try again: a paused read can't be pushed (it would do nothing), and it goes on by itself.
      expect(button("Try again")).toBeNull();
    } finally {
      await act(async () => {
        onlineManager.setOnline(true);
      });
    }
    await until(() => rowNames().length === 1, "the list");
  });
});

describe("the list's read failing", () => {
  it("says so, and Try again reads it again", async () => {
    const calls = serve([tpl("t1", "Hips & posture")], { reads: 1 });
    mount("/studio/templates");
    await until(() => text().includes("Couldn't load your templates."), "the failure");
    await click(button("Try again"), "Try again");
    await until(() => rowNames().length === 1, "the list");
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/templates").length).toBe(2);
  });
});

describe("Rename, Pin and Delete", () => {
  it("Rename changes the name in place", async () => {
    const calls = serve([tpl("t1", "Hips & posture")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Rename…", dialog("Hips & posture")!), "Rename…");
    await until(() => !!dialog("Rename"), "the rename sheet");
    const input = dialog("Rename")!.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("Hips & posture");
    // Nothing to save until the name changes.
    expect(button("Save", dialog("Rename")!)!.disabled).toBe(true);
    await act(async () => setValue(input, "Hips before skiing"));
    await click(button("Save", dialog("Rename")!), "Save");
    await until(() => rowNames()[0] === "Hips before skiing", "the new name");
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: "/api/templates/t1", body: { name: "Hips before skiing" } });
    expect(dialog("Rename")).toBeNull();
  });

  it("Pin puts it first, said in words; Unpin takes it back", async () => {
    const calls = serve([tpl("t1", "Apple", { lastUsedAt: "2026-10-10T12:00:00.000Z" }), tpl("t2", "Zebra")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 2, "the list");
    expect(rowNames()).toEqual(["Apple", "Zebra"]);
    await click(button("Zebra: more"), "more");
    await click(button("Pin to quick starts", dialog("Zebra")!), "Pin");
    await until(() => rowNames()[0] === "Zebra", "Zebra first");
    expect(rowOf("Zebra")!.textContent).toContain("Pinned");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ pinned: true });
    // The row moved; focus moved with it.
    expect(document.activeElement).toBe(button("Zebra: more"));
    await click(button("Zebra: more"), "more");
    await click(button("Unpin from quick starts", dialog("Zebra")!), "Unpin");
    await until(() => rowNames()[0] === "Apple", "Apple first again");
    expect(rowOf("Zebra")!.textContent).not.toContain("Pinned");
  });

  it("Delete asks first; Cancel keeps it; Delete deletes it, and focus stays on the page", async () => {
    const calls = serve([tpl("t1", "Hips & posture"), tpl("t2", "Legs")]);
    mount("/studio/templates");
    await until(() => rowNames().length === 2, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Delete…", dialog("Hips & posture")!), "Delete…");
    await until(() => !!dialog("Delete this template?"), "the question");
    expect(dialog("Delete this template?")!.textContent).toContain("“Hips & posture” will be deleted.");
    await click(button("Cancel", dialog("Delete this template?")!), "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(rowNames()).toContain("Hips & posture");

    await click(button("Hips & posture: more"), "more");
    await click(button("Delete…", dialog("Hips & posture")!), "Delete…");
    await click(button("Delete", dialog("Delete this template?")!), "Delete");
    await until(() => !rowNames().includes("Hips & posture"), "the row to go");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/templates/t1"]);
    expect(text()).toContain("Deleted “Hips & posture”.");
    // Its ⋯ went with it: focus is on the next row's name.
    expect(document.activeElement).toBe(nameOf("Legs"));
  });

  it("a template that can no longer be opened can still be renamed or deleted — nothing else", async () => {
    serve([tpl("t1", "Broken one", { doc: null })]);
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    await click(button("Broken one: more"), "more");
    const actions = buttons(dialog("Broken one")!).filter((b) => b.getAttribute("aria-label") !== "Close");
    expect(actions.map((b) => b.textContent)).toEqual(["Rename…", "Delete…"]);
  });

  it("a delete that can't reach the server says so, and the template stays", async () => {
    serve([tpl("t1", "Hips & posture")], { delete: true });
    mount("/studio/templates");
    await until(() => rowNames().length === 1, "the list");
    // Pressed from the keyboard (a script's click does not focus it): the ⋯ is what the sheets give focus back to.
    button("Hips & posture: more")!.focus();
    await click(button("Hips & posture: more"), "more");
    await click(button("Delete…", dialog("Hips & posture")!), "Delete…");
    await click(button("Delete", dialog("Delete this template?")!), "Delete");
    await until(() => text().includes("Deleting needs a connection."), "the reason");
    expect(dialog("Delete this template?")).not.toBeNull();
    expect(rowNames()).toEqual(["Hips & posture"]);
    // Not gone, only out of reach: closing the question puts focus back on its row's ⋯.
    await click(button("Cancel", dialog("Delete this template?")!), "Cancel");
    expect(document.activeElement).toBe(button("Hips & posture: more"));
  });
});

describe("a template deleted elsewhere (the server answers 404)", () => {
  // This device still lists “Hips & posture”; the server no longer has it.
  const listed = () => [tpl("t1", "Hips & posture"), tpl("t2", "Legs")];

  it("Pin says it is gone, the list is read again without it, and focus goes to the next row's name", async () => {
    serve([tpl("t2", "Legs")]);
    mount("/studio/templates", { templates: listed() });
    await until(() => rowNames().length === 2, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Pin to quick starts", dialog("Hips & posture")!), "Pin");
    await until(() => !rowNames().includes("Hips & posture"), "the gone row to go");
    expect(text()).toContain("That template is gone now.");
    expect(document.activeElement).toBe(nameOf("Legs"));
  });

  it("Rename says it is gone, the list is read again without it, and closing the sheet puts focus on the next row's name", async () => {
    serve([tpl("t2", "Legs")]);
    mount("/studio/templates", { templates: listed() });
    await until(() => rowNames().length === 2, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Rename…", dialog("Hips & posture")!), "Rename…");
    await act(async () => setValue(dialog("Rename")!.querySelector<HTMLInputElement>("input")!, "Hips again"));
    await click(button("Save", dialog("Rename")!), "Save");
    await until(() => dialog("Rename")?.textContent?.includes("That template is gone now.") === true, "the reason");
    await until(() => !rowNames().includes("Hips & posture"), "the gone row to go");
    await click(button("Close", dialog("Rename")!), "Close");
    expect(document.activeElement).toBe(nameOf("Legs"));
  });

  it("Delete says it is gone, the list is read again without it, and closing the question puts focus on the next row's name", async () => {
    serve([tpl("t2", "Legs")]);
    mount("/studio/templates", { templates: listed() });
    await until(() => rowNames().length === 2, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Delete…", dialog("Hips & posture")!), "Delete…");
    await click(button("Delete", dialog("Delete this template?")!), "Delete");
    await until(() => dialog("Delete this template?")?.textContent?.includes("That template is gone now.") === true, "the reason");
    await until(() => !rowNames().includes("Hips & posture"), "the gone row to go");
    await click(button("Cancel", dialog("Delete this template?")!), "Cancel");
    expect(document.activeElement).toBe(nameOf("Legs"));
  });

  it("with no row left, focus goes to the page's title", async () => {
    serve([]);
    mount("/studio/templates", { templates: [tpl("t1", "Hips & posture")] });
    await until(() => rowNames().length === 1, "the list");
    await click(button("Hips & posture: more"), "more");
    await click(button("Delete…", dialog("Hips & posture")!), "Delete…");
    await click(button("Delete", dialog("Delete this template?")!), "Delete");
    await until(() => text().includes("No templates yet."), "the empty list");
    await click(button("Cancel", dialog("Delete this template?")!), "Cancel");
    expect(document.activeElement).toBe(document.querySelector("h1"));
  });
});

// ── Quick starts ───────────────────────────────────────────────────────────

describe("a quick start", () => {
  it("is two taps to a running session: the tile opens the builder pre-filled, with no network asked; Start now starts it", async () => {
    const calls = serve();
    mount("/studio");
    await until(() => !!document.querySelector('a.stu-qs[href="/studio/build/quick/hip_opener"]'), "the tile");
    const before = calls.length;
    // Tap 1.
    await click(document.querySelector('a.stu-qs[href="/studio/build/quick/hip_opener"]'), "Hip opener");
    expect(where).toBe("/studio/build/quick/hip_opener");
    const made = quickStartFor("hip_opener", { ...emptyStudioCtx, today: TODAY, place: { name: "Home", equipment: HOME_GEAR } }, TODAY);
    if (!("doc" in made)) throw new Error(made.reason);
    // Pre-filled at once — from the bundled library, nothing asked of the server to make it.
    const names = [...document.querySelectorAll(".stu-item-name")].map((n) => n.firstChild?.textContent?.trim());
    expect(names.length).toBe(made.doc.parts.reduce((n, p) => n + p.items.length, 0));
    expect(calls.slice(before).filter((c) => !c.path.startsWith("/api/templates"))).toEqual([]);
    expect(startButton()!.disabled).toBe(false);
    // Tap 2.
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/workouts")!;
    const sent = (create.body as { doc: WorkoutDoc }).doc;
    expect(sent.title).toBe(made.doc.title);
    expect(sent.source).toEqual({ kind: "studio", ref: "quick_start:hip_opener" });
    expect(sent.parts.map((p) => p.items.length)).toEqual(made.doc.parts.map((p) => p.items.length));
  });

  it("leaves the workout being built on this device as it was", async () => {
    const own = startEditing(goblet("My own")).doc;
    await draftStore().save(own);
    serve();
    mount("/studio/build/quick/desk_reset");
    await until(() => !!startButton(), "the builder");
    // An edit to the quick start: the effort.
    await click(document.querySelectorAll<HTMLInputElement>('.stu-effort input[type="radio"]')[0]!, "Recover");
    await settle(20);
    expect((await draftStore().load())?.doc.title).toBe("My own");
    // Its menu offers no "Start over", which would clear that draft.
    await click(document.querySelector(".stu-save-btn"), "Save");
    expect(buttons(document.querySelector(".stu-save-menu")!).map((b) => b.textContent)).toEqual(["Save as template…"]);
  });

  it("scheduled, it is that planned workout in the builder — a later Start never makes a second — and the draft is untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    try {
      await draftStore().save(startEditing(goblet("My own")).doc);
      const calls = serve();
      mount("/studio/build/quick/desk_reset");
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
      await until(() => text().includes("Scheduled for today at 4 PM."), "the line");
      expect(where).toBe("/studio/build/workout/w-new");
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/workouts")).toHaveLength(1);
      // Start now starts that planned workout: no second one is made.
      await click(startButton(), "Start now");
      await until(() => text().includes("the player"), "the player");
      expect(where).toBe("/session/w-new");
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/workouts")).toHaveLength(1);
      expect(calls.filter((c) => c.path === "/api/sessions/w-new/start")).toHaveLength(1);
      expect((await draftStore().load())?.doc.title).toBe("My own");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opened by its address, it waits for the reads — never a wrong answer first — then opens", async () => {
    // Condition care hangs on the library read, which says the profile is on; it lands after everything else.
    serve([], {}, { dto: libraryDto({ tmj: true }), ms: 60 });
    mount("/studio/build/quick/condition_care", { library: undefined });
    let saidNo = false;
    await until(() => {
      saidNo ||= text().includes("needs a condition profile");
      return !!document.querySelector<HTMLInputElement>(".stu-build-title");
    }, "the workout");
    expect(saidNo).toBe(false);
    expect(document.querySelector<HTMLInputElement>(".stu-build-title")!.value).toBe("Jaw care");
    expect(startButton()).not.toBeNull();
  });

  it("opens with no network at all, from what the device knows", async () => {
    const calls = serve();
    onlineManager.setOnline(false);
    try {
      // The athlete's library read can't go out: it waits (paused), and the quick start does not wait for it.
      mount("/studio/build/quick/hip_opener", { library: undefined });
      await until(() => document.querySelectorAll(".stu-item-name").length > 0, "the workout");
      expect(startButton()).not.toBeNull();
      expect(calls.filter((c) => c.path === "/api/library")).toEqual([]);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("condition care with no profile on says why, plainly", async () => {
    serve();
    mount("/studio/build/quick/condition_care");
    await until(() => text().includes("Condition care needs a condition profile with care switched on."), "the reason");
    expect(startButton()).toBeNull();
  });

  it("condition care opened by its address with no connection, its profiles never read: it needs a connection the first time", async () => {
    serve();
    onlineManager.setOnline(false);
    try {
      mount("/studio/build/quick/condition_care", { library: undefined });
      await until(() => text().includes("Condition care needs a connection the first time."), "the reason");
      expect(text()).not.toContain("needs a condition profile");
      expect(startButton()).toBeNull();
    } finally {
      await act(async () => {
        onlineManager.setOnline(true);
      });
    }
  });

  it("condition care whose profiles' read failed says the same — not that no profile is on", async () => {
    serve(); // The library read is answered 503.
    mount("/studio/build/quick/condition_care", { library: undefined });
    await until(() => text().includes("Condition care needs a connection the first time."), "the reason");
    expect(text()).not.toContain("needs a condition profile");
  });

  it("Save as template can pin it to the quick starts in the same step", async () => {
    const calls = serve();
    mount("/studio/build/quick/desk_reset");
    await until(() => !!startButton(), "the builder");
    const saveAs = async () => {
      await click(document.querySelector(".stu-save-btn"), "Save");
      await click(document.querySelector('[role="menuitem"]'), "Save as template…");
      return dialog("Save as template")!;
    };
    // Off unless asked for.
    let sheet = await saveAs();
    let pin = sheet.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(pin.closest("label")!.textContent).toBe("Pin to quick starts");
    expect(pin.checked).toBe(false);
    await click(button("Save", sheet), "Save");
    await until(() => !dialog("Save as template"), "the sheet to close");
    expect((calls.filter((c) => c.method === "POST" && c.path === "/api/templates")[0]!.body as { pinned?: boolean }).pinned).toBeUndefined();
    // Asked for: the template is pinned as it is made, and the line says so.
    sheet = await saveAs();
    pin = sheet.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(pin, "Pin to quick starts");
    expect(pin.checked).toBe(true);
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("pinned to quick starts"), "the line");
    const body = calls.filter((c) => c.method === "POST" && c.path === "/api/templates")[1]!.body as { name: string; pinned?: boolean };
    expect(body.pinned).toBe(true);
    expect(text()).toContain(`Saved “${body.name}” as a template, pinned to quick starts.`);
  });
});
