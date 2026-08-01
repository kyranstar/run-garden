import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import {
  activities,
  gardenDayInputs,
  gardenEvents,
  gardenPlants,
  gardenSnapshots,
  gardenState,
  gardenUnlocks,
  gardenWildlife,
  plannedWorkouts,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  eachDay,
  isoWeekday,
  newId,
  nowInstant,
  todayInZone,
  type LocalDate,
  type UserPreferences,
  type WildlifeKind,
  type WorkoutCategory,
} from "@rg/domain";
import {
  initialSnapshot,
  simulateDay,
  SIMULATION_VERSION,
  type GardenDayInput,
  type GardenSnapshot,
} from "@rg/garden-engine";
import type { Db } from "./db.js";

/**
 * Garden synchronization: builds resolved day inputs from the database and
 * advances the deterministic simulation. Grace rules: a day is simulated once
 * it is at least 2 days old, or earlier if every workout on it is resolved —
 * so a slow COROS/Strava sync is never misread as a missed run.
 */

const CHECKPOINT_WEEKDAY = 1; // Mondays

export async function loadGarden(db: Db, userId: string): Promise<GardenSnapshot | null> {
  const rows = await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  if (!rows[0]) return null;
  return rows[0].snapshot as unknown as GardenSnapshot;
}

export async function ensureGarden(db: Db, userId: string, prefs: UserPreferences): Promise<GardenSnapshot> {
  const existing = await loadGarden(db, userId);
  if (existing) return existing;
  const today = todayInZone(prefs.timezone);
  const snapshot = initialSnapshot(today);
  await persistSnapshot(db, userId, snapshot);
  return snapshot;
}

async function persistSnapshot(db: Db, userId: string, snapshot: GardenSnapshot): Promise<void> {
  const now = nowInstant();
  const existing = await db.select({ userId: gardenState.userId }).from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  const value = {
    snapshot: snapshot as unknown as Record<string, unknown>,
    simulationVersion: SIMULATION_VERSION,
    lastSimulatedDate: snapshot.state.lastSimulatedDate,
    updatedAt: now,
  };
  if (existing[0]) await db.update(gardenState).set(value).where(eq(gardenState.userId, userId));
  else await db.insert(gardenState).values({ userId, ...value });

  // Projections for queries/diagnostics.
  await db.delete(gardenPlants).where(eq(gardenPlants.userId, userId));
  if (snapshot.plants.length > 0) {
    await db.insert(gardenPlants).values(
      snapshot.plants.map((p) => ({
        id: `${userId}:${p.id}`,
        userId,
        speciesId: p.speciesId,
        category: p.category,
        plantedAt: p.plantedAt,
        sourceWorkoutId: p.sourceWorkoutId ?? null,
        health: p.health,
        hydration: p.hydration,
        maturity: p.maturity,
        bloomProgress: p.bloomProgress,
        state: p.state,
        posX: p.position.x,
        posY: p.position.y,
        region: p.position.region,
        hostPlantId: p.hostPlantId ?? null,
        diedAt: p.diedAt ?? null,
        habitatRole: p.habitatRole ?? null,
      })),
    );
  }
  for (const kind of Object.keys(snapshot.wildlife) as WildlifeKind[]) {
    const id = `${userId}:${kind}`;
    const present = snapshot.wildlife[kind];
    const row = await db.select().from(gardenWildlife).where(eq(gardenWildlife.id, id)).limit(1);
    if (row[0]) {
      if (row[0].present !== present) {
        await db
          .update(gardenWildlife)
          .set({ present, since: present ? snapshot.state.lastSimulatedDate : row[0].since })
          .where(eq(gardenWildlife.id, id));
      }
    } else {
      await db.insert(gardenWildlife).values({
        id,
        userId,
        kind,
        present,
        since: present ? snapshot.state.lastSimulatedDate : null,
      });
    }
  }
}

/** Build the resolved inputs for one calendar day from the database. */
export async function buildDayInput(
  db: Db,
  userId: string,
  date: LocalDate,
  prefs: UserPreferences,
): Promise<GardenDayInput> {
  const dayWorkouts = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, date),
        isNull(plannedWorkouts.archivedAt),
      ),
    );

  const completedRuns: GardenDayInput["completedRuns"] = [];
  for (const w of dayWorkouts) {
    if (w.completionState === "completed" || w.completionState === "provisionally_completed") {
      const match = (
        await db
          .select()
          .from(workoutCompletionMatches)
          .where(and(eq(workoutCompletionMatches.workoutId, w.id), isNull(workoutCompletionMatches.undoneAt)))
          .limit(1)
      )[0];
      completedRuns.push({
        workoutId: w.id,
        activityId: match?.activityId,
        category: w.category as WorkoutCategory,
        window: w.effectiveTime < "12:00" ? "morning" : "evening",
      });
    }
  }

  // Unplanned extra runs: run-sport activities on this date with no match.
  const dayActivities = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), isNull(activities.completionMatchId)));
  for (const a of dayActivities) {
    const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
    if (d !== date || a.sport !== "run") continue;
    completedRuns.push({
      workoutId: `unplanned-${a.id}`,
      activityId: a.id,
      category: "easy",
      window: (a.startTimeLocal ?? a.startTime).slice(11, 16) < "12:00" ? "morning" : "evening",
      unplanned: true,
    });
  }

  const missedRuns = dayWorkouts
    .filter(
      (w) =>
        (w.completionState === "skipped" || w.completionState === "missed") &&
        (w.resolutionDate ?? w.effectiveDate) === date,
    )
    .map((w) => ({ workoutId: w.id }));

  const hasRest = dayWorkouts.some((w) => w.category === "rest");
  const hasNonRest = dayWorkouts.some((w) => w.category !== "rest");
  const restObserved = hasRest && !hasNonRest && completedRuns.length === 0 && missedRuns.length === 0;

  // Plan gap: no active plan covers this date.
  const plans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active")));
  const covered = plans.some(
    (p) => (!p.startDate || p.startDate <= date) && (!p.endDate || p.endDate >= date),
  );
  const planGap = !covered && dayWorkouts.length === 0;

  const restModeActive =
    prefs.gardenRestMode &&
    (!prefs.gardenRestModeUntil || prefs.gardenRestModeUntil >= date);

  const input: GardenDayInput = {
    date,
    completedRuns,
    restObserved,
    missedRuns,
    restModeActive,
    planGap,
  };

  // Week adherence on Mondays (for consistency unlocks).
  if (isoWeekday(date) === 1) {
    const weekStart = addDays(date, -7);
    const weekEnd = addDays(date, -1);
    const weekWorkouts = await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          gte(plannedWorkouts.effectiveDate, weekStart),
          lte(plannedWorkouts.effectiveDate, weekEnd),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
    const planned = weekWorkouts.filter((w) => w.category !== "rest");
    if (planned.length > 0) {
      const done = planned.filter(
        (w) => w.completionState === "completed" || w.completionState === "provisionally_completed",
      ).length;
      input.weekAdherence = done / planned.length;
    }
  }

  return input;
}

/** Is every workout on this date resolved (nothing still awaiting sync)? */
async function dayFullyResolved(db: Db, userId: string, date: LocalDate): Promise<boolean> {
  const dayWorkouts = await db
    .select({ state: plannedWorkouts.completionState, category: plannedWorkouts.category })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, date),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  return dayWorkouts.every(
    (w) =>
      w.category === "rest" ||
      ["completed", "provisionally_completed", "skipped", "missed"].includes(w.state),
  );
}

export interface GardenSimResult {
  simulatedDays: number;
  eventsEmitted: number;
  lastSimulatedDate: LocalDate;
}

/** Advance the simulation through all eligible days. */
export async function advanceGarden(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date = new Date(),
): Promise<GardenSimResult> {
  let snapshot = await ensureGarden(db, userId, prefs);
  const today = todayInZone(prefs.timezone, now);
  const nowIso = nowInstant(now);

  let simulated = 0;
  let eventsEmitted = 0;
  let date = addDays(snapshot.state.lastSimulatedDate, 1);
  while (date < today) {
    const graceDate = addDays(today, -2);
    if (date > graceDate && !(await dayFullyResolved(db, userId, date))) break;

    const input = await buildDayInput(db, userId, date, prefs);
    const result = simulateDay(snapshot, input);
    snapshot = result.snapshot;
    simulated += 1;
    eventsEmitted += result.events.length;

    await db
      .insert(gardenDayInputs)
      .values({
        id: `${userId}:${date}`,
        userId,
        date,
        input: input as unknown as Record<string, unknown>,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: gardenDayInputs.id,
        set: { input: input as unknown as Record<string, unknown>, updatedAt: nowIso },
      });

    if (result.events.length > 0) {
      await db
        .insert(gardenEvents)
        .values(
          result.events.map((e) => ({
            id: `${userId}:${e.id}`,
            userId,
            kind: e.kind,
            date: e.date,
            seq: e.seq,
            workoutId: e.workoutId ?? null,
            activityId: e.activityId ?? null,
            workoutCategory: e.workoutCategory ?? null,
            plantId: e.plantId ?? null,
            speciesId: e.speciesId ?? null,
            wildlifeId: e.wildlifeId ?? null,
            detail: e.detail ?? null,
            simulationVersion: e.simulationVersion,
            createdAt: nowIso,
          })),
        )
        .onConflictDoNothing();
      for (const e of result.events) {
        if (e.kind === "species_unlocked" && e.speciesId) {
          await db
            .insert(gardenUnlocks)
            .values({ id: newId(), userId, speciesId: e.speciesId, unlockedOn: e.date })
            .onConflictDoNothing();
        }
      }
    }

    if (isoWeekday(date) === CHECKPOINT_WEEKDAY) {
      await db
        .insert(gardenSnapshots)
        .values({
          id: `${userId}:${date}`,
          userId,
          date,
          snapshot: snapshot as unknown as Record<string, unknown>,
          simulationVersion: SIMULATION_VERSION,
          createdAt: nowIso,
        })
        .onConflictDoNothing();
    }

    date = addDays(date, 1);
  }

  await persistSnapshot(db, userId, snapshot);
  return { simulatedDays: simulated, eventsEmitted, lastSimulatedDate: snapshot.state.lastSimulatedDate };
}

/**
 * Replay after history changed (late-arriving activity for a past date):
 * restart from the latest checkpoint before the affected date, rebuild inputs
 * from the database, and resimulate. Deterministic, so the result converges.
 */
export async function resimulateFrom(
  db: Db,
  userId: string,
  affectedDate: LocalDate,
  prefs: UserPreferences,
  now: Date = new Date(),
): Promise<GardenSimResult> {
  const current = await loadGarden(db, userId);
  if (!current || affectedDate > current.state.lastSimulatedDate) {
    return advanceGarden(db, userId, prefs, now);
  }

  const checkpoints = await db
    .select()
    .from(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), lte(gardenSnapshots.date, addDays(affectedDate, -1))))
    .orderBy(asc(gardenSnapshots.date));
  const checkpoint = checkpoints[checkpoints.length - 1];

  let snapshot: GardenSnapshot;
  let restartAfter: LocalDate;
  if (checkpoint) {
    snapshot = checkpoint.snapshot as unknown as GardenSnapshot;
    restartAfter = checkpoint.date;
  } else {
    snapshot = initialSnapshot(current.state.createdDate);
    restartAfter = snapshot.state.lastSimulatedDate;
  }

  // Drop events/inputs/checkpoints after the restart point; they'll be rebuilt.
  await db
    .delete(gardenEvents)
    .where(and(eq(gardenEvents.userId, userId), gte(gardenEvents.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenDayInputs)
    .where(and(eq(gardenDayInputs.userId, userId), gte(gardenDayInputs.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), gte(gardenSnapshots.date, addDays(restartAfter, 1))));

  await persistSnapshot(db, userId, snapshot);
  return advanceGarden(db, userId, prefs, now);
}

/** Recent garden events for the UI (most recent first). */
export async function recentGardenEvents(db: Db, userId: string, limit = 40) {
  return db
    .select()
    .from(gardenEvents)
    .where(eq(gardenEvents.userId, userId))
    .orderBy(gardenEvents.date, gardenEvents.seq)
    .then((rows) => rows.slice(-limit).reverse());
}
