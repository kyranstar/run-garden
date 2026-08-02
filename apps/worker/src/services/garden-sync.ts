import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
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
  type GardenEvent,
  type LocalDate,
  type UserPreferences,
  type WildlifeKind,
  type WorkoutCategory,
} from "@rg/domain";
import {
  conditionWord,
  DEFAULT_GARDEN_CONFIG,
  disciplineBalance,
  initialSnapshot,
  nextUnlocks,
  simulateDay,
  SIMULATION_VERSION,
  SPECIES_BY_ID,
  speciesCodex,
  WILDLIFE_HINTS,
  type Discipline,
  type DisciplineBalance,
  type GardenDayInput,
  type GardenSnapshot,
  type SpeciesUnlockStatus,
} from "@rg/garden-engine";
import { chunkedInsert, type Db } from "./db.js";

/**
 * Garden synchronization: builds resolved day inputs from the database and
 * advances the deterministic simulation. Grace rules: a day is simulated once
 * it is at least 2 days old, or earlier if every workout on it is resolved —
 * so a slow COROS/Strava sync is never misread as a missed run.
 */

const CHECKPOINT_WEEKDAY = 1; // Mondays

/** Which discipline axis a workout belongs to, from its category or sport. */
function disciplineFor(category: string, sport: string): Discipline {
  if (category === "strength" || sport === "strength") return "strength";
  if (category === "yoga" || sport === "yoga") return "yoga";
  return "run";
}

export async function loadGarden(db: Db, userId: string): Promise<GardenSnapshot | null> {
  const rows = await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  if (!rows[0]) return null;
  return rows[0].snapshot as unknown as GardenSnapshot;
}

export async function ensureGarden(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  genesisDate?: LocalDate,
): Promise<GardenSnapshot> {
  const existing = await loadGarden(db, userId);
  if (existing) return existing;
  // A new garden starts on its genesis date (today for real users; the plan
  // start for a backfilled history) so the simulation can replay from there.
  const snapshot = initialSnapshot(genesisDate ?? todayInZone(prefs.timezone));
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
  const plantRows = snapshot.plants.map((p) => ({
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
  }));
  await chunkedInsert(plantRows, 17, (batch) => db.insert(gardenPlants).values(batch));
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
      // The matched activity's real distance/start hour drive the achievement
      // unlocks (milestone distances, early-bird runs).
      const activity = match?.activityId
        ? (
            await db.select().from(activities).where(eq(activities.id, match.activityId)).limit(1)
          )[0]
        : undefined;
      completedRuns.push({
        workoutId: w.id,
        activityId: match?.activityId,
        category: w.category as WorkoutCategory,
        discipline: disciplineFor(w.category, w.sport),
        window: w.effectiveTime < "12:00" ? "morning" : "evening",
        distanceMeters: activity?.distanceMeters ?? undefined,
        startHourLocal: activity
          ? Number((activity.startTimeLocal ?? activity.startTime).slice(11, 13))
          : undefined,
      });
    }
  }

  // Unplanned extra sessions: run/strength/yoga activities on this date with no match.
  const dayActivities = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), isNull(activities.completionMatchId)));
  for (const a of dayActivities) {
    const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
    if (d !== date || (a.sport !== "run" && a.sport !== "strength" && a.sport !== "yoga")) continue;
    completedRuns.push({
      workoutId: `unplanned-${a.id}`,
      activityId: a.id,
      category: "easy",
      discipline: a.sport as Discipline,
      window: (a.startTimeLocal ?? a.startTime).slice(11, 16) < "12:00" ? "morning" : "evening",
      unplanned: true,
      distanceMeters: a.distanceMeters ?? undefined,
      startHourLocal: Number((a.startTimeLocal ?? a.startTime).slice(11, 13)),
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
      const eventRows = result.events.map((e) => ({
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
      }));
      await chunkedInsert(eventRows, 14, (batch) =>
        db.insert(gardenEvents).values(batch).onConflictDoNothing(),
      );
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

export interface GardenSpeciesView {
  speciesId: string;
  name: string;
  category: string | undefined;
  rarity: string | undefined;
  unlockedOn: string;
  livingCount: number;
}

export interface GardenView {
  snapshot: GardenSnapshot;
  condition: string;
  species: GardenSpeciesView[];
  /**
   * Non-persisted events from previewing *today* (rain from a run completed
   * hours ago, plants taking root). The durable simulation only records a day
   * once it's over, but feedback must be same-day: these are what tomorrow's
   * persistence will record for today, computed early. Deterministic, so the
   * durable replay converges to exactly this.
   */
  previewEvents: GardenEvent[];
  /** Every species — unlocked and locked — with hints and real progress. */
  codex: Array<SpeciesUnlockStatus & { unlockedOn: string | null; livingCount: number }>;
  /** The nearest locked species: the "1 more week and it arrives" nudges. */
  nextUnlocks: SpeciesUnlockStatus[];
  /** Wildlife visitors: who's here now and what draws each kind. */
  wildlife: Array<{ kind: string; present: boolean; hint: string }>;
  /** How balanced run/strength/yoga are right now, from the current snapshot state. */
  balance: DisciplineBalance;
}

/**
 * The renderable garden: advances the simulation to now, then returns the
 * current snapshot, its one-word condition, and the unlocked-species roster.
 * Shared by the session-authed page route and the device-authed ambient read
 * so both always show the exact same garden.
 */
export async function buildGardenView(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<GardenView> {
  await advanceGarden(db, userId, prefs).catch(() => undefined);
  let snapshot = await ensureGarden(db, userId, prefs);

  // Same-day feedback: if a run was completed today, preview today's simulation
  // for display (rain, growth, events) without persisting it. Only when the
  // durable sim is exactly caught up to yesterday — previewing across a gap
  // would skip days and misrepresent.
  let previewEvents: GardenEvent[] = [];
  const today = todayInZone(prefs.timezone);
  if (addDays(snapshot.state.lastSimulatedDate, 1) === today) {
    try {
      const todayInput = await buildDayInput(db, userId, today, prefs);
      if (todayInput.completedRuns.length > 0) {
        const preview = simulateDay(snapshot, todayInput);
        snapshot = preview.snapshot;
        previewEvents = preview.events;
      }
    } catch {
      // Preview is cosmetic — never let it break the garden read.
    }
  }
  let unlocks = await db
    .select()
    .from(gardenUnlocks)
    .where(eq(gardenUnlocks.userId, userId))
    .orderBy(desc(gardenUnlocks.unlockedOn));

  // Self-heal the collection: the snapshot's unlockedSpeciesIds is the truth,
  // but genesis ("start") species predate the unlocks table, so seed any
  // missing rows — otherwise the collection reads "0 species" on day one.
  const have = new Set(unlocks.map((u) => u.speciesId));
  const missing = snapshot.unlockedSpeciesIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    for (const speciesId of missing) {
      await db
        .insert(gardenUnlocks)
        .values({ id: newId(), userId, speciesId, unlockedOn: snapshot.state.createdDate })
        .onConflictDoNothing();
    }
    unlocks = await db
      .select()
      .from(gardenUnlocks)
      .where(eq(gardenUnlocks.userId, userId))
      .orderBy(desc(gardenUnlocks.unlockedOn));
  }
  const unlockedOnById = new Map(unlocks.map((u) => [u.speciesId, u.unlockedOn]));
  const livingCount = (speciesId: string): number =>
    snapshot.plants.filter((p) => p.speciesId === speciesId && p.state !== "dead").length;

  return {
    snapshot,
    condition: conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG),
    previewEvents,
    species: unlocks.map((u) => {
      const s = SPECIES_BY_ID.get(u.speciesId);
      return {
        speciesId: u.speciesId,
        name: s?.name ?? u.speciesId,
        category: s?.category,
        rarity: s?.rarity,
        unlockedOn: u.unlockedOn,
        livingCount: livingCount(u.speciesId),
      };
    }),
    codex: speciesCodex(snapshot).map((entry) => ({
      ...entry,
      unlockedOn: unlockedOnById.get(entry.speciesId) ?? null,
      livingCount: livingCount(entry.speciesId),
    })),
    nextUnlocks: nextUnlocks(snapshot, 3),
    wildlife: Object.entries(snapshot.wildlife).map(([kind, present]) => ({
      kind,
      present,
      hint: WILDLIFE_HINTS[kind as keyof typeof WILDLIFE_HINTS] ?? "",
    })),
    balance: disciplineBalance(snapshot.state),
  };
}
