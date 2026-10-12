// @vitest-environment jsdom
/**
 * Stage 2 Task 5 — Add, live (spec §7): the one small sheet offers the workout being built (a draft on this device),
 * the planned workouts the Studio may change (never a programme's own session — for those, Pin), a new workout, and a
 * template; the move lands in the part its purpose belongs to; a refusal says why and adds nothing; after Add, a
 * quiet line with Open and Undo — and Undo puts back exactly what was there.
 */
import "fake-indexeddb/auto";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDto, WorkoutDto } from "@rg/api-client";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, type DraftDoc } from "@rg/workout";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { draftStore } from "../src/studio-drafts.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-11";

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

// ── The server, as the sheet meets it ──────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function planned(over: Partial<WorkoutDto>): WorkoutDto {
  return {
    id: "w1",
    title: "Strength day",
    category: "strength",
    sport: "strength",
    originalPlanDate: "2026-10-15",
    lastVerifiedCorosDate: "",
    effectiveDate: "2026-10-15",
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
    ...over,
  } as WorkoutDto;
}

const programSession = planned({ id: "slot-p1", title: "Garden program", origin: "program", programId: "p1", effectiveDate: "2026-10-13" });

const storedDoc = (title: string): WorkoutDoc => ({
  version: 1,
  title,
  intent: { summary: title, goals: [], focus: [], effort: "maintain" },
  parts: [
    { purpose: "warmup", format: "straight", items: [{ kind: "exercise", libraryId: "catCow", dose: { reps: 6 } }] },
    { purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "boxSquat", dose: { sets: 2, reps: 10 } }] },
  ],
  source: { kind: "studio" },
});

function template(over: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id: "t1",
    name: "Desk reset",
    doc: storedDoc("Desk reset"),
    pinned: false,
    uses: 2,
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    minutes: 20,
    discipline: "strength",
    ...over,
  };
}

interface Server {
  workouts?: WorkoutDto[];
  templates?: TemplateDto[];
  /** GET /api/workouts/:id/doc, in turn (the last one repeats). */
  docs?: Array<{ doc: WorkoutDoc; rev: number }>;
  /** PUT /api/workouts/:id/doc answers, in turn (the last one repeats): a status, or OK. */
  revise?: Array<number | { error: string; status: number }>;
}

function serve(s: Server = {}): Call[] {
  const calls: Call[] = [];
  let docRead = 0;
  let revised = 0;
  let rev = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: s.workouts ?? [] });
      if (method === "GET" && path === "/api/templates") return json({ templates: s.templates ?? [] });
      if (method === "PUT" && path.startsWith("/api/templates/")) return json({ template: { ...template(), doc: body.doc }, warnings: [] });
      const doc = /^\/api\/workouts\/([^/]+)\/doc$/.exec(path);
      if (doc && method === "GET") {
        const d = s.docs?.[Math.min(docRead++, (s.docs?.length ?? 1) - 1)];
        if (!d) return json({ error: "not_found" }, 404);
        rev = d.rev;
        return json({ doc: d.doc, derived: { estimatedMinutes: 20, discipline: "strength", category: "strength", mode: "build", watchStepCount: 4 }, rev: d.rev });
      }
      if (doc && method === "PUT") {
        const a = s.revise?.[Math.min(revised++, (s.revise?.length ?? 1) - 1)];
        if (a && typeof a === "object") return json({ error: a.error, rev: rev + 1 }, a.status);
        const w = planned({ id: doc[1]! });
        return json({ workout: { ...w, date: w.effectiveDate, time: w.effectiveTime, title: body.doc.title, intentSummary: "", docRev: body.baseRev + 1, minutes: 20 }, rev: body.baseRev + 1, watchHasOlder: false, warnings: [] });
      }
      const prefs = /^\/api\/library\/([^/]+)\/prefs$/.exec(path);
      if (prefs && method === "PUT") return json({ prefs: { exerciseId: prefs[1], rating: null, excluded: false, pinned: false, introducedOn: null, ...body } });
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

// ── Mounting and driving ───────────────────────────────────────────────────

function mount(path: string, { strict = false } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const app = createElement(
    QueryClientProvider,
    { client: primedClient() },
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(StudioScreen), createElement(Where)),
  );
  act(() => {
    root!.render(strict ? createElement(StrictMode, null, app) : app);
  });
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}

const text = () => (host!.textContent ?? "").replace(/\s+/g, " ");
const sheet = () => [...host!.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent?.startsWith("Add ")) ?? null;
const line = () => host!.querySelector<HTMLElement>(".stu-added--on");

async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const option = (label: string) =>
  [...sheet()!.querySelectorAll<HTMLLabelElement>(".stu-add-choice")].find((l) => l.textContent?.trim() === label)?.querySelector("input") ?? null;
const addButton = () => sheet()!.querySelector<HTMLButtonElement>(".stu-add-go");

/** Open the Add sheet from the row of `name` in a list for `q`, and wait for its reads. */
async function openAdd(q: string, name: string) {
  mount(`/studio?q=${encodeURIComponent(q)}`);
  await click(host!.querySelector(`[aria-label="Add ${name}"]`), `Add ${name}`);
  await until(() => !!sheet(), "the Add sheet");
  await settle(20);
}

const draftDoc = (title = "Hips & posture"): DraftDoc =>
  edit(startEditing(newDoc("structured", { title, source: { kind: "studio" } })), { type: "addItem", item: { kind: "exercise", libraryId: "catCow", dose: { reps: 6 } } }, EXERCISES).doc;

const exerciseIds = (doc: WorkoutDoc, purpose: string) =>
  doc.parts.find((p) => p.purpose === purpose)?.items.map((i) => (i.kind === "exercise" ? i.libraryId : i.kind)) ?? [];

// ── The choices ────────────────────────────────────────────────────────────

describe("the choices the sheet offers", () => {
  it("with nothing to add to: a new workout, chosen; and Pin", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    expect(sheet()!.querySelector("h2")!.textContent).toBe("Add Goblet squat");
    const choices = [...sheet()!.querySelectorAll(".stu-add-choice")].map((l) => l.textContent?.trim());
    expect(choices).toEqual(["To a new workout"]);
    expect(option("To a new workout")!.checked).toBe(true);
    expect(sheet()!.textContent).toContain("Pin — keep it in my rotation");
  });

  it("the workout being built (chosen first), the planned workouts the Studio may change, a new workout, the templates", async () => {
    await draftStore().save(draftDoc());
    serve({ workouts: [programSession, planned({ id: "w1" }), planned({ id: "done", completionState: "completed" })], templates: [template()] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To a template"), "the templates");
    const choices = [...sheet()!.querySelectorAll(".stu-add-choice")].map((l) => l.textContent?.trim());
    expect(choices).toEqual(["To the workout I'm building", "To a planned workout", "To a new workout", "To a template"]);
    expect(option("To the workout I'm building")!.checked).toBe(true);
    expect(sheet()!.textContent).toContain("“Hips & posture”");
    // A new workout would take the draft's place: it says so.
    expect(sheet()!.textContent).toContain("Replaces “Hips & posture”");
    const planned_ = [...sheet()!.querySelectorAll<HTMLOptionElement>('select[aria-label="Planned workout"] option')].map((o) => o.textContent);
    expect(planned_).toEqual(["Thu Oct 15 · Strength day"]);
  });

  it("a programme's own sessions are never offered to add to: for those, Pin", async () => {
    const calls = serve({ workouts: [programSession, planned({ id: "slot-p2", origin: "program", effectiveDate: "2026-10-16" })] });
    await openAdd("goblet", "Goblet squat");
    await until(() => calls.some((c) => c.path === "/api/plan/workouts"), "the plan read");
    await settle(20);
    expect(option("To a planned workout")).toBeNull();
    expect(sheet()!.textContent).not.toContain("Garden program");
    const pin = [...sheet()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Pin — keep it in my rotation"))!;
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await click(pin, "Pin");
    expect(calls.find((c) => c.method === "PUT" && c.path === "/api/library/gobletSquat/prefs")?.body).toEqual({ pinned: true });
    await until(() => sheet()!.querySelector(".stu-add-pin")?.getAttribute("aria-pressed") === "true", "Pinned");
    expect(sheet()!.querySelector(".stu-add-pin")!.textContent).toBe("Pinned");
  });
});

// ── Adding, and Undo ───────────────────────────────────────────────────────

describe("to the workout being built", () => {
  it("lands in its part; the line says where, with Open and Undo; Undo puts the draft back", async () => {
    const before = draftDoc();
    await draftStore().save(before);
    serve();
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To the workout I'm building"), "the draft");
    await click(addButton(), "Add");
    await until(() => !!line(), "the confirmation line");
    expect(sheet()).toBeNull();
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Hips & posture”.");
    expect(line()!.querySelector(".stu-added-text")!.getAttribute("role")).toBe("status");
    expect(line()!.querySelector("a")!.getAttribute("href")).toBe("/studio/build/new");
    const after = (await draftStore().load())!.doc;
    expect(exerciseIds(after, "main")).toEqual(["gobletSquat"]);
    expect(exerciseIds(after, "warmup")).toEqual(["catCow"]);

    const undo = [...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
    undo.focus();
    await click(undo, "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect((await draftStore().load())!.doc).toEqual(before);
    // Undo's button went: focus rests on the line, not the page.
    expect(document.activeElement).toBe(line()!.querySelector(".stu-added-text"));
  });

  it("a full part refuses, says so in the sheet, and adds nothing — no confirmation", async () => {
    let st = startEditing(draftDoc());
    for (let i = 0; i < 60; i++) st = edit(st, { type: "addItem", item: { kind: "exercise", libraryId: "boxSquat", dose: { reps: 8 } }, part: 1 }, EXERCISES);
    const full = st.doc;
    expect(full.parts[1]!.items).toHaveLength(60);
    await draftStore().save(full);
    serve();
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To the workout I'm building"), "the draft");
    await click(addButton(), "Add");
    await until(() => !!sheet()!.querySelector('[role="alert"]'), "the refusal");
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe("That part is full.");
    expect(line()).toBeNull();
    expect((await draftStore().load())!.doc).toEqual(full);
  });
});

describe("under StrictMode, as the dev build runs it", () => {
  it("an Add still lands and closes the sheet (a sheet's mounted-ness survives the double mount)", async () => {
    serve();
    mount("/studio?q=goblet", { strict: true });
    await click(host!.querySelector('[aria-label="Add Goblet squat"]'), "Add Goblet squat");
    await until(() => !!sheet(), "the Add sheet");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect(sheet()).toBeNull();
    expect((await draftStore().load())?.doc.title).toBe("New workout");
  });
});

describe("to a new workout", () => {
  it("takes the draft's place; Undo brings the old draft back", async () => {
    const before = draftDoc();
    await draftStore().save(before);
    serve();
    await openAdd("doorway", "Doorway chest stretch");
    await until(() => !!option("To a new workout"), "the choices");
    await click(option("To a new workout"), "the new-workout choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Cool-down in “New workout”.");
    const now = (await draftStore().load())!.doc;
    expect(now.title).toBe("New workout");
    expect(now.parts.map((p) => p.purpose)).toEqual(["warmup", "main", "cooldown"]);
    expect(exerciseIds(now, "cooldown")).toEqual(["doorwayPecStretch"]);
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect((await draftStore().load())!.doc).toEqual(before);
  });

  it("with no draft before it, Undo leaves none", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect((await draftStore().load())?.doc.title).toBe("New workout");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect(await draftStore().load()).toBeNull();
  });
});

describe("to a planned workout", () => {
  it("reads it, writes the next revision from the one it read, and Undo writes back what was there", async () => {
    const original = storedDoc("Strength day");
    const calls = serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: original, rev: 3 }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const put = calls.filter((c) => c.method === "PUT" && c.path === "/api/workouts/w1/doc");
    expect(put).toHaveLength(1);
    const sent = put[0]!.body as { doc: WorkoutDoc; baseRev: number };
    expect(sent.baseRev).toBe(3);
    expect(exerciseIds(sent.doc, "main")).toEqual(["boxSquat", "gobletSquat"]);
    expect(exerciseIds(sent.doc, "warmup")).toEqual(["catCow"]);
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Strength day”.");
    expect(line()!.querySelector("a")!.getAttribute("href")).toBe("/studio/build/workout/w1");

    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    const back = calls.filter((c) => c.method === "PUT" && c.path === "/api/workouts/w1/doc")[1]!.body as { doc: WorkoutDoc; baseRev: number };
    expect(back).toEqual({ doc: original, baseRev: 4 });
  });

  it("changed in between: added to what is there now, once", async () => {
    const calls = serve({
      workouts: [planned({ id: "w1" })],
      docs: [
        { doc: storedDoc("Strength day"), rev: 3 },
        { doc: storedDoc("Strength day, edited"), rev: 5 },
      ],
      revise: [{ error: "stale_revision", status: 409 }, 200],
    });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const puts = calls.filter((c) => c.method === "PUT").map((c) => (c.body as { baseRev: number; doc: WorkoutDoc }));
    expect(puts.map((p) => p.baseRev)).toEqual([3, 5]);
    expect(puts[1]!.doc.title).toBe("Strength day, edited");
  });

  it("refused (no longer editable): says why in the sheet; nothing is confirmed", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 1 }], revise: [{ error: "not_editable", status: 409 }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!sheet()?.querySelector('[role="alert"]'), "the refusal");
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe("This workout can't be changed now.");
    expect(line()).toBeNull();
  });
});

describe("to a template", () => {
  it("writes the template with the move in its part; Undo writes the old one back", async () => {
    const t = template();
    const calls = serve({ templates: [t] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!option("To a template"), "the template");
    await click(option("To a template"), "the template choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1");
    expect(exerciseIds((puts[0]!.body as { doc: WorkoutDoc }).doc, "main")).toEqual(["boxSquat", "gobletSquat"]);
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Desk reset”.");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1")[1]!.body).toEqual({ doc: t.doc });
  });
});

describe("from the detail", () => {
  it("Add in the move's sheet opens the Add sheet over it; the line shows in the detail; Escape closes only the top sheet", async () => {
    serve();
    mount("/studio/move/gobletSquat?q=goblet");
    await click(host!.querySelector(".stu-detail-add"), "the detail's Add");
    await until(() => !!sheet(), "the Add sheet");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(sheet()).toBeNull();
    expect(where).toBe("/studio/move/gobletSquat?q=goblet");
    await click(host!.querySelector(".stu-detail-add"), "the detail's Add");
    await until(() => !!sheet(), "the Add sheet");
    await click(addButton(), "Add");
    await until(() => !!host!.querySelector('[role="dialog"] .stu-added--on'), "the line in the detail");
    expect(host!.querySelector('[role="dialog"] .stu-added-text')!.textContent).toBe("Added to Main in “New workout”.");
    // Said once: the page's own line stays empty.
    expect(host!.querySelectorAll(".stu-added--on")).toHaveLength(1);
  });

  it("dismissing the line hands focus back to the Add that made it", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click(line()!.querySelector('[aria-label="Dismiss"]'), "Dismiss");
    expect(line()).toBeNull();
    expect(document.activeElement).toBe(host!.querySelector('[aria-label="Add Goblet squat"]'));
  });
});
