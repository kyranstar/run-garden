/**
 * D1 bound-variable ceiling, as a class of bug rather than two known lines.
 *
 * D1 caps a statement at 100 bound variables; better-sqlite3 allows 32766. So
 * an unchunked `inArray(col, ids)` over a user's data passes every test in this
 * repo and then throws `D1_ERROR: too many SQL variables` in production, once
 * that user's history grows past the cap. It has now happened three times:
 * calendar sync (froze every sync), the coach wake's guardrail context (burned
 * 125 seconds and an LLM call, persisted the briefing, then died before the
 * athlete's proposals), and the dossier's completion-match lookup.
 *
 * These tests run the real paths against `makeTestDb({ boundVariableCap })`,
 * which makes the test driver as strict as D1. A regression here fails in
 * milliseconds instead of in front of the athlete.
 */
import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { buildDossier } from "../src/services/coach-context.js";
import { wake } from "../src/services/coach-wake.js";
import { applyOps } from "../src/services/coach-apply.js";
import { consumeTriggers } from "../src/services/coach-triggers.js";
import { D1_BIND_LIMIT, makeTestDb, makeTestUser } from "./helpers.js";
import type { Env } from "../src/env.js";

function capped(): Db {
  return makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
}

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key",
  } as Env;
}

const RESTRAINT = { briefing: "steady week", proposals: [], question: null, memoryOps: [] };

function scriptedFetch(bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = bodies[i++];
    if (body === undefined) throw new Error("no more scripted responses");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 400 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

/**
 * `count` planned workouts spread evenly from `from` to `to`, each with a
 * completed activity and a completion match — so every id-list query on the
 * path (workouts, matches, activities) is genuinely wide, not just the first.
 */
async function seedBusyAthlete(
  db: Db,
  userId: string,
  opts: { count: number; from: string; to: string; planId?: string },
): Promise<string[]> {
  const { count, from, to, planId = "cp1" } = opts;
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000),
  );
  const ids: string[] = [];
  const now = nowInstant();
  for (let n = 0; n < count; n++) {
    const id = `w${n}`;
    const date = addDays(from, Math.floor((n * spanDays) / count));
    ids.push(id);
    await db.insert(schema.plannedWorkouts).values({
      id,
      userId,
      planId,
      sourceWorkoutId: `4738:${id}`,
      title: "Tempo 3×10",
      category: n % 3 === 0 ? "quality" : "easy",
      sport: n % 4 === 0 ? "strength" : "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState: date <= todayInZone("America/Los_Angeles") ? "completed" : "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: now,
      updatedAt: now,
    });
    // Past sessions also get an activity + match, which is what makes the
    // completion-match `inArray` wide on both the dossier and wake paths.
    if (date <= todayInZone("America/Los_Angeles")) {
      const activityId = `a${n}`;
      await db.insert(schema.activities).values({
        id: activityId,
        userId,
        sport: n % 4 === 0 ? "strength" : "run",
        startTime: `${date}T14:00:00Z`,
        startTimeLocal: `${date}T07:00:00`,
        durationSeconds: 2400,
        distanceMeters: 8000,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.workoutCompletionMatches).values({
        id: `m${n}`,
        workoutId: id,
        activityId,
        confidence: 0.95,
        method: "scored_auto",
        matchedAt: now,
      });
    }
  }
  return ids;
}

async function seedCoachPlan(db: Db, userId: string, today: string, id = "cp1"): Promise<void> {
  await db.insert(schema.coachPlans).values({
    id,
    userId,
    discipline: "run",
    name: "Fall Marathon",
    status: "active",
    startDate: addDays(today, -60),
    endDate: addDays(today, 60),
    stampPrefix: "Fall Marathon",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("the bind-cap guard itself", () => {
  // A green suite below is only meaningful if the harness can actually fail.
  it("rejects an unchunked inArray the way D1 does", async () => {
    const db = capped();
    const { userId } = await makeTestUser(db);
    const ids = Array.from({ length: 150 }, (_, n) => `w${n}`);
    await expect(
      db.select().from(schema.plannedWorkouts).where(inArray(schema.plannedWorkouts.id, ids)),
    ).rejects.toThrow(/too many SQL variables/);
    expect(userId).toBeTruthy();
  });

  it("accepts the same query once chunked", async () => {
    const db = capped();
    await makeTestUser(db);
    const ids = Array.from({ length: 150 }, (_, n) => `w${n}`);
    const rows = [
      ...(await db.select().from(schema.plannedWorkouts).where(inArray(schema.plannedWorkouts.id, ids.slice(0, 90)))),
      ...(await db.select().from(schema.plannedWorkouts).where(inArray(schema.plannedWorkouts.id, ids.slice(90)))),
    ];
    expect(rows).toEqual([]);
  });
});

// The shape that actually broke prod: a plan deep enough to span the wake's
// 95-day guardrail window (today-35 … today+60). 134 workouts was enough.
describe("coach paths survive an athlete with 200 planned workouts", () => {
  it("buildDossier completes", async () => {
    const db = capped();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedCoachPlan(db, userId, today);
    await seedBusyAthlete(db, userId, { count: 200, from: addDays(today, -45), to: addDays(today, 55) });

    const dossier = await buildDossier(db, userId, prefs);
    expect(dossier.sections).toContain("LAST 14 DAYS");
    expect(dossier.text.length).toBeGreaterThan(0);
  });

  it("wake completes and persists its proposals", async () => {
    const db = capped();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedCoachPlan(db, userId, today);
    await seedBusyAthlete(db, userId, { count: 200, from: addDays(today, -45), to: addDays(today, 55) });

    const res = await wake(
      db,
      makeEnv(),
      userId,
      prefs,
      { kind: "manual" },
      scriptedFetch([RESTRAINT]),
    );
    // The prod failure reached exactly here — briefing written, then the
    // guardrail context's unchunked `inArray` threw and the wake reported
    // `error` after 125 seconds.
    expect(res.status).toBe("ok");
  });

  it("retirePlan applies across every future session", async () => {
    const db = capped();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedCoachPlan(db, userId, today);
    await seedBusyAthlete(db, userId, { count: 200, from: addDays(today, 1), to: addDays(today, 120) });

    // Runs on approval, so an unchunked bind here fails later and far more
    // confusingly than the wake's — the athlete has already said yes.
    const out = await applyOps(db, userId, prefs, "prop1", [{ kind: "retirePlan", planId: "cp1" }]);
    expect(out.archived.length).toBe(200);
    const [plan] = await db.select().from(schema.coachPlans);
    expect(plan!.status).toBe("retired");
  });

  it("consumeTriggers clears a backlog larger than one chunk", async () => {
    const db = capped();
    const { userId } = await makeTestUser(db);
    const now = nowInstant();
    const ids: string[] = [];
    // `unanswered_message` is written per athlete message and cleared only by
    // a SUCCESSFUL wake, so a run of failures piles them up without bound.
    for (let n = 0; n < 150; n++) {
      const id = newId();
      ids.push(id);
      await db.insert(schema.coachTriggers).values({
        id,
        userId,
        kind: "unanswered_message",
        evidence: { body: "hello?" },
        firedAt: now,
      });
    }
    await consumeTriggers(db, userId, ids, now);
    const rows = await db.select().from(schema.coachTriggers);
    expect(rows.every((r) => r.consumedAt === now)).toBe(true);
  });
});

describe("the dossier's recent-window match lookup", () => {
  it("completes when the last 14 days are unusually dense", async () => {
    const db = capped();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedCoachPlan(db, userId, today);
    // Deliberately denser than any real athlete: the dossier's completion-match
    // query is scoped to 14 days, so only a stacked window puts it over the
    // cap. The point is to pin the chunking in place, not to model a human.
    await seedBusyAthlete(db, userId, { count: 140, from: addDays(today, -13), to: today });

    const dossier = await buildDossier(db, userId, prefs);
    expect(dossier.sections).toContain("LAST 14 DAYS");
  });
});
