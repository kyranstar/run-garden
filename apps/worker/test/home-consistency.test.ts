/**
 * The home streak band's data (System 1 spec §server): `homeConsistency`
 * band mapping — celebrate-only bands, sanctioned-skip mercy, the current
 * week always "current" — plus the /api/plan/today wiring.
 *
 * Dates are pinned (never the real clock): "today" is Tue 2026-08-18, whose
 * ISO week starts Mon 2026-08-17. A test that reads the wall clock is a time
 * bomb — see garden-resim-crash-safety's Friday/Saturday incident.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { homeConsistency, planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts } = schema;

const TODAY = "2026-08-18"; // Tuesday
const THIS_WEEK = startOfIsoWeek(TODAY); // 2026-08-17

function row(
  effectiveDate: string,
  completionState: string,
  sanctionedBy: string | null = null,
): { effectiveDate: string; originalPlanDate: string; completionState: string; sanctionedBy: string | null; category: string } {
  return { effectiveDate, originalPlanDate: effectiveDate, completionState, sanctionedBy, category: "easy" };
}

describe("homeConsistency", () => {
  it("returns exactly 12 weeks oldest-first, last one always 'current'", () => {
    const out = homeConsistency([], TODAY, 0);
    expect(out.weeks).toHaveLength(12);
    expect(out.weeks[0]!.weekStart).toBe(addDays(THIS_WEEK, -77));
    expect(out.weeks[11]!).toEqual({ weekStart: THIS_WEEK, band: "current" });
    // Nothing planned anywhere: every past week is quiet, and the
    // percentage is null, not 0 — silence, not a zero score.
    expect(out.weeks.slice(0, 11).every((w) => w.band === "quiet")).toBe(true);
    expect(out.adherencePct).toBeNull();
  });

  it("maps a completed week to 'full', a half week to 'partial', and never mints a punitive band", () => {
    const fullWeek = addDays(THIS_WEEK, -7);
    const halfWeek = addDays(THIS_WEEK, -14);
    const missedWeek = addDays(THIS_WEEK, -21);
    const rows = [
      row(fullWeek, "completed"),
      row(addDays(fullWeek, 2), "completed"),
      row(halfWeek, "completed"),
      row(addDays(halfWeek, 2), "missed"),
      row(missedWeek, "missed"),
      row(addDays(missedWeek, 2), "missed"),
    ];
    const out = homeConsistency(rows, TODAY, 3);
    const band = (ws: string) => out.weeks.find((w) => w.weekStart === ws)!.band;
    expect(band(fullWeek)).toBe("full");
    expect(band(halfWeek)).toBe("partial");
    // All-missed is "quiet" — the squares celebrate; the garden never accuses.
    expect(band(missedWeek)).toBe("quiet");
    expect(out.streakWeeks).toBe(3);
    // 3 completed of 6 resolved.
    expect(out.adherencePct).toBe(50);
  });

  it("lets a coach-sanctioned skip leave the ledger entirely (the /week mercy)", () => {
    const wk = addDays(THIS_WEEK, -7);
    const rows = [
      row(wk, "completed"),
      row(addDays(wk, 2), "skipped", "coach"),
    ];
    const out = homeConsistency(rows, TODAY, 1);
    expect(out.weeks.find((w) => w.weekStart === wk)!.band).toBe("full");
    expect(out.adherencePct).toBe(100);
    // The same skip WITHOUT sanction dims the week and the number.
    const unsanctioned = homeConsistency(
      [row(wk, "completed"), row(addDays(wk, 2), "skipped")],
      TODAY,
      1,
    );
    expect(unsanctioned.weeks.find((w) => w.weekStart === wk)!.band).toBe("partial");
    expect(unsanctioned.adherencePct).toBe(50);
  });

  it("treats an all-unresolved week as quiet, not failed", () => {
    const wk = addDays(THIS_WEEK, -7);
    const out = homeConsistency([row(wk, "unresolved"), row(addDays(wk, 1), "unresolved")], TODAY, 0);
    expect(out.weeks.find((w) => w.weekStart === wk)!.band).toBe("quiet");
    expect(out.adherencePct).toBeNull();
  });
});

describe("GET /api/plan/today consistency wiring", () => {
  let db: Db;
  let userId: string;
  let cookie: string;

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

  beforeEach(async () => {
    db = makeTestDb();
    const user = await makeTestUser(db);
    userId = user.userId;
    const token = await createSession(db, userId);
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  it("ships 12 bands and a percentage derived from the athlete's own rows", async () => {
    // One completed workout last ISO week (relative to the route's own
    // "today" — the real one, in the test user's zone; this test asserts
    // shape and wiring, band identity is pinned above).
    const lastWeek = addDays(startOfIsoWeek(new Date().toISOString().slice(0, 10)), -7);
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${id.slice(0, 4)}`,
      lastVerifiedCorosDate: lastWeek,
      title: "Easy Run",
      category: "easy",
      sport: "run",
      originalPlanDate: lastWeek,
      effectiveDate: lastWeek,
      effectiveTime: "07:00",
      completionState: "completed",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const res = await app.request("/api/plan/today", { headers: { Cookie: cookie } }, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consistency: { weeks: Array<{ band: string }>; adherencePct: number | null; streakWeeks: number };
    };
    expect(body.consistency.weeks).toHaveLength(12);
    expect(body.consistency.weeks[11]!.band).toBe("current");
    expect(body.consistency.adherencePct).toBe(100);
    expect(body.consistency.streakWeeks).toBe(0);
  });
});
