/**
 * The parity diagnostic and the workout read routes (Task 12). Synthetic data only: counts and ids come back, never
 * titles; a row with no usable document is reported, never a 500; rest days are exempt; archived rows do not exist.
 */
import { describe, expect, it } from "vitest";
import { plannedWorkouts, sessionBuilds } from "@rg/database";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { settingsRoutes } from "../src/routes/misc.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { checkWorkoutDocParity, minutesDiffer } from "../src/services/workout-doc-parity.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const NOW = "2026-10-01T00:00:00.000Z";

function docOf(over: { title?: string; summary?: string; items?: unknown[] } = {}): WorkoutDoc {
  return workoutDocSchema.parse({
    version: 1,
    title: over.title ?? "Easy run",
    intent: { summary: over.summary ?? "Keep it gentle", goals: [], focus: [], effort: "maintain" },
    source: { kind: "coach" },
    parts: [{ purpose: "main", format: "straight", items: over.items ?? [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }],
  });
}

async function seed(
  db: Db,
  userId: string,
  id: string,
  over: Partial<typeof plannedWorkouts.$inferInsert> = {},
): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "coach-adhoc",
    sourceWorkoutId: id,
    title: "Easy run",
    category: "easy",
    sport: "run",
    originalPlanDate: "2026-10-05",
    lastVerifiedCorosDate: "",
    effectiveDate: "2026-10-05",
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1800,
    sourceEstimatedDurationSeconds: 1800,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}

async function client(db: Db, userId: string) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const diag = mountRoutes(db, "/api/settings", settingsRoutes);
  const work = mountRoutes(db, "/api/workouts", workoutRoutes);
  const env = { FIXTURE_MODE: "1" } as never;
  return {
    diag: async (qs = "") => {
      const res = await diag.request(`/api/settings/diagnostics/workout-docs${qs}`, { headers: { Cookie: cookie } }, env);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    },
    work: async (path: string) => {
      const res = await work.request(`/api/workouts${path}`, { headers: { Cookie: cookie } }, env);
      return { status: res.status, body: (await res.json()) as any };
    },
  };
}

describe("minutes tolerance", () => {
  it("differs only past max(3 min, 20 % of the row's minutes)", () => {
    expect(minutesDiffer(8, 5)).toBe(false); // 3 min floor on a short row
    expect(minutesDiffer(9, 5)).toBe(true);
    expect(minutesDiffer(36, 30)).toBe(false); // 20 % of 30 = 6
    expect(minutesDiffer(37, 30)).toBe(true);
    expect(minutesDiffer(72, 60)).toBe(false); // 20 % of 60 = 12
    expect(minutesDiffer(73, 60)).toBe(true);
    expect(minutesDiffer(48, 60)).toBe(false);
    expect(minutesDiffer(47, 60)).toBe(true);
  });
});

describe("GET /api/settings/diagnostics/workout-docs", () => {
  it("counts missing, invalid and valid rows, exempts rest days, and returns ids only", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seed(db, userId, "a-ok", { workoutDoc: docOf() as never, workoutDocRev: 1 });
    await seed(db, userId, "b-none");
    await seed(db, userId, "c-bad", { workoutDoc: { version: 1, nonsense: true } as never });
    await seed(db, userId, "d-rest", { category: "rest", title: "Rest" });
    const { status, body } = await (await client(db, userId)).diag();
    expect(status).toBe(200);
    expect(body).toMatchObject({ checked: 3, withDoc: 1, missing: 1, invalid: 1, exempt: 1, mismatched: [], next: null });
    expect(body.sample.sort()).toEqual(["b-none", "c-bad"]);
    expect(JSON.stringify(body)).not.toContain("Easy run");
  });

  it("flags a minutes mismatch with its field, and tolerates a small difference", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const doc = docOf();
    const minutes = deriveDoc(doc, EXERCISES).estimatedMinutes;
    await seed(db, userId, "near", { workoutDoc: doc as never, sourceEstimatedDurationSeconds: (minutes + 2) * 60 });
    await seed(db, userId, "far", { workoutDoc: doc as never, sourceEstimatedDurationSeconds: (minutes + 25) * 60 });
    const { body } = await (await client(db, userId)).diag();
    expect(body.mismatched).toEqual([{ id: "far", field: "minutes" }]);
  });

  it("flags a title and a discipline mismatch", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seed(db, userId, "t", { workoutDoc: docOf({ title: "Something else" }) as never });
    await seed(db, userId, "d", { workoutDoc: docOf() as never, category: "strength" });
    const { body } = await (await client(db, userId)).diag();
    expect(body.mismatched).toEqual(expect.arrayContaining([{ id: "t", field: "title" }, { id: "d", field: "discipline" }]));
    expect(body.mismatched).toHaveLength(2);
  });

  it("compares steps after canonicalising library ids (a renamed move is not a mismatch), and flags a real difference", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const base = EXERCISES[0]!;
    const library: ExerciseRecord[] = [
      { ...base, id: "newMove", legacyIds: ["oldMove"] },
      { ...EXERCISES[1]!, id: "otherMove", legacyIds: [] },
    ];
    const doc = docOf({ items: [{ kind: "exercise", libraryId: "newMove", dose: { sets: 1, reps: 8 } }] });
    const minutes = deriveDoc(doc, library).estimatedMinutes * 60;
    const build = (workoutId: string, ids: string[]) =>
      db.insert(sessionBuilds).values({
        id: `b-${workoutId}`, userId, workoutId, version: 1, engineVersion: "t", inputsHash: "h",
        payload: { steps: ids.map((exerciseId) => ({ kind: "set", exerciseId })) }, workoutDoc: null, lockedAt: null, createdAt: NOW,
      });
    // The doc names "newMove"; the old build names it "oldMove" (renamed) or a different move.
    await seed(db, userId, "same", { workoutDoc: doc as never, sourceEstimatedDurationSeconds: minutes, category: "strength" });
    await seed(db, userId, "diff", { workoutDoc: doc as never, sourceEstimatedDurationSeconds: minutes, category: "strength" });
    await build("same", ["oldMove"]);
    await build("diff", ["otherMove"]);
    const report = await checkWorkoutDocParity(db, userId, {}, library);
    expect(report.mismatched.filter((m) => m.field === "steps")).toEqual([{ id: "diff", field: "steps" }]);
  });

  it("paginates by id", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) await seed(db, userId, id);
    const c = await client(db, userId);
    const first = (await c.diag("?limit=2")).body;
    expect(first).toMatchObject({ checked: 2, missing: 2, next: "p2" });
    const second = (await c.diag("?limit=2&after=p2")).body;
    expect(second).toMatchObject({ checked: 2, next: "p4" });
    const third = (await c.diag("?limit=2&after=p4")).body;
    expect(third).toMatchObject({ checked: 1, next: null });
  });

  it("is scoped to the signed-in user and leaves archived rows out", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);
    await seed(db, userId, "mine");
    await seed(db, userId, "gone", { archivedAt: NOW, archiveReason: "user_removed" });
    await seed(db, other.userId, "theirs");
    const { body } = await (await client(db, userId)).diag();
    expect(body).toMatchObject({ checked: 1, missing: 1 });
    expect(body.sample).toEqual(["mine"]);
  });

  it("stays within the statement budget on a full page", async () => {
    const statements: string[] = [];
    const db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
    const { userId } = await makeTestUser(db);
    const doc = docOf();
    for (let i = 0; i < 200; i++) await seed(db, userId, `w${String(i).padStart(3, "0")}`, { workoutDoc: doc as never });
    const c = await client(db, userId);
    statements.length = 0;
    const { status, body } = await c.diag("?limit=200");
    expect(status).toBe(200);
    expect(body.withDoc).toBe(200);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("GET /api/workouts/:id/doc", () => {
  it("returns the document, what is derived, and the revision; tolerates missing and invalid; 404 for another user's", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);
    const doc = docOf();
    await seed(db, userId, "ok", { workoutDoc: doc as never, workoutDocRev: 3 });
    await seed(db, userId, "none");
    await seed(db, userId, "bad", { workoutDoc: { nope: 1 } as never });
    await seed(db, other.userId, "theirs", { workoutDoc: doc as never, workoutDocRev: 1 });
    const c = await client(db, userId);
    const ok = await c.work("/ok/doc");
    expect(ok.status).toBe(200);
    expect(ok.body.rev).toBe(3);
    expect(ok.body.doc.title).toBe("Easy run");
    expect(ok.body.derived.estimatedMinutes).toBe(deriveDoc(doc, EXERCISES).estimatedMinutes);
    expect(await c.work("/none/doc")).toEqual({ status: 200, body: { doc: null, reason: "missing" } });
    expect(await c.work("/bad/doc")).toEqual({ status: 200, body: { doc: null, reason: "invalid" } });
    expect((await c.work("/theirs/doc")).status).toBe(404);
    expect((await c.work("/nowhere/doc")).status).toBe(404);
  });
});

describe("GET /api/workouts", () => {
  it("lists newest first with the summary shape, filters by inclusive dates, q, and limit; excludes archived and other users", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);
    await seed(db, userId, "w1", { effectiveDate: "2026-10-01", title: "Hill repeats", workoutDoc: docOf({ summary: "Strong legs" }) as never, workoutDocRev: 2 });
    await seed(db, userId, "w2", { effectiveDate: "2026-10-03", title: "Long Run" });
    await seed(db, userId, "w3", { effectiveDate: "2026-10-05", title: "Mobility", workoutDoc: docOf({ summary: "Loosen the HILLS of tension" }) as never });
    await seed(db, userId, "w4", { effectiveDate: "2026-10-04", title: "Hill sprints", archivedAt: NOW, archiveReason: "user_removed" });
    await seed(db, other.userId, "w5", { effectiveDate: "2026-10-02", title: "Hill someone else" });
    const c = await client(db, userId);
    const all = await c.work("");
    expect(all.body.map((r: { id: string }) => r.id)).toEqual(["w3", "w2", "w1"]);
    expect(all.body[2]).toEqual({
      id: "w1", date: "2026-10-01", title: "Hill repeats", intentSummary: "Strong legs", category: "easy",
      completionState: "scheduled", docRev: 2, minutes: 30,
    });
    expect(all.body[1]).toMatchObject({ intentSummary: null, docRev: null });
    expect((await c.work("?from=2026-10-03&to=2026-10-05")).body.map((r: { id: string }) => r.id)).toEqual(["w3", "w2"]);
    expect((await c.work("?to=2026-10-03")).body.map((r: { id: string }) => r.id)).toEqual(["w2", "w1"]);
    expect((await c.work("?q=hill")).body.map((r: { id: string }) => r.id)).toEqual(["w3", "w1"]);
    expect((await c.work("?q=100%25")).body).toEqual([]);
    expect((await c.work("?limit=1")).body).toHaveLength(1);
    expect((await c.work("?from=nope")).status).toBe(400);
  });

  it("caps the limit at 200 and answers within the statement budget", async () => {
    const statements: string[] = [];
    const db = makeTestDb({ onStatement: (s) => statements.push(s) });
    const { userId } = await makeTestUser(db);
    for (let i = 0; i < 210; i++) await seed(db, userId, `w${i}`, { effectiveDate: "2026-10-01" });
    const c = await client(db, userId);
    statements.length = 0;
    const res = await c.work("?limit=9999");
    expect(res.body).toHaveLength(200);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("fix round 1", () => {
  const ids = (r: { body: Array<{ id: string }> }) => r.body.map((x) => x.id);

  it("q is trimmed and cut at 40 characters; an all-whitespace q is no filter", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seed(db, userId, "long", { title: `${"a".repeat(40)}zzz` });
    await seed(db, userId, "other", { title: "Something else" });
    const c = await client(db, userId);
    const res = await c.work(`?q=${"a".repeat(40)}${"b".repeat(160)}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["long"]);
    expect(ids(await c.work("?q=%20%20%20")).sort()).toEqual(["long", "other"]);
  });

  it("q treats _ and \\ literally", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seed(db, userId, "under", { title: "step_up" });
    await seed(db, userId, "plain", { title: "stepXup" });
    await seed(db, userId, "slash", { title: "a\\b" });
    await seed(db, userId, "ab", { title: "ab" });
    const c = await client(db, userId);
    expect(ids(await c.work("?q=step_up"))).toEqual(["under"]);
    expect(ids(await c.work(`?q=${encodeURIComponent("a\\b")}`))).toEqual(["slash"]);
  });

  it("a malformed document column does not fail the list, and an archived row's doc is a 404", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seed(db, userId, "bad", { title: "Broken" });
    await seed(db, userId, "arch", { title: "Gone", archivedAt: NOW, workoutDoc: docOf() as never });
    (db as unknown as { $client: { prepare(s: string): { run(...a: unknown[]): void } } }).$client
      .prepare("UPDATE planned_workouts SET workout_doc = ? WHERE id = ?")
      .run("{not json", "bad");
    const c = await client(db, userId);
    const res = await c.work("?q=anything");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect((await c.work("/arch/doc")).status).toBe(404);
    expect((await c.work("/bad/doc")).body).toEqual({ doc: null, reason: "invalid" });
    expect((await c.diag()).body).toMatchObject({ checked: 1, invalid: 1, sample: ["bad"] });
  });

  it("no estimate: minutes are not compared against the calendar slot (counted unestimated); the list still shows the slot", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const doc = docOf();
    await seed(db, userId, "noest", { workoutDoc: doc as never, sourceEstimatedDurationSeconds: null, fallbackEstimatedDurationSeconds: null, calendarBlockDurationSeconds: 9000 });
    const c = await client(db, userId);
    const { body } = await c.diag();
    expect(body.unestimated).toBe(1);
    expect(body.mismatched.filter((m: { field: string }) => m.field === "minutes")).toEqual([]);
    expect((await c.work("")).body[0].minutes).toBe(150);
  });

  describe("steps use the played build and skip a stale one", () => {
    const library: ExerciseRecord[] = [
      { ...EXERCISES[0]!, id: "moveA", legacyIds: [] },
      { ...EXERCISES[1]!, id: "moveB", legacyIds: [] },
    ];
    const mk = (libraryId: string) => docOf({ items: [{ kind: "exercise", libraryId, dose: { sets: 1, reps: 8 } }] });
    const put = (db: Db, userId: string, workoutId: string, version: number, stepIds: string[], over: { lockedAt?: string | null; createdAt?: string; workoutDoc?: WorkoutDoc | null } = {}) =>
      db.insert(sessionBuilds).values({
        id: `b-${workoutId}-${version}`, userId, workoutId, version, engineVersion: "t", inputsHash: "h",
        payload: { steps: stepIds.map((exerciseId) => ({ kind: "set", exerciseId })) }, workoutDoc: (over.workoutDoc ?? null) as never,
        lockedAt: over.lockedAt ?? null, createdAt: over.createdAt ?? NOW,
      });
    const steps = (r: { mismatched: Array<{ id: string; field: string }> }) => r.mismatched.filter((m) => m.field === "steps");

    it("the locked build is the one compared, even when a later version exists", async () => {
      const db = makeTestDb();
      const { userId } = await makeTestUser(db);
      await seed(db, userId, "w", { workoutDoc: mk("moveA") as never, category: "strength" });
      await put(db, userId, "w", 1, ["moveA"], { lockedAt: NOW });
      await put(db, userId, "w", 2, ["moveB"]);
      expect(steps(await checkWorkoutDocParity(db, userId, {}, library))).toEqual([]);
    });

    it("without a locked build the latest is compared, and an older build's steps never stand in", async () => {
      const db = makeTestDb();
      const { userId } = await makeTestUser(db);
      await seed(db, userId, "w", { workoutDoc: mk("moveA") as never, category: "strength" });
      await put(db, userId, "w", 1, ["moveA"]);
      await put(db, userId, "w", 2, ["moveB"]);
      expect(steps(await checkWorkoutDocParity(db, userId, {}, library))).toEqual([{ id: "w", field: "steps" }]);
      // The newest build carries no steps array: nothing is compared, and v1 does not stand in.
      await db.insert(sessionBuilds).values({
        id: "b-w-3", userId, workoutId: "w", version: 3, engineVersion: "t", inputsHash: "h", payload: {}, workoutDoc: null, lockedAt: null, createdAt: NOW,
      });
      expect(steps(await checkWorkoutDocParity(db, userId, {}, library))).toEqual([]);
    });

    it("a build made from an earlier document, or before the row last changed, is stale: counted, not a mismatch", async () => {
      const db = makeTestDb();
      const { userId } = await makeTestUser(db);
      // The doc was edited from moveB to moveA after the build was made from it.
      await seed(db, userId, "edited", { workoutDoc: mk("moveA") as never, category: "strength" });
      await put(db, userId, "edited", 1, ["moveB"], { workoutDoc: mk("moveB") });
      // A build with no stored document that predates the row's last update.
      await seed(db, userId, "older", { workoutDoc: mk("moveA") as never, category: "strength", updatedAt: "2026-10-09T00:00:00.000Z" });
      await put(db, userId, "older", 1, ["moveB"]);
      const report = await checkWorkoutDocParity(db, userId, {}, library);
      expect(report.stale).toBe(2);
      expect(steps(report)).toEqual([]);
    });
  });
});
