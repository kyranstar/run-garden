import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, max, min, ne, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  accountState,
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
  nightState,
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
  DEW_TENDED_DAYS,
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

/** The morning dew first became derivable (sleep/recovery 0020). Nights
 * before this date produce neither `settledNight` nor `dew` on ANY path —
 * buildDayInput is re-run by every resim, so without this gate a resim would
 * retroactively mint dew across history the athlete already watched accrue
 * ("counts start at zero the day this ships" is a promise to them). */
const DEW_EPOCH = "2026-08-19";

/** App sessions (`activities.source = 'app'`) grow the garden from the day the player went live in production
 * (ruling 2d-R1), by the session's day on the athlete's own clock: it went live 2026-10-08 02:25Z, which was the
 * evening of 2026-10-07 in the athlete's zone, so the epoch is that local day (Audit 2d I-1) — a session played that
 * evening credits, as the deployed code already credited it. One dated earlier — only a clock-skewed device can save
 * one — credits nothing, at any read: the same promise as DEW_EPOCH, that a resim never mints credit across history
 * the athlete already watched. */
export const APP_SESSION_EPOCH: LocalDate = "2026-10-07";
import { chunkedInsert, chunkIds, type Db } from "./db.js";
import { isRestoring, loadAccountState, patchAccountState, restoreInProgress } from "./account-state.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { coachBlockAdherence, COACHED_BLOCK_ADHERENCE, plansEndedOn } from "./coach-plans.js";
import { AUTO_MISS_DAYS } from "./reconcile-daily.js";
import { REQUEST_REPLAY_MAX_DAYS } from "./cron-limits.js";
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

/**
 * Does the garden see this activity at all? (rulings 2d-R1, 2d-R3; spec §2d) Imported history (`source = 'import'`)
 * never — at every read, so importing the standalone tool's past leaves every garden byte-identical; an app session
 * only from APP_SESSION_EPOCH on; everything else as it always did, the watch's sessions and a merged app + watch
 * session (a COROS row, counted once) included. With no app or import rows this is true of every row, which is what
 * keeps the live account's past garden where it was.
 */
export function gardenSees(a: { source: string; startTime: string; startTimeLocal: string | null }): boolean {
  if (a.source === "import") return false;
  return a.source !== "app" || (a.startTimeLocal ?? a.startTime).slice(0, 10) >= APP_SESSION_EPOCH;
}

/** `gardenSees` as SQL, for the reads that stop at their first row in the database. Three binds. */
export function gardenSeesSql(): SQL {
  return and(
    ne(activities.source, "import"),
    or(ne(activities.source, "app"), gte(sql`coalesce(${activities.startTimeLocal}, ${activities.startTime})`, APP_SESSION_EPOCH)),
  )!;
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
  // A restore is replacing this account (ruling B2): the file's garden must
  // not lose to one simulated here — a genesis stub from ensureGarden, or a
  // walk that started before the restore did.
  if (await restoreInProgress(db, userId)) return;
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
  await chunkedInsert(plantRows, (batch) => db.insert(gardenPlants).values(batch));
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
  await chunkedInsert(wildlifeInserts, (batch) => db.insert(gardenWildlife).values(batch));
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
      // Rulings 2d-R1, 2d-R3: a completion the garden does not see (imported history; an app session dated before
      // APP_SESSION_EPOCH) credits nothing — the slot reads as if that session had not happened: still OPEN, so it
      // misses as an open slot does, AUTO_MISS_DAYS after its day (`lapsed` below; Audit 2d I-2). The match route
      // refuses such an activity, so only a write that bypasses it can make one.
      if (activity && !gardenSees(activity)) continue;
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
  // Rulings 2d-R1, 2d-R3: the unplanned sessions and the adventures below read only what the garden sees.
  const dayActivities = (
    await db
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
      .orderBy(asc(activities.startTime), asc(activities.id))
  ).filter(gardenSees);
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
  // Audit 2d I-2: a slot completed only by an activity the garden does not see is, to the garden, still open — so it
  // misses where an open slot does: the daily reconcile misses one AUTO_MISS_DAYS after its day, and that is the day
  // it lands (an auto-missed row lands there too, so matching one changes nothing). A miss resolved on another day
  // by hand loses that day to the match, which overwrites it; the debit itself is never lost. One read, the join
  // stopping at no row for every account without such a completion.
  const lapsed = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .innerJoin(
      workoutCompletionMatches,
      and(eq(workoutCompletionMatches.workoutId, plannedWorkouts.id), isNull(workoutCompletionMatches.undoneAt)),
    )
    .innerJoin(activities, eq(activities.id, workoutCompletionMatches.activityId))
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "completed"),
        eq(plannedWorkouts.effectiveDate, addDays(date, -AUTO_MISS_DAYS)),
        isNull(plannedWorkouts.archivedAt),
        ne(plannedWorkouts.category, "rest"),
        or(isNull(plannedWorkouts.sanctionedBy), ne(plannedWorkouts.sanctionedBy, "coach")),
        not(gardenSeesSql()),
      ),
    );
  const missedRuns = [
    ...resolvedHere.filter((w) => w.sanctionedBy !== "coach").map((w) => ({ workoutId: w.id })),
    ...lapsed.map((w) => ({ workoutId: w.id })),
  ];
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
  // Dew (sleep/recovery 0020): did the night INTO this date settle the body?
  // daily_health rows are wake-date keyed, so the row of `date` describes the
  // night that ended that morning. "gap" stays undefined — no reading is
  // never a bad night, and the engine treats absent exactly like pre-feature
  // stored inputs.
  //
  // DEW_EPOCH: nights before the feature shipped derive NOTHING, in every
  // path — resims re-derive day inputs from these same tables (walkForward
  // overwrites stored rows), so without the gate any resimulateFrom would
  // retroactively mint dew across pre-feature history and disagree with the
  // state the athlete already watched accrue (verify round 1, finding 1).
  //
  // Tended-ness (option C) is decided HERE, from the durable activities
  // table — a RUN within DEW_TENDED_DAYS, running today included. Not engine
  // state (a clock dew itself freezes self-renews; a snapshot backfill
  // diverges between replay paths — findings 1–2), and not any-discipline
  // (sleep + two yoga sessions a week pinned the run clock forever —
  // finding 2). Runs bring the rain; dew is water.
  if (date >= DEW_EPOCH && healthRow[0]) {
    const night = nightState({
      hrv: healthRow[0].hrv,
      sleepHrvBase: healthRow[0].sleepHrvBase,
      sleepHrvSd: healthRow[0].sleepHrvSd,
      recoveryScore: healthRow[0].recoveryScore,
    });
    if (night !== "gap") {
      input.settledNight = night === "settled";
      if (input.settledNight) {
        const ranToday = completedRuns.some((r) => (r.discipline ?? "run") === "run");
        const recentRun = ranToday
          ? [{}]
          : await db
              .select({ id: activities.id })
              .from(activities)
              .where(
                and(
                  eq(activities.userId, userId),
                  eq(activities.sport, "run"),
                  gte(activities.startTimeLocal, addDays(date, -DEW_TENDED_DAYS)),
                  lt(activities.startTimeLocal, addDays(date, 1)),
                  gardenSeesSql(),
                ),
              )
              .limit(1);
        if (recentRun.length > 0) input.dew = true;
      }
    }
  }

  // Fairness spec §4: the day AFTER a coached plan's final day, at ≥85%
  // block adherence, counts a coached block (→ the Keystone pine).
  const endedYesterday = await plansEndedOn(db, userId, addDays(date, -1));
  for (const plan of endedYesterday) {
    const adh = await coachBlockAdherence(db, userId, plan.id, plan.startDate, plan.endDate, unseenCompletions);
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
      const completed = planned.filter(
        (w) => w.completionState === "completed",
      );
      // Rulings 2d-R1, 2d-R3: a slot whose completion the garden does not see is not done here either — the same
      // reading as the day's own completed-slot path above.
      const unseen = await unseenCompletions(db, completed.map((w) => w.id));
      const done = completed.filter((w) => !unseen.has(w.id)).length;
      input.weekAdherence = done / planned.length;
    }
  }

  return input;
}

/** Of these completed workouts, the ones whose active completion is an activity the garden does not see
 * (`gardenSees`). One read per 90 ids — D1's 100 binds — and none for none. */
export async function unseenCompletions(db: Db, workoutIds: string[]): Promise<Set<string>> {
  const unseen = new Set<string>();
  for (const ids of chunkIds(workoutIds)) {
    const rows = await db
      .select({ workoutId: workoutCompletionMatches.workoutId })
      .from(workoutCompletionMatches)
      .innerJoin(activities, eq(activities.id, workoutCompletionMatches.activityId))
      .where(and(inArray(workoutCompletionMatches.workoutId, ids), isNull(workoutCompletionMatches.undoneAt), not(gardenSeesSql())));
    for (const r of rows) unseen.add(r.workoutId);
  }
  return unseen;
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
  /** True when a capped walk stopped early. On a version-upgrade rebuild
   * (P3d) `garden_state` still holds the pre-upgrade snapshot and the next
   * advanceGarden call resumes from the durable checkpoint cursor; on a
   * post-restore catch-up (B4 amended) `garden_state` holds the day the step
   * stopped at and the next call walks on from there. */
  resimPending?: boolean;
}

export interface GardenAdvanceOptions {
  /** Per-invocation day cap for version-upgrade rebuilds, post-restore
   * catch-up steps and replays (`resimulateFrom`, and a replay on record that
   * an earlier call left unfinished). Defaults to UPGRADE_RESIM_MAX_DAYS /
   * CATCH_UP_MAX_DAYS; a replay is uncapped by default. The crons and every
   * request (REQUEST_GARDEN_STEP) set it so one invocation never replays
   * weeks; tests set it low to exercise resumption. */
  maxResimDays?: number;
  /** Per-invocation day cap for the plain walk forward. Uncapped by default; the crons (cron reliability, part 2) and
   * every request (REQUEST_GARDEN_STEP, part 4) set it so one invocation never walks weeks. A capped walk persists the
   * day it stopped at, and the next call walks on from there (`resimPending`). */
  maxWalkDays?: number;
}

/**
 * The caps every REQUEST passes when it walks the garden (cron reliability, part 4): the garden page, every route that
 * replays after a change, the app's session save, a request's COROS read and backfill chunk. Both caps, always — a
 * replay asked for from a day the garden has not reached yet is a plain walk forward (`resimulate` hands it to
 * advanceGarden), and a pending version upgrade or post-restore catch-up takes `maxResimDays` too. A capped call
 * leaves the rest on record and the rendered garden where it was (see replayStep); the next request or cron walks on.
 */
export const REQUEST_GARDEN_STEP: Readonly<GardenAdvanceOptions> = Object.freeze({
  maxWalkDays: REQUEST_REPLAY_MAX_DAYS,
  maxResimDays: REQUEST_REPLAY_MAX_DAYS,
});

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
 * How many days one post-restore catch-up step may walk (B4 amended). Same
 * arithmetic as UPGRADE_RESIM_MAX_DAYS: a restored file can be months behind
 * the calendar, and walking all of it in one request is what used to fail
 * restore finish (audit 1 data finding 6).
 */
const CATCH_UP_MAX_DAYS = 45;

/**
 * A walk looks for the restore marker every this many simulated days (B9):
 * a long walk already running when begin fires stops within a week of days
 * instead of writing the rest of its range into the account being replaced.
 * One indexed read a week of walking; the restore's garden rows then win the
 * handful of keys it wrote (account-restore's FILE_WINS_ON).
 */
const MARKER_CHECK_DAYS = 7;

interface WalkLimits {
  /** Stop after this many simulated days (`capped` in the result). */
  maxDays?: number;
  /** Write a checkpoint at the exact day a capped walk stopped — the version
   * upgrade's durable cursor. The catch-up's cursor is `garden_state`. */
  checkpointAtCap?: boolean;
}

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
 * resimulateFrom path the replay's start day is on record
 * (`account_state.garden_changed_from`) before anything is purged, and the
 * next advanceGarden replays from it (cron reliability, part 3) — before,
 * that walk started PAST the purged range, so the purged days stayed missing
 * and the changed day's credit (a late activity's) was never simulated.
 */
async function walkForward(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  startSnapshot: GardenSnapshot,
  today: LocalDate,
  nowIso: string,
  limits: WalkLimits = {},
): Promise<{ snapshot: GardenSnapshot; simulatedDays: number; eventsEmitted: number; capped: boolean; halted: boolean }> {
  const { maxDays, checkpointAtCap = false } = limits;
  let snapshot = startSnapshot;
  let simulated = 0;
  let eventsEmitted = 0;
  let capped = false;
  let halted = false;
  let date = addDays(snapshot.state.lastSimulatedDate, 1);
  while (date < today) {
    // P3d: a capped walk stops mid-history instead of burning through the
    // subrequest budget; the caller's cursor makes it resumable.
    if (maxDays !== undefined && simulated >= maxDays) {
      capped = true;
      break;
    }
    if (simulated > 0 && simulated % MARKER_CHECK_DAYS === 0 && (await restoreInProgress(db, userId))) {
      // A restore began while this walk ran: stop writing. Reported as
      // capped so no caller treats the walk as having reached today; the
      // persist that follows is refused while the marker is set.
      capped = true;
      halted = true;
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
      await chunkedInsert(eventRows, (batch) =>
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
  if (capped && checkpointAtCap && simulated > 0 && !halted) {
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

  return { snapshot, simulatedDays: simulated, eventsEmitted, capped, halted };
}

/** While a restore is replacing the account nothing is simulated (B2). */
async function standDown(db: Db, userId: string, prefs: UserPreferences, now: Date): Promise<GardenSimResult> {
  const current = await loadGarden(db, userId);
  return {
    simulatedDays: 0,
    eventsEmitted: 0,
    lastSimulatedDate: current?.state.lastSimulatedDate ?? addDays(todayInZone(prefs.timezone, now), -1),
  };
}

/** Advance the simulation through all eligible days. */
export async function advanceGarden(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date = new Date(),
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const account = await loadAccountState(db, userId);
  if (isRestoring(account)) return standDown(db, userId, prefs, now);
  const startSnapshot = await ensureGarden(db, userId, prefs);

  // Simulation upgraded since this garden was last written: rebuild the whole
  // history — every day input re-derived from the live tables (buildDayInput)
  // with the preferences in force NOW, not replayed from the stored inputs —
  // so version-3 state (earned grounds) exists for past expansions too. The
  // rebuild is capped per invocation and resumable (P3d): each call here —
  // hourly cron or any garden read — advances the durable checkpoint cursor
  // until the walk reaches today, and only then does garden_state move.
  if ((startSnapshot.version ?? 1) < SIMULATION_VERSION) {
    return upgradeResimulate(db, userId, startSnapshot, prefs, now, opts);
  }

  // A restored garden still catching up from the file's last day (B4
  // amended): one capped, forward-only step.
  if (account?.gardenCatchUpPending) {
    const lock = await claimUserLock(db, userId, GARDEN_LOCK, GARDEN_LOCK_STALE_MINUTES);
    // Another step, or an ingest's resimulation, is walking this garden
    // right now: two walks at once write the same days from different folds.
    if (!lock) return { ...(await standDown(db, userId, prefs, now)), resimPending: true };
    try {
      return await catchUpStep(db, userId, prefs, now, opts);
    } finally {
      await releaseUserLock(db, userId, GARDEN_LOCK, lock).catch(() => undefined);
    }
  }

  // A replay is on record and not finished (cron reliability, part 3): an input changed on a day already
  // simulated, and the walk that replays it was capped, or killed. It goes first — a plain walk from
  // garden_state would start past the changed day.
  if (account?.gardenChangedFrom != null) {
    return replayStep(db, userId, prefs, now, startSnapshot, opts);
  }
  return walkOn(db, userId, prefs, now, startSnapshot, opts);
}

/** The plain walk forward from garden_state, persisted where it stops. */
async function walkOn(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date,
  startSnapshot: GardenSnapshot,
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const today = todayInZone(prefs.timezone, now);
  const nowIso = nowInstant(now);
  const { snapshot, simulatedDays, eventsEmitted, capped } = await walkForward(
    db,
    userId,
    prefs,
    startSnapshot,
    today,
    nowIso,
    opts?.maxWalkDays !== undefined ? { maxDays: opts.maxWalkDays } : {},
  );

  // A capped walk persists where it stopped — the same state the walk had reached day by day — and the next
  // call walks on from there.
  await persistSnapshot(db, userId, snapshot);
  return {
    simulatedDays,
    eventsEmitted,
    lastSimulatedDate: snapshot.state.lastSimulatedDate,
    ...(capped && opts?.maxWalkDays !== undefined ? { resimPending: true } : {}),
  };
}

/**
 * The per-user lock a post-restore catch-up step and an ingest's
 * resimulation take while the catch-up is pending (N2): both walk the same
 * days, and two walks at once interleave writes from different folds —
 * events are insert-or-ignore, so the first writer of a day wins for good.
 * Nobody waits for it (ruling B11): a step that finds it held skips, and a
 * resimulation that finds it held records its change for the next step. A
 * dead holder's lock goes stale after a minute.
 */
const GARDEN_LOCK = "garden";
const GARDEN_LOCK_STALE_MINUTES = 1;

/**
 * Record an input change for the next catch-up step (B11, B12): the
 * earliest changed date wins, the sequence moves on every record, and the
 * catch-up is marked pending so a step that was about to clear it cannot.
 * One statement; never waits. Nothing is recorded once a restore has begun
 * (NEW-B): the change belongs to the account being replaced, and a record
 * that outlived the restore would move the file's own history.
 */
async function recordGardenChange(db: Db, userId: string, date: LocalDate): Promise<void> {
  await db
    .update(accountState)
    .set({
      gardenChangedFrom: sql`CASE WHEN ${accountState.gardenChangedFrom} IS NULL OR ${accountState.gardenChangedFrom} > ${date} THEN ${date} ELSE ${accountState.gardenChangedFrom} END`,
      gardenChangedSeq: sql`${accountState.gardenChangedSeq} + 1`,
      gardenCatchUpPending: true,
      updatedAt: nowInstant(),
    })
    .where(and(eq(accountState.userId, userId), isNull(accountState.restoreId)));
}

/**
 * `recordReplayFrom` as a statement a caller runs in its own transaction: it lands with the caller's writes or not at
 * all, and as an upsert for an account that has no `account_state` row yet. The app's save (session-save.ts) and the
 * watch session's review (session-watch-review.ts) record the day their replay must start from together with the
 * session, so a replay killed after the commit is not lost (audit 2b-A M-5): the next garden read or cron replays from
 * it, a capped step at a time (ruling 2b-R7). Nothing is recorded while a restore runs.
 *
 * A plain replay on record — never the post-restore catch-up flag (cron reliability, part 4). It used to set the flag,
 * from before a plain replay could be on record (part 3); but a catch-up step restarts from the checkpoint before the
 * EARLIEST day on record, purges every derived row after it and persists garden_state where its capped walk stops:
 * behind where it was. With a long replay on record (the owner's rebuild from 2026-08-01) one session saved in the app
 * rewound the rendered garden to August. The plain replay (replayStep) is just as durable and resumable, and never
 * moves garden_state back. A restore's own catch-up still honours this record: its step reads the same column.
 */
export function gardenChangeStatement(db: Db, userId: string, date: LocalDate) {
  const now = nowInstant();
  return db
    .insert(accountState)
    .values({ userId, gardenChangedFrom: date, gardenChangedSeq: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: accountState.userId,
      set: {
        gardenChangedFrom: sql`CASE WHEN ${accountState.gardenChangedFrom} IS NULL OR ${accountState.gardenChangedFrom} > ${date} THEN ${date} ELSE ${accountState.gardenChangedFrom} END`,
        gardenChangedSeq: sql`${accountState.gardenChangedSeq} + 1`,
        updatedAt: now,
      },
      setWhere: isNull(accountState.restoreId),
    });
}

/**
 * Genesis ("start") species: unlocked from the garden's first day, never by
 * an event. Their unlock rows are stamped at `createdDate` by the garden
 * view's heal — after the cursor of a garden whose first day is not walked
 * yet — and are true in every world, so the catch-up's purge keeps them
 * (NEW-C: deleted, the next view re-healed them under new ids).
 */
const START_SPECIES = [...SPECIES_BY_ID.values()].filter((s) => s.unlock.kind === "start").map((s) => s.id);

/**
 * One post-restore catch-up step, under the garden lock (rulings B4 amended,
 * amended-2, B11 and B12).
 *
 * The cursor is `garden_state.lastSimulatedDate`. An input change on record
 * at or before it (B11 — recorded by a resimulation that found the lock held,
 * or by the one running this step) moves the cursor back (B12): this step
 * walks from the newest checkpoint before the changed day — or from genesis
 * when there is none — instead of from `garden_state`. There is no separate
 * replay: the same capped walk below does the work, however far back the
 * change is, so no step costs more than `maxResimDays` days. A change past
 * the cursor needs nothing: the walk reads it fresh.
 *
 * Rows dated AFTER the cursor are deleted first: they belong to no world — a
 * step that died part-way wrote them from a fold whose inputs may since have
 * changed, a walk of the account the restore replaced landed them after
 * begin's wipe, or (once the cursor moves back) they were derived without
 * the change — and events and checkpoints are insert-or-ignore, so left in
 * place they would keep this walk's rows out and seed a later resimulation.
 * Nothing at or before the cursor is ever deleted: without a recorded
 * change, the file's history stays as exported.
 *
 * Then a forward walk of at most `maxResimDays` days, `garden_state`
 * persisted where it stopped — behind where it was, when the cursor moved
 * back further than one step walks. The record is cleared only after that
 * persist, so a step that dies part-way leaves it, and the next step starts
 * from the same checkpoint. The step that reaches today clears the flag —
 * unless a change was recorded meanwhile, which the next step picks up.
 */
async function catchUpStep(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date,
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const account = await loadAccountState(db, userId);
  // A restore began after this step's caller looked: nothing to walk.
  if (isRestoring(account)) return standDown(db, userId, prefs, now);
  const recorded = account?.gardenChangedFrom ?? null;
  const seq = account?.gardenChangedSeq ?? 0;
  let start = await ensureGarden(db, userId, prefs);
  if (recorded !== null && recorded <= start.state.lastSimulatedDate) {
    const [checkpoint] = await db
      .select()
      .from(gardenSnapshots)
      .where(and(eq(gardenSnapshots.userId, userId), lte(gardenSnapshots.date, addDays(recorded, -1))))
      .orderBy(desc(gardenSnapshots.date))
      .limit(1);
    start = checkpoint
      ? (checkpoint.snapshot as unknown as GardenSnapshot)
      : initialSnapshot(start.state.createdDate);
  }
  const cursor = start.state.lastSimulatedDate;
  // The record is cleared only if nothing was recorded while this step ran:
  // a change that landed meanwhile may be one this step read too early.
  const clearRecorded = async (): Promise<void> => {
    if (recorded === null) return;
    await db
      .update(accountState)
      .set({ gardenChangedFrom: null, updatedAt: nowInstant() })
      .where(and(eq(accountState.userId, userId), eq(accountState.gardenChangedSeq, seq)));
  };

  await db.delete(gardenEvents).where(and(eq(gardenEvents.userId, userId), gt(gardenEvents.date, cursor)));
  await db.delete(gardenDayInputs).where(and(eq(gardenDayInputs.userId, userId), gt(gardenDayInputs.date, cursor)));
  await db.delete(gardenSnapshots).where(and(eq(gardenSnapshots.userId, userId), gt(gardenSnapshots.date, cursor)));
  await db
    .delete(gardenUnlocks)
    .where(
      and(
        eq(gardenUnlocks.userId, userId),
        gt(gardenUnlocks.unlockedOn, cursor),
        notInArray(gardenUnlocks.speciesId, START_SPECIES),
      ),
    );

  const { snapshot, simulatedDays, eventsEmitted, capped } = await walkForward(
    db,
    userId,
    prefs,
    start,
    todayInZone(prefs.timezone, now),
    nowInstant(now),
    { maxDays: opts?.maxResimDays ?? CATCH_UP_MAX_DAYS },
  );
  await persistSnapshot(db, userId, snapshot);
  await clearRecorded();
  if (!capped) {
    await db
      .update(accountState)
      .set({ gardenCatchUpPending: false, updatedAt: nowInstant() })
      .where(and(eq(accountState.userId, userId), isNull(accountState.gardenChangedFrom)));
  }
  return {
    simulatedDays,
    eventsEmitted,
    lastSimulatedDate: snapshot.state.lastSimulatedDate,
    ...(capped ? { resimPending: true } : {}),
  };
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
    { maxDays: opts?.maxResimDays ?? UPGRADE_RESIM_MAX_DAYS, checkpointAtCap: true },
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
  const account = await loadAccountState(db, userId);
  if (isRestoring(account)) return standDown(db, userId, prefs, now);
  if (account?.gardenCatchUpPending) return catchUpResimulate(db, userId, affectedDate, prefs, now, opts);
  return resimulate(db, userId, affectedDate, prefs, now, opts);
}

/**
 * An input changed while a restored garden is still catching up (N2, B11,
 * B12). The change is recorded, then with the garden lock free this call
 * takes it and runs one catch-up step — which, for a change at or before the
 * cursor, walks from the checkpoint before it, capped like any step. With the
 * lock held — a step is walking, or a dead one's claim has not gone stale —
 * it never waits: the next step picks the record up. A request (approve, a
 * skip, a match) or a `waitUntil` ingest therefore always returns at once,
 * and never spends more than one step's budget on the garden.
 */
async function catchUpResimulate(
  db: Db,
  userId: string,
  affectedDate: LocalDate,
  prefs: UserPreferences,
  now: Date,
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  // Recorded first either way: durable before any purge, so a step that dies
  // part-way leaves the change for the next one.
  await recordGardenChange(db, userId, affectedDate);
  const lock = await claimUserLock(db, userId, GARDEN_LOCK, GARDEN_LOCK_STALE_MINUTES);
  if (!lock) return { ...(await standDown(db, userId, prefs, now)), resimPending: true };
  try {
    const current = await loadGarden(db, userId);
    if (current && (current.version ?? 1) < SIMULATION_VERSION) {
      return await upgradeResimulate(db, userId, current, prefs, now, opts, affectedDate);
    }
    return await catchUpStep(db, userId, prefs, now, opts);
  } finally {
    await releaseUserLock(db, userId, GARDEN_LOCK, lock).catch(() => undefined);
  }
}

/**
 * The plain replay (outside a post-restore catch-up). Anything to replay goes on record first — durably, before a
 * single row is purged — and `replayStep` does the walking.
 */
async function resimulate(
  db: Db,
  userId: string,
  affectedDate: LocalDate,
  prefs: UserPreferences,
  now: Date,
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const current = await loadGarden(db, userId);
  if (!current || affectedDate > current.state.lastSimulatedDate) {
    return advanceGarden(db, userId, prefs, now, opts);
  }

  await recordReplayFrom(db, userId, affectedDate);

  // P3d: a pending version upgrade owns the whole timeline — fold this input
  // change into the (capped, resumable) full rebuild instead of walking from
  // an old-version checkpoint, which would persist a mixed-version fold only
  // for the stale stored version to re-fire the full resim anyway. The record
  // stays: once the rebuild lands, the next walk replays from it once more —
  // a rebuild step that died before its purge may have resumed past the day.
  if ((current.version ?? 1) < SIMULATION_VERSION) {
    return upgradeResimulate(db, userId, current, prefs, now, opts, affectedDate);
  }
  return replayStep(db, userId, prefs, now, current, opts);
}

/**
 * Put a replay on record (cron reliability, part 3): `account_state.garden_changed_from` — the earliest day whose
 * inputs changed under days already simulated — and a bump of `garden_changed_seq`. An upsert (an account may have
 * no `account_state` row yet); the earliest day wins; the post-restore catch-up flag is left alone (its step honours
 * the same record); nothing is recorded while a restore runs (NEW-B: the change belongs to the account being
 * replaced). One statement, written before the replay purges anything: an invocation killed at any point after it
 * leaves the record, and whatever walks the garden next replays from it.
 */
export async function recordReplayFrom(db: Db, userId: string, date: LocalDate): Promise<void> {
  const now = nowInstant();
  await db
    .insert(accountState)
    .values({ userId, gardenChangedFrom: date, gardenChangedSeq: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: accountState.userId,
      set: {
        gardenChangedFrom: sql`CASE WHEN ${accountState.gardenChangedFrom} IS NULL OR ${accountState.gardenChangedFrom} > ${date} THEN ${date} ELSE ${accountState.gardenChangedFrom} END`,
        gardenChangedSeq: sql`${accountState.gardenChangedSeq} + 1`,
        updatedAt: now,
      },
      setWhere: isNull(accountState.restoreId),
    });
}

/** Is a replay on record and unfinished for this account (`recordReplayFrom`)? One indexed read. */
export async function replayPending(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ from: accountState.gardenChangedFrom })
    .from(accountState)
    .where(eq(accountState.userId, userId))
    .limit(1);
  return (row?.from ?? null) !== null;
}

/**
 * Of the days an ingest touched (sorted or not), the earliest the garden must replay from — or null when it holds
 * every one of them exactly as the tables now give it (cron reliability, part 3). A day must be replayed when it is
 * past the last simulated day (the walk forward reads it: resimulateFrom walks on), when `mustReplay` names it (a new
 * activity's day), when it has no stored day input, or when its input rebuilt now differs from the stored one. Each
 * day's input carries everything the garden reads of that day's activities and slots, so identical inputs on every
 * touched day mean the replay would write back what is there. One rebuild per touched day, in date order, stopping
 * at the first that differs.
 */
export async function firstDayToReplay(
  db: Db,
  userId: string,
  touched: readonly LocalDate[],
  mustReplay: ReadonlySet<LocalDate>,
  prefs: UserPreferences,
): Promise<LocalDate | null> {
  if (touched.length === 0) return null;
  const [state] = await db
    .select({ last: gardenState.lastSimulatedDate })
    .from(gardenState)
    .where(eq(gardenState.userId, userId))
    .limit(1);
  for (const date of [...touched].sort()) {
    if (!state || date > state.last || mustReplay.has(date)) return date;
    const [stored] = await db
      .select({ input: gardenDayInputs.input })
      .from(gardenDayInputs)
      .where(eq(gardenDayInputs.id, `${userId}:${date}`))
      .limit(1);
    if (!stored) return date;
    const rebuilt = await buildDayInput(db, userId, date, prefs);
    if (JSON.stringify(rebuilt) !== JSON.stringify(stored.input)) return date;
  }
  return null;
}

/**
 * Move or clear the replay record — only if nothing was recorded since `seq` was read (a change that landed meanwhile
 * may be one this walk read too early, so its record stands), only while one is on record (a restore's begin clears
 * it, and a late walk must not bring it back) and never during a restore.
 */
async function settleReplayFrom(db: Db, userId: string, seq: number, next: LocalDate | null): Promise<void> {
  await db
    .update(accountState)
    .set({ gardenChangedFrom: next, updatedAt: nowInstant() })
    .where(
      and(
        eq(accountState.userId, userId),
        eq(accountState.gardenChangedSeq, seq),
        not(isNull(accountState.gardenChangedFrom)),
        isNull(accountState.restoreId),
      ),
    );
}

/** Delete the derived rows dated after `after` (through `through`, when given): events, day inputs, checkpoints. */
async function purgeDerived(db: Db, userId: string, after: LocalDate, through: LocalDate | null): Promise<void> {
  const range = (col: typeof gardenEvents.date | typeof gardenDayInputs.date | typeof gardenSnapshots.date) =>
    through === null ? gt(col, after) : and(gt(col, after), lte(col, through));
  await db.delete(gardenEvents).where(and(eq(gardenEvents.userId, userId), range(gardenEvents.date)));
  await db.delete(gardenDayInputs).where(and(eq(gardenDayInputs.userId, userId), range(gardenDayInputs.date)));
  await db.delete(gardenSnapshots).where(and(eq(gardenSnapshots.userId, userId), range(gardenSnapshots.date)));
}

/**
 * One step of a replay on record (cron reliability, part 3): restart from the newest checkpoint before the recorded
 * day — or from genesis when there is none — rebuild the inputs from the database, and walk forward. Deterministic,
 * so the result converges, however many steps it takes and wherever an earlier one died.
 *
 * Uncapped (a garden read, a request): the old replay exactly — every derived row after the checkpoint purged, the
 * walk to today, garden_state persisted, the record cleared.
 *
 * Capped at `maxResimDays` (the crons): only the days this step will walk are purged first, and
 *  - stopped before the day garden_state shows: garden_state is NOT moved — the rendered garden keeps what it showed
 *    (never rewound, the C21 promise) — a checkpoint is written at the stop day and the record moves to the day
 *    after it, so the next step resumes there (`resimPending`). The old timeline after the stop stays readable until
 *    a step reaches it.
 *  - reached or passed it: the rest of the old timeline is purged (what the uncapped replay purged up front),
 *    garden_state persisted where the walk stopped and the record cleared; a plain walk goes on from there.
 * Either way the garden lands where one uncapped replay lands; the capped one also leaves its stop-day checkpoints,
 * pure folds like the version upgrade's cursor rows.
 *
 * A record past the last simulated day needs no replay: the walk forward reads that day fresh.
 */
async function replayStep(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  now: Date,
  current: GardenSnapshot,
  opts?: GardenAdvanceOptions,
): Promise<GardenSimResult> {
  const account = await loadAccountState(db, userId);
  if (isRestoring(account)) return standDown(db, userId, prefs, now);
  const recorded = account?.gardenChangedFrom ?? null;
  const seq = account?.gardenChangedSeq ?? 0;
  const shown = current.state.lastSimulatedDate;
  if (recorded === null || recorded > shown) {
    if (recorded !== null) await settleReplayFrom(db, userId, seq, null);
    return walkOn(db, userId, prefs, now, current, opts);
  }

  // The newest checkpoint before the recorded day (one row, not every checkpoint's snapshot).
  const [checkpoint] = await db
    .select()
    .from(gardenSnapshots)
    .where(and(eq(gardenSnapshots.userId, userId), lte(gardenSnapshots.date, addDays(recorded, -1))))
    .orderBy(desc(gardenSnapshots.date))
    .limit(1);
  const startSnapshot = checkpoint
    ? (checkpoint.snapshot as unknown as GardenSnapshot)
    : initialSnapshot(current.state.createdDate);
  const restartAfter = checkpoint ? checkpoint.date : startSnapshot.state.lastSimulatedDate;
  const maxDays = opts?.maxResimDays;

  // Drop the derived rows the walk will rebuild. Safe without a transaction: garden_state is untouched until the
  // walk below has passed the day it shows, and the record (written before this) brings the next walk back here.
  await purgeDerived(db, userId, restartAfter, maxDays === undefined ? null : addDays(restartAfter, maxDays));

  const walk = await walkForward(
    db,
    userId,
    prefs,
    startSnapshot,
    todayInZone(prefs.timezone, now),
    nowInstant(now),
    maxDays === undefined ? {} : { maxDays, checkpointAtCap: true },
  );
  const stop = walk.snapshot.state.lastSimulatedDate;
  const result = { simulatedDays: walk.simulatedDays, eventsEmitted: walk.eventsEmitted, lastSimulatedDate: stop };
  // A restore began during the walk: it owns the account now (persist refuses; the record is its to clear).
  if (walk.halted) return { ...result, resimPending: true };
  if (walk.capped && stop < shown) {
    await settleReplayFrom(db, userId, seq, addDays(stop, 1));
    return { ...result, resimPending: true };
  }
  if (maxDays !== undefined) await purgeDerived(db, userId, stop, null);
  // Only now — once the walk has passed the day garden_state shows — does the durable garden pointer move. If the
  // walk throws above, garden_state (and its simulationVersion) stays exactly as it was (C21), and the record brings
  // the next walk back to the checkpoint before the changed day.
  await persistSnapshot(db, userId, walk.snapshot);
  await settleReplayFrom(db, userId, seq, null);
  return walk.capped ? { ...result, resimPending: true } : result;
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
  /** Dew this morning (option C, 0020): a settled night on a tended garden.
   * The forecast speaks for it; the scene reads it from the snapshot itself. */
  dewToday: boolean;
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
  todayShield?: { adventureFrozen: boolean; graceDay: boolean; dewToday?: boolean };
}> {
  const gapDays = daysBetween(snapshot.state.lastSimulatedDate, today);
  if (gapDays < 1 || gapDays > 14) return { snapshot, events: [], todayInput: null };
  try {
    let cursor = snapshot;
    let events: GardenEvent[] = [];
    let todayInput: GardenDayInput | null = null;
    let todayShield: { adventureFrozen: boolean; graceDay: boolean; dewToday?: boolean } | undefined;
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
  // A restore is replacing the account (B2): the read still answers, from
  // whatever is there, but heals and ledgers nothing.
  const restoring = await restoreInProgress(db, userId);
  // One capped step (cron reliability, part 4): a garden read walked a pending replay, a version rebuild or a
  // post-restore catch-up whole — weeks of days in one request. What it leaves stays on record for the next read or
  // cron; what this read renders is garden_state, which a replay behind it does not move (and the preview below folds
  // from it), so the page shows what it showed before the replay began until the walk has passed it.
  await advanceGarden(db, userId, prefs, new Date(), REQUEST_GARDEN_STEP).catch(() => undefined);
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
  if (missing.length > 0 && !restoring) {
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
      settledNight:
        (r.input as { settledNight?: boolean }).settledNight ??
        (r.input as { dew?: boolean }).dew,
    }));
    todayVisitor = visitorForDate(today, snapshot.state.season, dayRuns);
    if (todayVisitor && !restoring) {
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
          gardenSees(a) &&
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
  // Dew: same sourcing rule as the adventure shield (C11) — the fold's own
  // flag when the preview ran, the committed state's lastDewDate otherwise.
  const dewToday =
    todayShield?.dewToday ?? snapshot.state.lastDewDate === today;
  const runDecayPausedToday =
    snapshot.state.restMode ||
    frozenToday ||
    graceDay ||
    dewToday ||
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
      .where(and(eq(activities.userId, userId), eq(activities.sport, "run"), gardenSeesSql()))
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
    dewToday,
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
