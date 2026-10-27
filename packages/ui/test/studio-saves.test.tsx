// @vitest-environment jsdom
/**
 * "FROM YOUR SAVES", THE REVIEW SCREEN (`/studio/saves`, `/studio/saves/:batchId`; saved-posts import Task 15, the saves
 * flow redesigned §3.3): the batches — one put aside reads so, and offers Fit them in — then a batch's page: "{n} new
 * moves", the one bold line, one row per new move (its name, one line of what it is for, Skip | Coach | Include), the
 * moves already yours folded, and a sticky foot with the tally and Fit these in; then a move's sheet — Edit, Not this
 * move, Same as…, Remove, Ask the coach. A model's words (names, summaries, creators) are text, never markup; a post's
 * address is a link only when it is a web page's. Synthetic data only (example.com, made-up names).
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SAVES_QUERY, savesBatchQuery, type PersonalMovesDto } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { FIT_SAVES_REQUEST, type FitChoice, type SaveBatchDetailDto, type SaveBatchDto, type SaveBatchRowDto } from "@rg/saves";
import { StudioRoute } from "../src/app.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { FITTING_LINE, OPEN_FIRST_LINE, patchOf, formOf } from "../src/screens/studio/saves-model.js";
import { DEVICE_PREFS, libraryDto, placesDto, primedClient, profileDto, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Synthetic moves and a batch ──

const base = EXERCISES.find((r) => r.id === "bridge")!;
function personal(id: string, name: string, summary: string): ExerciseRecord {
  const { providers: _providers, ...rest } = base;
  return { ...rest, id, name, legacyIds: [], easier: [], harder: [], text: { ...base.text, summary } };
}
const QUAD = personal("myZorbexQuadShuffle1a2b3c", "Zorbex quad shuffle", "Shuffle the quads, slow and even.");
const NECK = personal("myZorbexNeckNod4d5e6f", "Zorbex neck nod", "Nod slowly, the jaw soft. Then rest.");
const CALF = personal("myZorbexCalfRocker7j8k9l", "Zorbex calf rocker", "Rock heel to toe.");
const LANTERN = personal("myLanternReach7g8h9i", "Lantern reach", "Reach long and slow, the hips level.");
const HIP = EXERCISES.find((e) => e.name === "90/90 hip switches")!;
const HOSTILE = '<img src=x onerror="alert(1)">';

const BATCH: SaveBatchDto = {
  id: "b1", status: "released", notice: "From your saves: 3 new moves (1 hip, 1 neck, 1 calf), 1 you already had.", theme: null,
  createdAt: "2026-10-23T10:00:00.000Z", releasedAt: "2026-10-23T10:00:00.000Z", savedAt: null, fittedAt: null, counts: { new: 3, linked: 1, removed: 0 },
  dismissedAt: null, fitStartedAt: null, fitting: false,
};
/**
 * Three posts: two share Zorbex quad shuffle; one new move is flagged, like a move of the owner's (Lantern reach); one
 * library move the owner already has (90/90 hip switches).
 */
const ROWS: SaveBatchRowDto[] = [
  {
    postMoveId: "pm1", position: 0, status: "pending", post: { url: "https://example.com/p/a", creator: "coach_a", kind: "routine" },
    move: { id: QUAD.id, name: QUAD.name, summary: QUAD.text.summary, kind: "new", check: false, seenDose: "3 x 10", purpose: "Loosens the quads before a run.", choice: null }, record: QUAD,
  },
  {
    postMoveId: "pm2", position: 1, status: "pending", post: { url: "https://example.com/p/a", creator: "coach_a", kind: "routine" },
    move: { id: HIP.id, name: "90/90 Hip Switch", summary: "Switch the knees side to side.", kind: "linked", linkedName: HIP.name, check: false, seenDose: "8 each side", purpose: null, choice: null },
  },
  {
    postMoveId: "pm3", position: 0, status: "pending", post: { url: "javascript:alert(1)", creator: HOSTILE, kind: "single_move" },
    move: {
      id: NECK.id, name: NECK.name, summary: NECK.text.summary, kind: "new", check: true, checkWhy: ["low_confidence", "inferred_dose", "near_duplicate"], seenDose: "5 slow",
      purpose: null, like: { id: LANTERN.id, name: LANTERN.name }, choice: null,
    },
    record: NECK,
  },
  {
    postMoveId: "pm4", position: 0, status: "pending", post: { url: "https://example.com/p/c", creator: "coach_c", kind: "routine" },
    move: { id: QUAD.id, name: QUAD.name, summary: QUAD.text.summary, kind: "new", check: false, seenDose: "2 x 12", purpose: "Warms the knees.", choice: null }, record: QUAD,
  },
  {
    postMoveId: "pm5", position: 1, status: "pending", post: { url: "https://example.com/p/c", creator: "coach_c", kind: "routine" },
    move: { id: CALF.id, name: CALF.name, summary: CALF.text.summary, kind: "new", check: false, seenDose: "20 reps", purpose: "Wakes the calves.", choice: null }, record: CALF,
  },
];
const PERSONAL: PersonalMovesDto = { moves: [{ record: LANTERN, status: "active", links: [] }], merged: [] };
/** What the posts say about when, why or how often (spec §17): a model's reading, one of them hostile. */
const INSIGHTS: NonNullable<SaveBatchDetailDto["insights"]> = [
  { postId: "post-a", url: "https://example.com/p/a", creator: "coach_a", text: "Do the quad shuffle before a run, not after." },
  { postId: "post-b", url: "javascript:alert(1)", creator: HOSTILE, text: `Twice a week ${HOSTILE}` },
];

// ── The server ──

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

interface Serve {
  insights?: SaveBatchDetailDto["insights"];
  batch?: Partial<SaveBatchDto>;
  /** The rows' own status (a fitted batch's are saved). */
  rowStatus?: SaveBatchRowDto["status"];
  /** Only these rows (by postMoveId). */
  only?: string[];
  /** Each move's stored fit choice. */
  choices?: Record<string, FitChoice>;
  /** `/fit`'s answer instead of a fit. */
  fit?: Response;
  /** `/rematch`'s answer instead of a re-match. */
  rematch?: Response;
}

function serve(o: Serve = {}): Call[] {
  const calls: Call[] = [];
  const insights = "insights" in o ? o.insights : INSIGHTS;
  let batch = { ...BATCH, ...o.batch };
  let rows: SaveBatchRowDto[] = ROWS.filter((r) => !o.only || o.only.includes(r.postMoveId)).map((r) => ({
    ...r,
    status: o.rowStatus ?? r.status,
    move: { ...r.move, choice: r.move.kind === "new" ? (o.choices?.[r.move.id] ?? null) : null },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/my-saves/batches") return json({ batches: [batch] });
      if (method === "GET" && path === "/api/my-saves/batches/b1") return json({ batch, rows, ...(insights ? { insights } : {}) } satisfies SaveBatchDetailDto);
      if (method === "GET" && path === "/api/my-saves/batches/gone") return json({ error: "not_found" }, 404);
      if (method === "GET" && path === "/api/my-saves/open") return json({ open: null });
      if (method === "POST" && path === "/api/my-saves/batches/b1/fit") {
        if (o.fit) return o.fit.clone();
        batch = { ...batch, status: "saved", savedAt: "2026-10-24T12:00:00.000Z", dismissedAt: null, fitStartedAt: "2026-10-24T12:00:00.000Z", fitting: true };
        // No choices key (the one-tap fit) keeps the stored ones; a set rewrites them.
        const chosen = (r: SaveBatchRowDto) => (body.choices ? (body.choices[r.move.id] ?? null) : r.move.choice);
        rows = rows.map((r) => (r.status === "pending" ? { ...r, status: "saved", move: { ...r.move, choice: chosen(r) } } : r));
        return json({ batchId: "b1", request: FIT_SAVES_REQUEST, moves: 3, links: 5 });
      }
      const rematch = /^\/api\/my-saves\/post-moves\/([^/]+)\/(rematch|remove)$/.exec(path);
      if (rematch && method === "POST") {
        const id = rematch[1]!;
        if (rematch[2] === "remove") {
          rows = rows.map((r) => (r.postMoveId === id ? { ...r, status: "removed" } : r));
          return json({ ok: true });
        }
        if (o.rematch) return o.rematch.clone();
        // The owner's word settles the row: no Check this, no like; to a move of theirs, the row is already theirs.
        const to = body.to as string | null;
        const sibling = rows.find((r) => r.move.id === to && r.move.kind === "new");
        rows = rows.map((r) => {
          if (r.postMoveId !== id || to === null) return r;
          const { like: _like, checkWhy: _why, ...move } = r.move;
          if (sibling) return { ...r, move: { ...sibling.move }, record: sibling.record };
          const own = to === LANTERN.id ? LANTERN : null;
          return { ...r, move: { ...move, id: to, kind: "linked", linkedName: own?.name ?? to, check: false, choice: null }, ...(own ? { record: own } : {}) };
        });
        return json({ ok: true, move: { id: to ?? "myOwnMove000001", kind: to && !to.startsWith("my") ? "library" : "personal" } });
      }
      const edit = /^\/api\/my-saves\/moves\/([^/]+)$/.exec(path);
      if (edit && method === "PUT") {
        if (body.name === "Bad name") return json({ error: "invalid_record", issues: ["conditions.tmj.clench must be 0–3"] }, 422);
        return json({ record: { ...QUAD, ...body } });
      }
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

// ── Mounting and driving ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";
let opener: CoachOpener & { open: ReturnType<typeof vi.fn> };
let client: ReturnType<typeof primedClient>;

function Where() {
  const loc = useLocation();
  where = loc.pathname;
  return null;
}

function mount(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(["mat"]), today: todayDto(null, false), library: libraryDto(), profile: profileDto(), personal: PERSONAL });
  qc.setQueryData(["settings"], { prefs: DEVICE_PREFS });
  client = qc;
  opener = { open: vi.fn() };
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          CoachOpenContext.Provider,
          { value: opener },
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(Routes, null, createElement(Route, { path: "/studio/*", element: createElement(StudioRoute) })),
            createElement(Where),
          ),
        ),
      ),
    );
  });
}

beforeEach(() => {
  where = "";
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

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
/** A new move's row on the page. */
const rowOf = (name: string) => [...document.querySelectorAll<HTMLElement>(".stu-save-row")].find((r) => r.querySelector(".stu-save-open")?.textContent === name) ?? null;
const openRow = (name: string) => click(rowOf(name)?.querySelector(".stu-save-open"), `${name}'s row`);
const rowNames = () => [...document.querySelectorAll<HTMLElement>(".stu-save-row .stu-save-open")].map((b) => b.textContent);
/** A move already yours, unfolded. */
const ownedOf = (name: string) => [...document.querySelectorAll<HTMLElement>(".stu-save-owned-row")].find((r) => r.querySelector(".stu-save-open")?.textContent === name) ?? null;
const fold = () => buttons().find((b) => /^[▸▾] Already yours · \d+$/.test(b.textContent?.trim() ?? "")) ?? null;
/** A row's Skip | Coach | Include: each radio's word and whether it is checked. */
const control = (name: string) => rowOf(name)?.querySelector<HTMLElement>('[role="radiogroup"]') ?? null;
const radios = (name: string) => [...(control(name)?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
const checked = (name: string) => radios(name).find((r) => r.getAttribute("aria-checked") === "true")?.textContent ?? null;
const choose = (name: string, word: "Skip" | "Coach" | "Include") => click(radios(name).find((r) => r.textContent === word), `${name}'s ${word}`);
const tally = () => document.querySelector(".stu-save-tally")?.textContent ?? null;
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);
const fitBody = (calls: Call[]) => posts(calls, "/api/my-saves/batches/b1/fit")[0]?.body;

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── The batch ──

describe("a batch's page (the saves flow redesigned §3.3)", () => {
  it("one row per new move, its purpose and control — no creator, no dose; Already yours folded: ▸ Already yours · 1", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    // Two posts show Zorbex quad shuffle: one row. The posts' order. The move already yours is not among them.
    expect(rowNames()).toEqual([QUAD.name, NECK.name, CALF.name]);
    // The row: its name, one line of what it is for (the post's purpose, else the summary's first sentence), the control.
    const quad = rowOf(QUAD.name)!;
    expect(quad.querySelector(".stu-save-purpose")?.textContent).toBe("Loosens the quads before a run.");
    expect(rowOf(CALF.name)!.querySelector(".stu-save-purpose")?.textContent).toBe("Wakes the calves.");
    expect(rowOf(NECK.name)!.querySelector(".stu-save-purpose")?.textContent).toBe("Nod slowly, the jaw soft.");
    // A flagged move keeps its flag word, then the move it looks like.
    expect(rowOf(NECK.name)!.textContent).toContain("Check this");
    expect(rowOf(NECK.name)!.textContent).toContain(`like ${LANTERN.name}`);
    expect(quad.textContent).not.toContain("Check this");
    // No creator, no dose on a row — and no New label.
    for (const name of [QUAD.name, NECK.name, CALF.name]) {
      const row = rowOf(name)!.textContent!;
      for (const word of ["coach_a", "coach_c", HOSTILE, "3 x 10", "2 x 12", "5 slow", "20 reps", "New"]) expect(row, `${name}: ${word}`).not.toContain(word);
    }
    expect(document.querySelector("img")).toBeNull();
    // Skip | Coach | Include, named by its move; Coach to start.
    for (const name of [QUAD.name, NECK.name, CALF.name]) {
      expect(control(name)?.getAttribute("aria-label")).toBe(name);
      expect(radios(name).map((r) => r.textContent)).toEqual(["Skip", "Coach", "Include"]);
      expect(checked(name)).toBe("Coach");
    }
    // Already yours: one folded line; unfolded, the names — each opens its sheet, none has a control.
    expect(fold()?.textContent?.trim()).toBe("▸ Already yours · 1");
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain(HIP.name);
    await click(fold(), "Already yours");
    expect(fold()?.textContent?.trim()).toBe("▾ Already yours · 1");
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    const owned = ownedOf(HIP.name);
    expect(owned).not.toBeNull();
    expect(owned!.querySelector('[role="radiogroup"]')).toBeNull();
    expect(owned!.textContent).not.toContain("8 each side");
    await click(owned!.querySelector(".stu-save-open"), HIP.name);
    expect(dialog("90/90 Hip Switch")).not.toBeNull();
    // Nothing of the old page: no Save these.
    expect(button("Save these")).toBeNull();
  });

  it("the title and the line, word for word", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    expect(document.querySelector("h1")?.textContent).toBe("3 new moves");
    const line = document.querySelector<HTMLElement>(".stu-save-line")!;
    expect(line.textContent).toBe("On Coach, the coach decides. Include is in. Skip stays out.");
    expect([...line.querySelectorAll("b, strong")].map((b) => b.textContent)).toEqual(["Coach", "Include", "Skip"]);
    act(() => root?.unmount());
    host?.remove();
    root = null;
    vi.unstubAllGlobals();
    // One new move: "1 new move".
    serve({ only: ["pm2", "pm3"] });
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the row");
    expect(document.querySelector("h1")?.textContent).toBe("1 new move");
  });

  it("no new move: the title says No new moves and Fit these in is there but disabled — a batch of only moves already yours, or one every row of which was removed", async () => {
    // Only a move already yours (final fix wave, saves flow redesign: never "0 new moves").
    const calls = serve({ only: ["pm2"] });
    mount("/studio/saves/b1");
    await until(() => !!fold(), "Already yours");
    expect(document.querySelector("h1")?.textContent).toBe("No new moves");
    expect(document.querySelector(".stu-save-line")).toBeNull();
    expect(tally()).toBeNull();
    expect(button("Fit these in")?.disabled).toBe(true);
    await click(button("Fit these in"), "Fit these in");
    expect(fitBody(calls)).toBeUndefined();
    act(() => root?.unmount());
    host?.remove();
    root = null;
    vi.unstubAllGlobals();
    // Every row removed: nothing left, and the same foot.
    serve({ rowStatus: "removed" });
    mount("/studio/saves/b1");
    await until(() => text().includes("Nothing left in this batch."), "nothing left");
    expect(document.querySelector("h1")?.textContent).toBe("No new moves");
    expect(button("Fit these in")?.disabled).toBe(true);
  });

  it("the tally follows the controls: All three on the coach's call → 1 in · 1 out · 1 on the coach's call", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    expect(tally()).toBe("All three on the coach's call");
    await choose(QUAD.name, "Include");
    expect(checked(QUAD.name)).toBe("Include");
    expect(tally()).toBe("1 in · 2 on the coach's call");
    await choose(NECK.name, "Skip");
    expect(checked(NECK.name)).toBe("Skip");
    expect(tally()).toBe("1 in · 1 out · 1 on the coach's call");
    await choose(QUAD.name, "Coach");
    expect(tally()).toBe("1 out · 2 on the coach's call");
    // The foot: the tally and one button.
    const foot = document.querySelector(".stu-save-foot")!;
    expect(buttons(foot).map((b) => b.textContent)).toEqual(["Fit these in"]);
  });

  it("the control is three radios: a fingertip's each, the arrows move the choice", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    const [skip, coach, include] = radios(QUAD.name);
    // One stop in the tab order: the checked one.
    expect([skip, coach, include].map((r) => r!.tabIndex)).toEqual([-1, 0, -1]);
    await act(async () => {
      coach!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(checked(QUAD.name)).toBe("Include");
    expect(document.activeElement).toBe(radios(QUAD.name)[2]);
    await act(async () => {
      radios(QUAD.name)[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(checked(QUAD.name)).toBe("Skip");
  });

  it("Fit these in fits with the choices — Coach sent as nothing — and opens the coach with the fit", async () => {
    // Zorbex neck nod was included before (a fit since declined): it starts on Include.
    const calls = serve({ choices: { [NECK.id]: "include" } });
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    expect(checked(NECK.name)).toBe("Include");
    expect(tally()).toBe("1 in · 2 on the coach's call");
    await choose(QUAD.name, "Include");
    await choose(CALF.name, "Skip");
    await choose(NECK.name, "Coach");
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await click(button("Fit these in"), "Fit these in");
    await until(() => opener.open.mock.calls.length === 1, "the coach opened");
    expect(fitBody(calls)).toEqual({ choices: { [QUAD.id]: "include", [CALF.id]: "skip" } });
    expect(opener.open).toHaveBeenCalledWith({ fit: { batchId: "b1", request: FIT_SAVES_REQUEST }, seeing: null });
    // The open batch, the batches and this batch read again (`savesChanged`), the library too: the save made the moves the owner's.
    const keys = invalidated.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const key of [OPEN_SAVES_QUERY, savesBatchQuery("b1"), ["library"]]) expect(keys).toContain(JSON.stringify(key));
    // While the fit is at work: no button, no control — the line in its place.
    await until(() => text().includes(FITTING_LINE), "Fitting in…");
    expect(button("Fit these in")).toBeNull();
    expect(control(QUAD.name)).toBeNull();
    expect(posts(calls, "/api/my-saves/batches/b1/fit")).toHaveLength(1);
    expect(posts(calls, "/api/my-saves/batches/b1/fit/cancel")).toHaveLength(0);
  });

  it("like {name} merges in one tap", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    const like = button(`like ${LANTERN.name}`, rowOf(NECK.name)!);
    expect(like).not.toBeNull();
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await click(like, "like Lantern reach");
    await until(() => posts(calls, "/api/my-saves/post-moves/pm3/rematch").length === 1, "the re-match");
    expect(posts(calls, "/api/my-saves/post-moves/pm3/rematch")[0]!.body).toEqual({ to: LANTERN.id });
    // Merged: the row is gone from the new moves, and is one of the owner's now.
    await until(() => !rowOf(NECK.name), "the row merged");
    expect(rowNames()).toEqual([QUAD.name, CALF.name]);
    expect(document.querySelector("h1")?.textContent).toBe("2 new moves");
    expect(fold()?.textContent?.trim()).toBe("▸ Already yours · 2");
    expect(tally()).toBe("Both on the coach's call");
    expect(invalidated.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === '["library"]')).toBe(true);
  });

  it("a like whose move has gone (merged by another row's Same as…): the page reads again, the like is plain text, no error", async () => {
    const calls = serve({ rematch: json({ error: "not_found" }, 404) });
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await click(button(`like ${LANTERN.name}`, rowOf(NECK.name)!), "like Lantern reach");
    await until(() => !button(`like ${LANTERN.name}`, rowOf(NECK.name) ?? undefined), "the like as text");
    expect(posts(calls, "/api/my-saves/post-moves/pm3/rematch")).toHaveLength(1);
    expect(rowOf(NECK.name)!.textContent).toContain(`like ${LANTERN.name}`);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").toBe("");
    // Read again.
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/my-saves/batches/b1").length).toBeGreaterThan(1);
  });

  it("a removed move's row goes, and its choice is never sent", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await choose(NECK.name, "Include");
    await choose(QUAD.name, "Skip");
    expect(tally()).toBe("1 in · 1 out · 1 on the coach's call");
    await openRow(NECK.name);
    await click(button("Remove", dialog(NECK.name)!), "Remove");
    await until(() => posts(calls, "/api/my-saves/post-moves/pm3/remove").length === 1 && !rowOf(NECK.name), "the removal");
    expect(tally()).toBe("1 out · 1 on the coach's call");
    // A move two posts show: Remove takes it out of both, and its row goes.
    await openRow(QUAD.name);
    await click(button("Remove", dialog(QUAD.name)!), "Remove");
    await until(() => !rowOf(QUAD.name), "the two-post move removed");
    expect(posts(calls, "/api/my-saves/post-moves/pm1/remove")).toHaveLength(1);
    expect(posts(calls, "/api/my-saves/post-moves/pm4/remove")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe("1 new move");
    expect(tally()).toBe("On the coach's call");
    await click(button("Fit these in"), "Fit these in");
    await until(() => !!fitBody(calls), "the fit");
    // Every move left on the coach's call: nothing sent.
    expect(fitBody(calls)).toEqual({ choices: {} });
  });

  it("409 batch_open says finish the batch that is open first", async () => {
    const calls = serve({ fit: json({ error: "batch_open" }, 409) });
    mount("/studio/saves/b1");
    await until(() => !!button("Fit these in"), "Fit these in");
    await click(button("Fit these in"), "Fit these in");
    await until(() => text().includes(OPEN_FIRST_LINE), "the refusal");
    expect(opener.open).not.toHaveBeenCalled();
    expect(posts(calls, "/api/my-saves/batches/b1/fit/cancel")).toHaveLength(0);
    // The page stays as it was: its controls, its button.
    expect(control(QUAD.name)).not.toBeNull();
    expect(button("Fit these in")).not.toBeNull();
  });

  it("a fitted batch is read-only", async () => {
    serve({ batch: { status: "saved", savedAt: "2026-10-24T12:00:00.000Z", fittedAt: "2026-10-24T13:00:00.000Z" }, rowStatus: "saved" });
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    await settle(10);
    expect(rowNames()).toEqual([QUAD.name, NECK.name, CALF.name]);
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.querySelector(".stu-save-foot")).toBeNull();
    expect(button("Fit these in")).toBeNull();
    expect(tally()).toBeNull();
    // Nothing to merge any more: the like is words.
    expect(button(`like ${LANTERN.name}`)).toBeNull();
    expect(rowOf(NECK.name)!.textContent).toContain(`like ${LANTERN.name}`);
    // A name still opens its sheet.
    await openRow(QUAD.name);
    expect(dialog(QUAD.name)).not.toBeNull();
  });

  it("a batch fitted in before but whose fit was declined (saved, not fitted) offers its controls and Fit these in again", async () => {
    const calls = serve({ batch: { status: "saved", savedAt: "2026-10-24T12:00:00.000Z" }, rowStatus: "saved", choices: { [CALF.id]: "skip" } });
    mount("/studio/saves/b1");
    await until(() => !!button("Fit these in"), "Fit these in");
    expect(checked(CALF.name)).toBe("Skip");
    await click(button("Fit these in"), "Fit these in");
    await until(() => !!fitBody(calls), "the fit");
    expect(fitBody(calls)).toEqual({ choices: { [CALF.id]: "skip" } });
  });

  it("Notes, under the rows: one line per insight with its creator, as text — read-only, a hostile one inert (spec §17)", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    const section = [...document.querySelectorAll<HTMLElement>("section")].find((x) => x.querySelector("h2")?.textContent === "Notes") ?? null;
    expect(section).not.toBeNull();
    const lines = [...section!.querySelectorAll("li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Do the quad shuffle before a run, not after.");
    expect(lines[0]).toContain("coach_a");
    expect(lines[1]).toContain(`Twice a week ${HOSTILE}`);
    expect(lines[1]).toContain(HOSTILE);
    // Text, never markup; nothing in it to press or follow.
    expect(document.querySelector("img")).toBeNull();
    expect(section!.querySelector("a, button, input")).toBeNull();
    // Under the rows, above the foot.
    const rows = document.querySelector(".stu-tpl-list")!;
    expect(rows.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section!.compareDocumentPosition(button("Fit these in")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no insights — none, or an answer kept from before they were read — no Notes", async () => {
    for (const insights of [[], undefined]) {
      serve({ insights });
      mount("/studio/saves/b1");
      await until(() => !!rowOf(QUAD.name), "the rows");
      expect([...document.querySelectorAll("h2")].some((h) => h.textContent === "Notes")).toBe(false);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      vi.unstubAllGlobals();
    }
  });

  it("a batch that isn't there says so", async () => {
    serve();
    mount("/studio/saves/gone");
    await until(() => text().includes("isn't there"), "the refusal");
    expect(button("Fit these in")).toBeNull();
  });
});

describe("a move's sheet", () => {
  it("Ask the coach opens the coach with the move focus", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await openRow(NECK.name);
    const sheet = dialog(NECK.name);
    expect(sheet).not.toBeNull();
    await click(button("Ask the coach", sheet!) ?? buttons(sheet!).find((b) => b.textContent?.includes("Ask the coach")), "Ask the coach");
    expect(opener.open).toHaveBeenCalledWith({ seeing: { kind: "move", id: NECK.id, label: NECK.name }, request: null });
  });

  it("shows the post: its creator as text, a link only to a web page, opened apart", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    await openRow(QUAD.name);
    const link = dialog(QUAD.name)!.querySelector<HTMLAnchorElement>("a[href]");
    expect(link?.getAttribute("href")).toBe("https://example.com/p/a");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    await click(button("Close", dialog(QUAD.name)!), "Close");
    await openRow(NECK.name);
    expect(dialog(NECK.name)!.querySelector("a[href]")).toBeNull();
    expect(dialog(NECK.name)!.textContent).toContain(HOSTILE);
  });

  it("shows the move's ratings per profile (folded, a tap opens them) and its cues; Check this says why, as data (verbatim audit gap 5)", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await openRow(NECK.name);
    const sheet = dialog(NECK.name)!;
    // Why "Check this": the reasons the server gave, each a fact — never an explainer.
    const why = sheet.querySelector(".stu-save-why");
    expect([...why!.querySelectorAll("span:not(.stu-sep)")].map((x) => x.textContent)).toEqual(["Low confidence", "Dose inferred", "Looks like another move"]);
    // The ratings, folded under their summary: per profile, each attribute on its scale, the profile's note with them.
    const ratings = sheet.querySelector<HTMLDetailsElement>("details.stu-save-ratings")!;
    expect(ratings).not.toBeNull();
    expect(ratings.open).toBe(false);
    expect(ratings.querySelector("summary")?.textContent).toBe("Ratings");
    const line = ratings.querySelector("li")!.textContent!.replace(/\s+/g, " ").trim();
    expect(line).toBe("TMJ: Clench 0 of 3 · Neck load 0 of 3 · Face down no");
    expect(ratings.textContent).toContain("Glutes work; the jaw doesn't.");
    // The cues (the record's focus), as text.
    const cues = [...sheet.querySelectorAll(".stu-save-cues li")].map((li) => li.textContent);
    expect(cues).toEqual(["Knees stay in line with the feet.", "Ribs stay down."]);
    await click(button("Close", sheet), "Close");
    // A row it doesn't flag says no why.
    await openRow(QUAD.name);
    expect(dialog(QUAD.name)!.querySelector(".stu-save-why")).toBeNull();
  });

  it("Same as… picks from the moves the Studio offers and re-matches the row", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await openRow(NECK.name);
    await click(button("Same as…", dialog(NECK.name)!), "Same as…");
    const picker = dialog("Same as…");
    expect(picker).not.toBeNull();
    setValue(picker!.querySelector<HTMLInputElement>('input[type="search"]')!, "Lantern");
    await settle();
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await click(buttons(picker!).find((b) => b.textContent?.includes(LANTERN.name)), "Lantern reach");
    await until(() => posts(calls, "/api/my-saves/post-moves/pm3/rematch").length === 1, "the re-match");
    expect(posts(calls, "/api/my-saves/post-moves/pm3/rematch")[0]!.body).toEqual({ to: LANTERN.id });
    await until(() => invalidated.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === '["library"]'), "the library read again");
  });

  it("Same as… offers the batch's other new moves first, by name — merging two new moves the matcher missed (final review I4)", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await openRow(NECK.name);
    await click(button("Same as…", dialog(NECK.name)!), "Same as…");
    const picker = dialog("Same as…")!;
    const names = buttons(picker).map((b) => b.querySelector(".stu-pick-name")?.textContent ?? null).filter(Boolean);
    // The batch's other new move at the top; never the row's own move.
    expect(names[0]).toBe(QUAD.name);
    expect(names).not.toContain(NECK.name);
    expect(names.filter((n) => n === QUAD.name)).toHaveLength(1);
    await click(buttons(picker).find((b) => b.querySelector(".stu-pick-name")?.textContent === QUAD.name), QUAD.name);
    await until(() => posts(calls, "/api/my-saves/post-moves/pm3/rematch").length === 1, "the re-match");
    expect(posts(calls, "/api/my-saves/post-moves/pm3/rematch")[0]!.body).toEqual({ to: QUAD.id });
  });

  it("Same as…'s search narrows the batch's new moves too", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(NECK.name), "the rows");
    await openRow(NECK.name);
    await click(button("Same as…", dialog(NECK.name)!), "Same as…");
    const picker = dialog("Same as…")!;
    setValue(picker.querySelector<HTMLInputElement>('input[type="search"]')!, "Lantern");
    await settle();
    const names = buttons(picker).map((b) => b.querySelector(".stu-pick-name")?.textContent ?? null).filter(Boolean);
    expect(names).not.toContain(QUAD.name);
    expect(names).toContain(LANTERN.name);
  });

  it("Not this move makes the post's move its own; Remove takes the row out", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!fold(), "the rows");
    await click(fold(), "Already yours");
    await click(ownedOf(HIP.name)?.querySelector(".stu-save-open"), HIP.name);
    // A linked row has no edit (the library's move is not the owner's to change).
    expect(button("Edit", dialog("90/90 Hip Switch")!)).toBeNull();
    await click(button("Not this move", dialog("90/90 Hip Switch")!), "Not this move");
    await until(() => posts(calls, "/api/my-saves/post-moves/pm2/rematch").length === 1, "the re-match");
    expect(posts(calls, "/api/my-saves/post-moves/pm2/rematch")[0]!.body).toEqual({ to: null });

    await until(() => !!rowOf(QUAD.name), "the rows again");
    await openRow(QUAD.name);
    // A new move too: the post's own reading makes another, every time.
    expect(button("Not this move", dialog(QUAD.name)!)).not.toBeNull();
    await click(button("Remove", dialog(QUAD.name)!), "Remove");
    await until(() => posts(calls, "/api/my-saves/post-moves/pm4/remove").length === 1 && !rowOf(QUAD.name), "the removal");
    expect(posts(calls, "/api/my-saves/post-moves/pm1/remove")).toHaveLength(1);
  });

  it("Edit sends what changed; an edit the library refuses says why", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    await openRow(QUAD.name);
    await click(button("Edit", dialog(QUAD.name)!), "Edit");
    const sheet = dialog(QUAD.name)!;
    const name = [...sheet.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith("Name"))!;
    const input = (name.control ?? name.querySelector("input")) as HTMLInputElement;
    setValue(input, "Bad name");
    await settle();
    await click(button("Save", sheet), "Save");
    await until(() => !!sheet.querySelector('[role="alert"]'), "the refusal");
    expect(sheet.querySelector('[role="alert"]')!.textContent).toContain("conditions.tmj.clench must be 0–3");
    setValue(input, "Zorbex quad walk");
    await settle();
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await click(button("Save", sheet), "Save");
    const puts = calls.filter((c) => c.method === "PUT" && c.path === `/api/my-saves/moves/${QUAD.id}`);
    await until(() => calls.filter((c) => c.method === "PUT").length === 2, "the edit");
    expect(puts.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ name: "Bad name" }, { name: "Zorbex quad walk" }]);
    // The whole library is read again — the move's own detail too (`["library", "item", id]`), not only the list.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["library"] });
  });
});

describe("the batches", () => {
  it("lists each batch with its counts, each opening its rows", async () => {
    serve();
    mount("/studio/saves");
    await until(() => !!document.querySelector('a[href="/studio/saves/b1"]'), "the batch");
    expect(document.querySelector("h1")?.textContent).toBe("From your saves");
    expect(text()).toContain("3 new");
    expect(text()).toContain("1 linked");
    // Not put aside: nothing to bring back.
    expect(text()).not.toContain("Put aside");
    expect(button("Fit them in")).toBeNull();
    await click(document.querySelector('a[href="/studio/saves/b1"]'), "the batch");
    expect(where).toBe("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
  });

  it("the list: a dismissed batch reads Put aside and offers Fit them in", async () => {
    const calls = serve({ batch: { dismissedAt: "2026-10-24T09:00:00.000Z" } });
    mount("/studio/saves");
    await until(() => !!document.querySelector('a[href="/studio/saves/b1"]'), "the batch");
    const item = document.querySelector('a[href="/studio/saves/b1"]')!.closest("li")!;
    expect(item.textContent).toContain("Put aside");
    await click(button("Fit them in", item), "Fit them in");
    await until(() => opener.open.mock.calls.length === 1, "the coach opened");
    // The same fit as the coach's card: no choices key — what the owner chose on the page stands.
    expect(fitBody(calls)).toEqual({});
    expect(opener.open).toHaveBeenCalledWith({ fit: { batchId: "b1", request: FIT_SAVES_REQUEST }, seeing: null });
  });

  it("the list: Fit them in refused while another batch is open says so", async () => {
    serve({ batch: { dismissedAt: "2026-10-24T09:00:00.000Z" }, fit: json({ error: "batch_open" }, 409) });
    mount("/studio/saves");
    await until(() => !!button("Fit them in"), "Fit them in");
    await click(button("Fit them in"), "Fit them in");
    await until(() => text().includes(OPEN_FIRST_LINE), "the refusal");
    expect(opener.open).not.toHaveBeenCalled();
  });
});

describe("the edit form", () => {
  it("patchOf sends only what changed: lines trimmed, blank lines dropped, a profile's note or rating by itself", () => {
    const form = formOf(QUAD);
    expect(patchOf(QUAD, form)).toBeNull();
    const profile = Object.keys(QUAD.conditions)[0]!;
    const attr = Object.keys(QUAD.conditions[profile]!)[0]!;
    const next = {
      ...form,
      summary: "  New words.  ",
      steps: "One.\n\n  Two.  \n",
      notes: { ...form.notes, [profile]: "Soft jaw." },
      ratings: { ...form.ratings, [profile]: { ...form.ratings[profile], [attr]: 2 } },
    };
    expect(patchOf(QUAD, next)).toEqual({
      text: { summary: "New words.", steps: ["One.", "Two."], conditions: { [profile]: "Soft jaw." } },
      conditions: { [profile]: { ...QUAD.conditions[profile], [attr]: 2 } },
    });
    expect(patchOf(QUAD, { ...form, low: "x" })).toEqual({ error: "The dose needs numbers." });
    // The dose is sent whole: what the form doesn't show goes as it was.
    expect(QUAD.dose.sets).toBeUndefined();
    expect(patchOf(QUAD, { ...form, high: "20", setsMin: "2", setsMax: "3" })).toEqual({ dose: { ...QUAD.dose, range: [QUAD.dose.range[0], 20], sets: [2, 3] } });
    // Sets are both given or both left blank.
    expect(patchOf(QUAD, { ...form, setsMin: "2" })).toEqual({ error: "The dose needs numbers." });
  });
});
