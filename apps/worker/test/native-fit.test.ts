/**
 * STAGE 2B FROM THE PHONE, "FIT IT TO THE DAY" (kit v0.15; stage 2b RG-NOTES §2): a `training-v3` device reaches
 * run-garden's own Build with the day's choices, a session's document read and revised by its revision, and the save with
 * the review's own feedback — the web's routes and services, nothing re-implemented — and v2 is refused each, exactly as
 * before.
 *
 *  - the gate's body rules: v3's Build holds only the choices the phone offers; its document edit is exactly
 *    `{doc, baseRev}`; its save may carry `review.graduations` and `review.excluded`;
 *  - Make it fit for an engine slot: minutes, place and a swap through Build's own schema; a swap lands only from the
 *    slot's own choices; a started session is locked; a document's build reads its checks alone, and Start still re-gates;
 *  - the document: an edit changes that session's row only — never the template it came from; a stale `baseRev` is 409
 *    `stale_revision` with nothing written; a session past, under way or done gets run-garden's own `why`;
 *  - progression: the review's Not for me and graduations apply once however often the save is sent, and a device's
 *    graduation applies only when the session's own recorded sets earn it — a partial session's `completed` flag earns
 *    nothing; the web's saves are as they were;
 *  - the player's swap: the save keeps the swapped move's work and its slot as played;
 *  - every request within a request's budget (45 statements and fetches; D1's bind cap on).
 *
 * Through the real route modules on the repo's migrations, under a faked `Date`. "Nothing written" is the whole database
 * compared before and after, but for the cookie's session row. Synthetic data only; `fetch` stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { addDays, newId, nowInstant, performedSessionSaveSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, LOCATION_PRESETS, makeEngineData } from "@rg/exercise-library";
import { Blocks } from "@rg/session-engine";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { deviceBuildBody, deviceDocBody, deviceFeedbackSaveBody } from "../src/auth/device-scope.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { loadProgramState } from "../src/services/engine-inputs.js";
import { createPlace } from "../src/services/places.js";
import { nativeRoutes } from "../src/routes/native.js";
import { conditionRoutes, sessionRoutes } from "../src/routes/sessions.js";
import { templateRoutes } from "../src/routes/templates.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { activateTmj, calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type CallOpts, type NativeWorld } from "./native-fixture.js";

const LA = "America/Los_Angeles";
const V2 = "training-v2";
const V3 = "training-v3";
/** A request's budget: D1 statements and fetches (the free plan's 50, with room). */
const BUDGET = 45;
const D = "2026-11-18";
const instant = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const setClock = (date: string, hhmm: string) => vi.setSystemTime(new Date(instant(date, hhmm)));

let w: NativeWorld;
let v3: string;
let v2: string;
let fetches = 0;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(D, "09:00");
  fetches = 0;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
    ["/api/conditions", conditionRoutes],
    ["/api/workouts", workoutRoutes],
    ["/api/templates", templateRoutes],
  ]);
  v3 = (await seedDevice(w.db, w.userId, { scope: V3, lastUsedAt: nowInstant(), expiresAt: "2027-06-01T00:00:00.000Z" })).token;
  v2 = (await seedDevice(w.db, w.userId, { scope: V2, lastUsedAt: nowInstant(), expiresAt: "2027-06-01T00:00:00.000Z" })).token;
});

const client = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[]; run(...a: unknown[]): unknown } } }).$client;
const q = (sql: string, ...args: unknown[]): any[] => client().prepare(sql).all(...args);
/** Every table, every row, but the cookie's own session row: "nothing written" is this, unchanged. */
function everything(): Record<string, unknown[]> {
  const tables = q(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('sessions') order by name`).map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, q(`select * from "${t}" order by rowid`)]));
}

/** A request, with the fetches it made: its total against the budget. */
async function costed(method: string, path: string, opts: CallOpts = {}): Promise<Answer & { total: number }> {
  const before = fetches;
  const a = await w.call(method, path, opts);
  return { ...a, total: a.statements.length + fetches - before };
}
const build = (id: string, body: unknown, bearer: string | null = v3) => costed("POST", `/api/sessions/${id}/build`, bearer === null ? { body } : { bearer, body });
const readDoc = (id: string, bearer: string | null = v3) => costed("GET", `/api/workouts/${id}/doc`, bearer === null ? {} : { bearer });
const editDoc = (id: string, body: unknown, bearer: string | null = v3) => costed("PUT", `/api/workouts/${id}/doc`, bearer === null ? { body } : { bearer, body });

/** A Studio workout the laptop makes on `day`. */
async function workoutOn(day: string, doc: WorkoutDoc = calmDoc()): Promise<string> {
  const made = await w.call("POST", "/api/workouts", { body: { doc, date: day, time: "18:00", clientId: `fit-${newId()}` } });
  expect(made.status, made.text).toBeLessThan(300);
  return made.json.workout.id as string;
}

/** The phone starts `id` from the build it was shown. */
async function phoneStarts(id: string, buildId: string): Promise<void> {
  const started = await w.call("POST", `/api/sessions/${id}/start`, { bearer: v3, body: { buildId } });
  expect(started.status, started.text).toBe(200);
}

/** What the phone's outbox sends for its session of `id` — moves done, one entry — with `over` laid on top. */
function wire(id: string, b: any, over: Record<string, unknown> = {}) {
  return performedSessionSaveSchema.parse({
    id: `p-${id}`, source: "app", sourceRef: null, workoutId: id, buildId: b.buildId, localDate: b.date,
    startedAt: instant(D, "09:05"), endedAt: instant(D, "09:35"), seconds: 1800, plannedSeconds: b.plannedSeconds ?? 1800, minutes: b.minutes ?? 30,
    mode: b.mode ?? null, theme: b.theme ?? null, locationId: b.locationId ?? null, blockRef: b.blockRef ?? null, blockNumber: null,
    completed: true, stepsTotal: (b.steps ?? []).length || 1, stepsDone: (b.steps ?? []).length || 1,
    movesDone: (b.items ?? []).map((i: { exerciseId: string; slotKey?: string }) => ({ exerciseId: i.exerciseId, seconds: 120, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
    note: null, newMove: b.newMove ?? null,
    entries: [{ exerciseId: b.items?.[0]?.exerciseId ?? "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }],
    checks: [], review: {}, ...over,
  });
}
const save = (body: { id: string }, bearer: string | null = v3, raw?: string) =>
  costed("PUT", `/api/sessions/performed/${body.id}`, { ...(bearer === null ? {} : { bearer }), ...(raw === undefined ? { body } : { raw }) });

describe("the gate's body rules for v3", () => {
  it("Build: only checks, overrides with minutes and locationId, and swaps; never mode or theme", () => {
    const ok = [{}, { checks: {} }, { overrides: { minutes: 25 } }, { overrides: { locationId: "p1" } }, { swaps: { "core:0": { from: "a", to: "b" } } },
      { checks: { tmj: { pre: 2, feelingOff: false } }, overrides: { minutes: 40, locationId: "p1" }, swaps: { "core:0": null } }];
    for (const b of ok) expect([b, deviceBuildBody(JSON.stringify(b))]).toEqual([b, true]);
    const refused = [{ overrides: { mode: "build" } }, { overrides: { theme: "t" } }, { overrides: { minutes: 25, mode: "recovery" } }, { other: 1 },
      { checks: [] }, { swaps: [] }, { overrides: null }, { overrides: "minutes" }, [], null, "{}"];
    for (const b of refused) expect([b, deviceBuildBody(JSON.stringify(b))]).toEqual([b, false]);
    expect(deviceBuildBody("not json")).toBe(false);
    expect(deviceBuildBody("")).toBe(false);
  });

  it("the document edit: exactly {doc, baseRev} — an object and a whole revision ≥ 0", () => {
    expect(deviceDocBody(JSON.stringify({ doc: {}, baseRev: 0 }))).toBe(true);
    expect(deviceDocBody(JSON.stringify({ doc: { title: "x" }, baseRev: 7 }))).toBe(true);
    for (const b of [{ doc: {}, baseRev: 1, force: true }, { doc: {} }, { baseRev: 1 }, { doc: [], baseRev: 1 }, { doc: null, baseRev: 1 }, { doc: {}, baseRev: "1" },
      { doc: {}, baseRev: -1 }, { doc: {}, baseRev: 1.5 }, { doc: {}, baseRev: null }, []]) {
      expect([b, deviceDocBody(JSON.stringify(b))]).toEqual([b, false]);
    }
    expect(deviceDocBody("not json")).toBe(false);
  });

  it("the save: the review's feedback allowed; still only the app's own source", () => {
    expect(deviceFeedbackSaveBody(JSON.stringify({ review: { graduations: [{ family: "hinge", to: "rdl" }], excluded: { bridge: true } } }))).toBe(true);
    expect(deviceFeedbackSaveBody(JSON.stringify({ source: "app", review: {} }))).toBe(true);
    for (const b of [{ source: "watch_review" }, { source: "import" }, { source: null }, { review: "graduate everything" }, { review: [] }, { review: null }]) {
      expect([b, deviceFeedbackSaveBody(JSON.stringify(b))]).toEqual([b, false]);
    }
    // Not an object at all: the route's own 422, as v1's rule leaves it.
    expect(deviceFeedbackSaveBody("[]")).toBe(true);
  });
});

describe("Make it fit for an engine slot: Build's choices, through run-garden's own schema and engine", () => {
  let place: string;
  beforeEach(async () => {
    place = await createPlace(w.db, w.userId, { name: "Gym", equipment: [...LOCATION_PRESETS.find((l) => l.id === "gym")!.equipment] }, nowInstant());
  });

  it("minutes, place and a swap from the slot's own choices: one Build, and the build is the choice", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const first = await build(slot, {});
    expect(first.status, first.text).toBe(200);
    const target = (first.json.build.items as Array<{ slotKey: string; exerciseId: string }>).find((i) => (first.json.build.alternatives[i.slotKey] ?? []).length > 0)!;
    const alt = first.json.build.alternatives[target.slotKey][0].id as string;
    const fitted = await build(slot, { checks: {}, overrides: { minutes: 25, locationId: place }, swaps: {} });
    expect([fitted.status, fitted.json.build.minutes, fitted.json.build.locationId], fitted.text).toEqual([200, 25, place]);
    expect(fitted.total).toBeLessThanOrEqual(BUDGET);
    // The swap, as the web's sheet sends it: from the slot's own choices (with the overrides kept: a request without them keeps them).
    const slotNow = (fitted.json.build.items as Array<{ slotKey: string; exerciseId: string }>).find((i) => (fitted.json.build.alternatives[i.slotKey] ?? []).length > 0)!;
    const to = fitted.json.build.alternatives[slotNow.slotKey][0].id as string;
    const swapped = await build(slot, { swaps: { [slotNow.slotKey]: { from: slotNow.exerciseId, to } } });
    expect(swapped.status, swapped.text).toBe(200);
    expect((swapped.json.build.items as Array<{ slotKey: string; exerciseId: string }>).find((i) => i.slotKey === slotNow.slotKey)!.exerciseId).toBe(to);
    expect([swapped.json.build.minutes, swapped.json.build.locationId]).toEqual([25, place]);
    expect(swapped.total).toBeLessThanOrEqual(BUDGET);
    void alt;
  });

  it("a swap to a move outside the slot's choices never lands: the engine keeps the slot's own move", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const first = (await build(slot, {})).json.build;
    const item = (first.items as Array<{ slotKey: string; exerciseId: string }>)[0]!;
    const offered = new Set((first.alternatives[item.slotKey] ?? []).map((a: { id: string }) => a.id));
    const outsider = ["snapDown", "deadlift", "bridge", "gobletSquat", "rdl"].find((x) => x !== item.exerciseId && !offered.has(x))!;
    const forced = await build(slot, { swaps: { [item.slotKey]: { from: item.exerciseId, to: outsider } } });
    expect(forced.status, forced.text).toBe(200);
    expect((forced.json.build.items as Array<{ slotKey: string; exerciseId: string }>).find((i) => i.slotKey === item.slotKey)!.exerciseId).toBe(item.exerciseId);
  });

  it("v2's Build is still exactly {}: the same choices are 403 out_of_scope, nothing written", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const held = everything();
    for (const body of [{ overrides: { minutes: 25 } }, { checks: {} }, { swaps: {} }]) {
      const a = await build(slot, body, v2);
      expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
    }
    expect(everything()).toEqual(held);
  });

  it("outside the phone's grammar is 403, outside the route's schema 422 invalid_build — each writing nothing", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const held = everything();
    for (const body of [{ overrides: { mode: "build" } }, { overrides: { theme: "anything" } }, { overrides: { minutes: 25, mode: "recovery" } }, { extra: true }]) {
      expect([(await build(slot, body)).status]).toEqual([403]);
    }
    for (const body of [{ overrides: { minutes: 5 } }, { overrides: { minutes: 25.5 } }, { overrides: { locationId: "" } }, { checks: { tmj: { pre: 11 } } }]) {
      const a = await build(slot, body);
      expect([JSON.stringify(body), a.status, a.json.error]).toEqual([JSON.stringify(body), 422, "invalid_build"]);
    }
    expect(everything()).toEqual(held);
  });

  it("once started, a session is locked: Build's choices are 409 locked, and the lock stands", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const b = (await build(slot, {})).json.build;
    await phoneStarts(slot, b.buildId);
    const held = everything();
    const a = await build(slot, { overrides: { minutes: 25 } });
    expect([a.status, a.json.error, a.json.session?.build?.buildId]).toEqual([409, "locked", b.buildId]);
    expect(everything()).toEqual(held);
  });
});

describe("a document workout: its build reads the checks alone, and Start still re-gates", () => {
  beforeEach(async () => {
    await activateTmj(w.db, w.userId);
  });

  it("overrides and swaps are not read for a document: the build is the document's own", async () => {
    const id = await workoutOn(D);
    const plain = (await build(id, {})).json.build;
    vi.advanceTimersByTime(1_000);
    const asked = await build(id, { overrides: { minutes: 10 }, swaps: { "parts[0].items[0]": { from: "bridge", to: "snapDown" } } });
    expect(asked.status, asked.text).toBe(200);
    expect([asked.json.build.minutes, asked.json.build.steps.map((s: { exerciseId?: string }) => s.exerciseId)]).toEqual([plain.minutes, plain.steps.map((s: { exerciseId?: string }) => s.exerciseId)]);
  });

  it("the phone's own body check that keeps a move out, with no alternate: Start is 409 gated, and nothing locks", async () => {
    const id = await workoutOn(D, landingsDoc({ alternates: false }));
    vi.advanceTimersByTime(1_000);
    const checked = await build(id, { checks: { tmj: { pre: 6, feelingOff: true } } });
    expect(checked.status, checked.text).toBe(200);
    expect(checked.json.build.fromDoc.blocked).toContainEqual(expect.objectContaining({ code: "condition_gate" }));
    vi.advanceTimersByTime(1_000);
    const refused = await w.call("POST", `/api/sessions/${id}/start`, { bearer: v3, body: { buildId: checked.json.build.buildId } });
    expect([refused.status, refused.json.error]).toEqual([409, "gated"]);
    expect(q(`select content_state as c from planned_workouts where id = ?`, id)[0].c).not.toBe("started");
    expect(q(`select count(*) as n from session_builds where workout_id = ? and locked_at is not null`, id)[0].n).toBe(0);
  });
});

describe("the document: GET and PUT /api/workouts/:id/doc with baseRev", () => {
  it("v3 reads a session's document; v2 is refused; an engine slot has none; another account's is 404", async () => {
    const id = await workoutOn(D);
    const a = await readDoc(id);
    expect([a.status, a.json.rev, a.json.origin, a.json.doc.title, Object.keys(a.json).sort()], a.text).toEqual([
      200, 1, "studio", "Hips and back", ["derived", "doc", "excluded", "locations", "origin", "rev"],
    ]);
    expect(a.writes).toEqual([]);
    expect(a.total).toBeLessThanOrEqual(BUDGET);
    // The web's read is as it was: none of the phone's two lists.
    expect(Object.keys((await readDoc(id, null)).json).sort()).toEqual(["derived", "doc", "origin", "rev"]);
    expect([(await readDoc(id, v2)).status, (await readDoc(id, v2)).json]).toEqual([403, { error: "out_of_scope" }]);
    const slot = await seedSlot(w.db, w.userId, D);
    expect((await readDoc(slot)).json).toEqual({ doc: null, reason: "missing" });
    // Another account's workout, made on its own laptop: not this phone's to read or edit.
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirCookie = `${SESSION_COOKIE}=${await createSession(w.db, other.userId, "test")}`;
    const made = await w.call("POST", "/api/workouts", { cookie: theirCookie, body: { doc: calmDoc(), date: D, time: "18:00", clientId: `theirs-${newId()}` } });
    expect(made.status, made.text).toBeLessThan(300);
    const theirs = made.json.workout.id as string;
    expect([(await readDoc(theirs)).status, (await readDoc(theirs)).json]).toEqual([404, { error: "not_found" }]);
    const held = everything();
    expect([(await editDoc(theirs, { doc: calmDoc({ title: "Mine now" }), baseRev: 1 })).status]).toEqual([404]);
    expect(everything()).toEqual(held);
  });

  it("the phone's read carries the places a document can name, as Build lists them, and the athlete's Not for me list", async () => {
    const id = await workoutOn(D);
    // No place of the account's yet: Build's choices list the preset Home, and so does the read.
    expect((await readDoc(id)).json.locations).toEqual([{ id: "home", name: "Home" }]);
    const gym = await createPlace(w.db, w.userId, { name: "Gym", equipment: ["kettlebell", "bench"] }, nowInstant());
    vi.advanceTimersByTime(1_000);
    const flat = await createPlace(w.db, w.userId, { name: "Flat", equipment: ["mat"], isDefault: true }, nowInstant());
    vi.advanceTimersByTime(1_000);
    const hotel = await createPlace(w.db, w.userId, { name: "Hotel", equipment: [] }, nowInstant());
    // The default first, then as they were made: exactly the list (and order) Build's choices give an engine slot.
    const slot = await seedSlot(w.db, w.userId, D);
    const built = await build(slot, {});
    expect((await readDoc(id)).json.locations).toEqual([{ id: flat, name: "Flat" }, { id: gym, name: "Gym" }, { id: hotel, name: "Hotel" }]);
    expect((await readDoc(id)).json.locations).toEqual(built.json.choices.locations);
    // Not for me, as it stands now: what the phone filters a document's swap lists with, as the web's item sheet does.
    expect((await readDoc(id)).json.excluded).toEqual([]);
    client().prepare(`insert into exercise_prefs (id, user_id, exercise_id, rating, excluded, pinned, updated_at) values (?, ?, 'deadBug', null, 1, 0, ?), (?, ?, 'bridge', 1, 0, 0, ?), (?, ?, 'birdDog', -1, 1, 0, ?)`)
      .run(`${w.userId}:deadBug`, w.userId, nowInstant(), `${w.userId}:bridge`, w.userId, nowInstant(), `${w.userId}:birdDog`, w.userId, nowInstant());
    const read = await readDoc(id);
    expect(read.json.excluded).toEqual(["birdDog", "deadBug"]);
    expect(read.writes).toEqual([]);
    expect(read.total).toBeLessThanOrEqual(BUDGET);
  });

  it("an edit (a move removed) is the session's next revision; only its row changes, with one revision row", async () => {
    const id = await workoutOn(D);
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    const removed: WorkoutDoc = { ...doc, parts: [{ ...doc.parts[0]!, items: doc.parts[0]!.items.slice(0, 1) }, ...doc.parts.slice(1)] };
    const a = await editDoc(id, { doc: removed, baseRev: 1 });
    expect([a.status, a.json.rev], a.text).toEqual([200, 2]);
    expect(a.total).toBeLessThanOrEqual(BUDGET);
    expect(JSON.parse(q(`select workout_doc as d from planned_workouts where id = ?`, id)[0].d)).toEqual(removed);
    expect(q(`select source_kind as k from workout_doc_revisions where workout_id = ? order by rowid`, id).map((r) => r.k).at(-1)).toBe("athlete_edit");
    // The web's revise exactly: the row, its revision, its sync intent. Never a template, programme, block, save or preference.
    const written = [...new Set(a.writes.map((s) => /^(?:insert into|update|delete from) "?(\w+)"?/i.exec(s)?.[1]))].sort();
    expect(written).toEqual(["planned_workouts", "sync_intents", "workout_doc_revisions"]);
    // Build again after an edit: the next build plays the new revision.
    const rebuilt = await build(id, {});
    expect([rebuilt.status, rebuilt.json.build.fromDoc.rev]).toEqual([200, 2]);
  });

  it("a longer document re-times the day's other session: the answer says so (`moved`), and never to a time before now (review r-m2)", async () => {
    // RV-D4: 09:00 today; the programme's session at 18:00 (its own time, unpinned) and a Studio session at 17:30.
    const slot = await seedSlot(w.db, w.userId, D);
    const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: D, time: "17:30", clientId: `fit-${newId()}` } });
    const id = made.json.workout.id as string;
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    // Make it fit, the other way: the same moves, far more of them — about 50 minutes.
    const longer: WorkoutDoc = {
      ...doc,
      parts: doc.parts.map((p) => ({ ...p, items: p.items.map((i) => (i.kind === "exercise" ? { ...i, dose: { ...i.dose, sets: 10, restSec: 90 } } : i)) })),
    };
    const a = await editDoc(id, { doc: longer, baseRev: 1 });
    expect([a.status, a.json.rev], a.text).toEqual([200, 2]);
    expect(a.json.workout.time).toBe("17:30");
    // The other session moved — later, after this one, and said so; not to the morning window, eleven hours gone.
    // Its exact shape: {workoutId, title, from: {date, time}, to: {date, time}}, a time `HH:MM` (or null for an untimed row).
    expect(a.json.moved).toEqual([{ workoutId: slot, title: "Mobility", from: { date: D, time: "18:00" }, to: { date: D, time: expect.stringMatching(/^\d{2}:\d{2}$/) } }]);
    const to = a.json.moved[0].to.time as string;
    expect(to > "18:00", to).toBe(true);
    expect(q(`select effective_time as t from planned_workouts where id = ?`, slot)[0].t).toBe(to);
    // An edit that changes nothing else on the day says nothing moved.
    const again = await editDoc(id, { doc: { ...longer, title: "Hips and back, long" }, baseRev: 2 });
    expect([again.status, again.json.moved]).toEqual([200, []]);
  });

  it("when it's the edited session that gives way, its own new time is in `workout`, and `moved` lists only the others", async () => {
    // The evening's programme session is the heavier one here (strength, an hour); the Studio session's time is its own,
    // not the athlete's pick (no time_change), so a longer version of it is the one that moves — later, after the hour.
    const slot = await seedSlot(w.db, w.userId, D);
    client().prepare(`update planned_workouts set category = 'strength', sport = 'strength', fallback_estimated_duration_seconds = 3600 where id = ?`).run(slot);
    const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: D, time: "17:30", clientId: `fit-${newId()}` } });
    const id = made.json.workout.id as string;
    client().prepare(`delete from schedule_overrides where workout_id = ? and kind = 'time_change'`).run(id);
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    const longer: WorkoutDoc = {
      ...doc,
      parts: doc.parts.map((p) => ({ ...p, items: p.items.map((i) => (i.kind === "exercise" ? { ...i, dose: { ...i.dose, sets: 10, restSec: 90 } } : i)) })),
    };
    const a = await editDoc(id, { doc: longer, baseRev: 1 });
    expect([a.status, a.json.moved], a.text).toEqual([200, []]);
    expect(a.json.workout.time > "18:00", a.json.workout.time).toBe(true);
    expect(q(`select effective_time as t from planned_workouts where id = ?`, slot)[0].t).toBe("18:00");
  });

  it("a stale baseRev is 409 stale_revision with the current rev, and nothing is written", async () => {
    const id = await workoutOn(D);
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    expect((await w.call("PUT", `/api/workouts/${id}/doc`, { body: { doc: { ...doc, title: "The laptop's edit" }, baseRev: 1 } })).status).toBe(200);
    const held = everything();
    const a = await editDoc(id, { doc: { ...doc, title: "The phone's edit" }, baseRev: 1 });
    expect([a.status, a.json]).toEqual([409, { error: "stale_revision", rev: 2 }]);
    expect(everything()).toEqual(held);
    expect((await readDoc(id)).json.doc.title).toBe("The laptop's edit");
  });

  it("a session under way, done or past, or an engine slot: run-garden's own refusal and why, nothing written", async () => {
    // Past: made yesterday, edited today.
    setClock(addDays(D, -1), "09:00");
    const past = await workoutOn(addDays(D, -1));
    setClock(D, "09:00");
    const underWay = await workoutOn(D);
    const b = (await build(underWay, {})).json.build;
    await phoneStarts(underWay, b.buildId);
    const done = await workoutOn(D);
    const db = (await build(done, {})).json.build;
    await phoneStarts(done, db.buildId);
    expect((await save(wire(done, db))).json.status).toBe("saved");
    const slot = await seedSlot(w.db, w.userId, D);
    const held = everything();
    const doc = calmDoc({ title: "Changed" });
    const refused = async (id: string) => (await editDoc(id, { doc, baseRev: 1 })).json;
    expect(await refused(past)).toEqual({ error: "past_date", why: "Its day has passed.", instead: "Propose for today or later." });
    expect(await refused(underWay)).toMatchObject({ error: "not_editable", cause: "under_way", why: "It's under way." });
    expect(await refused(done)).toMatchObject({ error: "not_editable", cause: "resolved", why: "It's already done." });
    expect(await refused(slot)).toMatchObject({ error: "not_editable", cause: "programme", why: "It's a programme's session: the programme builds it on the day." });
    expect(everything()).toEqual(held);
  });

  it("a session made from a template: the edit changes that session's document, never the template", async () => {
    const t = await w.call("POST", "/api/templates", { body: { name: "Morning hips", doc: calmDoc({ title: "Morning hips" }) } });
    expect(t.status, t.text).toBeLessThan(300);
    const used = await w.call("POST", `/api/templates/${t.json.template.id}/use`, { body: {} });
    const id = await workoutOn(D, used.json.doc as WorkoutDoc);
    expect((await readDoc(id)).json.origin).toBe("template");
    const template = q(`select * from workout_templates`);
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    const a = await editDoc(id, { doc: { ...doc, title: "Morning hips, shorter", parts: [{ ...doc.parts[0]!, items: doc.parts[0]!.items.slice(0, 1) }] }, baseRev: 1 });
    expect([a.status, a.json.rev], a.text).toEqual([200, 2]);
    expect(q(`select * from workout_templates`)).toEqual(template);
    expect(a.writes.filter((s) => /workout_templates/.test(s))).toEqual([]);
  });

  it("outside the phone's grammar is 403; a document the validator refuses is 422 invalid_doc; each writing nothing", async () => {
    const id = await workoutOn(D);
    const doc = (await readDoc(id)).json.doc as WorkoutDoc;
    const held = everything();
    for (const body of [{ doc, baseRev: 1, force: true }, { doc, baseRev: "1" }, { doc, baseRev: -1 }, { doc }, { doc: [doc], baseRev: 1 }]) {
      expect([(await editDoc(id, body)).status]).toEqual([403]);
    }
    expect([(await editDoc(id, { doc, baseRev: 1 }, v2)).status]).toEqual([403]);
    const invalid = await editDoc(id, { doc: { ...doc, parts: [] }, baseRev: 1 });
    expect([invalid.status, invalid.json.error]).toEqual([422, "invalid_doc"]);
    expect(everything()).toEqual(held);
  });
});

describe("the review's feedback from the phone: explicit, applied once, earned by the session's own sets", () => {
  /**
   * The core lifts the engine graduates at the top of their range on the place's heaviest bell (16 kg here), and what to:
   * its own rule (`Prog.suggest`'s top-out, then the move's harder variant). The engine rotates which families a session
   * holds, so each case takes the one its build holds.
   */
  const EARNABLE = [
    { family: "hinge", from: "deadlift", to: "rdl" },
    { family: "press", from: "floorPress", to: "oneArmBenchPress" },
  ] as const;

  /** Programme ids, in a fixed order: the engine's seed is the date and the programme, so each case builds the same. */
  let nextProgram = 0;
  beforeEach(() => void (nextProgram = 0));

  /**
   * A strength slot built at the athlete's place (the laptop's Build, in build mode), started by the phone: the first
   * programme, in the fixed order, whose build holds an earnable lift.
   */
  async function strengthStarted() {
    let found: { slot: string; programId: string; b: any; ids: string[]; lift: (typeof EARNABLE)[number] } | null = null;
    while (!found && nextProgram < 40) {
      const programId = `fit-program-${nextProgram++}`;
      const slot = await seedSlot(w.db, w.userId, D, programId);
      const b = (await build(slot, { overrides: { mode: "build" } }, null)).json.build;
      const ids = (b.items as Array<{ exerciseId: string }>).map((i) => i.exerciseId);
      const lift = EARNABLE.find((g) => ids.includes(g.from));
      if (lift) found = { slot, programId, b, ids, lift };
    }
    expect(found, "a build holding an earnable lift").not.toBeNull();
    const { slot, programId, b, ids, lift } = found!;
    // A move of the session that isn't the lift, for its Not for me.
    const other = ids.find((id) => id !== lift!.from)!;
    await phoneStarts(slot, b.buildId);
    return { slot, b, programId, lift: lift!, other, asked: [{ family: lift!.family, to: lift!.to }] };
  }
  /** The lift's sets, all at `kg` × `reps` (both earnable lifts top out at 10). */
  const sets = (exerciseId: string, kg: number, reps = 10) => ({
    exerciseId, implement: "kettlebell", format: "straight", perSide: false,
    sets: [0, 1, 2].map((setIndex) => ({ setIndex, reps, seconds: null, load: { v: kg, u: "kg" } })),
  });
  const bridge = { exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 12, seconds: null, load: null }] };
  /** The account's Not for me marks (a save also records the week's new move's first day there). */
  const prefsNow = () => q(`select exercise_id as id, excluded from exercise_prefs where user_id = ? and excluded = 1 order by exercise_id`, w.userId);

  beforeEach(async () => {
    // The athlete's place with its bells: at the heaviest, a lift's top of the range is a graduation (the engine's rule).
    await createPlace(w.db, w.userId, { name: "Home", equipment: [...LOCATION_PRESETS.find((l) => l.id === "home")!.equipment], implements: { kettlebell: "8, 12, 16 kg" }, isDefault: true }, nowInstant());
  });

  it("an earned graduation and a Not for me apply; the same save again is same_payload and writes nothing — one switch", async () => {
    const { slot, b, programId, lift, other, asked } = await strengthStarted();
    const body = wire(slot, b, { entries: [sets(lift.from, 16)], review: { graduations: asked, excluded: { [other]: true } } });
    const first = await save(body);
    expect([first.status, first.json.status, first.json.notes], first.text).toEqual([200, "saved", []]);
    const block = (await loadProgramState(w.db, programId))!;
    expect(block.core[lift.family]).toBe(lift.to);
    expect(block.rotations.filter((r) => r.why === "graduated")).toEqual([{ family: lift.family, from: lift.from, to: lift.to, date: D, why: "graduated" }]);
    expect(prefsNow()).toEqual([{ id: other, excluded: 1 }]);

    // Its answer lost, the outbox sends the same bytes again (and again).
    const held = everything();
    for (let i = 0; i < 3; i++) {
      const again = await save(body);
      expect([again.status, again.json]).toEqual([200, { status: "same_payload" }]);
      expect(again.writes).toEqual([]);
    }
    expect(everything()).toEqual(held);
    // The same id with other edits: a conflict, nothing written — never a second switch.
    const changed = { ...body, review: { ...body.review, graduations: [], excluded: { [other]: false } } } as typeof body;
    expect([(await save(changed)).status, (await save(changed)).json]).toEqual([409, { error: "conflict" }]);
    expect(everything()).toEqual(held);

    // A save is the account's heaviest request already (the activity, the match, the garden's step), and the review's
    // feedback was the web's cost before it was the phone's. What the phone adds — the earned check's read of the lift's
    // history (one ranked query, then four per 90 sessions it names) and the read of the session's own moves (review r-m3)
    // — is pinned against the web's own save of the same feedback. The garden's step is left out of both: how far it walks
    // depends on the account's state at each save, not on who sent it.
    const cost = async (by: string | null) => {
      const s = await strengthStarted();
      const a = await save(wire(s.slot, s.b, { entries: [sets(s.lift.from, 16)], review: { graduations: s.asked, excluded: { [s.other]: true } } }), by);
      expect([a.json.status, a.json.notes], a.text).toEqual(["saved", []]);
      return { total: a.total, outsideGarden: a.statements.filter((x) => !/garden_/.test(x)).length };
    };
    const phone = await cost(v3);
    const laptop = await cost(null);
    console.info(`[2b] a save with a graduation and a Not for me: the phone's ${phone.total} statements, the web's ${laptop.total} (${phone.outsideGarden} and ${laptop.outsideGarden} outside the garden's step)`);
    // The device's own row read stands where the cookie's session read does. The earned check is one ranked query, and four
    // more when the lift has history here (by which lift the build holds); the session's moves are one.
    expect(phone.outsideGarden - laptop.outsideGarden).toBeLessThanOrEqual(1 + 4 + 1);
  });

  it("a partial session — the lift never reached, the save still `completed: true` — earns nothing: skipped, said, and the rest lands", async () => {
    const { slot, b, programId, lift, other, asked } = await strengthStarted();
    const before = (await loadProgramState(w.db, programId))!;
    const partial = wire(slot, b, {
      completed: true,
      movesDone: [{ exerciseId: b.items[0].exerciseId, seconds: 60, slotKey: b.items[0].slotKey }],
      entries: [bridge],
      review: { graduations: asked, excluded: { [other]: true } },
    });
    const a = await save(partial);
    expect([a.status, a.json.status, a.json.notes], a.text).toEqual([200, "saved", ["graduation_skipped"]]);
    const after = (await loadProgramState(w.db, programId))!;
    expect([after.core[lift.family], after.rotations]).toEqual([before.core[lift.family], before.rotations]);
    expect(prefsNow()).toEqual([{ id: other, excluded: 1 }]);
  });

  it("the watch's own copy of this very session, ingested first, is not its history: an earned graduation still applies (review r-m1)", async () => {
    const { slot, b, programId, lift, asked } = await strengthSlotWithWatchCopy();
    const a = await save(wire(slot, b, { entries: [sets(lift.from, 16)], review: { graduations: asked } }));
    // The save joined the watch's activity (one physical session, one activity) and took over its sets…
    expect([a.status, a.json.status, a.json.activityId, a.json.notes], a.text).toEqual([200, "saved", "coros-lift", []]);
    expect(q(`select count(*) as n from performed_sessions where id = 'watch-copy'`)[0].n).toBe(0);
    // …and the graduation its own sets earned applied: the watch's lighter, shorter copy of the same lift was not judged.
    expect((await loadProgramState(w.db, programId))!.core[lift.family]).toBe(lift.to);
  });

  /**
   * A strength session the phone started, and the watch's own copy of it already ingested (review RV-G2): the phone was
   * offline at the review and COROS synced first. Its activity a minute after the phone's start, the same length; its
   * performed session that lift's newest entry — no load, 8 reps — and started after the phone's.
   */
  async function strengthSlotWithWatchCopy() {
    const started = await strengthStarted();
    const at = nowInstant();
    client()
      .prepare(`insert into activities (id, user_id, coros_activity_id, source, start_time, sport, duration_seconds, created_at, updated_at) values (?, ?, ?, 'coros', ?, 'strength', 1800, ?, ?)`)
      .run("coros-lift", w.userId, "coros-9001", new Date(Date.parse(instant(D, "09:06"))).toISOString().replace(".000Z", "Z"), at, at);
    client()
      .prepare(
        `insert into performed_sessions (id, user_id, workout_id, activity_id, source, source_ref, local_date, started_at, seconds, completed, moves_done, payload_hash, created_at, updated_at) values ('watch-copy', ?, null, 'coros-lift', 'watch', 'lbl-9001', ?, ?, 1800, 1, '[]', 'h', ?, ?)`,
      )
      .run(w.userId, D, instant(D, "09:06"), at, at);
    for (const i of [0, 1, 2]) {
      client()
        .prepare(`insert into performed_sets (id, performed_session_id, entry_index, exercise_id, implement, format, per_side, set_index, reps, done, flags) values (?, 'watch-copy', 0, ?, null, 'straight', 0, ?, 8, 1, '[]')`)
        .run(`watch-copy:0:${i}`, started.lift.from, i);
    }
    return started;
  }

  it("the lift done, but short of the top of what the place holds: no graduation either (the engine offers going up first)", async () => {
    const { slot, b, programId, lift, asked } = await strengthStarted();
    const a = await save(wire(slot, b, { entries: [sets(lift.from, 12)], review: { graduations: asked } }));
    expect([a.json.status, a.json.notes], a.text).toEqual(["saved", ["graduation_skipped"]]);
    expect((await loadProgramState(w.db, programId))!.core[lift.family]).toBe(lift.from);
  });

  it("a graduation the review never offers is skipped: the lift earned, but asked to switch to another of its family's moves", async () => {
    const { slot, b, programId, lift } = await strengthStarted();
    const before = (await loadProgramState(w.db, programId))!;
    // A move the block would take as that family's lift (the engine's own candidates at the place), but not the harder one
    // this session's sets earned: the web would switch to it; a device's save may not.
    const data = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES });
    const equipment = LOCATION_PRESETS.find((l) => l.id === "home")!.equipment;
    const sideways = Blocks.familyCandidates(data, lift.family, { equipment }).find((e) => e.id !== lift.from && e.id !== lift.to);
    expect(sideways, `another ${lift.family} candidate`).toBeDefined();
    expect(Blocks.graduate(data, before, lift.family, sideways!.id, D, equipment)).not.toBe(before);
    const a = await save(wire(slot, b, { entries: [sets(lift.from, 16)], review: { graduations: [{ family: lift.family, to: sideways!.id }] } }));
    expect([a.json.status, a.json.notes], a.text).toEqual(["saved", ["graduation_skipped"]]);
    expect((await loadProgramState(w.db, programId))!.core).toEqual(before.core);
  });

  it("never switches twice: the next session's save, carrying the same Switch, adds no second rotation (review r-m6, MU19)", async () => {
    const { slot, b, programId, lift, asked } = await strengthStarted();
    expect((await save(wire(slot, b, { entries: [sets(lift.from, 16)], review: { graduations: asked } }))).json.notes).toEqual([]);
    // The next day, the same programme's next session; the laptop's save carries the same Switch again (a stale review, a
    // second tab). Its lift is already the one asked for: nothing to switch, nothing skipped, one rotation.
    const next = addDays(D, 1);
    setClock(next, "09:00");
    const nextSlot = `${slot.slice(0, -D.length)}${next}`;
    const at = nowInstant();
    client()
      .prepare(
        `insert into planned_workouts (id, user_id, plan_id, source_workout_id, title, category, sport, original_plan_date, last_verified_coros_date, effective_date, effective_time, source_content_fingerprint, calendar_block_duration_seconds, fallback_estimated_duration_seconds, coros_sync_state, completion_state, origin, content_state, created_at, updated_at)
         values (?, ?, ?, ?, 'Mobility', 'yoga', 'yoga', ?, '', ?, '18:00', 'program', 1800, 1800, 'calendar_only', 'scheduled', 'program', 'outline', ?, ?)`,
      )
      .run(nextSlot, w.userId, programId, nextSlot, next, next, at, at);
    const nb = (await build(nextSlot, { overrides: { mode: "build" } }, null)).json.build;
    expect((await w.call("POST", `/api/sessions/${nextSlot}/start`, { body: { buildId: nb.buildId } })).status).toBe(200);
    const again = await save(
      wire(nextSlot, nb, { startedAt: instant(next, "09:05"), endedAt: instant(next, "09:35"), entries: [sets(lift.to, 16)], review: { graduations: asked } }),
      null,
    );
    expect([again.json.status, again.json.notes], again.text).toEqual(["saved", []]);
    const block = (await loadProgramState(w.db, programId))!;
    expect([block.core[lift.family], block.rotations.filter((r) => r.why === "graduated")]).toEqual([
      lift.to,
      [{ family: lift.family, from: lift.from, to: lift.to, date: D, why: "graduated" }],
    ]);
  });

  it("the web's save is as it was: it applies the graduation its review sends", async () => {
    const { slot, b, programId, lift, asked } = await strengthStarted();
    const a = await save(wire(slot, b, { entries: [bridge], review: { graduations: asked } }), null);
    expect([a.json.status, a.json.notes], a.text).toEqual(["saved", []]);
    expect((await loadProgramState(w.db, programId))!.core[lift.family]).toBe(lift.to);
  });

  /** The moves the session held: its build's items and what ⇄ offered for them. */
  const heldBy = (b: any) => new Set<string>([
    ...(b.items as Array<{ exerciseId: string }>).map((i) => i.exerciseId),
    ...Object.values(b.alternatives as Record<string, Array<{ id: string }>>).flat().map((a) => a.id),
  ]);
  /** Library moves this session never held. */
  const notHeld = (b: any, n: number) => EXERCISES.map((e) => e.id).filter((id) => !heldBy(b).has(id)).slice(0, n);

  it("a device's Not for me keeps only the session's own moves: the rest is skipped and said, never written (review r-m3)", async () => {
    const { slot, b, other } = await strengthStarted();
    const [outsideA, outsideB] = notHeld(b, 2);
    // ⇄'s offer for a slot, never played: the session held it, so it may be set aside too.
    const offered = Object.values(b.alternatives as Record<string, Array<{ id: string }>>).flat()[0]!.id;
    const body = wire(slot, b, { review: { excluded: { [other]: true, [offered]: true, [outsideA!]: true, [outsideB!]: false } } });
    const a = await save(body);
    expect([a.status, a.json.status, a.json.notes], a.text).toEqual([200, "saved", ["exclusion_skipped"]]);
    expect(prefsNow()).toEqual([other, offered].sort().map((id) => ({ id, excluded: 1 })));
    expect(q(`select count(*) as n from exercise_prefs where user_id = ? and exercise_id in (?, ?)`, w.userId, outsideA, outsideB)[0].n).toBe(0);
    // Its resend is the same save: nothing written, nothing new said.
    expect((await save(body)).json).toEqual({ status: "same_payload" });
  });

  it("a move the session played that the build never held (the player's swap) may be set aside; the web's Not for me is as it was", async () => {
    const { slot, b } = await strengthStarted();
    const [played, outside] = notHeld(b, 2);
    const swapped = wire(slot, b, {
      movesDone: [{ exerciseId: played!, seconds: 120, slotKey: b.items[0].slotKey }],
      entries: [{ exerciseId: played!, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 8, seconds: null, load: null }] }],
      review: { excluded: { [played!]: true } },
    });
    const a = await save(swapped);
    expect([a.json.status, a.json.notes], a.text).toEqual(["saved", []]);
    expect(prefsNow()).toEqual([{ id: played, excluded: 1 }]);
    // The laptop's save of another session is unchanged: it sets what its review sends.
    const web = await strengthStarted();
    const fromWeb = await save(wire(web.slot, web.b, { review: { excluded: { [outside!]: true } } }), null);
    expect([fromWeb.json.status, fromWeb.json.notes], fromWeb.text).toEqual(["saved", []]);
    expect(prefsNow().map((r) => r.id)).toContain(outside);
  });

  it("v2's save is as it was: graduations or Not for me are 403 out_of_scope before any write", async () => {
    const { slot, b, lift, other, asked } = await strengthStarted();
    const held = everything();
    for (const review of [{ graduations: asked }, { excluded: { [other]: true } }]) {
      const a = await save(wire(slot, b, { entries: [sets(lift.from, 16)], review }), v2);
      expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
    }
    expect(everything()).toEqual(held);
  });
});

describe("the player's swap: the save keeps what was played", () => {
  it("the swapped-in move's sets and the slot it was played in are saved as sent", async () => {
    const slot = await seedSlot(w.db, w.userId, D);
    const b = (await build(slot, {})).json.build;
    await phoneStarts(slot, b.buildId);
    const item = (b.items as Array<{ slotKey: string; exerciseId: string }>).find((i) => (b.alternatives[i.slotKey] ?? []).length > 0)!;
    const played = b.alternatives[item.slotKey][0].id as string;
    const body = wire(slot, b, {
      movesDone: [{ exerciseId: played, seconds: 150, slotKey: item.slotKey }],
      entries: [{ exerciseId: played, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 8, seconds: null, load: null }, { setIndex: 1, reps: 8, seconds: null, load: null }] }],
    });
    const a = await save(body);
    expect([a.status, a.json.status], a.text).toEqual([200, "saved"]);
    expect(JSON.parse(q(`select moves_done as m from performed_sessions where id = ?`, body.id)[0].m)).toEqual([{ exerciseId: played, seconds: 150, slotKey: item.slotKey }]);
    expect(q(`select exercise_id as e, reps from performed_sets where performed_session_id = ? order by set_index`, body.id)).toEqual([{ e: played, reps: 8 }, { e: played, reps: 8 }]);
    // The locked build is what was shown; the save doesn't rewrite it.
    expect(q(`select id as b from session_builds where workout_id = ? and locked_at is not null`, slot).map((r) => r.b)).toEqual([b.buildId]);
  });
});
