/**
 * THE BODY CHECK EASES A WATCH-PLAN RUN (the new shape, 2026-10-17; design §4): a run the athlete's COROS plan holds is
 * eased by the thread coach's own `ease` op through its own applier (`applyOps`) — its distance, or its time, × 0.7,
 * held easy — and is undoable: Undo puts the run back exactly as the plan had it (every column the ease wrote, its
 * stages with their repeats and targets, its document as a new revision), and settles the watch: a rewrite not yet run
 * is superseded (the watch never changed), one that reached the watch is followed by a rewrite back. A designed workout
 * is never changed by itself; race day is never eased. No AI.
 *
 * Synthetic data only; a fixed Friday (`today`, `now` passed in) and, for the route's cost, the real today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { answerBodyCheck, BODY_REGIONS, BodyCheckBusyError, readBodyCheck, undoBodyCheck } from "../src/services/body-check.js";
import { RUN_REGIONS } from "../src/services/body-exposure.js";
import { todayBodyRoutes } from "../src/routes/today-body.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { DAY, makeEnv, NOON, rowOf } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkoutStages, plannedWorkouts, syncIntents, workoutDocRevisions } = schema;

vi.setConfig({ testTimeout: 30_000 });

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];

beforeEach(async () => {
  // The applier reads the clock itself (a day gone is not changed): the athlete's noon on the test's Friday.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = (over: Partial<{ today: string; now: string }> = {}) => ({ today: DAY, now: NOON, prefs, ...over });

type Stage = typeof plannedWorkoutStages.$inferInsert;
const stage = (workoutId: string, n: number, over: Partial<Stage>): Stage => ({
  id: `${workoutId}:s${n}`,
  workoutId,
  parentStageId: null,
  ord: n,
  kind: "work",
  repeatCount: null,
  durationType: "time",
  durationSeconds: null,
  distanceMeters: null,
  targetType: "none",
  targetLow: null,
  targetHigh: null,
  paceZone: null,
  hrZone: null,
  label: null,
  ...over,
});

/**
 * A run the COROS plan holds, as the import writes it: a long run by distance (20 km), or intervals by time with a
 * repeat; with a watch address and the import's own fingerprint when `watch`.
 */
async function seedRun(date: string, o: { shape?: "long" | "intervals" | "race"; watch?: boolean } = {}): Promise<string> {
  const id = newId();
  const shape = o.shape ?? "long";
  const seconds = shape === "intervals" ? 3000 : 6600;
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "coros-plan",
    sourceWorkoutId: o.watch ? "4242:7" : `coros-${id}`,
    sourceProgramId: o.watch ? "990011" : null,
    sourceIdInPlan: o.watch ? "7" : null,
    title: shape === "intervals" ? "6 × 3 min" : shape === "race" ? "City half" : "Long run",
    category: shape === "intervals" ? "quality" : shape === "race" ? "race" : "long",
    qualitySubtype: shape === "intervals" ? "intervals" : null,
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: o.watch ? date : "",
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "0123456789abcdef",
    sourceVersion: "v3",
    sourceEstimatedDurationSeconds: seconds,
    fallbackEstimatedDurationSeconds: null,
    calendarBlockDurationSeconds: seconds,
    durationEstimate: { source: "coros_native", workoutSeconds: seconds, confidence: "high" },
    expectedDistanceMeters: shape === "intervals" ? 9000 : 20000,
    stageSummary: shape === "intervals" ? "10 min · 6 × (3 min · 90 s) · 10 min" : "20 km",
    structuredJson: null,
    // On the watch: the import's own copy, at its address. Otherwise a run only the app holds (the coach planned it).
    corosSyncState: o.watch ? "synced" : "calendar_only",
    completionState: "scheduled",
    origin: null,
    workoutDoc: JSON.stringify({ seed: "the plan's document" }),
    workoutDocRev: 1,
    createdAt: NOON,
    updatedAt: NOON,
  });
  const stages: Stage[] =
    shape === "intervals"
      ? [
          stage(id, 0, { kind: "warmup", durationSeconds: 600, label: "easy" }),
          stage(id, 1, { kind: "repeat", repeatCount: 6, durationType: "none" }),
          stage(id, 2, { parentStageId: `${id}:s1`, durationSeconds: 180, targetType: "pace", targetLow: 240, targetHigh: 250, label: "interval" }),
          stage(id, 3, { parentStageId: `${id}:s1`, kind: "recovery", durationSeconds: 90, label: "rest" }),
          stage(id, 4, { kind: "cooldown", durationSeconds: 600, label: "easy" }),
        ]
      : [stage(id, 0, { durationType: "distance", distanceMeters: shape === "race" ? 21097 : 20000, targetType: "pace", targetLow: 330, targetHigh: 360, hrZone: 2, label: "easy" })];
  await db.insert(plannedWorkoutStages).values(stages);
  return id;
}

async function stagesOf(id: string) {
  return db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id)).orderBy(asc(plannedWorkoutStages.ord));
}
const openContentIntents = (id: string) =>
  db.select().from(syncIntents).where(and(eq(syncIntents.targetId, id), eq(syncIntents.kind, "content"), isNull(syncIntents.resolvedAt), isNull(syncIntents.supersededBy)));
const rewrites = (id: string) => db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, id), eq(corosWriteJobs.kind, "coach_update_workout")));

/** What the ease and the restore may change on the row: everything a session decides, and its document. */
const SESSION_FACTS = [
  "title", "category", "qualitySubtype", "sport", "sourceEstimatedDurationSeconds", "fallbackEstimatedDurationSeconds", "calendarBlockDurationSeconds",
  "durationEstimate", "expectedDistanceMeters", "stageSummary", "structuredJson", "corosSyncState", "workoutDoc",
] as const;
const facts = (row: typeof plannedWorkouts.$inferSelect) => Object.fromEntries(SESSION_FACTS.map((k) => [k, row[k]]));

describe("a watch-plan run, A bit heavy", () => {
  it("a long run by distance: 20 km → 14 km, held easy, its kind and name kept — through the ease op's applier", async () => {
    const id = await seedRun(DAY);
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { meters: 14000 } });
    const row = await rowOf(db, id);
    expect(row).toMatchObject({ title: "Long run", category: "long", sport: "run", expectedDistanceMeters: 14000, calendarBlockDurationSeconds: 77 * 60, qualitySubtype: null });
    expect((await stagesOf(id)).map((s) => [s.durationType, s.distanceMeters, s.label])).toEqual([["distance", 14000, "easy"]]);
    // The ease op's own marks: the document's next revision, the app's claim on the content.
    expect(row.workoutDocRev).toBe(2);
    expect(await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id))).toHaveLength(1);
    expect(await openContentIntents(id)).toEqual([expect.objectContaining({ source: "coach_ease" })]);
    expect((await readBodyCheck(db, userId, id, ctx())).change).toEqual({ kind: "eased", to: { meters: 14000 } });
  });

  it("intervals by time: 50 min → 35 min, one easy run — no longer intervals", async () => {
    const id = await seedRun(DAY, { shape: "intervals" });
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { minutes: 35 } });
    expect(await rowOf(db, id)).toMatchObject({ title: "Easy run", category: "easy", calendarBlockDurationSeconds: 35 * 60, qualitySubtype: null });
    expect((await stagesOf(id)).map((s) => [s.durationType, s.durationSeconds, s.label])).toEqual([["time", 35 * 60, "easy"]]);
  });

  it("the same answer again eases nothing more", async () => {
    const id = await seedRun(DAY);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    statements = [];
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await rowOf(db, id)).expectedDistanceMeters).toBe(14000);
  });

  it("race day is never eased", async () => {
    const id = await seedRun(DAY, { shape: "race" });
    const before = facts(await rowOf(db, id));
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "kept", why: "race" });
    expect(facts(await rowOf(db, id))).toEqual(before);
  });
});

describe("a watch-plan run, Sore somewhere", () => {
  it("eases it for sore legs; sore shoulders are noted and the run left as planned", async () => {
    const id = await seedRun(DAY);
    const before = facts(await rowOf(db, id));
    const quiet = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["shoulders"] }, ctx());
    expect(quiet.view.change).toEqual({ kind: "kept", why: "quiet" });
    expect(facts(await rowOf(db, id))).toEqual(before);
    const sore = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["shoulders", "calves"] }, ctx());
    expect(sore.view.change).toEqual({ kind: "eased", to: { meters: 14000 } });
    // Back to sore shoulders only: the ease is put back.
    await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["shoulders"] }, ctx());
    expect(facts(await rowOf(db, id))).toEqual(before);
  });

  it("a run works what the growth body map says a run works (`RUN_REGIONS`, one list): a sore area there eases it, any other is noted", async () => {
    for (const area of BODY_REGIONS) {
      const id = await seedRun(DAY);
      const out = await answerBodyCheck(db, userId, id, { feel: "sore", areas: [area] }, ctx());
      expect([area, out.view.change?.kind]).toEqual([area, (RUN_REGIONS as readonly string[]).includes(area) ? "eased" : "kept"]);
    }
  });

  it("A bit heavy, then sore calves: the same ease stands — 14 km, never eased twice", async () => {
    const id = await seedRun(DAY);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const sore = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["calves"] }, ctx());
    expect(sore.view.change).toEqual({ kind: "eased", to: { meters: 14000 } });
    expect((await rowOf(db, id)).expectedDistanceMeters).toBe(14000);
  });
});

describe("putting the run back", () => {
  it("Undo restores it exactly — every column, its stages with their repeat and targets, its document as a new revision — and the app's claim on it ends", async () => {
    const id = await seedRun(DAY, { shape: "intervals" });
    const before = facts(await rowOf(db, id));
    const stagesBefore = await stagesOf(id);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const out = await undoBodyCheck(db, userId, id, ctx());
    expect(out.view).toMatchObject({ answer: { feel: "heavy" }, change: { kind: "kept", why: "undone" } });
    const row = await rowOf(db, id);
    expect(facts(row)).toEqual(before);
    expect(await stagesOf(id)).toEqual(stagesBefore);
    // Its fingerprint as it was: no "keep the watch's version" mark it never had (review-S3 U1's put-back is only for one).
    expect(row.sourceContentFingerprint).toBe("0123456789abcdef");
    expect(row.workoutDocRev).toBe(3);
    // The plan's document is the next revision, the athlete's own (they took the ease back).
    const revisions = await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id)).orderBy(asc(workoutDocRevisions.rev));
    expect(revisions.map((r) => [r.rev, r.sourceKind])).toEqual([
      [2, "coach"],
      [3, "athlete_edit"],
    ]);
    expect(revisions[1]!.doc).toBe(before.workoutDoc);
    expect(await openContentIntents(id)).toEqual([]);
    // Undo again: nothing to undo.
    statements = [];
    await undoBodyCheck(db, userId, id, ctx());
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("Fresh after A bit heavy puts it back too", async () => {
    const id = await seedRun(DAY);
    const before = facts(await rowOf(db, id));
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const out = await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    expect(out.view.change).toBeNull();
    expect(facts(await rowOf(db, id))).toEqual(before);
  });

  it("a run changed since the ease (the plan, the coach) is left as it is now", async () => {
    const id = await seedRun(DAY);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await db.update(plannedWorkouts).set({ title: "Hill run", stageSummary: "8 × hills" }).where(eq(plannedWorkouts.id, id));
    const now = facts(await rowOf(db, id));
    const out = await undoBodyCheck(db, userId, id, ctx());
    expect(out.view.change).toEqual({ kind: "kept", why: "undone" });
    expect(facts(await rowOf(db, id))).toEqual(now);
  });
});

describe("the watch", () => {
  it("the ease queues the rewrite for the client to drain; Undo before it ran supersedes it — the watch never changed", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.coachDrain).toBe(true);
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "queued" })]);
    const undo = await undoBodyCheck(db, userId, id, ctx());
    expect(undo.coachDrain).toBe(false);
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "superseded" })]);
    expect(await openContentIntents(id)).toEqual([]);
    expect((await rowOf(db, id)).corosSyncState).toBe("synced");
  });

  it("Undo after the rewrite reached the watch queues the rewrite back to the run as planned", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    // The drain ran: the watch holds the eased run (the write consumer's own stamps).
    const [job] = await rewrites(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    await db.update(syncIntents).set({ resolvedAt: NOON }).where(and(eq(syncIntents.targetId, id), eq(syncIntents.kind, "content")));
    await db.update(plannedWorkouts).set({ corosSyncState: "synced", sourceContentFingerprint: "fedcba9876543210" }).where(eq(plannedWorkouts.id, id));

    const undo = await undoBodyCheck(db, userId, id, ctx());
    expect(undo.coachDrain).toBe(true);
    const back = (await rewrites(id)).find((j) => j.status === "queued");
    expect(back).toBeDefined();
    expect(back!.expectedContentFingerprint).toBe("fedcba9876543210");
    // The plan's run, as the wire can carry it: its warm-up, each rep and its recovery, its cool-down.
    const blocks = (back!.payload as { session: { run: { blocks: Array<{ kind: string; value: number }> } } }).session.run.blocks;
    expect(blocks.map((b) => b.value)).toEqual([10, 3, 1.5, 3, 1.5, 3, 1.5, 3, 1.5, 3, 1.5, 3, 1.5, 10]);
    expect(await openContentIntents(id)).toEqual([expect.objectContaining({ source: "undo" })]);
    // The app's copy is the plan's again, exactly — and, as after any ease, not yet the watch's.
    expect(await rowOf(db, id)).toMatchObject({ stageSummary: "10 min · 6 × (3 min · 90 s) · 10 min", corosSyncState: "calendar_only" });
  });

  it("Undo after the rewrite reached the watch, with the watch's version since chosen: the rewrite back is on what the watch holds, and the mark lifted", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const [job] = await rewrites(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    await db.update(syncIntents).set({ resolvedAt: NOON }).where(and(eq(syncIntents.targetId, id), eq(syncIntents.kind, "content")));
    // "Keep the watch's version" since (watch-copy-marker.ts): the mark keeps what the watch holds.
    await db.update(plannedWorkouts).set({ corosSyncState: "synced", sourceContentFingerprint: "take-watch-copy:fedcba9876543210" }).where(eq(plannedWorkouts.id, id));

    await undoBodyCheck(db, userId, id, ctx());
    const back = (await rewrites(id)).find((j) => j.status === "queued");
    expect(back!.expectedContentFingerprint).toBe("fedcba9876543210");
    expect((await rowOf(db, id)).sourceContentFingerprint, "the app's claim is live again").toBe("fedcba9876543210");
  });

  it("eased again after an Undo and a keep of the watch's version, the rewrite the Undo superseded is queued again", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await undoBodyCheck(db, userId, id, ctx());
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "superseded" })]);
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: "take-watch-copy:0123456789abcdef" }).where(eq(plannedWorkouts.id, id));
    await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("a claim the app held before the ease (a coach ease not yet on the watch) stays when the ease is undone", async () => {
    const id = await seedRun(DAY, { shape: "intervals" });
    await db.insert(syncIntents).values({ id: newId(), userId, targetKind: "workout", targetId: id, kind: "content", payload: null, source: "coach_ease", createdAt: NOON });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await undoBodyCheck(db, userId, id, ctx());
    expect(await openContentIntents(id)).toHaveLength(1);
  });

  it("eased again after an Undo, the same rewrite the Undo superseded is queued again (it is that content's one job)", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    await undoBodyCheck(db, userId, id, ctx());
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "superseded" })]);
    await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    const again = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(again.coachDrain).toBe(true);
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(await openContentIntents(id)).toHaveLength(1);
  });

  it("while the watch is taking the eased run (its rewrite claimed, in progress, verifying) Undo — and an answer that would put it back — is refused in words; once it has landed, Undo rewrites back", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const [job] = await rewrites(id);
    const eased = facts(await rowOf(db, id));
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const post = (path: string, body: unknown) =>
      mountRoutes(db, "/api/today", todayBodyRoutes).request(
        path,
        { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
        makeEnv(),
      );
    for (const status of ["claimed", "in_progress", "verifying"]) {
      await db.update(corosWriteJobs).set({ status }).where(eq(corosWriteJobs.id, job!.id));
      await expect(undoBodyCheck(db, userId, id, ctx())).rejects.toBeInstanceOf(BodyCheckBusyError);
      await expect(answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckBusyError);
      const refused = await post("/api/today/body/undo", { workoutId: id });
      expect([refused.status, await refused.json()]).toEqual([409, { error: "watch_updating" }]);
      // Nothing moved: the run is still the eased one, the rewrite still the executor's, the answer still A bit heavy.
      expect(facts(await rowOf(db, id))).toEqual(eased);
      expect((await rewrites(id)).map((j) => j.status)).toEqual([status]);
      expect(await readBodyCheck(db, userId, id, ctx())).toMatchObject({ answer: { feel: "heavy" }, change: { kind: "eased" } });
    }
    // The rewrite landed: Undo now puts the run back and rewrites the watch back.
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    const undo = await undoBodyCheck(db, userId, id, ctx());
    expect(undo.view.change).toEqual({ kind: "kept", why: "undone" });
    expect(undo.coachDrain).toBe(true);
  });

  it("an answer refused because the drain took the rewrite mid-request saves nothing: the answer stays, and asked again once it has landed, it puts the run back", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const [job] = await rewrites(id);
    const eased = facts(await rowOf(db, id));
    // The drain claims the rewrite while the request is under way — as the run is read to be put back.
    const sqlite = (db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (s: string) => {
      if (/"sync_intents"/.test(s) && /^select/i.test(s) && /from "planned_workouts"/.test(s)) {
        sqlite.prepare = prepare;
        (prepare(`update "coros_write_jobs" set "status" = 'claimed' where "id" = ?`) as { run: (...a: unknown[]) => unknown }).run(job!.id);
      }
      return prepare(s);
    };
    await expect(answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckBusyError);
    sqlite.prepare = prepare;
    // Nothing saved: the answer is still A bit heavy beside the eased run — the card never says Fresh beside "Eased to …".
    expect(await readBodyCheck(db, userId, id, ctx())).toMatchObject({ answer: { feel: "heavy" }, change: { kind: "eased" } });
    expect(facts(await rowOf(db, id))).toEqual(eased);
    // The rewrite landed: Fresh, asked again, puts the run back.
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    const fresh = await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    expect(fresh.view).toMatchObject({ answer: { feel: "fresh" }, change: null });
    expect(facts(await rowOf(db, id))).not.toEqual(eased);
  });

  it("a watch write of the run the executor took before the ease (still claimed) holds Undo too", async () => {
    const id = await seedRun(DAY, { shape: "intervals" });
    await db.insert(corosWriteJobs).values({
      id: `older-${id}`, userId, workoutId: id, kind: "coach_update_workout", status: "claimed", payload: {}, expectedContentFingerprint: "0123456789abcdef",
      originalDate: DAY, destinationDate: DAY, requestedAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z",
    });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const eased = facts(await rowOf(db, id));
    await expect(undoBodyCheck(db, userId, id, ctx())).rejects.toBeInstanceOf(BodyCheckBusyError);
    expect(facts(await rowOf(db, id))).toEqual(eased);
  });

  it("Undo drops the ease's rewrite that failed — a Retry would otherwise put the eased run on the watch", async () => {
    const id = await seedRun(DAY, { shape: "intervals", watch: true });
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const [job] = await rewrites(id);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, job!.id));
    await undoBodyCheck(db, userId, id, ctx());
    expect((await rewrites(id)).map((j) => j.status)).toEqual(["superseded"]);
  });

  it("a distance run on the watch eases by time (the wire carries no distance), the rewrite queued; Undo restores its distance stages", async () => {
    const id = await seedRun(DAY, { watch: true });
    const stagesBefore = await stagesOf(id);
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { minutes: 77 } });
    expect(out.coachDrain).toBe(true);
    expect((await stagesOf(id)).map((s) => [s.durationType, s.durationSeconds, s.label])).toEqual([["time", 77 * 60, "easy"]]);
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "queued" })]);
    await undoBodyCheck(db, userId, id, ctx());
    expect(await stagesOf(id)).toEqual(stagesBefore);
    expect(await rewrites(id)).toEqual([expect.objectContaining({ status: "superseded" })]);
  });

  it("a distance run at its watch address eases by time whatever its sync state says (a change not yet on the watch)", async () => {
    const id = await seedRun(DAY, { watch: true });
    await db.update(plannedWorkouts).set({ corosSyncState: "calendar_only" }).where(eq(plannedWorkouts.id, id));
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { minutes: 77 } });
  });

  it("a distance run COROS holds with no address the app can write to still eases by time: the watch's copy is a time, never a distance", async () => {
    const id = await seedRun(DAY);
    await db.update(plannedWorkouts).set({ corosSyncState: "synced" }).where(eq(plannedWorkouts.id, id));
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "eased", to: { minutes: 77 } });
    expect(await rewrites(id)).toEqual([]);
  });

  it("…and once its rewrite reached the watch, Undo rewrites back the plan's run in the time the plan gives it", async () => {
    const id = await seedRun(DAY, { watch: true });
    const stagesBefore = await stagesOf(id);
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const [job] = await rewrites(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    await db.update(syncIntents).set({ resolvedAt: NOON }).where(and(eq(syncIntents.targetId, id), eq(syncIntents.kind, "content")));
    await db.update(plannedWorkouts).set({ corosSyncState: "synced", sourceContentFingerprint: "fedcba9876543210" }).where(eq(plannedWorkouts.id, id));
    const undo = await undoBodyCheck(db, userId, id, ctx());
    expect(undo.coachDrain).toBe(true);
    expect(await stagesOf(id)).toEqual(stagesBefore);
    const back = (await rewrites(id)).find((j) => j.status === "queued");
    const blocks = (back!.payload as { session: { run: { blocks: Array<{ kind: string; value: number; intensity?: string }> } } }).session.run.blocks;
    // The plan's 20 km in the plan's own 110 minutes, held as it was.
    expect(blocks).toEqual([{ kind: "duration", value: 110, intensity: "easy" }]);
  });

  it("with COROS writes off, nothing is queued", async () => {
    ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: false }));
    const id = await seedRun(DAY, { watch: true });
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.coachDrain).toBe(false);
    expect(await rewrites(id)).toEqual([]);
  });
});

describe("what the check never changes by itself", () => {
  it("a designed workout (the Studio's): the coach is offered, nothing is touched", async () => {
    const id = await seedRun(DAY);
    await db.update(plannedWorkouts).set({ origin: "studio", sport: "strength", category: "strength" }).where(eq(plannedWorkouts.id, id));
    const before = await rowOf(db, id);
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(out.view.change).toEqual({ kind: "ask" });
    expect(await rowOf(db, id)).toEqual(before);
  });
});

describe("what it costs", () => {
  it("the answer that eases a run on the watch, and the Undo that rewrites it back, each fit one request", async () => {
    const today = todayInZone(prefs.timezone);
    const id = await seedRun(today, { shape: "intervals", watch: true });
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const call = async (path: string, body: unknown) => {
      statements = [];
      const res = await mountRoutes(db, "/api/today", todayBodyRoutes).request(
        path,
        { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
        makeEnv(),
      );
      expect(res.status).toBe(200);
      return statements.length;
    };
    const eased = await call("/api/today/body", { workoutId: id, feel: "heavy" });
    const [job] = await rewrites(id);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    const undo = await call("/api/today/body/undo", { workoutId: id });
    console.log("body check (run) statements", { eased, undo });
    expect(eased).toBeLessThanOrEqual(45);
    expect(undo).toBeLessThanOrEqual(45);
  });
});
