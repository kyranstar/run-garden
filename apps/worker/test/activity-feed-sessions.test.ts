/**
 * THE ACTIVITY FEED — APP, MERGED AND IMPORTED SESSIONS (Phase 2d Task 2; spec §2d "Activity feed"; mocks §8;
 * ruling 2d-R4: built on 2a+'s `logged`, one reader of sets).
 *
 * Review Focus 3: an app session the watch also recorded is ONE row — the watch's heart rate, the app's sets, its
 * mode and its check values — and the garden counts it once. An imported session carries no heart rate and says
 * where it came from (`performed.source`); the weights it was logged with are shown as typed.
 *
 * Every date is passed explicitly (the save's `now`, the garden's walk), and every day is after APP_SESSION_EPOCH
 * (2026-10-08, ruling 2d-R1), so the garden's app-session gate cannot change these cases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, type PerformedSessionWireInput, type SourceActivity, type UserPreferences } from "@rg/domain";
import { THEMES } from "@rg/exercise-library";
import type { GardenDayInput } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import { buildSession, startSession, type BuildPayload } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { ingestActivities } from "../src/services/completion.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { importStandalone } from "../src/services/standalone-import.js";
import { activityRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { detailOf, makeEnv, workView } from "./watch-sets-fixture.js";
import { backup, entry, kg, lb, v2Session } from "./fixtures/standalone-backup.js";

const { conditionChecks, gardenDayInputs, plannedWorkouts, programs, userConditions } = schema;

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** Played on DAY (a Tuesday, noon in Los Angeles — the test user's zone); saved the next morning. */
const DAY = "2026-10-13";
const NOON = "2026-10-13T19:00:00.000Z";
const SAVED = "2026-10-14T16:00:00.000Z";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
  await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
  programId = newId();
  await db.insert(programs).values({
    id: programId,
    userId,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: NOON,
    updatedAt: NOON,
    archivedAt: null,
  });
});

async function startedSlot(): Promise<{ workoutId: string; build: BuildPayload }> {
  const workoutId = slotId(programId, DAY);
  await db.insert(plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: programId,
    sourceWorkoutId: workoutId,
    title: "Mobility",
    category: "strength",
    sport: "strength",
    originalPlanDate: DAY,
    lastVerifiedCorosDate: "",
    effectiveDate: DAY,
    effectiveTime: "12:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin: "program",
    contentState: "outline",
    createdAt: NOON,
    updatedAt: NOON,
  });
  const built = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: DAY, now: NOON, prefs });
  const locked = await startSession(db, userId, workoutId, built.build!.buildId, NOON);
  return { workoutId, build: locked.build! };
}

/** What the review saves: one move logged in pounds then kilograms (weights as typed), the session's own checks. */
function payload(s: { workoutId: string; build: BuildPayload }, checks: PerformedSessionWireInput["checks"]): PerformedSessionWireInput {
  const [first] = s.build.items;
  return {
    id: "5d2c1b4a-7e6f-4a8b-9c0d-2e3f4a5b6c7d",
    source: "app",
    sourceRef: null,
    workoutId: s.workoutId,
    buildId: s.build.buildId,
    localDate: DAY,
    startedAt: "2026-10-13T19:05:00.000Z",
    endedAt: "2026-10-13T19:36:00.000Z",
    seconds: 1860,
    plannedSeconds: s.build.plannedSeconds,
    minutes: s.build.minutes,
    mode: s.build.mode,
    theme: s.build.theme,
    locationId: s.build.locationId,
    blockRef: s.build.blockRef,
    blockNumber: 1,
    completed: true,
    stepsTotal: s.build.steps.length,
    stepsDone: s.build.steps.length,
    movesDone: s.build.items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120 })),
    note: null,
    newMove: s.build.newMove,
    entries: [
      {
        exerciseId: first!.exerciseId,
        implement: "kettlebell",
        format: "straight",
        perSide: false,
        sets: [
          { setIndex: 0, reps: 6, seconds: null, load: { v: 30, u: "lb" } },
          { setIndex: 1, reps: 6, seconds: null, load: { v: 12, u: "kg" } },
        ],
      },
    ],
    checks,
    review: {},
  };
}

const watch = (over: Partial<SourceActivity> = {}): SourceActivity => ({
  provider: "coros",
  providerActivityId: "lbl-strength-7001",
  startTime: "2026-10-13T19:06:00Z",
  startTimeLocal: "2026-10-13T12:06:00",
  sport: "strength",
  durationSeconds: 1850,
  avgHeartRate: 104,
  title: "Strength",
  contentFingerprint: "fp-1",
  ...over,
});
const watchDetails = { "lbl-strength-7001": detailOf(workView()) };

interface FeedRow {
  id: string;
  sport: string;
  date: string;
  avgHeartRate: number | null;
  logged: Array<{ exerciseId: string; name: string; sets: Array<{ reps: number | null; load: { v: number; u: string } | null }> }> | null;
  performed: {
    source: string;
    mode: string | null;
    theme: string | null;
    checks: Array<{ profileId: string; label: string; pre: number | null; post: number | null }>;
  } | null;
}

async function feed(): Promise<FeedRow[]> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const app = mountRoutes(db, "/api/activities", activityRoutes);
  const res = await app.request("/api/activities?limit=20", { headers: { Cookie: cookie } }, makeEnv());
  expect(res.status).toBe(200);
  return ((await res.json()) as { activities: FeedRow[] }).activities;
}

const dayInput = async (date: string): Promise<GardenDayInput | undefined> =>
  (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`)))[0]?.input as unknown as
    | GardenDayInput
    | undefined;

const TMJ_CHECKS: PerformedSessionWireInput["checks"] = [
  { profileId: "tmj", kind: "pre", value: 2, feelingOff: false, at: "2026-10-13T19:04:00.000Z" },
  { profileId: "tmj", kind: "post", value: 1, feelingOff: false, at: "2026-10-13T19:37:00.000Z" },
];

describe("a merged session — the app's save and the watch's recording (Review Focus 3)", () => {
  it.each([
    ["the watch first, the app's save joins it", "watch-first"],
    ["the app's save first, the watch's ingest adopts it", "app-first"],
  ] as const)("%s: one row, the watch's heart rate, the app's sets, mode and checks; the garden counts it once", async (_name, order) => {
    await ensureGarden(db, userId, prefs, "2026-10-05");
    const s = await startedSlot();
    const body = payload(s, TMJ_CHECKS);
    if (order === "watch-first") {
      await ingestActivities(db, { userId, sources: [watch()], strengthDetailsByProviderId: watchDetails });
      expect(await savePerformedSession(db, userId, body.id, body, { now: SAVED, prefs })).toMatchObject({ status: "saved" });
    } else {
      expect(await savePerformedSession(db, userId, body.id, body, { now: SAVED, prefs })).toMatchObject({ status: "saved" });
      await ingestActivities(db, { userId, sources: [watch()], strengthDetailsByProviderId: watchDetails });
    }

    const rows = (await feed()).filter((a) => a.date === DAY);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.avgHeartRate).toBe(104);
    // The app's sets — never the watch copy's Bench Press — with each weight exactly as typed.
    expect(row!.logged!.map((e) => e.exerciseId)).toEqual([s.build.items[0]!.exerciseId]);
    expect(row!.logged![0]!.sets.map((x) => [x.reps, x.load])).toEqual([
      [6, { v: 30, u: "lb" }],
      [6, { v: 12, u: "kg" }],
    ]);
    const theme = s.build.theme ? THEMES.find((t) => t.id === s.build.theme)!.name : null;
    const playedOnly = s.build.items.filter((i) => i.exerciseId !== s.build.items[0]!.exerciseId);
    expect(row!.performed).toEqual({
      source: "app",
      mode: "build",
      theme,
      // The check's words are the profile's own (`check.label`), never the UI's.
      checks: [{ profileId: "tmj", label: "Jaw / head", pre: 2, post: 1 }],
      // The moves played without a logged set: counted, with their time (mocks §8's last line).
      played: playedOnly.length > 0 ? { moves: playedOnly.length, seconds: 120 * playedOnly.length } : null,
    });

    await advanceGarden(db, userId, prefs, new Date(SAVED));
    const credited = (await dayInput(DAY))!.completedRuns;
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({ workoutId: s.workoutId });
  });

  it("a pre-check the session sheet recorded before the save (not written twice) still pairs with the session's post", async () => {
    const s = await startedSlot();
    await db.insert(conditionChecks).values({
      id: newId(),
      userId,
      profileId: "tmj",
      kind: "pre",
      value: 4,
      feelingOff: false,
      localDate: DAY,
      at: "2026-10-13T18:55:00.000Z",
      performedSessionId: null,
      workoutId: s.workoutId,
    });
    const body = payload(s, TMJ_CHECKS);
    await savePerformedSession(db, userId, body.id, body, { now: SAVED, prefs });
    const [row] = (await feed()).filter((a) => a.date === DAY);
    expect(row!.performed!.checks).toEqual([{ profileId: "tmj", label: "Jaw / head", pre: 4, post: 1 }]);
  });
});

describe("an imported session", () => {
  it("has no heart rate, says it was imported, and shows its weights as typed — kilograms to a pounds athlete", async () => {
    const file = backup([
      v2Session("2026-09-14", {
        pre: 3,
        post: 1,
        mode: "consistent",
        entries: [entry("deadlift", [{ w: kg(16), reps: 6 }]), entry("gobletSquat", [{ w: lb(25), reps: 8 }])],
      }),
    ]);
    await importStandalone(db, userId, file, { today: DAY, now: SAVED, timezone: prefs.timezone, dryRun: false });
    const rows = await feed();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.avgHeartRate).toBeNull();
    expect(row!.logged!.map((e) => [e.exerciseId, e.sets.map((x) => x.load)])).toEqual([
      ["deadlift", [{ v: 16, u: "kg" }]],
      ["gobletSquat", [{ v: 25, u: "lb" }]],
    ]);
    expect(row!.performed).toEqual({
      source: "import",
      mode: "consistent",
      theme: null,
      checks: [{ profileId: "tmj", label: "Jaw / head", pre: 3, post: 1 }],
      played: null,
    });
  });
});

describe("a watch-only strength session (the live account today)", () => {
  it("keeps 2a+'s view — the watch's sets in the athlete's unit — with no mode, theme or checks", async () => {
    await ingestActivities(db, { userId, sources: [watch()], strengthDetailsByProviderId: watchDetails });
    const [row] = await feed();
    expect(row!.avgHeartRate).toBe(104);
    expect(row!.logged!.map((e) => e.name)).toEqual(["Bench Press", "Dumbbell Row", "Planks", "Push-ups"]);
    // 12 kg on the watch → 26.5 lb for a pounds athlete: the watch's copy is not the athlete's typing (2a+).
    expect(row!.logged![1]!.sets[0]!.load).toEqual({ v: 26.5, u: "lb" });
    expect(row!.performed).toEqual({ source: "watch", mode: null, theme: null, checks: [], played: null });
  });

  it("a run with nothing logged says null for both", async () => {
    await ingestActivities(db, {
      userId,
      sources: [watch({ providerActivityId: "lbl-run-1", sport: "run", avgHeartRate: 141, title: "Easy run" })],
    });
    const [row] = await feed();
    expect(row).toMatchObject({ sport: "run", avgHeartRate: 141, logged: null, performed: null });
  });
});
