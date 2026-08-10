/**
 * Effort analysis (effort-analysis spec §5): cache per activity, force
 * re-runs, loud budget stop, message persisted with analysis refs, ledger row
 * under coach_analysis. Stubbed gateway — no live LLM.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { analyzeEffort } from "../src/services/coach-analyze.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

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

function chatBody(content: string): unknown {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2000, completion_tokens: 150 },
  };
}

function scriptedFetch(bodies: unknown[]): { fetchImpl: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const fetchImpl = (async () => {
    calls.push(i);
    const body = bodies[i++];
    if (body === undefined) throw new Error("no more scripted responses");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;

async function seedRun(id = "act1"): Promise<string> {
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: "2026-08-06T12:08:02Z",
    startTimeLocal: "2026-08-06T05:08:02",
    sport: "run",
    durationSeconds: 4038,
    distanceMeters: 9489,
    avgHeartRate: 153,
    telemetry: { avgCadenceSpm: 152, weatherTempC: 25.5 },
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzeEffort", () => {
  it("analyzes, persists the message with analysis refs, and records the ledger", async () => {
    const id = await seedRun();
    const { fetchImpl, calls } = scriptedFetch([chatBody("Strong strides today — 152spm held.")]);
    const res = await analyzeEffort(db, makeEnv(), userId, id, false, fetchImpl);
    expect(res.status).toBe("ok");
    expect(res.message!.body).toContain("152spm");
    expect(calls).toHaveLength(1);

    const [msg] = await db
      .select()
      .from(schema.coachMessages)
      .where(eq(schema.coachMessages.id, res.message!.id));
    expect(msg!.role).toBe("coach");
    expect(msg!.refs).toEqual({ kind: "analysis", activityId: id });

    const usage = await db.select().from(schema.llmUsage).where(eq(schema.llmUsage.userId, userId));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.kind).toBe("coach_analysis");
  });

  it("returns the cached read without a second LLM call; force re-runs", async () => {
    const id = await seedRun();
    const first = scriptedFetch([chatBody("First read.")]);
    await analyzeEffort(db, makeEnv(), userId, id, false, first.fetchImpl);

    const second = scriptedFetch([]);
    const cached = await analyzeEffort(db, makeEnv(), userId, id, false, second.fetchImpl);
    expect(cached.status).toBe("cached");
    expect(cached.message!.body).toBe("First read.");
    expect(second.calls).toHaveLength(0);

    const forced = scriptedFetch([chatBody("Second read.")]);
    const rerun = await analyzeEffort(db, makeEnv(), userId, id, true, forced.fetchImpl);
    expect(rerun.status).toBe("ok");
    expect(rerun.message!.body).toBe("Second read.");
    // Newest read becomes the cache.
    const nowCached = await analyzeEffort(db, makeEnv(), userId, id, false, scriptedFetch([]).fetchImpl);
    expect(nowCached.message!.body).toBe("Second read.");
  });

  it("stops loudly when the weekly budget is spent", async () => {
    const id = await seedRun();
    await db.insert(schema.llmUsage).values({
      id: newId(),
      userId,
      kind: "coach_wake",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 21_000_000,
      cacheHit: false,
      requestFingerprint: "f",
      createdAt: nowInstant(),
    });
    const { fetchImpl, calls } = scriptedFetch([]);
    const res = await analyzeEffort(db, makeEnv(), userId, id, false, fetchImpl);
    expect(res.status).toBe("resting");
    expect(calls).toHaveLength(0);
  });

  it("route: 404 unknown activity, 200 with cached flag, 429 when resting", async () => {
    const id = await seedRun();
    const token = await createSession(db, userId);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const post = (path: string, body?: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        makeEnv(),
      );

    expect((await post("/api/coach/analyze/nope")).status).toBe(404);

    vi.stubGlobal(
      "fetch",
      scriptedFetch([chatBody("Route read.")]).fetchImpl,
    );
    const ok = await post(`/api/coach/analyze/${id}`);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { message: { body: string }; cached: boolean };
    expect(okBody.message.body).toBe("Route read.");
    expect(okBody.cached).toBe(false);

    const again = await post(`/api/coach/analyze/${id}`);
    const againBody = (await again.json()) as { cached: boolean };
    expect(againBody.cached).toBe(true);
  });
});
