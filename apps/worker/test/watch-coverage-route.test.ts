/**
 * The coverage field as the ATHLETE receives it — driven through `applyOps`
 * (the real writer of every column the row adapter reads) and out of
 * `GET /api/plan/workouts/:id`.
 *
 * The unit test next door pins the rule set against `watchPushable`. This one
 * pins the other half of the same claim: that reconstructing a session's shape
 * from a stored row reaches the same verdict the session itself would have.
 * `routes/plan.ts` reads `sport`, `structuredJson`, `sourceIdInPlan`, the
 * stage rows and the open content intent; `coach-apply.ts` writes all five,
 * and neither file knows about the other. This test is the seam.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  addDays,
  coachSessionSchema,
  nowInstant,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { applyOps } from "../src/services/coach-apply.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts } = schema;

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

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

const get = (path: string) =>
  mountRoutes(db, "/api/plan", planRoutes).request(path, { headers: { Cookie: cookie } }, makeEnv());

async function coverageOf(id: string) {
  const res = await get(`/api/plan/workouts/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { workout: Record<string, unknown> }).workout;
}

async function apply(ops: CoachOp[]) {
  return applyOps(db, userId, prefs, `prop-${Math.random()}`, ops);
}

/** Through the schema, exactly as a wake's ops arrive — `weight` and
 * `restSeconds` carry defaults the apply path relies on. */
const session = (o: Record<string, unknown>): CoachSession => coachSessionSchema.parse(o);

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  prefs = user.prefs;
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

describe("GET /api/plan/workouts/:id — watchCoverage", () => {
  it("says nothing at all about a timed run: full coverage is silence", async () => {
    const today = todayInZone(prefs.timezone);
    const out = await apply([
      {
        kind: "add",
        date: addDays(today, 2),
        session: session({
          category: "easy",
          title: "Steady 40",
          durationMinutes: 40,
          run: { blocks: [{ kind: "duration", value: 40 }] },
        }),
      } as CoachOp,
    ]);
    const w = await coverageOf(out.created[0]!);
    expect(w.watchCoverage).toBeUndefined();
  });

  it("names the discipline for a lift, and the movements the library lacks", async () => {
    const today = todayInZone(prefs.timezone);
    const out = await apply([
      {
        kind: "add",
        date: addDays(today, 3),
        session: session({
          category: "strength",
          title: "Ski legs",
          durationMinutes: 35,
          lift: {
            exercises: [
              { name: "Skier hops", sets: 3, reps: 12 },
              { name: "Wall sit", sets: 3, holdSeconds: 45 },
            ],
          },
        }),
      } as CoachOp,
    ]);
    const w = await coverageOf(out.created[0]!);
    expect(w.watchCoverage).toEqual({
      coverage: "none",
      discipline: "lift",
      gaps: [{ code: "discipline_off_wire" }, { code: "off_catalog", names: ["Skier hops", "Wall sit"] }],
    });
  });

  it("catches the distance-measured run the old exercise test let through", async () => {
    const today = todayInZone(prefs.timezone);
    const out = await apply([
      {
        kind: "add",
        date: addDays(today, 4),
        session: session({
          category: "quality",
          title: "6×400",
          durationMinutes: 45,
          run: {
            blocks: [
              { kind: "duration", value: 15, intensity: "easy" },
              { kind: "distance", value: 400, intensity: "interval" },
            ],
          },
        }),
      } as CoachOp,
    ]);
    const w = await coverageOf(out.created[0]!);
    // `watchPushable` refuses this session, so no create job was enqueued —
    // and the DTO now says why instead of leaving the athlete a "Sync to
    // COROS" button whose retry can only fail.
    expect(w.watchCoverage).toEqual({
      coverage: "none",
      discipline: "run",
      gaps: [{ code: "distance_target" }],
    });
  });

  it("reports steps that will arrive without a pace band", async () => {
    const today = todayInZone(prefs.timezone);
    // No threshold pace is passed to apply, so `writeStages` writes no bands.
    const out = await apply([
      {
        kind: "add",
        date: addDays(today, 5),
        session: session({
          category: "quality",
          title: "Threshold 3×8",
          durationMinutes: 50,
          run: {
            blocks: [
              { kind: "duration", value: 15, intensity: "easy" },
              { kind: "duration", value: 8, intensity: "threshold" },
              { kind: "duration", value: 3, intensity: "rest" },
            ],
          },
        }),
      } as CoachOp,
    ]);
    const w = await coverageOf(out.created[0]!);
    // The `rest` block is NOT owed a pace band — a walk has no honest one —
    // which is the same exclusion `missingPaceTargets` makes on the wire.
    expect(w.watchCoverage).toEqual({
      coverage: "partial",
      discipline: "run",
      gaps: [{ code: "pace_targets_owed", count: 2 }],
    });
  });

  it("says nothing about a session whose content came FROM COROS", async () => {
    // An imported strength workout is on the watch by definition. Telling its
    // owner "your watch won't show this, it's a lift" would be the loudest
    // possible way to be wrong.
    const id = "imported-lift";
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${id}`,
      sourceIdInPlan: "11",
      title: "Gym",
      category: "strength",
      sport: "strength",
      originalPlanDate: "2026-08-20",
      lastVerifiedCorosDate: "2026-08-20",
      effectiveDate: "2026-08-20",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const w = await coverageOf(id);
    expect(w.watchCoverage).toBeUndefined();
    expect(w.corosSyncView).toBe("synced");
  });

  it("turns an eased-but-pushed session from 'synced' into 'older on watch'", async () => {
    // THE HEADLINE CASE. A row COROS already holds, eased in place: the date
    // does not move, no job exists, and the derivation used to answer "synced".
    const id = "pushed-run";
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${id}`,
      sourceIdInPlan: "12",
      title: "Threshold 5×5",
      category: "quality",
      sport: "run",
      originalPlanDate: "2026-08-20",
      lastVerifiedCorosDate: "2026-08-20",
      effectiveDate: "2026-08-20",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    expect((await coverageOf(id)).corosSyncView).toBe("synced");

    await apply([
      {
        kind: "ease",
        workoutId: id,
        session: session({
          category: "easy",
          title: "Easy 30 — calf",
          durationMinutes: 30,
          run: { blocks: [{ kind: "duration", value: 30 }] },
        }),
      } as CoachOp,
    ]);
    const after = await coverageOf(id);
    expect(after.corosSyncView).toBe("content_stale");
    // The eased body is still a timed run, so there is nothing to disclose
    // about coverage — the divergence is the whole story.
    expect(after.watchCoverage).toBeUndefined();
    expect(
      (await db.select({ d: plannedWorkouts.effectiveDate }).from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!.d,
    ).toBe("2026-08-20");
  });

  it("keeps a rest day out of it entirely", async () => {
    const today = todayInZone(prefs.timezone);
    const out = await apply([
      {
        kind: "add",
        date: addDays(today, 6),
        session: session({ category: "rest", title: "Off", durationMinutes: 0 }),
      } as CoachOp,
    ]);
    expect((await coverageOf(out.created[0]!)).watchCoverage).toBeUndefined();
  });
});
