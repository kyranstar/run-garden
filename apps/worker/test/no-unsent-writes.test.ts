/**
 * NO COROS WRITE FROM A SESSION THAT WAS NOT SENT (Phase 3 Task 6; spec §4.5 "No other path writes", §7; ruling
 * 2a-R4 extended).
 *
 * An account with COROS connected, writes on and the switch on holds program and on-demand slots in every state.
 * Every path that can enqueue a COROS job runs over them — the pending-work emitter, the absent-session push (live),
 * content convergence (live, every row named), the legacy heal, a move of each slot, a snapshot import, placement
 * (with its retraction) and the daily reconcile. None may queue a write for any of them. The one exception is the
 * cleanup of a copy that WAS sent: moving it takes it off the watch. Then sending one slot queues exactly one push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, type UserPreferences } from "@rg/domain";
import type { SourcePlannedWorkout } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { emitPendingWork, applyMove } from "../src/services/jobs.js";
import { pushAbsentSessions } from "../src/services/push-absent.js";
import { convergeDivergedContent } from "../src/services/content-converge.js";
import { healLegacySyncState } from "../src/services/heal-legacy-sync.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { placeSlots, retractSlot } from "../src/services/program-slots.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { openMoveIntents, recordIntent } from "../src/services/sync-intents.js";
import { buildSession, startSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";
import { DAY, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 60_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const YESTERDAY = addDays(DAY, -1);

/** Every app-authored row's id. */
const appRows = async () =>
  (await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.origin, ["program", "on_demand"]))).map((r) => r.id);
const jobsNaming = async (ids: string[]) =>
  ids.length === 0 ? [] : db.select().from(corosWriteJobs).where(inArray(corosWriteJobs.workoutId, ids));

describe("the sweep: no write from an unsent session", () => {
  it("queues nothing for any program or on-demand slot but the cleanup of a sent copy; one Send is one push", async () => {
    // ── Slots in every state ──
    const future = await seedSlot(db, userId, programId, addDays(DAY, 3));
    const builtToday = await seedSlot(db, userId, programId, DAY);
    await buildSession(db, userId, builtToday, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
    const started = await seedSlot(db, userId, programId, DAY, `${builtToday}-started`);
    const startedBuild = await buildSession(db, userId, started, {}, ctx());
    await startSession(db, userId, started, startedBuild.build!.buildId, NOON);
    const done = await seedSlot(db, userId, programId, YESTERDAY, "slot-done");
    await db.update(plannedWorkouts).set({ contentState: "done", completionState: "completed" }).where(eq(plannedWorkouts.id, done));
    const skipped = await seedSlot(db, userId, programId, YESTERDAY, "slot-skipped");
    await db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, skipped));
    const onDemand = await seedSlot(db, userId, programId, DAY, "on-demand-1");
    await db.update(plannedWorkouts).set({ origin: "on_demand" }).where(eq(plannedWorkouts.id, onDemand));
    // A slot that WAS sent, its copy on the watch: the only one whose move may write (to take the copy off).
    const sent = await seedSlot(db, userId, programId, DAY, "slot-sent");
    const sentBuild = await buildSession(db, userId, sent, {}, ctx());
    await sendToWatch(db, switchOn(), userId, sent, sentBuild.build!.buildId, ctx());
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${sentBuild.build!.buildId}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, sent));
    // A coach-shaped body on two of them: the push-absent and convergence lanes would have a session to send.
    const liftBody = {
      exercises: [{ name: "Goblet Squat", originId: "4258276155475001301", sets: 3, reps: 8, weight: { type: "bodyweight" }, restSeconds: 60 }],
    };
    for (const id of [onDemand, sent, future]) {
      await db.update(plannedWorkouts).set({ structuredJson: liftBody, sport: "strength" }).where(eq(plannedWorkouts.id, id));
    }
    const before = new Set((await jobsNaming(await appRows())).map((j) => j.id));

    // Open intents every reconciler path reads: a move owed and an approved content change, on every slot.
    for (const id of [future, builtToday, started, done, skipped, onDemand, sent]) {
      await recordIntent(db, { userId, targetKind: "workout", targetId: id, kind: "move", payload: { toDate: addDays(DAY, 5), toTime: "07:00", fromDate: "" }, source: "auto_resolve" });
      await recordIntent(db, { userId, targetKind: "workout", targetId: id, kind: "content", source: "coach_ease" });
    }

    // ── Every path that can enqueue a COROS job ──
    await emitPendingWork(db, userId, { corosWritesEnabled: true });
    await pushAbsentSessions(db, userId, { dryRun: false });
    await convergeDivergedContent(db, userId, { dryRun: false, workoutIds: await appRows() });
    await healLegacySyncState(db, userId);
    // The legacy heal owes no move for an app-built slot (rulings 2a-R4, 3-R3): the emitter above closed every one.
    const appIds = new Set(await appRows());
    expect((await openMoveIntents(db, userId)).filter((i) => appIds.has(i.targetId))).toEqual([]);
    for (const [id, to] of [[future, addDays(DAY, 4)], [builtToday, addDays(DAY, 1)], [started, addDays(DAY, 2)], [done, DAY], [skipped, DAY], [onDemand, addDays(DAY, 1)], [sent, addDays(DAY, 1)]] as const) {
      await applyMove(db, { userId, workoutId: id, toDate: to, toTime: "07:00", source: "app", corosWritesEnabled: true });
    }
    const wire: SourcePlannedWorkout = {
      sourceWorkoutId: "4738:12", sourcePlanId: "4738", date: addDays(DAY, 2), title: "Easy 40", sport: "run", stages: [],
      contentFingerprint: "fp-wire", isRestDay: false, estimatedDurationSeconds: 2400,
    } as SourcePlannedWorkout;
    await importPlanSnapshot(
      db,
      { userId, plan: { sourcePlanId: "4738", name: "Autumn base" }, workouts: [wire], rangeStart: DAY, rangeEnd: addDays(DAY, 20), source: "fixture" },
      prefs,
    );
    await placeSlots(db, userId, programId, DAY, prefs, NOON);
    const extra = await seedSlot(db, userId, programId, addDays(DAY, 6), "slot-retract");
    await retractSlot(db, userId, { id: extra }, DAY, prefs, NOON);
    await reconcileCompletionStates(db, userId, prefs, new Date(NOON));
    await emitPendingWork(db, userId, { corosWritesEnabled: true });

    // ── Nothing queued for an unsent session ──
    const after = (await jobsNaming(await appRows())).filter((j) => !before.has(j.id));
    const unsanctioned = after.filter((j) => !(j.workoutId === sent && j.kind === "coach_delete_workout"));
    expect(unsanctioned.map((j) => [j.workoutId, j.kind, j.id])).toEqual([]);
    // The sent copy's move took it off the watch, once.
    expect(after.filter((j) => j.workoutId === sent).map((j) => j.id)).toEqual([`unpush:${sentBuild.build!.buildId}`]);

    // ── Then one Send is exactly one push ──
    const fresh = await seedSlot(db, userId, programId, DAY, "slot-fresh");
    const freshBuild = await buildSession(db, userId, fresh, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
    await sendToWatch(db, switchOn(), userId, fresh, freshBuild.build!.buildId, ctx());
    const pushes = (await jobsNaming(await appRows())).filter((j) => j.kind === "program_session_push" && !before.has(j.id));
    expect(pushes.map((j) => [j.workoutId, j.status])).toEqual([[fresh, "queued"]]);
  });
});
