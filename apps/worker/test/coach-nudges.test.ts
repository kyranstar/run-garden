/**
 * THE COACH'S "NEEDS YOU" CHIPS (§8 §6, stream T): the thread coach's free signals, read from its old trigger rules
 * when the opening screen asks — computed on read, no row written, at most two, each `{ id, label, request }`. A tap
 * sends the `request` as the athlete's words: the only spend.
 *
 *   a missed session in the last 2 days       → "Rework my week around Tuesday's tempo"
 *   back after 7 or more quiet days           → "Ease me back in"
 *   a plan's next week still an outline, 14 d → "Fill in next week of my 10K plan"
 *   a race within 21 days                     → "Get me ready for race day"
 *   a plan ending within 21 days              → "Plan what comes after my half marathon plan"
 *
 * `GET /api/coach/nudges` → `{ nudges }`, a 404 while the coach designer is off (as its conversation is).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeCoachNudgesRoutes } from "../src/routes/coach-nudges.js";
import { asWords, NUDGES_MAX, readNudges, type CoachNudge } from "../src/services/coach-nudges.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = (designer = true): Env =>
  ({
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
    ...(designer ? { COACH_DESIGNER: "1" } : {}),
  }) as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

/** A date's weekday, as the chips say it. */
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

const nudges = () => readNudges(db, userId, prefs, today, new Date());
const ids = (list: CoachNudge[]) => list.map((n) => n.id);

async function seedSession(o: {
  id: string;
  date: string;
  state: string;
  category?: string;
  qualitySubtype?: string | null;
  sport?: string;
  sanctionedBy?: string | null;
  archivedAt?: string | null;
}): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id: o.id,
    userId,
    planId: "p",
    sourceWorkoutId: `src-${o.id}`,
    title: "T1004",
    category: o.category ?? "quality",
    qualitySubtype: o.qualitySubtype === undefined ? "tempo" : o.qualitySubtype,
    sport: o.sport ?? "run",
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: "07:00",
    completionState: o.state,
    resolutionDate: o.state === "scheduled" ? null : o.date,
    sanctionedBy: o.sanctionedBy ?? null,
    archivedAt: o.archivedAt ?? null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function seedActivity(id: string, date: string): Promise<void> {
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: `${date}T14:00:00Z`,
    startTimeLocal: `${date}T07:00:00`,
    sport: "run",
    durationSeconds: 1800,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function seedPlan(o: { id: string; name: string; endDate: string; raceDate?: string | null; status?: string }): Promise<void> {
  await db.insert(schema.coachPlans).values({
    id: o.id,
    userId,
    discipline: "run",
    name: o.name,
    status: o.status ?? "active",
    startDate: addDays(today, -30),
    endDate: o.endDate,
    raceDate: o.raceDate ?? null,
    stampPrefix: o.name,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function seedWeek(planId: string, weekStart: string, state: "firm" | "shape"): Promise<void> {
  await db.insert(schema.coachPlanWeeks).values({
    id: newId(),
    planId,
    weekStart,
    state,
    shape: state === "shape" ? { volumeTarget: "40k", keySessions: ["long"] } : null,
  });
}

async function seedRun(request: string, createdAt: string, parentId: string | null = null): Promise<void> {
  await db.insert(schema.coachRuns).values({
    id: newId(),
    userId,
    parentId,
    role: parentId ? "designer" : "main",
    scope: { kind: "auto" },
    request,
    status: "finished",
    createdAt,
    updatedAt: createdAt,
  });
}

async function setRace(raceDate: string | null): Promise<void> {
  prefs = { ...prefs, raceDate };
  await savePreferences(db, userId, prefs);
}

describe("a missed session in the last 2 days", () => {
  it("offers to rework the week around it, by its day and kind", async () => {
    const day = addDays(today, -1);
    await seedSession({ id: "w1", date: day, state: "missed" });
    expect(await nudges()).toEqual([
      {
        id: "missed:w1",
        label: `Rework my week around ${weekday(day)}'s tempo`,
        request: `Rework my week around ${weekday(day)}'s tempo — I missed it.`,
      },
    ]);
  });

  it("counts one skipped, or asked about and still unanswered, as missed — and today's says today", async () => {
    await seedSession({ id: "w1", date: today, state: "skipped", category: "long", qualitySubtype: null });
    expect((await nudges())[0]).toMatchObject({ label: "Rework my week around today's long run" });
    await db.delete(schema.plannedWorkouts);
    const day = addDays(today, -2);
    await seedSession({ id: "w2", date: day, state: "unresolved", category: "strength", qualitySubtype: null, sport: "strength" });
    expect((await nudges())[0]).toMatchObject({ id: "missed:w2", label: `Rework my week around ${weekday(day)}'s strength session` });
  });

  it("names several in one request, newest first", async () => {
    const a = addDays(today, -1);
    const b = addDays(today, -2);
    await seedSession({ id: "w1", date: b, state: "missed", category: "easy", qualitySubtype: null });
    await seedSession({ id: "w2", date: a, state: "missed" });
    expect(await nudges()).toEqual([
      {
        id: "missed:w2",
        label: "Rework my week around the sessions I missed",
        request: `Rework my week around the sessions I missed: ${weekday(a)}'s tempo and ${weekday(b)}'s easy run.`,
      },
    ]);
  });

  it("stays quiet for one 3 days back, one the coach skipped on purpose, a rest day, one archived, one done or still to come", async () => {
    await seedSession({ id: "w1", date: addDays(today, -3), state: "missed" });
    await seedSession({ id: "w2", date: addDays(today, -1), state: "skipped", sanctionedBy: "coach" });
    await seedSession({ id: "w3", date: addDays(today, -1), state: "missed", category: "rest", qualitySubtype: null });
    await seedSession({ id: "w4", date: addDays(today, -1), state: "missed", archivedAt: nowInstant() });
    await seedSession({ id: "w5", date: addDays(today, -1), state: "completed" });
    await seedSession({ id: "w6", date: addDays(today, -1), state: "scheduled" });
    expect(await nudges()).toEqual([]);
  });
});

describe("back after 7 or more quiet days", () => {
  it("offers to ease back in", async () => {
    await seedActivity("a1", addDays(today, -1));
    await seedActivity("a2", addDays(today, -9));
    expect(await nudges()).toEqual([
      { id: `comeback:${addDays(today, -1)}`, label: "Ease me back in", request: "I'm back after 8 days away. Ease me back in." },
    ]);
  });

  it("stays quiet after a 6-day gap, and once the return is 3 days old", async () => {
    await seedActivity("a1", addDays(today, -1));
    await seedActivity("a2", addDays(today, -7));
    expect(await nudges()).toEqual([]);
    await db.delete(schema.activities);
    await seedActivity("a3", addDays(today, -3));
    await seedActivity("a4", addDays(today, -20));
    expect(await nudges()).toEqual([]);
  });
});

describe("a plan's next week still an outline within 14 days", () => {
  it("offers to fill it in, by the plan's name", async () => {
    await seedPlan({ id: "cp1", name: "10K", endDate: addDays(today, 60) });
    await seedWeek("cp1", addDays(today, -2), "firm");
    await seedWeek("cp1", addDays(today, 12), "shape");
    expect(await nudges()).toEqual([
      { id: "horizon:cp1", label: "Fill in next week of my 10K plan", request: "Fill in next week of my 10K plan." },
    ]);
  });

  it("an outline week already under way is this week's", async () => {
    await seedPlan({ id: "cp1", name: "Base plan", endDate: addDays(today, 60) });
    await seedWeek("cp1", addDays(today, -3), "shape");
    expect(await nudges()).toEqual([
      { id: "horizon:cp1", label: "Fill in this week of my Base plan", request: "Fill in this week of my Base plan." },
    ]);
  });

  it("stays quiet for an outline 15 days out, a filled-in week, a finished outline, and a plan not running", async () => {
    await seedPlan({ id: "cp1", name: "10K", endDate: addDays(today, 60) });
    await seedWeek("cp1", addDays(today, 15), "shape");
    await seedWeek("cp1", addDays(today, 5), "firm");
    await seedWeek("cp1", addDays(today, -10), "shape");
    await seedPlan({ id: "cp2", name: "Old block", endDate: addDays(today, 60), status: "retired" });
    await seedWeek("cp2", addDays(today, 3), "shape");
    expect(await nudges()).toEqual([]);
  });
});

describe("a race within 21 days", () => {
  it("offers to get ready, from the race day in Settings", async () => {
    await setRace(addDays(today, 21));
    expect(await nudges()).toEqual([
      { id: `race:${addDays(today, 21)}`, label: "Get me ready for race day", request: "My race is in 21 days. Get me ready for race day." },
    ]);
  });

  it("or from a running plan's race day; tomorrow's is tomorrow", async () => {
    await seedPlan({ id: "cp1", name: "Fall Half", endDate: addDays(today, 60), raceDate: addDays(today, 1) });
    expect(await nudges()).toEqual([
      { id: `race:${addDays(today, 1)}`, label: "Get me ready for race day", request: "My race is tomorrow. Get me ready for race day." },
    ]);
  });

  it("stays quiet for a race 22 days out, and one past", async () => {
    await setRace(addDays(today, 22));
    expect(await nudges()).toEqual([]);
    await setRace(addDays(today, -1));
    expect(await nudges()).toEqual([]);
  });
});

describe("a plan ending within 21 days", () => {
  it("offers to plan what comes after it", async () => {
    await seedPlan({ id: "cp1", name: "half marathon", endDate: addDays(today, 21) });
    expect(await nudges()).toEqual([
      {
        id: "ending:cp1",
        label: "Plan what comes after my half marathon plan",
        request: "Plan what comes after my half marathon plan — it ends in 21 days.",
      },
    ]);
  });

  it("stays quiet for one ending in 22 days, one already ended, and a bucket of one-offs", async () => {
    await seedPlan({ id: "cp1", name: "Long", endDate: addDays(today, 22) });
    await seedPlan({ id: "cp2", name: "Done", endDate: addDays(today, -1) });
    await seedPlan({ id: `adhoc-run-${userId.slice(0, 8)}`, name: "Coach one-offs", endDate: today });
    expect(await nudges()).toEqual([]);
  });
});

describe("at most two, the most pressing first", () => {
  async function seedAll(): Promise<void> {
    await seedSession({ id: "w1", date: addDays(today, -1), state: "missed" });
    await seedActivity("a1", addDays(today, -1));
    await seedActivity("a2", addDays(today, -10));
    await seedPlan({ id: "cp1", name: "Fall Half", endDate: addDays(today, 14), raceDate: addDays(today, 14) });
    await seedWeek("cp1", addDays(today, 6), "shape");
  }

  it("missed, then back, then the outline, then the race, then the ending", async () => {
    expect(NUDGES_MAX).toBe(2);
    await seedAll();
    expect(ids(await nudges())).toEqual(["missed:w1", `comeback:${addDays(today, -1)}`]);
    await db.delete(schema.plannedWorkouts);
    expect(ids(await nudges())).toEqual([`comeback:${addDays(today, -1)}`, "horizon:cp1"]);
    await db.delete(schema.activities);
    expect(ids(await nudges())).toEqual(["horizon:cp1", `race:${addDays(today, 14)}`]);
    await db.delete(schema.coachPlanWeeks);
    expect(ids(await nudges())).toEqual([`race:${addDays(today, 14)}`, "ending:cp1"]);
  });

  it("one the athlete asked in the last 3 days stays away, and lets the next one in", async () => {
    await seedAll();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    // The words differ from the chip's request (a day count moved, a word typed): its label, in them, is what counts.
    await seedRun(`I MISSED yesterday's run — rework my week around ${weekday(addDays(today, -1))}'s tempo please`, hourAgo);
    expect(ids(await nudges())).toEqual([`comeback:${addDays(today, -1)}`, "horizon:cp1"]);
    // A sub-run's words are not the athlete's; one older than three days no longer counts.
    await seedRun("Ease me back in", hourAgo, "parent");
    await seedRun("Ease me back in", new Date(Date.now() - 73 * 3_600_000).toISOString());
    expect(ids(await nudges())).toEqual([`comeback:${addDays(today, -1)}`, "horizon:cp1"]);
  });

  it("every rule's chip stays away once its own request was sent — the next day too, its count moved (review-1 I3)", async () => {
    const minuteAgo = () => new Date(Date.now() - 60_000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    /** The chip a seeded condition offers, then: its own request sent, it is gone. */
    async function sentAway(seed: () => Promise<void>, kind: string, sent?: (chip: CoachNudge) => string): Promise<void> {
      await db.delete(schema.coachRuns);
      await seed();
      const chip = (await nudges()).find((n) => n.id.startsWith(`${kind}:`));
      expect(chip, kind).toBeDefined();
      // The rule's invariant: its request holds its label, which is what "asked" reads.
      expect(asWords(chip!.request), kind).toContain(asWords(chip!.label));
      await seedRun(sent ? sent(chip!) : chip!.request, sent ? dayAgo : minuteAgo());
      expect((await nudges()).map((n) => n.id), kind).not.toContain(chip!.id);
    }
    await sentAway(() => seedSession({ id: "w1", date: addDays(today, -1), state: "missed" }), "missed");
    await db.delete(schema.plannedWorkouts);
    await sentAway(async () => {
      await seedSession({ id: "w1", date: addDays(today, -1), state: "missed" });
      await seedSession({ id: "w2", date: addDays(today, -2), state: "skipped", category: "easy", qualitySubtype: null });
    }, "missed");
    await db.delete(schema.plannedWorkouts);
    await sentAway(async () => {
      await seedActivity("a1", addDays(today, -1));
      await seedActivity("a2", addDays(today, -9));
    }, "comeback");
    await db.delete(schema.activities);
    await sentAway(async () => {
      await seedPlan({ id: "cp1", name: "10K", endDate: addDays(today, 60) });
      await seedWeek("cp1", addDays(today, 6), "shape");
    }, "horizon");
    await db.delete(schema.coachPlanWeeks);
    await db.delete(schema.coachPlans);
    await sentAway(() => setRace(addDays(today, 12)), "race");
    // Sent yesterday, when the race was a day further off: still the same ask.
    await sentAway(async () => undefined, "race", (chip) => chip.request.replace("12 days", "13 days"));
    await setRace(null);
    await sentAway(() => seedPlan({ id: "cp2", name: "half marathon", endDate: addDays(today, 20) }), "ending");
    await sentAway(async () => undefined, "ending", (chip) => chip.request.replace("20 days", "21 days"));
  });

  it("the athlete's own words count too: the request or the label, whatever the case, spacing or punctuation", async () => {
    await seedPlan({ id: "cp1", name: "half marathon", endDate: addDays(today, 20) });
    expect(ids(await nudges())).toEqual(["ending:cp1"]);
    await seedRun("plan what comes after my half-marathon plan!!", new Date().toISOString());
    expect(await nudges()).toEqual([]);
  });

  it("writes nothing, and costs at most six statements", async () => {
    await seedAll();
    await seedRun("Plan my week", new Date().toISOString());
    statements.length = 0;
    await nudges();
    expect(statements.filter(isWrite)).toEqual([]);
    // The missed sessions, the activities, the plans, last week's review (the opening's, stream H), their outline weeks,
    // the athlete's recent asks.
    expect(statements.length).toBe(6);
  });

  it("a quiet account costs four: nothing to look up weeks for, nothing to have asked", async () => {
    statements.length = 0;
    expect(await nudges()).toEqual([]);
    expect(statements.length).toBe(4);
  });
});

describe("GET /api/coach/nudges", () => {
  const get = (designer = true, withCookie = true) =>
    mountRoutes(db, "/api/coach/nudges", makeCoachNudgesRoutes({ now: () => new Date() })).request(
      "/api/coach/nudges",
      { headers: withCookie ? { Cookie: cookie } : {} },
      env(designer),
    );

  it("answers { nudges } for the signed-in athlete, in 8 statements with the sign-in and the preferences", async () => {
    await setRace(addDays(today, 10));
    await seedPlan({ id: "cp1", name: "10K", endDate: addDays(today, 40) });
    await seedWeek("cp1", addDays(today, 4), "shape");
    statements.length = 0;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nudges: [
        { id: "horizon:cp1", label: "Fill in next week of my 10K plan", request: "Fill in next week of my 10K plan." },
        { id: `race:${addDays(today, 10)}`, label: "Get me ready for race day", request: "My race is in 10 days. Get me ready for race day." },
      ],
    });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.length).toBe(8);
  });

  it("is a 404 while the coach designer is off, and a 401 signed out", async () => {
    expect((await get(false)).status).toBe(404);
    expect((await get(true, false)).status).toBe(401);
  });
});
