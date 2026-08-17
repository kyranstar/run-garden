import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { SourcePlannedWorkout, TrainingPlanInfo } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { placeDaySessions, windowTimeFor } from "../src/services/day-placement.js";
import { repairOrphanedMirrors, countOrphanedMirrors } from "../src/services/mirror-repair.js";
import { recordIntent } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser, connectTestCoros, D1_BIND_LIMIT } from "./helpers.js";

/**
 * The four import-path defects of 2026-08-17, each pinned by the sequence that
 * produced it on the athlete's real rows:
 *
 *  1. Fifteen lift sessions archived locally while COROS still served them —
 *     the healing gate read `archive_reason` (evidence) as a standing
 *     instruction, so rule 8's mirror release could never win.
 *  2. A user-wide `sourceWorkoutId` map with duplicate keys, resolved by D1's
 *     row order.
 *  3. The sync heal flipping `calendar_only → synced` on date agreement alone,
 *     laundering an approved ease the watch has never seen.
 *  4. Two and three sessions at one `effective_time`.
 */

const { plannedWorkouts, calendarEventSuppressions } = schema;

const RUN_PLAN = "700000000000000001";
const LIFT_PLAN = "700000000000000002";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let rangeStart: string;
let rangeEnd: string;

const plan: TrainingPlanInfo = { sourcePlanId: RUN_PLAN, name: "Autumn base" };

function wire(over: Partial<SourcePlannedWorkout> & { sourceWorkoutId: string; date: string }): SourcePlannedWorkout {
  return {
    sourcePlanId: RUN_PLAN,
    title: "Easy 40",
    sport: "run",
    stages: [],
    contentFingerprint: `fp-${over.sourceWorkoutId}`,
    isRestDay: false,
    estimatedDurationSeconds: 40 * 60,
    ...over,
  };
}

async function importWire(workouts: SourcePlannedWorkout[]) {
  return importPlanSnapshot(db, { userId, plan, workouts, rangeStart, rangeEnd, source: "fixture" }, prefs);
}

/** A row as the importer would have created it, seeded directly so a test can
 * start from a state the importer took several reads to reach. */
async function seedRow(over: {
  id: string;
  sourceWorkoutId: string;
  date: string;
  title?: string;
  sport?: string;
  planId?: string;
  category?: string;
  effectiveTime?: string;
  archivedAt?: string | null;
  archiveReason?: string | null;
  completionState?: string;
  corosSyncState?: string;
  createdAt?: string;
  durationSeconds?: number;
}): Promise<void> {
  const now = nowInstant();
  await db.insert(plannedWorkouts).values({
    id: over.id,
    userId,
    planId: over.planId ?? "local-run-plan",
    sourceWorkoutId: over.sourceWorkoutId,
    title: over.title ?? "Upper A",
    category: over.category ?? "strength",
    sport: over.sport ?? "strength",
    originalPlanDate: over.date,
    lastVerifiedCorosDate: over.date,
    effectiveDate: over.date,
    effectiveTime: over.effectiveTime ?? "07:00",
    sourceContentFingerprint: `fp-${over.sourceWorkoutId}`,
    sourceEstimatedDurationSeconds: over.durationSeconds ?? 45 * 60,
    calendarBlockDurationSeconds: over.durationSeconds ?? 45 * 60,
    calendarSyncState: "synced",
    corosSyncState: over.corosSyncState ?? "synced",
    completionState: over.completionState ?? "scheduled",
    archivedAt: over.archivedAt ?? null,
    archiveReason: over.archiveReason ?? null,
    createdAt: over.createdAt ?? now,
    updatedAt: now,
  });
}

const rowById = async (id: string) =>
  (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  await connectTestCoros(db, userId);
  today = todayInZone(prefs.timezone);
  rangeStart = addDays(today, -30);
  rangeEnd = addDays(today, 60);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. A released mirror can actually heal
// ─────────────────────────────────────────────────────────────────────────────

describe("#1 archive_reason is evidence, not a standing instruction", () => {
  /**
   * THE DECISIVE SEQUENCE, exactly as it ran on the athlete's rows: two twins →
   * dedupe → absence sweep (which releases the mirror) → the next import heals
   * the survivor. Before the fix the belt re-derived the block from the mirror's
   * own `archive_reason` and the survivor stayed archived forever.
   */
  it("two twins → dedupe → absence sweep → release → the next import heals the survivor", async () => {
    const day = addDays(today, 1);
    // COROS serves the applied lift plan twice: the definition and its
    // materialization under a second plan id, same title, same day.
    const definition = wire({
      sourceWorkoutId: `${LIFT_PLAN}:11`,
      sourcePlanId: LIFT_PLAN,
      date: day,
      title: "Upper A",
      sport: "strength",
    });
    const materialized = wire({
      sourceWorkoutId: `${LIFT_PLAN}:12`,
      sourcePlanId: LIFT_PLAN,
      date: day,
      title: "Upper A",
      sport: "strength",
    });
    const other = wire({ sourceWorkoutId: `${RUN_PLAN}:1`, date: addDays(today, 2) });

    // Read 1: both twins land, the dedupe archives the newer one.
    const first = await importWire([definition, materialized, other]);
    expect(first.dedupedMirrors).toBe(1);
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Upper A"));
    const keeper = rows.find((r) => !r.archivedAt)!;
    const mirror = rows.find((r) => r.archivedAt)!;
    expect(mirror.archiveReason).toBe("duplicate_mirror");
    expect(
      await db
        .select()
        .from(calendarEventSuppressions)
        .where(eq(calendarEventSuppressions.workoutId, mirror.id)),
    ).toHaveLength(1);

    // Reads 2 and 3: COROS stops serving the KEEPER's address only. Two
    // consecutive absences archive it, and the sweep releases the mirror.
    // Which twin the dedupe kept is decided by row id (they were created in the
    // same instant), so the snapshot is built from the keeper it actually chose.
    const keeperGone = [definition, materialized].filter(
      (w) => w.sourceWorkoutId !== keeper.sourceWorkoutId,
    );
    keeperGone.push(other);
    expect(keeperGone).toHaveLength(2);
    await importWire(keeperGone);
    await importWire(keeperGone);
    expect((await rowById(keeper.id)).archivedAt).not.toBeNull();
    expect((await rowById(keeper.id)).archiveReason).toBe("absence_confirmed");
    expect(
      await db
        .select()
        .from(calendarEventSuppressions)
        .where(eq(calendarEventSuppressions.workoutId, mirror.id)),
    ).toHaveLength(0);

    // Read 4: the mirror is the only copy left and COROS still serves it, so it
    // comes back — and comes back CLEAN, with no reason left to re-arm anything.
    const healed = await importWire(keeperGone);
    expect(healed.unarchived).toBe(1);
    const after = await rowById(mirror.id);
    expect(after.archivedAt).toBeNull();
    expect(after.archiveReason).toBeNull();
    expect(after.calendarSyncState).toBe("pending");

    // And it STAYS healed: the day now has one live copy, so the dedupe has
    // nothing to do and the row does not flip archived/live every hour.
    const again = await importWire(keeperGone);
    expect(again.unarchived).toBe(0);
    expect(again.dedupedMirrors).toBe(0);
    expect((await rowById(mirror.id)).archivedAt).toBeNull();
  });

  it("a mirror whose keeper is still LIVE stays archived — the dedupe is not undone", async () => {
    const day = addDays(today, 1);
    const a = wire({
      sourceWorkoutId: `${LIFT_PLAN}:11`,
      sourcePlanId: LIFT_PLAN,
      date: day,
      title: "Upper A",
      sport: "strength",
    });
    const b = wire({
      sourceWorkoutId: `${LIFT_PLAN}:12`,
      sourcePlanId: LIFT_PLAN,
      date: day,
      title: "Upper A",
      sport: "strength",
    });
    await importWire([a, b]);
    // Both still on the wire, over and over: the mirror must not resurrect.
    await importWire([a, b]);
    const stats = await importWire([a, b]);
    expect(stats.unarchived).toBe(0);
    const live = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Upper A"))).filter(
      (r) => !r.archivedAt,
    );
    expect(live).toHaveLength(1);
  });

  it("a user_removed row stays removed however long its keeper has been gone", async () => {
    // The other reason, unchanged: a person decided, and no condition an import
    // can observe withdraws that.
    const day = addDays(today, 1);
    await seedRow({
      id: "removed-1",
      sourceWorkoutId: `${LIFT_PLAN}:21`,
      date: day,
      archivedAt: nowInstant(),
      archiveReason: "user_removed",
    });
    const stats = await importWire([
      wire({ sourceWorkoutId: `${LIFT_PLAN}:21`, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);
    expect(stats.unarchived).toBe(0);
    expect((await rowById("removed-1")).archivedAt).not.toBeNull();
  });

  it("an orphaned mirror still wearing a stranded suppression heals AND loses it", async () => {
    // The release only fires from rule 8's sweep. A keeper removed by hand, or
    // archived while outside the snapshot window, releases nothing — and an
    // un-archived row behind a live suppression is a plan entry with no
    // calendar event (audit#2 #4).
    const day = addDays(today, 1);
    await seedRow({
      id: "mirror-stranded",
      sourceWorkoutId: `${LIFT_PLAN}:31`,
      date: day,
      archivedAt: nowInstant(),
      archiveReason: "duplicate_mirror",
    });
    await db.insert(calendarEventSuppressions).values({
      id: "sup-stranded",
      workoutId: "mirror-stranded",
      eventId: null,
      reason: "duplicate_mirror",
      createdAt: nowInstant(),
    });

    const stats = await importWire([
      wire({ sourceWorkoutId: `${LIFT_PLAN}:31`, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);

    expect(stats.unarchived).toBe(1);
    expect((await rowById("mirror-stranded")).archiveReason).toBeNull();
    expect(
      await db
        .select()
        .from(calendarEventSuppressions)
        .where(eq(calendarEventSuppressions.workoutId, "mirror-stranded")),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. The repair for rows already lost
// ─────────────────────────────────────────────────────────────────────────────

describe("#1 repair — orphaned mirrors already archived", () => {
  const day = () => addDays(today, 1);

  async function seedOrphan(id: string, over: Partial<Parameters<typeof seedRow>[0]> = {}) {
    await seedRow({
      id,
      sourceWorkoutId: `${LIFT_PLAN}:${id}`,
      date: day(),
      title: `Upper ${id}`,
      archivedAt: nowInstant(),
      archiveReason: "duplicate_mirror",
      ...over,
    });
  }

  it("dry run reports exactly what it would change and writes nothing", async () => {
    await seedOrphan("a");
    const before = await rowById("a");

    const report = await repairOrphanedMirrors(db, userId, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.totals.unarchived).toBe(1);
    expect(report.backup).toBeNull();
    expect(report.assumes).toContain("does NOT verify that COROS still");
    const only = report.mirrors[0]!;
    expect(only.action).toBe("repair");
    expect(only.changes).toEqual([
      { column: "archivedAt", from: before.archivedAt, to: null },
      { column: "archiveReason", from: "duplicate_mirror", to: null },
      { column: "calendarSyncState", from: "synced", to: "pending" },
    ]);
    // Nothing written.
    expect((await rowById("a")).archivedAt).toBe(before.archivedAt);
  });

  it("a live run un-archives, clears the reason, backs up first, and is idempotent", async () => {
    await seedOrphan("a");
    await seedOrphan("b");
    await db.insert(calendarEventSuppressions).values({
      id: "sup-b",
      workoutId: "b",
      eventId: null,
      reason: "duplicate_mirror",
      createdAt: nowInstant(),
    });

    const report = await repairOrphanedMirrors(db, userId, { dryRun: false });
    expect(report.totals.unarchived).toBe(2);
    expect(report.totals.suppressionsCleared).toBe(1);
    expect(report.backup?.kind).toBe("orphaned_mirror_unarchived");

    for (const id of ["a", "b"]) {
      const row = await rowById(id);
      expect(row.archivedAt).toBeNull();
      expect(row.archiveReason).toBeNull();
      expect(row.calendarSyncState).toBe("pending");
    }
    // `missing_reads` is deliberately untouched, so a row COROS really dropped
    // re-archives at the earliest honest opportunity.
    expect((await rowById("a")).missingReads).toBe(0);

    // The backup carries whole pre-change rows, not a diff.
    const [backup] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, report.backup!.auditEventId));
    const detail = backup!.detail as { previousWorkouts: Array<{ id: string; archiveReason: string }> };
    expect(detail.previousWorkouts.map((w) => w.id).sort()).toEqual(["a", "b"]);
    expect(detail.previousWorkouts[0]!.archiveReason).toBe("duplicate_mirror");

    // Second run: nothing left to do, and no second backup.
    const second = await repairOrphanedMirrors(db, userId, { dryRun: false });
    expect(second.totals.unarchived).toBe(0);
    expect(second.backup).toBeNull();
  });

  it("refuses a mirror whose twin is alive, a resolved mirror, and any other reason", async () => {
    await seedOrphan("shadowed", { title: "Upper shadowed" });
    await seedRow({
      id: "keeper",
      sourceWorkoutId: `${LIFT_PLAN}:keeper`,
      date: day(),
      title: "Upper shadowed",
    });
    await seedOrphan("done", { completionState: "completed", title: "Upper done" });
    await seedRow({
      id: "absent",
      sourceWorkoutId: `${LIFT_PLAN}:absent`,
      date: day(),
      title: "Upper absent",
      archivedAt: nowInstant(),
      archiveReason: "absence_confirmed",
    });

    const report = await repairOrphanedMirrors(db, userId, { dryRun: true });
    expect(report.totals.unarchived).toBe(0);
    const byId = new Map(report.mirrors.map((m) => [m.workoutId, m]));
    expect(byId.get("shadowed")!.reason).toContain("a live row still holds this session");
    expect(byId.get("done")!.reason).toContain("history is not rewritten");
    // An absence-confirmed row is not this repair's business at all.
    expect(byId.has("absent")).toBe(false);

    // Even when named explicitly, a row with another reason is refused.
    const named = await repairOrphanedMirrors(db, userId, { dryRun: true, workoutIds: ["absent"] });
    expect(named.totals.unarchived).toBe(0);
    expect(named.mirrors[0]!.reason).toContain("only reverses the dedupe");
  });

  it("the census counts the damage without loading the report", async () => {
    await seedOrphan("a");
    await seedOrphan("shadowed", { title: "Upper shadowed" });
    await seedRow({ id: "keeper", sourceWorkoutId: `${LIFT_PLAN}:k`, date: day(), title: "Upper shadowed" });

    const census = await countOrphanedMirrors(db, userId);
    expect(census.archivedMirrors).toBe(2);
    expect(census.orphaned).toBe(1);
    expect(census.dates).toEqual([day()]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. One address, two claimants
// ─────────────────────────────────────────────────────────────────────────────

describe("#2 a recorded address is a claim, not an identity", () => {
  it("the live row wins over an archived one claiming the same address — by stamp, not row order", async () => {
    const day = addDays(today, 3);
    const address = `${LIFT_PLAN}:21`;
    // The archived run row is INSERTED FIRST and is older, so under the old
    // last-row-wins map (and under any "oldest wins" tie-break) it could take
    // the address. It must not: it is the record of a workout that left.
    await seedRow({
      id: "old-run",
      sourceWorkoutId: address,
      date: addDays(today, -10),
      title: "Threshold 5x5",
      sport: "run",
      category: "quality",
      archivedAt: nowInstant(),
      archiveReason: "absence_confirmed",
      createdAt: "2026-01-01T00:00:00Z",
    });
    // The live coach row that COROS verified INTO that recycled slot. It keeps
    // its coach plan, so plan agreement cannot be the key either.
    await seedRow({
      id: "coach-lift",
      sourceWorkoutId: address,
      planId: "coach-plan-1",
      date: day,
      title: "Upper A",
      createdAt: "2026-08-01T00:00:00Z",
    });

    const stats = await importWire([
      wire({ sourceWorkoutId: address, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);

    // The wire workout resolved to the live coach row: it was neither created
    // afresh nor allowed to resurrect the archived run.
    expect(stats.created).toBe(0);
    expect(stats.contestedAddresses).toBe(1);
    expect((await rowById("old-run")).archivedAt).not.toBeNull();
    expect((await rowById("old-run")).title).toBe("Threshold 5x5");
    const coach = await rowById("coach-lift");
    expect(coach.archivedAt).toBeNull();
    expect(coach.lastVerifiedCorosDate).toBe(day);
  });

  it("resolves the same way whichever order the rows come back in", async () => {
    // The bug was that D1's row order decided this. Seeding the two claimants in
    // the opposite order must not change the answer.
    const day = addDays(today, 3);
    const address = `${LIFT_PLAN}:22`;
    await seedRow({
      id: "coach-lift",
      sourceWorkoutId: address,
      planId: "coach-plan-1",
      date: day,
      title: "Upper A",
      createdAt: "2026-08-01T00:00:00Z",
    });
    await seedRow({
      id: "old-run",
      sourceWorkoutId: address,
      date: addDays(today, -10),
      title: "Threshold 5x5",
      sport: "run",
      category: "quality",
      archivedAt: nowInstant(),
      archiveReason: "absence_confirmed",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const stats = await importWire([
      wire({ sourceWorkoutId: address, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);

    expect(stats.created).toBe(0);
    expect((await rowById("old-run")).archivedAt).not.toBeNull();
    expect((await rowById("coach-lift")).lastVerifiedCorosDate).toBe(day);
  });

  it("an archived row is still a candidate when it is the only claimant — healing depends on it", async () => {
    const day = addDays(today, 3);
    const address = `${LIFT_PLAN}:23`;
    await seedRow({
      id: "swept",
      sourceWorkoutId: address,
      date: day,
      title: "Upper A",
      archivedAt: nowInstant(),
      archiveReason: "absence_confirmed",
    });
    const stats = await importWire([
      wire({ sourceWorkoutId: address, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);
    expect(stats.created).toBe(0);
    expect(stats.unarchived).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Date agreement is not content agreement
// ─────────────────────────────────────────────────────────────────────────────

describe("#3 an open content claim keeps the stored column honest", () => {
  it("does not flip an eased row back to synced when the dates agree", async () => {
    const day = addDays(today, 4);
    const address = `${RUN_PLAN}:31`;
    await seedRow({
      id: "eased",
      sourceWorkoutId: address,
      date: day,
      title: "Easy 30 (eased)",
      sport: "run",
      category: "easy",
      // Exactly what `ease` leaves behind: the app holds the content, COROS
      // still has the old body, so the row is calendar_only.
      corosSyncState: "calendar_only",
    });
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: "eased",
      kind: "content",
      source: "coach_ease",
    });

    await importWire([
      wire({ sourceWorkoutId: address, date: day, title: "Easy 30 (eased)", contentFingerprint: "fp-eased" }),
    ]);

    expect((await rowById("eased")).corosSyncState).toBe("calendar_only");
  });

  it("still heals an unclaimed row whose dates agree", async () => {
    const day = addDays(today, 4);
    const address = `${RUN_PLAN}:32`;
    await seedRow({
      id: "flagged",
      sourceWorkoutId: address,
      date: day,
      title: "Easy 40",
      sport: "run",
      category: "easy",
      corosSyncState: "calendar_only",
    });
    await importWire([
      wire({ sourceWorkoutId: address, date: day, title: "Easy 40", contentFingerprint: "fp-flagged" }),
    ]);
    expect((await rowById("flagged")).corosSyncState).toBe("synced");
  });

  it("adopting a COROS date move does not launder the content claim either", async () => {
    const day = addDays(today, 4);
    const moved = addDays(today, 6);
    const address = `${RUN_PLAN}:33`;
    await seedRow({
      id: "eased-moved",
      sourceWorkoutId: address,
      date: day,
      title: "Easy 30 (eased)",
      sport: "run",
      category: "easy",
      corosSyncState: "calendar_only",
    });
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: "eased-moved",
      kind: "content",
      source: "coach_ease",
    });

    await importWire([
      wire({ sourceWorkoutId: address, date: moved, title: "Easy 30 (eased)", contentFingerprint: "fp-eased-moved" }),
    ]);

    const row = await rowById("eased-moved");
    expect(row.effectiveDate).toBe(moved);
    expect(row.corosSyncState).toBe("calendar_only");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A day is not three appointments at 09:00
// ─────────────────────────────────────────────────────────────────────────────

describe("#4 placement", () => {
  it("places three sessions of different kinds without collision, deterministically", async () => {
    const day = addDays(today, 5);
    const sessions = [
      { sourceWorkoutId: `${RUN_PLAN}:41`, title: "Long run", category: "long", sport: "run", seconds: 90 * 60 },
      { sourceWorkoutId: `${LIFT_PLAN}:42`, title: "Upper A", category: "strength", sport: "strength", seconds: 45 * 60 },
      { sourceWorkoutId: `${LIFT_PLAN}:43`, title: "Hip mobility", category: "yoga", sport: "yoga", seconds: 15 * 60 },
    ];
    const wires = sessions.map((s) =>
      wire({
        sourceWorkoutId: s.sourceWorkoutId,
        sourcePlanId: s.sourceWorkoutId.startsWith(LIFT_PLAN) ? LIFT_PLAN : RUN_PLAN,
        date: day,
        title: s.title,
        sport: s.sport,
        estimatedDurationSeconds: s.seconds,
      }),
    );

    await importWire(wires);

    const read = async () =>
      (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.effectiveDate, day)))
        .sort((a, b) => a.effectiveTime.localeCompare(b.effectiveTime))
        .map((r) => [r.title, r.effectiveTime, r.sourceEstimatedDurationSeconds!] as const);

    const placed = await read();
    expect(placed).toHaveLength(3);
    // No two blocks (buffers included) overlap.
    for (let i = 1; i < placed.length; i++) {
      const [, prevTime, prevSeconds] = placed[i - 1]!;
      const [, time] = placed[i]!;
      const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const prevEnd = minutes(prevTime) + prevSeconds / 60 + prefs.bufferAfterMinutes;
      expect(minutes(time) - prefs.bufferBeforeMinutes).toBeGreaterThanOrEqual(prevEnd);
    }
    // The heaviest session anchors the day at the athlete's own window time.
    expect(placed[0]![0]).toBe("Long run");
    expect(placed[0]![1]).toBe(windowTimeFor({ category: "long", date: day }, prefs));
    // …and the filler is last, behind the lift.
    expect(placed.map((p) => p[0])).toEqual(["Long run", "Upper A", "Hip mobility"]);

    // Repeated imports re-derive the SAME times — a placement that drifted would
    // rewrite the athlete's calendar every hour.
    await importWire(wires);
    const again = await importWire(wires);
    expect(again.separatedTimes).toBe(0);
    expect(await read()).toEqual(placed);
  });

  it("leaves a day that already clears itself completely alone", async () => {
    const day = addDays(today, 5);
    await seedRow({ id: "am", sourceWorkoutId: `${RUN_PLAN}:51`, date: day, title: "Easy 40", sport: "run", category: "easy", effectiveTime: "07:00", durationSeconds: 40 * 60 });
    await seedRow({ id: "pm", sourceWorkoutId: `${LIFT_PLAN}:52`, date: day, title: "Upper A", effectiveTime: "18:00", durationSeconds: 45 * 60 });

    const stats = await importWire([
      wire({ sourceWorkoutId: `${RUN_PLAN}:51`, date: day, title: "Easy 40" }),
      wire({ sourceWorkoutId: `${LIFT_PLAN}:52`, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);

    expect(stats.separatedTimes).toBe(0);
    expect((await rowById("am")).effectiveTime).toBe("07:00");
    expect((await rowById("pm")).effectiveTime).toBe("18:00");
  });

  it("never moves a time the athlete chose by hand", async () => {
    const day = addDays(today, 5);
    await seedRow({ id: "pinned", sourceWorkoutId: `${RUN_PLAN}:61`, date: day, title: "Easy 40", sport: "run", category: "easy", effectiveTime: "07:00", durationSeconds: 40 * 60 });
    await seedRow({ id: "lift", sourceWorkoutId: `${LIFT_PLAN}:62`, date: day, title: "Upper A", effectiveTime: "07:00", durationSeconds: 45 * 60 });
    await db.insert(schema.scheduleOverrides).values({
      id: "ov-1",
      workoutId: "pinned",
      kind: "time_change",
      fromDate: day,
      toDate: day,
      toTime: "07:00",
      source: "app",
      createdAt: nowInstant(),
    });

    await importWire([
      wire({ sourceWorkoutId: `${RUN_PLAN}:61`, date: day, title: "Easy 40" }),
      wire({ sourceWorkoutId: `${LIFT_PLAN}:62`, sourcePlanId: LIFT_PLAN, date: day, title: "Upper A", sport: "strength" }),
    ]);

    // The pinned run keeps 07:00 even though the lift would otherwise have it;
    // the lift is what moves.
    expect((await rowById("pinned")).effectiveTime).toBe("07:00");
    expect((await rowById("lift")).effectiveTime).not.toBe("07:00");
  });

  it("does not re-place a day in the past", async () => {
    const yesterday = addDays(today, -1);
    await seedRow({ id: "y1", sourceWorkoutId: `${RUN_PLAN}:71`, date: yesterday, title: "Easy 40", sport: "run", category: "easy", effectiveTime: "07:00", durationSeconds: 40 * 60 });
    await seedRow({ id: "y2", sourceWorkoutId: `${LIFT_PLAN}:72`, date: yesterday, title: "Upper A", effectiveTime: "07:00" });

    await importWire([
      wire({ sourceWorkoutId: `${RUN_PLAN}:71`, date: yesterday, title: "Easy 40" }),
      wire({ sourceWorkoutId: `${LIFT_PLAN}:72`, sourcePlanId: LIFT_PLAN, date: yesterday, title: "Upper A", sport: "strength" }),
    ]);

    expect((await rowById("y1")).effectiveTime).toBe("07:00");
    expect((await rowById("y2")).effectiveTime).toBe("07:00");
  });

  it("stays under D1's bound-variable ceiling across a full 90-day window", async () => {
    // The placement pass binds one variable per DATE. A 90-day import window is
    // the production shape, and better-sqlite3 would happily bind all of them —
    // which is exactly how an unchunked list passes every local test and then
    // freezes the athlete's calendar in prod.
    const capped = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    const seeded = await makeTestUser(capped);
    const start = addDays(today, -30);
    const wires: SourcePlannedWorkout[] = [];
    for (let i = 0; i < 90; i++) {
      const date = addDays(start, i);
      wires.push(
        wire({ sourceWorkoutId: `${RUN_PLAN}:d${i}`, date, title: `Easy ${i}` }),
        wire({
          sourceWorkoutId: `${LIFT_PLAN}:d${i}`,
          sourcePlanId: LIFT_PLAN,
          date,
          title: `Lift ${i}`,
          sport: "strength",
        }),
      );
    }
    await expect(
      importPlanSnapshot(
        capped,
        {
          userId: seeded.userId,
          plan,
          workouts: wires,
          rangeStart: start,
          rangeEnd: addDays(start, 89),
          source: "fixture",
        },
        seeded.prefs,
      ),
    ).resolves.toBeTruthy();
  });

  it("the layout itself is a pure function of the day's set", () => {
    const day = "2026-08-25";
    const sessions = [
      { key: "b", category: "yoga", workoutSeconds: 900, currentTime: "09:00", pinned: false },
      { key: "a", category: "long", workoutSeconds: 5400, currentTime: "09:00", pinned: false },
      { key: "c", category: "strength", workoutSeconds: 2700, currentTime: "09:00", pinned: false },
    ];
    const first = placeDaySessions(day, sessions, prefs);
    const shuffled = placeDaySessions(day, [...sessions].reverse(), prefs);
    expect([...shuffled.entries()].sort()).toEqual([...first.entries()].sort());
    // Three distinct times where prod has three at 09:00.
    expect(new Set(first.values()).size).toBe(3);
  });
});
