/**
 * The designed-run journey's fixture levers (§8 §3, stream R; coach-runs.spec.ts): `POST /api/dev/threshold` writes the
 * athlete's threshold pace for today (the COROS read writes it in production; the fixture account has none), and
 * `GET /api/dev/coach-job?workoutId=` returns a workout's queued watch create with the program the write lane would put
 * on the watch from it — computed, never sent. Both exist in fixture mode only. Driven through the Worker's real
 * default export with the fixture stack's env; only the database is a stand-in, and nothing reaches the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, runWatchSessionOf, todayInZone, type WorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import { enqueueWatchCreate } from "../src/services/coach-apply.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { makeTestDb } from "./helpers.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});

const { default: worker } = await import("../src/index.js");

vi.setConfig({ testTimeout: 60_000 });

function stackEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "http://localhost:5271",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "0",
    AI_GATEWAY_BASE_URL: "http://127.0.0.1:9",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "fixture@example.com",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(env: Env, method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: opts.cookie } : {}) };
  const res = await worker.fetch(
    new Request(`http://localhost:8971${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
    env,
    ctx,
  );
  await Promise.allSettled(pending);
  return res;
}

const tempo: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 } }] },
  ],
  source: { kind: "coach" },
};

describe("the designed-run journey's fixture levers", () => {
  it("do not exist outside fixture mode", async () => {
    holder.db = makeTestDb();
    const env = stackEnv({ FIXTURE_MODE: "0" });
    expect((await call(env, "POST", "/api/dev/threshold", { body: { secPerKm: 289 } })).status).toBe(404);
    expect((await call(env, "GET", "/api/dev/coach-job?workoutId=wo-run")).status).toBe(404);
  });

  it("fixture mode: today's threshold written (and rewritten), then a designed run's watch create with its pace bytes", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
    }) as typeof fetch;
    const env = stackEnv();
    holder.db = makeTestDb();
    const db = holder.db as ReturnType<typeof makeTestDb>;
    const login = await call(env, "POST", "/api/dev/fixture-login");
    const { userId } = (await login.clone().json()) as { userId: string };
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(env, "POST", "/api/dev/threshold", { body: { secPerKm: 289 } })).status).toBe(401);

    for (const bad of [{}, { secPerKm: "289" }, { secPerKm: 60 }, { secPerKm: 900 }]) {
      expect((await call(env, "POST", "/api/dev/threshold", { cookie, body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const today = todayInZone((await loadPreferences(db as never, userId)).timezone);
    const thresholdOn = async () =>
      (await db.select().from(schema.dailyHealth).where(and(eq(schema.dailyHealth.userId, userId), eq(schema.dailyHealth.date, today)))).map((h) => h.thresholdPaceSecPerKm);
    expect(await thresholdOn()).toEqual([]);
    expect((await call(env, "POST", "/api/dev/threshold", { cookie, body: { secPerKm: 300 } })).status).toBe(200);
    expect(await thresholdOn()).toEqual([300]);
    expect((await call(env, "POST", "/api/dev/threshold", { cookie, body: { secPerKm: 289 } })).status).toBe(200);
    expect(await thresholdOn()).toEqual([289]);

    expect((await call(env, "GET", "/api/dev/coach-job?workoutId=wo-run", { cookie })).status).toBe(404);
    const made = runWatchSessionOf(tempo);
    if (!("session" in made)) throw new Error(made.refused);
    const date = addDays(today, 1);
    expect(await enqueueWatchCreate(db as never, userId, "wo-run", date, made.session, nowInstant(), 300)).toBe("wo-run-push");

    const res = await call(env, "GET", "/api/dev/coach-job?workoutId=wo-run", { cookie });
    expect(res.status).toBe(200);
    const job = (await res.json()) as { kind: string; status: string; sessionKind: string; steps: Array<Record<string, unknown>> };
    expect(job).toMatchObject({ kind: "coach_create_workout", status: "queued", sessionKind: "run_watch" });
    expect(job.steps.map((s) => s.exerciseType)).toEqual([1, 2, 4, 2, 4, 2, 4, 3]);
    // Queued at 5:00 /km, built from the freshest (today's 4:49): the 2 km cool-down at the easy band's middle, 6:19 /km → 758 s.
    expect(job.steps.map((s) => s.targetValue)).toEqual([600, 480, 120, 480, 120, 480, 120, 758]);
    expect(job.steps[1]).toMatchObject({ targetType: 2, intensityType: 3, intensityValue: 299_000, intensityValueExtend: 314_000, intensityMultiplier: 1000 });
    // Never sent: the job is still queued.
    const [row] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, "wo-run-push"));
    expect(row!.status).toBe("queued");
  });
});
