/**
 * SETTINGS → COACH (Stage 3 Task 10; spec §6): `GET/PUT /api/coach/preferences`, and the run a create starts from them.
 *
 *  - Inert as the runs are: a 404 unless COACH_DESIGNER (or staging), signed in or not, ahead of the coach's own sign-in.
 *  - The settings are `coach` in the user's preferences: read and written whole, the rest of the preferences untouched,
 *    and kept by a save of any other setting.
 *  - A limit may be lowered, never raised past its default: refused in plain words.
 *  - A create with no scope starts the athlete's default; "next workouts" with no count takes theirs; the run's limit is
 *    theirs when they lowered it — all from the one preferences read a create already made (its cost unchanged).
 *  - The model is named in plain words.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachPreferenceRoutes, modelName } from "../src/routes/coach-preferences.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { RUN_CEILING_MICROS, type RunDeps } from "../src/services/coach-runs.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...extra,
  } as Env;
}
const ON = makeEnv({ COACH_DESIGNER: "1" });
const OFF = makeEnv();

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db, { units: "mi", timezone: "Europe/Paris" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

async function prefsCall(method: "GET" | "PUT", body?: unknown, env: Env = ON, withCookie = true) {
  const app = mountRoutes(db, "/api/coach/preferences", coachPreferenceRoutes);
  statements = 0;
  const res = await app.request(
    "/api/coach/preferences",
    {
      method,
      headers: { ...(withCookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements };
}

const DEFAULTS = { defaultScope: "now", nextN: 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } };

describe("inert unless the coach designer is on", () => {
  it("GET and PUT are a 404 with the flag off, signed in or not; on, they sign in first", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const body = method === "PUT" ? { nextN: 4 } : undefined;
      expect((await prefsCall(method, body, OFF)).status).toBe(404);
      expect((await prefsCall(method, body, OFF, false)).status).toBe(404);
      expect((await prefsCall(method, body, makeEnv({ COACH_DESIGNER: "0" }))).status).toBe(404);
      expect((await prefsCall(method, body, ON, false)).status).toBe(401);
    }
    expect((await prefsCall("GET", undefined, makeEnv({ STAGING: "1" }))).status).toBe(200);
    // Nothing was written.
    expect((await loadPreferences(db, userId)).coach).toBeUndefined();
  });

  it("through the Worker's own entry: a 404 before the coach's sign-in can answer 401", async () => {
    const entry = (await import("../src/index.js")).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    expect((await entry.fetch(new Request("https://app.test/api/coach/preferences"), OFF, ctx)).status).toBe(404);
    expect((await entry.fetch(new Request("https://app.test/api/coach/preferences", { method: "PUT", body: "{}" }), OFF, ctx)).status).toBe(404);
    expect((await entry.fetch(new Request("https://app.test/api/coach/preferences"), ON, ctx)).status).toBe(401);
    // The coach's own routes are untouched.
    expect((await entry.fetch(new Request("https://app.test/api/coach/memory"), OFF, ctx)).status).toBe(401);
  });
});

describe("read and write", () => {
  it("reads the defaults when nothing is set — the session and the preferences, two statements", async () => {
    const got = await prefsCall("GET");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ coach: {}, settings: DEFAULTS, model: { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" } });
    expect(got.cost).toBe(2);
  });

  it("writes the settings whole and answers them; the rest of the preferences untouched — three statements", async () => {
    const put = await prefsCall("PUT", { defaultScope: "week", nextN: 5, trainingTimes: ["18:30", "07:00"], ceilingsUsd: { day: 1 } });
    expect(put.status).toBe(200);
    expect(put.body.coach).toEqual({ defaultScope: "week", nextN: 5, trainingTimes: ["18:30", "07:00"], ceilingsUsd: { day: 1 } });
    expect(put.body.settings).toEqual({ defaultScope: "week", nextN: 5, trainingTimes: ["07:00", "18:30"], ceilingsUsd: { day: 1, set: 6 } });
    // The session and the restore marker, then one write that answers what it wrote.
    expect(put.cost).toBe(3);
    const prefs = await loadPreferences(db, userId);
    expect(prefs.units).toBe("mi");
    expect(prefs.timezone).toBe("Europe/Paris");
    expect(prefs.coach).toEqual(put.body.coach);
    // Whole: what the next write leaves out is back to its default.
    const next = await prefsCall("PUT", { nextN: 2 });
    expect(next.body.settings).toEqual({ ...DEFAULTS, nextN: 2 });
    expect((await prefsCall("GET")).body.coach).toEqual({ nextN: 2 });
  });

  it("an account with no preferences row yet gets one holding only the settings", async () => {
    await db.delete(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
    const put = await prefsCall("PUT", { nextN: 6 });
    expect(put.status).toBe(200);
    expect(put.cost).toBe(3);
    const prefs = await loadPreferences(db, userId);
    expect(prefs.coach).toEqual({ nextN: 6 });
    expect(prefs.timezone).toBe("America/New_York");
  });

  it("lowering a limit works; raising one past its default is refused in plain words, and nothing is written", async () => {
    expect((await prefsCall("PUT", { ceilingsUsd: { day: 0.75, set: 3.5 } })).body.settings.ceilingsUsd).toEqual({ day: 0.75, set: 3.5 });
    for (const raised of [{ day: 1.51 }, { set: 6.5 }, { day: 20 }]) {
      const refused = await prefsCall("PUT", { ceilingsUsd: raised });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("invalid_coach_settings");
      expect(refused.body.issues[0].message).toMatch(/^at most \$(1\.50|6\.00): a limit can be lowered, never raised$/);
    }
    expect((await loadPreferences(db, userId)).coach).toEqual({ ceilingsUsd: { day: 0.75, set: 3.5 } });
  });

  it("refuses what isn't a setting", async () => {
    for (const bad of [null, [], { nextN: 9 }, { defaultScope: "month" }, { trainingTimes: ["07:00", "08:00", "09:00", "10:00"] }, { model: "x" }]) {
      expect((await prefsCall("PUT", bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("a save of any other setting keeps them", async () => {
    await prefsCall("PUT", { nextN: 4, ceilingsUsd: { set: 5 } });
    const settings = mountRoutes(db, "/api/settings", settingsRoutes);
    const res = await settings.request(
      "/api/settings",
      { method: "PUT", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ units: "km" }) },
      ON,
    );
    expect(res.status).toBe(200);
    const prefs = await loadPreferences(db, userId);
    expect(prefs.units).toBe("km");
    expect(prefs.coach).toEqual({ nextN: 4, ceilingsUsd: { set: 5 } });
  });
});

describe("the model, in plain words", () => {
  it("names the gateway's Claude ids, and the setting the server runs on", async () => {
    expect(modelName("anthropic/claude-opus-5.5")).toBe("Claude Opus 5.5");
    expect(modelName("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelName("anthropic/claude-opus-5.5-fast")).toBe("Claude Opus 5.5 (fast)");
    expect(modelName("openai/some-model")).toBe("some-model");
    expect((await prefsCall("GET", undefined, makeEnv({ COACH_DESIGNER: "1", AI_DESIGN_MODEL: "anthropic/claude-sonnet-5.5" }))).body.model).toEqual({
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
    });
  });
});

// ── A create, from the settings ──────────────────────────────────────────────

const noModel: RunDeps = {
  callModel: async () => {
    throw new Error("no model call in a create");
  },
  buildContext: { statementCost: 0, build: async () => ({ system: [], header: "" }) },
  tools: [],
};

async function create(body: unknown) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => noModel));
  statements = 0;
  const res = await app.request(
    "/api/coach/runs",
    { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) },
    ON,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, cost: statements };
}

async function ceilingOf(runId: string): Promise<number> {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, runId));
  return (JSON.parse(row!.state!) as { settings: { ceilingMicros: number } }).settings.ceilingMicros;
}

describe("a create honours the settings", () => {
  it("no settings: a create with no scope is for now, under the default limits — four statements, as before", async () => {
    const made = await create({ request: "something easy" });
    expect(made.status).toBe(200);
    expect(made.body.run.scope).toEqual({ kind: "now" });
    expect(await ceilingOf(made.body.run.id)).toBe(RUN_CEILING_MICROS.now);
    // The session and the restore marker, the preferences, the insert.
    expect(made.cost).toBe(4);
  });

  it("the default scope and N: a create with no scope starts the athlete's default, next workouts with no count takes theirs", async () => {
    await prefsCall("PUT", { defaultScope: "next_n", nextN: 5 });
    const made = await create({ request: "plan ahead" });
    expect(made.body.run.scope).toEqual({ kind: "next_n", n: 5 });
    expect(made.cost).toBe(4);
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, made.body.run.id));
    expect((await create({ scope: { kind: "next_n" } })).body.run.scope).toEqual({ kind: "next_n", n: 5 });
    await db.update(schema.coachRuns).set({ status: "cancelled" });
    // A scope the request names is the request's.
    expect((await create({ scope: { kind: "next_n", n: 2 } })).body.run.scope).toEqual({ kind: "next_n", n: 2 });
    await db.update(schema.coachRuns).set({ status: "cancelled" });
    expect((await create({ scope: { kind: "later_today" } })).body.run.scope).toEqual({ kind: "later_today" });
  });

  it("the limits: a run starts under the athlete's lowered limit for its scope, else the default", async () => {
    await prefsCall("PUT", { ceilingsUsd: { day: 0.8 } });
    const now = await create({ scope: { kind: "now" } });
    expect(await ceilingOf(now.body.run.id)).toBe(800_000);
    expect(now.body.run.ceilingUsd).toBe(0.8);
    await db.update(schema.coachRuns).set({ status: "cancelled" });
    const week = await create({ scope: { kind: "week" } });
    expect(await ceilingOf(week.body.run.id)).toBe(RUN_CEILING_MICROS.week);
    await db.update(schema.coachRuns).set({ status: "cancelled" });
    await prefsCall("PUT", { ceilingsUsd: { set: 2.5 } });
    expect(await ceilingOf((await create({ scope: { kind: "next_n", n: 2 } })).body.run.id)).toBe(2_500_000);
  });

  it("a rehearsal keeps the defaults: the scenario suite measures the system as designed", async () => {
    await prefsCall("PUT", { defaultScope: "week", ceilingsUsd: { day: 0.5 } });
    const made = await create({ scope: { kind: "now" }, rehearsal: true });
    expect(await ceilingOf(made.body.run.id)).toBe(RUN_CEILING_MICROS.now);
  });

  it("the defaults are the settings' own: $1.50 for one workout, $6 for a set", () => {
    expect(RUN_CEILING_MICROS).toEqual({ now: 1_500_000, later_today: 1_500_000, week: 6_000_000, next_n: 6_000_000 });
  });

  it("the preferred training times reach the main coach's scope for later today and a set; none set, the line is as before", async () => {
    const now = new Date("2026-03-10T15:00:00Z");
    const header = async (kind: "later_today" | "week" | "next_n" | "now") =>
      (await buildDesignContext(db, ON, userId, { id: "r1", role: "main", scope: kind === "next_n" ? { kind, n: 3 } : { kind }, request: null, parentId: null }, now)).header;
    const before = await header("later_today");
    expect(before).not.toMatch(/preferred training times/);
    await prefsCall("PUT", { trainingTimes: ["18:30", "07:00"] });
    expect(await header("later_today")).toContain("latest evening finish 21:00; their preferred training times 07:00, 18:30) and set it as the target's time");
    expect(await header("week")).toContain("planned as a set; time each workout at one of the athlete's preferred training times (07:00, 18:30) where it fits");
    expect(await header("next_n")).toContain("planned as a set; time each workout at one of the athlete's preferred training times (07:00, 18:30) where it fits");
    expect(await header("now")).not.toMatch(/preferred training times/);
  });

  it("still refuses a scope it doesn't know, or a count outside what a set may hold", async () => {
    expect((await create({ scope: { kind: "forever" } })).status).toBe(400);
    expect((await create({ scope: { kind: "next_n", n: 0 } })).status).toBe(400);
    expect((await create({ scope: "now" })).status).toBe(400);
    expect((await create({ scope: null })).status).toBe(400);
  });
});
