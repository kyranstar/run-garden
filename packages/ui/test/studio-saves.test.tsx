// @vitest-environment jsdom
/**
 * Saved-posts import, Task 15 — "FROM YOUR SAVES", THE REVIEW SCREEN (`/studio/saves`, `/studio/saves/:batchId`): the
 * batches, then a batch's rows (New / Linked to {name} / Check this), then a move's sheet — Edit, Not this move,
 * Same as…, Remove, Ask the coach — and Save these at the foot. A model's words (names, summaries, creators) are text,
 * never markup; a post's address is a link only when it is a web page's. Synthetic data only (example.com, made-up names).
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalMovesDto } from "@rg/api-client";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { FIT_SAVES_REQUEST, type SaveBatchDetailDto, type SaveBatchDto, type SaveBatchRowDto } from "@rg/saves";
import { StudioRoute } from "../src/app.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { patchOf, formOf } from "../src/screens/studio/saves-model.js";
import { DEVICE_PREFS, libraryDto, placesDto, primedClient, profileDto, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Synthetic moves and a batch ──

const base = EXERCISES.find((r) => r.id === "bridge")!;
function personal(id: string, name: string, summary: string): ExerciseRecord {
  const { providers: _providers, ...rest } = base;
  return { ...rest, id, name, legacyIds: [], easier: [], harder: [], text: { ...base.text, summary } };
}
const QUAD = personal("myZorbexQuadShuffle1a2b3c", "Zorbex quad shuffle", "Shuffle the quads, slow and even.");
const NECK = personal("myZorbexNeckNod4d5e6f", "Zorbex neck nod", "Nod slowly, the jaw soft.");
const LANTERN = personal("myLanternReach7g8h9i", "Lantern reach", "Reach long and slow, the hips level.");
const HIP = EXERCISES.find((e) => e.name === "90/90 hip switches")!;
const HOSTILE = '<img src=x onerror="alert(1)">';

const BATCH: SaveBatchDto = {
  id: "b1", status: "released", notice: "From your saves: 2 new moves (1 hip, 1 neck), 1 you already had.", theme: null,
  createdAt: "2026-10-23T10:00:00.000Z", releasedAt: "2026-10-23T10:00:00.000Z", savedAt: null, fittedAt: null, counts: { new: 2, linked: 1, removed: 0 },
  dismissedAt: null, fitStartedAt: null, fitting: false,
};
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
    move: { id: NECK.id, name: NECK.name, summary: NECK.text.summary, kind: "new", check: true, checkWhy: ["low_confidence", "inferred_dose"], seenDose: null, purpose: null, choice: null }, record: NECK,
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

function serve(o: { insights?: SaveBatchDetailDto["insights"]; batch?: Partial<SaveBatchDto> } = {}): Call[] {
  const calls: Call[] = [];
  const insights = "insights" in o ? o.insights : INSIGHTS;
  let batch = { ...BATCH, ...o.batch };
  let rows = ROWS.map((r) => ({ ...r }));
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
      if (method === "POST" && path === "/api/my-saves/batches/b1/save") {
        batch = { ...batch, status: "saved", savedAt: "2026-10-24T12:00:00.000Z" };
        rows = rows.map((r) => (r.status === "pending" ? { ...r, status: "saved" } : r));
        return json({ moves: 2, links: 3 });
      }
      const rematch = /^\/api\/my-saves\/post-moves\/([^/]+)\/(rematch|remove)$/.exec(path);
      if (rematch && method === "POST") {
        const id = rematch[1]!;
        if (rematch[2] === "remove") {
          rows = rows.map((r) => (r.postMoveId === id ? { ...r, status: "removed" } : r));
          return json({ ok: true });
        }
        return json({ ok: true, move: { id: body.to ?? "myOwnMove000001", kind: body.to && !body.to.startsWith("my") ? "library" : "personal" } });
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
const rowOf = (name: string) => [...document.querySelectorAll<HTMLElement>(".stu-save-row")].find((r) => r.querySelector(".stu-save-open")?.textContent === name) ?? null;
const openRow = (name: string) => click(rowOf(name)?.querySelector(".stu-save-open"), `${name}'s row`);
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── The batch ──

describe("a batch's rows", () => {
  it("Rows render New / Linked to {name} / Check this, under From your saves", async () => {
    serve();
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    expect(document.querySelector("h1")?.textContent).toBe("From your saves");
    expect(rowOf(QUAD.name)!.textContent).toContain("New");
    expect(rowOf(QUAD.name)!.textContent).not.toContain("Check this");
    expect(rowOf("90/90 Hip Switch")!.textContent).toContain(`Linked to ${HIP.name}`);
    expect(rowOf("90/90 Hip Switch")!.textContent).not.toContain("New");
    expect(rowOf(NECK.name)!.textContent).toContain("New");
    expect(rowOf(NECK.name)!.textContent).toContain("Check this");
    // The dose as the post gave it.
    expect(rowOf(QUAD.name)!.textContent).toContain("3 x 10");
    // A creator's words are text: no element is made of them.
    expect(rowOf(NECK.name)!.textContent).toContain(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
    // Each row's open button is a fingertip's target, and Save these is there.
    expect(button("Save these")).not.toBeNull();
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
    // Under the rows, above Save these.
    const rows = document.querySelector(".stu-tpl-list")!;
    expect(rows.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section!.compareDocumentPosition(button("Save these")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("Save these calls save; the batch reads as saved after", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!button("Save these"), "Save these");
    await click(button("Save these"), "Save these");
    await until(() => posts(calls, "/api/my-saves/batches/b1/save").length === 1 && !button("Save these"), "the save");
    expect(text()).toContain("Saved");
  });

  it("after Save these, Fit these in opens the coach with the Fit request — the batch saved already, never saved twice (final review I3)", async () => {
    const calls = serve();
    mount("/studio/saves/b1");
    await until(() => !!button("Save these"), "Save these");
    // Before the save, the page offers Save these, not Fit these in.
    expect(button("Fit these in")).toBeNull();
    await click(button("Save these"), "Save these");
    await until(() => !!button("Fit these in"), "Fit these in");
    expect(button("Save these")).toBeNull();
    await click(button("Fit these in"), "Fit these in");
    expect(opener.open).toHaveBeenCalledWith({ request: FIT_SAVES_REQUEST });
    expect(posts(calls, "/api/my-saves/batches/b1/save")).toHaveLength(1);
  });

  it("a saved batch not yet fitted in offers Fit these in when the page is opened again; one fitted in, nothing", async () => {
    serve({ batch: { status: "saved", savedAt: "2026-10-24T12:00:00.000Z" } });
    mount("/studio/saves/b1");
    await until(() => !!button("Fit these in"), "Fit these in");
    act(() => root?.unmount());
    host?.remove();
    root = null;
    vi.unstubAllGlobals();
    serve({ batch: { status: "saved", savedAt: "2026-10-24T12:00:00.000Z", fittedAt: "2026-10-24T13:00:00.000Z" } });
    mount("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
    await settle(10);
    expect(button("Fit these in")).toBeNull();
    expect(button("Save these")).toBeNull();
  });

  it("a batch that isn't there says so", async () => {
    serve();
    mount("/studio/saves/gone");
    await until(() => text().includes("isn't there"), "the refusal");
    expect(button("Save these")).toBeNull();
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
    expect([...why!.querySelectorAll("span:not(.stu-sep)")].map((x) => x.textContent)).toEqual(["Low confidence", "Dose inferred"]);
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
    await until(() => !!rowOf("90/90 Hip Switch"), "the rows");
    await openRow("90/90 Hip Switch");
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
    await until(() => posts(calls, "/api/my-saves/post-moves/pm1/remove").length === 1 && !rowOf(QUAD.name), "the removal");
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
    expect(text()).toContain("2 new");
    expect(text()).toContain("1 linked");
    await click(document.querySelector('a[href="/studio/saves/b1"]'), "the batch");
    expect(where).toBe("/studio/saves/b1");
    await until(() => !!rowOf(QUAD.name), "the rows");
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
