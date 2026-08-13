import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, min, sql } from "drizzle-orm";
import {
  activities,
  dailyHealth,
  gardenDayInputs,
  gardenEvents,
  gardenPlants,
  gardenSeen,
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
  isAdventureSport,
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
  adventureGraceDay,
  conditionWord,
  DEFAULT_GARDEN_CONFIG,
  disciplineBalance,
  initialSnapshot,
  nextUnlocks,
  qualifiesAsAdventure,
  recoveryScoreFrom,
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
import { coachBlockAdherence, COACHED_BLOCK_ADHERENCE, plansEndedOn } from "./coach-plans.js";
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
  // audit#2 #22: `since` is the ARRIVAL date, not the walk-end date. A single
  // persist can land a walk spanning many days (or a whole resim), so
  // lastSimulatedDate is usually well past the day the wildlife actually
  // showed up. The durable wildlife_arrived events (written by walkForward
  // before this runs) carry the true dates; the latest arrival per kind is
  // the start of the current presence stretch. Walk-end remains the fallback
  // only when a present kind somehow has no arrival event on record.
  const arrivalRows = await db
    .select({ wildlifeId: gardenEvents.wildlifeId, date: gardenEvents.date })
    .from(gardenEvents)
    .where(and(eq(gardenEvents.userId, userId), eq(gardenEvents.kind, "wildlife_arrived")));
  const arrivedOn = new Map<string, LocalDate>();
  for (const r of arrivalRows) {
    if (!r.wildlifeId) continue;
    const prev = arrivedOn.get(r.wildlifeId);
    if (!prev || r.date > prev) arrivedOn.set(r.wildlifeId, r.date);
  }
  // P3c: one user-scoped select for the whole roster instead of a per-kind
  // select (2 subrequests × ~a dozen kinds on EVERY persist). Presence rarely
  // flips, so writes stay per-kind but only for rows that actually changed;
  // missing rows land in a single batched insert.
  const wildlifeRows = await db
    .select()
    .from(gardenWildlife)
    .where(eq(gardenWildlife.userId, userId));
  const wildlifeByKind = new Map(wildlifeRows.map((r) => [r.kind, r]));
  const wildlifeInserts: Array<typeof gardenWildlife.$inferInsert> = [];
  for (const kind of Object.keys(snapshot.wildlife) as WildlifeKind[]) {
    const present = snapshot.wildlife[kind];
    const row = wildlifeByKind.get(kind);
    if (row) {
      // Heal `since` even when presence didn't flip: rows stamped with the
      // old walk-end date stay wrong forever otherwise (presence rarely
      // flips back and forth).
      const since = present
        ? (arrivedOn.get(kind) ?? row.since ?? snapshot.state.lastSimulatedDate)
        : row.since;
      if (row.present !== present || row.since !== since) {
        await db.update(gardenWildlife).set({ present, since }).where(eq(gardenWildlife.id, row.id));
      }
    } else {
      wildlifeInserts.push({
        id: `${userId}:${kind}`,
        userId,
        kind,
        present,
        since: present ? (arrivedOn.get(kind) ?? snapshot.state.lastSimulatedDate) : null,
      });
    }
  }
  await chunkedInsert(wildlifeInserts, 5, (batch) => db.insert(gardenWildlife).values(batch));
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
      const startHourLocal = activity
        ? Number((activity.startTimeLocal ?? activity.startTime).slice(11, 13))
        : undefined;
      completedRuns.push({
        workoutId: w.id,
        activityId: match?.activityId,
        category: w.category as WorkoutCategory,
        discipline: disciplineOf(w.category, w.sport),
        // audit#2 #11: the credited window is when the run actually happened
        // — the matched activity's local start hour (evening = 17:00 or
        // later), not the planned slot. Every plan slot is a morning slot,
        // so reading effectiveTime made eveningRunCount (Moonflower, the
        // fireflies) unreachable no matter how many real evening runs
        // landed. The planned slot answers only when no activity matched.
        window:
          startHourLocal !== undefined
            ? startHourLocal >= 17
              ? "evening"
              : "morning"
            : w.effectiveTime < "12:00"
              ? "morning"
              : "evening",
        distanceMeters: activity?.distanceMeters ?? undefined,
        startHourLocal,
      });
    }
  }

  // Unplanned extra sessions: run/strength/yoga activities on this date with no match.
  // audit#2 (c) — documented, deliberately skipped: an unplanned run still
  // cannot RESET the run-decay clock, even in a week with no planned runs.
  // The reset is a transition-function decision (simulateDay reads only the
  // `unplanned` flag, simulate.ts step 4), and the sole input-side lever —
  // clearing `unplanned` here — would also grant the full planned-run
  // rewards (plantings, species, counters) the reward contract reserves for
  // the plan. Changing the transition needs a SIMULATION_VERSION bump, out
  // of scope for input derivation. The pre-race taper is sheltered by the
  // raceDate window below regardless, and an unplanned run already freezes
  // the clock for its own day (the sim neither resets nor advances it).
  // P3a: bound the unmatched-activity scan to the simulated day instead of
  // scanning the whole table once per simulated day. Date attribution below
  // reads the watch-local start (startTimeLocal ?? startTime) while startTime
  // is stored UTC, so the SQL window is deliberately over-inclusive — ±1 day
  // around the local date (the same pattern buildGardenView's
  // lastAdventureDate lookup uses) — and the exact in-memory local-date
  // filter below is unchanged, keeping the derived values identical to the
  // old unbounded scan. The ORDER BY pins what was previously query-plan
  // luck: the unbounded scan had no ORDER BY, so row order (and with it the
  // order of same-day unplanned entries in completedRuns) depended on
  // whether SQLite walked activities_user_time_idx or the table. Explicit
  // chronological order (id tiebreak) is what the index path always
  // returned, and makes the derivation deterministic across engines.
  const dayActivities = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNull(activities.completionMatchId),
        gte(activities.startTime, `${addDays(date, -1)}T00:00:00`),
        lte(activities.startTime, `${addDays(date, 2)}T00:00:00`),
      ),
    )
    .orderBy(asc(activities.startTime), asc(activities.id));
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

  // Adventures: every non-discipline sport on this date. Raw load/duration —
  // the engine applies the effort threshold so the stored inputs stay honest.
  const adventures = dayActivities
    .filter((a) => {
      const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
      return d === date && isAdventureSport(a.sport);
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => ({
      sport: a.sport,
      trainingLoad: a.trainingLoad ?? undefined,
      durationMin: Math.round(a.durationSeconds / 60),
    }));

  // audit#2 #9: a skip/miss LANDS in the garden on max(effectiveDate,
  // resolutionDate) — the later of "when it was due" and "when the decision
  // landed". The old same-day intersection (dayWorkouts ∩ same
  // resolutionDate) was empty whenever the two differed, so late
  // resolutions never debited anywhere and advance sanctions (resolved
  // BEFORE their day) never earned their mercy. Landing late resolutions on
  // the resolution day also keeps them inside walkForward's grace window —
  // their own effective day may already be simulated by then.
  const resolutionLandedOn = sql<string>`max(${plannedWorkouts.effectiveDate}, coalesce(${plannedWorkouts.resolutionDate}, ${plannedWorkouts.effectiveDate}))`;
  const resolvedHere = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        inArray(plannedWorkouts.completionState, ["skipped", "missed"]),
        isNull(plannedWorkouts.archivedAt),
        eq(resolutionLandedOn, date),
      ),
    );
  // Coach-sanctioned skips never cost the garden (fairness spec §1): they are
  // excluded from missedRuns entirely, and the FIRST one in any rolling 7
  // days upgrades the day to observed rest below. Deterministic from
  // resolution rows, so replay is exact.
  const sanctionedHere = resolvedHere.filter((w) => w.sanctionedBy === "coach");
  const missedRuns = resolvedHere
    .filter((w) => w.sanctionedBy !== "coach")
    .map((w) => ({ workoutId: w.id }));
  let mercyToday = false;
  if (sanctionedHere.length > 0) {
    // The rolling-week lookback counts prior sanctions by the same landing
    // date (audit#2 #9) — a sanction that never landed anywhere must not
    // poison the window for the next one.
    const prior = await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.sanctionedBy, "coach"),
          inArray(plannedWorkouts.completionState, ["skipped", "missed"]),
          gte(resolutionLandedOn, addDays(date, -6)),
          lt(resolutionLandedOn, date),
        ),
      );
    mercyToday = prior.length === 0;
  }

  const hasRest = dayWorkouts.some((w) => w.category === "rest");
  const hasNonRest = dayWorkouts.some((w) => w.category !== "rest");
  // audit#2 (b): taper shelter. With a race ahead, a final-weeks day that
  // schedules no run is the taper doing its job, not neglect — mark it the
  // way a planned rest day is marked (restObserved), so the run-decay clock
  // holds instead of marching the garden into drought on race morning. The
  // window is the 21 days before prefs.raceDate through the race day itself
  // (the race is often not a plan row — see the Oct 23 race vs the plan's
  // Oct 3 "Race Day!"). A day inside the window that DOES schedule a run
  // gets no shelter: skipping real taper work still costs.
  const taperShelter =
    prefs.raceDate !== null &&
    date >= addDays(prefs.raceDate, -21) &&
    date <= prefs.raceDate &&
    !dayWorkouts.some((w) => w.category !== "rest" && disciplineOf(w.category, w.sport) === "run");
  const restObserved =
    (hasRest && !hasNonRest && completedRuns.length === 0 && missedRuns.length === 0) ||
    // Mercy day: agreed rest is keeping the plan, not breaking it.
    (mercyToday && completedRuns.length === 0) ||
    taperShelter;

  // Plan gap: no active plan covers this date. audit#2 (a): a NULL date is
  // not "forever" — COROS plans are stored with NULL start/end, and reading
  // NULL as an open bound made every date covered, so planGap could never
  // fire after the last scheduled day. A NULL bound is derived from the
  // min/max effective_date of the plan's own unarchived workouts; a plan
  // with no workouts (the stale empty containers) covers nothing.
  const plans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active")));
  const nullDated = plans.filter((p) => !p.startDate || !p.endDate);
  const workoutBounds = new Map<string, { min: string | null; max: string | null }>();
  if (nullDated.length > 0) {
    const bounds = await db
      .select({
        planId: plannedWorkouts.planId,
        min: min(plannedWorkouts.effectiveDate),
        max: max(plannedWorkouts.effectiveDate),
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          inArray(
            plannedWorkouts.planId,
            nullDated.map((p) => p.id),
          ),
          isNull(plannedWorkouts.archivedAt),
        ),
      )
      .groupBy(plannedWorkouts.planId);
    for (const b of bounds) workoutBounds.set(b.planId, { min: b.min, max: b.max });
  }
  const covered = plans.some((p) => {
    const start = p.startDate ?? workoutBounds.get(p.id)?.min ?? null;
    const end = p.endDate ?? workoutBounds.get(p.id)?.max ?? null;
    return start !== null && end !== null && start <= date && end >= date;
  });
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

  if (adventures.length > 0) input.adventures = adventures;
  const healthRow = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), eq(dailyHealth.date, date)))
    .limit(1);
  const recovery = recoveryScoreFrom(healthRow[0]?.recoveryScore, healthRow[0]?.fatigueScore);
  if (recovery !== undefined) input.recoveryScore = recovery;

  // Fairness spec §4: the day AFTER a coached plan's final day, at ≥85%
  // block adherence, counts a coached block (→ the Keystone pine).
  const endedYesterday = await plansEndedOn(db, userId, addDays(date, -1));
  for (const plan of endedYesterday) {
    const adh = await coachBlockAdherence(db, userId, plan.id, plan.startDate, plan.endDate);
    if (adh !== null && adh >= COACHED_BLOCK_ADHERENCE) {
      input.coachedBlockCompleted = true;
      break;
    }
  }

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
    // audit#2 #10: coach-sanctioned skips leave the denominator entirely —
    // the fairness contract above (§1) promises sanctioned rest never costs
    // the garden, and a consistency chain zeroed by an agreed taper skip
    // would cost it weeks of ivy/clematis/wisteria progress. Same exclusion
    // coachBlockAdherence applies.
    const planned = weekWorkouts.filter(
      (w) =>
        w.category !== "rest" &&
        !(
          w.sanctionedBy === "coach" &&
          (w.completionState === "skipped" || w.completionState === "missed")
        ),
    );
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
  /** True when a capped version-upgrade rebuild stopped early (P3d).
   * `garden_state` still holds the pre-upgrade snapshot — reads keep showing
   * it — and the next advanceGarden call (hourly cron, or any garden read)
   * resumes from the durable checkpoint cursor. */
  resimPending?: boolean;
}

export interface GardenAdvanceOptions {
  /** Per-invocation day cap for version-upgrade rebuilds. Defaults to
   * UPGRADE_RESIM_MAX_DAYS; tests set it low to exercise resumption without
   * touching SIMULATION_VERSION. */
  maxResimDays?: number;
}

/**
 * P3d: how many days one version-upgrade rebuild invocation may simulate.
 * Each simulated day costs ~10-16 D1 subrequests (buildDayInput's queries
 * plus the day-input/event writes), so an uncapped full-history replay hits
 * Cloudflare's 1,000-subrequest budget once a garden is ~90-100 days old.
 * 45 days ≈ 450-720 subrequests, leaving persistSnapshot and the caller's
 * own work comfortable headroom; an older garden simply takes a few hourly
 * cron ticks (or garden reads) to finish rebuilding instead of failing
 * forever.
 */
const UPGRADE_RESIM_MAX_DAYS = 45;

/**
 * Walk `snapshot` forward day-by-day to `today`, writing events/day-inputs/
 * weekly checkpoints as it goes. Deliberately does NOT touch the durable
 * `garden_state` pointer — the caller persists that once the walk is done.
 *
 * That split is what makes `resimulateFrom` crash-safe without a transaction
 * (D1's driver here has none): if this throws partway (subrequest budget,
 * request timeout, …), nothing durable has regressed — `garden_state` still
 * holds whatever it held before the attempt — instead of a genesis/checkpoint
 * stub that then looks like the garden's real, current state. The deleted
 * events/day-inputs/checkpoints for the walked range are safe to leave gone
 * on that failure path: they're rebuilt from scratch by this same function
 * (idempotent — `onConflictDoNothing`/`onConflictDoUpdate` throughout). On
 * the version-upgrade path the rebuild is guaranteed (the stale durable
 * version re-fires the full resim on the next read). On the plain
 * resimulateFrom path the next advanceGarden starts PAST the purged range,
 * so the timeline/event-log hole persists until some later resim covers it —
 * the garden itself renders correctly throughout; only those secondary
 * views read truncated in the interim.
 */
async function walkForward(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  startSnapshot: GardenSnapshot,
  today: LocalDate,
  nowIso: string,
  maxDays?: number,
): Promise<{ snapshot: GardenSnapshot; simulatedDays: number; eventsEmitted: number; capped: boolean }> {
  let snapshot = startSnapshot;
  let simulated = 0;
  let eventsEmitted = 0;
  let capped = false;
  let date = addDays(snapshot.state.lastSimulatedDate, 1);
  while (date < today) {
    // P3d: a capped walk stops mid-history instead of burning through the
    // subrequest budget; the cursor checkpoint below makes it resumable.
    if (maxDays !== undefined && simulated >= maxDays) {
      capped = true;
      break;
    }
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
          // audit#2 #18: the replayed event's date is the truth — a resim
          // must overwrite whatever an existing row says (a genesis-seeded
          // stub, or a date minted before a history heal), not preserve it.
          // onConflictDoNothing let a wrong unlockedOn survive every resim.
          await db
            .insert(gardenUnlocks)
            .values({ id: newId(), userId, speciesId: e.speciesId, unlockedOn: e.date })
            .onConflictDoUpdate({
              target: [gardenUnlocks.userId, gardenUnlocks.speciesId],
              set: { unlockedOn: e.date },
            });
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

  // P3d: a cap-stop writes a checkpoint at the exact stop date (Mondays only
  // wouldn't do — a cap smaller than a week could then never advance the
  // cursor). Checkpoint content is a pure function of the fold, so an extra
  // non-Monday row changes nothing downstream: any resim restarting from it
  // replays byte-identically.
  if (capped && simulated > 0) {
    await db
      .insert(gardenSnapshots)
      .values({
        id: `${userId}:${snapshot.state.lastSimulatedDate}`,
        userId,
        date: snapshot.state.lastSimulatedDate,
        snapshot: snapshot as unknown as Record<string, unknown>,
        simulationVersion: SIMULATION_VERSION,
        createdAt: nowIso,
      })
      .onConflictDoNothing();
  }

  return { snapshot, simulatedDays: simulated, eventsEmitted, capped };
}

/** Advance the simulation through all eligible days. */
export async function advanceGarden(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date = new Date(),
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const startSnapshot = await ensureGarden(db, userId, prefs);

  // Simulation upgraded since this garden was last written: rebuild the whole
  // history from the stored inputs so version-3 state (earned grounds) exists
  // for past expansions too. Deterministic — same inputs, same garden. The
  // rebuild is capped per invocation and resumable (P3d): each call here —
  // hourly cron or any garden read — advances the durable checkpoint cursor
  // until the walk reaches today, and only then does garden_state move.
  if ((startSnapshot.version ?? 1) < SIMULATION_VERSION) {
    return upgradeResimulate(db, userId, startSnapshot, prefs, now, opts);
  }

  const today = todayInZone(prefs.timezone, now);
  const nowIso = nowInstant(now);
  const { snapshot, simulatedDays, eventsEmitted } = await walkForward(db, userId, prefs, startSnapshot, today, nowIso);

  await persistSnapshot(db, userId, snapshot);
  return { simulatedDays, eventsEmitted, lastSimulatedDate: snapshot.state.lastSimulatedDate };
}

/**
 * P3d: the full-history rebuild a SIMULATION_VERSION bump demands, made
 * resumable so it can never hit Cloudflare's subrequest budget and fail
 * forever on an old garden.
 *
 * Cursor: the newest `garden_snapshots` checkpoint already stamped at the
 * CURRENT SIMULATION_VERSION. The first invocation finds none (the purge
 * below removed every old-version checkpoint), starts from genesis, walks at
 * most `maxResimDays` days, and — when capped — writes a checkpoint at the
 * exact stop date. Each later invocation resumes from that cursor.
 *
 * Trust rules: `garden_state` (what every read renders) is persisted ONLY
 * when the walk reaches today uncapped, so a partial rebuild can never be
 * served as the fresh garden — reads keep showing the pre-upgrade snapshot,
 * exactly what they showed between deploy and resim before this change. The
 * stale embedded snapshot version doubles as the resume signal: until the
 * full walk lands, every advanceGarden call re-enters here.
 *
 * `changedFrom` (set when a plain resimulateFrom call arrives while an
 * upgrade is still pending): inputs from that date on have changed, so the
 * cursor is only trusted up to the day before it — later checkpoints are
 * purged and rebuilt.
 */
async function upgradeResimulate(
  db: Db,
  userId: string,
  current: GardenSnapshot,
  prefs: UserPreferences,
  now: Date,
  opts?: GardenAdvanceOptions,
  changedFrom?: LocalDate,
): Promise<GardenSimResult> {
  const cursorConditions = [
    eq(gardenSnapshots.userId, userId),
    eq(gardenSnapshots.simulationVersion, SIMULATION_VERSION),
  ];
  if (changedFrom !== undefined) {
    cursorConditions.push(lte(gardenSnapshots.date, addDays(changedFrom, -1)));
  }
  const cursor = (
    await db
      .select()
      .from(gardenSnapshots)
      .where(and(...cursorConditions))
      .orderBy(desc(gardenSnapshots.date))
      .limit(1)
  )[0];

  let startSnapshot: GardenSnapshot;
  let restartAfter: LocalDate;
  if (cursor) {
    startSnapshot = cursor.snapshot as unknown as GardenSnapshot;
    restartAfter = cursor.date;
  } else {
    startSnapshot = initialSnapshot(current.state.createdDate);
    restartAfter = startSnapshot.state.lastSimulatedDate;
  }

  // Same crash-safe purge contract as resimulateFrom: these rows are
  // rebuilt idempotently by walkForward, and garden_state stays untouched
  // until the whole walk succeeds. On a resume the range past the cursor is
  // already empty (or holds a crashed continuation's partial rows) — the
  // delete is a cheap no-op/heal either way.
  await db
    .delete(gardenEvents)
    .where(and(eq(gardenEvents.userId, userId), gte(gardenEvents.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenDayInputs)
    .where(and(eq(gardenDayInputs.userId, userId), gte(gardenDayInputs.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), gte(gardenSnapshots.date, addDays(restartAfter, 1))));

  const today = todayInZone(prefs.timezone, now);
  const nowIso = nowInstant(now);
  const { snapshot, simulatedDays, eventsEmitted, capped } = await walkForward(
    db,
    userId,
    prefs,
    startSnapshot,
    today,
    nowIso,
    opts?.maxResimDays ?? UPGRADE_RESIM_MAX_DAYS,
  );

  if (capped) {
    // Partial rebuild: the cursor checkpoint is durable, garden_state is NOT
    // moved — reads keep serving the old snapshot as before the deploy, and
    // the still-stale stored version re-fires this path on the next call.
    return {
      simulatedDays,
      eventsEmitted,
      lastSimulatedDate: snapshot.state.lastSimulatedDate,
      resimPending: true,
    };
  }

  await persistSnapshot(db, userId, snapshot);
  return { simulatedDays, eventsEmitted, lastSimulatedDate: snapshot.state.lastSimulatedDate };
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
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const current = await loadGarden(db, userId);
  if (!current || affectedDate > current.state.lastSimulatedDate) {
    return advanceGarden(db, userId, prefs, now, opts);
  }

  // P3d: a pending version upgrade owns the whole timeline — fold this input
  // change into the (capped, resumable) full rebuild instead of walking from
  // an old-version checkpoint, which would persist a mixed-version fold only
  // for the stale stored version to re-fire the full resim anyway.
  if ((current.version ?? 1) < SIMULATION_VERSION) {
    return upgradeResimulate(db, userId, current, prefs, now, opts, affectedDate);
  }

  const checkpoints = await db
    .select()
    .from(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), lte(gardenSnapshots.date, addDays(affectedDate, -1))))
    .orderBy(asc(gardenSnapshots.date));
  const checkpoint = checkpoints[checkpoints.length - 1];

  let startSnapshot: GardenSnapshot;
  let restartAfter: LocalDate;
  if (checkpoint) {
    startSnapshot = checkpoint.snapshot as unknown as GardenSnapshot;
    restartAfter = checkpoint.date;
  } else {
    startSnapshot = initialSnapshot(current.state.createdDate);
    restartAfter = startSnapshot.state.lastSimulatedDate;
  }

  // Drop events/inputs/checkpoints after the restart point; they'll be
  // rebuilt by walkForward below. Safe to do even though nothing has been
  // persisted to garden_state yet: on a mid-walk crash the rendered garden
  // (garden_state, still un-touched below) keeps showing its last known-good
  // value, and any successful resim afterwards rebuilds this range fully.
  await db
    .delete(gardenEvents)
    .where(and(eq(gardenEvents.userId, userId), gte(gardenEvents.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenDayInputs)
    .where(and(eq(gardenDayInputs.userId, userId), gte(gardenDayInputs.date, addDays(restartAfter, 1))));
  await db
    .delete(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), gte(gardenSnapshots.date, addDays(restartAfter, 1))));

  const today = todayInZone(prefs.timezone, now);
  const nowIso = nowInstant(now);
  const { snapshot, simulatedDays, eventsEmitted } = await walkForward(db, userId, prefs, startSnapshot, today, nowIso);

  // Only now — once the FULL walk has succeeded — does the durable garden
  // pointer move. If walkForward throws above, execution never reaches this
  // line: garden_state (and its simulationVersion) stays exactly as it was
  // before this resim attempt, so the next advanceGarden call sees the same
  // "needs resim" signal and retries cleanly instead of finding a genesis
  // stub already stamped at the current SIMULATION_VERSION.
  await persistSnapshot(db, userId, snapshot);
  return { simulatedDays, eventsEmitted, lastSimulatedDate: snapshot.state.lastSimulatedDate };
}

/** Recent garden events for the UI (most recent first). P3b: ORDER BY +
 * LIMIT belong in SQL — the old ascending-scan-then-slice loaded the user's
 * entire event log on every /today and /garden read. (date, seq) is unique
 * per user (garden_events_unique), so descending order + LIMIT returns
 * exactly the rows the slice-and-reverse did, in the same order. */
export async function recentGardenEvents(db: Db, userId: string, limit = 40) {
  return db
    .select()
    .from(gardenEvents)
    .where(eq(gardenEvents.userId, userId))
    .orderBy(desc(gardenEvents.date), desc(gardenEvents.seq))
    .limit(limit);
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
  /** Arrival watermark (null = never marked; see POST /api/garden/seen).
   * `updatedAt` is server-stamped on every write — the arrival admission
   * logic (C13) uses it to tell a genuinely rebuilt event (resimulateFrom,
   * createdAt AFTER this) apart from an ordinary one that's simply behind
   * the watermark. */
  seen: {
    lastSeenDate: string;
    lastSeenSeq: number;
    celebratedSpeciesIds: string[];
    updatedAt: string;
  } | null;
  /** Garden-birthday line, on the anniversary of `createdDate` (age ≥ 1y). */
  anniversary: string | null;
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
  /** Today's adventure shield: sheltered day + what to name in the caption. */
  adventure: { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null };
  /**
   * True calendar date of the most recent completed run activity (any
   * discipline-agnostic run, matched or unmatched to a planned workout) —
   * null if none ever recorded. C2 (round 2): the decay clock
   * (`balance.run.days`) freezes on shielded/rest days, so it can sit
   * BEHIND real recency once a past shield has ended; the HUD caption needs
   * the true date to stop presenting a paused count as fresh fact.
   */
  lastRunDate: LocalDate | null;
  /**
   * audit#2: does the sim's run-decay clock hold still through TODAY? True
   * on sheltered days — plan gap, observed rest (planned, mercy, or race
   * taper), adventure freeze/grace, rest mode — the exact conditions
   * simulateDay's decay path consults, read from the same fold that
   * rendered `snapshot`. The UI's projected decay must freeze on the sim's
   * own shelter set, not re-derive an approximation ("no next workout")
   * that can contradict the durable clock in either direction.
   */
  runDecayPausedToday: boolean;
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
): Promise<{
  snapshot: GardenSnapshot;
  events: GardenEvent[];
  todayInput: GardenDayInput | null;
  /** Today's own adventure shield, as the fold that rendered `snapshot`
   * actually computed it (C11) — undefined only when the fold didn't run
   * (see the gapDays guard below), in which case a caller should fall back
   * to deriving the shield from durable state directly. */
  todayShield?: { adventureFrozen: boolean; graceDay: boolean };
}> {
  const gapDays = daysBetween(snapshot.state.lastSimulatedDate, today);
  if (gapDays < 1 || gapDays > 14) return { snapshot, events: [], todayInput: null };
  try {
    let cursor = snapshot;
    let events: GardenEvent[] = [];
    let todayInput: GardenDayInput | null = null;
    let todayShield: { adventureFrozen: boolean; graceDay: boolean } | undefined;
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
      if (date === today) {
        events = step.events;
        todayInput = input;
        todayShield = step.shield;
      }
    }
    return { snapshot: cursor, events, todayInput, todayShield };
  } catch {
    // Preview is cosmetic — never let it break the garden read.
    return { snapshot, events: [], todayInput: null };
  }
}

export async function buildGardenView(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<GardenView> {
  await advanceGarden(db, userId, prefs).catch(() => undefined);
  let snapshot = await ensureGarden(db, userId, prefs);

  // Fallback-only shield state, read pre-preview: used below solely when the
  // preview didn't run (see todayShield). When it DOES run, C11's fix is to
  // prefer its own per-day shield instead of re-deriving from this — a fold
  // spanning more than just today (an unresolved yesterday held the durable
  // sim back) can consume a banked grace day or log an adventure the durable
  // sim hasn't committed yet, and a re-derivation from this pre-fold
  // snapshot would then disagree with what was actually rendered.
  const shieldState = {
    lastAdventureDate: snapshot.state.lastAdventureDate ?? null,
    adventureGraceDays: snapshot.state.adventureGraceDays ?? 0,
    restMode: snapshot.state.restMode,
  };

  // Same-day feedback: fold the sim forward read-only from the last durable
  // day through today — resolved days as recorded, unresolved days neutral —
  // so a lagging durable sim can never silence today's run (spec §2 of the
  // 2026-08-05 reward-loop design). Nothing here is persisted. The fold also
  // hands back today's input and its own shield for the adventure shield below.
  const today = todayInZone(prefs.timezone);
  const preview = await previewToday(db, userId, snapshot, today, prefs);
  snapshot = preview.snapshot;
  const previewEvents = preview.events;
  const todayInput = preview.todayInput;
  const todayShield = preview.todayShield;
  let unlocks = await db
    .select()
    .from(gardenUnlocks)
    .where(eq(gardenUnlocks.userId, userId))
    .orderBy(desc(gardenUnlocks.unlockedOn));

  // Self-heal the collection: the snapshot's unlockedSpeciesIds is the truth,
  // but genesis ("start") species predate the unlocks table, so seed any
  // missing rows — otherwise the collection reads "0 species" on day one.
  // audit#2 #18: ONLY start-gated species may be stamped at createdDate —
  // this heal used to seed ANY ledger-missing species at genesis, minting a
  // wrong unlock date an earned species then carried forever (the Field
  // poppy: Aug 1 shown, Aug 6 earned). Earned species get their row, with
  // the event's true date, from walkForward's species_unlocked insert.
  const have = new Set(unlocks.map((u) => u.speciesId));
  const missing = snapshot.unlockedSpeciesIds.filter(
    (id) => !have.has(id) && SPECIES_BY_ID.get(id)?.unlock.kind === "start",
  );
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

  // Adventure shield for the caption: is today sheltered, and by what?
  const qualifyingToday = (todayInput?.adventures ?? []).filter(qualifiesAsAdventure);
  let frozenToday: boolean;
  let graceDay: boolean;
  if (todayShield) {
    // C11: the preview fold ran — trust ITS shield for the day it actually
    // rendered rather than re-deriving from shieldState (captured before the
    // fold, and stale whenever the fold spans more than just today). The
    // engine's `graceDay` and "adventure happened today" are mutually
    // exclusive by construction (adventureGraceDay never returns true when
    // adventureToday is true — see adventure.ts), so this reconstruction of
    // frozenToday from the combined `adventureFrozen` flag is lossless.
    graceDay = todayShield.graceDay;
    frozenToday = todayShield.adventureFrozen && !todayShield.graceDay;
  } else {
    // The preview didn't run (durable sim is already caught up through
    // today), so `snapshot.state` — and therefore shieldState above — IS
    // today's real, committed state: the original derivation is accurate.
    frozenToday = qualifyingToday.length > 0;
    graceDay =
      !frozenToday &&
      adventureGraceDay(
        {
          lastAdventureDate: shieldState.lastAdventureDate,
          adventureGraceDays: shieldState.adventureGraceDays,
        },
        {
          date: today,
          hasSession: (todayInput?.completedRuns.length ?? 0) > 0,
          adventureToday: false,
          restMode: shieldState.restMode,
          planGap: todayInput?.planGap ?? false,
          recoveryScore: todayInput?.recoveryScore,
        },
      );
  }
  // C11 residual: the sport/date NAMED in the caption must come from the
  // POST-FOLD snapshot (what actually got rendered), not shieldState
  // (captured before the fold). When the preview didn't run, snapshot is
  // still exactly the pre-preview state, so this is a strict superset fix —
  // never a regression for that path.
  const postFoldLastAdventureDate = snapshot.state.lastAdventureDate ?? null;
  let lastSport: string | null = qualifyingToday[0]?.sport ?? null;
  if (!lastSport && graceDay && postFoldLastAdventureDate) {
    // Find the sport of an adventure activity that actually falls on
    // lastAdventureDate (by *local* date — the caption names this date).
    // startTime is UTC, so the window is deliberately over-inclusive by a
    // day on each side; the exact local-date match happens in memory. If
    // several activities land on that date, pick deterministically by id.
    const lastAdventureDate = postFoldLastAdventureDate;
    const rows = await db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          gte(activities.startTime, `${addDays(lastAdventureDate, -1)}T00:00:00`),
          lte(activities.startTime, `${addDays(lastAdventureDate, 2)}T00:00:00`),
        ),
      );
    const match = rows
      .filter(
        (a) =>
          isAdventureSport(a.sport) &&
          (a.startTimeLocal ?? a.startTime).slice(0, 10) === lastAdventureDate,
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    lastSport = match?.sport ?? null;
  }

  // audit#2: today's run-decay shelter, from the fold that actually rendered
  // the snapshot (todayInput + the shield above — same sourcing rule as
  // C11). When the preview didn't run at all (a >14-day durable outage),
  // claim nothing: false keeps the projection honest about an unknown day.
  const runDecayPausedToday =
    snapshot.state.restMode ||
    frozenToday ||
    graceDay ||
    (todayInput !== null && (todayInput.planGap || todayInput.restObserved));

  const seenRow = (
    await db.select().from(gardenSeen).where(eq(gardenSeen.userId, userId)).limit(1)
  )[0];

  // C2 (round 2): true calendar recency for the run-bar caption, independent
  // of the decay clock's freeze/skip days. A single indexed query
  // (activities_user_time_idx covers userId, sorted by startTime) rather
  // than deriving from the durable run_completed events — those events also
  // cover strength/yoga sessions (applyRun emits run_completed for every
  // discipline) and would need extra category filtering to mean "a run"; a
  // direct sport='run' lookup is both cheaper and unambiguous.
  const lastRunRow = (
    await db
      .select({ startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
      .from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.sport, "run")))
      .orderBy(desc(activities.startTime))
      .limit(1)
  )[0];
  const lastRunDate: LocalDate | null = lastRunRow
    ? (lastRunRow.startTimeLocal ?? lastRunRow.startTime).slice(0, 10)
    : null;

  // Garden birthday (Bundle 3 §6): a quiet once-a-year line, no art needed.
  const created = snapshot.state.createdDate;
  const ageYears = Number(today.slice(0, 4)) - Number(created.slice(0, 4));
  const anniversary =
    ageYears >= 1 && today.slice(5) === created.slice(5)
      ? `The garden turns ${ageYears} today — it remembers every run.`
      : null;

  return {
    snapshot,
    condition: conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG),
    previewEvents,
    seen: seenRow
      ? {
          lastSeenDate: seenRow.lastSeenDate,
          lastSeenSeq: seenRow.lastSeenSeq,
          celebratedSpeciesIds: seenRow.celebratedSpeciesIds,
          updatedAt: seenRow.updatedAt,
        }
      : null,
    anniversary,
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
    adventure: {
      frozenToday,
      graceDay,
      lastSport,
      lastDate: frozenToday ? today : postFoldLastAdventureDate,
    },
    lastRunDate,
    runDecayPausedToday,
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
