import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { activities, coachPlans, coachPlanWeeks, coachRuns, plannedWorkouts } from "@rg/database";
import { addDays, QUALITY_SUBTYPE_LABELS, type LocalDate, type QualitySubtype, type UserPreferences } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { isLoosePlan } from "./coach-plans.js";
import { COMEBACK_GAP_DAYS, FIRM_HORIZON_DAYS, PLAN_ENDING_DAYS, REFIRE_WINDOW_MS } from "./coach-triggers.js";

/**
 * THE COACH'S "NEEDS YOU" CHIPS (§8 §6). The thread coach used to turn its free signals into paid wakes: a trigger row
 * marked, a Plan visit woke it. It has stepped back (`THREAD_COACH`), and its signals are now chips on the coach's
 * opening screen — computed when the screen asks, from the old trigger rules, writing nothing. A tap sends the chip's
 * `request` as the athlete's words, and that is the only spend.
 *
 * In order, at most `NUDGES_MAX`:
 *   1. a session missed in the last 2 days (missed, skipped by the athlete, or asked about and unanswered) — "Rework my
 *      week around Tuesday's tempo";
 *   2. back after a gap of a week or more (the latest activity in the last 2 days) — "Ease me back in";
 *   3. a running plan's next outline week starting within 14 days — "Fill in next week of my 10K plan" (the outline is
 *      what the coach fills in; nothing else will now);
 *   4. a race within 21 days (Settings' race day, else a running plan's) — "Get me ready for race day";
 *   5. a running plan ending within 21 days — "Plan what comes after my half marathon plan".
 * The pressing first: what just happened, then what the plan needs to keep going, then what is coming.
 *
 * A chip the athlete already asked in the last three days (its label in the words of one of their own runs: a request
 * whose day count moved since still counts) stays away, and the next one takes its place: never the same nudge twice
 * while the coach is working on it.
 *
 * Cost: at most five statements, three on a quiet account (the missed sessions, the activities, the plans; their outline
 * weeks only with a running plan; the athlete's recent asks only with a chip to offer). Every text here is the app's,
 * or a plan's name — data, which the screen renders as text.
 */
export interface CoachNudge {
  /** Stable while its condition holds: `<kind>:<subject>`. */
  id: string;
  /** The chip's words. */
  label: string;
  /** What a tap sends, as the athlete's words. */
  request: string;
}

/** The most chips the opening screen shows (they come before its general starters). */
export const NUDGES_MAX = 2;
/** A session missed this many days back, or nearer, is still worth reworking the week around. */
export const NUDGE_MISSED_DAYS = 2;
/** A race this many days out, or nearer. */
export const NUDGE_RACE_DAYS = 21;
/** How recent the comeback's return must be (the old trigger's own window). */
const COMEBACK_FRESH_DAYS = 2;
/** The athlete's asks read back for the "already asked" rule, at most (three days of a heavy user's are fewer). */
const RECENT_ASKS_MAX = 50;

/** States a past session is missed in: the athlete said so, skipped it, or was asked and has not answered. */
const MISSED_STATES = ["missed", "skipped", "unresolved"];

/** How a plan is named in the athlete's words: "my 10K plan" — never "my Base plan plan". */
export function planPhrase(name: string): string {
  const n = name.trim();
  return /\bplan$/i.test(n) ? `my ${n}` : `my ${n} plan`;
}

/** A local date's weekday, the same in every zone (it is a calendar date, read at its own noon). */
function weekdayOf(date: LocalDate): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A session's kind in plain words, as a sentence names it: "tempo", "long run", "strength session". */
function sessionNoun(w: { category: string; qualitySubtype: string | null; sport: string }): string {
  if (w.category === "quality") {
    const sub = w.qualitySubtype;
    return sub && sub !== "other" && sub in QUALITY_SUBTYPE_LABELS ? lowerFirst(QUALITY_SUBTYPE_LABELS[sub as QualitySubtype]) : "quality session";
  }
  switch (w.category) {
    case "easy":
      return "easy run";
    case "long":
      return "long run";
    case "recovery":
      return "recovery run";
    case "race":
      return "race";
    case "strength":
      return "strength session";
    case "yoga":
      return "mobility session";
    case "cross_training":
      return "cross-training";
    default:
      return w.sport === "strength" ? "strength session" : "run";
  }
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "in 12 days", "tomorrow", "today". */
function inDays(days: number): string {
  return days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

const daysBetween = (from: LocalDate, to: LocalDate): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export async function readNudges(db: Db, userId: string, prefs: UserPreferences, today: LocalDate, now: Date): Promise<CoachNudge[]> {
  const [missedRows, recent, plans] = await Promise.all([
    db
      .select({
        id: plannedWorkouts.id,
        date: plannedWorkouts.effectiveDate,
        category: plannedWorkouts.category,
        qualitySubtype: plannedWorkouts.qualitySubtype,
        sport: plannedWorkouts.sport,
        sanctionedBy: plannedWorkouts.sanctionedBy,
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          inArray(plannedWorkouts.completionState, MISSED_STATES),
          gte(plannedWorkouts.effectiveDate, addDays(today, -NUDGE_MISSED_DAYS)),
          lte(plannedWorkouts.effectiveDate, today),
          isNull(plannedWorkouts.archivedAt),
        ),
      )
      .orderBy(desc(plannedWorkouts.effectiveDate), plannedWorkouts.effectiveTime),
    // The old comeback rule's own read: the two latest activities up to today.
    db
      .select({ startTimeLocal: activities.startTimeLocal, startTime: activities.startTime })
      .from(activities)
      .where(and(eq(activities.userId, userId), lte(activities.startTime, `${addDays(today, 1)}T00:00:00Z`)))
      .orderBy(desc(activities.startTime))
      .limit(2),
    db
      .select({ id: coachPlans.id, name: coachPlans.name, endDate: coachPlans.endDate, raceDate: coachPlans.raceDate })
      .from(coachPlans)
      .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"))),
  ]);
  // A bucket of one-offs is no plan: it has no weeks, and is forever "ending" on its last one-off.
  const blocks = plans.filter((p) => !isLoosePlan(p)).sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0));

  const found: CoachNudge[] = [];

  // 1. Missed: the coach's own skip is planned rest, and a rest day is nothing to miss.
  const missed = missedRows.filter((w) => w.category !== "rest" && w.sanctionedBy !== "coach");
  if (missed.length > 0) {
    const named = missed.slice(0, 3).map((w) => `${w.date === today ? "today" : weekdayOf(w.date)}'s ${sessionNoun(w)}`);
    found.push(
      missed.length === 1
        ? { id: `missed:${missed[0]!.id}`, label: `Rework my week around ${named[0]}`, request: `I missed ${named[0]}. Rework my week around it.` }
        : { id: `missed:${missed[0]!.id}`, label: "Rework my week around the sessions I missed", request: `I missed ${listed(named)}. Rework my week around them.` },
    );
  }

  // 2. Back: the latest activity is fresh and follows a gap of a week or more.
  if (recent.length === 2) {
    const backOn = (recent[0]!.startTimeLocal ?? recent[0]!.startTime).slice(0, 10);
    const before = (recent[1]!.startTimeLocal ?? recent[1]!.startTime).slice(0, 10);
    const gap = daysBetween(before, backOn);
    if (backOn >= addDays(today, -COMEBACK_FRESH_DAYS) && gap >= COMEBACK_GAP_DAYS) {
      found.push({ id: `comeback:${backOn}`, label: "Ease me back in", request: `I'm back after ${gap} days away. Ease me back in.` });
    }
  }

  // 3. The next outline week: one still running, or starting within the horizon, of a plan still running.
  if (blocks.length > 0) {
    const weeks = [];
    for (const ids of chunkIds(blocks.map((p) => p.id))) {
      weeks.push(
        ...(await db
          .select({ planId: coachPlanWeeks.planId, weekStart: coachPlanWeeks.weekStart })
          .from(coachPlanWeeks)
          .where(
            and(
              inArray(coachPlanWeeks.planId, ids),
              eq(coachPlanWeeks.state, "shape"),
              gte(coachPlanWeeks.weekStart, addDays(today, -6)),
              lte(coachPlanWeeks.weekStart, addDays(today, FIRM_HORIZON_DAYS)),
            ),
          )
          .orderBy(coachPlanWeeks.weekStart)),
      );
    }
    const next = weeks[0];
    const plan = next ? blocks.find((p) => p.id === next.planId) : undefined;
    if (next && plan) {
      const which = next.weekStart <= today ? "this week" : "next week";
      const words = `Fill in ${which} of ${planPhrase(plan.name)}`;
      found.push({ id: `horizon:${plan.id}`, label: words, request: `${words}.` });
    }
  }

  // 4. The race: Settings' race day first (the race strip's), else the nearest a running plan holds.
  const inWindow = (d: string | null | undefined): d is string => !!d && d >= today && d <= addDays(today, NUDGE_RACE_DAYS);
  const raceDate = inWindow(prefs.raceDate)
    ? prefs.raceDate
    : (plans
        .map((p) => p.raceDate)
        .filter(inWindow)
        .sort()[0] ?? null);
  if (raceDate) {
    found.push({
      id: `race:${raceDate}`,
      label: "Get me ready for race day",
      request: `My race is ${inDays(daysBetween(today, raceDate))}. Get me ready for race day.`,
    });
  }

  // 5. A plan ending: the soonest.
  const ending = blocks.find((p) => p.endDate >= today && p.endDate <= addDays(today, PLAN_ENDING_DAYS));
  if (ending) {
    const phrase = planPhrase(ending.name);
    found.push({
      id: `ending:${ending.id}`,
      label: `Plan what comes after ${phrase}`,
      request: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} ends ${inDays(daysBetween(today, ending.endDate))}. Plan what comes after it.`,
    });
  }

  if (found.length === 0) return [];
  // Already asked: the athlete's own runs (never a sub-run's brief) of the last three days, read once.
  const asked = await db
    .select({ request: coachRuns.request })
    .from(coachRuns)
    .where(
      and(
        eq(coachRuns.userId, userId),
        isNull(coachRuns.parentId),
        gte(coachRuns.createdAt, new Date(now.getTime() - REFIRE_WINDOW_MS).toISOString()),
      ),
    )
    .orderBy(desc(coachRuns.createdAt))
    .limit(RECENT_ASKS_MAX);
  const words = asked.map((r) => (r.request ?? "").toLowerCase());
  return found.filter((n) => !words.some((w) => w.includes(n.label.toLowerCase()))).slice(0, NUDGES_MAX);
}
