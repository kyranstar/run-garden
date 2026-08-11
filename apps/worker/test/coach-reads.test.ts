import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { coachReads, coachLocks, llmUsage, schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import {
  AUTO_READ_RESERVE_MICROS,
  READ_MAX_ATTEMPTS,
  enqueueBackfillDigest,
  enqueueCoachReads,
  ensureRead,
  processCoachReads,
} from "../src/services/coach-reads.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides,
  } as Env;
}

function chatBody(content: unknown): unknown {
  return {
    choices: [
      { message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  };
}

/** Scripted transport: each call consumes the next body; repeats the last. */
function scriptedFetch(bodies: unknown[], opts: { repeatLast?: boolean; delayMs?: number } = {}) {
  let i = 0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const body = bodies[Math.min(i, bodies.length - 1)];
    if (i < bodies.length - 1 || opts.repeatLast) i += 1;
    if (body === undefined) throw new Error("no scripted response");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

/** Non-retryable 400 — chatCompletion returns {ok:false} immediately. */
function failingFetch() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("bad", { status: 400 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const GOOD = chatBody({ glance: "Steady 9:40s; HR drifted late — fueling.", body: "Nice steady effort with honest pacing.", flags: ["hr_drift"] });
const GOOD_NO_FLAGS = chatBody({ glance: "Easy spin, right on plan.", body: "Kept it genuinely easy.", flags: [] });

async function seedActivity(db: Db, userId: string, daysAgo: number, tz: string, overrides: Partial<typeof schema.activities.$inferInsert> = {}): Promise<string> {
  const date = addDays(todayInZone(tz), -daysAgo);
  const id = overrides.id ?? newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: `${date}T12:08:02Z`,
    startTimeLocal: `${date}T05:08:02`,
    sport: "run",
    durationSeconds: 4038,
    elapsedSeconds: 4174,
    distanceMeters: 9489,
    avgHeartRate: 153,
    trainingLoad: 146,
    title: "Aerobic Endurance",
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...overrides,
  });
  return id;
}

async function setup(prefsOverride: Partial<UserPreferences> = {}) {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, prefsOverride);
  return { db, userId, prefs, today: todayInZone(prefs.timezone) };
}

async function readRows(db: Db, userId: string) {
  return db.select().from(coachReads).where(eq(coachReads.userId, userId));
}

describe("coach_reads schema", () => {
  it("enforces one read per (user, activity)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const row = {
      id: newId(),
      userId,
      activityId: "act-1",
      status: "queued",
      attempt: 0,
      nextAttemptAt: nowInstant(),
      claimToken: null,
      claimedAt: null,
      glance: null,
      body: null,
      flags: [] as string[],
      model: null,
      createdAt: nowInstant(),
      completedAt: null,
    };
    await db.insert(coachReads).values(row);
    await expect(db.insert(coachReads).values({ ...row, id: newId() })).rejects.toThrow();
  });

  it("coach_locks is one row per (user, kind)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(coachLocks).values({ userId, kind: "wake", token: "t1", claimedAt: nowInstant() });
    await expect(
      db.insert(coachLocks).values({ userId, kind: "wake", token: "t2", claimedAt: nowInstant() }),
    ).rejects.toThrow();
  });
});

describe("enqueueCoachReads", () => {
  it("enqueues recent activities, skips old ones, and is idempotent", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 3, prefs.timezone);
    await seedActivity(db, userId, 20, prefs.timezone);
    expect(await enqueueCoachReads(db, userId, today)).toBe(1);
    expect(await enqueueCoachReads(db, userId, today)).toBe(0);
    const rows = await readRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
  });

  it("does not re-enqueue an activity whose read is already done", async () => {
    const { db, userId, prefs, today } = await setup();
    const actId = await seedActivity(db, userId, 2, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const { fetchImpl } = scriptedFetch([GOOD]);
    await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl });
    expect(await enqueueCoachReads(db, userId, today)).toBe(0);
    const rows = await readRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
    expect(rows[0]!.activityId).toBe(actId);
  });
});

describe("processCoachReads", () => {
  it("processes a queued read: done row, glance/body/flags, one call, usage ledger", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 1, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const { fetchImpl, calls } = scriptedFetch([GOOD]);
    const res = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl });
    expect(res).toEqual({ processed: 1, skipped: null });
    expect(calls()).toBe(1);
    const [row] = await readRows(db, userId);
    expect(row!.status).toBe("done");
    expect(row!.glance).toContain("HR drifted");
    expect(row!.flags).toEqual(["hr_drift"]);
    const usage = await db.select().from(llmUsage).where(eq(llmUsage.userId, userId));
    expect(usage.map((u) => u.kind)).toEqual(["coach_read"]);
  });

  it("EXACTLY-ONCE: two concurrent processors make one LLM call total", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 1, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const { fetchImpl, calls } = scriptedFetch([GOOD], { delayMs: 30, repeatLast: true });
    const env = makeEnv();
    await Promise.all([
      processCoachReads(db, env, userId, prefs, { fetchImpl }),
      processCoachReads(db, env, userId, prefs, { fetchImpl }),
    ]);
    expect(calls()).toBe(1);
    const rows = await readRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
  });

  it("failure backs off, then marks failed after READ_MAX_ATTEMPTS", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 1, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const bad = failingFetch();
    await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl: bad.fetchImpl });
    let [row] = await readRows(db, userId);
    expect(row!.status).toBe("queued");
    expect(row!.attempt).toBe(1);
    expect(row!.nextAttemptAt > nowInstant()).toBe(true);
    // Immediately re-running does nothing — the backoff holds.
    const again = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl: bad.fetchImpl });
    expect(again.processed).toBe(0);
    expect(bad.calls()).toBe(1);
    // At the attempt ceiling a further failure goes terminal.
    await db
      .update(coachReads)
      .set({ attempt: READ_MAX_ATTEMPTS - 1, nextAttemptAt: nowInstant(), status: "queued" })
      .where(eq(coachReads.id, row!.id));
    await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl: bad.fetchImpl });
    [row] = await readRows(db, userId);
    expect(row!.status).toBe("failed");
  });

  it("honors kill switches and the auto-read budget reserve", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 1, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const { fetchImpl, calls } = scriptedFetch([GOOD]);

    expect((await processCoachReads(db, makeEnv({ FIXTURE_MODE: "1" }), userId, prefs, { fetchImpl })).skipped).toBe("fixture");
    expect((await processCoachReads(db, makeEnv({ AI_GATEWAY_API_KEY: undefined }), userId, prefs, { fetchImpl })).skipped).toBe("no_key");
    expect(
      (await processCoachReads(db, makeEnv(), userId, { ...prefs, aiEnabled: false }, { fetchImpl })).skipped,
    ).toBe("ai_disabled");
    expect(
      (await processCoachReads(db, makeEnv({ AI_DEFAULT_ENABLED: "0" }), userId, prefs, { fetchImpl })).skipped,
    ).toBe("ai_disabled");

    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: AUTO_READ_RESERVE_MICROS + 1,
      cacheHit: false,
      requestFingerprint: "f",
      createdAt: nowInstant(),
    });
    expect((await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl })).skipped).toBe("budget_reserve");
    expect(calls()).toBe(0);
    const [row] = await readRows(db, userId);
    expect(row!.status).toBe("queued");
  });

  it("recovers from invalid JSON with one repair round-trip", async () => {
    const { db, userId, prefs, today } = await setup();
    await seedActivity(db, userId, 1, prefs.timezone);
    await enqueueCoachReads(db, userId, today);
    const { fetchImpl, calls } = scriptedFetch([chatBody("not json at all"), GOOD]);
    const res = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl });
    expect(res.processed).toBe(1);
    expect(calls()).toBe(2);
  });
});

describe("ensureRead", () => {
  it("generates synchronously, then serves the ledger; force regenerates in place", async () => {
    const { db, userId, prefs } = await setup();
    const actId = await seedActivity(db, userId, 1, prefs.timezone);
    const t1 = scriptedFetch([GOOD]);
    const first = await ensureRead(db, makeEnv(), userId, prefs, actId, { fetchImpl: t1.fetchImpl });
    expect(first.status).toBe("done");
    expect(first.cached).toBe(false);
    expect(first.read!.glance).toContain("HR drifted");
    expect(t1.calls()).toBe(1);

    const t2 = scriptedFetch([GOOD_NO_FLAGS]);
    const second = await ensureRead(db, makeEnv(), userId, prefs, actId, { fetchImpl: t2.fetchImpl });
    expect(second.status).toBe("done");
    expect(second.cached).toBe(true);
    expect(t2.calls()).toBe(0);

    const t3 = scriptedFetch([GOOD_NO_FLAGS]);
    const forced = await ensureRead(db, makeEnv(), userId, prefs, actId, { force: true, fetchImpl: t3.fetchImpl });
    expect(forced.status).toBe("done");
    expect(forced.read!.glance).toContain("Easy spin");
    expect(t3.calls()).toBe(1);
    expect(await readRows(db, userId)).toHaveLength(1);
  });

  it("returns not_found for a foreign or missing activity", async () => {
    const { db, userId, prefs } = await setup();
    expect((await ensureRead(db, makeEnv(), userId, prefs, "nope", {})).status).toBe("not_found");
  });

  it("EXACTLY-ONCE: concurrent ensureRead calls make one LLM call", async () => {
    const { db, userId, prefs } = await setup();
    const actId = await seedActivity(db, userId, 1, prefs.timezone);
    const { fetchImpl, calls } = scriptedFetch([GOOD], { delayMs: 30, repeatLast: true });
    const env = makeEnv();
    const results = await Promise.all([
      ensureRead(db, env, userId, prefs, actId, { fetchImpl }),
      ensureRead(db, env, userId, prefs, actId, { fetchImpl }),
    ]);
    expect(calls()).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(["done", "working"]);
  });

  it("runs above the auto-read reserve but rests at the hard cutoff", async () => {
    const { db, userId, prefs } = await setup();
    const actId = await seedActivity(db, userId, 1, prefs.timezone);
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: AUTO_READ_RESERVE_MICROS + 1, // over the reserve, under the cutoff
      cacheHit: false,
      requestFingerprint: "f",
      createdAt: nowInstant(),
    });
    const t = scriptedFetch([GOOD]);
    expect((await ensureRead(db, makeEnv(), userId, prefs, actId, { fetchImpl: t.fetchImpl })).status).toBe("done");

    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "studio_generate",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 20_000_000,
      cacheHit: false,
      requestFingerprint: "f2",
      createdAt: nowInstant(),
    });
    const t2 = scriptedFetch([GOOD]);
    expect((await ensureRead(db, makeEnv(), userId, prefs, actId, { force: true, fetchImpl: t2.fetchImpl })).status).toBe("resting");
    expect(t2.calls()).toBe(0);
  });
});

describe("enqueueBackfillDigest", () => {
  it("enqueues one digest above the threshold, idempotently; below it, none", async () => {
    const { db, userId } = await setup();
    expect(await enqueueBackfillDigest(db, userId, "run1", 3)).toBe(false);
    expect(await readRows(db, userId)).toHaveLength(0);
    expect(await enqueueBackfillDigest(db, userId, "run1", 12)).toBe(true);
    await enqueueBackfillDigest(db, userId, "run1", 12);
    const rows = await readRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activityId).toBe("digest:run1");
  });

  it("digest read processes from the deterministic history summary", async () => {
    const { db, userId, prefs } = await setup();
    await seedActivity(db, userId, 30, prefs.timezone);
    await seedActivity(db, userId, 60, prefs.timezone);
    await enqueueBackfillDigest(db, userId, "run1", 10);
    const { fetchImpl, calls } = scriptedFetch([GOOD_NO_FLAGS]);
    const res = await processCoachReads(db, makeEnv(), userId, prefs, { fetchImpl });
    expect(res.processed).toBe(1);
    expect(calls()).toBe(1);
    const [row] = await readRows(db, userId);
    expect(row!.status).toBe("done");
  });
});
