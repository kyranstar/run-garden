/**
 * Route-level tests for `GET /api/garden/timeline` (apps/worker/src/routes/garden.ts):
 * the day-slider scrubber replays every durably simulated day from the
 * stored `gardenDayInputs` rows (`buildGardenTimeline`, garden-sync.ts).
 * Must be read-only (never touches `gardenState`), return one entry per
 * simulated day in ascending date order, and be deterministic across repeat
 * calls. Mounts `gardenRoutes` the same way plan-routes.test.ts /
 * sync-routes.test.ts mount their route modules.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import {
  FixtureTrainingProvider,
  fixtureCorosCompletedThreshold,
  normalizeCorosActivity,
} from "@rg/providers";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { gardenRoutes } from "../src/routes/garden.js";
import { advanceGarden } from "../src/services/garden-sync.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { ingestActivities } from "../src/services/completion.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { gardenState, gardenDayInputs, plannedWorkouts } = schema;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

interface TimelineDto {
  days: Array<{ date: string; view: { snapshot: { state: Record<string, unknown> }; condition: string } }>;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let provider: FixtureTrainingProvider;
let baseMonday: string;

function client() {
  const app = mountRoutes(db, "/api/garden", gardenRoutes);
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
  };
}

async function importFromProvider() {
  const plan = await provider.getCurrentPlan();
  const range = { start: baseMonday, end: addDays(baseMonday, 13) };
  const workouts = await provider.getPlannedWorkouts(range);
  return importPlanSnapshot(
    db,
    { userId, plan: plan!, workouts, rangeStart: range.start, rangeEnd: range.end, source: "fixture" },
    prefs,
  );
}

/**
 * Seed a small history: import the fixture plan, complete its quality
 * workout, then advance the garden several days past it so a handful of
 * days get durably simulated (and written to `gardenDayInputs`) — the same
 * "garden integration" shape vertical-loop.test.ts uses.
 */
async function seedHistory(daysPast = 6) {
  await importFromProvider();
  const w = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Threshold 5x5")))[0]!;
  const startIso = `${w.effectiveDate}T14:02:05Z`;
  const { item, detail } = fixtureCorosCompletedThreshold(startIso);
  await ingestActivities(db, { userId, sources: [normalizeCorosActivity(item, detail)] });

  const now = new Date(`${addDays(w.effectiveDate, daysPast)}T12:00:00Z`);
  const result = await advanceGarden(db, userId, prefs, now);
  return { workout: w, result };
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
  const today = todayInZone(prefs.timezone);
  baseMonday = addDays(today, 2);
  provider = new FixtureTrainingProvider({ baseMonday });
});

describe("GET /api/garden/timeline", () => {
  it("returns one entry per durably simulated day, ascending, matching the stored day-input rows", async () => {
    const { result } = await seedHistory();
    expect(result.simulatedDays).toBeGreaterThan(0);

    const res = await client().get("/api/garden/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineDto;

    const rows = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
    expect(body.days.length).toBe(rows.length);
    expect(body.days.length).toBeGreaterThan(1); // multiple days, so ordering is a real assertion

    const dates = body.days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length); // no duplicate/repeated day

    // Every returned view carries what GardenScene + its condition label need.
    for (const day of body.days) {
      expect(day.view.snapshot.state.lastSimulatedDate).toBe(day.date);
      expect(typeof day.view.condition).toBe("string");
    }
  });

  it("replays to exactly the durably persisted state at the last simulated day", async () => {
    await seedHistory();
    const body = (await (await client().get("/api/garden/timeline")).json()) as TimelineDto;
    const last = body.days[body.days.length - 1]!;

    const stored = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(last.date).toBe(stored.lastSimulatedDate);
    expect(last.view.snapshot.state).toEqual((stored.snapshot as { state: unknown }).state);
  });

  it("is deterministic across repeat calls", async () => {
    await seedHistory();
    const first = await (await client().get("/api/garden/timeline")).json();
    const second = await (await client().get("/api/garden/timeline")).json();
    expect(second).toEqual(first);
  });

  it("never mutates gardenState — a read-only replay", async () => {
    await seedHistory();
    const before = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    const res = await client().get("/api/garden/timeline");
    expect(res.status).toBe(200);

    const after = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(after).toEqual(before);
    // And it didn't add/remove day-input rows either (no re-simulation as a side effect).
    const rowsBefore = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
    await client().get("/api/garden/timeline");
    const rowsAfter = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
    expect(rowsAfter.length).toBe(rowsBefore.length);
  });

  it("returns an empty list before any day has been durably simulated", async () => {
    // No advanceGarden call — the garden row doesn't exist yet.
    const res = await client().get("/api/garden/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineDto;
    expect(body.days).toEqual([]);
  });
});
