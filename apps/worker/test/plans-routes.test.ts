/**
 * `/api/plans` (plans with a purpose, Stage 1): the plans the account has, and the edit of a plan's purpose, brief and
 * ending. A phase is not a plan, and the one-off bucket is not one. All names are made up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plans.js";
import { programRoutes } from "../src/routes/programs.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachPlans, programs, programVersions } = schema;
const NOW = "2026-10-05T12:00:00.000Z";

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
  } as Env;
}

let db: Db;
let statements: string[];
let userId: string;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

const call = (method: string, path: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, "/api/plans", planRoutes).request(
    path,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );

async function plan(id: string, kind: string, extra: Partial<typeof programs.$inferInsert> = {}) {
  await db.insert(programs).values({
    id,
    userId,
    kind,
    name: `Plan ${id}`,
    status: "active",
    disciplines: ["strength"],
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });
}

async function phase(id: string, programId: string | null, startDate = "2026-10-05", endDate = "2026-10-18") {
  await db.insert(coachPlans).values({
    id,
    userId,
    discipline: "run",
    name: `Block ${id}`,
    status: "active",
    startDate,
    endDate,
    raceDate: null,
    stampPrefix: id,
    programId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

type Summary = {
  id: string;
  kind: string;
  lineKey: string | null;
  listedAs: string | null;
  purpose: string | null;
  onEnd: string | null;
  status: string;
  course: unknown;
  prompt: unknown;
};
const listed = async () => ((await (await call("GET", "/api/plans")).json()) as { plans: Summary[] }).plans;
const rowOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;

describe("GET /api/plans", () => {
  it("lists a coach plan with its line's key, a programme and a course, and neither a phase nor the one-off bucket", async () => {
    await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask", purpose: "Build the base" });
    await phase("blk-1", "plan-a");
    await phase("blk-2", "plan-a", "2026-10-19", "2026-11-01");
    await plan("prog-1", "adaptive", { onEnd: "continue" });
    await plan("course-1", "course", { onEnd: "finish" });
    await plan("bucket", "studio", { onEnd: null });

    const plans = await listed();
    expect(plans.map((p) => p.id).sort()).toEqual(["course-1", "plan-a", "prog-1"]);
    const coach = plans.find((p) => p.id === "plan-a")!;
    expect(coach.lineKey).toMatch(/\S/);
    expect(coach).toMatchObject({ purpose: "Build the base", onEnd: "ask", listedAs: null, course: null, prompt: null, status: "active" });
    // A programme and a course are listed as themselves, and have no line.
    expect(plans.find((p) => p.id === "prog-1")).toMatchObject({ kind: "adaptive", listedAs: "prog-1", lineKey: null });
    expect(plans.find((p) => p.id === "course-1")).toMatchObject({ kind: "course", listedAs: "course-1", lineKey: null });
  });

  it("a Studio coach plan is listed as its studio plan's id", async () => {
    await plan("container-1", "coach", { source: { studioPlanId: "studio-xyz" } });
    expect((await listed())[0]).toMatchObject({ id: "container-1", listedAs: "studio-xyz", lineKey: null });
  });

  it("another account's plans never appear", async () => {
    const { userId: other } = await makeTestUser(db);
    await db.insert(programs).values({ id: "theirs", userId: other, kind: "course", name: "Theirs", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    expect(await listed()).toEqual([]);
  });

  it("reads the plans and the phases once each, beside the session and the preferences", async () => {
    await plan("plan-a", "coach");
    await phase("blk-1", "plan-a");
    await plan("prog-1", "adaptive");
    statements.length = 0;
    await call("GET", "/api/plans");
    const reads = statements.filter((s) => /from "(programs|coach_plans)"/i.test(s));
    expect(reads.length).toBe(2);
    expect(statements.length).toBeLessThanOrEqual(6);
  });

  it("/api/programs still answers the adaptive programme alone", async () => {
    await plan("prog-1", "adaptive", { onEnd: "continue" });
    await plan("course-1", "course");
    await plan("plan-a", "coach");
    const res = await mountRoutes(db, "/api/programs", programRoutes).request("/api/programs", { headers: { Cookie: cookie } }, makeEnv());
    const body = (await res.json()) as { programs: Array<{ id: string }> };
    expect(body.programs.map((p) => p.id)).toEqual(["prog-1"]);
  });
});

describe("PATCH /api/plans/:id", () => {
  it("writes the fields and records a version each time", async () => {
    await plan("plan-a", "coach", { disciplines: ["run"], onEnd: "ask" });
    const res = await call("PATCH", "/api/plans/plan-a", { purpose: "Be ready", brief: "Keep easy days easy", onEnd: "finish", objectiveIds: ["o1"], pausedUntil: "2099-01-01" });
    expect(res.status).toBe(200);
    expect(await rowOf("plan-a")).toMatchObject({ purpose: "Be ready", brief: "Keep easy days easy", onEnd: "finish", objectiveIds: ["o1"], pausedUntil: "2099-01-01" });
    const versions = await db.select().from(programVersions).where(eq(programVersions.programId, "plan-a"));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.versionNum).toBe(1);
    expect(versions[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0]!.summary).toMatchObject({ changed: expect.arrayContaining(["purpose", "onEnd"]) });
    expect(((await res.json()) as { plan: Summary }).plan).toMatchObject({ id: "plan-a", purpose: "Be ready", onEnd: "finish" });

    await call("PATCH", "/api/plans/plan-a", { purpose: "Be readier" });
    const next = await db.select().from(programVersions).where(eq(programVersions.programId, "plan-a"));
    expect(next.map((v) => v.versionNum).sort()).toEqual([1, 2]);
  });

  it("an empty patch writes nothing and records no version", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", {})).status).toBe(200);
    expect(await db.select().from(programVersions)).toEqual([]);
  });

  it("a course cannot ask: 422 with the words, and nothing changes", async () => {
    await plan("course-1", "course", { onEnd: "continue" });
    const res = await call("PATCH", "/api/plans/course-1", { onEnd: "ask" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/ask/);
    expect((await rowOf("course-1")).onEnd).toBe("continue");
    expect(await db.select().from(programVersions)).toEqual([]);
  });

  it("another account's plan is 404", async () => {
    const { userId: other } = await makeTestUser(db);
    await db.insert(programs).values({ id: "theirs", userId: other, kind: "coach", name: "Theirs", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    expect((await call("PATCH", "/api/plans/theirs", { purpose: "Mine now" })).status).toBe(404);
    expect((await rowOf("theirs")).purpose).toBeNull();
  });

  it("the one-off bucket is not a plan: 404", async () => {
    await plan("bucket", "studio");
    expect((await call("PATCH", "/api/plans/bucket", { purpose: "x" })).status).toBe(404);
  });

  it("a purpose of 201 characters is 422; 200 is fine", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { purpose: "x".repeat(201) })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { purpose: "x".repeat(200) })).status).toBe(200);
  });

  it("a brief of 1,001 characters is 422; 1,000 is fine", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { brief: "x".repeat(1001) })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { brief: "x".repeat(1000) })).status).toBe(200);
  });

  it("a pause date in the past or not a date is 422, and null clears a pause", async () => {
    await plan("plan-a", "coach", { pausedUntil: "2099-01-01" });
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: "2000-01-01" })).status).toBe(422);
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: "not a date" })).status).toBe(422);
    expect((await rowOf("plan-a")).pausedUntil).toBe("2099-01-01");
    expect((await call("PATCH", "/api/plans/plan-a", { pausedUntil: null })).status).toBe(200);
    expect((await rowOf("plan-a")).pausedUntil).toBeNull();
  });

  it("easeNext merges into a course's config; any other kind is 422", async () => {
    await plan("course-1", "course", { onEnd: "continue", config: { course: "c", weekdays: [1, 3], time: "07:00", quietDaysBeforeRace: 7, placementWeeksAhead: 2, easeNext: false } });
    expect((await call("PATCH", "/api/plans/course-1", { easeNext: true })).status).toBe(200);
    expect((await rowOf("course-1")).config).toMatchObject({ course: "c", weekdays: [1, 3], time: "07:00", easeNext: true });
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { easeNext: true })).status).toBe(422);
  });

  it("an unknown key is 422", async () => {
    await plan("plan-a", "coach");
    expect((await call("PATCH", "/api/plans/plan-a", { name: "Renamed" })).status).toBe(422);
  });

  it("applyPlanPatch lands the row and its version as two writes in one batch, and says what changed", async () => {
    const writes: string[] = [];
    const rec = makeTestDb({ boundVariableCap: 100, onStatement: (s) => isWrite(s) && writes.push(s) });
    const { userId: u } = await makeTestUser(rec);
    await rec.insert(programs).values({ id: "p", userId: u, kind: "coach", name: "P", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    writes.length = 0;
    expect(await applyPlanPatch(rec, u, "p", { purpose: "Hello" }, NOW)).toEqual({ ok: true, changed: ["purpose"] });
    expect(writes.length).toBe(2);
    expect(await applyPlanPatch(rec, u, "nope", { purpose: "Hello" }, NOW)).toEqual({ ok: false, error: "not_found" });
  });
});
