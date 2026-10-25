// @vitest-environment jsdom
/**
 * Saved-posts import, Task 14 — THE ACCOUNT LIBRARY IN THE UI: the bundled library and the owner's own moves
 * (`GET /api/library/personal`), merged once per answer (`useAccountLibrary`). The Studio searches and browses what the
 * athlete is offered (the public library and the active moves: `StudioCtx.library`); what a document already holds — an
 * archived move too — resolves in `all`: the builder's judge, its minutes, a build made on the device, a move's detail.
 * A move's detail says it is the athlete's own and links each post it came from. With the personal read failing, the
 * Studio is the bundled library, as before.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalMoveDto, PersonalMovesDto, TemplateDto } from "@rg/api-client";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { suggestedItem } from "@rg/workout";
import { accountLibraryOf } from "../src/library/account-library.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { draftStore } from "../src/studio-drafts.js";
import { offlineDb, OFFLINE_STORES } from "../src/offline/idb.js";
import { loadBuild } from "../src/offline/builds.js";
import { DEVICE_PREFS, libraryDto, placesDto, primedClient, TODAY, todayDto, type Primed } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Synthetic personal moves (never a real post, creator or caption: example.com and made-up names) ──

const base = EXERCISES.find((r) => r.id === "bridge")!;
/** A personal move made from a library record: its own id, name and words, no ladder, no provider. */
function personal(id: string, name: string, summary: string): ExerciseRecord {
  const { providers: _providers, ...rest } = base;
  return { ...rest, id, name, legacyIds: [], easier: [], harder: [], text: { ...base.text, summary } };
}
const LANTERN = personal("myLanternReach1a2b3c", "Lantern reach", "Reach long and slow, the hips level.");
const WINDMILL = personal("myWindmillSwitch4d5e6f", "Windmill switch", "Switch sides without lifting the feet.");

const move = (record: ExerciseRecord, status: PersonalMoveDto["status"], links: PersonalMoveDto["links"]): PersonalMoveDto => ({ record, status, links });
const MOVES: PersonalMovesDto = {
  moves: [
    move(LANTERN, "active", [
      { url: "https://example.com/p/lantern-1", creator: "Example Coach" },
      { url: null, creator: "Second Example" },
    ]),
    move(WINDMILL, "archived", [{ url: "https://example.com/p/windmill", creator: "Example Coach" }]),
  ],
};

// ── The page ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const [y, m, d] = TODAY.split("-").map(Number);
  vi.setSystemTime(new Date(y!, m! - 1, d!, 9, 0));
  await draftStore().clear();
  const db = await offlineDb();
  for (const s of OFFLINE_STORES) await db.clear(s);
});

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

/**
 * The network: the personal list answers `personal` (a 503 when it is null), the templates list `templates` when given;
 * every other read fails as a dropped connection does. The paths asked, in order.
 */
function network(o: { personal?: PersonalMovesDto | null; templates?: TemplateDto[] } = {}): string[] {
  const asked: string[] = [];
  vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split("?")[0]!;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/library/personal") return o.personal ? json(o.personal) : json({ error: "unavailable" }, 503);
      if (path === "/api/templates" && o.templates) return json({ templates: o.templates });
      throw new TypeError("Failed to fetch");
    }),
  );
  return asked;
}

function mountStudio(path: string, primed: Primed = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: primedClient(primed) },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(StudioScreen), createElement(Where)),
      ),
    );
  });
}

function mountBuilder(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(["mat"]), library: libraryDto(), today: todayDto(null, false) });
  qc.setQueryData(["settings"], { prefs: DEVICE_PREFS });
  qc.setQueryData(["me"], { userId: "u1" });
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
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}
const rows = () => [...host!.querySelectorAll<HTMLAnchorElement>("a.stu-move-open")].map((a) => a.textContent);
const dialog = () => host!.querySelector<HTMLElement>('[role="dialog"]');

// ── The merge ──

describe("accountLibraryOf: the bundled library and the owner's moves, merged once per answer", () => {
  it("no answer, or no moves: both views are the bundled library itself", () => {
    expect(accountLibraryOf(undefined).all).toBe(EXERCISES);
    expect(accountLibraryOf(undefined).offered).toBe(EXERCISES);
    const none = accountLibraryOf({ moves: [] });
    expect(none.all).toBe(EXERCISES);
    expect(none.offered).toBe(EXERCISES);
  });

  it("all holds every move the account resolves; offered leaves out an archived one; one answer, one pair of arrays", () => {
    const lib = accountLibraryOf(MOVES);
    expect(lib.all.length).toBe(EXERCISES.length + 2);
    expect(lib.all.slice(0, EXERCISES.length)).toEqual(EXERCISES);
    expect(lib.all.map((r) => r.id)).toEqual(expect.arrayContaining([LANTERN.id, WINDMILL.id]));
    expect(lib.offered.map((r) => r.id)).toContain(LANTERN.id);
    expect(lib.offered.map((r) => r.id)).not.toContain(WINDMILL.id);
    expect(accountLibraryOf(MOVES)).toBe(lib);
    expect(lib.find(WINDMILL.id)?.name).toBe("Windmill switch");
    expect(lib.mine.get(LANTERN.id)?.links).toHaveLength(2);
  });

  it("a record that is not a personal id never stands in the library (it could shadow a public move)", () => {
    const fake = { ...LANTERN, id: "gobletSquat", name: "Not a goblet squat" };
    const lib = accountLibraryOf({ moves: [move(fake, "active", [])] });
    expect(lib.offered).toBe(EXERCISES);
    expect(lib.find("gobletSquat")?.name).toBe("Goblet squat");
  });
});

// ── The Studio ──

describe("the Studio offers the athlete's own moves", () => {
  it("The Studio search finds a personal move", async () => {
    network({ personal: MOVES });
    mountStudio("/studio?q=lantern");
    await until(() => rows().includes("Lantern reach"), "the personal move in the list");
  });

  it("an archived move is never offered: every move lists the active one, never the archived one", async () => {
    network({ personal: MOVES });
    mountStudio("/studio?all=1");
    await until(() => rows().includes("Lantern reach"), "the personal move in the list");
    expect(rows()).not.toContain("Windmill switch");
    expect(rows()).toHaveLength(EXERCISES.length + 1);
  });

  it("browse offers what the athlete's own moves add: a part no library move has", async () => {
    const conditioning = { ...LANTERN, purposes: ["conditioning" as const] };
    const asked = network({ personal: { moves: [move(conditioning, "active", [])] } });
    mountStudio("/studio");
    await until(() => asked.includes("GET /api/library/personal"), "the personal read");
    await until(() => [...host!.querySelectorAll("button.chip")].some((b) => b.textContent === "Conditioning"), "the Conditioning part");
  });

  it("With the personal read failing, the Studio still lists the library", async () => {
    const asked = network({ personal: null });
    mountStudio("/studio?q=goblet");
    await until(() => asked.includes("GET /api/library/personal"), "the personal read");
    await settle(20);
    expect(rows()).toContain("Goblet squat");
    expect(rows()).not.toContain("Lantern reach");
  });
});

describe("a personal move's detail", () => {
  it("Move detail shows its post link", async () => {
    network({ personal: MOVES });
    mountStudio(`/studio/move/${LANTERN.id}`);
    await until(() => dialog()?.querySelector("h2")?.textContent === "Lantern reach", "the move's detail");
    const sheet = dialog()!;
    expect(sheet.textContent).toContain("Yours");
    const links = [...sheet.querySelectorAll<HTMLAnchorElement>("a[target=_blank]")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/p/lantern-1"]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]!.closest("li")?.textContent).toContain("Example Coach");
    // A link with no address still names its creator, with no anchor.
    const second = [...sheet.querySelectorAll("li")].find((li) => li.textContent?.includes("Second Example"));
    expect(second).toBeDefined();
    expect(second!.querySelector("a")).toBeNull();
    // The athlete's say and Add, as for any move it is offered.
    expect([...sheet.querySelectorAll("button")].some((b) => b.textContent === "Add")).toBe(true);
    expect(where).toBe(`/studio/move/${LANTERN.id}`);
  });

  it("a creator's words are text, never markup; an address that is not a web page is no link", async () => {
    const hostile = move(personal("myHostileMove7g8h9i", "Hostile move", "A move."), "active", [
      { url: "javascript:alert(1)", creator: '<img src=x onerror="alert(1)">' },
    ]);
    network({ personal: { moves: [hostile] } });
    mountStudio("/studio/move/myHostileMove7g8h9i");
    await until(() => dialog()?.querySelector("h2")?.textContent === "Hostile move", "the move's detail");
    const sheet = dialog()!;
    expect(sheet.querySelector("img")).toBeNull();
    expect(sheet.textContent).toContain('<img src=x onerror="alert(1)">');
    expect([...sheet.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").startsWith("javascript"))).toBe(false);
  });

  it("an archived move still opens from its address — kept for old workouts — and offers no Add and no say", async () => {
    network({ personal: MOVES });
    mountStudio(`/studio/move/${WINDMILL.id}`);
    await until(() => dialog()?.querySelector("h2")?.textContent === "Windmill switch", "the archived move's detail");
    const sheet = dialog()!;
    expect(sheet.textContent).toContain("Yours");
    expect(sheet.textContent).toContain("Archived");
    expect([...sheet.querySelectorAll("button")].some((b) => b.textContent === "Add")).toBe(false);
    expect(sheet.querySelector(".stu-say")).toBeNull();
    expect(sheet.querySelector("a[target=_blank]")?.getAttribute("href")).toBe("https://example.com/p/windmill");
  });
});

// ── The player ──

describe("a build made on the device", () => {
  const template = (doc: WorkoutDoc): TemplateDto => ({
    id: "t1",
    name: doc.title,
    doc,
    pinned: true,
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    minutes: 10,
    discipline: "strength",
  });
  const doc: WorkoutDoc = {
    version: 1,
    title: "Lantern day",
    intent: { summary: "Lantern day", goals: [], focus: [], effort: "maintain" },
    parts: [{ purpose: "main", format: "straight", items: [suggestedItem(base, "main"), suggestedItem(LANTERN, "main")] }],
    source: { kind: "studio" },
    basedOn: { kind: "template", id: "t1" },
  };

  it("an archived move a template still holds is named, judged and timed — kept for what holds it", async () => {
    const held: WorkoutDoc = { ...doc, parts: [{ purpose: "main", format: "straight", items: [suggestedItem(WINDMILL, "main")] }] };
    network({ personal: MOVES, templates: [template(held)] });
    mountBuilder("/studio/build/template/t1");
    const start = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
    await until(() => !!start() && !start()!.disabled, "Start now");
    expect(text()).toContain("Windmill switch");
    expect(text()).not.toContain("in the library");
    expect(document.querySelector(".stu-part-meta")?.textContent).toMatch(/\d+ min/);
  });

  it("A local build of a workout holding a personal move plays its steps", async () => {
    network({ personal: MOVES, templates: [template(doc)] });
    mountBuilder("/studio/build/template/t1");
    const start = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
    await until(() => !!start() && !start()!.disabled, "Start now");
    // The builder names it, as the library names its own.
    expect(text()).toContain("Lantern reach");
    await act(async () => {
      start()!.click();
    });
    await until(() => text().includes("the player"), "the player");
    const id = decodeURIComponent(where.replace(/^\/session\//, ""));
    const stored = (await loadBuild(await offlineDb(), id))!;
    const played = stored.build.steps.filter((s) => s.kind !== "rest" && s.exerciseId === LANTERN.id);
    expect(played.length).toBeGreaterThan(0);
    expect(stored.build.exercises[LANTERN.id]?.name).toBe("Lantern reach");
    expect(stored.build.items.map((i) => i.exerciseId)).toContain(LANTERN.id);
  });
});
