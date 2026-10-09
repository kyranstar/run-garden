/**
 * READ-ONLY: has the garden lost credit it was owed? (cron reliability, part 3)
 *
 * Before the replay was put on record (`recordReplayFrom`), an invocation killed inside `resimulateFrom` — the
 * half-hourly sweep's, on the free plan, Oct 3–7 — could leave the garden without a late activity's credit, in one of
 * three shapes, all of which this finds:
 *  - the day's stored input without it (killed before the walk reached that day, or never replayed at all);
 *  - simulated days with no stored input at all (the replay purged them and died before rewriting them);
 *  - every input right but `garden_state` never moved (killed after the walk, before or inside its persist): only a
 *    fold of the stored inputs from genesis sees that one (`fold`, opt-in — it costs one simulated day per day).
 *
 * Credit is what `buildDayInput` puts in a day's input: a completed slot (and the activity matched to it) as a
 * `completedRuns` entry under the slot's id on its day; an unmatched run, lift or yoga session as one under
 * `unplanned-<activity id>` on its own local day; any other unmatched sport as an `adventures` entry on its day. The
 * expected entries are derived here from the tables in a handful of reads (not one `buildDayInput` per day), the same
 * rules — the garden sees no imported history and no app session before APP_SESSION_EPOCH.
 *
 * Answers counts and dates only: no titles, no ids. `replayFrom` is the day a replay must start from to heal all of
 * it — put it on record (`recordReplayFrom`) and the next hourly, sweep or garden read replays from it.
 */
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import {
  activities,
  accountState,
  gardenDayInputs,
  gardenSnapshots,
  gardenState,
  plannedWorkouts,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, isAdventureSport, type LocalDate } from "@rg/domain";
import { initialSnapshot, simulateDay, type GardenDayInput, type GardenSnapshot } from "@rg/garden-engine";
import type { Db } from "./db.js";
import { gardenSees } from "./garden-sync.js";
import { canonicalJson } from "./account-tables.js";

export interface GardenHoleReport {
  /** The simulated days, genesis through `garden_state`'s last; null when the account has no garden. */
  simulated: { from: LocalDate; through: LocalDate; days: number } | null;
  /** The days the per-day checks covered (`opts.from` narrows the start). */
  checkedFrom: LocalDate | null;
  /** A replay already on record (it heals itself on the next walk), or null. */
  replayPending: LocalDate | null;
  /** Simulated days with no stored day input. */
  dayInputGaps: { count: number; dates: LocalDate[] };
  /** Completed slots and unmatched runs, lifts and yoga sessions the garden owes credit to, and those whose day's
   * input lacks it (a day with no input counts here too). */
  sessions: { checked: number; missing: number; dates: LocalDate[] };
  /** Unmatched sessions of the other sports (adventures), counted per day and sport. */
  adventures: { checked: number; missing: number; dates: LocalDate[] };
  /** With `fold`: the stored inputs folded from genesis, against every stored checkpoint and `garden_state`. */
  fold?: {
    checked: true;
    matchesState: boolean;
    /** The first checkpoint the fold disagrees with. */
    firstMismatchCheckpoint: LocalDate | null;
    /** The fold could not go on: this simulated day has no stored input. */
    stoppedAtGap: LocalDate | null;
  };
  /** The earliest day a replay must start from to heal everything above; null when nothing needs it. */
  replayFrom: LocalDate | null;
}

const localDay = (a: { startTime: string; startTimeLocal: string | null }): LocalDate =>
  (a.startTimeLocal ?? a.startTime).slice(0, 10);

const sorted = (dates: Iterable<LocalDate>): LocalDate[] => [...new Set(dates)].sort();

/** A snapshot as the database holds it (JSON drops `undefined` keys), keys sorted — for comparing a fold to a row. */
const asStored = (snapshot: unknown): string => canonicalJson(JSON.parse(JSON.stringify(snapshot)));

export async function findGardenHoles(
  db: Db,
  userId: string,
  opts: { fold?: boolean; from?: LocalDate } = {},
): Promise<GardenHoleReport> {
  const [record] = await db
    .select({ from: accountState.gardenChangedFrom })
    .from(accountState)
    .where(eq(accountState.userId, userId))
    .limit(1);
  const replayPending = record?.from ?? null;
  const [state] = await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  if (!state) {
    return {
      simulated: null,
      checkedFrom: null,
      replayPending,
      dayInputGaps: { count: 0, dates: [] },
      sessions: { checked: 0, missing: 0, dates: [] },
      adventures: { checked: 0, missing: 0, dates: [] },
      replayFrom: null,
    };
  }
  const snapshot = state.snapshot as unknown as GardenSnapshot;
  const genesis = snapshot.state.createdDate;
  const last = snapshot.state.lastSimulatedDate;
  const from = opts.from !== undefined && opts.from > genesis ? opts.from : genesis;
  const days: LocalDate[] = [];
  for (let d = genesis; d <= last; d = addDays(d, 1)) days.push(d);

  // The stored inputs: from genesis when folding, else from where the checks start.
  const inputRows = await db
    .select({ date: gardenDayInputs.date, input: gardenDayInputs.input })
    .from(gardenDayInputs)
    .where(and(eq(gardenDayInputs.userId, userId), gte(gardenDayInputs.date, opts.fold ? genesis : from), lte(gardenDayInputs.date, last)));
  const inputs = new Map(inputRows.map((r) => [r.date, r.input as unknown as GardenDayInput]));
  const gaps = days.filter((d) => d >= from && !inputs.has(d));

  // Owed: completed slots in range (unless their activity is one the garden does not see)…
  const slots = await db
    .select({ id: plannedWorkouts.id, date: plannedWorkouts.effectiveDate })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "completed"),
        isNull(plannedWorkouts.archivedAt),
        gte(plannedWorkouts.effectiveDate, from),
        lte(plannedWorkouts.effectiveDate, last),
      ),
    );
  const matchedActivities = await db
    .select({
      workoutId: workoutCompletionMatches.workoutId,
      source: activities.source,
      startTime: activities.startTime,
      startTimeLocal: activities.startTimeLocal,
    })
    .from(workoutCompletionMatches)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutCompletionMatches.workoutId))
    .innerJoin(activities, eq(activities.id, workoutCompletionMatches.activityId))
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "completed"),
        isNull(workoutCompletionMatches.undoneAt),
        gte(plannedWorkouts.effectiveDate, from),
        lte(plannedWorkouts.effectiveDate, last),
      ),
    );
  const unseenSlots = new Set(matchedActivities.filter((m) => !gardenSees(m)).map((m) => m.workoutId));
  const owed: Array<{ date: LocalDate; workoutId: string }> = slots
    .filter((s) => !unseenSlots.has(s.id))
    .map((s) => ({ date: s.date, workoutId: s.id }));

  // …and the unmatched sessions on their own local day (the same ±1-day UTC window buildDayInput reads).
  const acts = (
    await db
      .select({
        id: activities.id,
        sport: activities.sport,
        source: activities.source,
        startTime: activities.startTime,
        startTimeLocal: activities.startTimeLocal,
      })
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          isNull(activities.completionMatchId),
          gte(activities.startTime, `${addDays(from, -1)}T00:00:00`),
          lte(activities.startTime, `${addDays(last, 2)}T00:00:00`),
        ),
      )
  ).filter((a) => gardenSees(a) && localDay(a) >= from && localDay(a) <= last);
  const adventuresOwed = new Map<string, number>(); // `${date}|${sport}` → count
  for (const a of acts) {
    if (a.sport === "run" || a.sport === "strength" || a.sport === "yoga") {
      owed.push({ date: localDay(a), workoutId: `unplanned-${a.id}` });
    } else if (isAdventureSport(a.sport)) {
      const key = `${localDay(a)}|${a.sport}`;
      adventuresOwed.set(key, (adventuresOwed.get(key) ?? 0) + 1);
    }
  }

  const missingSessions: LocalDate[] = [];
  for (const o of owed) {
    const input = inputs.get(o.date);
    if (!input || !input.completedRuns.some((r) => r.workoutId === o.workoutId)) missingSessions.push(o.date);
  }
  let adventuresChecked = 0;
  let adventuresMissing = 0;
  const missingAdventureDays: LocalDate[] = [];
  for (const [key, count] of adventuresOwed) {
    const [date, sport] = key.split("|") as [LocalDate, string];
    adventuresChecked += count;
    const stored = (inputs.get(date)?.adventures ?? []).filter((x) => x.sport === sport).length;
    if (stored < count) {
      adventuresMissing += count - stored;
      missingAdventureDays.push(date);
    }
  }

  let fold: GardenHoleReport["fold"];
  let foldReplayFrom: LocalDate | null = null;
  if (opts.fold) {
    const checkpoints = new Map(
      (
        await db
          .select({ date: gardenSnapshots.date, snapshot: gardenSnapshots.snapshot })
          .from(gardenSnapshots)
          .where(and(eq(gardenSnapshots.userId, userId), lte(gardenSnapshots.date, last)))
          .orderBy(asc(gardenSnapshots.date))
      ).map((c) => [c.date, c.snapshot]),
    );
    let folded = initialSnapshot(genesis);
    let lastAgreed: LocalDate | null = null;
    let firstMismatchCheckpoint: LocalDate | null = null;
    let stoppedAtGap: LocalDate | null = null;
    for (const d of days) {
      const input = inputs.get(d);
      if (!input) {
        stoppedAtGap = d;
        break;
      }
      folded = simulateDay(folded, input).snapshot;
      const checkpoint = checkpoints.get(d);
      if (checkpoint === undefined || firstMismatchCheckpoint !== null) continue;
      if (asStored(checkpoint) === asStored(folded)) lastAgreed = d;
      else firstMismatchCheckpoint = d;
    }
    const matchesState = stoppedAtGap === null && asStored(folded) === asStored(snapshot);
    fold = { checked: true, matchesState, firstMismatchCheckpoint, stoppedAtGap };
    // A replay restarts from the newest checkpoint before its day: start it after the last one the fold agrees with.
    if (!matchesState) foldReplayFrom = lastAgreed !== null ? addDays(lastAgreed, 1) : genesis;
  }

  const candidates = [gaps[0], sorted(missingSessions)[0], sorted(missingAdventureDays)[0], foldReplayFrom].filter(
    (d): d is LocalDate => typeof d === "string",
  );
  return {
    simulated: { from: genesis, through: last, days: days.length },
    checkedFrom: from,
    replayPending,
    dayInputGaps: { count: gaps.length, dates: gaps },
    sessions: { checked: owed.length, missing: missingSessions.length, dates: sorted(missingSessions) },
    adventures: { checked: adventuresChecked, missing: adventuresMissing, dates: sorted(missingAdventureDays) },
    ...(fold ? { fold } : {}),
    replayFrom: candidates.length > 0 ? candidates.sort()[0]! : null,
  };
}
