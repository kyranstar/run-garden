/**
 * A made-up athlete for the coach designer's read tools (Stage 3 Task 4): rich rows in every table the tools read —
 * sessions with sets, flags and checks; runs; wellness; check-ins and feedback; the plan with documents and a
 * programme block; objectives across every measure family; templates; proposals; memory; exercise preferences — and
 * a second account whose every row carries OTHER_SENTINEL. Synthetic data only; every date is relative to a fixed
 * clock, and nothing reads the real one.
 */
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { makeTestUser } from "./helpers.js";

/** 2026-05-13 09:30 in Los Angeles (a Wednesday; PDT, UTC-7). */
export const NOW = new Date("2026-05-13T16:30:00Z");
export const TODAY = "2026-05-13";
export const TZ = "America/Los_Angeles";
export const OTHER_SENTINEL = "OTHER-SENTINEL";

/** `n` days before today (negative: after). */
export const day = (n: number): string => addDays(TODAY, -n);
/** An instant on a local date in Los Angeles (PDT): `hhmm` local. */
export const at = (date: string, hhmm = "09:00"): string => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h! + 7) * 60 + m!) * 60_000).toISOString();
};

export function studioDoc(over: { title?: string; summary?: string; why?: string } = {}): WorkoutDoc {
  return workoutDocSchema.parse({
    version: 1,
    title: over.title ?? "Strong hips, easy back",
    intent: { summary: over.summary ?? "Wake the glutes, then load the squat; finish by opening the hips.", goals: ["strength", "posture"], focus: ["glutes", "upper-back"], effort: "develop" },
    parts: [
      { purpose: "activation", why: "Glutes on before loading.", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12 }, why: over.why ?? "Activation before loading." }] },
      {
        purpose: "main",
        format: "straight",
        items: [
          { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8, load: { typed: "35 lb", kg: 15.9 }, restSec: 90 }, why: "Week 3 of 5 — up one rep.", cue: "Elbows inside the knees." },
          { kind: "exercise", libraryId: "bandRow", dose: { sets: 3, reps: 12 }, why: "Upper back, untrained for 6 days." },
        ],
      },
      { purpose: "cooldown", format: "flow", items: [{ kind: "exercise", libraryId: "couchStretch", dose: { holdSec: 45, perSide: true } }] },
    ],
    source: { kind: "studio" },
    notes: "Keep the jaw soft.",
  });
}

interface SeedIds {
  placeId: string;
  gymId: string;
  programId: string;
  /** Today's 18:00 Studio workout (a document, revision 2). */
  todayDocId: string;
  /** A done Studio workout 3 days ago, with its session and feedback. */
  pastDocId: string;
  archivedDocId: string;
  outlineToday: string;
  /** The app session 3 days ago (the one that did pastDocId, its strength activity's own record). */
  sessionDay3: string;
}

/** The rich athlete. */
export async function seedRichAthlete(db: Db, prefs: Partial<UserPreferences> = {}): Promise<{ userId: string } & SeedIds> {
  const { userId } = await makeTestUser(db, { timezone: TZ, units: "km", weightUnit: "lb", raceDate: "2026-06-20", raceDistanceKm: 21.1, ...prefs });
  const ids = await seedRows(db, userId, "");
  return { userId, ...ids };
}

/**
 * The plans of an owner-shaped account (training lines, final review I3), added to an athlete's rows:
 *  - a running line of four abutting phases — the bridge done, the base under way, the build and the taper ahead to the
 *    race — each week a row (firm while its sessions are placed, shape after, with its volume and key sessions), and
 *    the sessions of its firm weeks (four or five a week; those behind today done, one skipped);
 *  - the coach's three buckets of one-offs, three sessions each;
 *  - a 24-week Studio plan of three sessions a week (the athlete's Studio sessions, filed under `studio-<user>`, are
 *    its), with a push for each session: verified behind today, pending ahead.
 * Synthetic names; every date on the fixed clock.
 */
export async function seedOwnerPlans(db: Db, userId: string): Promise<{ phases: string[]; studioPlanId: string }> {
  const key = userId.slice(0, 8);
  const monday = "2026-05-11"; // this week's
  const stamp = at(day(60));
  const shape = (n: number) => ({ volumeTarget: `about ${36 + 2 * n} km, one long run`, keySessions: [`long run ${14 + n} km`, "tempo 25 min", "strides 6×20 s"] });
  const phases = [
    { id: `cp-${key}-bridge`, name: "Bridge block", status: "completed", start: addDays(monday, -28), weeks: 3, firm: 3, race: null },
    { id: `cp-${key}-base`, name: "Base block", status: "active", start: addDays(monday, -7), weeks: 4, firm: 3, race: null },
    { id: `cp-${key}-build`, name: "Race build", status: "active", start: addDays(monday, 21), weeks: 4, firm: 0, race: null },
    { id: `cp-${key}-taper`, name: "Taper to the half", status: "active", start: addDays(monday, 49), weeks: 2, firm: 0, race: addDays(monday, 62) },
  ];
  let n = 0;
  for (const p of phases) {
    await db.insert(schema.coachPlans).values({
      id: p.id, userId, discipline: "run", name: p.name, status: p.status, startDate: p.start, endDate: addDays(p.start, 7 * p.weeks - 1),
      raceDate: p.race, stampPrefix: p.name, createdAt: stamp, updatedAt: stamp,
    });
    for (let w = 0; w < p.weeks; w++) {
      const weekStart = addDays(p.start, 7 * w);
      const firm = w < p.firm;
      await db.insert(schema.coachPlanWeeks).values({ id: `${p.id}-${weekStart}`, planId: p.id, weekStart, state: firm ? "firm" : "shape", shape: firm ? null : shape(n + w) });
      if (!firm) continue;
      for (const [d, category, minutes] of [[1, "easy", 45], [2, "quality", 55], [4, "easy", 40], [6, "long", 95], [5, "recovery", 30]] as const) {
        if (d === 5 && w % 2 === 1) continue;
        const date = addDays(weekStart, d);
        const id = `${p.id}-${date}`;
        await db.insert(schema.plannedWorkouts).values({
          id, userId, planId: p.id, sourceWorkoutId: id, title: `${category === "long" ? "Long run" : category === "quality" ? "Tempo" : "Easy run"} ${minutes} min`,
          category, sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp",
          sourceEstimatedDurationSeconds: minutes * 60, calendarBlockDurationSeconds: minutes * 60 + 900, origin: "coach",
          completionState: date >= TODAY ? "scheduled" : date === addDays(monday, -6) ? "skipped" : "completed", createdAt: stamp, updatedAt: stamp,
        });
      }
    }
    n += p.weeks;
  }

  // The coach's one-offs, a bucket a discipline.
  for (const [discipline, sport, category] of [["run", "run", "easy"], ["lift", "strength", "strength"], ["mobility", "mobility", "yoga"]] as const) {
    const id = `adhoc-${discipline}-${key}`;
    const dates = [day(12), day(3), day(-4)];
    await db.insert(schema.coachPlans).values({
      id, userId, discipline, name: "Coach one-offs", status: "active", startDate: dates[0]!, endDate: dates[2]!, raceDate: null, stampPrefix: "Coach", createdAt: stamp, updatedAt: stamp,
    });
    for (const date of dates) {
      const sid = `${id}-${date}`;
      await db.insert(schema.plannedWorkouts).values({
        id: sid, userId, planId: id, sourceWorkoutId: sid, title: `One-off ${sport}`, category, sport, originalPlanDate: date, lastVerifiedCorosDate: date,
        effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 2700,
        origin: "coach", completionState: date >= TODAY ? "scheduled" : "completed", createdAt: stamp, updatedAt: stamp,
      });
    }
  }

  // The Studio plan: 24 weeks from 2 March, three sessions a week, each pushed.
  const studioPlanId = `studio-${userId}`;
  const start = "2026-03-02";
  const brief = { goal: "general", durationWeeks: 24, sessionsPerWeek: 3, sessionMinutes: 45, startDate: start };
  const moves = ["gobletSquat", "suitcaseDeadlift", "bandRow", "deadBug", "splitSquat", "pushUp"];
  const weeks = Array.from({ length: 24 }, (_, w) => ({
    week: w + 1,
    sessions: [0, 2, 4].map((d, s) => ({
      day: addDays(start, 7 * w + d),
      title: `W${w + 1} — ${["Lower", "Upper", "Full body"][s]}`,
      exercises: moves.slice(s, s + 4).map((exerciseId, k) => ({ exerciseId, sets: 3, reps: 8 + 2 * (w % 3), restSeconds: 90, order: k + 1 })),
    })),
  }));
  await db.insert(schema.studioPlans).values({ id: studioPlanId, userId, brief, plan: { name: "Full Body Strength", brief, weeks }, version: 3, createdAt: at("2026-02-27"), updatedAt: at(day(20)) });
  for (const w of weeks) {
    for (const s of w.sessions) {
      await db.insert(schema.studioPlanPushes).values({
        id: `${studioPlanId}-${s.day}`, planId: studioPlanId, planVersion: 3, happenDay: s.day, sessionTitle: s.title, status: s.day < TODAY ? "verified" : "pending", updatedAt: at(day(20)),
      });
    }
  }
  return { phases: phases.map((p) => p.id), studioPlanId };
}

/** Another account: the same shape of rows, every text a sentinel — none of it may ever reach the first athlete. */
export async function seedOtherAthlete(db: Db): Promise<{ userId: string } & SeedIds> {
  const { userId } = await makeTestUser(db, { timezone: TZ });
  const ids = await seedRows(db, userId, OTHER_SENTINEL);
  return { userId, ...ids };
}

async function seedRows(db: Db, userId: string, tag: string): Promise<SeedIds> {
  const t = (text: string): string => (tag ? `${tag} ${text}` : text);
  const placeId = newId();
  const gymId = newId();
  await db.insert(schema.locations).values([
    { id: placeId, userId, name: t("Garage"), equipment: ["mat", "dumbbells", "bench", "band"], implements: { dumbbells: t("10, 20, 35 lb") }, isDefault: true, createdAt: at(day(200)), updatedAt: at(day(200)) },
    { id: gymId, userId, name: t("Gym"), equipment: ["barbell", "cable", "machine", "dumbbells", "kettlebell", "bench"], implements: {}, isDefault: false, createdAt: at(day(150)), updatedAt: at(day(150)) },
  ]);
  await db.insert(schema.athleteProfiles).values({
    id: userId,
    userId,
    goals: [
      { id: "posture", words: t("Stand taller at my desk") },
      { id: "speed", words: t("A faster half marathon") },
      { id: "strength", words: t("Squat with confidence") },
    ],
    focusAreas: [
      { id: "upper-back", label: t("Upper back"), refs: ["upper-back", "thoracic"], note: t("Stiff after long meetings") },
      { id: "calves", label: t("Calves"), refs: ["calves"] },
      // A region and one of its own muscles: a set that trains both counts once.
      { id: "mid-back", label: t("Mid-back"), refs: ["upper-back", "rhomboids"] },
    ],
    events: [
      { id: "ev-half", label: t("Spring half"), kind: "race", start: "2026-06-20", priority: "A", taper: true },
      { id: "ev-trip", label: t("Coast trip"), kind: "trip", start: "2026-07-01", end: "2026-07-08", priority: "C", taper: false },
      { id: "ev-past", label: t("Winter 10K"), kind: "race", start: "2026-02-01", priority: "B", taper: true },
    ],
    preferences: { sessionMinutes: { default: 35, max: 50 }, trainingDays: [0, 2, 4, 5], defaultPlaceId: placeId },
    updatedAt: at(day(30)),
  });
  await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: day(120), settings: {} });

  // ── Sessions: every other day for two months, four moves each, checks before and after ──
  const sessions: Array<{ id: string; date: string }> = [];
  for (let n = 1; n <= 59; n += 2) {
    const id = newId();
    const date = day(n);
    sessions.push({ id, date });
    await db.insert(schema.performedSessions).values({
      id,
      userId,
      source: "app",
      localDate: date,
      startedAt: at(date, "07:00"),
      seconds: 1800 + n * 10,
      minutes: 30,
      mode: n % 3 === 0 ? "consistent" : "build",
      theme: "fullBody",
      completed: true,
      movesDone: [
        { exerciseId: "catCow", seconds: 120 },
        { exerciseId: "gobletSquat", seconds: 240 },
        { exerciseId: "wallSit", seconds: 130 },
      ],
      note: n % 5 === 0 ? t("Felt strong, slept well") : null,
      payloadHash: `h-${n}`,
      createdAt: at(date, "07:40"),
      updatedAt: at(date, "07:40"),
    });
    const set = (entryIndex: number, exerciseId: string, setIndex: number, o: Partial<typeof schema.performedSets.$inferInsert>) => ({
      id: newId(),
      performedSessionId: id,
      entryIndex,
      exerciseId,
      setIndex,
      ...o,
    });
    for (const row of [
      set(0, "gobletSquat", 0, { reps: 8, loadValue: 35, loadUnit: "lb", loadKg: 15.88 }),
      set(0, "gobletSquat", 1, { reps: 8, loadValue: 35, loadUnit: "lb", loadKg: 15.88 }),
      set(0, "gobletSquat", 2, { reps: 6, loadValue: 35, loadUnit: "lb", loadKg: 15.88 }),
      set(1, "wallSit", 0, { seconds: 45 }),
      set(1, "wallSit", 1, { seconds: 45 }),
      set(1, "wallSit", 2, { seconds: 40 + (n % 7) }),
      set(2, "deadBug", 0, { reps: 10, perSide: true }),
      set(2, "deadBug", 1, { reps: 10, perSide: true }),
      set(3, "bandRow", 0, { reps: 12 }),
      set(3, "bandRow", 1, { reps: 12 }),
      set(3, "bandRow", 2, { reps: 12, flags: n % 6 === 1 ? ["clenched"] : [] }),
      // Not done: never shown.
      set(3, "bandRow", 3, { reps: 4, done: false }),
    ]) {
      await db.insert(schema.performedSets).values(row);
    }
    await db.insert(schema.conditionChecks).values([
      { id: newId(), userId, profileId: "tmj", kind: "pre", value: 2, localDate: date, at: at(date, "06:58"), performedSessionId: id },
      { id: newId(), userId, profileId: "tmj", kind: "post", value: n % 4 === 1 ? 4 : 2, localDate: date, at: at(date, "07:41"), performedSessionId: id },
    ]);
  }
  // A strength activity the app session on day(3) logged, and the watch's derived copy of it: one session counts once.
  const strengthActivity = newId();
  await db.insert(schema.activities).values({
    id: strengthActivity, userId, source: "coros", startTime: at(day(3), "07:00"), startTimeLocal: `${day(3)}T07:00:00`, sport: "strength",
    durationSeconds: 1900, avgHeartRate: 112, trainingLoad: 40, title: t("Strength"), createdAt: at(day(3)), updatedAt: at(day(3)),
  });
  const day3 = sessions.find((s) => s.date === day(3))!;
  await db.update(schema.performedSessions).set({ activityId: strengthActivity }).where(eqId(day3.id));
  const watchCopy = newId();
  await db.insert(schema.performedSessions).values({
    id: watchCopy, userId, source: "watch", sourceRef: `w-${userId}`, activityId: strengthActivity, localDate: day(3), seconds: 1900,
    movesDone: [], payloadHash: "w", createdAt: at(day(3), "08:00"), updatedAt: at(day(3), "08:00"),
  });
  await db.insert(schema.performedSets).values({ id: newId(), performedSessionId: watchCopy, entryIndex: 0, exerciseId: "sentinelWatchCopyMove", setIndex: 0, reps: 99 });
  // A watch session still being written: absent everywhere.
  const pending = newId();
  await db.insert(schema.performedSessions).values({
    id: pending, userId, source: "watch", sourceRef: `p-${userId}`, localDate: day(1), seconds: 600, payloadHash: "pending",
    createdAt: at(day(1)), updatedAt: at(day(1)),
  });
  await db.insert(schema.performedSets).values({ id: newId(), performedSessionId: pending, entryIndex: 0, exerciseId: "sentinelPendingMove", setIndex: 0, reps: 99 });

  // ── Runs every third day, a yoga class ──
  for (let n = 2; n <= 59; n += 3) {
    const date = day(n);
    const meters = n === 5 ? 5000 : 6000 + (n % 4) * 1000;
    const seconds = Math.round((meters / 1000) * (330 + (n % 5) * 5));
    await db.insert(schema.activities).values({
      id: newId(), userId, source: "coros", startTime: at(date, "18:00"), startTimeLocal: `${date}T18:00:00`, sport: "run",
      durationSeconds: seconds, distanceMeters: meters, avgHeartRate: 146 + (n % 6), avgPaceSecPerKm: seconds / (meters / 1000), trainingLoad: 60 + n,
      telemetry: { feelRating: 4, sportNote: t("Legs heavy on the hills"), aerobicEffect: 3.1 }, title: t("Evening run"),
      createdAt: at(date, "19:00"), updatedAt: at(date, "19:00"),
    });
  }
  await db.insert(schema.activities).values({
    id: newId(), userId, source: "coros", startTime: at(day(4), "12:00"), startTimeLocal: `${day(4)}T12:00:00`, sport: "yoga",
    durationSeconds: 3600, avgHeartRate: 88, createdAt: at(day(4)), updatedAt: at(day(4)),
  });

  // ── Wellness: thirty mornings, threshold pace for the key results ──
  for (let n = 0; n < 30; n++) {
    const date = day(n);
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${date}`, userId, date, restingHeartRate: 50 + (n % 3), hrv: 58 - (n % 5), recoveryScore: 70 + (n % 10), trainingLoad7d: 400 + n,
      loadRatio: 1.1, sleepHrvBase: 56, sleepHrvSd: 5, thresholdPaceSecPerKm: 300 - (n % 4), contentFingerprint: "fp", updatedAt: at(date),
    });
    await db.insert(schema.sleepRecords).values({
      id: `${userId}:${date}`, userId, date, durationSeconds: 25_200 + (n % 4) * 600, qualityScore: 78, contentFingerprint: "fp", updatedAt: at(date),
    });
    await db.insert(schema.conditionChecks).values({
      id: newId(), userId, profileId: "tmj", kind: "daily", value: n === 0 ? 2 : n % 4, feelingOff: false, localDate: date, at: at(date, "07:40"),
    });
  }

  // ── A programme with its block, and the plan ──
  const programId = newId();
  await db.insert(schema.programs).values({
    id: programId, userId, kind: "adaptive", name: t("Strength block"), status: "active", disciplines: ["strength"],
    config: { weeklyGoal: 3 }, createdAt: at(day(40)), updatedAt: at(day(40)),
  });
  await db.insert(schema.programBlocks).values({
    id: newId(), programId, number: 2, kind: "core_block", startDate: day(14), weeks: 5,
    intent: { core: { squat: "gobletSquat", hinge: "suitcaseDeadlift", row: "bandRow", press: null }, rotations: [] },
    createdAt: at(day(14)), updatedAt: at(day(14)),
  });
  const planned = async (o: {
    date: string; time?: string; category: string; sport?: string; origin?: string | null; planId?: string; state?: string; content?: string | null;
    doc?: WorkoutDoc; rev?: number; title?: string; archived?: boolean; minutes?: number;
  }): Promise<string> => {
    const id = newId();
    await db.insert(schema.plannedWorkouts).values({
      id, userId, planId: o.planId ?? "coros-plan", sourceWorkoutId: id, title: t(o.title ?? (o.doc ? o.doc.title : "Easy run")), category: o.category,
      sport: o.sport ?? "run", originalPlanDate: o.date, lastVerifiedCorosDate: o.date, effectiveDate: o.date, effectiveTime: o.time ?? "18:00",
      sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: (o.minutes ?? 40) * 60, calendarBlockDurationSeconds: (o.minutes ?? 40) * 60 + 900,
      completionState: o.state ?? "scheduled", origin: o.origin ?? null, contentState: o.content ?? null,
      workoutDoc: o.doc ? JSON.stringify(o.doc) : null, workoutDocRev: o.doc ? (o.rev ?? 1) : null,
      archivedAt: o.archived ? at(day(1)) : null, createdAt: at(day(40)), updatedAt: at(day(40)),
    });
    return id;
  };
  const outlineToday = await planned({ date: TODAY, time: "07:00", category: "strength", sport: "strength", origin: "program", planId: programId, content: "outline", title: "Strength", minutes: 35 });
  const todayDocId = await planned({ date: TODAY, time: "18:00", category: "strength", sport: "strength", origin: "studio", planId: `studio-${userId}`, doc: studioDoc({ title: t("Strong hips, easy back") }), rev: 2 });
  const pastDocId = await planned({ date: day(3), time: "07:00", category: "strength", sport: "strength", origin: "studio", planId: `studio-${userId}`, doc: studioDoc({ title: t("Hips and rows") }), state: "completed" });
  await db.update(schema.performedSessions).set({ workoutId: pastDocId }).where(eqId(day3.id));
  const archivedDocId = await planned({ date: day(2), category: "strength", sport: "strength", origin: "studio", doc: studioDoc({ title: t("Archived") }), archived: true });
  for (let n = 1; n <= 30; n++) {
    if (n % 2 === 0) await planned({ date: day(-n), time: "07:00", category: "strength", sport: "strength", origin: "program", planId: programId, content: "outline", title: "Strength", minutes: 35 });
    if (n % 3 === 0) await planned({ date: day(-n), category: n % 9 === 0 ? "long" : "easy", minutes: n % 9 === 0 ? 90 : 45 });
    if (n % 7 === 0) await planned({ date: day(-n), time: "12:00", category: "strength", sport: "strength", origin: "template", planId: `studio-${userId}`, doc: studioDoc({ title: t(`Template day ${n}`) }) });
  }
  for (let n = 5; n <= 25; n += 5) {
    await planned({ date: day(n), time: "07:00", category: "strength", sport: "strength", origin: "studio", planId: `studio-${userId}`, doc: studioDoc({ title: t(`Studio ${n}`) }), state: "completed" });
  }

  // ── Check-ins and feedback ──
  const answer = (o: { q: string; date: string; kind?: string; subject?: string; num?: number; choice?: string; text?: string; source?: string; workoutId?: string; hhmm?: string }) => ({
    id: newId(), userId, questionId: o.q, subjectKind: o.kind ?? null, subjectId: o.subject ?? null, valueNum: o.num ?? null, valueChoice: o.choice ?? null,
    text: o.text ? t(o.text) : null, source: o.source ?? "checkin", localDate: o.date, at: at(o.date, o.hhmm ?? "08:00"), workoutId: o.workoutId ?? null,
  });
  const answers = [
    answer({ q: "soreness", date: day(1), kind: "region", subject: "calves", num: 6, text: "Calves tight after the hills" }),
    answer({ q: "soreness", date: day(1), kind: "region", subject: "hamstrings", num: 3, hhmm: "07:59" }),
    answer({ q: "tightness", date: day(2), kind: "region", subject: "hips", num: 5, text: "Tight after the long drive" }),
    answer({ q: "pain", date: day(5), kind: "region", subject: "low-back", num: 2 }),
    answer({ q: "exercise_feedback", date: day(3), kind: "exercise", subject: "gobletSquat", choice: "loved", text: "Felt great", source: "session_post" }),
    answer({ q: "workout_feedback", date: day(3), kind: "workout", subject: pastDocId, num: 4, text: "Just right", source: "session_post", workoutId: pastDocId }),
  ];
  for (let n = 0; n < 40; n++) answers.push(answer({ q: "energy", date: day(n), num: 5 + (n % 4), hhmm: "07:45" }));
  for (const a of answers) await db.insert(schema.athleteAnswers).values(a);

  // ── Objectives across every measure family ──
  await db.insert(schema.objectives).values([
    { id: `${userId}-obj-hold`, userId, title: t("Hold a strong wall sit"), why: t("Ski legs"), status: "active", goalIds: ["strength"], sort: 0, createdAt: at(day(60)), updatedAt: at(day(60)) },
    { id: `${userId}-obj-run`, userId, title: t("A faster half"), status: "active", goalIds: ["speed"], sort: 1, createdAt: at(day(60)), updatedAt: at(day(60)) },
    // Sorted first by the athlete, but paused: it still comes after the active ones.
    { id: `${userId}-obj-paused`, userId, title: t("Paused objective"), status: "paused", sort: -1, createdAt: at(day(60)), updatedAt: at(day(60)) },
    { id: `${userId}-obj-dropped`, userId, title: t("DROPPED-OBJECTIVE"), status: "dropped", sort: 3, createdAt: at(day(60)), updatedAt: at(day(60)) },
  ]);
  const kr = (objectiveId: string, label: string, measure: Record<string, unknown>, unit: string, o: { target?: number; baseline?: number; direction?: string; position?: number } = {}) => ({
    id: newId(), userId, objectiveId, label: t(label), measure, direction: o.direction ?? "up", baseline: o.baseline ?? null, target: o.target ?? null, unit,
    position: o.position ?? 0, createdAt: at(day(60)), updatedAt: at(day(60)),
  });
  for (const row of [
    kr(`${userId}-obj-hold`, "Wall sit hold", { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 }, "s", { target: 90, baseline: 40 }),
    kr(`${userId}-obj-hold`, "Goblet squat estimated max", { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays: 90 }, "lb", { target: 60, position: 1 }),
    kr(`${userId}-obj-run`, "5K time", { kind: "run_best", distanceM: 5000, windowDays: 180 }, "s", { direction: "down", target: 1500 }),
    kr(`${userId}-obj-run`, "Pace at easy heart rate", { kind: "pace_at_hr", hrLow: 140, hrHigh: 155, minDurationSec: 1200, windowDays: 90 }, "s/km", { direction: "down", position: 1 }),
    kr(`${userId}-obj-run`, "Threshold pace", { kind: "threshold_pace", windowDays: 90 }, "s/km", { direction: "down", position: 2 }),
    kr(`${userId}-obj-run`, "Predicted half", { kind: "predicted_time", distanceM: 21097, windowDays: 90 }, "min", { direction: "down", position: 3 }),
    kr(`${userId}-obj-paused`, "Energy", { kind: "checkin", questionId: "energy" }, "score"),
  ]) {
    await db.insert(schema.keyResults).values(row);
  }

  // ── Templates ──
  for (let n = 0; n < 20; n++) {
    await db.insert(schema.workoutTemplates).values({
      id: newId(), userId, name: t(`Saved workout ${n}`), doc: JSON.stringify(studioDoc({ title: t(`Saved workout ${n}`) })), pinned: n < 2, uses: n,
      lastUsedAt: n % 3 === 0 ? at(day(n)) : null, createdAt: at(day(100 - n)), updatedAt: at(day(100 - n)),
    });
  }

  // ── Proposals ──
  const statuses = ["approved", "declined", "superseded", "expired", "approved", "declined", "pending", "approved", "declined", "approved", "expired", "approved", "declined", "rehearsal"];
  for (let n = 0; n < statuses.length; n++) {
    const created = at(day(2 * n + 1), "10:00");
    await db.insert(schema.coachProposals).values({
      id: `${userId}-prop-${n}`, userId, title: t(statuses[n] === "rehearsal" ? "REHEARSAL-PROPOSAL" : `Proposal ${n}`), evidence: t("Two hard days in a row"),
      rationale: t("Ease Thursday so Saturday's long run lands fresh"), flags: [], status: statuses[n]!,
      ops: n % 2 === 0
        ? [{ kind: "doc_workout", target: { kind: "new", date: day(2 * n) }, date: day(2 * n), doc: { title: t(`Designed ${n}`) } }]
        : [{ kind: "move", workoutId: "w-1", toDate: day(2 * n), toTime: null }, { kind: "skip", workoutId: "w-2", reason: null }],
      createdAt: created, expiresAt: at(day(2 * n - 7)), resolvedAt: statuses[n] === "pending" ? null : at(day(2 * n), "12:00"),
    });
  }

  // ── Memory: a pinned core, more beyond it, and rows recall never shows ──
  const memory = (o: { kind: string; body: string; pinned?: boolean; confidence?: string; learned?: number; superseded?: boolean; active?: boolean; expires?: string; rehearsal?: boolean; evidence?: unknown }) => ({
    id: newId(), userId, kind: o.kind, body: t(o.body), provenance: { source: "message", at: at(day(o.learned ?? 10)), ...(o.rehearsal ? { rehearsal: true } : {}) } as { source: string; at: string },
    learnedAt: at(day(o.learned ?? 10)), expiresAt: o.expires ?? null, active: o.active ?? true, pinned: o.pinned ?? false, confidence: o.confidence ?? "stated",
    supersededBy: o.superseded ? "newer" : null, evidence: o.evidence === undefined ? null : JSON.stringify(o.evidence), updatedAt: null,
  });
  const rows = [
    memory({ kind: "rule", body: "Prefers to train before work", pinned: true }),
    memory({ kind: "fact", body: "Has a standing desk", pinned: true }),
    memory({ kind: "observation", body: "Squats feel better after a long warm-up", pinned: true, confidence: "inferred", evidence: { sessions: 3 } }),
  ];
  for (let n = 0; n < 18; n++) rows.push(memory({ kind: n % 2 ? "fact" : "rule", body: `Core item ${n}`, learned: n + 1 }));
  for (let n = 0; n < 14; n++) {
    rows.push(memory({ kind: n % 2 ? "note" : "observation", body: `Beyond the core ${n}: likes ${n % 3 ? "hills" : "intervals"}`, learned: 20 + n, confidence: n % 2 ? "stated" : "inferred", evidence: n % 2 ? undefined : { runs: n } }));
  }
  rows.push(
    memory({ kind: "note", body: "SUPERSEDED-MEMORY", superseded: true }),
    memory({ kind: "note", body: "INACTIVE-MEMORY", active: false }),
    memory({ kind: "note", body: "EXPIRED-MEMORY", expires: day(2) }),
    memory({ kind: "note", body: "REHEARSAL-MEMORY", rehearsal: true }),
    memory({ kind: "note", body: "Trip ends soon", expires: day(-5), learned: 40 }),
  );
  for (const row of rows) await db.insert(schema.coachMemory).values(row);

  // ── Exercise preferences and a saved move ──
  await db.insert(schema.exercisePrefs).values([
    { id: `${userId}:gobletSquat`, userId, exerciseId: "gobletSquat", rating: 1, pinned: true, excluded: false, introducedOn: day(90), updatedAt: at(day(5)) },
    { id: `${userId}:wallSit`, userId, exerciseId: "wallSit", rating: -1, pinned: false, excluded: false, updatedAt: at(day(5)) },
    { id: `${userId}:splitSquat`, userId, exerciseId: "splitSquat", rating: null, pinned: false, excluded: true, updatedAt: at(day(5)) },
  ]);
  await db.insert(schema.exerciseProvenance).values({ id: newId(), userId, exerciseId: "deadBug", sourceType: "video", url: null, creator: null, createdAt: at(day(50)) });

  return { placeId, gymId, programId, todayDocId, pastDocId, archivedDocId, outlineToday, sessionDay3: day3.id };
}

const eqId = (id: string) => eq(schema.performedSessions.id, id);
