// @vitest-environment jsdom
/**
 * Phase 2c Task 3 — Settings gains Health conditions, Places & equipment, Units (weights lb/kg) and Import (mocks §7).
 *
 *  - Labels are plain and every condition word comes from the profile registry (via the API): a profile this test
 *    makes up is shown by its own name, and no other condition word appears.
 *  - Review Focus 3: a weight list typed as "10, 15, 20 lb, 12kg" is sent exactly as typed and shown back as typed.
 *  - Units save on a tap, one setting at a time; Scheduling saves only its own fields, so it can never put back a unit
 *    (or any other setting) changed elsewhere since the page opened.
 *  - The Import card stays hidden until the garden gate (`features.import`): nothing reaches the importer.
 */
import { act, createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import type { ConditionSettingDto, PlaceDto, ProvenanceImportSummaryDto, StandaloneImportSummaryDto } from "@rg/api-client";
import { features } from "../src/features.js";
import {
  HealthConditionsSection,
  ImportSection,
  PlacesSection,
  SchedulingSection,
  UnitsSection,
} from "../src/screens/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VOCAB = [
  { id: "mat", label: "Mat", weighted: false },
  { id: "kettlebell", label: "Kettlebell", weighted: true },
  { id: "dumbbells", label: "Dumbbells", weighted: true },
  { id: "band", label: "Resistance band", weighted: false },
  { id: "massage-ball", label: "Massage ball", weighted: false },
];

/** A worker in memory: what the cards read and write. */
function fakeWorker(init: { conditions?: ConditionSettingDto[]; places?: PlaceDto[]; prefs?: Partial<UserPreferences>; deleteRefusal?: { id: string; name: string } } = {}) {
  const state = {
    conditions: init.conditions ?? [{ profileId: "p-x", label: "Knee", active: false, since: null }],
    places: init.places ?? [],
    prefs: { ...DEFAULT_USER_PREFERENCES, ...init.prefs } as UserPreferences,
  };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      const body = req?.body ? JSON.parse(String(req.body)) : null;
      const path = url.replace(/\?.*$/, "");
      calls.push({ method, path: url, body });
      if (path === "/api/conditions" && method === "GET") return json({ profiles: state.conditions });
      if (path === "/api/conditions" && method === "PUT") {
        state.conditions = state.conditions.map((c) => (c.profileId === body.profileId ? { ...c, active: body.active, since: c.since ?? "2026-06-02" } : c));
        return json({ profiles: state.conditions });
      }
      if (path === "/api/places" && method === "GET") return json({ places: state.places, equipment: VOCAB });
      if (path === "/api/places" && method === "POST") {
        const place = { id: `pl${state.places.length + 1}`, name: body.name, equipment: body.equipment, implements: body.implements ?? {}, isDefault: state.places.length === 0 };
        state.places.push(place);
        return json({ place }, 201);
      }
      const m = path.match(/^\/api\/places\/(.+)$/);
      if (m && method === "PATCH") {
        state.places = state.places.map((p) => (p.id === m[1] ? { ...p, ...body } : p));
        return json({ place: state.places.find((p) => p.id === m[1]) });
      }
      if (m && method === "DELETE") {
        if (init.deleteRefusal) return json({ error: "place_in_use", program: init.deleteRefusal }, 409);
        state.places = state.places.filter((p) => p.id !== m[1]);
        return json({ ok: true });
      }
      if (path === "/api/settings" && method === "GET") return json({ prefs: state.prefs, llm: null });
      if (path === "/api/settings" && method === "PUT") {
        state.prefs = { ...state.prefs, ...body };
        return json({ ok: true, prefs: state.prefs });
      }
      if (path === "/api/library") {
        return json({
          total: 3, items: [], place: { id: "home", name: "Home" }, profiles: [],
          wishlist: state.prefs.equipmentWishlist.map((id) => ({ equipmentId: id, label: VOCAB.find((v) => v.id === id)!.label, unlocks: id === "band" ? 11 : 6 })),
        });
      }
      return json({});
    }),
  );
  return { state, calls };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, el));
  });
}

beforeEach(() => {
  features.import = false;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  features.import = false;
});

const all = () => [...document.querySelectorAll<HTMLElement>("button, input, select, [role=switch]")];
const label = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
const byName = (name: string) => all().find((b) => label(b) === name);
const press = async (name: string) => {
  const b = byName(name);
  if (!b) throw new Error(`no control "${name}"\n${document.body.textContent}`);
  await act(async () => {
    b.click();
  });
};
const setValue = async (el: HTMLElement | undefined, value: string) => {
  if (!el) throw new Error("no field");
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
}
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

describe("Health conditions", () => {
  it("lists each profile by its own name with a switch; the day it was first on shows while it is on", async () => {
    const { calls } = fakeWorker();
    mount(createElement(HealthConditionsSection));
    await until(() => text().includes("Knee"), "the profile");
    expect(text()).toContain("Health conditions");
    // No condition word of the UI's own.
    expect(text()).not.toMatch(/TMJ|Jaw|jaw/);
    const sw = byName("Knee")!;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(text()).not.toContain("Since");
    await press("Knee");
    await until(() => byName("Knee")?.getAttribute("aria-checked") === "true", "switched on");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([{ method: "PUT", path: "/api/conditions", body: { profileId: "p-x", active: true } }]);
    expect(text()).toContain("Since Jun 2");
  });
});

describe("Health conditions, switched off", () => {
  it("shows no day for a profile switched off, though it keeps its first day", async () => {
    fakeWorker({ conditions: [{ profileId: "p-x", label: "Knee", active: false, since: "2026-06-02" }] });
    mount(createElement(HealthConditionsSection));
    await until(() => text().includes("Knee"), "the profile");
    expect(text()).not.toContain("Since");
  });
});

describe("Places & equipment", () => {
  const HOME: PlaceDto = { id: "pl1", name: "Home", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20, 25 lb" }, isDefault: true };

  it("lists each place with its gear by label and its weights as typed", async () => {
    fakeWorker({ places: [HOME, { id: "pl2", name: "Gym", equipment: ["mat", "dumbbells"], implements: {}, isDefault: false }] });
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => text().includes("Gym"), "the places");
    const rows = [...document.querySelectorAll(".place-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows[0]).toContain("Home");
    expect(rows[0]).toContain("Mat · Kettlebell");
    expect(rows[0]).toContain("Kettlebell: 10, 15, 20, 25 lb");
    expect(rows[0]).toContain("Default");
    expect(rows[1]).toContain("Mat · Dumbbells");
    expect(rows[1]).not.toContain("Default");
  });

  it("a list kept with no unit shows the unit the build reads it in (Audit 2c-A MINOR-4)", async () => {
    const bare: PlaceDto = { ...HOME, implements: { kettlebell: "10, 15, 20" } };
    fakeWorker({ places: [bare], prefs: { weightUnit: "kg" } });
    mount(createElement(PlacesSection, { prefs: { ...DEFAULT_USER_PREFERENCES, weightUnit: "kg" } }));
    await until(() => text().includes("Kettlebell: 10, 15, 20 kg"), "the unit on the card");
  });

  it("Review Focus 3: a list typed \"10, 15, 20 lb, 12kg\" is sent exactly as typed and shown back as typed", async () => {
    const { calls, state } = fakeWorker({ places: [HOME] });
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => !!document.querySelector(".place-row"), "the place");
    await act(async () => document.querySelector<HTMLButtonElement>(".place-row")!.click());
    await until(() => !!byName("Kettlebell weights"), "the sheet");
    expect((byName("Kettlebell weights") as HTMLInputElement).value).toBe("10, 15, 20, 25 lb");
    await setValue(byName("Kettlebell weights"), "10, 15, 20 lb, 12kg");
    await press("Save");
    await until(() => calls.some((c) => c.method === "PATCH"), "the save");
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Home", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20 lb, 12kg" } });
    expect(state.places[0]!.implements.kettlebell).toBe("10, 15, 20 lb, 12kg");
    await until(() => text().includes("Kettlebell: 10, 15, 20 lb, 12kg"), "the card shows it as typed");
    await act(async () => document.querySelector<HTMLButtonElement>(".place-row")!.click());
    await until(() => !!byName("Kettlebell weights"), "the sheet again");
    expect((byName("Kettlebell weights") as HTMLInputElement).value).toBe("10, 15, 20 lb, 12kg");
  });

  it("a list that is not weights says which part, and nothing is sent", async () => {
    const { calls } = fakeWorker({ places: [HOME] });
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => !!document.querySelector(".place-row"), "the place");
    await act(async () => document.querySelector<HTMLButtonElement>(".place-row")!.click());
    await until(() => !!byName("Kettlebell weights"), "the sheet");
    await setValue(byName("Kettlebell weights"), "10, 12 stone");
    await press("Save");
    expect(text()).toContain("“12 stone” isn't a weight");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a new place: gear by toggles, weights only for gear that takes them, then it is listed", async () => {
    const { calls } = fakeWorker();
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => !!byName("Add a place"), "the add button");
    await until(() => !(byName("Add a place") as HTMLButtonElement).disabled, "the places loaded");
    await press("Add a place");
    await until(() => !!byName("Name"), "the sheet");
    await setValue(byName("Name"), "Garage");
    expect(byName("Kettlebell weights")).toBeUndefined();
    await press("Mat");
    await press("Kettlebell");
    expect(byName("Mat")!.getAttribute("aria-pressed")).toBe("true");
    expect(byName("Mat weights")).toBeUndefined();
    await setValue(byName("Kettlebell weights"), "8, 12, 16 kg");
    await press("Save");
    await until(() => calls.some((c) => c.method === "POST"), "the create");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Garage", equipment: ["mat", "kettlebell"], implements: { kettlebell: "8, 12, 16 kg" } });
    await until(() => text().includes("Garage"), "listed");
  });

  it("a place a program builds at is not deleted: the sheet names the program", async () => {
    fakeWorker({ places: [HOME], deleteRefusal: { id: "p1", name: "Mornings" } });
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => !!document.querySelector(".place-row"), "the place");
    await act(async () => document.querySelector<HTMLButtonElement>(".place-row")!.click());
    await press("Delete…");
    await press("Delete place");
    await until(() => text().includes("Mornings"), "the refusal");
    expect(text()).toContain("Home");
  });

  it("the wishlist never offers gear the default place already has (Audit 2c-A MINOR-7)", async () => {
    fakeWorker({ places: [HOME] });
    mount(createElement(PlacesSection, { prefs: DEFAULT_USER_PREFERENCES }));
    await until(() => !!byName("Add to wishlist"), "the wishlist picker");
    const offered = [...(byName("Add to wishlist") as HTMLSelectElement).options].map((o) => o.value);
    expect(offered).not.toContain("mat");
    expect(offered).not.toContain("kettlebell");
    expect(offered).toContain("band");
  });

  it("the wishlist: what each item would unlock, remove one, add another — one setting saved each time", async () => {
    const { calls } = fakeWorker({ prefs: { equipmentWishlist: ["band"] } });
    mount(createElement(PlacesSection, { prefs: { ...DEFAULT_USER_PREFERENCES, equipmentWishlist: ["band"] } }));
    await until(() => text().includes("+11 moves"), "the counts");
    expect(text()).toContain("Resistance band");
    await setValue(byName("Add to wishlist"), "massage-ball");
    await until(() => calls.some((c) => c.method === "PUT"), "the add");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ equipmentWishlist: ["band", "massage-ball"] }]);
    const rows = () => [...document.querySelectorAll(".setting-row")].map((r) => r.textContent ?? "");
    await until(
      () => calls.filter((c) => c.path === "/api/settings" && c.method === "GET").length >= 2 && rows().some((r) => r.includes("Massage ball")) && !(byName("Remove Resistance band") as HTMLButtonElement).disabled,
      "the add saved and read back",
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rows().filter((r) => r.includes("Resistance band") || r.includes("Massage ball"))).toHaveLength(2);
    await press("Remove Resistance band");
    await until(() => calls.filter((c) => c.method === "PUT").length === 2, "the remove");
    expect(calls.filter((c) => c.method === "PUT")[1]!.body).toEqual({ equipmentWishlist: ["massage-ball"] });
    await until(() => ![...document.querySelectorAll(".setting-row")].some((r) => r.textContent?.includes("Resistance band")), "removed");
  });
});

describe("Units", () => {
  it("distance, temperature and weights, each saved alone on a tap", async () => {
    const { calls } = fakeWorker();
    mount(createElement(UnitsSection, { prefs: { ...DEFAULT_USER_PREFERENCES, units: "km", temperatureUnit: "F", weightUnit: "lb" } }));
    const pressed = (group: string) => [...document.querySelectorAll(`[aria-label="${group}"] [aria-pressed="true"]`)].map((b) => b.textContent);
    expect(pressed("Distance")).toEqual(["km"]);
    expect(pressed("Temperature")).toEqual(["°F"]);
    expect(pressed("Weights")).toEqual(["lb"]);
    // As on the page: the settings are loaded before a unit is tapped.
    await until(() => calls.some((c) => c.path === "/api/settings"), "the settings read");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Weights"] button:last-child')!.click());
    const writes = () => calls.filter((c) => c.method !== "GET");
    await until(() => writes().length > 0 && pressed("Weights")[0] === "kg", "the save, shown at once");
    expect(writes()).toEqual([{ method: "PUT", path: "/api/settings", body: { weightUnit: "kg" } }]);
    // Saved and read back: still kg, nothing else moved.
    await until(() => calls.filter((c) => c.path === "/api/settings" && c.method === "GET").length >= 2 && !document.querySelector('[aria-label="Weights"] button:disabled'), "the save settled");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(pressed("Weights")).toEqual(["kg"]);
    expect(pressed("Distance")).toEqual(["km"]);
    expect(writes()).toHaveLength(1);
  });
});

describe("Scheduling", () => {
  it("saves its own fields only — never a unit or a switch another card owns", async () => {
    const { calls } = fakeWorker();
    mount(createElement(SchedulingSection, { prefs: { ...DEFAULT_USER_PREFERENCES, units: "mi", weightUnit: "kg", aiEnabled: false } }));
    await press("Save scheduling");
    await until(() => calls.some((c) => c.method === "PUT"), "the save");
    const body = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    for (const k of ["units", "temperatureUnit", "weightUnit", "equipmentWishlist", "aiEnabled", "corosWritesEnabled", "theme", "gardenRestMode"]) {
      expect(body, k).not.toHaveProperty(k);
    }
    expect(body).toMatchObject({ weekdayMorningTime: "07:00", timezone: DEFAULT_USER_PREFERENCES.timezone });
  });
});

describe("Import", () => {
  it("is hidden until the garden gate: no card, no file picker", () => {
    fakeWorker();
    mount(createElement(ImportSection));
    expect(host!.innerHTML).toBe("");
  });

  it("with the gate open, the standalone row takes a backup file", () => {
    features.import = true;
    fakeWorker();
    mount(createElement(ImportSection));
    expect(text()).toContain("From the standalone tool…");
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

// ── Phase 2c Task 5: the summary sheet (mocks §7) and the result sheet (the tool's numbers, to compare) ────────────

/** A synthetic summary, as the worker answers it (with `?dryRun=1`: the same, nothing written). */
type SummaryOver = Partial<Pick<StandaloneImportSummaryDto, "dryRun" | "firstImport" | "program" | "weightUnit" | "places" | "ratings">> & {
  added?: number;
  invalid?: number;
  firstDate?: string;
  lastDate?: string;
  addedFirstDate?: string | null;
  addedLastDate?: string | null;
};
function summary(over: SummaryOver = {}): StandaloneImportSummaryDto {
  const weeks = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
  const added = over.added ?? 18;
  const firstDate = over.firstDate ?? "2026-08-03";
  const lastDate = over.lastDate ?? "2026-09-30";
  return {
    dryRun: over.dryRun ?? true,
    firstImport: over.firstImport ?? true,
    sessions: {
      total: 18, added, alreadyImported: 18 - added, firstDate, lastDate,
      addedFirstDate: over.addedFirstDate !== undefined ? over.addedFirstDate : added ? firstDate : null,
      addedLastDate: over.addedLastDate !== undefined ? over.addedLastDate : added ? lastDate : null,
      invalid: Array.from({ length: over.invalid ?? 0 }, (_, i) => ({ index: i, id: null, reason: "date: invalid" })),
    },
    unknownMoves: 0,
    program: over.program ?? { outcome: "created", name: "Care" },
    weightUnit: over.weightUnit ?? { before: "lb", after: "lb" },
    places: over.places ?? ["Apartment", "Gym", "Mat only"],
    ratings: over.ratings ?? 2,
    block: { number: 2, week: 3, weeks: 5 },
    dropped: [],
    written: { sessions: added, sets: 40, checks: 30, activities: added, program: 1, block: 1, places: 3, prefs: 5, condition: 1, preferences: 1 },
    oracle: {
      unit: "lb",
      sessionCount: 18,
      sessionsPerWeek: weeks.map((week, i) => ({ week, sessions: i === 7 ? 0 : 2 })),
      weeklyVolume: weeks.map((week, i) => ({ week, kg: i === 7 ? 0 : 700 + 10 * i, inUnit: i === 7 ? 0 : Math.round((700 + 10 * i) * 2.20462262) })),
      bestByCoreLift: [
        { family: "squat", exerciseId: "gobletSquat", name: "Goblet squat", best: { w: { v: 40, u: "lb" }, reps: 5, secs: null }, latest: { date: "2026-09-30", w: { v: 35, u: "lb" }, reps: 8, secs: null } },
        { family: "hinge", exerciseId: "deadlift", name: "Deadlift", best: { w: { v: 16, u: "kg" }, reps: 8, secs: null }, latest: { date: "2026-09-28", w: { v: 16, u: "kg" }, reps: 6, secs: null } },
        { family: "press", exerciseId: "floorPress", name: "Floor press", best: null, latest: null },
      ],
      records: 7,
      prePostPairs: 16,
      block: { number: 2, week: 3 },
    },
  };
}

/** The worker the Import card talks to: the dry run and the import answer `answer(dryRun)`. */
/** A refusal the worker answers instead of a summary. */
type Refusal = { status: number; body: unknown };
function importWorker(answer: (dryRun: boolean) => StandaloneImportSummaryDto | Refusal | null) {
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      if (url.startsWith("/api/import/standalone") && req?.method === "POST") {
        calls.push({ path: url, body: JSON.parse(String(req.body)) });
        const s = answer(url.includes("dryRun=1"));
        if (s && "status" in s) return new Response(JSON.stringify(s.body), { status: s.status, headers: { "Content-Type": "application/json" } });
        return s
          ? new Response(JSON.stringify(s), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ error: "invalid_backup", issues: [] }), { status: 422, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

const BACKUP = { app: "tmj_tool", version: 2, sessions: [], lastExport: "2026-09-30T08:00:00.000Z" };

async function choose(contents: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([contents], "backup.json", { type: "application/json" });
  // jsdom's File has no text(); a browser's does.
  Object.defineProperty(file, "text", { value: async () => contents });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Each matching element's text, its separate text nodes joined by a space. */
const rowsOf = (selector: string) =>
  [...document.querySelectorAll(selector)].map((r) => {
    const parts: string[] = [];
    const walk = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.trim()) parts.push(n.textContent.trim());
    return parts.join(" ").replace(/\s+/g, " ");
  });

describe("Import: the summary sheet (mocks §7)", () => {
  beforeEach(() => {
    features.import = true;
  });

  it("a backup file is read with a dry run; the sheet says what will come in and that history stays out of the garden", async () => {
    const calls = importWorker((dry) => summary({ dryRun: dry }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("History stays out of the garden"), "the summary");
    expect(calls).toEqual([{ path: "/api/import/standalone?dryRun=1", body: BACKUP }]);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Import backup · Sep 30");
    expect(rowsOf(".import-summary .setting-row")).toEqual([
      "18 sessions Aug 3 – Sep 30, 2026",
      "Makes the program Care Block 2 · week 3 · 3 core lifts",
      "3 places · 2 ratings Apartment, Gym, Mat only",
      "Weights in lb As in the tool",
      "History stays out of the garden Activity and records show it",
    ]);
    // The tool's numbers wait for the import; nothing is written yet.
    expect(text()).not.toContain("Per week");
    expect((byName("Import") as HTMLButtonElement).disabled).toBe(false);
  });

  /** The summary sheet's rows for a dry run answering `over`. */
  async function summaryRows(over: SummaryOver) {
    importWorker((dry) => summary({ ...over, dryRun: dry }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("History stays out of the garden"), "the summary");
    return rowsOf(".import-summary .setting-row");
  }

  it("an account with its own program, no block yet: the sheet says the block goes into it (ruling 2d-R5)", async () => {
    const rows = await summaryRows({ program: { outcome: "adopted", name: "Mornings" }, places: [], ratings: 1 });
    expect(rows).toContain("Mornings takes block 2 · week 3 3 core lifts · its own settings stay");
    expect(rows.join(" | ")).not.toMatch(/Makes the program|stays as it is/);
  });

  it("an account whose program is under way: the sheet says it stays as it is, and the file's block is not used", async () => {
    const rows = await summaryRows({ program: { outcome: "kept", name: "Mornings" }, places: [], ratings: 0 });
    expect(rows).toContain("Your program Mornings stays as it is The file's block isn't used");
    expect(rows.join(" | ")).not.toMatch(/Block 2|takes block|Makes the program/);
  });

  it("several programs, none named: they all stay", async () => {
    const rows = await summaryRows({ program: { outcome: "kept", name: null } });
    expect(rows).toContain("Your programs stay as they are The file's block isn't used");
  });

  it("lists only what is written: no places row when the account keeps its own, ratings alone when some are new (Audit C M-1)", async () => {
    const rows = await summaryRows({ places: [], ratings: 1 });
    expect(rows).toContain("1 rating");
    expect(rows.join(" | ")).not.toMatch(/place|Apartment/);
    document.body.innerHTML = "";
    const none = await summaryRows({ places: [], ratings: 0 });
    expect(none.join(" | ")).not.toMatch(/rating|place/);
  });

  it("says what happens to the weight unit: switched to the tool's, or the account's kept (ruling 2d-R6)", async () => {
    expect(await summaryRows({ weightUnit: { before: "lb", after: "kg" } })).toContain("Weights switch to kg The tool's setting");
    document.body.innerHTML = "";
    importWorker((dry) => {
      const s = summary({ dryRun: dry, weightUnit: { before: "lb", after: "lb" } });
      return { ...s, oracle: { ...s.oracle, unit: "kg" } };
    });
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("History stays out of the garden"), "the summary");
    expect(rowsOf(".import-summary .setting-row")).toContain("Weights stay in lb Your setting here");
  });

  it("a later import: the new sessions and their own span, and that nothing else changes (Audit C M-1, M-2)", async () => {
    const rows = await summaryRows({ firstImport: false, added: 4, addedFirstDate: "2026-10-05", addedLastDate: "2026-10-07" });
    expect(rows).toEqual([
      "4 new sessions Oct 5 – Oct 7, 2026",
      "Nothing else changes Program, places and settings stay as they are",
      "History stays out of the garden Activity and records show it",
    ]);
  });

  it("a span across a new year carries both years and reads oldest first; one session is one session (Audit C M-2)", async () => {
    const rows = await summaryRows({ added: 183, firstDate: "2025-10-06", lastDate: "2026-09-28" });
    expect(rows[0]).toBe("183 sessions Oct 6, 2025 – Sep 28, 2026");
    document.body.innerHTML = "";
    const one = await summaryRows({ added: 1, invalid: 1, firstDate: "2026-09-28", lastDate: "2026-09-28" });
    expect(one[0]).toBe("1 session Sep 28, 2026");
    expect(text()).toContain("1 session skipped");
    expect(text()).not.toContain("1 sessions");
  });

  it("a first import whose file brings no new session still offers Import: its settings and block come in (Audit C M-8)", async () => {
    await summaryRows({ added: 0, firstImport: true, program: { outcome: "adopted", name: "Mornings" } });
    expect(text()).not.toContain("Nothing new to import");
    expect((byName("Import") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a file that is not a backup says so, and nothing is sent", async () => {
    const calls = importWorker(() => summary());
    mount(createElement(ImportSection));
    await choose("{not json");
    await until(() => text().includes("That file isn't a backup from the standalone tool."), "the refusal");
    expect(calls).toEqual([]);
  });

  it("a JSON file the worker refuses says so in the sheet, and Import stays off", async () => {
    importWorker(() => null);
    mount(createElement(ImportSection));
    await choose(JSON.stringify({ hello: 1 }));
    await until(() => text().includes("That file isn't a backup from the standalone tool."), "the refusal");
    expect((byName("Import") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says how many sessions it skips", async () => {
    importWorker((dry) => summary({ dryRun: dry, invalid: 2 }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("2 sessions skipped"), "the skipped count");
  });
});

describe("Import: each refusal in its own words (Audit C M-3)", () => {
  beforeEach(() => {
    features.import = true;
  });

  it("a backup from a newer version of the tool says so, not that it isn't a backup", async () => {
    importWorker(() => ({ status: 422, body: { error: "invalid_backup", reason: "newer_version", issues: [] } }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify({ ...BACKUP, version: 3 }));
    await until(() => text().includes("a newer version of the standalone tool"), "the refusal");
    expect(text()).not.toContain("isn't a backup");
    expect((byName("Import") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a dry run the worker cannot answer is not called a bad file", async () => {
    importWorker(() => ({ status: 500, body: { error: "internal" } }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("Couldn't read that file — try again."), "the refusal");
    expect(text()).not.toContain("isn't a backup");
  });

  async function importRefused(refusal: Refusal) {
    importWorker((dry) => (dry ? summary({ dryRun: true }) : refusal));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
  }

  it("Import while a restore runs says to import after it", async () => {
    await importRefused({ status: 423, body: { error: "restore_in_progress" } });
    await until(() => text().includes("A restore is running — import after it finishes."), "the refusal");
  });

  it("Import while another import writes says so", async () => {
    await importRefused({ status: 503, body: { error: "busy" } });
    await until(() => text().includes("Another import is running — try again in a moment."), "the refusal");
  });

  it("any other failure of Import asks to try again", async () => {
    await importRefused({ status: 500, body: { error: "internal" } });
    await until(() => text().includes("Couldn't import that — try again."), "the refusal");
  });
});

describe("Import: the row shows keyboard focus (Audit C M-4)", () => {
  it("the file row draws the focus ring when its hidden input has keyboard focus", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    const rule = css.match(/\.place-file:has\(input:focus-visible\)\s*\{([^}]*)\}/);
    expect(rule, "a .place-file:has(input:focus-visible) rule").not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--focus\)/);
  });
});

describe("Import: the result sheet — the tool's own numbers, to compare with its Progress tab", () => {
  beforeEach(() => {
    features.import = true;
  });

  async function imported() {
    const calls = importWorker((dry) => summary({ dryRun: dry }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
    await until(() => text().includes("18 sessions imported"), "the result");
    return calls;
  }

  it("Import sends the file once, without the dry run; the sheet then shows what came in", async () => {
    const calls = await imported();
    expect(calls.map((c) => c.path)).toEqual(["/api/import/standalone?dryRun=1", "/api/import/standalone"]);
    expect(calls[1]!.body).toEqual(BACKUP);
    expect(byName("Import")).toBeUndefined();
    expect(byName("Done")).toBeDefined();
    expect(rowsOf(".import-result > .setting-row")).toEqual(["18 sessions imported Aug 3 – Sep 30, 2026", "Made the program Care Block 2 · week 3 · 3 core lifts"]);
  });

  /** The result sheet's own rows after a dry run answering `dry` and an import answering `real`. */
  async function resultRows(dry: SummaryOver, real: SummaryOver) {
    importWorker((isDry) => summary({ ...(isDry ? dry : real), dryRun: isDry }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
    await until(() => text().includes("imported"), "the result");
    return rowsOf(".import-result > .setting-row");
  }

  it("says what the import did to the program, as it landed (re-review C R-4)", async () => {
    const mornings = { outcome: "adopted", name: "Mornings" } as const;
    expect((await resultRows({ program: mornings }, { program: mornings }))[1]).toBe("Mornings took block 2 · week 3 3 core lifts · its own settings stay");
    document.body.innerHTML = "";
    // The dry run said adopted, but a block the app started meanwhile kept the program as it was: the result says so.
    const kept = await resultRows({ program: mornings }, { program: { outcome: "kept", name: "Mornings" } });
    expect(kept[1]).toBe("Your program Mornings stays as it is The file's block isn't used");
    expect(kept.join(" | ")).not.toMatch(/took block|takes block/);
  });

  it("one session imported is one session, and its span is the new sessions' (Audit C M-2)", async () => {
    importWorker((dry) => summary({ dryRun: dry, added: 1, firstImport: false, addedFirstDate: "2026-10-07", addedLastDate: "2026-10-07" }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
    await until(() => text().includes("1 session imported"), "the result");
    expect(rowsOf(".import-result > .setting-row")).toEqual(["1 session imported Oct 7, 2026"]);
  });

  it("the totals as the tool shows them: sessions, records, before-and-after pairs, the block", async () => {
    await imported();
    // The block is the tool's: the app's program may be on its own (a kept import, re-review C R-4).
    expect(rowsOf(".import-compare .setting-row")).toEqual(["Sessions 18", "Records 7", "Before and after 16", "Block in the tool 2 · week 3"]);
  });

  it("each of the last eight weeks: sessions, and volume in the tool's unit beside the whole kilos", async () => {
    await imported();
    const head = rowsOf(".import-weeks thead th");
    expect(head).toEqual(["Week", "Sessions", "lb", "kg"]);
    const rows = [...document.querySelectorAll(".import-weeks tbody tr")].map((tr) => [...tr.querySelectorAll("th, td")].map((c) => c.textContent));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(["Aug 10", "2", "1,543", "700"]);
    expect(rows[7]).toEqual(["Sep 28", "0", "0", "0"]);
  });

  it("each core lift: its latest top set as the tool's lift tile shows it, in the tool's unit, and its best", async () => {
    await imported();
    expect(rowsOf(".import-lifts .setting-row")).toEqual([
      "Goblet squat Latest 35 lb × 8 Best 40 lb × 5",
      "Deadlift Latest 35.5 lb × 6 Best 35.5 lb × 8",
      "Floor press Not logged",
    ]);
  });

  it("a tool set to kilograms shows one volume column", async () => {
    importWorker((dry) => {
      const s = summary({ dryRun: dry });
      return { ...s, oracle: { ...s.oracle, unit: "kg", weeklyVolume: s.oracle.weeklyVolume.map((w) => ({ ...w, inUnit: w.kg })) } };
    });
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
    await until(() => text().includes("18 sessions imported"), "the result");
    expect(rowsOf(".import-weeks thead th")).toEqual(["Week", "Sessions", "kg"]);
    expect(rowsOf(".import-lifts .setting-row")[1]).toBe("Deadlift Latest 16 kg × 6 Best 16 kg × 8");
  });

  it("a backup already imported: nothing to import, and the numbers to compare straight away", async () => {
    const calls = importWorker((dry) => summary({ dryRun: dry, added: 0, firstImport: false }));
    mount(createElement(ImportSection));
    await choose(JSON.stringify(BACKUP));
    await until(() => text().includes("Nothing new to import"), "the summary");
    expect(byName("Import")).toBeUndefined();
    expect(rowsOf(".import-compare .setting-row")[0]).toBe("Sessions 18");
    await press("Done");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("Done closes the sheet; plain labels, and no condition word of the UI's own", async () => {
    await imported();
    expect(text()).not.toMatch(/TMJ|Jaw|jaw/);
    await press("Done");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

// ── Phase 2c Task 6: Settings → Import → "Saved-post links…" (the private file the local builder writes) ──────────

/** A synthetic summary of `POST /api/import/provenance` — counts only, as the worker answers. */
function linksSummary(over: Partial<ProvenanceImportSummaryDto> = {}): ProvenanceImportSummaryDto {
  return { dryRun: true, items: 3, moves: 2, added: 2, updated: 1, unchanged: 0, unknownMoves: 0, ...over };
}
/** A synthetic links file (the builder's format, made-up items with no link). */
const LINKS = { format: "rg-provenance", version: 1, items: [{ exerciseId: "gobletSquat", sourceType: "example", url: null, creator: null, sourceKey: "k1" }] };

function linksWorker(answer: (dryRun: boolean) => ProvenanceImportSummaryDto | Refusal) {
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, req?: RequestInit) => {
      if (url.startsWith("/api/import/provenance") && req?.method === "POST") {
        calls.push({ path: url, body: JSON.parse(String(req.body)) });
        const s = answer(url.includes("dryRun=1"));
        const [status, body] = "status" in s ? [s.status, s.body] : [200, s];
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

async function chooseLinks(contents: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Saved-post links file"]');
  if (!input) throw new Error(`no links file input\n${document.body.textContent}`);
  const file = new File([contents], "provenance.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => contents });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Import: saved-post links", () => {
  beforeEach(() => {
    features.import = true;
  });

  it("a second row takes the links file, in plain words", () => {
    linksWorker(() => linksSummary());
    mount(createElement(ImportSection));
    expect(rowsOf(".place-file")).toEqual(["From the standalone tool… Sessions, block, places and ratings ›", "Saved-post links… Where your saved moves came from ›"]);
  });

  it("reads the file with a dry run; the sheet counts the links and says they stay private", async () => {
    const calls = linksWorker((dry) => linksSummary({ dryRun: dry }));
    mount(createElement(ImportSection));
    await chooseLinks(JSON.stringify(LINKS));
    await until(() => text().includes("Stays private"), "the summary");
    expect(calls).toEqual([{ path: "/api/import/provenance?dryRun=1", body: LINKS }]);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Import saved-post links");
    expect(rowsOf(".links-summary .setting-row")).toEqual(["3 links for 2 moves 2 new · 1 changed", "Stays private Only you see where a move came from"]);
    expect((byName("Import") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says how many links name a move this library doesn't have", async () => {
    linksWorker((dry) => linksSummary({ dryRun: dry, unknownMoves: 2 }));
    mount(createElement(ImportSection));
    await chooseLinks(JSON.stringify(LINKS));
    await until(() => text().includes("2 links name a move this library doesn't have — left out"), "the left-out count");
  });

  it("Import sends the file once without the dry run, then says what came in; Done closes", async () => {
    const calls = linksWorker((dry) => linksSummary({ dryRun: dry }));
    mount(createElement(ImportSection));
    await chooseLinks(JSON.stringify(LINKS));
    await until(() => !!byName("Import") && !(byName("Import") as HTMLButtonElement).disabled, "the summary");
    await press("Import");
    await until(() => text().includes("3 links imported"), "the result");
    expect(calls.map((c) => c.path)).toEqual(["/api/import/provenance?dryRun=1", "/api/import/provenance"]);
    expect(calls[1]!.body).toEqual(LINKS);
    expect(rowsOf(".links-summary .setting-row")[0]).toBe("3 links imported 2 moves");
    expect(byName("Import")).toBeUndefined();
    await press("Done");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a file already imported: nothing new, and Done", async () => {
    const calls = linksWorker((dry) => linksSummary({ dryRun: dry, added: 0, updated: 0, unchanged: 3 }));
    mount(createElement(ImportSection));
    await chooseLinks(JSON.stringify(LINKS));
    await until(() => text().includes("Nothing new to import"), "the summary");
    expect(rowsOf(".links-summary .setting-row")[0]).toBe("Nothing new to import 3 links already here");
    expect(byName("Import")).toBeUndefined();
    await press("Done");
    expect(calls).toHaveLength(1);
  });

  it("each refusal in its own words", async () => {
    const cases: Array<[Refusal | "not json", string]> = [
      ["not json", "That file isn't a saved-post links file."],
      [{ status: 422, body: { error: "invalid_provenance", issues: [] } }, "That file isn't a saved-post links file."],
      [{ status: 422, body: { error: "invalid_provenance", reason: "newer_version", issues: [] } }, "That links file is newer than this app reads."],
      [{ status: 413, body: { error: "too_large" } }, "That file is too large to be a saved-post links file."],
      [{ status: 423, body: { error: "restore_in_progress" } }, "A restore is running — import after it finishes."],
      [{ status: 500, body: { error: "internal" } }, "Couldn't read that file — try again."],
    ];
    for (const [refusal, words] of cases) {
      linksWorker(() => (refusal === "not json" ? linksSummary() : refusal));
      mount(createElement(ImportSection));
      await chooseLinks(refusal === "not json" ? "{nope" : JSON.stringify(LINKS));
      await until(() => text().includes(words), words);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      document.body.innerHTML = "";
    }
  });
});
