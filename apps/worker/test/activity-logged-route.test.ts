/**
 * GET /api/activities carries each activity's logged sets (Phase 2a+ Task 3):
 * a strength activity with a watch session lists its exercises by name with
 * weights in the athlete's unit; every other row says null.
 */
import { describe, expect, it } from "vitest";
import type { SourceActivity } from "@rg/domain";
import { activityRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { detailOf, makeEnv, workView } from "./watch-sets-fixture.js";

const src = (extra: Partial<SourceActivity>): SourceActivity => ({
  provider: "coros",
  providerActivityId: "lbl-lift-51",
  startTime: "2026-10-01T13:00:00Z",
  startTimeLocal: "2026-10-01T06:00:00",
  sport: "strength",
  durationSeconds: 2400,
  contentFingerprint: "fp",
  ...extra,
});

async function feed(weightUnit: "lb" | "kg") {
  const db = makeTestDb();
  const { userId } = await makeTestUser(db, { weightUnit });
  await ingestActivities(db, {
    userId,
    sources: [
      src({}),
      src({ providerActivityId: "lbl-run-52", sport: "run", startTime: "2026-10-01T18:00:00Z", startTimeLocal: "2026-10-01T11:00:00" }),
    ],
    strengthDetailsByProviderId: { "lbl-lift-51": detailOf(workView()) },
  });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const app = mountRoutes(db, "/api/activities", activityRoutes);
  const res = await app.request("/api/activities?limit=10", { headers: { Cookie: cookie } }, makeEnv());
  expect(res.status).toBe(200);
  return (await res.json()) as {
    activities: Array<{ sport: string; logged: Array<{ name: string; sets: Array<{ reps: number | null; load: { v: number; u: string } | null }> }> | null }>;
  };
}

describe("GET /api/activities — logged sets", () => {
  it("lists a lift's exercises by name, in the athlete's unit, and null on every other row", async () => {
    const body = await feed("lb");
    const lift = body.activities.find((a) => a.sport === "strength")!;
    const run = body.activities.find((a) => a.sport === "run")!;
    expect(lift.logged!.map((e) => e.name)).toEqual(["Bench Press", "Dumbbell Row", "Planks", "Push-ups"]);
    expect(lift.logged![0]!.sets[0]).toMatchObject({ reps: 8, load: { v: 50, u: "lb" } });
    expect(run.logged).toBeNull();
  });

  it("converts for a kilograms athlete", async () => {
    const body = await feed("kg");
    const lift = body.activities.find((a) => a.sport === "strength")!;
    expect(lift.logged![0]!.sets[0]!.load).toEqual({ v: 22.5, u: "kg" });
  });
});
