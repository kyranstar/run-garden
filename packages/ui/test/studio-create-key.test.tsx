// @vitest-environment jsdom
/**
 * A retried create names what it would make (whole-branch review, server finding 2): the builder sends its draft's
 * `clientId` with `POST /api/workouts` and `POST /api/templates`, the same one when a create whose answer was lost is
 * tried again — so the server answers the workout it made, never a second, nor a second calendar event — and a new one
 * once a create has landed. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, toProposable, type DraftDoc } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { draftStore } from "../src/studio-drafts.js";
import { DEVICE_PREFS, placesDto, primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  await draftStore().clear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** The server: each create's answer, in turn — `lost` (the request went, its answer never came back) or made. */
function serve(answers: { workouts?: Array<"lost" | "made">; templates?: Array<"lost" | "made"> }, kept: unknown[] = []) {
  const bodies: { workouts: Array<{ clientId?: string }>; templates: Array<{ clientId?: string }> } = { workouts: [], templates: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "GET" && path === "/api/plan/workouts") return json({ today: TODAY, plan: null, corosWritesEnabled: false, workouts: [] });
      if (method === "GET" && path === "/api/templates") return json({ templates: kept });
      if (method === "POST" && path === "/api/workouts") {
        const n = bodies.workouts.push(body);
        if (answers.workouts?.[n - 1] === "lost") throw new TypeError("Failed to fetch");
        return json({ workout: { id: "w-new", date: body.date, time: body.time ?? "18:00", title: body.doc.title, intentSummary: "", category: "strength", sport: "strength", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: 20 }, warnings: [] }, 201);
      }
      if (method === "POST" && path === "/api/templates") {
        const n = bodies.templates.push(body);
        if (answers.templates?.[n - 1] === "lost") throw new TypeError("Failed to fetch");
        return json({ template: { id: "t-new", name: body.name, doc: body.doc, pinned: false, uses: 0, lastUsedAt: null, createdAt: "", updatedAt: "", minutes: 20, discipline: "strength" }, warnings: [] }, 201);
      }
      return json({ error: "offline" }, 503);
    }),
  );
  return bodies;
}

function mount(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"]), today: todayDto(null, false) });
  qc.setQueryData(["settings"], { prefs: DEVICE_PREFS });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: "/studio/build/*", element: createElement(BuilderRoute) }))),
      ),
    );
  });
}

const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
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
  await act(async () => (el as HTMLElement).click());
  await settle();
}
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string | RegExp, scope: ParentNode = document) =>
  buttons(scope).find((b) => (typeof name === "string" ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name : name.test(b.textContent ?? ""))) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;

function draft(): DraftDoc {
  const s = startEditing(newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } }));
  const rec = EXERCISES.find((r) => r.id === "gobletSquat")!;
  return edit(s, { type: "addItem", part: 1, item: suggestedItem(rec, "main") as never }, EXERCISES).doc;
}

describe("a create's key (clientId)", () => {
  it("Schedule tried again after its answer was lost sends the same key", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    await draftStore().save(draft());
    const sent = serve({ workouts: ["lost", "made"] });
    mount("/studio/build/new");
    await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
    await click(button("Schedule…"), "Schedule…");
    await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
    await until(() => sent.workouts.length === 1 && !!dialog("Schedule"), "the refusal");
    // Tried again from the sheet still open.
    await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
    await until(() => text().includes("Scheduled for today"), "the line");
    expect(sent.workouts).toHaveLength(2);
    expect(sent.workouts[0]!.clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent.workouts[1]!.clientId).toBe(sent.workouts[0]!.clientId);
    // A Schedule is planned: booked on the calendar as ever.
    expect((sent.workouts[0] as { startNow?: boolean }).startNow).toBeUndefined();
  });

  it("a reload between a lost Schedule and its retry still sends the same key: it is kept with the draft on the device", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    await draftStore().save(draft());
    const sent = serve({ workouts: ["lost", "made"] });
    const schedule = async () => {
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      await click(button("Schedule…"), "Schedule…");
      await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
    };
    mount("/studio/build/new");
    await schedule();
    await until(() => sent.workouts.length === 1 && !!dialog("Schedule"), "the refusal");
    // The page is reloaded: nothing of the last one's memory is left, only the device's draft.
    act(() => root!.unmount());
    host!.remove();
    mount("/studio/build/new");
    await schedule();
    await until(() => text().includes("Scheduled for today"), "the line");
    expect(sent.workouts).toHaveLength(2);
    expect(sent.workouts[0]!.clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent.workouts[1]!.clientId).toBe(sent.workouts[0]!.clientId);
    // That one landed: the workout is made, and the draft (and its key) is gone from the device.
    expect(await draftStore().load()).toBeNull();
  });

  it("a reload between a lost Save as template and its retry still sends the same key", async () => {
    await draftStore().save(draft());
    const sent = serve({ templates: ["lost", "made"] });
    const save = async () => {
      await until(() => !!button(/^Save/), "Save ▾");
      await click(button(/^Save/), "Save ▾");
      await click(document.querySelector('[role="menuitem"]'), "Save as template…");
      await click(button("Save", dialog("Save as template")!), "Save");
    };
    mount("/studio/build/new");
    await save();
    await until(() => sent.templates.length === 1, "the lost save");
    await settle(10);
    act(() => root!.unmount());
    host!.remove();
    mount("/studio/build/new");
    await save();
    await until(() => text().includes("as a template."), "the line");
    expect(sent.templates[1]!.clientId).toBe(sent.templates[0]!.clientId);
    // It landed: the draft stays, without the template's key.
    expect((await draftStore().load())?.keys?.template).toBeUndefined();
  });

  it("a template's Schedule (no draft: its key in the page's memory): a retry after a lost answer sends the same key; scheduled again once it landed, another", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 11, 14, 20) });
    const doc = toProposable(draft())!;
    const sent = serve({ workouts: ["lost", "made", "made"] }, [
      { id: "t1", name: "Hips", doc, pinned: false, uses: 0, lastUsedAt: null, createdAt: "", updatedAt: "", minutes: 20, discipline: "strength" },
    ]);
    mount("/studio/build/template/t1");
    for (const n of [1, 2, 3]) {
      await until(() => !!button("Schedule…") && !button("Schedule…")!.disabled, "Schedule…");
      if (!dialog("Schedule")) await click(button("Schedule…"), "Schedule…");
      await click(buttons(dialog("Schedule")!).find((b) => b.textContent === "Schedule"), "Schedule");
      await until(() => sent.workouts.length === n && (n === 1 || !dialog("Schedule")), `Schedule ${n}`);
    }
    expect(sent.workouts[0]!.clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent.workouts[1]!.clientId).toBe(sent.workouts[0]!.clientId);
    expect(sent.workouts[2]!.clientId).not.toBe(sent.workouts[0]!.clientId);
    // No draft was made or keyed on the device.
    expect(await draftStore().load()).toBeNull();
  });

  it("Start now tried again after its create's answer was lost sends the same key", async () => {
    await draftStore().save(draft());
    const sent = serve({ workouts: ["lost", "made"] });
    mount("/studio/build/new");
    const start = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
    await until(() => !!start() && !start()!.disabled, "Start now");
    await click(start(), "Start now");
    await until(() => sent.workouts.length === 1 && !!start() && !start()!.disabled, "Start now again");
    await click(start(), "Start now");
    await until(() => sent.workouts.length === 2, "the second create");
    expect(sent.workouts[0]!.clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent.workouts[1]!.clientId).toBe(sent.workouts[0]!.clientId);
    // Start now's workout is made to start at once: never planned, booked on no calendar (CUJ R6).
    expect(sent.workouts.map((w) => (w as { startNow?: boolean }).startNow)).toEqual([true, true]);
  });

  it("Start over is another draft: its first create never reuses the key of a lost one", async () => {
    await draftStore().save(draft());
    const sent = serve({ templates: ["lost", "made"] });
    mount("/studio/build/new");
    await until(() => !!button(/^Save/), "Save ▾");
    await click(button(/^Save/), "Save ▾");
    await click(document.querySelector('[role="menuitem"]'), "Save as template…");
    await click(button("Save", dialog("Save as template")!), "Save");
    await until(() => sent.templates.length === 1, "the lost save");
    await click(button("Close", dialog("Save as template")!), "Close");
    await click(button(/^Save/), "Save ▾");
    await click([...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes("Start over")), "Start over…");
    await click(button("Start new"), "Start new");
    // A move in the new draft, from the main part's picker.
    await click(button("Add a move", document.querySelectorAll<HTMLElement>(".stu-part")[1]!), "Add a move in Main");
    await until(() => !!dialog("Add to Main"), "the picker");
    const search = dialog("Add to Main")!.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "deadlift");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => buttons(dialog("Add to Main")!).some((b) => b.querySelector(".stu-pick-name")?.textContent === "Deadlift"), "the Deadlift row");
    await click(buttons(dialog("Add to Main")!).find((b) => b.querySelector(".stu-pick-name")?.textContent === "Deadlift"), "the Deadlift row");
    await until(() => !dialog("Add to Main"), "the picker to close");
    await click(button(/^Save/), "Save ▾");
    await click(document.querySelector('[role="menuitem"]'), "Save as template…");
    const sheet = dialog("Save as template")!;
    const input = sheet.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Another");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save", dialog("Save as template")!), "Save");
    await until(() => sent.templates.length === 2, "the new draft's save");
    expect(sent.templates[1]!.clientId).not.toBe(sent.templates[0]!.clientId);
  });

  it("Save as template tried again after its answer was lost sends the same key; once one has landed, the next sends another", async () => {
    await draftStore().save(draft());
    const sent = serve({ templates: ["lost", "made", "made"] });
    mount("/studio/build/new");
    const save = async () => {
      await until(() => !!button(/^Save/), "Save ▾");
      if (!dialog("Save as template")) {
        await click(button(/^Save/), "Save ▾");
        await click(document.querySelector('[role="menuitem"]'), "Save as template…");
      }
      await click(button("Save", dialog("Save as template")!), "Save");
    };
    await save();
    await until(() => sent.templates.length === 1, "the first save");
    await settle(10);
    await save();
    await until(() => text().includes("as a template."), "the line");
    expect(sent.templates).toHaveLength(2);
    expect(sent.templates[1]!.clientId).toBe(sent.templates[0]!.clientId);
    // That one landed: saving it again is another template, with another key.
    await save();
    await until(() => sent.templates.length === 3, "the second save");
    expect(sent.templates[2]!.clientId).not.toBe(sent.templates[0]!.clientId);
  });
});
