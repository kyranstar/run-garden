// @vitest-environment jsdom
/**
 * R11 — Start now of a quick start, or of a template whose document is on the device, with no network: it plays from a
 * build made on this device, under a provisional id, and the outbox records it later. Today's check is offered as
 * online, its answer kept for that session alone; two starts of one kind on one day are one session (Continue it); a
 * device holding another day's plan judges today with what it knows of today; a template never opened here, or a
 * workout of the athlete's own, still needs a connection.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDto, TodayResponse } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, validateWorkoutDoc, type EditAction } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { draftStore } from "../src/studio-drafts.js";
import { offlineDb, OFFLINE_STORES } from "../src/offline/idb.js";
import { loadBuild } from "../src/offline/builds.js";
import { isLocalId, loadLocalStart, localStarts } from "../src/offline/local-starts.js";
import { enqueue, outboxEntries } from "../src/offline/outbox.js";
import { loadExtras } from "../src/player/stored.js";
import { forgetOfflineIdentity } from "../src/offline/me.js";
import { DEVICE_PREFS, libraryDto, placesDto, primedClient, profileDto, todayDto, TODAY, type Primed } from "./studio-fixtures.js";
import { useCheckGatedTmj } from "./check-gated-profile.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_GEAR = ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"];
const ME = "u1";
const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

beforeEach(async () => {
  // The device's clock: 9 in the morning of the fixtures' day, on the account's clock (the device's zone).
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

interface Call {
  method: string;
  path: string;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/**
 * No network. What the service worker kept answers its reads (the templates list, when it holds one); every other
 * request fails as a dropped connection does.
 */
function offline(kept: { templates?: TemplateDto[] } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      calls.push({ method, path });
      if (method === "GET" && path === "/api/templates" && kept.templates) return json({ templates: kept.templates });
      throw new TypeError("Failed to fetch");
    }),
  );
  return calls;
}

/** `settings: false`: no settings read kept on the device (the account's zone then only the profile's, if kept). */
function mount(path: string, primed: Primed = {}, opts: { settings?: boolean } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ places: placesDto(HOME_GEAR), library: libraryDto({ tmj: true }), today: todayDto({ value: 2 }), ...primed });
  if (opts.settings !== false) qc.setQueryData(["settings"], { prefs: DEVICE_PREFS });
  qc.setQueryData(["me"], { userId: ME });
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
function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
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
async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string, scope: ParentNode = document) => buttons(scope).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === title) ?? null;
const startButton = () => document.querySelector<HTMLButtonElement>(".stu-build-start");
const startable = () => until(() => !!startButton() && !startButton()!.disabled, "Start now");
/** The provisional id the player opened on. */
const playedId = () => decodeURIComponent(where.replace(/^\/session\//, ""));
const posts = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map((c) => c.path);

const template = (id: string, doc: WorkoutDoc): TemplateDto => ({ id, name: doc.title, doc, pinned: true, uses: 0, lastUsedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", minutes: 20, discipline: "strength" });
const docOf = (title: string, effort: WorkoutDoc["intent"]["effort"], ...ids: string[]): WorkoutDoc => ({
  version: 1,
  title,
  intent: { summary: title, goals: [], focus: [], effort },
  parts: [{ purpose: "main", format: "straight", items: ids.map((id) => suggestedItem(rec(id), "main")) }],
  source: { kind: "studio" },
});

describe("Start now of a quick start with no network (R11)", () => {
  it("plays from this device: the build, its name and the start kept under a provisional id — nothing reaches the server but the create it tried", async () => {
    const calls = offline();
    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const id = playedId();
    expect(isLocalId(id)).toBe(true);
    const db = await offlineDb();
    const start = (await loadLocalStart(db, id))!;
    expect(start).toMatchObject({ localId: id, clientId: id.slice("local:".length), userId: ME, kind: "quick_start:desk_reset", date: TODAY, time: "09:00" });
    expect(start.doc.source).toEqual({ kind: "studio", ref: "quick_start:desk_reset" });
    const stored = (await loadBuild(db, id))!;
    expect(stored.build).toMatchObject({ buildId: id, date: TODAY });
    expect(stored.build.steps.length).toBeGreaterThan(0);
    // Today's reading, known here: the session's own before-reading.
    expect(stored.build.params.checks).toEqual({ tmj: { pre: 2, feelingOff: false } });
    expect(await loadExtras(db, id)).toMatchObject({ title: start.title, userId: ME, profiles: [expect.objectContaining({ profileId: "tmj" })] });
    expect(posts(calls)).toEqual(["/api/workouts"]);
  });

  it("today's check unanswered: offered first, as online — its answer kept for this session alone, never sent on its own", async () => {
    const calls = offline();
    mount("/studio/build/quick/desk_reset", { today: todayDto(null) });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    expect(button("Skip", sheet)).not.toBeNull();
    await click(buttons(sheet).find((b) => b.textContent === "3"), "3");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("the player"), "the player");
    const db = await offlineDb();
    expect((await loadBuild(db, playedId()))!.build.params.checks).toEqual({ tmj: { pre: 3, feelingOff: false } });
    // Nothing waits to send it: it travels in the session's save, or not at all.
    expect(await outboxEntries(db)).toEqual([]);
    expect(posts(calls).filter((p) => p !== "/api/workouts")).toEqual(["/api/conditions/checks"]);
  });

  it("Skip goes on without it: no before-reading", async () => {
    offline();
    mount("/studio/build/quick/desk_reset", { today: todayDto(null) });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    await click(button("Skip", dialog("Jaw / head")!), "Skip");
    await until(() => text().includes("the player"), "the player");
    expect((await loadBuild(await offlineDb(), playedId()))!.build.params.checks).toEqual({});
  });

  it("two starts of one kind on one day are one session: the second offers Continue it, into the first — once saved, another may begin", async () => {
    offline();
    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const first = playedId();
    unmount();

    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("You've started this today already."), "the offer");
    await click(button("Continue it"), "Continue it");
    await until(() => text().includes("the player"), "the player");
    expect(playedId()).toBe(first);
    const db = await offlineDb();
    expect((await localStarts(db, ME)).map((s) => s.localId)).toEqual([first]);
    unmount();

    // Its session saved (waiting in the outbox): done — a new Start is a new session.
    await enqueue(db, savedOf(first), ME);
    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    expect(playedId()).not.toBe(first);
    expect(await localStarts(db, ME)).toHaveLength(2);
  });
});

describe("Start now of a template with no network (R11)", () => {
  it("one whose document is on the device starts from it", async () => {
    offline({ templates: [template("t1", docOf("Thursday lift", "maintain", "gobletSquat"))] });
    mount("/studio/build/template/t1");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const start = (await loadLocalStart(await offlineDb(), playedId()))!;
    expect(start.kind).toBe("template:t1");
    expect(start.doc.basedOn).toEqual({ kind: "template", id: "t1" });
  });

  it("one never opened on this device says it needs a connection the first time", async () => {
    offline();
    mount("/studio/build/template/t9");
    await until(() => text().includes("Opening a template needs a connection the first time."), "the line");
    expect(startButton()).toBeNull();
  });
});

/** A session the server built (and, once started, started): enough for Start to lock it and the player to open. */
function builtSession(id: string, contentState: "built" | "started" = "built") {
  return {
    workoutId: id, date: TODAY, contentState, locked: contentState === "started", checks: {}, profiles: [],
    choices: { modes: [], themes: [], locations: [] },
    view: { mode: "consistent", proposedMode: "consistent", modeReasons: [], theme: null, proposedTheme: null, themeReasons: [], minutes: 8, location: { id: "home", name: "Home", equipment: [], implements: {} }, block: null, newMove: null },
    build: { buildId: "b1", version: 1, date: TODAY, steps: [], items: [], exercises: {}, alternatives: {}, targets: {}, newMove: null, params: { checks: {}, overrides: {}, swaps: {} }, fromDoc: { rev: 1, swaps: [], blocked: [] } },
    watch: null,
  };
}

/**
 * The network gone at Start and at the check's Save, then back before the create's retry. `checkAnswer` is what the
 * server says to the kept answer's send once online (a 500: it fails); `todayNow`, its Today read then (fix round 2:
 * the account's day, and whether it holds a reading).
 */
function flapping(opts: { checkAnswer?: number; todayNow?: TodayResponse } = {}): Array<Call & { body?: unknown }> {
  const calls: Array<Call & { body?: unknown }> = [];
  let online = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (!online) {
        // The check's Save is the last thing to fail: the network is back after it.
        if (method === "POST" && path === "/api/conditions/checks") online = true;
        throw new TypeError("Failed to fetch");
      }
      if (method === "POST" && path === "/api/workouts") {
        return json({ workout: { id: "w-new", date: body.date, time: body.time, title: body.doc.title, intentSummary: "", category: "mobility", sport: "mobility", origin: "studio", contentState: "outline", completionState: "scheduled", docRev: 1, minutes: 8 }, warnings: [] }, 201);
      }
      if (method === "POST" && path === "/api/conditions/checks") {
        return opts.checkAnswer ? json({ error: "down" }, opts.checkAnswer) : json({ check: { ...body, date: TODAY } });
      }
      if (method === "GET" && path === "/api/plan/today") return json(opts.todayNow ?? todayDto(null));
      if (method === "POST" && path === "/api/sessions/w-new/build") return json(builtSession("w-new"));
      if (method === "POST" && path === "/api/sessions/w-new/start") return json(builtSession("w-new", "started"));
      return json({ error: "not_found" }, 404);
    }),
  );
  return calls;
}

describe("an answer kept offline, the network back before the create (R11 fix round 1)", () => {
  it("the create lands online: the kept answer is sent as an ordinary check before the build — the server gates and builds on it", async () => {
    const calls = flapping();
    mount("/studio/build/quick/desk_reset", { today: todayDto(null) });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    await click(buttons(sheet).find((b) => b.textContent === "3"), "3");
    await click(button("Save", sheet), "Save");
    await until(() => where === "/session/w-new", "the player, on the server's workout");
    expect(posts(calls)).toEqual(["/api/workouts", "/api/conditions/checks", "/api/workouts", "/api/conditions/checks", "/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
    expect(calls.filter((c) => c.path === "/api/conditions/checks").map((c) => c.body)).toEqual([
      { profileId: "tmj", value: 3, feelingOff: false },
      { profileId: "tmj", value: 3, feelingOff: false },
    ]);
    // Online all the way from the create: nothing started on the device.
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);
  });

  it("its send fails: the build goes on, the day judged unanswered", async () => {
    const calls = flapping({ checkAnswer: 500 });
    mount("/studio/build/quick/desk_reset", { today: todayDto(null) });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    await click(buttons(sheet).find((b) => b.textContent === "3"), "3");
    await click(button("Save", sheet), "Save");
    await until(() => where === "/session/w-new", "the player");
    expect(posts(calls).slice(-3)).toEqual(["/api/conditions/checks", "/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
  });

  /**
   * Start, the check answered while the network is out (kept), then the create lands online: the player opens. A new
   * day's check, offered online once the day has turned, is skipped.
   */
  async function keptThenOnline(calls: Call[], cachedToday: TodayResponse = todayDto(null)): Promise<void> {
    mount("/studio/build/quick/desk_reset", { today: cachedToday });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    await click(buttons(sheet).find((b) => b.textContent === "3"), "3");
    await click(button("Save", sheet), "Save");
    await until(() => where === "/session/w-new" || !!dialog("Jaw / head"), "the player, or the new day's check");
    if (dialog("Jaw / head")) await click(button("Skip", dialog("Jaw / head")!), "Skip");
    await until(() => where === "/session/w-new", "the player");
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/plan/today").length).toBeGreaterThan(0);
  }

  it("the account's day has turned since it was kept: it is dropped, never sent as the new day's (fix round 2)", async () => {
    const calls = flapping({ todayNow: { ...todayDto(null), today: addDays(TODAY, 1) } });
    await keptThenOnline(calls);
    expect(posts(calls).filter((p) => p === "/api/conditions/checks")).toHaveLength(1);
    expect(posts(calls).slice(-2)).toEqual(["/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
  });

  it("the server already holds a reading for today: the kept one is dropped, the server's stands (fix round 2)", async () => {
    const calls = flapping({ todayNow: todayDto({ value: 5 }) });
    await keptThenOnline(calls);
    expect(posts(calls).filter((p) => p === "/api/conditions/checks")).toHaveLength(1);
    expect(posts(calls).slice(-2)).toEqual(["/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
  });

  it("answered offline with only yesterday's Today read kept: dated on the account's clock, so it is sent when the network returns the same day", async () => {
    const calls = flapping({ todayNow: todayDto(null) });
    await keptThenOnline(calls, { ...todayDto(null), today: addDays(TODAY, -1) });
    expect(calls.filter((c) => c.path === "/api/conditions/checks").map((c) => c.body)).toEqual([
      { profileId: "tmj", value: 3, feelingOff: false },
      { profileId: "tmj", value: 3, feelingOff: false },
    ]);
    expect(posts(calls).slice(-3)).toEqual(["/api/conditions/checks", "/api/sessions/w-new/build", "/api/sessions/w-new/start"]);
  });
});

describe("sign-out forgets a start under way (R11 fix round 2)", () => {
  it("signed out with one under way, then in again: the same kind on the same day starts afresh — no Continue it into what is gone", async () => {
    offline();
    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    const first = playedId();
    unmount();
    // Sign-out: the offline identity goes (the build, the session in progress, and now the start too).
    await forgetOfflineIdentity({ caches: undefined });
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);

    // Signed in again, the same day, still offline.
    mount("/studio/build/quick/desk_reset");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    expect(text()).not.toContain("You've started this today already.");
    expect(playedId()).not.toBe(first);
  });
});

describe("what an offline start needs kept on the device (R11 fix round 1)", () => {
  it("the condition profiles unknown (neither the library nor Today read kept): it needs a connection — never judged with no profiles", async () => {
    const calls = offline();
    mount("/studio/build/quick/desk_reset", { library: undefined, today: undefined });
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("Starting needs a connection — try again once you're online."), "the refusal");
    expect(text()).not.toContain("the player");
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);
    expect(posts(calls)).toEqual(["/api/workouts"]);
  });

  it("the account's zone unknown (no settings, no profile kept): it needs a connection — never dated by the device's clock", async () => {
    offline();
    mount("/studio/build/quick/desk_reset", {}, { settings: false });
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("Starting needs a connection — try again once you're online."), "the refusal");
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);
  });

  it("the settings gone but the profile kept (its week-long cache): dated on the profile's zone, and it starts", async () => {
    offline();
    mount("/studio/build/quick/desk_reset", { profile: { ...profileDto(), timezone: DEVICE_PREFS.timezone } }, { settings: false });
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("the player"), "the player");
    expect((await loadLocalStart(await offlineDb(), playedId()))!).toMatchObject({ date: TODAY, time: "09:00" });
  });
});

describe("judged offline as the server would (R11)", () => {
  // A gate the check reads: TMJ's until 2026-10-23, a stand-in's since (`CHECK_GATED`).
  useCheckGatedTmj();
  /** A press the jaw's flare keeps out, at develop effort. */
  const pressDoc = docOf("Press day", "develop", "halfKneelingPress");
  /** What this device kept of Today: yesterday's, its jaw read calm then. */
  const yesterdays = (): TodayResponse => ({ ...todayDto({ value: 1 }), today: addDays(TODAY, -1) });

  it("this device's plan is another day's: today is judged with nothing known of it — the check its errors wait on is asked (no Skip), and an answer that keeps the move out stops Start in the validator's words, nothing kept", async () => {
    offline({ templates: [template("t2", pressDoc)] });
    mount("/studio/build/template/t2", { today: yesterdays() });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    expect(button("Skip", sheet)).toBeNull();
    await click(buttons(sheet).find((b) => b.textContent === "8"), "8");
    await click(button("Save", sheet), "Save");
    const said = validateWorkoutDoc(pressDoc, { library: EXERCISES, activeProfiles: [PROFILES.tmj], day: { date: TODAY, today: TODAY, readings: { tmj: { pre: 8, post: null, feelingOff: false } } } }).find(
      (i) => i.severity === "error",
    )!.message;
    await until(() => text().includes(said), "the validator's words");
    expect(text()).not.toContain("the player");
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);
  });

  it("…and a calm answer starts it, with that answer — never the other day's — as its before-reading", async () => {
    offline({ templates: [template("t2", pressDoc)] });
    mount("/studio/build/template/t2", { today: yesterdays() });
    await startable();
    await click(startButton(), "Start now");
    await until(() => !!dialog("Jaw / head"), "the check");
    const sheet = dialog("Jaw / head")!;
    await click(buttons(sheet).find((b) => b.textContent === "0"), "0");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("the player"), "the player");
    const db = await offlineDb();
    expect((await loadBuild(db, playedId()))!.build).toMatchObject({ date: TODAY, params: { checks: { tmj: { pre: 0, feelingOff: false } } } });
  });

  it("a workout of the athlete's own (not a quick start or template) still needs a connection to start", async () => {
    const actions: EditAction[] = [{ type: "addItem", part: 1, item: suggestedItem(rec("catCow"), "main") as never }];
    let s = startEditing(newDoc("structured", { title: "Mine", source: { kind: "studio" } }));
    for (const a of actions) s = edit(s, a, EXERCISES);
    await draftStore().save(s.doc);
    offline();
    mount("/studio/build/new");
    await startable();
    await click(startButton(), "Start now");
    await until(() => text().includes("Starting needs a connection — try again once you're online."), "the refusal");
    expect(await localStarts(await offlineDb(), ME)).toEqual([]);
  });
});

/** A session of `workoutId` as the player saves it. */
function savedOf(workoutId: string) {
  return {
    id: "p-1",
    source: "app" as const,
    sourceRef: null,
    workoutId,
    buildId: workoutId,
    localDate: TODAY,
    startedAt: `${TODAY}T09:00:00.000Z`,
    endedAt: `${TODAY}T09:08:00.000Z`,
    seconds: 480,
    plannedSeconds: 480,
    minutes: 8,
    mode: "consistent" as const,
    theme: null,
    locationId: "home",
    blockRef: null,
    blockNumber: null,
    completed: true,
    stepsTotal: 1,
    stepsDone: 1,
    note: null,
    newMove: null,
    entries: [],
  };
}
