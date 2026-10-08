/**
 * THE PROGRESS TILES (Phase 2d Task 3; spec §2d "Progress", mocks §8): for the Activity page, from logged sessions
 * of every source —
 *
 *  - a condition trend per switched-on profile (before vs after over eight weeks, flare days by the profile's own
 *    rule, `insufficient_data` below four paired sessions), labelled by the profile registry;
 *  - weekly strength volume (weight × reps, both sides of a one-sided move);
 *  - each core lift of the current block: its top set per week, its best as typed, labelled in the unit last used.
 *
 * Every number is a `MetricResult` from @rg/analytics. Every read is WINDOWED to those eight weeks (sessions by
 * their day, their loaded sets by id, checks by day), so a request costs what the window holds, never what the
 * history holds — a few statements however long the account has logged. One physical session counts once: an
 * activity's sessions go through `sessionPerActivity`, the feed's own rule.
 */
import { and, asc, eq, gt, gte, inArray, lte, ne } from "drizzle-orm";
import { conditionChecks, performedSessions, performedSets, programs } from "@rg/database";
import {
  conditionTrend,
  liftTopSets,
  PROGRESS_WEEKS,
  weeklyStrengthVolume,
  type ConditionReading,
  type ConditionTrendValue,
  type LiftTopSetsValue,
  type LoggedLoadSet,
  type MetricResult,
  type StrengthSession,
  type WeeklyVolumeValue,
} from "@rg/analytics";
import { addDays, startOfIsoWeek, type LocalDate, type WeightUnit } from "@rg/domain";
import { CORE_FAMILIES, EXERCISES, isProfileId, profileById } from "@rg/exercise-library";
import { activeProfileIds } from "./condition-views.js";
import { chunkIds, type Db } from "./db.js";
import { loadProgramState } from "./engine-inputs.js";
import { exerciseDisplayName, readingsBySession, sessionPerActivity } from "./logged-sets.js";
import { PENDING_HASH } from "./watch-sets.js";

export interface ProgressDto {
  /** The athlete's weight unit: what the volume tile speaks. */
  weightUnit: WeightUnit;
  /** One per switched-on profile the registry knows, labelled by the profile (`check.label`). */
  conditions: Array<{ profileId: string; label: string; trend: MetricResult<ConditionTrendValue> }>;
  volume: MetricResult<WeeklyVolumeValue>;
  /** The current block's core lifts, in family order; none without a block. */
  lifts: Array<{ exerciseId: string; name: string; trend: MetricResult<LiftTopSetsValue> }>;
}

let canonicalIds: Map<string, string> | null = null;
/** A library move's id from any id it has had (`legacyIds`), so an old log still counts for its lift. */
function canonical(id: string): string {
  if (canonicalIds === null) {
    canonicalIds = new Map();
    for (const e of EXERCISES) for (const legacy of e.legacyIds) if (!canonicalIds.has(legacy)) canonicalIds.set(legacy, e.id);
    for (const e of EXERCISES) canonicalIds.set(e.id, e.id);
  }
  return canonicalIds.get(id) ?? id;
}

const FAMILY_ORDER = new Map(CORE_FAMILIES.map((f, i) => [f.id, i]));

/** The core lifts of each active adaptive program's latest block, in family order; a damaged block gives none. */
async function coreLifts(db: Db, userId: string): Promise<string[]> {
  const active = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.kind, "adaptive"), eq(programs.status, "active")))
    .orderBy(asc(programs.createdAt), asc(programs.id));
  const out: string[] = [];
  for (const p of active) {
    const block = await loadProgramState(db, p.id).catch(() => null);
    if (!block) continue;
    const families = Object.keys(block.core).sort(
      (a, b) => (FAMILY_ORDER.get(a) ?? FAMILY_ORDER.size) - (FAMILY_ORDER.get(b) ?? FAMILY_ORDER.size) || a.localeCompare(b),
    );
    for (const f of families) {
      const id = block.core[f];
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

export async function loadProgress(db: Db, userId: string, today: LocalDate, weightUnit: WeightUnit): Promise<ProgressDto> {
  const first = addDays(startOfIsoWeek(today), -7 * (PROGRESS_WEEKS - 1));

  const [sessionRows, checkRows, profiles, lifts] = await Promise.all([
    db
      .select({
        id: performedSessions.id,
        activityId: performedSessions.activityId,
        workoutId: performedSessions.workoutId,
        source: performedSessions.source,
        localDate: performedSessions.localDate,
        startedAt: performedSessions.startedAt,
        createdAt: performedSessions.createdAt,
      })
      .from(performedSessions)
      .where(
        and(
          eq(performedSessions.userId, userId),
          gte(performedSessions.localDate, first),
          lte(performedSessions.localDate, today),
          // Mid-write: not there yet.
          ne(performedSessions.payloadHash, PENDING_HASH),
        ),
      ),
    // The window's checks: every session's own, the sheet pre-checks of its slots (same day), and the daily ones.
    db
      .select({
        id: conditionChecks.id,
        profileId: conditionChecks.profileId,
        kind: conditionChecks.kind,
        value: conditionChecks.value,
        feelingOff: conditionChecks.feelingOff,
        localDate: conditionChecks.localDate,
        at: conditionChecks.at,
        performedSessionId: conditionChecks.performedSessionId,
        workoutId: conditionChecks.workoutId,
      })
      .from(conditionChecks)
      .where(and(eq(conditionChecks.userId, userId), gte(conditionChecks.localDate, first), lte(conditionChecks.localDate, today))),
    activeProfileIds(db, userId),
    coreLifts(db, userId),
  ]);

  // One physical session once: the activity's own record over the watch's copy (the feed's rule).
  const sessions = [...sessionPerActivity(sessionRows).values(), ...sessionRows.filter((s) => !s.activityId)];

  const setRows = (
    await Promise.all(
      chunkIds(sessions.map((s) => s.id)).map((ids) =>
        db
          .select({
            performedSessionId: performedSets.performedSessionId,
            exerciseId: performedSets.exerciseId,
            reps: performedSets.reps,
            loadValue: performedSets.loadValue,
            loadUnit: performedSets.loadUnit,
            loadKg: performedSets.loadKg,
            perSide: performedSets.perSide,
            side: performedSets.side,
          })
          .from(performedSets)
          .where(and(inArray(performedSets.performedSessionId, ids), eq(performedSets.done, true), gt(performedSets.loadKg, 0)))
          .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex)),
      ),
    )
  ).flat();
  const setsBySession = new Map<string, LoggedLoadSet[]>();
  for (const r of setRows) {
    if (r.loadKg === null || !(r.loadKg > 0)) continue;
    const typedUnit = r.loadUnit === "lb" || r.loadUnit === "kg" ? r.loadUnit : null;
    const list = setsBySession.get(r.performedSessionId) ?? [];
    list.push({
      exerciseId: canonical(r.exerciseId),
      reps: r.reps,
      // As typed; a row with no typed weight (none should exist) speaks its stored kilograms.
      load: typedUnit && r.loadValue !== null && r.loadValue > 0 ? { v: r.loadValue, u: typedUnit } : { v: r.loadKg, u: "kg" },
      kg: r.loadKg,
      perSide: r.perSide,
      side: r.side === "left" || r.side === "right" ? r.side : null,
    });
    setsBySession.set(r.performedSessionId, list);
  }
  const strength: StrengthSession[] = sessions.map((s) => ({ date: s.localDate, startedAt: s.startedAt, sets: setsBySession.get(s.id) ?? [] }));

  const readings = readingsBySession(sessions, checkRows);
  const conditions = profiles.filter(isProfileId).map((profileId) => {
    const profile = profileById(profileId);
    const daily: ConditionReading[] = checkRows
      .filter((c) => c.profileId === profileId && (c.kind === "pre" || c.kind === "daily"))
      .map((c) => ({ date: c.localDate, value: c.value, feelingOff: c.feelingOff }));
    const trend = conditionTrend(
      {
        sessions: sessions.map((s) => {
          const r = readings.get(s.id)?.get(profileId);
          return { date: s.localDate, pre: r?.pre ?? null, post: r?.post ?? null };
        }),
        readings: daily,
        isFlare: (reading) => profile.flare(reading),
      },
      today,
    );
    return { profileId, label: profile.check.label, trend };
  });

  return {
    weightUnit,
    conditions,
    volume: weeklyStrengthVolume(strength, today),
    lifts: lifts.map((exerciseId) => ({ exerciseId, name: exerciseDisplayName(exerciseId), trend: liftTopSets(strength, exerciseId, today) })),
  };
}
