/**
 * Fixture mode only (stream H, the e2e of the coach's opening line): what the coach notices, put in the account as the
 * app would have it — last week's review as the Monday cron writes it (`weekly_reviews`, its narrative given), and a
 * run finished this morning as a watch import lands it (`activities`, with its time in each heart-rate zone). Both a
 * minute old, so any ask the journey makes comes after them. Synthetic, never sent anywhere, no model call.
 */
import { activities, weeklyReviews } from "@rg/database";
import { addDays, newId, startOfIsoWeek, type LocalDate } from "@rg/domain";
import type { Db } from "./db.js";

export interface CoachNoticesSeed {
  /** Last week's review's narrative. */
  review?: string;
  /** A run this morning: its distance, its time, and its seconds in zones 1–5. */
  run?: { meters: number; seconds: number; zones?: number[] };
}

/** The body as the lever takes it: anything else is left out (null: nothing to seed). */
export function parseCoachNoticesSeed(body: unknown): CoachNoticesSeed | null {
  const b = (body ?? {}) as { review?: unknown; run?: { meters?: unknown; seconds?: unknown; zones?: unknown } };
  const review = typeof b.review === "string" && b.review.length <= 2_000 ? b.review.trim() || undefined : undefined;
  const r = b.run;
  const run =
    r && typeof r.meters === "number" && r.meters > 0 && r.meters <= 100_000 && typeof r.seconds === "number" && r.seconds >= 60 && r.seconds <= 36_000
      ? {
          meters: r.meters,
          seconds: r.seconds,
          ...(Array.isArray(r.zones) && r.zones.length === 5 && r.zones.every((z) => typeof z === "number" && z >= 0) ? { zones: r.zones as number[] } : {}),
        }
      : undefined;
  return review || run ? { ...(review ? { review } : {}), ...(run ? { run } : {}) } : null;
}

export async function seedCoachNotices(db: Db, userId: string, today: LocalDate, now: Date, seed: CoachNoticesSeed): Promise<{ weekStart?: string; activityId?: string }> {
  const at = new Date(now.getTime() - 60_000).toISOString();
  const out: { weekStart?: string; activityId?: string } = {};
  if (seed.review) {
    const weekStart = addDays(startOfIsoWeek(today), -7);
    await db
      .insert(weeklyReviews)
      .values({ id: newId(), userId, weekStart, facts: {}, narrative: seed.review, llmModel: "fixture", llmCostMicros: 0, createdAt: at })
      .onConflictDoUpdate({ target: [weeklyReviews.userId, weeklyReviews.weekStart], set: { narrative: seed.review, createdAt: at } });
    out.weekStart = weekStart;
  }
  if (seed.run) {
    const id = `fx-notices-${today}-${newId().slice(0, 8)}`;
    const { meters, seconds, zones } = seed.run;
    await db.insert(activities).values({
      id,
      userId,
      source: "coros",
      startTime: `${today}T14:00:00Z`,
      startTimeLocal: `${today}T07:00:00`,
      sport: "run",
      durationSeconds: seconds,
      elapsedSeconds: seconds,
      distanceMeters: meters,
      avgPaceSecPerKm: seconds / (meters / 1000),
      title: "Morning Run",
      telemetry: zones ? { hrZones: zones.map((s, i) => ({ lo: 100 + i * 15, hi: 115 + i * 15, seconds: s })) } : null,
      sourceMergeConfidence: 1,
      createdAt: at,
      updatedAt: at,
    });
    out.activityId = id;
  }
  return out;
}
