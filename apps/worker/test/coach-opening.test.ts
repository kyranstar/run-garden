/**
 * THE COACH NOTICES (stream H): the opening screen's own line, read with the "needs you" chips (`GET /api/coach/nudges`
 * → `{ nudges, opening? }`), free — from what the app already has, never a model call:
 *
 *   last week's review (Monday's, paid for)    → "From last week's review: …"          + "Plan this week"
 *   a session finished today or yesterday      → "Saturday's long run is in — 16 km…"  + "Plan today around it"
 *   …whose ambient coach read is paid for      → "Saturday's long run: <its glance>"
 *
 * The review before the session. Either is old news once the athlete has asked the coach anything since it arrived, and
 * gives way to the next once this device has shown it (`?seen=`). Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeCoachNudgesRoutes } from "../src/routes/coach-nudges.js";
import { readCoachOpening } from "../src/services/coach-nudges.js";
import {
  distanceIn,
  effortWords,
  firstSentence,
  parseSeen,
  REVIEW_REQUEST,
  reviewOpening,
  SEEN_MAX,
  sessionFacts,
  sessionOpening,
  type FinishedSession,
} from "../src/services/coach-opening-line.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

// ── The words (pure) ─────────────────────────────────────────────────────────

const run = (o: Partial<FinishedSession> = {}): FinishedSession => ({
  activityId: "a1",
  date: "2026-10-17",
  sport: "run",
  seconds: 16 * 340,
  meters: 16_000,
  paceSecPerKm: 340,
  hrZones: [{ seconds: 1200 }, { seconds: 3500 }, { seconds: 600 }, { seconds: 100 }, { seconds: 40 }],
  noun: "long run",
  workoutId: "w1",
  sets: null,
  glance: null,
  ...o,
});
const lift = (o: Partial<FinishedSession> = {}): FinishedSession =>
  run({ sport: "strength", seconds: 42 * 60, meters: null, paceSecPerKm: null, hrZones: null, noun: "strength session", sets: { done: 18, total: 18, completed: true }, ...o });

describe("the words, in the athlete's units", () => {
  it("a distance to a tenth, said whole when it is whole", () => {
    expect(distanceIn(16_000, "km")).toBe("16 km");
    expect(distanceIn(10_440, "km")).toBe("10.4 km");
    expect(distanceIn(10_000, "mi")).toBe("6.2 mi");
  });

  it("how hard, by the watch's own time in zone: easy, hard, steady — or nothing clear", () => {
    expect(effortWords([{ seconds: 30 }, { seconds: 50 }, { seconds: 10 }, { seconds: 10 }, { seconds: 0 }])).toBe("mostly easy");
    expect(effortWords([{ seconds: 10 }, { seconds: 10 }, { seconds: 20 }, { seconds: 40 }, { seconds: 20 }])).toBe("mostly hard");
    expect(effortWords([{ seconds: 10 }, { seconds: 20 }, { seconds: 45 }, { seconds: 25 }, { seconds: 0 }])).toBe("mostly steady");
    expect(effortWords([{ seconds: 30 }, { seconds: 20 }, { seconds: 20 }, { seconds: 30 }, { seconds: 0 }])).toBeNull();
    expect(effortWords(null)).toBeNull();
    expect(effortWords([])).toBeNull();
  });

  it("a run: its distance at its pace, and how hard — per mile for an athlete in miles", () => {
    expect(sessionFacts(run(), "km")).toBe("16 km at 5:40 /km, mostly easy");
    expect(sessionFacts(run(), "mi")).toBe("9.9 mi at 9:07 /mi, mostly easy");
    // Its pace from its time when the watch gave none; none believable, none said.
    expect(sessionFacts(run({ paceSecPerKm: null, hrZones: null }), "km")).toBe("16 km at 5:40 /km");
    expect(sessionFacts(run({ paceSecPerKm: 4000, hrZones: null }), "km")).toBe("16 km");
    // No distance (a treadmill): its time.
    expect(sessionFacts(run({ meters: null, seconds: 45 * 60, hrZones: null }), "km")).toBe("45 min");
  });

  it("a strength or mobility session: its time and the sets logged — all of them in, or how many of how many", () => {
    expect(sessionFacts(lift(), "km")).toBe("42 min, all 18 sets in");
    expect(sessionFacts(lift({ sets: { done: 14, total: 18, completed: true } }), "km")).toBe("42 min, 14 of 18 sets");
    expect(sessionFacts(lift({ sets: { done: 18, total: 18, completed: false } }), "km")).toBe("42 min, 18 sets");
    expect(sessionFacts(lift({ sport: "yoga", noun: "mobility session", seconds: 20 * 60, sets: null }), "km")).toBe("20 min");
  });

  it("after a session: one line, and a chip that plans tomorrow around it — today's, for yesterday's", () => {
    const today = "2026-10-17";
    expect(sessionOpening(run(), today, "km")).toEqual({
      id: "session:a1",
      line: "Today's long run is in — 16 km at 5:40 /km, mostly easy.",
      source: "session",
      chips: [{ id: "session:a1", label: "Plan tomorrow around it", request: "Plan tomorrow around today's long run — 16 km at 5:40 /km, mostly easy." }],
      workoutId: "w1",
    });
    const yesterday = sessionOpening(lift({ workoutId: null }), addDays(today, 1), "km");
    expect(yesterday.line).toBe(`${weekday(today)}'s strength session is done — 42 min, all 18 sets in.`);
    expect(yesterday.chips).toEqual([
      { id: "session:a1", label: "Plan today around it", request: `Plan today around ${weekday(today)}'s strength session — 42 min, all 18 sets in.` },
    ]);
    expect(yesterday).not.toHaveProperty("workoutId");
  });

  it("the coach's read of it, already paid for: its glance instead, said about the session", () => {
    const read = sessionOpening(run({ glance: "HR drifted 6% late — fueling, not fitness" }), "2026-10-18", "km");
    expect(read.source).toBe("read");
    expect(read.line).toBe("Saturday's long run: HR drifted 6% late — fueling, not fitness.");
    // The chip still says the session in figures.
    expect(read.chips[0]!.request).toBe("Plan today around Saturday's long run — 16 km at 5:40 /km, mostly easy.");
    expect(sessionOpening(run({ glance: "A steady one!" }), "2026-10-18", "km").line).toBe("Saturday's long run: A steady one!");
  });

  it("on Monday: the review's first sentence — a decimal is no sentence's end — and Plan this week", () => {
    const r = reviewOpening({ weekStart: "2026-10-12", narrative: "You ran 4 times for 32.1 kilometres. Two strength sessions too.\n\nMore." });
    expect(r).toEqual({
      id: "review:2026-10-12",
      line: "From last week's review: You ran 4 times for 32.1 kilometres.",
      source: "review",
      chips: [{ id: "review:2026-10-12", label: "Plan this week", request: REVIEW_REQUEST }],
    });
    expect(REVIEW_REQUEST).toBe("Plan my week around how last week went.");
    expect(reviewOpening({ weekStart: "2026-10-12", narrative: null })).toBeNull();
    expect(reviewOpening({ weekStart: "2026-10-12", narrative: "   " })).toBeNull();
    const long = firstSentence(`${"word ".repeat(80)}end.`);
    expect(long.length).toBeLessThanOrEqual(220);
    expect(long.endsWith("…")).toBe(true);
  });

  it("the seen list takes only openings' ids, at most eight", () => {
    expect([...parseSeen("review:2026-10-12, session:abc-1,junk,session:,<script>")]).toEqual(["review:2026-10-12", "session:abc-1"]);
    expect(parseSeen(Array.from({ length: 12 }, (_, i) => `session:a${i}`).join(",")).size).toBe(SEEN_MAX);
    expect(parseSeen(undefined).size).toBe(0);
  });
});

// ── The read ─────────────────────────────────────────────────────────────────

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const read = (seen: string[] = []) => readCoachOpening(db, userId, prefs, today, new Date(), new Set(seen));

async function seedActivity(o: {
  id: string;
  date: string;
  sport?: string;
  seconds?: number;
  meters?: number | null;
  pace?: number | null;
  zones?: number[];
  arrivedAt?: string;
  workout?: { id: string; category: string; qualitySubtype?: string | null };
}): Promise<void> {
  const at = o.arrivedAt ?? iso(HOUR);
  const matchId = o.workout ? `m-${o.id}` : null;
  await db.insert(schema.activities).values({
    id: o.id,
    userId,
    startTime: `${o.date}T14:00:00Z`,
    startTimeLocal: `${o.date}T07:00:00`,
    sport: o.sport ?? "run",
    durationSeconds: o.seconds ?? 5440,
    distanceMeters: o.meters === undefined ? 16_000 : o.meters,
    avgPaceSecPerKm: o.pace === undefined ? 340 : o.pace,
    telemetry: o.zones ? { hrZones: o.zones.map((seconds, i) => ({ lo: 100 + i * 20, hi: 120 + i * 20, seconds })) } : null,
    completionMatchId: matchId,
    sourceMergeConfidence: 1,
    createdAt: at,
    updatedAt: at,
  });
  if (o.workout && matchId) {
    await db.insert(schema.plannedWorkouts).values({
      id: o.workout.id,
      userId,
      planId: "p",
      sourceWorkoutId: `src-${o.workout.id}`,
      title: "T1",
      category: o.workout.category,
      qualitySubtype: o.workout.qualitySubtype ?? null,
      sport: o.sport === "strength" ? "strength" : "run",
      originalPlanDate: o.date,
      lastVerifiedCorosDate: o.date,
      effectiveDate: o.date,
      effectiveTime: "07:00",
      completionState: "completed",
      resolutionDate: o.date,
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.workoutCompletionMatches).values({ id: matchId, workoutId: o.workout.id, activityId: o.id, confidence: 1, method: "app_session", matchedAt: at });
  }
}

async function seedSets(activityId: string, o: { done: number; undone?: number; completed: boolean; source?: string }): Promise<void> {
  const id = `ps-${activityId}-${o.source ?? "app"}`;
  await db.insert(schema.performedSessions).values({
    id,
    userId,
    activityId,
    source: o.source ?? "app",
    sourceRef: o.source === "watch" ? `ref-${activityId}` : null,
    localDate: today,
    seconds: 2520,
    completed: o.completed,
    payloadHash: "h",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  const rows = [...Array.from({ length: o.done }, () => true), ...Array.from({ length: o.undone ?? 0 }, () => false)];
  for (const [i, done] of rows.entries()) {
    await db.insert(schema.performedSets).values({ id: `${id}-s${i}`, performedSessionId: id, entryIndex: 0, exerciseId: "goblet-squat", setIndex: i, reps: 8, done });
  }
}

async function seedRead(activityId: string, glance: string, status = "done"): Promise<void> {
  await db.insert(schema.coachReads).values({
    id: newId(),
    userId,
    activityId,
    status,
    attempt: 1,
    nextAttemptAt: nowInstant(),
    glance,
    body: "Body.",
    flags: [],
    createdAt: nowInstant(),
  });
}

const lastWeek = () => addDays(startOfIsoWeek(today), -7);

async function seedReview(o: { weekStart?: string; narrative?: string | null; createdAt?: string } = {}): Promise<void> {
  await db.insert(schema.weeklyReviews).values({
    id: newId(),
    userId,
    weekStart: o.weekStart ?? lastWeek(),
    facts: {},
    narrative: o.narrative === undefined ? "You ran 4 times for 32.1 kilometres. Steady work." : o.narrative,
    createdAt: o.createdAt ?? iso(2 * HOUR),
  });
}

async function seedAsk(request: string, createdAt: string, parentId: string | null = null): Promise<void> {
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

describe("after a session", () => {
  it("a run finished today: its plan session's name, its figures, and Plan tomorrow around it", async () => {
    await seedActivity({ id: "a1", date: today, zones: [1200, 3500, 600, 100, 40], workout: { id: "w1", category: "long" } });
    const { opening } = await read();
    expect(opening).toEqual({
      id: "session:a1",
      line: "Today's long run is in — 16 km at 5:40 /km, mostly easy.",
      source: "session",
      chips: [{ id: "session:a1", label: "Plan tomorrow around it", request: "Plan tomorrow around today's long run — 16 km at 5:40 /km, mostly easy." }],
      workoutId: "w1",
    });
  });

  it("yesterday's, by its day; a quality session by its kind; in miles for an athlete in miles", async () => {
    prefs = { ...prefs, units: "mi" };
    await savePreferences(db, userId, prefs);
    const day = addDays(today, -1);
    await seedActivity({ id: "a2", date: day, meters: 10_000, pace: 300, seconds: 3000, workout: { id: "w2", category: "quality", qualitySubtype: "tempo" } });
    const { opening } = await read();
    expect(opening?.line).toBe(`${weekday(day)}'s tempo is in — 6.2 mi at 8:03 /mi.`);
    expect(opening?.chips[0]?.label).toBe("Plan today around it");
  });

  it("a strength session done in the app: its sets as logged — the app's own, never the watch's copy", async () => {
    await seedActivity({ id: "a3", date: today, sport: "strength", seconds: 42 * 60, meters: null, pace: null });
    await seedSets("a3", { done: 2, completed: false, source: "watch" });
    await seedSets("a3", { done: 18, completed: true });
    expect((await read()).opening?.line).toBe("Today's strength session is done — 42 min, all 18 sets in.");
  });

  it("a session left part done says how many of how many", async () => {
    await seedActivity({ id: "a4", date: today, sport: "strength", seconds: 30 * 60, meters: null, pace: null });
    await seedSets("a4", { done: 10, undone: 4, completed: false });
    expect((await read()).opening?.line).toBe("Today's strength session is done — 30 min, 10 of 14 sets.");
  });

  it("the coach's read of it, paid for already: its glance — one that never finished says nothing", async () => {
    await seedActivity({ id: "a5", date: today });
    await seedRead("a5", "Even splits — a calm, honest long effort");
    const { opening } = await read();
    expect(opening).toMatchObject({ source: "read", line: "Today's run: Even splits — a calm, honest long effort." });
    expect(opening).not.toHaveProperty("workoutId");
    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    await seedActivity({ id: "a6", date: today });
    await seedRead("a6", "Half a thought", "failed");
    expect((await read()).opening).toMatchObject({ source: "session", line: "Today's run is in — 16 km at 5:40 /km." });
  });

  it("a match the athlete undid names no plan session: the run is a run", async () => {
    await seedActivity({ id: "a13", date: today, workout: { id: "w13", category: "long" } });
    await db.update(schema.workoutCompletionMatches).set({ undoneAt: nowInstant() });
    const { opening } = await read();
    expect(opening?.line).toBe("Today's run is in — 16 km at 5:40 /km.");
    expect(opening).not.toHaveProperty("workoutId");
  });

  it("not news: one two days back, a fragment under five minutes, a walk no plan asked for", async () => {
    await seedActivity({ id: "old", date: addDays(today, -2) });
    expect((await read()).opening).toBeNull();
    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    await seedActivity({ id: "frag", date: today, seconds: 240 });
    expect((await read()).opening).toBeNull();
    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    await seedActivity({ id: "walk", date: today, sport: "walk", seconds: 1800, meters: 2500, pace: null });
    expect((await read()).opening).toBeNull();
  });

  it("a walk that completed a planned session is: named by what was planned", async () => {
    await seedActivity({ id: "walk", date: today, sport: "walk", seconds: 1800, meters: 2500, pace: null, workout: { id: "w3", category: "recovery" } });
    expect((await read()).opening?.line).toBe("Today's recovery run is done — 2.5 km, 30 min.");
  });

  it("the newest real one, past a fragment after it", async () => {
    await seedActivity({ id: "real", date: today });
    await db.insert(schema.activities).values({
      id: "frag",
      userId,
      startTime: `${today}T15:00:00Z`,
      startTimeLocal: `${today}T08:00:00`,
      sport: "run",
      durationSeconds: 120,
      sourceMergeConfidence: 1,
      createdAt: iso(HOUR),
      updatedAt: iso(HOUR),
    });
    expect((await read()).opening?.id).toBe("session:real");
  });

  it("old news once the athlete has asked the coach anything since it arrived — not before it, nor a sub-run's brief", async () => {
    await seedActivity({ id: "a7", date: today, arrivedAt: iso(3 * HOUR) });
    await seedAsk("Something for my hips", iso(5 * HOUR));
    await seedAsk("a designer's brief", iso(HOUR), "parent");
    expect((await read()).opening?.id).toBe("session:a7");
    await seedAsk("Plan my week", iso(2 * HOUR));
    expect((await read()).opening).toBeNull();
  });
});

describe("on Monday: last week's review", () => {
  it("its first sentence, with Plan this week", async () => {
    await seedReview();
    expect((await read()).opening).toEqual({
      id: `review:${lastWeek()}`,
      line: "From last week's review: You ran 4 times for 32.1 kilometres.",
      source: "review",
      chips: [{ id: `review:${lastWeek()}`, label: "Plan this week", request: "Plan my week around how last week went." }],
    });
  });

  it("none for an older week's, nor one the cron wrote without words", async () => {
    await seedReview({ weekStart: addDays(lastWeek(), -7) });
    expect((await read()).opening).toBeNull();
    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    await seedReview({ narrative: null });
    expect((await read()).opening).toBeNull();
  });

  it("stays until the athlete asks the coach anything — however many days since it was written", async () => {
    await seedReview({ createdAt: iso(6 * 24 * HOUR) });
    await seedAsk("Something for my hips", iso(7 * 24 * HOUR));
    expect((await read()).opening?.source).toBe("review");
    await seedAsk("Something for my hips", iso(5 * 24 * HOUR));
    expect((await read()).opening).toBeNull();
  });
});

describe("which line: the review, then the session, then none (the screen's own) — one shown here gives way", () => {
  it("the review before a session; the session once the review was shown here; none once both were", async () => {
    await seedReview();
    await seedActivity({ id: "a8", date: today });
    expect((await read()).opening?.id).toBe(`review:${lastWeek()}`);
    expect((await read([`review:${lastWeek()}`])).opening?.id).toBe("session:a8");
    expect((await read([`review:${lastWeek()}`, "session:a8"])).opening).toBeNull();
  });

  it("the review asked about, the session after it still news", async () => {
    await seedReview({ createdAt: iso(10 * HOUR) });
    await seedAsk("Plan my week", iso(5 * HOUR));
    await seedActivity({ id: "a9", date: today, arrivedAt: iso(2 * HOUR) });
    expect((await read()).opening?.id).toBe("session:a9");
  });

  it("the needs-you chips are as they were beside it", async () => {
    await seedReview();
    prefs = { ...prefs, raceDate: addDays(today, 10) };
    await savePreferences(db, userId, prefs);
    const out = await read();
    expect(out.opening?.source).toBe("review");
    expect(out.nudges.map((n) => n.id)).toEqual([`race:${addDays(today, 10)}`]);
  });

  it("the asks read back as far as the review are for the line alone: a chip asked four days ago is offered again", async () => {
    await seedReview({ createdAt: iso(6 * 24 * HOUR) });
    prefs = { ...prefs, raceDate: addDays(today, 10) };
    await savePreferences(db, userId, prefs);
    await seedAsk("Get me ready for race day", iso(4 * 24 * HOUR));
    const out = await read();
    expect(out.opening).toBeNull();
    expect(out.nudges.map((n) => n.id)).toEqual([`race:${addDays(today, 10)}`]);
  });
});

describe("the cost", () => {
  it("writes nothing; six statements at most — the review and the session in the reads already made, and one for the asks", async () => {
    await seedReview();
    await seedActivity({ id: "a10", date: today, sport: "strength", meters: null, pace: null, workout: { id: "w10", category: "strength" } });
    await seedSets("a10", { done: 12, completed: true });
    await seedRead("a10", "Solid");
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "10K",
      status: "active",
      startDate: addDays(today, -30),
      endDate: addDays(today, 40),
      stampPrefix: "10K",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.coachPlanWeeks).values({ id: newId(), planId: "cp1", weekStart: addDays(today, 4), state: "shape", shape: { volumeTarget: "40k", keySessions: ["long"] } });
    await seedAsk("Something", iso(30 * HOUR));
    statements.length = 0;
    const out = await read();
    expect(out.opening?.source).toBe("review");
    expect(out.nudges.length).toBe(1);
    expect(statements.filter(isWrite)).toEqual([]);
    // The missed sessions, the activities (with what each completed, its sets and its read), the plans, the review;
    // the plan's outline weeks; the athlete's asks.
    expect(statements.length).toBe(6);
  });

  it("four on a quiet account; five with a line to offer (its asks read)", async () => {
    statements.length = 0;
    expect(await read()).toEqual({ opening: null, nudges: [] });
    expect(statements.length).toBe(4);
    await seedActivity({ id: "a11", date: today });
    statements.length = 0;
    expect((await read()).opening?.id).toBe("session:a11");
    expect(statements.length).toBe(5);
    // Every line already shown here: nothing to ask about.
    statements.length = 0;
    expect((await read(["session:a11"])).opening).toBeNull();
    expect(statements.length).toBe(4);
  });
});

describe("GET /api/coach/nudges", () => {
  const env = {
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
    COACH_DESIGNER: "1",
  } as Env;
  let cookie = "";
  beforeEach(async () => {
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  });
  const get = (query = "") =>
    mountRoutes(db, "/api/coach/nudges", makeCoachNudgesRoutes({ now: () => new Date() })).request(`/api/coach/nudges${query}`, { headers: { Cookie: cookie } }, env);

  it("answers the opening beside the nudges, `?seen=` giving way, in seven statements with the sign-in and the preferences", async () => {
    await seedReview();
    await seedActivity({ id: "a12", date: today });
    const first = await get();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { opening: { id: string } }).opening.id).toBe(`review:${lastWeek()}`);
    statements.length = 0;
    const res = await get(`?seen=review:${lastWeek()}`);
    const body = (await res.json()) as { nudges: unknown[]; opening: { id: string; line: string } };
    expect(body.nudges).toEqual([]);
    expect(body.opening).toMatchObject({ id: "session:a12", line: "Today's run is in — 16 km at 5:40 /km." });
    expect(statements.filter(isWrite)).toEqual([]);
    // The sign-in, the preferences; the missed sessions, the activities, the plans, the review; the asks.
    expect(statements.length).toBe(7);
  });

  it("with nothing to say, the shape an older screen knows: { nudges } alone", async () => {
    expect(await (await get()).json()).toEqual({ nudges: [] });
  });
});
