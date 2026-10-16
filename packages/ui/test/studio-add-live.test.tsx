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
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDto, WorkoutDto } from "@rg/api-client";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, type DraftDoc } from "@rg/workout";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { AddSheet, SAVE_PATIENCE, type AddDone } from "../src/screens/studio/add-sheet.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { draftStore, type DraftStore, type StudioDraft } from "../src/studio-drafts.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-11";

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

beforeEach(async () => {
  // The Studio reads "today" on the account's clock (CUJ R14), so the fixtures' dates hold only on the day they name:
  // the clock is pinned to TODAY (Date only; timers stay real), or the planned workouts fall into the past.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`));
  await draftStore().clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  SAVE_PATIENCE.ms = 8000;
});

/** Answers a revise the server is holding ("held"). */
let releaseHeld: () => void = () => undefined;

let whereState: unknown = null;
function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  whereState = loc.state;
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
  /** GET /api/templates, in turn (the last one repeats). */
  templates?: TemplateDto[] | TemplateDto[][];
  /** GET /api/workouts/:id/doc, in turn (the last one repeats). */
  docs?: Array<{ doc: WorkoutDoc; rev: number }>;
  /** PUT /api/workouts/:id/doc answers, in turn (the last one repeats): a refusal, "hang" (never answers), or OK with
   * what the server says of it. */
  revise?: Array<number | "hang" | "held" | { error: string; status: number } | { watchHasOlder?: boolean; warnings?: unknown[] }>;
  /** PUT /api/templates/:id answers, in turn (the last one repeats): `stale` (409 stale_revision), else OK. */
  tplPut?: Array<"stale" | "ok">;
}

function serve(s: Server = {}): Call[] {
  const calls: Call[] = [];
  let docRead = 0;
  let revised = 0;
  let tplRead = 0;
  let tplPut = 0;
  let rev = 0;
  const tplAnswers: TemplateDto[][] = Array.isArray(s.templates?.[0]) ? (s.templates as TemplateDto[][]) : [(s.templates as TemplateDto[] | undefined) ?? []];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: s.workouts ?? [] });
      if (method === "GET" && path === "/api/templates") return json({ templates: tplAnswers[Math.min(tplRead++, tplAnswers.length - 1)] });
      if (method === "PUT" && path.startsWith("/api/templates/")) {
        if (s.tplPut?.[Math.min(tplPut++, s.tplPut.length - 1)] === "stale") return json({ error: "stale_revision", updatedAt: "2026-10-11T09:00:00Z" }, 409);
        return json({ template: { ...template(), doc: body.doc }, warnings: [] });
      }
      const doc = /^\/api\/workouts\/([^/]+)\/doc$/.exec(path);
      if (doc && method === "GET") {
        const d = s.docs?.[Math.min(docRead++, (s.docs?.length ?? 1) - 1)];
        if (!d) return json({ error: "not_found" }, 404);
        rev = d.rev;
        return json({ doc: d.doc, derived: { estimatedMinutes: 20, discipline: "strength", category: "strength", mode: "build", watchStepCount: 4 }, rev: d.rev });
      }
      if (doc && method === "PUT") {
        const a = s.revise?.[Math.min(revised++, (s.revise?.length ?? 1) - 1)];
        if (a === "hang") return new Promise<Response>(() => undefined);
        if (a === "held") return new Promise<Response>((r) => (releaseHeld = () => r(json({ workout: { ...planned({ id: doc[1]! }), date: "2026-10-15", time: "18:00", title: body.doc.title, intentSummary: "", docRev: body.baseRev + 1, minutes: 20 }, rev: body.baseRev + 1, watchHasOlder: false, warnings: [] }))));
        if (a && typeof a === "object" && "error" in a) return json({ error: a.error, rev: rev + 1 }, a.status);
        const said = a && typeof a === "object" ? a : {};
        const w = planned({ id: doc[1]! });
        return json({
          workout: { ...w, date: w.effectiveDate, time: w.effectiveTime, title: body.doc.title, intentSummary: "", docRev: body.baseRev + 1, minutes: 20 },
          rev: body.baseRev + 1,
          watchHasOlder: said.watchHasOlder ?? false,
          warnings: said.warnings ?? [],
        });
      }
      if (method === "GET" && path === "/api/sessions/w1/watch-preview") {
        return json({ buildId: "b9", stamp: "Strength day — 2026-10-15", steps: [{ name: "Goblet Squat", freeText: false, target: { kind: "reps", reps: 7 }, grams: null, load: null, overview: "", restSeconds: 0 }], freeText: 0, refusal: null, digest: "d9" });
      }
      if (method === "POST" && path === "/api/sessions/w1/send-to-watch") return json({ workoutId: "w1", watch: { state: "sending" } });
      if (method === "POST" && path === "/api/sessions/watch/drain") return json({ executed: 1 });
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

/** A choice that is offered (its row is there and can be taken). */
const offered = (label: string) => {
  const o = option(label);
  return o && !o.disabled ? o : null;
};
const option = (label: string) =>
  [...sheet()!.querySelectorAll<HTMLLabelElement>(".stu-choice")].find((l) => l.textContent?.trim() === label)?.querySelector("input") ?? null;
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
  it("with nothing to add to: a new workout, chosen; the planned and template rows hold their place, saying there are none; and Pin", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    expect(sheet()!.querySelector("h2")!.textContent).toBe("Add Goblet squat");
    const choices = [...sheet()!.querySelectorAll(".stu-choice")].map((l) => l.textContent?.trim());
    expect(choices).toEqual(["To a planned workout", "To a new workout", "To a template"]);
    expect(option("To a new workout")!.checked).toBe(true);
    expect(option("To a planned workout")!.disabled).toBe(true);
    expect(option("To a template")!.disabled).toBe(true);
    expect(sheet()!.textContent).toContain("None coming up");
    expect(sheet()!.textContent).toContain("None yet");
    expect(sheet()!.textContent).toContain("Pin — keep it in my rotation");
  });

  it("the workout being built (chosen first), the planned workouts the Studio may change, a new workout, the templates", async () => {
    await draftStore().save(draftDoc());
    serve({ workouts: [programSession, planned({ id: "w1" }), planned({ id: "done", completionState: "completed" })], templates: [template()] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a template"), "the templates");
    const choices = [...sheet()!.querySelectorAll(".stu-choice")].map((l) => l.textContent?.trim());
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
    expect(offered("To a planned workout")).toBeNull();
    expect(sheet()!.textContent).toContain("None coming up");
    expect(sheet()!.textContent).not.toContain("Garden program");
    const pin = [...sheet()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Pin — keep it in my rotation"))!;
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await click(pin, "Pin");
    expect(calls.find((c) => c.method === "PUT" && c.path === "/api/library/gobletSquat/prefs")?.body).toEqual({ pinned: true });
    await until(() => sheet()!.querySelector(".stu-add-pin")?.getAttribute("aria-pressed") === "true", "pressed");
    // One name; the state is the button's `aria-pressed`, shown by the check.
    expect(sheet()!.querySelector(".stu-add-pin")!.textContent).toBe("Pin — keep it in my rotation");
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
    expect(line()!.querySelector(".stu-added-said")!.getAttribute("role")).toBe("status");
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
    expect(document.activeElement).toBe(line()!.querySelector(".stu-added-said"));
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
    await until(() => !!offered("To a planned workout"), "the planned workout");
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
    await until(() => !!offered("To a planned workout"), "the planned workout");
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
    await until(() => !!offered("To a planned workout"), "the planned workout");
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
    await until(() => !!offered("To a template"), "the template");
    await click(option("To a template"), "the template choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1");
    expect(exerciseIds((puts[0]!.body as { doc: WorkoutDoc }).doc, "main")).toEqual(["boxSquat", "gobletSquat"]);
    // Built on the copy it read: the write names that copy, so a template changed since is refused, not overwritten.
    expect((puts[0]!.body as { baseUpdatedAt?: string }).baseUpdatedAt).toBe(t.updatedAt);
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Desk reset”.");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1")[1]!.body).toEqual({ doc: t.doc, baseUpdatedAt: t.updatedAt });
  });

  it("a template changed elsewhere since it was read (a cached copy): refused, read again, the move added to what is there now", async () => {
    const t = template();
    const newer = { ...t, updatedAt: "2026-10-11T09:00:00Z", doc: storedDoc("Desk reset, longer") };
    const calls = serve({ templates: [[t], [t], [newer]], tplPut: ["stale", "ok"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a template"), "the template");
    await click(option("To a template"), "the template choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1").map((c) => c.body as { doc: WorkoutDoc; baseUpdatedAt: string });
    expect(puts.map((b) => b.baseUpdatedAt)).toEqual([t.updatedAt, newer.updatedAt]);
    expect(puts[1]!.doc.title).toBe("Desk reset, longer");
  });

  it("changed again on the second try: says so plainly, and adds nothing", async () => {
    const t = template();
    const calls = serve({ templates: [t], tplPut: ["stale"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a template"), "the template");
    await click(option("To a template"), "the template choice");
    await click(addButton(), "Add");
    await until(() => !!sheet()?.querySelector('[role="alert"]'), "the refusal");
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe("That template changed elsewhere. Try again.");
    expect(line()).toBeNull();
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1")).toHaveLength(2);
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

// ── Fix round 1 ────────────────────────────────────────────────────────────

/** The sheet alone, with a draft store the test controls. */
function mountSheet(drafts: DraftStore, onAdded: (d: AddDone) => void = () => undefined) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient();
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(AddSheet, {
            rec: EXERCISES.find((r) => r.id === "gobletSquat")!,
            ctx: emptyStudioCtx,
            today: TODAY,
            onClose: () => undefined,
            onAdded,
            drafts,
          }),
        ),
      ),
    );
  });
  return client;
}

/** A store whose first read answers only when the test says, and whose device holds `held` (changeable). */
function lateStore(held: { draft: StudioDraft | null }) {
  let answer: (() => void) | null = null;
  let first = true;
  const store = {
    load: vi.fn(() => {
      if (!first) return Promise.resolve(held.draft);
      first = false;
      return new Promise<StudioDraft | null>((r) => (answer = () => r(held.draft)));
    }),
    save: vi.fn(async (doc: DraftDoc) => (held.draft = { doc, updatedAt: 2 })),
    clear: vi.fn(async () => {
      held.draft = null;
    }),
  };
  return { store, answer: () => answer?.() };
}

describe("before the draft has been read (review: Add must not overwrite a draft it has not seen)", () => {
  it("nothing can be taken and Add waits; then the draft is chosen, the rows in place", async () => {
    serve();
    const held = { draft: { doc: draftDoc(), updatedAt: 1 } as StudioDraft | null };
    const { store, answer } = lateStore(held);
    mountSheet(store);
    await settle(20);
    expect(sheet()!.querySelector("fieldset")!.getAttribute("aria-busy")).toBe("true");
    expect(sheet()!.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(addButton()!.disabled).toBe(true);
    await act(async () => answer());
    await until(() => option("To the workout I'm building")?.checked === true, "the draft, chosen");
    expect(sheet()!.querySelector("fieldset")!.getAttribute("aria-busy")).toBe("false");
    expect(addButton()!.disabled).toBe(false);
  });

  it("a new workout's Undo puts back the draft the device held when the Add was made — read then, not as the sheet saw it", async () => {
    serve();
    // The sheet read no draft; another tab then started one before Add.
    const held = { draft: null as StudioDraft | null };
    const { store, answer } = lateStore(held);
    let done: AddDone | null = null;
    mountSheet(store, (d) => (done = d));
    await act(async () => answer());
    await until(() => option("To a new workout")?.checked === true, "a new workout");
    const elsewhere = draftDoc("Started in another tab");
    held.draft = { doc: elsewhere, updatedAt: 1 };
    await click(addButton(), "Add");
    await until(() => done !== null, "the Add");
    expect(held.draft?.doc.title).toBe("New workout");
    await act(async () => done!.undo());
    expect(held.draft?.doc).toEqual(elsewhere);
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("a save this device could not make says so plainly — not as a connection", async () => {
    serve();
    const held = { draft: null as StudioDraft | null };
    const { store, answer } = lateStore(held);
    store.save.mockRejectedValue(new Error("QuotaExceededError"));
    mountSheet(store);
    await act(async () => answer());
    await until(() => !addButton()!.disabled, "Add");
    await click(addButton(), "Add");
    await until(() => !!sheet()!.querySelector('[role="alert"]'), "the refusal");
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe("Couldn't keep it on this device.");
  });
});

describe("the watch holds the older version (review: watchHasOlder, spec §10)", () => {
  it("the line says so, with the server's costs, and Send the new version goes through the session's own preview and Send", async () => {
    const warning = { path: "parts[1].items[1]", code: "balance", message: "Two squats in a row load the knees twice.", severity: "warning" };
    const calls = serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [{ watchHasOlder: true, warnings: [warning] }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Strength day”. Your watch has the older version.");
    expect(line()!.querySelector(".stu-added-notes")!.textContent).toBe("Two squats in a row load the knees twice.");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Send the new version"), "Send the new version");
    await until(() => !!host!.querySelector(".watch-send"), "the watch preview");
    await click(host!.querySelector(".watch-send"), "Send");
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/sessions/w1/send-to-watch")?.body).toEqual({ buildId: "b9", digest: "d9" });
    await until(() => line()?.textContent?.includes("Sending the new version to your watch.") ?? false, "sending");
    expect(calls.some((c) => c.path === "/api/sessions/watch/drain")).toBe(true);
    expect([...line()!.querySelectorAll("button")].some((b) => b.textContent === "Send the new version")).toBe(false);
  });

  it("no older copy: nothing about the watch", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect(line()!.textContent).not.toContain("watch");
  });
});

describe("Undo and Open in reach of a keyboard (review)", () => {
  it("after an Add from the list, focus is on the line — still a status — so Open and Undo are the next Tab stops", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const said = line()!.querySelector(".stu-added-said")!;
    expect(document.activeElement).toBe(said);
    expect(said.getAttribute("role")).toBe("status");
    const after = [...line()!.querySelectorAll("a, button")].map((el) => el.textContent || el.getAttribute("aria-label"));
    expect(after.slice(0, 2)).toEqual(["Open", "Undo"]);
  });

  it("an Undo that fails is an alert, and Undo stays", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [200, { error: "stale_revision", status: 409 }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => !!line()!.querySelector('[role="alert"]'), "the alert");
    expect(line()!.querySelector('[role="alert"]')!.textContent).toBe("It changed since, so it can't be undone here.");
    expect([...line()!.querySelectorAll("button")].some((b) => b.textContent === "Undo")).toBe(true);
  });
});

describe("while a write is under way (review)", () => {
  it("✕ and Escape wait for its answer: the sheet stays", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: ["hang"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    expect(addButton()!.textContent).toBe("Adding…");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(sheet()).not.toBeNull();
    await click(sheet()!.querySelector('[aria-label="Close"]'), "Close");
    expect(sheet()).not.toBeNull();
  });
});

describe("a template's Undo (review)", () => {
  it("refuses, plainly, when the template changed since the Add", async () => {
    const t = template();
    const calls = serve({ templates: [[t], [t], [{ ...t, updatedAt: "2026-10-11T09:00:00Z" }]] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a template"), "the template");
    await click(option("To a template"), "the template choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => !!line()!.querySelector('[role="alert"]'), "the refusal");
    expect(line()!.querySelector('[role="alert"]')!.textContent).toBe("That template changed since, so it can't be undone here.");
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/templates/t1")).toHaveLength(1);
  });
});

// ── Fix round 2 ────────────────────────────────────────────────────────────

describe("fix round 2: the watch, the line, the wait, the draft row", () => {
  it("after Send the new version, focus rests on the line's words, not the page", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [{ watchHasOlder: true }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    const send = [...line()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send the new version")!;
    send.focus();
    await click(send, "Send the new version");
    await until(() => !!host!.querySelector(".watch-send"), "the watch preview");
    await click(host!.querySelector(".watch-send"), "Send");
    await until(() => line()?.textContent?.includes("Sending the new version") ?? false, "sending");
    expect(document.activeElement).toBe(line()!.querySelector(".stu-added-said"));
  });

  it("the server's costs are inside the status region, so they are announced with the words", async () => {
    const warning = { path: "parts[1]", code: "balance", message: "Two squats in a row load the knees twice.", severity: "warning" };
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [{ warnings: [warning] }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    expect(line()!.querySelector('[role="status"] .stu-added-notes')?.textContent).toBe("Two squats in a row load the knees twice.");
  });

  it("Undo carries what the server says of the watch — and claims the copy there has the move only when the Add's version was sent", async () => {
    // Round 3: `watchHasOlder` compares revisions, not content — after an unsent Add it is true both ways.
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [{ watchHasOlder: true }, { watchHasOlder: true }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Undone. Your watch has an older version.");
    expect(line()!.textContent).not.toContain("copy with");
    expect([...line()!.querySelectorAll("button")].some((b) => b.textContent === "Send this version")).toBe(true);
  });

  it("Undo after the Add's version went to the watch: the watch has the copy with the move, with Send", async () => {
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: [{ watchHasOlder: true }, { watchHasOlder: true }] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Send the new version"), "Send the new version");
    await until(() => !!host!.querySelector(".watch-send"), "the watch preview");
    await click(host!.querySelector(".watch-send"), "Send");
    await until(() => line()?.textContent?.includes("Sending the new version") ?? false, "sending");
    await click([...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo"), "Undo");
    await until(() => line()?.textContent?.includes("Undone.") ?? false, "Undone");
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Undone. Your watch has the copy with Goblet squat.");
    expect([...line()!.querySelectorAll("button")].some((b) => b.textContent === "Send this version")).toBe(true);
  });

  it("✕ and Escape wait for a write only so long: past the wait the sheet may close, and the page keeps the answer", async () => {
    SAVE_PATIENCE.ms = 60;
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: ["held"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    // Within the wait, Escape does nothing.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(sheet()).not.toBeNull();
    await until(() => sheet()?.textContent?.includes("Still saving…") ?? false, "Still saving");
    expect(sheet()!.querySelector(".stu-add-wait")!.getAttribute("role")).toBe("status");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(sheet()).toBeNull();
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Still saving…");
    // Focus is back on the row's ＋, where the closed sheet left it.
    const plus = host!.querySelector<HTMLElement>('[aria-label="Add Goblet squat"]')!;
    plus.focus();
    await act(async () => releaseHeld());
    await until(() => line()?.textContent?.includes("Added to Main") ?? false, "the answer, on the page");
    expect(line()!.querySelector(".stu-added-text")!.textContent).toBe("Added to Main in “Strength day”.");
    expect([...line()!.querySelectorAll("button")].some((b) => b.textContent === "Undo")).toBe(true);
    // The answer brings Open and Undo: focus moves to the line, so they are the next stops.
    expect(document.activeElement).toBe(line()!.querySelector(".stu-added-said"));
  });

  it("a slow answer leaves focus alone when the athlete has moved on", async () => {
    SAVE_PATIENCE.ms = 60;
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: ["held"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => sheet()?.textContent?.includes("Still saving…") ?? false, "Still saving");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    const field = host!.querySelector<HTMLInputElement>('input[type="search"]')!;
    field.focus();
    await act(async () => releaseHeld());
    await until(() => line()?.textContent?.includes("Added to Main") ?? false, "the answer");
    expect(document.activeElement).toBe(field);
  });

  it("a slow answer for a line a newer Add has replaced arms nothing: focus never jumps there later", async () => {
    SAVE_PATIENCE.ms = 60;
    serve({ workouts: [planned({ id: "w1" })], docs: [{ doc: storedDoc("Strength day"), rev: 3 }], revise: ["held"] });
    await openAdd("goblet", "Goblet squat");
    await until(() => !!offered("To a planned workout"), "the planned workout");
    await click(option("To a planned workout"), "the planned choice");
    await click(addButton(), "Add");
    await until(() => sheet()?.textContent?.includes("Still saving…") ?? false, "Still saving");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(sheet()).toBeNull();
    // A newer Add, from another row, to a new workout: its line replaces the slow one.
    await click(host!.querySelector('[aria-label="Add Goblet carry"]'), "Add Goblet carry");
    await until(() => !!sheet(), "the second Add sheet");
    await settle(20);
    await click(option("To a new workout"), "a new workout");
    await click(addButton(), "Add");
    await until(() => !sheet() && !!line() && line()!.querySelector(".stu-added-text")!.textContent !== "Still saving…", "the newer line");
    const newer = line()!.querySelector(".stu-added-said");
    // The first answer lands while focus is back on its row's ＋ — but its line is gone.
    const plus = host!.querySelector<HTMLElement>('[aria-label="Add Goblet squat"]')!;
    plus.focus();
    await act(async () => releaseHeld());
    await settle(20);
    expect(document.activeElement).toBe(plus);
    // Later renders (the athlete types on) leave focus where it is.
    const field = host!.querySelector<HTMLInputElement>('input[type="search"]')!;
    field.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(field, "goblet c");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(20);
    expect(document.activeElement).toBe(field);
    expect(document.activeElement).not.toBe(newer);
  });

  it("the draft row is the first read's, for the sheet's life: a draft appearing later adds no row", async () => {
    serve();
    const held = { draft: null as StudioDraft | null };
    const { store, answer } = lateStore(held);
    const client = mountSheet(store);
    await act(async () => answer());
    await until(() => option("To a new workout")?.checked === true, "a new workout");
    const before = [...sheet()!.querySelectorAll(".stu-choice")].map((l) => l.textContent?.trim());
    await act(async () => {
      client.setQueryData(["studio-draft"], { doc: draftDoc("Started in another tab"), updatedAt: 3 });
    });
    await settle(10);
    expect([...sheet()!.querySelectorAll(".stu-choice")].map((l) => l.textContent?.trim())).toEqual(before);
    expect(option("To a new workout")!.checked).toBe(true);
    expect(sheet()!.textContent).not.toContain("Replaces");
  });
});

describe("Open on the line (Stage 2 whole-branch review M9)", () => {
  it("hands the builder its way back: the search the Add was made from", async () => {
    serve();
    await openAdd("goblet", "Goblet squat");
    await click(addButton(), "Add");
    await until(() => !!line(), "the line");
    await click([...line()!.querySelectorAll("a")].find((a) => a.textContent === "Open"), "Open");
    expect(where).toBe("/studio/build/new");
    expect(whereState).toEqual({ from: { href: "/studio?q=goblet" } });
  });
});

describe("offline (Stage 2 whole-branch review M5)", () => {
  it("the planned-workout and template choices say they need a connection — never a wait that does not end", async () => {
    onlineManager.setOnline(false);
    try {
      serve();
      await openAdd("goblet", "Goblet squat");
      await until(() => (sheet()?.textContent ?? "").includes("Needs a connection"), "the words");
      const rows = [...sheet()!.querySelectorAll<HTMLElement>(".stu-add-opt")].map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim());
      expect(rows.find((r) => r.startsWith("To a planned workout"))).toContain("Needs a connection");
      expect(rows.find((r) => r.startsWith("To a template"))).toContain("Needs a connection");
      expect(sheet()!.textContent).not.toContain("…");
      // A new workout needs no connection: it is still offered, and chosen.
      expect(option("To a new workout")!.checked).toBe(true);
    } finally {
      await act(async () => {
        onlineManager.setOnline(true);
      });
    }
  });
});
