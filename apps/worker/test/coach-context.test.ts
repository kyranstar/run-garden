/**
 * Dossier golden test (Plan A Task A5, spec §2): all eight sections present,
 * unknowns explicit, deterministic given fixed rows, inside the token budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { initialSnapshot } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import { buildDossier } from "../src/services/coach-context.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const SECTIONS = [
  "ATHLETE",
  "PLANS",
  "STRENGTH PLAN",
  "UPCOMING 14 DAYS",
  "HISTORY 90D",
  "LAST 14 DAYS",
  "WELLNESS 14D",
  "SIGNALS",
  "MILESTONES",
  "OPEN ITEMS",
  "CONVERSATION TAIL",
];

describe("buildDossier", () => {
  it("renders all sections with explicit unknowns on an empty account", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    for (const s of SECTIONS) expect(d.sections).toContain(s);
    expect(d.text).toContain("no coached plans");
    expect(d.text).toContain("can be skipped or moved by proposal");
    expect(d.text).toContain("nothing scheduled in the next 14 days");
    expect(d.text).toContain("no sessions recorded");
    expect(d.text).toContain("none pending");
    // Readiness is the dossier's opening fact about the athlete — and on an
    // empty account it is an explicit unknown, never an assumed-fine.
    expect(d.text).toContain("readiness today: unknown — too little recent COROS wellness data");
    // An account with no synced catalog gets no EXERCISE CATALOG section —
    // an empty list would read as "this watch knows no exercises".
    expect(d.sections).not.toContain("EXERCISE CATALOG");
    expect(d.approxTokens).toBeLessThanOrEqual(20_000);
  });

  it("opens ATHLETE with the same readiness verdict the garden dock shows", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // A flat 14-day history (HRV 62 / RHR 46) with a rough morning on top:
    // RHR +8 is the poor signal, HRV is inside its noise band.
    for (let i = 0; i < 14; i++) {
      const date = addDays(today, -i);
      await db.insert(schema.dailyHealth).values({
        id: `${userId}:${date}`,
        userId,
        date,
        hrv: i === 0 ? 60 : 62,
        restingHeartRate: i === 0 ? 54 : 46,
        contentFingerprint: `h${i}`,
        updatedAt: nowInstant(),
      });
    }
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain(
      "readiness today: poor — RHR 8 bpm above your baseline · HRV 60 (base 62)",
    );
  });

  it("lists upcoming sessions with [wo:id] handles and marks imported ones", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const at = nowInstant();
    // A session from the imported COROS plan (planId is no coachPlans id) —
    // the live case: the coach must be able to name it to propose a skip.
    await db.insert(schema.plannedWorkouts).values({
      id: "up-imported",
      userId,
      planId: "473846232060707016",
      sourceWorkoutId: "4738:9",
      title: "Long Run",
      category: "long",
      sport: "run",
      originalPlanDate: addDays(today, 3),
      lastVerifiedCorosDate: addDays(today, 3),
      effectiveDate: addDays(today, 3),
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 5400,
      createdAt: at,
      updatedAt: at,
    });
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain(`"Long Run" · run [wo:up-imported] · imported`);
  });

  it("is deterministic and carries memory ids, plan lines and wellness baselines", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const at = nowInstant();

    await db.insert(schema.coachMemory).values({
      id: "mem1",
      userId,
      kind: "rule",
      body: "Long runs stay on Saturdays",
      provenance: { source: "message", at },
      learnedAt: at,
      active: true,
    });
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: addDays(today, -14),
      endDate: addDays(today, 40),
      raceDate: addDays(today, 47),
      stampPrefix: "Fall Half",
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(schema.coachPlanWeeks).values({
      id: newId(),
      planId: "cp1",
      weekStart: addDays(today, 7),
      state: "shape",
      shape: { volumeTarget: "42k", keySessions: ["long 18k"] },
    });
    for (let i = 1; i <= 3; i++) {
      const date = addDays(today, -i);
      await db.insert(schema.sleepRecords).values({
        id: `${userId}:${date}`,
        userId,
        date,
        durationSeconds: 6 * 3600,
        contentFingerprint: `s${i}`,
        updatedAt: at,
      });
    }

    const a = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    const b = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(a.text).toBe(b.text);
    expect(a.text).toContain("rule [mem1]: Long runs stay on Saturdays");
    expect(a.text).toContain("plan [cp1] Fall Half · run · active");
    expect(a.text).toContain("shape wk");
    expect(a.text).toContain("30d sleep baseline: 6.0h");
    expect(a.text).toContain("sanctioned rest used 0 of 1 this rolling week");
    expect(a.text).toContain("HRV unknownms · RHR unknownbpm");
  });
});

describe("RECENT READS (2026-08-11 rework §3)", () => {
  it("carries glances completed since the last real briefing, capped at 7", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await db.insert(schema.coachMessages).values({
      id: newId(),
      userId,
      role: "coach",
      body: "old briefing",
      refs: {},
      at: "2026-08-01T00:00:00.000Z",
    });
    for (let i = 0; i < 9; i++) {
      await db.insert(schema.coachReads).values({
        id: newId(),
        userId,
        activityId: `act-${i}`,
        status: "done",
        attempt: 1,
        nextAttemptAt: nowInstant(),
        claimToken: null,
        claimedAt: null,
        glance: `glance number ${i}`,
        body: "…",
        flags: i === 8 ? ["hr_drift"] : [],
        model: "m",
        createdAt: nowInstant(),
        completedAt: `2026-08-0${Math.min(i + 1, 9)}T12:00:00.000Z`,
      });
    }
    const dossier = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(dossier.sections).toContain("RECENT READS");
    expect(dossier.text).toContain("glance number 8");
    expect(dossier.text).toContain("(hr_drift)");
    // Cap 7: the two oldest glances are not present.
    expect(dossier.text).not.toContain("glance number 0");
    expect(dossier.text).not.toContain("glance number 1");
  });

  it("omits the section when nothing new was read", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const dossier = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(dossier.sections).not.toContain("RECENT READS");
  });
});

/**
 * The 2026-08-16 input audit: everything the coach could not see, and the
 * specific bad advice each blindness produced. Fixtures below are shaped
 * after the live prod rows named in each case.
 */
describe("what the coach can see (2026-08-16 input audit)", () => {
  const at = "2026-08-16T12:00:00.000Z";

  const seedCatalog = async (db: ReturnType<typeof makeTestDb>) => {
    // Stored names are COROS i18n T-codes, never words — the whole reason
    // the catalog has to be resolved before the model reads it.
    for (const [id, code] of [
      ["469664622790754304", "T1367"], // Reverse Step-Down
      ["469664891494645760", "T1368"], // Copenhagen Plank
      ["426939619892969472", "T1174"], // Ski Step
    ] as const) {
      await db.insert(schema.corosExercises).values({ id, name: code, raw: { id }, updatedAt: at });
    }
  };

  const seedActivity = async (
    db: ReturnType<typeof makeTestDb>,
    userId: string,
    over: { sport: string; date: string; distanceMeters?: number },
  ) =>
    db.insert(schema.activities).values({
      id: newId(),
      userId,
      startTime: `${over.date}T15:00:00Z`,
      startTimeLocal: `${over.date}T08:00:00`,
      sport: over.sport,
      durationSeconds: 3000,
      distanceMeters: over.distanceMeters ?? null,
      sourceMergeConfidence: 1,
      createdAt: at,
      updatedAt: at,
    });

  it("renders the exercise catalog as names in words — no ids — at the very end", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedCatalog(db);
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    // The vocabulary, in words the model can match a prescription against.
    expect(d.text).toContain("Reverse Step-Down");
    expect(d.text).toContain("Copenhagen Plank");
    expect(d.text).toContain("Ski Step");
    // And NOT the 18-digit snowflakes (2026-08-17). They were ~7 tokens each
    // × 382 rows of input the model could never use: every exercise is
    // re-resolved from its NAME server-side and the model's id is overwritten.
    for (const id of ["469664622790754304", "469664891494645760", "426939619892969472"]) {
      expect(d.text, "catalog ids must not reach the model").not.toContain(id);
    }
    // Last, so defensive truncation eats it before anything else.
    expect(d.sections.at(-1)).toBe("EXERCISE CATALOG");
  });

  it("carries the athlete's own constraints, and what Wednesday already has", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const wednesday = addDays(today, 3);
    await db.insert(schema.studioPlans).values({
      id: "sp1",
      userId,
      brief: {
        goal: "general",
        durationWeeks: 16,
        sessionsPerWeek: 2,
        sessionMinutes: 45,
        preferredDays: [2, 3],
        equipment: "bodyweight and dumbells for the first week",
        constraints: "tight IT band, glutes, quads, shoulders, a bit of pelvic tilt",
        notes: "I haven't lifted in a long time. Tuesday I am also running and will likely run before this.",
        startDate: today,
      },
      plan: {
        name: "16-Week Posterior Chain",
        weeks: [
          {
            sessions: [
              {
                title: "W1 Wed - Posterior Chain Foundation (home)",
                weekday: 3,
                exercises: [
                  {
                    originId: "469646870080307200",
                    name: "Wall Sit",
                    sets: 3,
                    reps: 1,
                    weight: { type: "bodyweight" },
                    restSeconds: 60,
                    note: "Wall sit 30s. Ski quad base.",
                  },
                ],
              },
            ],
          },
        ],
      },
      version: 2,
      createdAt: at,
      updatedAt: at,
    });
    // The pushed workout's title is the Studio title plus a week suffix.
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-lift",
      userId,
      planId: "imported",
      sourceWorkoutId: "s1",
      title: "W1 Wed - Posterior Chain Foundation (home) — wk 1",
      category: "strength",
      sport: "strength",
      originalPlanDate: wednesday,
      lastVerifiedCorosDate: wednesday,
      effectiveDate: wednesday,
      effectiveTime: "18:00",
      sourceContentFingerprint: "fp-lift",
      calendarBlockDurationSeconds: 2700,
      stageSummary: "3 × open Wall Sit",
      createdAt: at,
      updatedAt: at,
    });

    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    // Verbatim, because a paraphrased injury list is one the coach can ignore.
    expect(d.text).toContain("tight IT band, glutes, quads, shoulders, a bit of pelvic tilt");
    expect(d.text).toContain("I haven't lifted in a long time");
    expect(d.text).toContain("Tuesday I am also running and will likely run before this");
    expect(d.text).toContain("preferred days: Tue, Wed");
    // The wall sit Wednesday already has — the coach prescribed a second one.
    expect(d.text).toContain("do not duplicate what is in it");
    expect(d.text).toContain("Wall Sit 3×1 bodyweight");
    // And the UPCOMING line no longer judges the session by its title alone.
    expect(d.text).toContain('· contains: 3 × open Wall Sit');
  });

  it("reads the plan's lifts in the athlete's weight unit, the prescription's kilos beside pounds (Audit 2c-A MINOR-5)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = "2026-10-05";
    const wednesday = addDays(today, 2);
    const at = "2026-10-01T12:00:00.000Z";
    const title = "W1 Wed - Goblet day";
    await db.insert(schema.studioPlans).values({
      id: "sp-units",
      userId,
      brief: { goal: "general", durationWeeks: 4, sessionsPerWeek: 1, sessionMinutes: 40, startDate: today },
      plan: {
        name: "Units",
        weeks: [{ sessions: [{ title, weekday: 3, exercises: [{ originId: "x-goblet", name: "Goblet Squat", sets: 3, reps: 8, weight: { type: "kg", value: 20 }, restSeconds: 90 }] }] }],
      },
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-goblet", userId, planId: "imported", sourceWorkoutId: "s-goblet", title: `${title} — wk 1`, category: "strength", sport: "strength",
      originalPlanDate: wednesday, lastVerifiedCorosDate: wednesday, effectiveDate: wednesday, effectiveTime: "18:00",
      sourceContentFingerprint: "fp-goblet", calendarBlockDurationSeconds: 2400, stageSummary: "3 × 8 Goblet Squat", createdAt: at, updatedAt: at,
    });
    const lb = await buildDossier(db, userId, { ...prefs, weightUnit: "lb" }, today);
    expect(lb.text).toContain("Goblet Squat 3×8 @ 44 lb (20 kg)");
    const kg = await buildDossier(db, userId, { ...prefs, weightUnit: "kg" }, today);
    expect(kg.text).toContain("Goblet Squat 3×8 @ 20 kg");
    expect(kg.text).not.toContain("44 lb");
  });

  it("names a placeholder session's actual contents on the UPCOMING line", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-mob",
      userId,
      planId: "imported",
      sourceWorkoutId: "s2",
      title: "W2 Tue - Vacation Placeholder - 10 min mobility",
      category: "strength",
      sport: "strength",
      originalPlanDate: addDays(today, 9),
      lastVerifiedCorosDate: addDays(today, 9),
      effectiveDate: addDays(today, 9),
      effectiveTime: "18:00",
      sourceContentFingerprint: "fp-mob",
      calendarBlockDurationSeconds: 600,
      stageSummary: "2 × open Cat-Cow Stretch · 2 × open Push-ups · 1 × open Cool Down",
      createdAt: at,
      updatedAt: at,
    });
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    // Zero lower-body content — which the coach called adequate ski coverage
    // from the title, because the title was all it had.
    expect(d.text).toContain("contains: 2 × open Cat-Cow Stretch · 2 × open Push-ups");
  });

  it("states detraining in words, and takes days-since-run from activities", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedActivity(db, userId, { sport: "run", date: addDays(today, -5), distanceMeters: 8000 });
    await seedActivity(db, userId, { sport: "ski", date: addDays(today, -134) });
    await seedActivity(db, userId, { sport: "strength", date: addDays(today, -225) });
    // The garden's own count is stale by two days — it is what said "3".
    const snap = initialSnapshot(addDays(today, -30));
    await db.insert(schema.gardenState).values({
      userId,
      simulationVersion: 6,
      lastSimulatedDate: addDays(today, -2),
      snapshot: {
        ...snap,
        state: { ...snap.state, daysSinceCompletedRun: 3 },
      } as unknown as Record<string, unknown>,
      updatedAt: at,
    });

    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain(`days since last run: 5 (last run ${addDays(today, -5)})`);
    expect(d.text).toContain("strength: 0 sessions in 90d · 1 all-time");
    expect(d.text).toContain("treat as untrained");
    expect(d.text).toContain("ski: 0 sessions in 90d · 1 all-time");
    // The garden number is gone as a bare fact, and what remains is dated.
    expect(d.text).toContain(`garden (simulation state as of ${addDays(today, -2)}, 2d stale)`);
    expect(d.text).not.toContain("3d since a run");
  });

  it("marks a frozen score, an absent reading, empty sleep, and a load collapse", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // Live shape: load 837 → 119, recovery pinned at 100, HRV/RHR gone on the
    // last two days, and not one sleep record in the database.
    const loads = [837, 834, 688, 482, 192, 119];
    for (let i = 0; i < loads.length; i++) {
      const date = addDays(today, -(loads.length - 1 - i));
      await db.insert(schema.dailyHealth).values({
        id: `${userId}:${date}`,
        userId,
        date,
        hrv: i >= 4 ? null : 62,
        restingHeartRate: i >= 4 ? null : 46,
        recoveryScore: i >= 2 ? 100 : null,
        trainingLoad7d: loads[i]!,
        contentFingerprint: `h${i}`,
        updatedAt: at,
      });
    }
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain("sleep: NO DATA AT ALL — sleep_records is empty");
    expect(d.text).toContain(`COROS 7-day training load: 119 on ${today}`);
    expect(d.text).toContain("-86% off peak — this is a COLLAPSE in load");
    expect(d.text).toContain("recovery: 100% UNCHANGED across the last 4 recorded days");
    expect(d.text).toContain(`HRV: NO READING on ${today}`);
    expect(d.text).toContain(`RHR: NO READING on ${today}`);
    // And the verdict itself stops claiming a clean bill of health off it.
    expect(d.text).toContain("readiness today: unknown");
  });

  it("renders distance and pace in the athlete's own unit", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { units: "mi" });
    const today = todayInZone(prefs.timezone);
    await seedActivity(db, userId, { sport: "run", date: addDays(today, -2), distanceMeters: 8046.72 });
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain('units: miles');
    expect(d.text).toContain("5mi in 90d");
    expect(d.text).toContain("unplanned run · 50min 5.0mi");
    expect(d.text).not.toContain("8.0km");
  });

  it("drops the catalog before it drops the athlete's constraints", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seedCatalog(db);
    await db.insert(schema.studioPlans).values({
      id: "sp2",
      userId,
      brief: { constraints: "tight IT band and a bad wrist" },
      plan: { name: "Lift", weeks: [] },
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    // A pathological conversation tail: ten messages of 40k characters each
    // is far past any budget, so truncation has to choose.
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.coachMessages).values({
        id: newId(),
        userId,
        role: "user",
        body: "x".repeat(40_000),
        refs: {},
        at: `2026-08-1${i}T00:00:00.000Z`,
      });
    }
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.sections).not.toContain("EXERCISE CATALOG");
    expect(d.sections).toContain("STRENGTH PLAN");
    expect(d.text).toContain("tight IT band and a bad wrist");
    // The loss is stated — a missing catalog must not read as "no exercises".
    expect(d.text).toContain("dropped to fit the context budget: EXERCISE CATALOG");
    expect(d.approxTokens).toBeLessThanOrEqual(20_000);
  });

  /**
   * LIMITS (2026-08-17). UPCOMING lists sessions without durations, so "does
   * Wednesday's lift already count as a hard day, and how much of the
   * cold-start budget does it spend?" — a question with a numeric answer the
   * validator computes to the minute — could not be answered from the
   * dossier at all. The coach proposed 313 minutes of strength against a
   * 120-minute ceiling and learned both numbers from the rejection.
   */
  it("LIMITS states what is LEFT of each hard limit, from the guardrail's own calendar", async () => {
    const { guardrailCtx } = await import("../src/services/coach-wake.js");
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const wed = addDays(today, 3);
    await db.insert(schema.plannedWorkouts).values({
      id: "wed-lift",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:wed",
      title: "Posterior chain",
      category: "strength",
      sport: "strength",
      originalPlanDate: wed,
      lastVerifiedCorosDate: wed,
      effectiveDate: wed,
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 56 * 60,
      createdAt: at,
      updatedAt: at,
    });
    const guard = await guardrailCtx(db, userId, prefs, today);
    // `guard.today`, not a second read: the wake threads one date through both
    // (ONE CLOCK PER WAKE — coach-wake.ts), and the tests hold the same rule.
    const d = await buildDossier(db, userId, prefs, guard.today, guard);
    expect(d.sections).toContain("LIMITS");
    // No strength history, so the absolute ceiling applies — and 56 of it is
    // already spent by the athlete's own session.
    expect(d.text).toContain("COLD START");
    expect(d.text).toContain("holds 56min (64min left)");
    // Which day is already hard: unanswerable from UPCOMING's duration-less
    // lines, and the reason a 56-minute lift was invisible to the coach. The
    // wording says what the finding DOES now — adjacency is advisory, so the
    // athlete is told about a back-to-back pair, not refused one.
    expect(d.text).toContain(`is a back-to-back pair the athlete gets told about: ${wed}`);
    // …and LIMITS says so in its own header, because a model told a price is
    // a wall plans around it silently instead of naming it.
    expect(d.text).toContain("going past one does not reject anything");
    // Without a guardrail context the section is absent rather than guessed.
    expect((await buildDossier(db, userId, prefs, today)).sections).not.toContain("LIMITS");
  });
});

/**
 * WHICH SESSIONS CAN STILL BE CHANGED (2026-08-17).
 *
 * With the guardrail split and the schema's vocabulary fixed, the top remaining
 * cause of a refused proposal was `fatal:touch_resolved` — the coach easing or
 * skipping a session that was already done. It was a dossier defect, not a
 * model one: LAST 14 DAYS printed finished sessions with the same `[wo:...]`
 * handles as upcoming ones, and the wake prompt told the coach outright that
 * ease/move/skip "reach ANY session in UPCOMING or LAST 14 DAYS by its
 * [wo:...] id". The context invited the mistake and the validator punished it.
 *
 * The rule is now carried by the data: the handle IS the permission, printed
 * only beside a row that passes the same predicate `validateOps` tests. This
 * test asserts that as an INVARIANT over the whole rendered document rather
 * than as a string match, so it fails if any section — this one, STRENGTH
 * PLAN, or one written next year — prints a past session with a bare handle.
 */
describe("the dossier says which sessions can still be changed", () => {
  /** Every id the document offers as a handle. `[wo:...]` with a literal
   * ellipsis is the prose that EXPLAINS the convention, not an offer. */
  const handlesIn = (text: string): string[] =>
    [...text.matchAll(/\[wo:([^\]\s]+)\]/g)].map((m) => m[1]!).filter((id) => id !== "...");

  it("prints a [wo:...] handle for exactly the sessions an op may name", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const at = nowInstant();
    // Every combination of (which side of today) × (resolved or not), including
    // the two that a naive filter gets wrong: a session finished earlier TODAY
    // sits inside UPCOMING's window, and a session left "scheduled" after its
    // day went by looks addressable and is not.
    const rows: Array<{ id: string; date: string; state: string; sport: string; category: string }> = [
      { id: "ahead-scheduled", date: addDays(today, 3), state: "scheduled", sport: "run", category: "easy" },
      { id: "ahead-planned", date: addDays(today, 5), state: "planned", sport: "run", category: "long" },
      { id: "today-scheduled", date: today, state: "scheduled", sport: "run", category: "quality" },
      { id: "today-completed", date: today, state: "completed", sport: "run", category: "easy" },
      { id: "today-skipped", date: today, state: "skipped", sport: "run", category: "easy" },
      { id: "lift-ahead", date: addDays(today, 2), state: "scheduled", sport: "strength", category: "strength" },
      { id: "lift-done-today", date: today, state: "completed", sport: "strength", category: "strength" },
      { id: "past-completed", date: addDays(today, -2), state: "completed", sport: "run", category: "long" },
      { id: "past-missed", date: addDays(today, -5), state: "missed", sport: "run", category: "quality" },
      { id: "past-never-resolved", date: addDays(today, -3), state: "scheduled", sport: "run", category: "easy" },
    ];
    for (const r of rows) {
      await db.insert(schema.plannedWorkouts).values({
        id: r.id,
        userId,
        planId: "p1",
        sourceWorkoutId: `4738:${r.id}`,
        title: `Session ${r.id}`,
        category: r.category,
        sport: r.sport,
        originalPlanDate: r.date,
        lastVerifiedCorosDate: r.date,
        effectiveDate: r.date,
        effectiveTime: "07:00",
        completionState: r.state,
        sourceContentFingerprint: `fp-${r.id}`,
        calendarBlockDurationSeconds: 2400,
        createdAt: at,
        updatedAt: at,
      });
    }

    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    const handles = new Set(handlesIn(d.text));
    // The same predicate `validateOps` applies: unresolved, and its day has not
    // gone — plus the one op whose whole purpose is a RESOLVED row: `restore`
    // may name a skipped session dated today or later (audit 1, coach finding
    // 10). Written out here rather than imported so the two agreeing is a fact
    // this test checks instead of one it inherits.
    const mayName = rows
      .filter(
        (r) =>
          (r.state === "scheduled" || r.state === "planned" || r.state === "skipped") && r.date >= today,
      )
      .map((r) => r.id);
    expect([...handles].sort()).toEqual([...mayName].sort());
    // …and a skipped session's handle says which op it is for, so it is not
    // read as an invitation to ease or move a resolved row.
    expect(d.text).toContain("[wo:today-skipped] · skipped — restore is the only op that may name it");

    // …and the history is all still THERE. Withholding the handle must not
    // withhold the evidence: the coach's every claim rests on finished work, so
    // each of these rows keeps its date, its category and its outcome.
    for (const r of rows.filter((x) => !mayName.includes(x.id))) {
      expect(d.text, `${r.id} must still be visible as evidence`).toContain(r.date);
      expect(d.text).not.toContain(`[wo:${r.id}]`);
    }
    // The day that went by unmarked is named for what it is, not silently
    // rendered as if it were still on the calendar.
    expect(d.text).toContain("never resolved — the day went by without it being marked either way");
    // And the document states the convention once, in a section truncation
    // cannot drop, so the rule is readable from the text alone.
    expect(d.text).toContain("the [wo:...] handle IS the permission");
    expect(d.text).toContain("no [wo:...] handles in this section, on purpose");
    // A session finished earlier today is inside UPCOMING's window and says so
    // in place of its handle.
    expect(d.text).toContain("already completed, so no handle — it cannot be changed");
  });

  it("does not print one session twice with two different verdicts", async () => {
    // Today's still-scheduled session used to appear in UPCOMING with a handle
    // AND in LAST 14 DAYS without one (both windows include today), which is
    // one session and two contradictory lines.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const at = nowInstant();
    await db.insert(schema.plannedWorkouts).values({
      id: "only-today",
      userId,
      planId: "p1",
      sourceWorkoutId: "4738:only-today",
      title: "Threshold repeats",
      category: "quality",
      sport: "run",
      originalPlanDate: today,
      lastVerifiedCorosDate: today,
      effectiveDate: today,
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3000,
      createdAt: at,
      updatedAt: at,
    });
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(handlesIn(d.text)).toEqual(["only-today"]);
    expect(d.text.split("Threshold repeats").length - 1).toBe(1);
  });
});

/**
 * PLAN SHAPE (spec 2026-09-20 §4). Selectors address workouts by property, so
 * a handle is no longer needed to act — but the coach still has to KNOW a
 * block runs past the 14-day window, or it will never think to reach for it.
 * No handles here on purpose: this section is knowledge, not targets.
 */
describe("buildDossier · PLAN SHAPE", () => {
  async function seedBlock(db: Db, userId: string, today: string) {
    const at = nowInstant();
    // Lifts every Monday and Thursday for six weeks — well past UPCOMING's
    // fortnight, which is the whole point.
    for (let week = 0; week < 6; week++) {
      for (const [n, offset] of [1, 4].entries()) {
        const date = addDays(today, week * 7 + offset);
        await db.insert(schema.plannedWorkouts).values({
          id: `lift-${week}-${n}`,
          userId,
          planId: "blk",
          sourceWorkoutId: `s-${week}-${n}`,
          title: n === 0 ? "Lower Body" : "Upper Body",
          category: "strength",
          sport: "strength",
          originalPlanDate: date,
          lastVerifiedCorosDate: date,
          effectiveDate: date,
          effectiveTime: "07:00",
          completionState: "scheduled",
          sourceContentFingerprint: `fp-${week}-${n}`,
          calendarBlockDurationSeconds: 2700,
          createdAt: at,
          updatedAt: at,
        });
      }
    }
  }

  it("reports each discipline's count, span and usual days beyond the fortnight", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedBlock(db, userId, today);

    const d = await buildDossier(db, userId, prefs, today);
    expect(d.sections).toContain("PLAN SHAPE");
    const shape = d.text.split("## PLAN SHAPE")[1]!.split("##")[0]!;
    // 8, not 12: the four inside the fortnight are UPCOMING's job, and this
    // section exists to describe only what UPCOMING cannot show.
    expect(shape).toContain("strength · 8 sessions");
    expect(shape).toContain(addDays(today, 15)); // first one past the window
    expect(shape).toContain(addDays(today, 39)); // the last one, five weeks out
    // The days a selector would name, so the coach can describe the block.
    expect(shape).toMatch(/usually [A-Z][a-z]{2}, [A-Z][a-z]{2}/);
    // Knowledge, not targets: a handle here would invite an op on a session
    // UPCOMING deliberately did not offer.
    expect(shape).not.toContain("[wo:");
  });

  it("says so plainly when there is nothing past the fortnight", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.text).toContain("nothing is scheduled beyond the next 14 days");
  });
});

/**
 * RECENT STRENGTH DETAIL (spec 2026-09-20 §5; audit 2a+ X-1). The coach reads
 * the LOGGED sets of each recent lift — the athlete's own log, else the watch
 * session — never `activity_laps`: COROS stores every set beside its rest item
 * (and can send a second lap type of the same sets), so counting laps told the
 * coach at least twice the sets that were done.
 */
describe("buildDossier · RECENT STRENGTH DETAIL", () => {
  const TODAY = "2026-10-05";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T19:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const AT = "2026-10-05T19:00:00.000Z";
  async function strengthActivity(db: Db, userId: string, id: string, day: string, seconds = 2880) {
    await db.insert(schema.activities).values({
      id,
      userId,
      startTime: `${day}T17:00:00Z`,
      startTimeLocal: `${day}T10:00:00`,
      sport: "strength",
      durationSeconds: seconds,
      sourceMergeConfidence: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  }
  /** Laps as stored for a lift: every set followed by its rest item, both under the exercise's key. */
  async function setAndRestLaps(db: Db, activityId: string, keys: string[]) {
    let i = 0;
    for (const key of keys) {
      for (let n = 0; n < 2; n++) {
        await db.insert(schema.activityLaps).values({
          id: `${activityId}-lap-${i}`,
          activityId,
          lapIndex: i++,
          durationSeconds: 45,
          exerciseNameKey: key,
        });
      }
    }
  }
  type LoggedSet = { exerciseId: string; reps?: number; seconds?: number; load?: [number, "lb" | "kg"] };
  async function loggedSession(
    db: Db,
    userId: string,
    activityId: string,
    sets: LoggedSet[],
    opts: { source?: string; payloadHash?: string } = {},
  ) {
    const id = newId();
    await db.insert(schema.performedSessions).values({
      id,
      userId,
      activityId,
      source: opts.source ?? "watch",
      sourceRef: opts.source === "app" ? null : `lbl-${activityId}`,
      localDate: TODAY,
      payloadHash: opts.payloadHash ?? "h",
      createdAt: AT,
      updatedAt: AT,
    });
    let setIndex = 0;
    for (const s of sets) {
      await db.insert(schema.performedSets).values({
        id: newId(),
        performedSessionId: id,
        entryIndex: 0,
        exerciseId: s.exerciseId,
        setIndex: setIndex++,
        reps: s.reps ?? null,
        seconds: s.seconds ?? null,
        loadValue: s.load?.[0] ?? null,
        loadUnit: s.load?.[1] ?? null,
        loadKg: s.load ? (s.load[1] === "kg" ? s.load[0] : s.load[0] * 0.45359237) : null,
        done: true,
      });
    }
  }
  const section = (text: string): string[] =>
    text.split("## RECENT STRENGTH DETAIL\n")[1]!.split("\n\n")[0]!.split("\n");

  /** Bench 50/50/55 lb × 8/8/6, rows 12 kg × 10/9, two plank holds, one set of push-ups. */
  const WATCH_SETS: LoggedSet[] = [
    { exerciseId: "coros:T1041", reps: 8, load: [50, "lb"] },
    { exerciseId: "coros:T1041", reps: 8, load: [50, "lb"] },
    { exerciseId: "coros:T1041", reps: 6, load: [55, "lb"] },
    { exerciseId: "coros:T1055", reps: 10, load: [12, "kg"] },
    { exerciseId: "coros:T1055", reps: 9, load: [12, "kg"] },
    { exerciseId: "coros:T1010", seconds: 45 },
    { exerciseId: "coros:T1010", seconds: 40 },
    { exerciseId: "coros:T1004", reps: 15 },
  ];

  it("reads the logged sets — set count, reps, top weight in the athlete's unit, holds in seconds — never the laps", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { weightUnit: "lb" });
    await strengthActivity(db, userId, "act-lift", "2026-10-03");
    // 16 lap rows for 8 sets: what the old section counted.
    await setAndRestLaps(db, "act-lift", ["T1041", "T1041", "T1041", "T1055", "T1055", "T1010", "T1010", "T1004"]);
    await loggedSession(db, userId, "act-lift", WATCH_SETS);

    const d = await buildDossier(db, userId, prefs, TODAY);
    expect(section(d.text)).toEqual([
      `the sets logged in each recent strength session, per exercise: set count, reps (lowest–highest), seconds for holds, and the top weight in lb. From the athlete's own log where there is one, otherwise the watch. No weight listed means none was logged. "no set detail" means no sets were logged for that session, so never quote or assume its sets or loads — ask if it matters.`,
      "2026-10-03 · 48min · Bench Press 3 sets: 6–8 reps, top 55 lb · Dumbbell Row 2 sets: 9–10 reps, top 26.5 lb · Planks 2 sets: 40–45s · Push-ups 1 set: 15 reps",
    ]);

    // A kilograms athlete reads kilograms: 55 lb is 24.9 kg, to the half kilo; 12 kg stays as typed.
    const kg = await buildDossier(db, userId, { ...prefs, weightUnit: "kg" }, TODAY);
    const kgLines = section(kg.text);
    expect(kgLines[0]).toContain("the top weight in kg.");
    expect(kgLines[1]).toBe(
      "2026-10-03 · 48min · Bench Press 3 sets: 6–8 reps, top 25 kg · Dumbbell Row 2 sets: 9–10 reps, top 12 kg · Planks 2 sets: 40–45s · Push-ups 1 set: 15 reps",
    );
  });

  it("takes the athlete's own log over the watch copy of the same session", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { weightUnit: "lb" });
    await strengthActivity(db, userId, "act-lift", "2026-10-03");
    await loggedSession(db, userId, "act-lift", WATCH_SETS);
    await loggedSession(
      db,
      userId,
      "act-lift",
      [
        { exerciseId: "gobletSquat", reps: 10, load: [25, "lb"] },
        { exerciseId: "gobletSquat", reps: 8, load: [30, "lb"] },
      ],
      { source: "app" },
    );

    const lines = section((await buildDossier(db, userId, prefs, TODAY)).text);
    expect(lines.slice(1)).toEqual(["2026-10-03 · 48min · Goblet squat 2 sets: 8–10 reps, top 30 lb"]);
  });

  it('says "no set detail" when no sets are logged — never a count from the laps', async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    // Exercise laps, no logged session.
    await strengthActivity(db, userId, "act-laps-only", "2026-10-03", 1800);
    await setAndRestLaps(db, "act-laps-only", ["T1041", "T1041", "T1055"]);
    // A watch session still being written is not there yet.
    await strengthActivity(db, userId, "act-pending", "2026-10-01", 2400);
    await setAndRestLaps(db, "act-pending", ["T1041"]);
    await loggedSession(db, userId, "act-pending", WATCH_SETS, { payloadHash: "pending" });
    // No exercise laps and nothing logged: nothing to describe, as before.
    await strengthActivity(db, userId, "act-bare", "2026-09-30", 1200);

    const lines = section((await buildDossier(db, userId, prefs, TODAY)).text);
    expect(lines.slice(1)).toEqual(["2026-10-03 · 30min · no set detail", "2026-10-01 · 40min · no set detail"]);
  });

  it("stays bounded: the five latest sessions, at most twelve exercises each", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    for (let i = 0; i < 6; i++) {
      const id = `act-${i}`;
      await strengthActivity(db, userId, id, addDays(TODAY, -1 - i), 3600);
      const moves = i === 0 ? 14 : 1;
      await loggedSession(
        db,
        userId,
        id,
        Array.from({ length: moves }, (_, m) => ({ exerciseId: `coros:Move ${String(m + 1).padStart(2, "0")}`, reps: 5 })),
      );
    }

    const lines = section((await buildDossier(db, userId, prefs, TODAY)).text).slice(1);
    expect(lines.map((l) => l.slice(0, 10))).toEqual(["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01", "2026-09-30"]);
    const names = Array.from({ length: 12 }, (_, m) => `Move ${String(m + 1).padStart(2, "0")} 1 set: 5 reps`);
    expect(lines[0]).toBe(`2026-10-04 · 60min · ${names.join(" · ")} · +2 more exercises`);
  });

  it("is omitted entirely when there is no strength work to describe", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const d = await buildDossier(db, userId, prefs, todayInZone(prefs.timezone));
    expect(d.sections).not.toContain("RECENT STRENGTH DETAIL");
  });
});
