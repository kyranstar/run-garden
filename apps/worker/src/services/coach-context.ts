import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  coachMemory,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  coachProposals,
  coachQuestions,
  coachReads,
  corosExercises,
  gardenState,
  dailyHealth,
  plannedWorkouts,
  sleepRecords,
  studioPlans,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  coachExerciseSchema,
  daysBetween,
  formatExercise,
  humanizeWorkoutTitle,
  todayInZone,
  type LocalDate,
  type UserPreferences,
} from "@rg/domain";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import {
  conditionWord,
  DEFAULT_GARDEN_CONFIG,
  gardenForecast,
  nextUnlocks,
  type GardenSnapshot,
} from "@rg/garden-engine";
import type { Db } from "./db.js";
import { pendingTriggers } from "./coach-triggers.js";
import { resolveCodesInText } from "./exercise-catalog.js";
import { findRaceConflict } from "./race-conflict.js";
import { buildRaceHub } from "./race-hub.js";
import { buildReadiness } from "./readiness.js";

/**
 * The dossier (spec §2): everything the coach reads, packaged as ONE terse
 * document for the one-shot wake. Explicit `unknown` for gaps, deterministic
 * given fixed rows. This is the comprehensive-COROS-data-in-useful-format
 * requirement made concrete.
 *
 * The 2026-08-16 input audit added five sections' worth of things the coach
 * could not see and was being blamed for missing: the exercise catalog it was
 * told to cite ids from, the athlete's own written constraints, what an
 * upcoming session actually contains, real training history beyond 14 days,
 * and the honesty markers that stop a frozen or absent reading from being
 * quoted as evidence.
 */

/**
 * 20k, up from 12k (2026-08-16). The EXERCISE CATALOG was ~3.7k tokens of
 * byte-stable reference data and is ~1.7k since its useless 18-digit ids
 * came out (2026-08-17); the athlete's strength brief is another ~700, and
 * measured against prod the whole dossier assembles at ~5k. The ceiling
 * is headroom for a long conversation tail, not a target — and when it IS hit,
 * `truncate` drops whole sections from the tail (catalog first) rather than
 * slicing a line in half.
 */
const TOKEN_BUDGET = 20_000;

/** The readiness baseline window — the same 14 days `/api/plan/today` sends
 * the app, so the dossier's verdict is the app's verdict. */
const READINESS_WINDOW_DAYS = 14;

/** HISTORY's window. 14 days told the coach nothing about a discipline the
 * athlete last touched in January — which is exactly the fact that decides
 * whether a session is a progression or a first-ever. */
const HISTORY_WINDOW_DAYS = 90;

/** Disciplines HISTORY reports even at zero: these are the two the coach
 * prescribes, and "0 strength sessions in 90d" is load-bearing advice. */
const ALWAYS_REPORT_SPORTS = ["run", "strength"] as const;

/**
 * A COROS score that has not moved in this many consecutive recorded days is
 * an artefact of the feed, not a measurement of the athlete. Live-observed:
 * `recovery_score` held exactly 100 for four straight days (and null for the
 * 73 before them) while the coach wrote "recovery reads 100%".
 */
const FROZEN_AFTER_DAYS = 3;

/**
 * Truncation order. Everything not named here can be dropped from the tail to
 * fit the budget, last section first — which is why EXERCISE CATALOG is
 * appended last: it is the largest block and the only one the coach can
 * partially work around. The athlete's constraints and real history sit in
 * here because losing them is what produced the audit's worst advice.
 */
const PROTECTED_SECTIONS = new Set([
  "ATHLETE",
  "PLANS",
  "STRENGTH PLAN",
  "UPCOMING 14 DAYS",
  "HISTORY 90D",
]);

export interface Dossier {
  text: string;
  sections: string[];
  approxTokens: number;
}

const fmt = (v: number | null | undefined, digits = 0): string =>
  v == null ? "unknown" : v.toFixed(digits);

// ── Units ────────────────────────────────────────────────────────────────
// `prefs.units` is "mi" for the live athlete and the dossier was km-only, so
// every distance and pace the coach quoted was in a unit the athlete does not
// read. `llm.ts` already guards this for the weekly review; nothing guarded
// it here. Everything below is rendered IN the athlete's unit and the unit is
// named in the ATHLETE header, because a model that converts invents.

type Units = UserPreferences["units"];
const METERS_PER_MILE = 1609.344;
const unitAbbr = (units: Units): string => (units === "mi" ? "mi" : "km");
const unitWord = (units: Units): string => (units === "mi" ? "miles" : "kilometres");
const inUnits = (meters: number, units: Units): number =>
  units === "mi" ? meters / METERS_PER_MILE : meters / 1000;
const dist = (meters: number | null | undefined, units: Units, digits = 1): string =>
  meters == null ? "unknown" : `${inUnits(meters, units).toFixed(digits)}${unitAbbr(units)}`;

function pace(distanceMeters: number | null, durationSeconds: number, units: Units): string {
  if (!distanceMeters || distanceMeters < 200) return "—";
  const secPerUnit = durationSeconds / inUnits(distanceMeters, units);
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  return `${m}:${String(s).padStart(2, "0")}/${unitAbbr(units)}`;
}

/**
 * How many consecutive RECORDED days (newest first) a reading has held the
 * same value, or null when the newest day has no reading at all. Used to mark
 * weak evidence in the dossier itself — see {@link FROZEN_AFTER_DAYS}.
 */
function frozenRun(
  rows: Array<{ date: LocalDate; value: number | null }>,
): { value: number; days: number; from: LocalDate; to: LocalDate } | null {
  const newestFirst = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const head = newestFirst[0];
  if (!head || head.value == null) return null;
  let i = 1;
  while (i < newestFirst.length && newestFirst[i]!.value === head.value) i++;
  return { value: head.value, days: i, from: newestFirst[i - 1]!.date, to: head.date };
}

/** The most recent day that carried a reading at all, for "last seen" copy. */
function lastReading(
  rows: Array<{ date: LocalDate; value: number | null }>,
): { value: number; date: LocalDate } | null {
  const hit = [...rows]
    .sort((a, b) => b.date.localeCompare(a.date))
    .find((r) => r.value != null);
  return hit ? { value: hit.value!, date: hit.date } : null;
}

/** ISO weekday (1 = Monday) → the short name the athlete wrote their brief in. */
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export async function buildDossier(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<Dossier> {
  const today = todayInZone(prefs.timezone);
  const since14 = addDays(today, -14);
  const since30 = addDays(today, -30);
  const since90 = addDays(today, -HISTORY_WINDOW_DAYS);
  const units = prefs.units;
  // Sections are kept as blocks rather than a flat string so defensive
  // truncation can drop whole sections from the tail instead of cutting a
  // line in half (see `PROTECTED_SECTIONS`).
  const blocks: Array<{ name: string; body: string[] }> = [];
  const push = (name: string, body: string[]) => {
    blocks.push({ name, body });
  };

  // 1 · ATHLETE — memory verbatim, grouped, with ids the model can update.
  const memory = await db
    .select()
    .from(coachMemory)
    .where(and(eq(coachMemory.userId, userId), eq(coachMemory.active, true)));
  const memLines = (kind: string, label: string) => {
    const rows = memory.filter((m) => m.kind === kind);
    return rows.length === 0
      ? [`${label}: none recorded`]
      : rows.map((m) => `${label} [${m.id}]: ${m.body}${m.expiresAt ? ` (until ${m.expiresAt})` : ""}`);
  };
  // The athlete's stated race day is settings data the coach must see
  // directly — memory facts about it go stale, and the race-conflict rule
  // below needs the authoritative value (live-observed 2026-08-13: the coach
  // was told the real date in chat yet had no way to see or fix the
  // conflicting plan label).
  const raceConflict = await findRaceConflict(db, userId, prefs);
  // The race strip's data, in coach-readable form — this is what makes the
  // raceLine output field writable with real numbers (race hub 2026-08-14).
  const raceHub = await buildRaceHub(db, userId, prefs);
  // Wellness rows are loaded here (rather than down in §5, where they are
  // also used) so the ATHLETE header can open with how the athlete is
  // actually doing today — the same verdict the garden dock shows, from the
  // same helper, so the coach's writing and the app's card never contradict
  // each other. `unknown` when the evidence is too thin, per §5's convention.
  const health = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, since30)));
  const readiness = buildReadiness(
    health
      .filter((h) => h.date <= today)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, READINESS_WINDOW_DAYS),
  );
  push("ATHLETE", [
    // The unit contract, first line: every figure this dossier COMPUTES is
    // already in it, so the model quotes rather than converts (a converted
    // number is an invented one). The one exception is called out rather than
    // rewritten: an imported session's `contains:` text is COROS's own words
    // and rewriting its numbers would be inventing data about the plan.
    `units: ${unitWord(units)} — every distance and pace this dossier computes is already in ${unitAbbr(units)}. Quote them as given, name the unit as "${unitAbbr(units)}", never convert. EXCEPTION: the "contains:" text on UPCOMING lines is the plan's own verbatim wording and may be metric — quote its distances in the unit it uses, or restate them in ${unitAbbr(units)} only if you are certain.`,
    `readiness today: ${
      readiness.verdict
        ? `${readiness.verdict.level} — ${readiness.verdict.reasons.join(" · ")}`
        : "unknown — too little recent COROS wellness data to judge"
    }`,
    prefs.raceDate ? `race day (settings): ${prefs.raceDate}` : "race day (settings): none set",
    ...(raceHub && raceHub.daysToRace >= 0
      ? [
          `RACE: ${raceHub.daysToRace} days out · phase ${raceHub.phase} · taper starts ${raceHub.taperStartDate}` +
            (raceHub.goal
              ? ` · COROS threshold ${raceHub.goal.thresholdPaceSecPerKm} sec/km` +
                (raceHub.goal.prediction
                  ? ` · ${raceHub.goal.prediction.distanceKm}km goal band ${raceHub.goal.prediction.fastSecPerKm}-${raceHub.goal.prediction.slowSecPerKm} sec/km`
                  : " · race distance not set, so no goal time — ask if it matters")
              : " · no threshold reading yet") +
            ` · checklist: restructure ${raceHub.checklist.find((i) => i.id === "coach-restructure")?.done ? "done" : "OPEN"}, race-week lifts ${(() => { const it = raceHub.checklist.find((i) => i.id === "coach-lifts"); return it?.note ?? (it?.done ? "eased" : "OPEN"); })()}` +
            (raceHub.terrain.comparison
              ? ` · TERRAIN: recent ${raceHub.terrain.recent!.metresPerKm} m/km vs course ${raceHub.terrain.raceMetresPerKm} m/km (${raceHub.terrain.comparison.verdict})`
              : raceHub.terrain.recent
                ? ` · terrain: recent ${raceHub.terrain.recent.metresPerKm} m/km, course profile not set`
                : "") +
            (raceHub.raceLine ? ` · current raceLine: "${raceHub.raceLine.text}"` : " · no raceLine yet — write one"),
        ]
      : []),
    ...(raceConflict
      ? [
          `RACE CONFLICT: plan session "${raceConflict.title}" is labeled as the race on ${raceConflict.plannedDate}, but race day in Settings is ${raceConflict.raceDate}. Once the athlete confirms which is right, propose resolveRaceConflict.`,
        ]
      : []),
    ...memLines("fact", "fact"),
    ...memLines("rule", "rule"),
    ...memLines("note", "note"),
  ]);

  // 2 · PLANS — coached plans with firm/shape weeks + block adherence.
  const plans = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.userId, userId), inArray(coachPlans.status, ["active", "draft"])));
  const planLines: string[] = [];
  for (const p of plans) {
    const weeks = await db.select().from(coachPlanWeeks).where(eq(coachPlanWeeks.planId, p.id));
    const firm = weeks.filter((w) => w.state === "firm").map((w) => w.weekStart).sort();
    const shape = weeks.filter((w) => w.state === "shape").sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const blockWorkouts = await db
      .select({ state: plannedWorkouts.completionState, category: plannedWorkouts.category })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          isNull(plannedWorkouts.archivedAt),
          gte(plannedWorkouts.effectiveDate, p.startDate),
          lte(plannedWorkouts.effectiveDate, today),
        ),
      );
    const resolved = blockWorkouts.filter((w) =>
      ["completed", "skipped", "missed"].includes(w.state),
    );
    const done = resolved.filter((w) => w.state === "completed").length;
    planLines.push(
      `plan [${p.id}] ${p.name} · ${p.discipline} · ${p.status} · ${p.startDate}→${p.endDate}` +
        `${p.raceDate ? ` · race ${p.raceDate}` : ""}` +
        ` · firm through ${firm.length ? addDays(firm.at(-1)!, 6) : "unknown"}` +
        ` · adherence ${resolved.length ? Math.round((100 * done) / resolved.length) + "%" : "unknown"}`,
    );
    for (const s of shape) {
      planLines.push(
        `  shape wk ${s.weekStart}: ${s.shape?.volumeTarget ?? "unknown"} · ${s.shape?.keySessions.join(", ") ?? ""}`,
      );
    }
  }
  push(
    "PLANS",
    planLines.length
      ? planLines
      : [
          "no coached plans — imported COROS plan sessions (if any) are listed in UPCOMING and can be skipped or moved by proposal; only their plan structure is read-only",
        ],
  );

  // The next 14 days of sessions, read once: UPCOMING renders them and
  // STRENGTH PLAN expands the lift ones.
  const coachPlanIdSet = new Set(
    (await db.select({ id: coachPlans.id }).from(coachPlans).where(eq(coachPlans.userId, userId))).map(
      (p) => p.id,
    ),
  );
  const upcoming = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        // Archived rows are invisible on the Plan page — a dossier that
        // includes them has the coach anchoring on phantom sessions
        // (2026-08-12 audit finding 7).
        isNull(plannedWorkouts.archivedAt),
        gte(plannedWorkouts.effectiveDate, today),
        lte(plannedWorkouts.effectiveDate, addDays(today, 14)),
      ),
    )
    .orderBy(plannedWorkouts.effectiveDate);

  // The COROS movement catalog, read once: EXERCISE CATALOG lists it at the
  // very end of the dossier and `resolveCodesInText` uses it to turn the
  // T-codes inside stage summaries into words.
  const catalogRows = await db
    .select({ id: corosExercises.id, name: corosExercises.name })
    .from(corosExercises)
    .orderBy(corosExercises.id);
  const catalogRawNames = new Map(catalogRows.map((r) => [r.id, r.name]));
  const humanName = (stored: string): string => COROS_EXERCISE_NAMES[stored.trim()] ?? stored;

  // 2.5 · STRENGTH PLAN — the athlete's own words, verbatim.
  //
  // `studio_plans.brief` is the richest athlete profile in the database and
  // the dossier had never read it. Live consequence (2026-08-16): the brief
  // says "tight IT band … I haven't lifted in a long time … Tuesday I am also
  // running and will likely run before this", and the coach put a heavy leg
  // session on Tuesday and never mentioned the IT band. The exercises of the
  // live upcoming lift sessions ride along, because "what is already
  // prescribed on Wednesday" is the other half of not double-prescribing it.
  const [studio] = await db
    .select()
    .from(studioPlans)
    .where(eq(studioPlans.userId, userId))
    .orderBy(desc(studioPlans.updatedAt))
    .limit(1);
  push("STRENGTH PLAN", strengthPlanLines(studio, upcoming, catalogRawNames));

  // 3 · UPCOMING 14 DAYS — every scheduled session with the [wo:id] handle
  // ease/move/skip ops need. Without this section the coach could not name a
  // future workout at all (live-observed: it refused to skip an imported
  // Saturday run it had no way to reference).
  //
  // `stageSummary` is appended because date-category-title alone had the
  // coach judging an 8-minute desk-mobility placeholder (cat-cow, chin tucks,
  // breathing, zero lower body) as adequate ski preparation FROM ITS TITLE,
  // and prescribing a wall sit Wednesday already had.
  push(
    "UPCOMING 14 DAYS",
    upcoming.length
      ? upcoming.map(
          (w) =>
            `${w.effectiveDate} · ${w.category} · "${humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype)}" · ${w.sport} [wo:${w.id}]` +
            `${w.completionState !== "scheduled" ? ` · ${w.completionState}` : ""}` +
            `${coachPlanIdSet.has(w.planId ?? "") ? "" : " · imported"}` +
            ` · contains: ${
              w.stageSummary
                ? resolveCodesInText(w.stageSummary, catalogRawNames)
                : "no stage detail stored — do NOT assume what is in it"
            }`,
        )
      : ["nothing scheduled in the next 14 days"],
  );

  // 4 · LAST 14 DAYS — planned vs actual, one line per session.
  const recentWorkouts = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt), gte(plannedWorkouts.effectiveDate, since14), lte(plannedWorkouts.effectiveDate, today)))
    .orderBy(plannedWorkouts.effectiveDate);
  const recentActs = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, `${since14}T00:00:00Z`)));
  const matches = await db
    .select()
    .from(workoutCompletionMatches)
    .where(inArray(workoutCompletionMatches.workoutId, recentWorkouts.map((w) => w.id).concat("-")));
  const actById = new Map(recentActs.map((a) => [a.id, a]));
  const matchByWorkout = new Map(matches.map((m) => [m.workoutId, m]));
  const trainingLines = recentWorkouts
    .filter((w) => w.category !== "rest")
    .map((w) => {
      const act = matchByWorkout.get(w.id) ? actById.get(matchByWorkout.get(w.id)!.activityId) : undefined;
      const actual = act
        ? `did ${Math.round(act.durationSeconds / 60)}min${act.distanceMeters ? ` ${dist(act.distanceMeters, units)} ${pace(act.distanceMeters, act.durationSeconds, units)}` : ""}`
        : w.completionState === "completed"
          ? "completed (details unknown)"
          : w.completionState;
      return `${w.effectiveDate} · ${w.category} · "${humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype)}" · ${actual} [wo:${w.id}]`;
    });
  const matchedActivityIds = new Set(matches.map((m) => m.activityId));
  const unplanned = recentActs
    .filter((a) => !matchedActivityIds.has(a.id) && ["run", "strength", "yoga"].includes(a.sport))
    .map((a) => {
      const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
      return `${d} · unplanned ${a.sport} · ${Math.round(a.durationSeconds / 60)}min${a.distanceMeters ? ` ${dist(a.distanceMeters, units)}` : ""}`;
    });

  // 3.5 · HISTORY 90D — per discipline, and the authoritative days-since-run.
  //
  // The dossier showed 14 days and nothing else, so the coach could not know
  // that this athlete has ONE strength activity in the entire database
  // (2026-01-03) and ten ski activities in Jan–Apr. Both facts change the
  // advice completely, and neither was visible. The detraining sentence is
  // spelled out in words the model cannot round off.
  //
  // days-since-run is computed HERE, from activities, because the old source
  // (`garden_state.snapshot.state.daysSinceCompletedRun`) is a simulation
  // artefact with no freshness check: it read 3 while the truth was 5, and
  // the coach said "3 days off running" to the athlete.
  const perSport = await db
    .select({
      sport: activities.sport,
      allTime: sql<number>`count(*)`,
      lastAt: sql<string>`max(coalesce(${activities.startTimeLocal}, ${activities.startTime}))`,
    })
    .from(activities)
    .where(eq(activities.userId, userId))
    .groupBy(activities.sport);
  const windowActs = await db
    .select({
      sport: activities.sport,
      startTime: activities.startTime,
      startTimeLocal: activities.startTimeLocal,
      distanceMeters: activities.distanceMeters,
      durationSeconds: activities.durationSeconds,
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, `${addDays(since90, -1)}T00:00:00Z`)));
  const localDay = (a: { startTime: string; startTimeLocal: string | null }): LocalDate =>
    (a.startTimeLocal ?? a.startTime).slice(0, 10);
  const inWindow = windowActs.filter((a) => localDay(a) >= since90 && localDay(a) <= today);
  const sports = [...new Set([...perSport.map((r) => r.sport), ...ALWAYS_REPORT_SPORTS])];
  const historyRows = sports
    .map((sport) => {
      const all = perSport.find((r) => r.sport === sport);
      const recent = inWindow.filter((a) => a.sport === sport);
      const lastDate = all?.lastAt ? (all.lastAt.slice(0, 10) as LocalDate) : null;
      return {
        sport,
        recent: recent.length,
        allTime: all?.allTime ?? 0,
        lastDate,
        daysSince: lastDate ? daysBetween(lastDate, today) : null,
        meters: recent.reduce((sum, a) => sum + (a.distanceMeters ?? 0), 0),
        minutes: Math.round(recent.reduce((sum, a) => sum + a.durationSeconds, 0) / 60),
      };
    })
    .sort((a, b) => b.recent - a.recent || b.allTime - a.allTime || a.sport.localeCompare(b.sport));
  const lastRun = historyRows.find((r) => r.sport === "run");
  const historyLines: string[] = [
    lastRun?.lastDate
      ? `days since last run: ${lastRun.daysSince} (last run ${lastRun.lastDate}) — computed from activities; this is the number to quote, never the garden's`
      : "days since last run: no run ever recorded",
    ...historyRows.map((r) => {
      const parts = [
        `${r.sport}: ${r.recent} sessions in ${HISTORY_WINDOW_DAYS}d`,
        `${r.allTime} all-time`,
        r.lastDate ? `last ${r.lastDate} (${r.daysSince}d ago)` : "never recorded",
      ];
      if (r.meters > 0) parts.push(`${dist(r.meters, units, 0)} in ${HISTORY_WINDOW_DAYS}d`);
      else if (r.minutes > 0) parts.push(`${r.minutes}min in ${HISTORY_WINDOW_DAYS}d`);
      // The one sentence that cannot be misread as "a bit rusty".
      const verdict =
        r.recent === 0
          ? " — treat as untrained: prescribe a first session, not a progression"
          : r.recent <= 2
            ? " — barely trained in this discipline"
            : "";
      return parts.join(" · ") + verdict;
    }),
  ];
  push("HISTORY 90D", historyLines);

  push("LAST 14 DAYS", [...trainingLines, ...unplanned].length ? [...trainingLines, ...unplanned] : ["no sessions recorded"]);

  // 5 · WELLNESS 14D — with 30d baselines, COROS training load, and explicit
  // markers on evidence too weak to quote.
  //
  // Three live failures shaped this section (2026-08-16):
  //  · `sleep_records` is COMPLETELY EMPTY (0 rows), so every line read
  //    "sleep unknown" and the emptiness looked like a gap in the window
  //    rather than a gap in the feed. Now it is stated once, in words.
  //  · `recovery_score` has held exactly two values across 77 rows (null ×73,
  //    100 ×4). The coach wrote "recovery reads 100%" off a frozen number.
  //  · HRV and RHR are null on the latest two days, and the coach wrote "HRV
  //    back above baseline" on a day with no HRV at all.
  // And `training_load_7d` — the one number that says "detrained RIGHT NOW",
  // used by the Studio prompt since day one — was simply absent here.
  const sleep = await db
    .select()
    .from(sleepRecords)
    .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, since30)));
  const anySleepEver = sleep.length
    ? 1
    : (await db
        .select({ n: sql<number>`count(*)` })
        .from(sleepRecords)
        .where(eq(sleepRecords.userId, userId)))[0]?.n ?? 0;
  // `health` is loaded up in §1 (the readiness line needs it there).
  const baseline = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const sleepBase = baseline(sleep.map((s) => s.durationSeconds / 3600));
  const hrvBase = baseline(health.map((h) => h.hrv).filter((v): v is number => v != null));
  const rhrBase = baseline(health.map((h) => h.restingHeartRate).filter((v): v is number => v != null));
  const window14 = health
    .filter((h) => h.date <= today && h.date > addDays(today, -14))
    .sort((a, b) => a.date.localeCompare(b.date));
  const series = (pick: (h: (typeof health)[number]) => number | null) =>
    window14.map((h) => ({ date: h.date as LocalDate, value: pick(h) }));

  const wellnessLines: string[] = [
    anySleepEver === 0
      ? "sleep: NO DATA AT ALL — sleep_records is empty for this athlete (0 rows, ever). Never state, infer, or ask them to confirm anything about their sleep."
      : `30d sleep baseline: ${fmt(sleepBase, 1)}h`,
    `30d baselines: HRV ${fmt(hrvBase)}ms · RHR ${fmt(rhrBase)}bpm`,
  ];

  // Training load: today's figure plus enough trajectory to see a collapse.
  const loadSeries = series((h) => h.trainingLoad7d).filter((p) => p.value != null) as Array<{
    date: LocalDate;
    value: number;
  }>;
  if (loadSeries.length === 0) {
    wellnessLines.push("COROS 7-day training load: no reading in the last 14 days");
  } else {
    const latestLoad = loadSeries[loadSeries.length - 1]!;
    const peak = loadSeries.reduce((a, b) => (b.value >= a.value ? b : a));
    const deltaPct = peak.value > 0 ? Math.round((100 * (latestLoad.value - peak.value)) / peak.value) : 0;
    wellnessLines.push(
      `COROS 7-day training load: ${Math.round(latestLoad.value)} on ${latestLoad.date} · 14d peak ${Math.round(peak.value)} on ${peak.date} · ${deltaPct >= 0 ? "+" : ""}${deltaPct}% off peak` +
        (deltaPct <= -50
          ? " — this is a COLLAPSE in load, not a taper: the athlete is detrained right now"
          : ""),
    );
  }

  // Weak-evidence markers, stated in the dossier rather than left for the
  // model to notice. A frozen score and a missing reading are both things it
  // has already quoted as fresh measurements.
  for (const [label, pick, unit] of [
    ["recovery", (h: (typeof health)[number]) => h.recoveryScore, "%"],
    ["HRV", (h: (typeof health)[number]) => h.hrv, "ms"],
    ["RHR", (h: (typeof health)[number]) => h.restingHeartRate, "bpm"],
  ] as const) {
    const s = series(pick);
    const latest = s[s.length - 1];
    if (latest && latest.value == null) {
      const last = lastReading(s);
      wellnessLines.push(
        `${label}: NO READING on ${latest.date}${last ? ` (last was ${Math.round(last.value)}${unit} on ${last.date})` : " and none in the last 14 days"} — you cannot say anything about today's ${label}.`,
      );
      continue;
    }
    const frozen = frozenRun(s);
    if (frozen && frozen.days >= FROZEN_AFTER_DAYS) {
      wellnessLines.push(
        `${label}: ${Math.round(frozen.value)}${unit} UNCHANGED across the last ${frozen.days} recorded days (${frozen.from}→${frozen.to}) — a stuck feed value, weak evidence. Do not present it as today's measurement or as a change.`,
      );
    }
  }

  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const s = sleep.find((r) => r.date === d);
    const h = health.find((r) => r.date === d);
    if (!s && !h) continue;
    wellnessLines.push(
      `${d}: ` +
        (anySleepEver === 0 ? "" : `sleep ${s ? (s.durationSeconds / 3600).toFixed(1) + "h" : "unknown"} · `) +
        `HRV ${fmt(h?.hrv)}ms · RHR ${fmt(h?.restingHeartRate)}bpm · load ${fmt(h?.trainingLoad7d)}`,
    );
  }
  push("WELLNESS 14D", wellnessLines);

  // 6 · SIGNALS — pending triggers verbatim.
  const triggers = await pendingTriggers(db, userId);
  push(
    "SIGNALS",
    triggers.length
      ? triggers.map((t) => `${t.kind} (${t.firedAt.slice(0, 10)}): ${JSON.stringify(t.evidence)}`)
      : ["none pending"],
  );

  // 7 · MILESTONES — the garden's state, for the coach's (sparing) garden
  // voice (fairness spec §3). Forecast stage included so the one-loss-voice
  // rule can hold: when the garden is already speaking loss, the coach
  // stays silent about it.
  const [gs] = await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  const gardenLines: string[] = [];
  if (gs) {
    const snap = gs.snapshot as unknown as GardenSnapshot;
    const st = snap.state;
    const chain = st.consecutiveConsistentWeeks ?? 0;
    const forecast = gardenForecast(snap, 0);
    const nearest = nextUnlocks(snap, 1)[0];
    // `daysSinceCompletedRun` USED to be emitted here as a bare number. It is
    // a simulation output, only as fresh as `last_simulated_date`, and the
    // coach quoted it to the athlete as "3 days off running" on a day the
    // real answer was 5. The garden's day-count no longer appears at all —
    // HISTORY 90D carries the activity-derived figure — and what remains is
    // stamped with the date it describes (2026-08-16 input audit).
    const staleBy = gs.lastSimulatedDate ? daysBetween(gs.lastSimulatedDate, today) : null;
    gardenLines.push(
      `garden (simulation state as of ${gs.lastSimulatedDate ?? "unknown"}${staleBy && staleBy > 0 ? `, ${staleBy}d stale` : ""}): ${conditionWord(st, DEFAULT_GARDEN_CONFIG)} · weather ${st.weatherState} · chain ${chain}w`,
      `garden forecast stage: ${forecast.next?.stage ?? (st.restMode ? "rest_mode" : "none")}${forecast.recovering ? " (recovering)" : ""}`,
      "garden counters are scenery, not training facts — never quote a garden day-count to the athlete; use HISTORY 90D.",
    );
    if (nearest?.progress) {
      gardenLines.push(
        `nearest unlock: ${nearest.name} (${nearest.progress.current}/${nearest.progress.target} — ${nearest.hint})`,
      );
    }
  } else {
    gardenLines.push("garden: unknown");
  }
  push("MILESTONES", gardenLines);

  // 7.5 · RECENT READS — ambient per-effort glances since the last real
  // briefing (rework spec §3). Replaces the old pattern of analyses crowding
  // the conversation tail: seven one-liners instead of seven 140-word essays.
  const [lastBriefing] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "coach"),
        sql`json_extract(${coachMessages.refs}, '$.kind') IS NULL`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  const lastBriefingAt = lastBriefing?.at ?? "";
  const doneReads = await db
    .select()
    .from(coachReads)
    .where(and(eq(coachReads.userId, userId), eq(coachReads.status, "done")));
  const freshReads = doneReads
    .filter((r) => (r.completedAt ?? "") > lastBriefingAt && r.glance)
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
    .slice(-7);
  if (freshReads.length > 0) {
    push(
      "RECENT READS",
      freshReads.map(
        (r) =>
          `- [${r.activityId}] ${r.glance}${r.flags.length ? ` (${r.flags.join(",")})` : ""}`,
      ),
    );
  }

  // 8 · OPEN ITEMS — never double-propose, never re-ask.
  const pendingProps = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")));
  const openQs = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.userId, userId)))
    .orderBy(desc(coachQuestions.askedAt))
    .limit(5);
  const sanctionedThisWeek = (
    await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.sanctionedBy, "coach"),
          inArray(plannedWorkouts.completionState, ["skipped", "missed"]),
          gte(plannedWorkouts.resolutionDate, addDays(today, -6)),
        ),
      )
  ).length;
  push("OPEN ITEMS", [
    `sanctioned rest used ${Math.min(sanctionedThisWeek, 1)} of 1 this rolling week (${sanctionedThisWeek} total sanctioned skips in window)`,
    ...(pendingProps.length
      ? pendingProps.map((p) => `pending proposal [${p.id}]: ${p.title} (${p.evidence})`)
      : ["no pending proposals"]),
    ...openQs.map(
      (q) =>
        `question ${q.answeredAt ? "answered" : "OPEN"} (${q.askedAt.slice(0, 10)}): ${q.body}`,
    ),
  ]);

  // 9 · CONVERSATION TAIL — last 10 messages, oldest first.
  const tail = await db
    .select()
    .from(coachMessages)
    .where(eq(coachMessages.userId, userId))
    .orderBy(desc(coachMessages.at))
    .limit(10);
  push(
    "CONVERSATION TAIL",
    tail.length
      ? [...tail].reverse().map((m) => `${m.at.slice(0, 16)} ${m.role}: ${m.body}`)
      : ["no conversation yet"],
  );

  // 10 · EXERCISE CATALOG — LAST, deliberately, and NAMES ONLY.
  //
  // The wake prompt tells the model "lifts use catalog exercises" and it was
  // never given the catalog: 382 synced COROS movements, passed to the Studio
  // prompt and to nothing else. It was being asked to cite ids it had never
  // seen — which is why prescribed lifts kept arriving off-catalog and
  // therefore app-only. Names come through COROS_EXERCISE_NAMES because the
  // stored names are i18n T-codes ("T1367"), not words.
  //
  // The IDS ARE GONE (2026-08-17), and they were most of the block. A COROS
  // exercise id is an 18-digit snowflake ("425827615547506688") — ~7 tokens
  // of pure noise each, 382 of them, and the model was never able to use one
  // anyway: `resolveOpsExercises` re-resolves every exercise from its NAME
  // server-side and overwrites whatever id the model echoed. So the catalog
  // was spending ~2.7k input tokens per wake to offer a fact the pipeline
  // discards. What the model actually needs from this block is the
  // VOCABULARY — which movements this watch can be told about — and that is
  // the names. One comma-separated list, de-duplicated, ~half the block.
  //
  // Its position is the whole trick: byte-stable across wakes (so it is the
  // one block worth caching), largest block in the document, and the only one
  // the coach can partly work around — so it is what truncation eats first.
  const catalogNames = [...new Set(catalogRows.map((r) => humanName(r.name).trim()).filter(Boolean))];
  if (catalogNames.length > 0) {
    push("EXERCISE CATALOG", [
      `The ${catalogNames.length} movements this athlete's watch knows, by name. Prefer these names so a lift can reach the watch; anything else still works and simply lives in the app. Write names, never ids — the server resolves them.`,
      catalogNames.join(", "),
    ]);
  }

  const sections = blocks.map((b) => b.name);
  const render = (bs: typeof blocks): string =>
    `# ATHLETE DOSSIER · ${today}\n\n` +
    bs.map((b) => [`## ${b.name}`, ...b.body, ""].join("\n")).join("\n");

  // Defensive truncation drops WHOLE SECTIONS from the tail, last first, and
  // never one named in PROTECTED_SECTIONS — so a pathological conversation
  // history costs the catalog before it costs the athlete's constraints or
  // their training history. What was dropped is stated, because a silently
  // absent catalog looks to the model like an athlete with no exercises.
  let kept = [...blocks];
  const dropped: string[] = [];
  while (render(kept).length / 4 > TOKEN_BUDGET) {
    let i = -1;
    for (let j = kept.length - 1; j >= 0; j--) {
      if (!PROTECTED_SECTIONS.has(kept[j]!.name)) {
        i = j;
        break;
      }
    }
    if (i < 0) break;
    dropped.push(kept[i]!.name);
    kept.splice(i, 1);
  }
  if (dropped.length > 0) {
    kept = [
      ...kept,
      {
        name: "OMITTED",
        body: [
          `dropped to fit the context budget: ${dropped.join(", ")}. Treat their contents as unknown, not as empty.`,
        ],
      },
    ];
  }
  let text = render(kept);
  if (text.length / 4 > TOKEN_BUDGET) text = text.slice(0, TOKEN_BUDGET * 4);
  return { text, sections: kept.map((b) => b.name), approxTokens: Math.round(text.length / 4) };
}

// ── STRENGTH PLAN rendering ──────────────────────────────────────────────

interface StudioPlanRow {
  id: string;
  brief: Record<string, unknown>;
  plan: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

interface UpcomingLiftRow {
  id: string;
  effectiveDate: string;
  title: string;
  category: string;
  qualitySubtype: string | null;
  sport: string;
  structuredJson: { exercises?: unknown[]; rounds?: number } | null;
}

/**
 * `studio_plans.brief` verbatim, plus the exercises of every lift session in
 * the next 14 days. Verbatim is the point: an injury list the coach has
 * paraphrased is an injury list the coach can ignore.
 *
 * Every read is defensive rather than schema-validated — a brief with one odd
 * field must still surrender the athlete's constraints, because losing the
 * whole section to a validation failure is the exact bug this section exists
 * to fix.
 */
function strengthPlanLines(
  studio: StudioPlanRow | undefined,
  upcoming: UpcomingLiftRow[],
  catalogRawNames: Map<string, string>,
): string[] {
  const lines: string[] = [];
  if (!studio) {
    lines.push(
      "no strength plan in Plan Studio — the athlete has stated no lifting goal, constraints, or equipment. Ask before prescribing loaded work.",
    );
  } else {
    const brief = studio.brief ?? {};
    const str = (k: string): string | null => {
      const v = brief[k];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const num = (k: string): number | null => (typeof brief[k] === "number" ? (brief[k] as number) : null);
    const days = Array.isArray(brief.preferredDays)
      ? (brief.preferredDays as unknown[]).filter((d): d is number => typeof d === "number")
      : [];
    const planName = typeof studio.plan?.name === "string" ? studio.plan.name : "untitled";
    lines.push(
      `plan [${studio.id}] "${planName}" · v${studio.version} · updated ${studio.updatedAt.slice(0, 10)}` +
        (str("startDate") ? ` · starts ${str("startDate")}` : ""),
      [
        `goal: ${str("goal") ?? "unknown"}`,
        `${num("durationWeeks") ?? "unknown"} weeks`,
        `${num("sessionsPerWeek") ?? "unknown"} sessions/week`,
        `${num("sessionMinutes") ?? "unknown"} min/session`,
        `preferred days: ${days.length ? days.map((d) => WEEKDAY_NAMES[d - 1] ?? String(d)).join(", ") : "unknown"}`,
      ].join(" · "),
      `equipment: ${str("equipment") ?? "not stated"}`,
      `constraints (THE ATHLETE'S OWN WORDS — every session you write must respect these): ${str("constraints") ?? "none stated"}`,
      `notes (THE ATHLETE'S OWN WORDS): ${str("notes") ?? "none stated"}`,
    );
  }

  const lifts = upcoming.filter((w) => w.sport === "strength" || w.category === "strength");
  if (lifts.length === 0) {
    lines.push("no lift session scheduled in the next 14 days");
    return lines;
  }
  const byTitle = studioSessionIndex(studio);
  for (const w of lifts) {
    lines.push(
      `already prescribed ${w.effectiveDate} "${humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype)}" [wo:${w.id}] — do not duplicate what is in it:`,
    );
    const rendered = liftExerciseLines(w, byTitle, catalogRawNames);
    if (rendered.length === 0) {
      lines.push(
        "  · exercises not stored on this session — the UPCOMING line's `contains:` is everything that is known about it",
      );
    } else {
      lines.push(...rendered.map((l) => `  · ${l}`));
    }
  }
  return lines;
}

/** Studio session title → its exercises. Titles carry their week ("W1 Wed …"),
 * so they are unique in practice; on a collision the later week wins. */
function studioSessionIndex(studio: StudioPlanRow | undefined): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const weeks = (studio?.plan as { weeks?: unknown })?.weeks;
  if (!Array.isArray(weeks)) return out;
  for (const week of weeks) {
    const sessions = (week as { sessions?: unknown })?.sessions;
    if (!Array.isArray(sessions)) continue;
    for (const s of sessions) {
      const title = (s as { title?: unknown })?.title;
      const exercises = (s as { exercises?: unknown })?.exercises;
      if (typeof title === "string" && Array.isArray(exercises)) out.set(title, exercises);
    }
  }
  return out;
}

/**
 * A planned lift's exercises, from whichever source has them: a coach-authored
 * session stores them on `structured_json`; a Studio session that was pushed
 * to COROS stores them only in `studio_plans.plan`, and the pushed workout's
 * title is the Studio title plus a week suffix ("… — wk 1"), so it is matched
 * by longest title prefix.
 */
function liftExerciseLines(
  w: UpcomingLiftRow,
  byTitle: Map<string, unknown[]>,
  catalogRawNames: Map<string, string>,
): string[] {
  const stored = w.structuredJson?.exercises;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.flatMap((e) => {
      const parsed = coachExerciseSchema.safeParse(e);
      if (!parsed.success) {
        const line = studioExerciseLine(e, catalogRawNames);
        return line ? [line] : [];
      }
      const note = (e as { note?: unknown })?.note;
      return [
        formatExercise(parsed.data) + (typeof note === "string" && note.trim() ? ` — ${note.trim()}` : ""),
      ];
    });
  }
  const match =
    byTitle.get(w.title) ??
    [...byTitle.entries()]
      .filter(([t]) => w.title.startsWith(t))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (!match) return [];
  return match.flatMap((e) => {
    const line = studioExerciseLine(e, catalogRawNames);
    return line ? [line] : [];
  });
}

/** One Studio-shaped exercise as a line: name, sets×reps, load, rest, note,
 * and the catalog id — the id is what makes "already prescribed" checkable. */
function studioExerciseLine(e: unknown, catalogRawNames: Map<string, string>): string | null {
  if (typeof e !== "object" || e === null) return null;
  const o = e as Record<string, unknown>;
  const originId = typeof o.originId === "string" ? o.originId : null;
  const rawName = originId ? catalogRawNames.get(originId) : undefined;
  const fallback = typeof o.name === "string" ? o.name : "";
  const name = COROS_EXERCISE_NAMES[(rawName ?? fallback).trim()] ?? rawName ?? fallback;
  if (!name) return null;
  const sets = typeof o.sets === "number" ? o.sets : null;
  const reps = typeof o.reps === "number" ? o.reps : null;
  const work = sets != null && reps != null ? ` ${sets}×${reps}` : sets != null ? ` ${sets} sets` : "";
  const weight = o.weight as { type?: unknown; value?: unknown } | undefined;
  const load =
    weight?.type === "kg" && typeof weight.value === "number"
      ? ` @ ${weight.value} kg`
      : weight?.type === "bodyweight"
        ? " bodyweight"
        : "";
  const rest = typeof o.restSeconds === "number" ? ` · rest ${o.restSeconds}s` : "";
  const note = typeof o.note === "string" && o.note.trim() ? ` — ${o.note.trim()}` : "";
  return `${name}${work}${load}${rest}${originId ? ` [${originId}]` : ""}${note}`;
}
