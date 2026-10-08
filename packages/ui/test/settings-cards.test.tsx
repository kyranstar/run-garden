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
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "@rg/domain";
import type { ConditionSettingDto, PlaceDto } from "@rg/api-client";
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
