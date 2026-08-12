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
  gardenState,
  dailyHealth,
  plannedWorkouts,
  sleepRecords,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  humanizeWorkoutTitle,
  todayInZone,
  type LocalDate,
  type UserPreferences,
} from "@rg/domain";
import {
  conditionWord,
  DEFAULT_GARDEN_CONFIG,
  gardenForecast,
  nextUnlocks,
  type GardenSnapshot,
} from "@rg/garden-engine";
import type { Db } from "./db.js";
import { pendingTriggers } from "./coach-triggers.js";

/**
 * The dossier (spec §2): everything the coach reads, packaged as ONE terse
 * document for the one-shot wake. Nine sections, explicit `unknown` for
 * gaps, deterministic given fixed rows, budget ≈ 12k tokens. This is the
 * comprehensive-COROS-data-in-useful-format requirement made concrete.
 */

const TOKEN_BUDGET = 12_000;

export interface Dossier {
  text: string;
  sections: string[];
  approxTokens: number;
}

const fmt = (v: number | null | undefined, digits = 0): string =>
  v == null ? "unknown" : v.toFixed(digits);

function pace(distanceMeters: number | null, durationSeconds: number): string {
  if (!distanceMeters || distanceMeters < 200) return "—";
  const secPerKm = durationSeconds / (distanceMeters / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export async function buildDossier(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<Dossier> {
  const today = todayInZone(prefs.timezone);
  const since14 = addDays(today, -14);
  const since30 = addDays(today, -30);
  const out: string[] = [];
  const sections: string[] = [];
  const push = (name: string, body: string[]) => {
    sections.push(name);
    out.push(`## ${name}`, ...body, "");
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
  push("ATHLETE", [
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

  // 3 · UPCOMING 14 DAYS — every scheduled session with the [wo:id] handle
  // ease/move/skip ops need. Without this section the coach could not name a
  // future workout at all (live-observed: it refused to skip an imported
  // Saturday run it had no way to reference).
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
  push(
    "UPCOMING 14 DAYS",
    upcoming.length
      ? upcoming.map(
          (w) =>
            `${w.effectiveDate} · ${w.category} · "${humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype)}" · ${w.sport} [wo:${w.id}]` +
            `${w.completionState !== "scheduled" ? ` · ${w.completionState}` : ""}` +
            `${coachPlanIdSet.has(w.planId ?? "") ? "" : " · imported"}`,
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
        ? `did ${Math.round(act.durationSeconds / 60)}min${act.distanceMeters ? ` ${(act.distanceMeters / 1000).toFixed(1)}km ${pace(act.distanceMeters, act.durationSeconds)}` : ""}`
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
      return `${d} · unplanned ${a.sport} · ${Math.round(a.durationSeconds / 60)}min${a.distanceMeters ? ` ${(a.distanceMeters / 1000).toFixed(1)}km` : ""}`;
    });
  push("LAST 14 DAYS", [...trainingLines, ...unplanned].length ? [...trainingLines, ...unplanned] : ["no sessions recorded"]);

  // 5 · WELLNESS 14D — with 30d baselines.
  const sleep = await db
    .select()
    .from(sleepRecords)
    .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, since30)));
  const health = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, since30)));
  const baseline = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const sleepBase = baseline(sleep.map((s) => s.durationSeconds / 3600));
  const hrvBase = baseline(health.map((h) => h.hrv).filter((v): v is number => v != null));
  const rhrBase = baseline(health.map((h) => h.restingHeartRate).filter((v): v is number => v != null));
  const wellnessLines: string[] = [
    `30d baselines: sleep ${fmt(sleepBase, 1)}h · HRV ${fmt(hrvBase)}ms · RHR ${fmt(rhrBase)}bpm`,
  ];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    const s = sleep.find((r) => r.date === d);
    const h = health.find((r) => r.date === d);
    if (!s && !h) continue;
    wellnessLines.push(
      `${d}: sleep ${s ? (s.durationSeconds / 3600).toFixed(1) + "h" : "unknown"} · HRV ${fmt(h?.hrv)}ms · RHR ${fmt(h?.restingHeartRate)}bpm`,
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
    gardenLines.push(
      `garden: ${conditionWord(st, DEFAULT_GARDEN_CONFIG)} · weather ${st.weatherState} · ${st.daysSinceCompletedRun}d since a run · chain ${chain}w`,
      `garden forecast stage: ${forecast.next?.stage ?? (st.restMode ? "rest_mode" : "none")}${forecast.recovering ? " (recovering)" : ""}`,
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

  let text = `# ATHLETE DOSSIER · ${today}\n\n${out.join("\n")}`;
  // Defensive truncation from the tail sections only (never the athlete/plans
  // head) if a pathological history blows the budget.
  if (text.length / 4 > TOKEN_BUDGET) text = text.slice(0, TOKEN_BUDGET * 4);
  return { text, sections, approxTokens: Math.round(text.length / 4) };
}
