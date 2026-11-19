/**
 * WHAT'S IN IT, AHEAD OF A SESSION'S DAY (stage 2c, kit v0.16; DESIGN-2c §2.3, §9.1): `GET /api/native/sessions/:id/ahead`
 * for a `training-v4` device — one session on a later day, built in memory and never stored.
 *
 *  - an engine slot: its moves are what Build `{}` would preview for that day; `session_builds` and `program_blocks` are
 *    unchanged after it, where Build `{}` in the same test changes `session_builds`; the laptop's stored preview choices
 *    stand; the writers (`insert`, `update`, `delete`) are never called;
 *  - a document: its moves, the doc read's derived minutes, the place it names; an outline: its course's next document
 *    (`coursePreviewDoc`), or `none` for a paused course — no outline written and no note left; a COROS run: its stages;
 *  - today or past 409 `not_ahead`; another account's, archived, rest or unknown 404; writes nothing; the gate; the
 *    restore's 503; the budget (≤ 30).
 *
 * Under a faked `Date`, on a made-up course (`course-fixture.ts`), the Calendar sync mocked. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema, NO_EQUIPMENT_PLACE, newId, sessionLead, type LeadBuild, type WorkoutDoc } from "@rg/domain";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { accountState, plannedWorkouts, programs, syncNotes } = schema;

const LA = "America/Los_Angeles";
const T = "2026-11-16";
const WED = "2026-11-18";
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const NOW = at(T, "12:00");

let w: NativeWorld;
let token: string;
let fetched: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    throw new Error("no external call from a read");
  }) as typeof fetch);
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
    ["/api/workouts", workoutRoutes],
  ]);
  ({ token } = await seedDevice(w.db, w.userId, { scope: "training-v4", lastUsedAt: NOW }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ahead = (id: string, bearer = token) => w.call("GET", `/api/native/sessions/${id}/ahead`, { bearer });

const raw = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).$client;
function snapshot(): Record<string, string[]> {
  const tables = raw().prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all().map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, raw().prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r)).sort()]));
}
const rowsOf = (table: string) => raw().prepare(`select * from "${table}" order by rowid`).all();

/** The request, and proof it wrote nothing: no write statement, every table as it was, no writer called, no waitUntil. */
async function readsOnly(id: string) {
  const before = snapshot();
  const writers = (["insert", "update", "delete"] as const).map((m) => vi.spyOn(w.db, m));
  const waitUntil = vi.fn();
  const res = await w.app.request(`/api/native/sessions/${id}/ahead`, { headers: { Authorization: `Bearer ${token}` } }, w.env, { waitUntil, passThroughOnException: () => undefined, props: {} } as never);
  for (const spy of writers) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  expect(waitUntil).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  const a = await ahead(id);
  expect(a.writes).toEqual([]);
  expect(a.status).toBe(res.status);
  return a;
}

/** A document workout made on the laptop. */
async function made(doc: WorkoutDoc, date: string): Promise<string> {
  const a = await w.call("POST", "/api/workouts", { body: { doc, date, time: "18:00", clientId: `slot-${newId()}` } });
  expect(a.status, a.text).toBe(201);
  return a.json.workout.id as string;
}

/** A running course on Mondays and Wednesdays, its outlines placed. */
async function course(over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await w.db.insert(programs).values({
    id, userId: w.userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null,
    raceDate: null, source: null, config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 2], time: "18:15", placementWeeksAhead: 1 }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  });
  await placeSlots(w.db, w.userId, id, T, await loadPreferences(w.db, w.userId), NOW);
  return id;
}

/** Build's moves as the session sheet reads them (`sessionLead`, every move): name → dose. */
const doses = (build: LeadBuild) => new Map(sessionLead(build, 999).moves.map((m) => [m.name, m.dose]));

describe("an engine slot ahead", () => {
  it("its moves are Build {}'s preview for that day; session_builds and program_blocks unchanged, where Build {} writes its preview", async () => {
    const id = await seedSlot(w.db, w.userId, WED);
    const builds = rowsOf("session_builds");
    const blocks = rowsOf("program_blocks");
    const first = await readsOnly(id);
    expect([first.status, first.json.basis, first.json.date, first.json.today], first.text).toEqual([200, "engine", WED, T]);
    expect(first.json.moves.length).toBeGreaterThan(0);
    expect([rowsOf("session_builds"), rowsOf("program_blocks")]).toEqual([builds, blocks]);

    // The web's Build {} of the same day: it stores a preview (version 0). Its moves are the ones /ahead said.
    const built = await w.call("POST", `/api/sessions/${id}/build`, { body: {} });
    expect(built.status, built.text).toBe(200);
    expect(rowsOf("session_builds")).toHaveLength(1);
    const b = built.json.build;
    expect(first.json.moves.map((m: { exerciseId: string }) => m.exerciseId)).toEqual(b.items.map((i: { exerciseId: string }) => i.exerciseId));
    const sheet = doses(b);
    for (const m of first.json.moves) expect([m.name, m.dose]).toEqual([b.exercises[m.exerciseId].name, sheet.get(m.name)]);
    expect([first.json.minutes, first.json.place]).toEqual([built.json.view.minutes, { id: built.json.view.location.id, name: built.json.view.location.name }]);

    // Asked again with the preview stored: the stored preview, unchanged by the read.
    const held = rowsOf("session_builds");
    const again = await readsOnly(id);
    expect(again.json).toEqual(first.json);
    expect(rowsOf("session_builds")).toEqual(held);
    expect(fetched).toEqual([]);
  });

  it("the laptop's choices for that day's preview stand: its length, and the place the build took", async () => {
    const id = await seedSlot(w.db, w.userId, WED);
    const built = await w.call("POST", `/api/sessions/${id}/build`, { body: { overrides: { minutes: 20, locationId: NO_EQUIPMENT_PLACE } } });
    expect(built.status, built.text).toBe(200);
    const a = await readsOnly(id);
    expect([built.json.view.minutes, a.json.basis, a.json.minutes, a.json.place.id]).toEqual([20, "engine", 20, built.json.view.location.id]);
    expect(a.json.moves.map((m: { exerciseId: string }) => m.exerciseId)).toEqual(built.json.build.items.map((i: { exerciseId: string }) => i.exerciseId));
  });

  it("a slot whose programme is gone says nothing more; no write", async () => {
    const id = await seedSlot(w.db, w.userId, WED);
    const [row] = await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
    await w.db.delete(programs).where(eq(programs.id, row!.planId));
    const a = await readsOnly(id);
    expect([a.status, a.json.basis, a.json.moves]).toEqual([200, "none", []]);
  });

  it("what it costs: at most 30 statements (14 for a slot with no history)", async () => {
    const id = await seedSlot(w.db, w.userId, WED);
    const a = await ahead(id);
    expect(a.status).toBe(200);
    expect(a.statements.length).toBeLessThanOrEqual(30);
    // The gate, restore, preferences, the row; its builds; the engine's inputs (programme, profiles, prefs, saved moves, places,
    // library, block, name, history).
    expect(a.statements.length).toBe(14);
  });
});

describe("a document, an outline, a run's stages, nothing", () => {
  it("a document: its moves in order, the doc read's derived minutes, its revision; the place it names", async () => {
    const id = await made(calmDoc({ title: "Studio hips" }), WED);
    const a = await readsOnly(id);
    const read = await w.call("GET", `/api/workouts/${id}/doc`);
    expect(a.json).toEqual({
      workoutId: id, date: WED, today: T, basis: "document", title: "Studio hips",
      minutes: Math.round(read.json.derived.estimatedMinutes), place: null,
      moves: [
        { exerciseId: "bridge", name: expect.any(String), dose: "2 × 12" },
        { exerciseId: "deadBug", name: expect.any(String), dose: "2 × 8" },
      ],
      summary: null, docRev: 1, distanceMeters: null,
    });
    const bare = await made({ ...calmDoc({ title: "Bare hips" }), setting: { placeId: NO_EQUIPMENT_PLACE } }, WED);
    expect((await readsOnly(bare)).json.place).toEqual({ id: NO_EQUIPMENT_PLACE, name: "No equipment" });
  });

  it("an outline ahead: its course's next session as it stands now — no outline written, no note; a paused course: none", async () => {
    const plan = await course();
    const id = slotId(plan, WED);
    const before = (await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
    const a = await readsOnly(id);
    expect([a.json.basis, a.json.moves, a.json.docRev]).toEqual(["course", [{ exerciseId: "legsUp", name: expect.any(String), dose: "11 min" }], null]);
    expect((await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]).toEqual(before);
    expect(await w.db.select().from(syncNotes)).toEqual([]);

    await w.db.update(programs).set({ pausedUntil: WED }).where(eq(programs.id, plan));
    expect((await readsOnly(id)).json).toMatchObject({ basis: "none", moves: [] });
    await w.db.update(programs).set({ pausedUntil: null, status: "completed" }).where(eq(programs.id, plan));
    expect((await readsOnly(id)).json).toMatchObject({ basis: "none", moves: [] });
  });

  it("a COROS-plan run: its stages, minutes and distance, the title as stored with its words", async () => {
    const id = newId();
    await w.db.insert(plannedWorkouts).values({
      id, userId: w.userId, planId: "coros-plan", sourceWorkoutId: `1:${id}`, title: "T1004", category: "quality", qualitySubtype: "threshold", sport: "run",
      originalPlanDate: WED, lastVerifiedCorosDate: WED, effectiveDate: WED, effectiveTime: "18:30", sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3000, sourceEstimatedDurationSeconds: 2700, expectedDistanceMeters: 9000,
      stageSummary: "10 min warm up · 3 × 8 min threshold · 10 min cool down", createdAt: NOW, updatedAt: NOW,
    });
    const a = await readsOnly(id);
    expect(a.json).toMatchObject({ basis: "stages", title: "T1004", label: expect.any(String), minutes: 45, summary: "10 min warm up · 3 × 8 min threshold · 10 min cool down", distanceMeters: 9000, moves: [], place: null });
    // An easy run with no stages: nothing more to say.
    const plain = newId();
    await w.db.insert(plannedWorkouts).values({
      id: plain, userId: w.userId, planId: "coros-plan", sourceWorkoutId: `1:${plain}`, title: "Easy 30", category: "easy", sport: "run",
      originalPlanDate: WED, lastVerifiedCorosDate: WED, effectiveDate: WED, effectiveTime: "07:00", sourceContentFingerprint: "fp2",
      calendarBlockDurationSeconds: 1800, createdAt: NOW, updatedAt: NOW,
    });
    expect((await readsOnly(plain)).json).toMatchObject({ basis: "none", summary: null, moves: [] });
  });
});

describe("refusals", () => {
  it("today or past: 409 not_ahead with the date and the account's today, nothing written", async () => {
    for (const date of [T, "2026-11-10"]) {
      const id = await seedSlot(w.db, w.userId, date);
      const a = await readsOnly(id);
      expect([a.status, a.json]).toEqual([409, { error: "not_ahead", date, today: T }]);
    }
  });

  it("another account's row, an archived one, a rest row, an unknown id: 404 not_found", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirs = await seedSlot(w.db, other.userId, WED);
    const archived = await seedSlot(w.db, w.userId, WED);
    await w.db.update(plannedWorkouts).set({ archivedAt: NOW }).where(eq(plannedWorkouts.id, archived));
    const rest = newId();
    await w.db.insert(plannedWorkouts).values({
      id: rest, userId: w.userId, planId: "p", sourceWorkoutId: rest, title: "Rest", category: "rest", sport: "rest", originalPlanDate: WED,
      lastVerifiedCorosDate: WED, effectiveDate: WED, effectiveTime: "", sourceContentFingerprint: "r", calendarBlockDurationSeconds: 0, createdAt: NOW, updatedAt: NOW,
    });
    for (const id of [theirs, archived, rest, newId()]) {
      const a = await readsOnly(id);
      expect([a.status, a.json]).toEqual([404, { error: "not_found" }]);
      expect(a.text.includes(other.userId)).toBe(false);
    }
  });

  it("the gate: v3 is 403; the query rule: any query is 403; the cookie reads it; 503 retryable during a restore", async () => {
    const id = await seedSlot(w.db, w.userId, WED);
    const v3 = await seedDevice(w.db, w.userId, { scope: "training-v3", lastUsedAt: NOW });
    expect((await ahead(id, v3.token)).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("GET", `/api/native/sessions/${id}/ahead?x=1`, { bearer: token })).json).toEqual({ error: "out_of_scope" });
    const device = await ahead(id);
    const cookie = await w.call("GET", `/api/native/sessions/${id}/ahead`);
    expect([device.status, cookie.status, device.headers["cache-control"]]).toEqual([200, 200, "no-store"]);
    expect(cookie.json).toEqual(device.json);
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: NOW, updatedAt: NOW });
    const a = await ahead(id);
    expect([a.status, a.json, a.headers["cache-control"]]).toEqual([503, { error: "restore_in_progress", retryable: true }, "no-store"]);
    expect(a.statements.some((s) => /planned_workouts|session_builds|program_blocks/.test(s))).toBe(false);
  });
});
