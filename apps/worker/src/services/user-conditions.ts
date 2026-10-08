/**
 * HEALTH CONDITIONS THE ATHLETE HAS SWITCHED ON (Phase 2 spec §2c "Settings sections"; plan Task 2, Review Focus 5).
 *
 * Every profile the library knows is listed, labelled by the profile (the UI holds no condition words). Switching one
 * on writes `user_conditions` (`${userId}:${profileId}`, as the convention keys it): the first time, `since` is the
 * athlete's today; switched off and on again, `since` keeps that first day. Its rules apply only while it is on —
 * every reader (the build's inputs, the Today chip, the library's safety) reads `active = 1` rows only.
 */
import { and, eq } from "drizzle-orm";
import { userConditions } from "@rg/database";
import { PROFILE_IDS, profileById } from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import type { Db } from "./db.js";
import { RestoreInProgressError } from "./programs.js";

export interface ConditionSetting {
  profileId: string;
  /** The profile's own name ("TMJ"). */
  label: string;
  active: boolean;
  /** The day it was first switched on; null when it never was. */
  since: string | null;
}

export class UnknownConditionError extends Error {
  constructor() {
    super("unknown_profile");
  }
}

export async function listConditions(db: Db, userId: string): Promise<ConditionSetting[]> {
  const rows = await db.select().from(userConditions).where(eq(userConditions.userId, userId));
  return PROFILE_IDS.map((profileId) => {
    const row = rows.find((r) => r.profileId === profileId);
    return { profileId, label: profileById(profileId).label, active: row?.active ?? false, since: row?.since ?? null };
  });
}

/** Switch a profile on or off. A profile never switched on and asked off writes nothing. */
export async function setCondition(
  db: Db,
  userId: string,
  change: { profileId: string; active: boolean },
  ctx: { today: string },
): Promise<ConditionSetting[]> {
  if (!(PROFILE_IDS as readonly string[]).includes(change.profileId)) throw new UnknownConditionError();
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  const [row] = await db
    .select()
    .from(userConditions)
    .where(and(eq(userConditions.userId, userId), eq(userConditions.profileId, change.profileId)))
    .limit(1);
  if (row) {
    if (row.active !== change.active) {
      await db.update(userConditions).set({ active: change.active }).where(eq(userConditions.id, row.id));
    }
  } else if (change.active) {
    await db
      .insert(userConditions)
      .values({ id: `${userId}:${change.profileId}`, userId, profileId: change.profileId, active: true, since: ctx.today, settings: {} })
      // Two taps at once: the second finds the row the first wrote; `since` stays the first day.
      .onConflictDoUpdate({ target: [userConditions.userId, userConditions.profileId], set: { active: true } });
  }
  return listConditions(db, userId);
}
