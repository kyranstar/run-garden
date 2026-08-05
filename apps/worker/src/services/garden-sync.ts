import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import {
  activities,
  gardenDayInputs,
  gardenEvents,
  gardenPlants,
  gardenSnapshots,
  gardenState,
  gardenUnlocks,
  gardenVisitors,
  gardenWildlife,
  plannedWorkouts,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  daysBetween,
  eachDay,
  isoWeekday,
  newId,
  nowInstant,
  todayInZone,
  type GardenConditionWord,
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
// One derivation of "which discipline is this workout", shared with the
// insights route — a second copy is how the garden and the dashboard come to
// disagree about what counts as a yoga session.
import { disciplineOf } from "@rg/analytics";
import { chunkedInsert, type Db } from "./db.js";
import {
  VISITOR_HINTS,
  VISITOR_LINES,
  visitorForDate,
  type VisitorDayRuns,
  type VisitorKind,
} from "./visitors.js";

/**
 * Garden synchronization: builds resolved day inputs from the database and
 * advances the deterministic simulation. Grace rules: a day is simulated once
 * it is at least 2 days old, or earlier if every workout on it is resolved —
 * so a slow COROS sync is never misread as a missed run.
 */

const CHECKPOINT_WEEKDAY = 1; // Mondays

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
    if (w.completionState === "completed") {
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
        discipline: disciplineOf(w.category, w.sport),
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
      // Non-run unplanned sessions carry their own discipline as the category
      // too, so downstream copy (garden history) can tell a lift from a run
      // instead of reading every unplanned entry as an "easy run".
      category: a.sport === "strength" ? "strength" : a.sport === "yoga" ? "yoga" : "easy",
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
        (w) => w.completionState === "completed",
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
      ["completed", "skipped", "missed"].includes(w.state),
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

  // Simulation upgraded since this garden was last written: rebuild the whole
  // history from the stored inputs so version-3 state (earned grounds) exists
  // for past expansions too. Deterministic — same inputs, same garden.
  if ((snapshot.version ?? 1) < SIMULATION_VERSION) {
    return resimulateFrom(db, userId, snapshot.state.createdDate, prefs, now);
  }

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
  /** Today's rare visitor, if the pattern and the seeded roll line up. */
  visitor: { kind: VisitorKind; line: string } | null;
  /** The rare-visitor ledger: every kind with sightings and its earn hint. */
  visitors: Array<{
    kind: VisitorKind;
    count: number;
    lastSeen: string | null;
    hint: string;
  }>;
  /** How balanced run/strength/yoga are right now, from the current snapshot state. */
  balance: DisciplineBalance;
}

/**
 * The renderable garden: advances the simulation to now, then returns the
 * current snapshot, its one-word condition, and the unlocked-species roster.
 * Shared by the session-authed page route and the device-authed ambient read
 * so both always show the exact same garden.
 */
/**
 * Read-only fold of the simulation from the last durable day through today.
 * Days the durable sim couldn't resolve are simulated from their best-known
 * inputs (or neutral inputs if even that fails); only TODAY's events are
 * returned, since intermediate days will emit identical durable rows when
 * they resolve. Capped at 14 days — beyond that (a durable-sim outage, not
 * normal lag, which the grace window bounds at 2) the durable snapshot
 * stands and the preview stays silent.
 */
export async function previewToday(
  db: Db,
  userId: string,
  snapshot: GardenSnapshot,
  today: LocalDate,
  prefs: UserPreferences,
): Promise<{ snapshot: GardenSnapshot; events: GardenEvent[] }> {
  const gapDays = daysBetween(snapshot.state.lastSimulatedDate, today);
  if (gapDays < 1 || gapDays > 14) return { snapshot, events: [] };
  try {
    let cursor = snapshot;
    let events: GardenEvent[] = [];
    for (
      let date = addDays(snapshot.state.lastSimulatedDate, 1);
      date <= today;
      date = addDays(date, 1)
    ) {
      let input: GardenDayInput;
      try {
        input = await buildDayInput(db, userId, date, prefs);
      } catch {
        input = {
          date,
          completedRuns: [],
          missedRuns: [],
          restObserved: false,
          restModeActive: cursor.state.restMode,
          planGap: false,
        };
      }
      const step = simulateDay(cursor, input);
      cursor = step.snapshot;
      if (date === today) events = step.events;
    }
    return { snapshot: cursor, events };
  } catch {
    // Preview is cosmetic — never let it break the garden read.
    return { snapshot, events: [] };
  }
}

export async function buildGardenView(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<GardenView> {
  await advanceGarden(db, userId, prefs).catch(() => undefined);
  let snapshot = await ensureGarden(db, userId, prefs);

  // Same-day feedback: fold the sim forward read-only from the last durable
  // day through today — resolved days as recorded, unresolved days neutral —
  // so a lagging durable sim can never silence today's run (spec §2 of the
  // 2026-08-05 reward-loop design). Nothing here is persisted.
  const today = todayInZone(prefs.timezone);
  const preview = await previewToday(db, userId, snapshot, today, prefs);
  snapshot = preview.snapshot;
  const previewEvents = preview.events;
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

  // Today's rare visitor: a pure function of the date and the resolved day
  // inputs (see visitors.ts). The ledger only records what was decided.
  let todayVisitor: VisitorKind | null = null;
  let visitorRows: Array<{ kind: string; count: number; lastSeen: string }> = [];
  try {
    const recentInputs = await db
      .select()
      .from(gardenDayInputs)
      .where(and(eq(gardenDayInputs.userId, userId), gte(gardenDayInputs.date, addDays(today, -29))));
    const dayRuns = recentInputs.map((r) => ({
      date: r.date,
      runs: ((r.input as { completedRuns?: unknown }).completedRuns ?? []) as VisitorDayRuns["runs"],
    }));
    todayVisitor = visitorForDate(today, snapshot.state.season, dayRuns);
    if (todayVisitor) {
      const id = `${userId}:${todayVisitor}`;
      const existing = await db.select().from(gardenVisitors).where(eq(gardenVisitors.id, id)).limit(1);
      if (!existing[0]) {
        await db.insert(gardenVisitors).values({
          id,
          userId,
          kind: todayVisitor,
          count: 1,
          firstSeen: today,
          lastSeen: today,
        });
      } else if (existing[0].lastSeen !== today) {
        await db
          .update(gardenVisitors)
          .set({ count: existing[0].count + 1, lastSeen: today })
          .where(eq(gardenVisitors.id, id));
      }
    }
    visitorRows = await db
      .select()
      .from(gardenVisitors)
      .where(eq(gardenVisitors.userId, userId));
  } catch {
    // Visitors are a flourish — never let them break the garden read.
  }
  const visitorByKind = new Map(visitorRows.map((r) => [r.kind, r]));

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
    visitor: todayVisitor ? { kind: todayVisitor, line: VISITOR_LINES[todayVisitor] } : null,
    visitors: (Object.keys(VISITOR_HINTS) as VisitorKind[]).map((kind) => ({
      kind,
      count: visitorByKind.get(kind)?.count ?? 0,
      lastSeen: visitorByKind.get(kind)?.lastSeen ?? null,
      hint: VISITOR_HINTS[kind],
    })),
    balance: disciplineBalance(snapshot.state),
  };
}

export interface GardenTimelineDay {
  date: LocalDate;
  /** Just what `GardenScene` (+ its condition label) needs — not the full
   * `GardenView` (codex/species/nextUnlocks/wildlife-hints), which is
   * derived from the *current* unlocks table and doesn't make sense per
   * historical day. */
  view: { snapshot: GardenSnapshot; condition: GardenConditionWord };
}

/**
 * Read-only replay of the garden's whole simulated history, one entry per
 * durably simulated day (ascending). Purely a fold of the stored, resolved
 * `gardenDayInputs` rows through the pure `simulateDay` — the same rows
 * `resimulateFrom` replays from — starting from `initialSnapshot`, so it
 * never reads `plannedWorkouts`/`activities` again and never touches
 * `gardenState`/`gardenPlants`/`gardenWildlife` (no `persistSnapshot` call).
 * Deterministic: two calls with unchanged inputs return identical output.
 *
 * Today's still-preview day is intentionally excluded — it isn't in
 * `gardenDayInputs` yet (only committed once it's simulated, per
 * `advanceGarden`'s grace rules), and `buildGardenView`'s live snapshot
 * already covers "right now" for the caller.
 *
 * No cap: a garden can only be as old as this single-user product itself, so
 * even a full year (365 rows) replays and serializes cheaply; a multi-year
 * history would want pagination or checkpoint-based windowing instead.
 */
export async function buildGardenTimeline(db: Db, userId: string): Promise<GardenTimelineDay[]> {
  const current = await loadGarden(db, userId);
  if (!current) return [];

  const rows = await db
    .select()
    .from(gardenDayInputs)
    .where(eq(gardenDayInputs.userId, userId))
    .orderBy(asc(gardenDayInputs.date));

  let snapshot = initialSnapshot(current.state.createdDate);
  const days: GardenTimelineDay[] = [];
  for (const row of rows) {
    const input = row.input as unknown as GardenDayInput;
    const result = simulateDay(snapshot, input);
    snapshot = result.snapshot;
    days.push({
      date: row.date,
      view: { snapshot, condition: conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG) },
    });
  }
  return days;
}
