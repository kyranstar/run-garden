/**
 * Dossier golden test (Plan A Task A5, spec §2): all eight sections present,
 * unknowns explicit, deterministic given fixed rows, inside the token budget.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { initialSnapshot } from "@rg/garden-engine";
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
    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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

    const a = await buildDossier(db, userId, prefs);
    const b = await buildDossier(db, userId, prefs);
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
    const dossier = await buildDossier(db, userId, prefs);
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
    const dossier = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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

    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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

    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
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
    const d = await buildDossier(db, userId, prefs);
    expect(d.sections).not.toContain("EXERCISE CATALOG");
    expect(d.sections).toContain("STRENGTH PLAN");
    expect(d.text).toContain("tight IT band and a bad wrist");
    // The loss is stated — a missing catalog must not read as "no exercises".
    expect(d.text).toContain("dropped to fit the context budget: EXERCISE CATALOG");
    expect(d.approxTokens).toBeLessThanOrEqual(20_000);
  });
});
