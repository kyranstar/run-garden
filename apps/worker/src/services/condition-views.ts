/**
 * CONDITION PROFILES AS THE UI SHOWS THEM (Phase 2a Tasks 6–8). The UI holds no condition words of its own: every
 * label it prints — the Today chip, the check sheet, the session pre-check, the care block, the care switch — comes
 * from the profile, through these views.
 */
import { and, eq, inArray } from "drizzle-orm";
import { conditionChecks, programs, userConditions } from "@rg/database";
import { isProfileId, profileById } from "@rg/exercise-library";
import type { Db } from "./db.js";

/** One switched-on condition profile: its check's label and scale, and its care label (null = no care content). */
export interface ConditionView {
  profileId: string;
  check: { label: string; min: number; max: number };
  care: string | null;
}

/** A profile's reading today: the day's check or a session's pre-check, whichever came last. */
export interface TodayReading {
  value: number | null;
  feelingOff: boolean;
}

export function conditionView(profileId: string): ConditionView {
  const p = profileById(profileId);
  return {
    profileId,
    check: { label: p.check.label, min: p.check.min, max: p.check.max },
    care: p.care?.block.label ?? null,
  };
}

/** The account's switched-on profiles the library knows, sorted by id. */
export async function activeProfileIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ profileId: userConditions.profileId })
    .from(userConditions)
    .where(and(eq(userConditions.userId, userId), eq(userConditions.active, true)));
  return [...new Set(rows.map((r) => r.profileId).filter(isProfileId))].sort();
}

/**
 * The Today card's condition chips: each switched-on profile with today's reading. Dark by data — an account with
 * no active adaptive program gets none, whatever it has switched on.
 */
export async function todayConditions(
  db: Db,
  userId: string,
  today: string,
): Promise<Array<ConditionView & { today: TodayReading | null }>> {
  const [program] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.kind, "adaptive"), eq(programs.status, "active")))
    .limit(1);
  if (!program) return [];
  const active = await activeProfileIds(db, userId);
  if (active.length === 0) return [];
  const rows = await db
    .select()
    .from(conditionChecks)
    .where(
      and(
        eq(conditionChecks.userId, userId),
        eq(conditionChecks.localDate, today),
        inArray(conditionChecks.kind, ["daily", "pre"]),
        inArray(conditionChecks.profileId, active),
      ),
    );
  return active.map((profileId) => {
    const latest = rows
      .filter((r) => r.profileId === profileId)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
    return { ...conditionView(profileId), today: latest ? { value: latest.value, feelingOff: latest.feelingOff } : null };
  });
}
