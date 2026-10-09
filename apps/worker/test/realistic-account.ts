/**
 * A realistic account at the moment a new activity has landed, for measuring what the hourly cron spends on it
 * (cron reliability, part 2). On top of the fixture-mode seed (a 12-week plan nine weeks in, its runs, sixty days
 * of health, the Plan Studio world and an adaptive program with slots) it adds months of older history — runs with
 * km laps, strength sessions with the sets the watch logged, yoga, health and sleep every day — a garden grown
 * from four months back, an active coach plan with firm and shape weeks, standing coach memory, a month of LLM
 * spend, every older effort already read, and a cloud COROS connection on the mock server. Then the new
 * activities: yesterday's threshold run with its laps and a strength session with its sets, each queued for a
 * coach read, with the garden two days behind. Synthetic throughout; dates are relative to the real clock.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, fingerprint, newId, nowInstant, todayInZone, type SourceActivity, type UserPreferences } from "@rg/domain";
import {
  fixtureCorosCompletedStrength,
  fixtureCorosCompletedThreshold,
  fixtureCorosCompletedYoga,
  fixtureCorosStrengthLapList,
  normalizeCorosActivity,
  normalizeCorosLaps,
} from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { seedFixtures } from "../src/services/fixtures.js";
import { ingestActivities, type IngestInput } from "../src/services/completion.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { enqueueCoachReads } from "../src/services/coach-reads.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { makeTestUser } from "./helpers.js";

export const LLM_BASE_URL = "https://llm-gateway.test/v1";

export function makeRealisticEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    AI_GATEWAY_API_KEY: "test-key",
    AI_GATEWAY_BASE_URL: LLM_BASE_URL,
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...overrides,
  } as Env;
}

/**
 * The gateway's streamed answer to a read, as the real one sends it: one SSE event per token or so (`pieces` of
 * them), the usage on the last. The content is a valid read.
 */
export function sseReadResponse(pieces = 320): Response {
  const read = JSON.stringify({
    glance: "Threshold reps held steady; HR drifted late in the fourth.",
    body: "A controlled threshold session. ".repeat(24).trim(),
    flags: ["hr_drift"],
  });
  const step = Math.max(1, Math.ceil(read.length / pieces));
  const events: string[] = [];
  for (let i = 0; i < read.length; i += step) {
    events.push(
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: read.slice(i, i + step) }, finish_reason: null }] })}\n\n`,
    );
  }
  events.push(
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2400, completion_tokens: pieces } })}\n\n`,
    "data: [DONE]\n\n",
  );
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export interface RealisticAccount {
  userId: string;
  prefs: UserPreferences;
  env: Env;
  /** The global-fetch stand-in: the COROS mock for COROS, a streamed read for the gateway. Counts every call. */
  fetchImpl: typeof fetch;
  fetches: { coros: number; llm: number };
  /** The mock COROS account behind `fetchImpl` (its `state` is live: what the next read lists). */
  coros: ReturnType<typeof mockCorosServer>;
  /** The new activities' ids (each with a queued coach read). */
  newActivityIds: string[];
}

function runSource(date: string, i: number, kind: "easy" | "long" | "tempo"): SourceActivity {
  const spec = { easy: { dur: 2760, dist: 7300, hr: 138, load: 38 }, long: { dur: 6720, dist: 18100, hr: 145, load: 96 }, tempo: { dur: 3300, dist: 9900, hr: 156, load: 78 } }[kind];
  return {
    provider: "coros",
    providerActivityId: `rg-hist-run-${date}`,
    startTime: `${date}T14:0${i % 6}:00Z`,
    startTimeLocal: `${date}T07:0${i % 6}:00`,
    timezone: "America/Los_Angeles",
    sport: "run",
    durationSeconds: spec.dur + ((i * 37) % 120),
    elapsedSeconds: spec.dur + ((i * 37) % 120) + 45,
    distanceMeters: spec.dist + ((i * 53) % 400),
    avgHeartRate: spec.hr + (i % 4),
    maxHeartRate: spec.hr + 18,
    elevationGainMeters: 40 + (i % 5) * 12,
    trainingLoad: spec.load,
    deviceName: "COROS PACE 3",
    title: kind === "long" ? "Long Run" : kind === "tempo" ? "Tempo" : "Morning Run",
    contentFingerprint: fingerprint({ date, kind, hist: true }),
  };
}

const kmLaps = (n: number, pace: number) =>
  Array.from({ length: n }, (_, k) => ({
    lapIndex: k,
    durationSeconds: pace + (k % 3),
    distanceMeters: 1000,
    avgPaceSecPerKm: pace + (k % 3),
    avgHeartRate: 140 + (k % 9),
    splitType: "auto_km",
  }));

/**
 * Build the account. `historyDays` of activity history (the fixture's nine weeks included), a garden grown from
 * `gardenDays` back, left `gardenBehindDays` short of where the hourly cron would take it.
 */
export async function seedRealisticAccount(
  db: Db,
  opts: {
    historyDays?: number;
    gardenDays?: number;
    newActivities?: boolean;
    gardenBehindDays?: number;
    /** The mock COROS account's week (its activities land on its Tuesday); next week's by default. */
    corosBaseMonday?: string;
  } = {},
): Promise<RealisticAccount> {
  const historyDays = opts.historyDays ?? 180;
  const gardenDays = opts.gardenDays ?? 120;
  const env = makeRealisticEnv();
  const { userId } = await makeTestUser(db, { aiEnabled: true });
  await seedFixtures(db, env, userId);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();

  // The fixture's own history starts on its plan's Monday, nine-odd weeks back; older history fills in before it.
  const fixtureStart = addDays(today, -(9 * 7 + 7));
  const sources: SourceActivity[] = [];
  const lapsByProviderId: NonNullable<IngestInput["lapsByProviderId"]> = {};
  const strengthDetailsByProviderId: NonNullable<IngestInput["strengthDetailsByProviderId"]> = {};
  for (let d = historyDays; d > 0; d--) {
    const date = addDays(today, -d);
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
    const i = historyDays - d;
    if (date < fixtureStart) {
      if (weekday === 1 || weekday === 3) sources.push(runSource(date, i, weekday === 1 ? "tempo" : "easy"));
      if (weekday === 5) {
        const long = runSource(date, i, "long");
        sources.push(long);
        lapsByProviderId[long.providerActivityId] = kmLaps(18, 370);
      }
      if (weekday === 6) sources.push(runSource(date, i, "easy"));
      if (weekday === 4) sources.push(normalizeCorosActivity(fixtureCorosCompletedYoga(`${date}T15:00:00Z`, `rg-hist-yoga-${date}`)));
    }
    // Strength twice a week through the whole history (the fixture has one), with the sets the watch logged.
    if ((weekday === 0 || weekday === 2) && date !== addDays(today, -1)) {
      const item = fixtureCorosCompletedStrength(`${date}T19:00:00Z`, `rg-hist-strength-${date}`);
      sources.push(normalizeCorosActivity(item));
      strengthDetailsByProviderId[item.labelId] = { lapList: fixtureCorosStrengthLapList() };
    }
    if (d > 60) {
      await db
        .insert(schema.dailyHealth)
        .values({
          id: `${userId}:${date}`, userId, date, restingHeartRate: 45 + (i % 5), hrv: 58 + ((i * 7) % 18),
          recoveryScore: 60 + ((i * 11) % 35), trainingLoad7d: 280 + ((i * 13) % 120), dayLoad: 30 + ((i * 7) % 45),
          sleepHrvBase: 68, sleepHrvSd: 6, provider: "coros", contentFingerprint: fingerprint({ date, i, hist: true }), updatedAt: now,
        })
        .onConflictDoNothing();
      await db
        .insert(schema.sleepRecords)
        .values({
          id: `${userId}:${date}`, userId, date, durationSeconds: (6.5 + (i % 10) / 10) * 3600, deepSeconds: 4800, remSeconds: 5400,
          qualityScore: 70, provider: "coros", contentFingerprint: fingerprint({ date, sleep: i, hist: true }), updatedAt: now,
        })
        .onConflictDoNothing();
    }
  }
  for (let k = 0; k < sources.length; k += 40) {
    await ingestActivities(db, { userId, sources: sources.slice(k, k + 40), lapsByProviderId, strengthDetailsByProviderId });
  }

  // An active coach plan: four firm weeks, four in shape.
  const planId = newId();
  const planStart = addDays(today, -14);
  await db.insert(schema.coachPlans).values({
    id: planId, userId, discipline: "run", name: "Autumn 10K block", status: "active", startDate: planStart,
    endDate: addDays(planStart, 8 * 7 - 1), raceDate: addDays(planStart, 8 * 7 - 1), stampPrefix: "RG", createdAt: now, updatedAt: now,
  });
  for (let w = 0; w < 8; w++) {
    await db.insert(schema.coachPlanWeeks).values({
      id: newId(), planId, weekStart: addDays(planStart, w * 7), state: w < 4 ? "firm" : "shape",
      shape: w < 4 ? null : { volumeTarget: `${30 + w * 2} km`, keySessions: ["tempo", "long run"] },
    });
  }
  for (const [k, body] of [
    ["fact", "Runs early, before work; evenings are for strength."],
    ["rule", "Never two hard days in a row."],
    ["fact", "Left calf tightens after long downhill runs."],
    ["note", "Prefers effort cues over pace targets on trails."],
    ["fact", "Targets a 10K in late autumn."],
    ["rule", "Keep strength on Mondays and Wednesdays."],
  ] as const) {
    await db.insert(schema.coachMemory).values({
      id: newId(), userId, kind: k, body, provenance: { source: "chat", at: now }, learnedAt: now, expiresAt: null, active: true,
    });
  }
  // A month of spend, well under the auto-read reserve.
  for (let d = 0; d < 20; d++) {
    await db.insert(schema.llmUsage).values({
      id: newId(), userId, kind: "coach_read", model: "m", inputTokens: 2400, outputTokens: 300, costMicros: 40_000,
      createdAt: new Date(Date.now() - d * 3600_000).toISOString(),
    });
  }
  // Every effort so far already read — the whole history's ledger, each read a full body long.
  const read = { glance: "Steady aerobic work; HR stayed in its band.", body: "A steady, honest effort. ".repeat(36).trim() };
  for (const a of await db.select({ id: schema.activities.id }).from(schema.activities).where(eq(schema.activities.userId, userId))) {
    await db.insert(schema.coachReads).values({
      id: newId(), userId, activityId: a.id, status: "done", attempt: 1, nextAttemptAt: now, claimToken: null, claimedAt: null,
      ...read, flags: [], model: "m", createdAt: now, completedAt: now,
    });
  }

  // The new activities: yesterday's threshold with its laps, and a strength session with its sets.
  const newActivityIds: string[] = [];
  if (opts.newActivities !== false) {
    const yesterday = addDays(today, -1);
    const { item, detail } = fixtureCorosCompletedThreshold(`${yesterday}T14:02:05Z`, `rg-new-run-${yesterday}`);
    const strength = fixtureCorosCompletedStrength(`${yesterday}T23:30:00Z`, `rg-new-strength-${yesterday}`);
    await ingestActivities(db, {
      userId,
      sources: [normalizeCorosActivity(item, detail), normalizeCorosActivity(strength)],
      lapsByProviderId: { [item.labelId]: normalizeCorosLaps(detail) as never },
      strengthDetailsByProviderId: { [strength.labelId]: { lapList: fixtureCorosStrengthLapList() } },
    });
    await enqueueCoachReads(db, userId, today);
    const queued = await db
      .select({ activityId: schema.coachReads.activityId })
      .from(schema.coachReads)
      .where(and(eq(schema.coachReads.userId, userId), eq(schema.coachReads.status, "queued")));
    newActivityIds.push(...queued.map((r) => r.activityId));
  }

  // The garden, regrown from `gardenDays` back to two days short of the cron's reach.
  for (const t of [schema.gardenState, schema.gardenEvents, schema.gardenSnapshots, schema.gardenDayInputs, schema.gardenPlants, schema.gardenUnlocks, schema.gardenWildlife]) {
    await db.delete(t).where(eq(t.userId, userId));
  }
  await ensureGarden(db, userId, prefs, addDays(today, -gardenDays));
  // Grown as of `gardenBehindDays - 2` days ago: the walk then stops two days short of that (grace), so the cron's
  // walk has about `gardenBehindDays` days to take (two by default — what a new activity leaves).
  await advanceGarden(db, userId, prefs, new Date(Date.now() - Math.max(0, (opts.gardenBehindDays ?? 3) - 2) * 86_400_000));

  // A cloud COROS connection on the mock server; every fetch from here on goes through the counting router.
  const server = mockCorosServer(opts.corosBaseMonday ? { baseMonday: opts.corosBaseMonday } : {});
  await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const connected = await connectCoros(db, env, userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  if (connected.status !== "connected") throw new Error(`mock COROS connect failed: ${connected.status}`);

  const fetches = { coros: 0, llm: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(LLM_BASE_URL)) {
      fetches.llm += 1;
      return sseReadResponse();
    }
    fetches.coros += 1;
    return server.fetchImpl(input as never, init);
  }) as typeof fetch;

  return { userId, prefs: await loadPreferences(db, userId), env, fetchImpl, fetches, newActivityIds, coros: server };
}
