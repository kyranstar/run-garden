/**
 * `POST /api/dev/watch-session` (Phase 3 Task 11): fixture mode only — today's sent session done on the watch, so the
 * e2e journey can take the quick review end to end. Driven through the Worker's real default export with the fixture
 * stack's own env, as fixture-stack.sh boots it (RG_E2E_WATCH=1 turns the switch on); only the database is a stand-in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});

const { default: worker } = await import("../src/index.js");

vi.setConfig({ testTimeout: 120_000 });

function stackEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "http://localhost:5271",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "0",
    AI_GATEWAY_BASE_URL: "http://127.0.0.1:9",
    WATCH_PUSH_ENABLED: "1",
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

describe("POST /api/dev/watch-session", () => {
  it("does not exist outside fixture mode", async () => {
    holder.db = makeTestDb();
    expect((await call(stackEnv({ FIXTURE_MODE: "0" }), "POST", "/api/dev/watch-session")).status).toBe(404);
  });

  it("fixture mode: today's sent session done on the watch → the review offered, saved once, counted once", async () => {
    // No network at all: the fixture's COROS connection holds no credentials, and nothing else may be asked.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
    }) as typeof fetch;
    const env = stackEnv();
    holder.db = makeTestDb();
    const db = holder.db as ReturnType<typeof makeTestDb>;
    const login = await call(env, "POST", "/api/dev/fixture-login");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(env, "POST", "/api/dev/seed", { cookie })).status).toBe(200);
    expect((await call(env, "POST", "/api/dev/watch-session", { cookie })).status).toBe(409);

    // Today's program slot (moved here when today has none), built with its pre-check, and sent.
    const today = (await (await call(env, "GET", "/api/plan/today", { cookie })).json()) as {
      today: string;
      todaySessions: Array<{ workout: { id: string; origin: string | null } }>;
    };
    let slot = today.todaySessions.find((s) => s.workout.origin === "program")?.workout.id;
    if (!slot) {
      const week = JSON.stringify(await (await call(env, "GET", "/api/plan/week", { cookie })).json());
      slot = [...week.matchAll(/"id":"(slot-[^"]+)"/g)].map((m) => m[1]!).at(-1)!;
      expect((await call(env, "POST", `/api/plan/workouts/${slot}/move`, { cookie, body: { toDate: today.today, toTime: "23:45" } })).status).toBe(200);
    }
    const session = (await (await call(env, "GET", `/api/sessions/${slot}`, { cookie })).json()) as { profiles: Array<{ profileId: string }> };
    const checks = Object.fromEntries(session.profiles.map((p) => [p.profileId, { pre: 2, feelingOff: false }]));
    const built = (await (await call(env, "POST", `/api/sessions/${slot}/build`, { cookie, body: { checks } })).json()) as { build: { buildId: string } };
    const preview = (await (await call(env, "GET", `/api/sessions/${slot}/watch-preview`, { cookie })).json()) as { digest: string };
    const sent = await call(env, "POST", `/api/sessions/${slot}/send-to-watch`, { cookie, body: { buildId: built.build.buildId, digest: preview.digest } });
    expect(sent.status).toBe(200);

    const done = await call(env, "POST", "/api/dev/watch-session", { cookie });
    expect(done.status).toBe(200);
    const { workoutId, activityId } = (await done.json()) as { workoutId: string; activityId: string };
    expect(workoutId).toBe(slot);

    const offered = (await (await call(env, "GET", "/api/plan/today", { cookie })).json()) as { watchReviews: Array<{ workoutId: string }> };
    expect(offered.watchReviews.map((r) => r.workoutId)).toEqual([slot]);
    const basisRes = await call(env, "GET", `/api/sessions/${slot}/watch-review`, { cookie });
    expect(basisRes.status).toBe(200);
    const basis = (await basisRes.json()) as {
      buildId: string;
      sourceRef: string;
      localDate: string;
      startedAt: string;
      endedAt: string;
      seconds: number;
      entries: Array<{ exerciseId: string; implement: string | null; format: string | null; perSide: boolean; sets: Array<Record<string, unknown>> }>;
    };
    expect(basis.entries.some((e) => e.sets.some((s) => s.from === "watch"))).toBe(true);

    const id = "4f4f4f4f-1111-4222-8333-444455556666";
    const body = {
      id, source: "watch_review", sourceRef: basis.sourceRef, workoutId: slot, buildId: basis.buildId, localDate: basis.localDate,
      startedAt: basis.startedAt, endedAt: basis.endedAt, seconds: basis.seconds, plannedSeconds: null, minutes: null, mode: null,
      theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
      movesDone: [], note: null, newMove: null, checks: [], review: {},
      entries: basis.entries.map((e) => ({ exerciseId: e.exerciseId, implement: e.implement, format: e.format, perSide: e.perSide, sets: e.sets.map(({ from: _f, ...s }) => s) })),
    };
    const saved = await call(env, "PUT", `/api/sessions/performed/${id}`, { cookie, body });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: "saved", activityId });

    const after = (await (await call(env, "GET", "/api/plan/today", { cookie })).json()) as { watchReviews: unknown[] };
    expect(after.watchReviews).toEqual([]);
    const sessions = await db.select().from(schema.performedSessions).where(eq(schema.performedSessions.activityId, activityId));
    expect(sessions.map((s) => s.source)).toEqual(["watch_review"]);
    const matches = (await db.select().from(schema.workoutCompletionMatches).where(eq(schema.workoutCompletionMatches.activityId, activityId))).filter(
      (m) => m.undoneAt === null,
    );
    expect(matches.map((m) => m.workoutId)).toEqual([slot]);
  });
});
