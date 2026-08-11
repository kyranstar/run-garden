/**
 * Dossier golden test (Plan A Task A5, spec §2): all eight sections present,
 * unknowns explicit, deterministic given fixed rows, inside the token budget.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { buildDossier } from "../src/services/coach-context.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const SECTIONS = [
  "ATHLETE",
  "PLANS",
  "UPCOMING 14 DAYS",
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
    expect(d.approxTokens).toBeLessThanOrEqual(12_000);
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
    expect(a.text).toContain("30d baselines: sleep 6.0h");
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
