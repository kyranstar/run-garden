/**
 * Creating and revising a document workout (Stage 2 spec §10; programme spec §3.11): `POST /api/workouts` and
 * `PUT /api/workouts/:id/doc`, the one path the Studio and the coach's approvals share. Route tests use the real today
 * (the routes do), with dates relative to it. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { lockCurrentBuild, pushJobId } from "../src/services/session-build.js";
import { CALENDAR_OPS_PER_REQUEST } from "../src/services/calendar-sync.js";
import { createDocWorkout, studioProgramId } from "../src/services/doc-workouts.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, type Reply } from "./doc-workout-fixture.js";

const { plannedWorkouts, programs, workoutDocRevisions, exercisePrefs, corosWriteJobs, sessionBuilds, performedSessions, performedSets } = schema;

// The routes hand the calendar one bounded sync step through waitUntil; the tests count the hand-offs (the real sync,
// with its cost, is measured in doc-workout-budget.test.ts).
const calendar = vi.hoisted(() => ({ syncs: [] as Array<{ maxOps?: number } | undefined> }));
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async (_db: unknown, _env: unknown, _user: unknown, opts?: { maxOps?: number }) => {
    calendar.syncs.push(opts);
    return {};
  }),
}));

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;
/** Runs just before each statement the application executes (a test arms it to land a concurrent write there). */
let beforeStatement: ((sql: string) => void) | null;

beforeEach(async () => {
  statements = [];
  calendar.syncs = [];
  beforeStatement = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (s) => {
      statements.push(s);
      beforeStatement?.(s);
    },
  });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  call = await clientFor(db, userId);
});

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id));

/** A programme's slot (the engine builds it), as placement writes it. */
async function seedProgramRow(id: string, date: string): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "prog-1",
    sourceWorkoutId: id,
    title: "Mobility",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    origin: "program",
    contentState: "outline",
    workoutDoc: JSON.stringify(calmDoc()),
    workoutDocRev: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

/** A performed session of one move, two sets done, its first set carrying `flags`. */
async function seedPerformed(id: string, date: string, exerciseId: string, flags: string[]): Promise<void> {
  const at = `${date}T17:00:00.000Z`;
  await db.insert(performedSessions).values({
    id, userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: date,
    startedAt: at, endedAt: null, seconds: 1200, plannedSeconds: 1200, minutes: 20, mode: "consistent", theme: null,
    locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
    movesDone: [], note: null, newMove: null, payloadHash: "h", createdAt: at, updatedAt: at,
  });
  await db.insert(performedSets).values(
    [0, 1].map((setIndex) => ({
      id: `${id}-s${setIndex}`, performedSessionId: id, entryIndex: 0, exerciseId, implement: null, format: "straight",
      perSide: false, setIndex, side: null, reps: 5, seconds: null, loadValue: null, loadUnit: null, loadKg: null,
      done: true, flags: setIndex === 0 ? flags : [],
    })),
  );
}

describe("POST /api/workouts", () => {
  it("creates a Studio row at revision 1 with its revision, its fields derived from the document, hung from the account's Studio programme", async () => {
    const doc = calmDoc();
    const date = addDays(today, 2);
    const res = await call("POST", "/api/workouts", { date, time: "18:30", doc });
    expect(res.status).toBe(201);
    const id = res.body.workout.id as string;
    const derived = deriveDoc(doc, EXERCISES);
    expect(res.body.workout).toMatchObject({
      id,
      date,
      time: "18:30",
      title: "Hips and back",
      intentSummary: "Wake the glutes and brace the trunk.",
      category: derived.category,
      sport: derived.discipline,
      origin: "studio",
      contentState: "outline",
      completionState: "scheduled",
      docRev: 1,
      minutes: derived.estimatedMinutes,
    });
    expect(res.body.warnings).toEqual([]);

    const row = await rowOf(id);
    // The app's own session, as a programme slot is written: calendar only, no watch address, its own id as source.
    expect(row).toMatchObject({
      userId,
      planId: studioProgramId(userId),
      sourceWorkoutId: id,
      sourceProgramId: null,
      sourceIdInPlan: null,
      lastVerifiedCorosDate: "",
      originalPlanDate: date,
      effectiveDate: date,
      effectiveTime: "18:30",
      calendarSyncState: "not_created",
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      origin: "studio",
      contentState: "outline",
      category: derived.category,
      sport: derived.discipline,
      title: "Hips and back",
      workoutDocRev: 1,
    });
    expect(JSON.parse(row.workoutDoc!)).toEqual(doc);
    // The calendar books the derived length, rounded up to five minutes, as a built slot's is.
    expect(row.calendarBlockDurationSeconds).toBe(Math.max(300, Math.ceil((derived.estimatedMinutes * 60) / 300) * 300));
    expect(row.fallbackEstimatedDurationSeconds).toBe(row.calendarBlockDurationSeconds);

    const revs = await revisionsOf(id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ id: `${id}:1`, userId, rev: 1, sourceKind: "studio" });
    expect(JSON.parse(revs[0]!.doc)).toEqual(doc);

    const [program] = await db.select().from(programs).where(eq(programs.id, studioProgramId(userId)));
    expect(program).toMatchObject({ userId, kind: "studio", status: "active" });
  });

  it("a document based on a template makes a template row; a second create reuses the Studio programme", async () => {
    const doc: WorkoutDoc = { ...calmDoc(), basedOn: { kind: "template", id: "tpl-1" } };
    const a = await call("POST", "/api/workouts", { date: today, doc });
    const b = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: calmDoc() });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.workout.origin).toBe("template");
    expect(b.body.workout.origin).toBe("studio");
    expect(await db.select().from(programs).where(eq(programs.userId, userId))).toHaveLength(1);
  });

  it("hands the calendar one bounded sync step, as the athlete's own edits do; a refused one does not", async () => {
    expect((await call("POST", "/api/workouts", { date: addDays(today, 1), doc: calmDoc() })).status).toBe(201);
    expect(calendar.syncs).toEqual([{ maxOps: CALENDAR_OPS_PER_REQUEST }]);
    expect((await call("POST", "/api/workouts", { date: addDays(today, -1), doc: calmDoc() })).status).toBe(422);
    expect(calendar.syncs).toHaveLength(1);
  });

  it("with no time, the row takes the athlete's window for the day", async () => {
    const date = addDays(today, 3);
    const res = await call("POST", "/api/workouts", { date, doc: calmDoc() });
    expect(res.status).toBe(201);
    expect(res.body.workout.time).toMatch(/^\d{2}:\d{2}$/);
    expect((await rowOf(res.body.workout.id)).effectiveTime).toBe(res.body.workout.time);
  });

  it("422 with the issues on a fatal one, and nothing is written", async () => {
    await activateTmj(db, userId);
    const writesBefore = statements.filter(isWrite).length;
    // A jump today with no jaw check answered: the gate is closed.
    const res = await call("POST", "/api/workouts", { date: today, doc: landingsDoc() });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_doc");
    expect(res.body.issues).toContainEqual(
      expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "condition_gate", severity: "error" }),
    );
    // A move the library does not have.
    const unknown = await call("POST", "/api/workouts", {
      date: today,
      doc: { ...calmDoc(), parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "notAMove", dose: { reps: 5 } }] }] },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.issues[0]).toMatchObject({ code: "unknown_exercise", severity: "error" });
    // Not a document at all.
    const junk = await call("POST", "/api/workouts", { date: today, doc: { title: "x" } });
    expect(junk.status).toBe(422);
    expect(junk.body.issues.every((i: { code: string }) => i.code === "bounds")).toBe(true);
    expect(statements.filter(isWrite).length).toBe(writesBefore);
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).toEqual([]);
  });

  it("warnings are returned and never block", async () => {
    await db.insert(exercisePrefs).values({ id: `${userId}:deadBug`, userId, exerciseId: "deadBug", rating: null, excluded: true, pinned: false, introducedOn: null, updatedAt: nowInstant() });
    const res = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: calmDoc() });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toContainEqual(expect.objectContaining({ code: "excluded_by_athlete", severity: "warning", path: "parts[0].items[1].libraryId" }));
  });

  it("a gated move on a day ahead is allowed when its alternate suits a recovery day (a warning), refused without one", async () => {
    await activateTmj(db, userId);
    const ok = await call("POST", "/api/workouts", { date: addDays(today, 2), doc: landingsDoc() });
    expect(ok.status).toBe(201);
    expect(ok.body.warnings).toContainEqual(expect.objectContaining({ code: "condition_gate_pending", severity: "warning" }));
    const no = await call("POST", "/api/workouts", { date: addDays(today, 2), doc: landingsDoc({ alternates: false }) });
    expect(no.status).toBe(422);
  });

  it("refuses a day gone, a malformed date or time, and a body with extra keys", async () => {
    expect((await call("POST", "/api/workouts", { date: addDays(today, -1), doc: calmDoc() })).body).toEqual({ error: "past_date" });
    for (const body of [
      { date: "tomorrow", doc: calmDoc() },
      { date: today, time: "7pm", doc: calmDoc() },
      { date: today, doc: calmDoc(), extra: 1 },
      { date: today },
    ]) {
      const r = await call("POST", "/api/workouts", body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.error).toBe("invalid_workout");
    }
  });

  it("a jump is past the frontier until its easier rung was done cleanly — a clenched exposure is not (the engine's rule)", async () => {
    await activateTmj(db, userId);
    // Pogo hops sit one rung above snap-downs; the only snap-downs logged were clenched.
    await seedPerformed("p-1", addDays(today, -3), "snapDown", ["clenched"]);
    const pogo: WorkoutDoc = {
      ...landingsDoc(),
      parts: [{ purpose: "power", format: "straight", items: [{ kind: "exercise", libraryId: "pogoHop", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "tempoSquat" }] }] }],
    };
    const jump = { path: "parts[0].items[0].libraryId", code: "progression_jump" };
    const first = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: pogo });
    expect(first.status).toBe(201);
    expect(first.body.warnings).toContainEqual(expect.objectContaining(jump));
    // Done once more with no clench: now it unlocks the next rung.
    await seedPerformed("p-2", addDays(today, -2), "snapDown", []);
    const second = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: pogo });
    expect(second.body.warnings).not.toContainEqual(expect.objectContaining(jump));
  });

  it("a move done but never logged (a timed move the player only ticks) counts as done cleanly", async () => {
    await activateTmj(db, userId);
    const at = `${addDays(today, -1)}T17:00:00.000Z`;
    await db.insert(performedSessions).values({
      id: "p-ticked", userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: addDays(today, -1),
      startedAt: at, endedAt: null, seconds: 600, plannedSeconds: 600, minutes: 10, mode: "consistent", theme: null, locationId: null,
      blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [{ exerciseId: "snapDown", seconds: 60 }],
      note: null, newMove: null, payloadHash: "h", createdAt: at, updatedAt: at,
    });
    const pogo: WorkoutDoc = {
      ...landingsDoc(),
      parts: [{ purpose: "power", format: "straight", items: [{ kind: "exercise", libraryId: "pogoHop", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "tempoSquat" }] }] }],
    };
    const res = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: pogo });
    expect(res.status).toBe(201);
    expect(res.body.warnings).not.toContainEqual(expect.objectContaining({ code: "progression_jump" }));
  });

  it("stays within the statement budget (≤ 45) and D1's bound-variable cap, with history on the account", async () => {
    await activateTmj(db, userId);
    for (let i = 1; i <= 12; i++) await seedPerformed(`h-${i}`, addDays(today, -i), i % 2 ? "bwSplitSquat" : "snapDown", i % 3 ? [] : ["clenched"]);
    statements.length = 0;
    const res = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: landingsDoc() });
    expect(res.status).toBe(201);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("PUT /api/workouts/:id/doc", () => {
  async function created(date = addDays(today, 1), doc: WorkoutDoc = calmDoc()): Promise<string> {
    const res = await call("POST", "/api/workouts", { date, doc });
    expect(res.status).toBe(201);
    return res.body.workout.id;
  }

  it("writes revision 2 (an athlete's edit), re-derives the row, and says the watch holds nothing older when nothing was sent", async () => {
    const id = await created();
    const next = calmDoc({ title: "Hips, back and core" });
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: next, baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rev: 2, watchHasOlder: false, warnings: [] });
    expect(res.body.workout).toMatchObject({ id, title: "Hips, back and core", docRev: 2 });
    const row = await rowOf(id);
    expect(row).toMatchObject({ workoutDocRev: 2, title: "Hips, back and core" });
    expect(JSON.parse(row.workoutDoc!)).toEqual(next);
    const revs = (await revisionsOf(id)).sort((a, b) => a.rev - b.rev);
    expect(revs.map((r) => [r.id, r.rev, r.sourceKind])).toEqual([
      [`${id}:1`, 1, "studio"],
      [`${id}:2`, 2, "athlete_edit"],
    ]);
    expect(JSON.parse(revs[1]!.doc)).toEqual(next);
  });

  it("the same document again is no new revision, and leaves the calendar alone", async () => {
    const id = await created();
    calendar.syncs = [];
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc(), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body.rev).toBe(1);
    expect(res.body).not.toHaveProperty("calendarChanged");
    expect(await revisionsOf(id)).toHaveLength(1);
    expect(calendar.syncs).toEqual([]);
  });

  it("a synced calendar event is asked to update, and the calendar handed a sync step", async () => {
    const id = await created();
    await db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, id));
    calendar.syncs = [];
    await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Renamed" }), baseRev: 1 });
    expect((await rowOf(id)).calendarSyncState).toBe("pending");
    expect(calendar.syncs).toEqual([{ maxOps: CALENDAR_OPS_PER_REQUEST }]);
    // A change the event does not show (one rep more, within the same five booked minutes) leaves it as it is.
    await db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, id));
    calendar.syncs = [];
    const dose = calmDoc({ title: "Renamed" });
    (dose.parts[0]!.items[0] as { dose: { reps?: number } }).dose.reps = 13;
    const booked = (d: WorkoutDoc) => Math.max(300, Math.ceil((deriveDoc(d, EXERCISES).estimatedMinutes * 60) / 300) * 300);
    expect(booked(dose)).toBe(booked(calmDoc({ title: "Renamed" })));
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: dose, baseRev: 2 });
    expect(res.body.rev).toBe(3);
    expect((await rowOf(id)).calendarSyncState).toBe("synced");
    expect(calendar.syncs).toEqual([]);
  });

  it("409 stale_revision when the base moved on; nothing written", async () => {
    const id = await created();
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Second" }), baseRev: 1 })).status).toBe(200);
    const stale = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Third" }), baseRev: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "stale_revision", rev: 2 });
    expect((await rowOf(id)).title).toBe("Second");
    expect(await revisionsOf(id)).toHaveLength(2);
  });

  describe("a write that lands between the read and this one wins", () => {
    const sqlite = () => (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;
    const armed = (write: () => void) => {
      beforeStatement = (sql) => {
        if (!/^update "planned_workouts" set "title"/.test(sql)) return;
        beforeStatement = null;
        write();
      };
    };

    it("another revision: 409 stale_revision, and nothing of this one is written", async () => {
      const id = await created();
      const theirs = calmDoc({ title: "Edited elsewhere" });
      armed(() => {
        sqlite().prepare("update planned_workouts set workout_doc = ?, workout_doc_rev = 2, title = ? where id = ?").run(JSON.stringify(theirs), theirs.title, id);
        sqlite()
          .prepare("insert into workout_doc_revisions (id, user_id, workout_id, rev, doc, source_kind, source_ref, created_at) values (?, ?, ?, 2, ?, 'coach', null, ?)")
          .run(`${id}:2`, userId, id, JSON.stringify(theirs), nowInstant());
      });
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Mine" }), baseRev: 1 });
      expect(res).toEqual({ status: 409, body: { error: "stale_revision", rev: 2 } });
      const row = await rowOf(id);
      expect(row).toMatchObject({ title: "Edited elsewhere", workoutDocRev: 2 });
      expect(JSON.parse(row.workoutDoc!)).toEqual(theirs);
      expect((await revisionsOf(id)).map((r) => [r.rev, r.sourceKind]).sort()).toEqual([
        [1, "studio"],
        [2, "coach"],
      ]);
    });

    it("the workout resolved: 409 not_editable, its document and its fields kept", async () => {
      const id = await created(today);
      armed(() => sqlite().prepare("update planned_workouts set completion_state = 'completed' where id = ?").run(id));
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Too late" }), baseRev: 1 });
      expect(res).toEqual({ status: 409, body: { error: "not_editable" } });
      expect(await rowOf(id)).toMatchObject({ title: "Hips and back", workoutDocRev: 1, completionState: "completed" });
      expect(await revisionsOf(id)).toHaveLength(1);
    });

    it("the session started: 409 not_editable, its document and its fields kept", async () => {
      const id = await created(today);
      armed(() => sqlite().prepare("update planned_workouts set content_state = 'started' where id = ?").run(id));
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Mid-way" }), baseRev: 1 });
      expect(res).toEqual({ status: 409, body: { error: "not_editable" } });
      expect(await rowOf(id)).toMatchObject({ title: "Hips and back", workoutDocRev: 1 });
    });

    it("the row no longer a document workout: 409 not_editable, its fields kept", async () => {
      const id = await created(today);
      armed(() => sqlite().prepare("update planned_workouts set origin = 'program' where id = ?").run(id));
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Not mine" }), baseRev: 1 });
      expect(res).toEqual({ status: 409, body: { error: "not_editable" } });
      expect(await rowOf(id)).toMatchObject({ title: "Hips and back", workoutDocRev: 1 });
    });
  });

  describe("a row that cannot take the edit is refused before its document is judged (reload, not fix)", () => {
    /** A document with a fatal issue: a superset of three. */
    const broken = () => ({ ...calmDoc(), parts: [{ purpose: "main", format: "superset", items: [...calmDoc().parts[0]!.items, calmDoc().parts[0]!.items[0]] }] });

    it("a programme's session", async () => {
      await seedProgramRow("slot-2", addDays(today, 1));
      expect((await call("PUT", "/api/workouts/slot-2/doc", { doc: broken(), baseRev: 1 })).body).toEqual({ error: "not_editable" });
    });

    it("a completed workout, and a session under way", async () => {
      const done = await created(today);
      await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, done));
      expect((await call("PUT", `/api/workouts/${done}/doc`, { doc: broken(), baseRev: 1 })).body).toEqual({ error: "not_editable" });
      const going = await created(today);
      await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, going));
      expect((await call("PUT", `/api/workouts/${going}/doc`, { doc: broken(), baseRev: 1 })).body).toEqual({ error: "not_editable" });
    });

    it("a stale base", async () => {
      const id = await created();
      expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Second" }), baseRev: 1 })).status).toBe(200);
      expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: broken(), baseRev: 1 })).body).toEqual({ error: "stale_revision", rev: 2 });
    });
  });

  it("409 not_editable for a programme's own session", async () => {
    await seedProgramRow("slot-1", addDays(today, 1));
    const res = await call("PUT", "/api/workouts/slot-1/doc", { doc: calmDoc({ title: "Mine now" }), baseRev: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_editable" });
    expect((await rowOf("slot-1")).title).toBe("Mobility");
  });

  it.each(["completed", "skipped", "missed"] as const)("409 not_editable for a %s workout", async (state) => {
    const id = await created(today);
    await db.update(plannedWorkouts).set({ completionState: state }).where(eq(plannedWorkouts.id, id));
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Too late" }), baseRev: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_editable" });
    expect((await rowOf(id)).workoutDocRev).toBe(1);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("409 not_editable once the session has started", async () => {
    const id = await created(today);
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id));
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Mid-way" }), baseRev: 1 })).body).toEqual({ error: "not_editable" });
  });

  it("404 for another user's workout, an archived one, or none", async () => {
    const other = await makeTestUser(db);
    const theirs = await createDocWorkout(db, other.userId, { date: addDays(today, 1), doc: calmDoc() }, { today, now: nowInstant(), prefs: other.prefs });
    expect((await call("PUT", `/api/workouts/${theirs.workout.id}/doc`, { doc: calmDoc({ title: "Mine" }), baseRev: 1 })).status).toBe(404);
    expect((await rowOf(theirs.workout.id)).title).toBe("Hips and back");
    const id = await created();
    await db.update(plannedWorkouts).set({ archivedAt: nowInstant(), archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, id));
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc(), baseRev: 1 })).status).toBe(404);
    expect((await call("PUT", "/api/workouts/nowhere/doc", { doc: calmDoc(), baseRev: 1 })).status).toBe(404);
  });

  it("422 with the issues for a document with a fatal issue; the row is unchanged", async () => {
    const id = await created();
    const res = await call("PUT", `/api/workouts/${id}/doc`, {
      doc: { ...calmDoc(), parts: [{ purpose: "main", format: "superset", items: calmDoc().parts[0]!.items.concat(calmDoc().parts[0]!.items[0]!) }] },
      baseRev: 1,
    });
    expect(res.status).toBe(422);
    expect(res.body.issues).toContainEqual(expect.objectContaining({ code: "format_mismatch", severity: "error" }));
    expect((await rowOf(id)).workoutDocRev).toBe(1);
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc() })).status).toBe(422);
  });

  it("watchHasOlder when the watch holds a copy sent from an older revision", async () => {
    const id = await created(today);
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.status).toBe(200);
    const buildId = built.body.build.buildId as string;
    // Send locks the build; its push job is what says a copy is on the watch.
    await lockCurrentBuild(db, userId, id, buildId, nowInstant(), { as: "send", prefs });
    await db.insert(corosWriteJobs).values({
      id: pushJobId(buildId),
      userId,
      workoutId: id,
      kind: "program_session_push",
      expectedContentFingerprint: "fp",
      originalDate: today,
      destinationDate: today,
      requestedAt: nowInstant(),
      status: "verified",
      updatedAt: nowInstant(),
    });
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Changed after sending" }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rev: 2, watchHasOlder: true });
    // A copy taken off the watch is no copy.
    await db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, pushJobId(buildId)));
    const again = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Changed again" }), baseRev: 2 });
    expect(again.body).toMatchObject({ rev: 3, watchHasOlder: false });
    expect((await db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, id)))).length).toBeGreaterThan(0);
  });

  it("stays within the statement budget (≤ 45) with a copy on the watch", async () => {
    await activateTmj(db, userId);
    const id = await created(addDays(today, 1), landingsDoc());
    await db.insert(corosWriteJobs).values({
      id: pushJobId("b-1"), userId, workoutId: id, kind: "program_session_push", expectedContentFingerprint: "fp",
      originalDate: today, destinationDate: today, requestedAt: nowInstant(), updatedAt: nowInstant(), status: "verified",
    });
    await db.insert(sessionBuilds).values({
      id: "b-1", userId, workoutId: id, version: 1, engineVersion: "e", inputsHash: "h",
      payload: { build: { fromDoc: { rev: 1, swaps: [], blocked: [] } } }, workoutDoc: null, lockedAt: nowInstant(), createdAt: nowInstant(),
    });
    statements.length = 0;
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: landingsDoc({ reps: 10 }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body.watchHasOlder).toBe(true);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("the service", () => {
  it("createDocWorkout takes the revision's source from the caller (the coach's approval, Stage 3)", async () => {
    const { workout } = await createDocWorkout(
      db,
      userId,
      { date: addDays(today, 1), doc: { ...calmDoc(), source: { kind: "coach" } } },
      { today, now: nowInstant(), prefs },
      { sourceKind: "coach", sourceRef: "proposal-1" },
    );
    const [rev] = await revisionsOf(workout.id);
    expect(rev).toMatchObject({ sourceKind: "coach", sourceRef: "proposal-1" });
  });
});
