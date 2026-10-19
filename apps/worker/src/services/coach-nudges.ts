import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { activities, coachPlans, coachPlanWeeks, coachReads, coachRuns, plannedWorkouts, weeklyReviews, workoutCompletionMatches } from "@rg/database";
import { addDays, QUALITY_SUBTYPE_LABELS, startOfIsoWeek, type LocalDate, type QualitySubtype, type UserPreferences } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { isLoosePlan } from "./coach-plans.js";
import { reviewOpening, sessionDays, sessionOpening, type CoachOpeningLine, type FinishedSession } from "./coach-opening-line.js";
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
 * A chip the athlete already asked in the last three days stays away, and the next one takes its place: never the same
 * nudge twice while the coach is working on it — each tap is a paid run (review-1 I3). Every request holds its label and
 * then says what the coach should know ("Plan what comes after my 10K plan — it ends in 12 days."), so "asked" is the
 * label in the words of one of the athlete's own runs, read alike whatever the case, spacing or punctuation (`asWords`):
 * the chip's own request sent counts, one sent yesterday with its count a day off counts, and so does the athlete typing
 * the chip's words themselves.
 *
 * THE OPENING'S OWN LINE (stream H; coach-opening-line.ts words it) comes from the same reads: last week's review (the
 * Monday cron's, already paid for) while the athlete hasn't asked the coach anything since it was written; else the
 * newest session finished today or yesterday (5 minutes or more: a run, a strength or mobility session, or anything that
 * completed a planned session) while they haven't asked anything since it reached the app. A review or a session the
 * athlete has asked the coach about since — any turn of theirs, a chip or their own words — doesn't come back; one this
 * device has already shown (`seen`, the screen's own list) gives way to the next.
 *
 * Cost: at most six statements, four on a quiet account (the missed sessions; the activities — with what each one
 * completed, its logged sets and the coach's read of it, in the same statement; the plans; last week's review; then
 * their outline weeks only with a running plan, and the athlete's recent asks only with a chip or a line to offer).
 * Every text here is the app's, or a plan's name — data, which the screen renders as text.
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
export function sessionNoun(w: { category: string; qualitySubtype: string | null; sport: string }): string {
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

/** Words compared as the athlete's: lower case, any run of punctuation and spacing as one space. */
export function asWords(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** What the opening screen reads: its own line, when the coach noticed something, and the "needs you" chips. */
export interface CoachOpeningRead {
  opening: CoachOpeningLine | null;
  nudges: CoachNudge[];
}

/** An activity this short is a fragment (a walk to the trailhead), never news. */
export const SESSION_MIN_SECONDS = 300;
/** The sports a session is news for on its own; any other only when it completed a planned session. */
const NEWS_SPORTS = new Set(["run", "strength", "yoga"]);

/** The "needs you" chips alone. */
export async function readNudges(db: Db, userId: string, prefs: UserPreferences, today: LocalDate, now: Date): Promise<CoachNudge[]> {
  return (await readCoachOpening(db, userId, prefs, today, now)).nudges;
}

/** The opening screen's read: its own line (none already shown here, `seen`) and the "needs you" chips. */
export async function readCoachOpening(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  today: LocalDate,
  now: Date,
  seen: ReadonlySet<string> = new Set(),
): Promise<CoachOpeningRead> {
  const lastWeek = addDays(startOfIsoWeek(today), -7);
  const [missedRows, recent, plans, reviews] = await Promise.all([
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
    // The old comeback rule's own read: the two latest activities up to today — with, for the opening, what each one
    // completed, the sets logged against it and the coach's read of it, in the same statement.
    db
      .select({
        id: activities.id,
        startTimeLocal: activities.startTimeLocal,
        startTime: activities.startTime,
        arrivedAt: activities.createdAt,
        sport: activities.sport,
        seconds: activities.durationSeconds,
        meters: activities.distanceMeters,
        pace: activities.avgPaceSecPerKm,
        telemetry: activities.telemetry,
        workoutId: plannedWorkouts.id,
        category: plannedWorkouts.category,
        qualitySubtype: plannedWorkouts.qualitySubtype,
        plannedSport: plannedWorkouts.sport,
        glance: coachReads.glance,
        sets: sql<string | null>`(select json_object(
            'done', (select count(*) from performed_sets x where x.performed_session_id = ps.id and x.done = 1),
            'total', (select count(*) from performed_sets x where x.performed_session_id = ps.id),
            'completed', ps.completed)
          from performed_sessions ps where ps.user_id = ${userId} and ps.activity_id = ${activities.id}
          order by case ps.source when 'app' then 0 when 'watch_review' then 1 else 2 end limit 1)`,
      })
      .from(activities)
      .leftJoin(workoutCompletionMatches, and(eq(workoutCompletionMatches.id, activities.completionMatchId), isNull(workoutCompletionMatches.undoneAt)))
      .leftJoin(plannedWorkouts, and(eq(plannedWorkouts.id, workoutCompletionMatches.workoutId), eq(plannedWorkouts.userId, userId)))
      .leftJoin(coachReads, and(eq(coachReads.userId, userId), eq(coachReads.activityId, activities.id), eq(coachReads.status, "done")))
      .where(and(eq(activities.userId, userId), lte(activities.startTime, `${addDays(today, 1)}T00:00:00Z`)))
      .orderBy(desc(activities.startTime))
      .limit(2),
    db
      .select({ id: coachPlans.id, name: coachPlans.name, endDate: coachPlans.endDate, raceDate: coachPlans.raceDate })
      .from(coachPlans)
      .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"))),
    // Last week's review, written by Monday's cron (its narrative already paid for).
    db
      .select({ weekStart: weeklyReviews.weekStart, narrative: weeklyReviews.narrative, createdAt: weeklyReviews.createdAt })
      .from(weeklyReviews)
      .where(and(eq(weeklyReviews.userId, userId), eq(weeklyReviews.weekStart, lastWeek)))
      .limit(1),
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
        ? { id: `missed:${missed[0]!.id}`, label: `Rework my week around ${named[0]}`, request: `Rework my week around ${named[0]} — I missed it.` }
        : {
            id: `missed:${missed[0]!.id}`,
            label: "Rework my week around the sessions I missed",
            request: `Rework my week around the sessions I missed: ${listed(named)}.`,
          },
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
    const label = `Plan what comes after ${planPhrase(ending.name)}`;
    found.push({ id: `ending:${ending.id}`, label, request: `${label} — it ends ${inDays(daysBetween(today, ending.endDate))}.` });
  }

  // The opening's own line: the review first, then the newest session still news — each with the moment after which an
  // ask of the athlete's makes it old news. One this device has shown gives way to the next.
  const candidates: Array<{ opening: CoachOpeningLine; since: string }> = [];
  const review = reviews[0] ? reviewOpening(reviews[0]) : null;
  if (review) candidates.push({ opening: review, since: reviews[0]!.createdAt });
  const days = sessionDays(today);
  const done = recent.find(
    (a) =>
      a.seconds >= SESSION_MIN_SECONDS &&
      days.includes((a.startTimeLocal ?? a.startTime).slice(0, 10)) &&
      (NEWS_SPORTS.has(a.sport) || a.workoutId !== null),
  );
  if (done) {
    const session: FinishedSession = {
      activityId: done.id,
      date: (done.startTimeLocal ?? done.startTime).slice(0, 10),
      sport: done.sport,
      seconds: done.seconds,
      meters: done.meters,
      paceSecPerKm: done.pace,
      hrZones: done.telemetry?.hrZones ?? null,
      noun: done.category ? sessionNoun({ category: done.category, qualitySubtype: done.qualitySubtype, sport: done.plannedSport ?? done.sport }) : sportNoun(done.sport),
      workoutId: done.workoutId,
      sets: parseSets(done.sets),
      glance: done.glance,
    };
    candidates.push({ opening: sessionOpening(session, today, prefs.units === "mi" ? "mi" : "km"), since: done.arrivedAt });
  }
  const unseen = candidates.filter((c) => !seen.has(c.opening.id));

  if (found.length === 0 && unseen.length === 0) return { opening: null, nudges: [] };
  // Already asked: the athlete's own runs (never a sub-run's brief) of the last three days — or since the review was
  // written, when that is longer ago — read once, the newest first.
  const window = new Date(now.getTime() - REFIRE_WINDOW_MS).toISOString();
  const since = unseen.reduce((s, c) => (c.since < s ? c.since : s), window);
  const asked = await db
    .select({ request: coachRuns.request, createdAt: coachRuns.createdAt })
    .from(coachRuns)
    .where(and(eq(coachRuns.userId, userId), isNull(coachRuns.parentId), gte(coachRuns.createdAt, since)))
    .orderBy(desc(coachRuns.createdAt))
    .limit(RECENT_ASKS_MAX);
  const words = asked.filter((r) => r.createdAt >= window).map((r) => asWords(r.request ?? ""));
  const sent = (n: CoachNudge) => words.some((w) => w.includes(asWords(n.label)));
  // Old news: the athlete has asked the coach something since it reached the app.
  const latest = asked[0]?.createdAt ?? null;
  const opening = unseen.find((c) => latest === null || latest < c.since)?.opening ?? null;
  return { opening, nudges: found.filter((n) => !sent(n)).slice(0, NUDGES_MAX) };
}

/** A session's logged sets, as the activities read gives them (one JSON object, or null): none logged, null. */
function parseSets(raw: string | null): FinishedSession["sets"] {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { done?: unknown; total?: unknown; completed?: unknown };
    const total = typeof o.total === "number" ? o.total : 0;
    if (total <= 0) return null;
    return { done: typeof o.done === "number" ? o.done : 0, total, completed: o.completed === 1 || o.completed === true };
  } catch {
    return null;
  }
}

/** A session no planned one stands behind, named by its sport. */
function sportNoun(sport: string): string {
  return sport === "run" ? "run" : sport === "strength" ? "strength session" : sport === "yoga" ? "mobility session" : "session";
}
