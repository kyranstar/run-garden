/**
 * A DESIGNED RUN ON THE PLAN (§8 §3): Today and Plan show it as they show a plan run — its stages, its summary — and
 * the session sheet's "what the watch will show" reads it as the wire will carry it before its create has landed: a
 * timed run says nothing (it crosses whole), a distance goes as its time, and one no pace can time stays here until the
 * threshold is known. Written by the approve's own writer (`createDesignedRun`); read back through `GET
 * /api/plan/workouts/:id`. Synthetic data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { createDesignedRun } from "../src/services/designed-runs.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: "k", ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c" } as unknown as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let today: string;
beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  // Writes off: the row stays as the approve wrote it (no create lands), as it is while one is on its way.
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: false }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  today = todayInZone(prefs.timezone);
});

const run = (cooldown: Record<string, unknown>): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: cooldown }] },
  ],
  source: { kind: "coach" },
  basedOn: { kind: "proposal", id: "dp-x", opId: "x" },
});

async function made(doc: WorkoutDoc, key: string) {
  const r = await createDesignedRun(db, userId, { date: addDays(today, 2), time: null, doc, clientId: key }, { today, now: nowInstant(), prefs }, { sourceKind: "coach" });
  return r.workout.id;
}
async function workout(id: string) {
  const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}`, { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { workout: Record<string, any> }).workout;
}
async function threshold() {
  await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: addDays(today, -1), thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: nowInstant() });
}

describe("a designed run, read on the plan", () => {
  it("a timed run with a threshold: its stage summary, and silence about the watch (it crosses whole)", async () => {
    await threshold();
    const w = await workout(await made(run({ durationSec: 600 }), "a"));
    expect(w.stageSummary).toBe("10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy");
    expect(w.watchCoverage).toBeUndefined();
  });

  it("a distance with a threshold: on the watch by its time", async () => {
    await threshold();
    const w = await workout(await made(run({ distanceM: 2000 }), "b"));
    expect(w.watchCoverage).toEqual({ coverage: "partial", discipline: "run", gaps: [{ code: "distance_as_time", count: 1 }] });
  });

  it("a distance with no threshold: it stays here until one is known", async () => {
    const w = await workout(await made(run({ distanceM: 2000 }), "c"));
    expect(w.watchCoverage).toEqual({ coverage: "none", discipline: "run", gaps: [{ code: "distance_needs_threshold", count: 1 }] });
  });

  it("timed with no threshold: on the watch with no pace targets — the steps a threshold would pace, written out, counted", async () => {
    const w = await workout(await made(run({ durationSec: 600 }), "d"));
    // Warm-up, three tempo reps, cool-down: five steps a threshold would pace, as `runWatchSteps` counts them (the jogs go
    // bare: review-2 M1).
    expect(w.watchCoverage).toEqual({ coverage: "partial", discipline: "run", gaps: [{ code: "pace_targets_owed", count: 5 }] });
  });
});
