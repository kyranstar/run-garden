/**
 * THE PHONE'S READ CONTRACT (the LifeOS migration's kit v0.10): the phone's reads write nothing, by the server's own rule,
 * and the phone is told beforehand which of the day's rows it can open.
 *
 *  - `GET /api/native/today`: each row also says `written` — false only for an UNWRITTEN COURSE OUTLINE (a programme row
 *    with nothing on it whose plan is a course: `courseOf`, what a web opening writes on its day), true for everything
 *    else, whose opening is a pure read — and `docRev`, the row's current document revision (null without a document).
 *    Every field it had is as it was.
 *  - A DEVICE's `GET /api/sessions/:id` and `GET /api/sessions/:id/review-basis` of an unwritten course outline answer
 *    409 `not_written` and write nothing — no row, no revision, no `course_session_refused` note — due today or not,
 *    whatever `/today` said a moment before and whether or not it was asked. The cookie (the web) writes it as before.
 *
 * Rows of every kind on one day: a Studio session, a template's, a course's outline due today, a course's session already
 * written, an engine programme slot, an imported run, a coach-designed run, a paused course's outline, an outline of a
 * course whose definition is gone, and an outline whose plan is gone. Under a faked `Date`, on a made-up course
 * (`course-fixture.ts`), the Calendar sync mocked. Synthetic data only.
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

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema, newId, type CourseConfig, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { templateRoutes } from "../src/routes/templates.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { writeCourseSessionsDue } from "../src/services/course-sessions.js";
import type { Db } from "../src/services/db.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type Answer, type NativeWorld } from "./native-fixture.js";

const { plannedWorkouts, programs, syncNotes, workoutDocRevisions } = schema;

/** A Monday, and noon of it in Los Angeles (the world's zone). */
const MON = "2026-10-05";
const WED = "2026-10-07";
const NOW = "2026-10-05T19:00:00.000Z";
const WED_NOON = "2026-10-07T19:00:00.000Z";

let w: NativeWorld;
let prefs: UserPreferences;
let token: string;
/** The day's rows, by what they are. */
let ids: {
  studio: string;
  template: string;
  dueOutline: string;
  laterOutline: string;
  writtenCourse: string;
  engine: string;
  importedRun: string;
  coachRun: string;
  pausedOutline: string;
  goneDefinition: string;
  goneProgram: string;
};
let dueCourse: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
    ["/api/workouts", workoutRoutes],
    ["/api/templates", templateRoutes],
  ]);
  prefs = await loadPreferences(w.db, w.userId);
  ({ token } = await seedDevice(w.db, w.userId));
  ids = await seedDay();
  // The device's first request writes its last use (at most hourly, `touchDevice`); the clock stands still from here, so
  // no later request of the device writes it, and what a request writes is the route's alone.
  expect((await w.call("GET", "/api/native/me", { bearer: token })).status).toBe(200);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A running course on Mondays and Wednesdays at 18:15, its outlines placed as the hourly pass places them. */
async function course(db: Db, userId: string, config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId,
    kind: "course",
    name: "Evening practice",
    status: "active",
    disciplines: ["yoga"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 2], time: "18:15", placementWeeksAhead: 1, ...config }),
    onEnd: "continue",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  });
  await placeSlots(db, userId, id, MON, await loadPreferences(db, userId), NOW);
  return id;
}

/** A document workout made on the laptop for today, as the web makes one. */
async function made(doc: WorkoutDoc, time: string): Promise<string> {
  const a = await w.call("POST", "/api/workouts", { body: { doc, date: MON, time, clientId: `slot-${newId()}` } });
  expect(a.status, a.text).toBe(201);
  return a.json.workout.id as string;
}

/** A row the import or the coach put on today: not an app session. */
async function foreignRow(over: Partial<typeof plannedWorkouts.$inferInsert>): Promise<string> {
  const id = newId();
  await w.db.insert(plannedWorkouts).values({
    id, userId: w.userId, planId: "coros-plan", sourceWorkoutId: `coros-plan:${id}`, title: "Easy 30", category: "easy", sport: "run",
    originalPlanDate: MON, lastVerifiedCorosDate: MON, effectiveDate: MON, effectiveTime: "06:30", sourceContentFingerprint: `fp-${id}`,
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

async function seedDay(): Promise<typeof ids> {
  const studio = await made(calmDoc({ title: "Studio hips" }), "07:00");
  const saved = await w.call("POST", "/api/templates", { body: { name: "Saved hips", doc: calmDoc({ title: "Template hips" }) } });
  expect(saved.status, saved.text).toBe(201);
  const used = await w.call("POST", `/api/templates/${saved.json.template.id}/use`, { body: {} });
  const template = await made(used.json.doc as WorkoutDoc, "08:00");

  dueCourse = await course(w.db, w.userId);
  const written = await course(w.db, w.userId, { time: "19:30" });
  // The web opened that one today: written as session 1, an ordinary document workout from now on.
  const opened = await w.call("GET", `/api/sessions/${slotId(written, MON)}`);
  expect([opened.status, opened.json.origin], opened.text).toEqual([200, "studio"]);
  const paused = await course(w.db, w.userId, { time: "20:00" });
  await w.db.update(programs).set({ pausedUntil: WED }).where(eq(programs.id, paused));
  const gone = await course(w.db, w.userId, { time: "20:30" });
  const [goneRow] = await w.db.select().from(programs).where(eq(programs.id, gone));
  await w.db.update(programs).set({ config: { ...(goneRow!.config as object), course: "gone" } }).where(eq(programs.id, gone));

  const engine = await seedSlot(w.db, w.userId, MON);
  const orphan = await seedSlot(w.db, w.userId, MON);
  const [orphanRow] = await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, orphan));
  await w.db.delete(programs).where(eq(programs.id, orphanRow!.planId));

  const importedRun = await foreignRow({ origin: null });
  const runDoc = JSON.stringify({ version: 1, title: "Easy 30", intent: { summary: "Easy", goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }], source: { kind: "studio" } });
  const coachRun = await foreignRow({ origin: "coach", contentState: "outline", planId: "coach-plan", workoutDoc: runDoc, workoutDocRev: 3, effectiveTime: "06:00" });

  return {
    studio,
    template,
    dueOutline: slotId(dueCourse, MON),
    laterOutline: slotId(dueCourse, WED),
    writtenCourse: slotId(written, MON),
    engine,
    importedRun,
    coachRun,
    pausedOutline: slotId(paused, MON),
    goneDefinition: slotId(gone, MON),
    goneProgram: orphan,
  };
}

const raw = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).$client;
/** Every table's rows, sorted: what "nothing written" is compared on. */
function snapshot(): Record<string, string[]> {
  const tables = raw().prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all().map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, raw().prepare(`select * from "${t}"`).all().map((r) => JSON.stringify(r)).sort()]));
}

/** The request, and proof it wrote nothing: no write statement ran, and every table holds what it held. */
async function writesNothing(method: string, path: string, opts: Parameters<NativeWorld["call"]>[2] = {}): Promise<Answer> {
  const before = snapshot();
  const a = await w.call(method, path, opts);
  expect(a.writes, `${method} ${path}`).toEqual([]);
  expect(snapshot(), `${method} ${path}`).toEqual(before);
  return a;
}

const todayRows = async (bearer = token) => {
  const a = await w.call("GET", "/api/native/today", { bearer });
  expect(a.status, a.text).toBe(200);
  return a.json.sessions as Array<Record<string, unknown>>;
};
const rowOf = async (id: string) => (await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const NOT_WRITTEN = { error: "not_written" };

describe("GET /api/native/today: written and docRev, beside every field it had", () => {
  it("each row says whether opening it is a pure read, and its document's revision", async () => {
    const byId = Object.fromEntries((await todayRows()).map((s) => [s.id, { written: s.written, docRev: s.docRev }]));
    expect(byId).toEqual({
      // A document workout: its document is its content.
      [ids.studio]: { written: true, docRev: 1 },
      [ids.template]: { written: true, docRev: 1 },
      // A course's outline, due today: an opening by the web writes it.
      [ids.dueOutline]: { written: false, docRev: null },
      // A course's session the web's opening wrote: a document workout now.
      [ids.writtenCourse]: { written: true, docRev: 1 },
      // An engine programme slot: an opening reads it and writes nothing (its build is the sheet's own Build).
      [ids.engine]: { written: true, docRev: null },
      // Not an app session: the session routes answer 404, as they did, and write nothing.
      [ids.importedRun]: { written: true, docRev: null },
      [ids.coachRun]: { written: true, docRev: 3 },
      // A course's outline that isn't due (its plan paused; its definition gone): no opening writes it, and it is unwritten.
      [ids.pausedOutline]: { written: false, docRev: null },
      [ids.goneDefinition]: { written: false, docRev: null },
      // An outline whose plan is gone is no course's: it reads as it stands.
      [ids.goneProgram]: { written: true, docRev: null },
    });
  });

  it("keeps every field it had, as it had them, and adds only the two", async () => {
    const rows = await todayRows();
    for (const s of rows) expect(Object.keys(s)).toEqual(["id", "title", "sport", "category", "date", "time", "state", "written", "docRev"]);
    expect(rows.find((s) => s.id === ids.studio)).toEqual({ id: ids.studio, title: "Studio hips", sport: "strength", category: "strength", date: MON, time: "07:00", state: "scheduled", written: true, docRev: 1 });
    // Timed rows by time, as before: the two runs first.
    expect(rows.slice(0, 2).map((s) => s.id)).toEqual([ids.coachRun, ids.importedRun]);
  });

  it("an outline on a later day is unwritten on its own day too", async () => {
    vi.setSystemTime(new Date(WED_NOON));
    const later = (await todayRows()).find((s) => s.id === ids.laterOutline);
    expect(later).toMatchObject({ written: false, docRev: null });
  });

  it("the cookie gets the same rows", async () => {
    expect((await w.call("GET", "/api/native/today")).json).toEqual((await w.call("GET", "/api/native/today", { bearer: token })).json);
  });

  it("is a read: it writes nothing", async () => {
    await writesNothing("GET", "/api/native/today", { bearer: token });
  });
});

describe("a device's opening of an unwritten course outline: 409 not_written, and nothing written", () => {
  const OUTLINES = ["dueOutline", "laterOutline", "pausedOutline", "goneDefinition"] as const;

  for (const which of OUTLINES) {
    it(`GET /api/sessions/:id — ${which}`, async () => {
      const a = await writesNothing("GET", `/api/sessions/${ids[which]}`, { bearer: token });
      expect([a.status, a.json]).toEqual([409, NOT_WRITTEN]);
    });

    it(`GET /api/sessions/:id/review-basis — ${which}`, async () => {
      const a = await writesNothing("GET", `/api/sessions/${ids[which]}/review-basis`, { bearer: token });
      expect([a.status, a.json]).toEqual([409, NOT_WRITTEN]);
    });
  }

  it("a document the day refuses: no course_session_refused note either (the web's opening leaves one)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A document naming a move the library doesn't hold: the day's judge refuses it.
    const real = INTRO_COURSE.sessionDoc;
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation((n, opts) => {
      const doc = real(n, opts);
      return { ...doc, parts: [{ ...doc.parts[0]!, items: [{ kind: "exercise", libraryId: "noSuchMove", dose: { sets: 1, holdSec: 60 } }] }] };
    });
    for (const path of [`/api/sessions/${ids.dueOutline}`, `/api/sessions/${ids.dueOutline}/review-basis`]) {
      const a = await writesNothing("GET", path, { bearer: token });
      expect([a.status, a.json]).toEqual([409, NOT_WRITTEN]);
    }
    expect(INTRO_COURSE.sessionDoc).not.toHaveBeenCalled();
    expect(await w.db.select().from(syncNotes)).toEqual([]);

    // The web's opening judges it, is refused by the day, and leaves the note: as before.
    const web = await w.call("GET", `/api/sessions/${ids.dueOutline}`);
    expect([web.status, web.json.origin, web.json.build]).toEqual([200, "program", null]);
    expect((await w.db.select().from(syncNotes)).map((n) => [n.kind, n.workoutId])).toEqual([["course_session_refused", ids.dueOutline]]);
  });

  it("whatever /today said: a row read as written that has since become an outline is refused", async () => {
    expect((await todayRows()).find((s) => s.id === ids.writtenCourse)).toMatchObject({ written: true, docRev: 1 });
    // Its session retracted and brought back on its day (`program-slots.ts`'s revive): an outline again, its revision kept.
    await w.db
      .update(plannedWorkouts)
      .set({ origin: "program", courseSession: null, workoutDoc: null, contentState: "outline", sourceContentFingerprint: "program" })
      .where(eq(plannedWorkouts.id, ids.writtenCourse));
    expect((await rowOf(ids.writtenCourse)).workoutDocRev).toBe(1);

    for (const path of [`/api/sessions/${ids.writtenCourse}`, `/api/sessions/${ids.writtenCourse}/review-basis`]) {
      const a = await writesNothing("GET", path, { bearer: token });
      expect([a.status, a.json]).toEqual([409, NOT_WRITTEN]);
    }
    // And /today says so now: no document, so no revision, though the row keeps the number its next write goes past.
    expect((await todayRows()).find((s) => s.id === ids.writtenCourse)).toMatchObject({ written: false, docRev: null });
  });

  it("whatever /today said: a row read as unwritten that the hourly pass has since written opens as a pure read", async () => {
    expect((await todayRows()).find((s) => s.id === ids.dueOutline)).toMatchObject({ written: false, docRev: null });
    expect((await writeCourseSessionsDue(w.db, new Date(NOW))).written).toBeGreaterThanOrEqual(1);

    const a = await writesNothing("GET", `/api/sessions/${ids.dueOutline}`, { bearer: token });
    expect([a.status, a.json.origin, a.json.title]).toEqual([200, "studio", "Intro 1"]);
    expect((await todayRows()).find((s) => s.id === ids.dueOutline)).toMatchObject({ written: true, docRev: 1 });
  });

  it("asked straight, never having read /today: refused the same, by a device that has made no other request", async () => {
    const fresh = await seedDevice(w.db, w.userId, { lastUsedAt: NOW });
    const a = await writesNothing("GET", `/api/sessions/${ids.dueOutline}`, { bearer: fresh.token });
    expect([a.status, a.json]).toEqual([409, NOT_WRITTEN]);
    const b = await writesNothing("GET", `/api/sessions/${ids.laterOutline}/review-basis`, { bearer: fresh.token });
    expect([b.status, b.json]).toEqual([409, NOT_WRITTEN]);
  });

  it("another account's outline is not found, as before: the refusal says nothing of rows that aren't the device's", async () => {
    const other = await makeTestUser(w.db, { timezone: "America/Los_Angeles" });
    const theirs = slotId(await course(w.db, other.userId), MON);
    const a = await writesNothing("GET", `/api/sessions/${theirs}`, { bearer: token });
    expect([a.status, a.json]).toEqual([404, { error: "not_found" }]);
    const b = await writesNothing("GET", `/api/sessions/no-such-row`, { bearer: token });
    expect([b.status, b.json]).toEqual([404, { error: "not_found" }]);
  });
});

describe("the web, unchanged: the cookie's opening writes today's outline", () => {
  it("GET /api/sessions/:id writes it once, as session 1, and the device then reads it", async () => {
    const before = await rowOf(ids.dueOutline);
    expect([before.origin, before.workoutDoc]).toEqual(["program", null]);
    const web = await w.call("GET", `/api/sessions/${ids.dueOutline}`);
    expect([web.status, web.json.origin, web.json.title], web.text).toEqual([200, "studio", "Intro 1"]);
    expect(web.writes.length).toBeGreaterThan(0);
    const after = await rowOf(ids.dueOutline);
    expect([after.origin, after.courseSession, after.workoutDocRev]).toEqual(["studio", 1, 1]);
    expect(await w.db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, ids.dueOutline))).toHaveLength(1);

    const phone = await writesNothing("GET", `/api/sessions/${ids.dueOutline}`, { bearer: token });
    expect(phone.json).toEqual((await w.call("GET", `/api/sessions/${ids.dueOutline}`)).json);
  });

  it("GET /api/sessions/:id/review-basis writes it too, and answers not_built, as before", async () => {
    const web = await w.call("GET", `/api/sessions/${ids.dueOutline}/review-basis`);
    expect([web.status, web.json]).toEqual([409, { error: "not_built" }]);
    expect((await rowOf(ids.dueOutline)).origin).toBe("studio");
  });

  it("a day ahead: the web's opening writes nothing and answers the outline, as before", async () => {
    const web = await writesNothing("GET", `/api/sessions/${ids.laterOutline}`);
    expect([web.status, web.json.contentState, web.json.build]).toEqual([200, "outline", null]);
  });

  it("the web path is the credential's, not a header's: a cookie with any other Authorization still writes", async () => {
    const web = await w.call("GET", `/api/sessions/${ids.dueOutline}`, { cookie: true, headers: { Authorization: "Bearer not-a-device-token", "User-Agent": "LifeOS/1 (iPhone)" } });
    expect([web.status, web.json.origin]).toEqual([200, "studio"]);
  });
});

describe("written: true is exactly the rows a device opens as the web does", () => {
  it("every row /today calls written reads the same for the device and the cookie, and writes nothing for either", async () => {
    const rows = await todayRows();
    for (const s of rows.filter((r) => r.written)) {
      const id = s.id as string;
      for (const path of [`/api/sessions/${id}`, `/api/sessions/${id}/review-basis`]) {
        const phone = await writesNothing("GET", path, { bearer: token });
        const web = await writesNothing("GET", path);
        expect([phone.status, phone.json], `${path} (${id})`).toEqual([web.status, web.json]);
        expect(phone.json, path).not.toEqual(NOT_WRITTEN);
        // Statement for statement, past signing in (the device's row, or the cookie's session).
        const route = (s: string[]) => s.filter((q) => !/"(native_devices|sessions)"/.test(q));
        expect(route(phone.statements), path).toEqual(route(web.statements));
      }
    }
    // And every row it calls unwritten is refused to the device.
    for (const s of rows.filter((r) => !r.written)) {
      expect((await w.call("GET", `/api/sessions/${s.id as string}`, { bearer: token })).json).toEqual(NOT_WRITTEN);
    }
  });

  it("a built Studio session's review basis: the device's is the web's", async () => {
    const built = await w.call("POST", `/api/sessions/${ids.studio}/build`, { body: {} });
    expect(built.status, built.text).toBe(200);
    const phone = await writesNothing("GET", `/api/sessions/${ids.studio}/review-basis`, { bearer: token });
    expect(phone.status, phone.text).toBe(200);
    expect(phone.json).toEqual((await w.call("GET", `/api/sessions/${ids.studio}/review-basis`)).json);
  });
});
