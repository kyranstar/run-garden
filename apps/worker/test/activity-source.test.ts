import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, type SourceActivity } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const T = "2026-08-10T12:00:00Z";

async function insertActivity(db: Db, userId: string, id: string, source?: "coros" | "app" | "import") {
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: T,
    sport: "strength",
    durationSeconds: 1800,
    corosActivityId: null,
    ...(source ? { source } : {}),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

function corosStrength(offsetMin: number, extra: Partial<SourceActivity> = {}): SourceActivity {
  return {
    provider: "coros",
    providerActivityId: "c-1",
    startTime: new Date(Date.parse(T) + offsetMin * 60_000).toISOString().replace(".000Z", "Z"),
    sport: "strength",
    durationSeconds: 1750,
    contentFingerprint: "fp-1",
    ...extra,
  };
}

describe("activities.source", () => {
  it("never adopts an import-source activity", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "imp", "import");
    await ingestActivities(db, { userId, sources: [corosStrength(5)] });
    const rows = await db.select().from(schema.activities);
    expect(rows).toHaveLength(2);
    const imp = rows.find((r) => r.id === "imp")!;
    expect(imp.source).toBe("import");
    expect(imp.corosActivityId).toBeNull();
  });

  it("adopts an app-source activity as the merge: same id, COROS metrics, source becomes coros", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "app1", "app");
    await ingestActivities(db, { userId, sources: [corosStrength(2, { avgHeartRate: 120 })] });
    const rows = await db.select().from(schema.activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("app1");
    expect(rows[0]!.avgHeartRate).toBe(120);
    expect(rows[0]!.source).toBe("coros");
    expect(rows[0]!.corosActivityId).toBe("c-1");
  });

  it("never lets an import-source activity complete a planned session (audit 1, ingest MINOR #2)", async () => {
    // Spec §10.7: imported history carries no match and never enters the
    // garden, and a completion credits the garden. The ingest's auto-matcher
    // read every unmatched activity, so any COROS activity that brought the
    // date into play let an imported lift complete an open planned one.
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const day = T.slice(0, 10);
    await db.insert(schema.plannedWorkouts).values({
      id: "lift",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:lift",
      title: "Legs",
      category: "strength",
      sport: "strength",
      originalPlanDate: day,
      lastVerifiedCorosDate: day,
      effectiveDate: day,
      effectiveTime: "05:00",
      sourceContentFingerprint: "fp",
      fallbackEstimatedDurationSeconds: 1800,
      calendarBlockDurationSeconds: 1800,
      completionState: "unresolved",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await insertActivity(db, userId, "imp", "import");
    // An unrelated COROS run that day is what brings the date into matching.
    await ingestActivities(db, {
      userId,
      sources: [corosStrength(300, { providerActivityId: "run-1", sport: "run", contentFingerprint: "fp-run" })],
    });

    const [lift] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "lift"));
    expect(lift!.completionState).toBe("unresolved");
    const [imp] = await db.select().from(schema.activities).where(eq(schema.activities.id, "imp"));
    expect(imp!.completionMatchId).toBeNull();
    expect(await db.select().from(schema.workoutCompletionMatches)).toEqual([]);
  });

  it("merges an app mobility session with the watch's Strength copy of it — and only an app one (audit 1, ingest MINOR #3)", async () => {
    // The watch files a pushed mobility program as Strength (402); the app
    // saved the same session as yoga. One physical session, counted once
    // (spec §10.6) — but only for the deliberate app+watch merge: a legacy
    // COROS-source yoga row and a strength session are two sessions.
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "app-mob",
      userId,
      startTime: T,
      sport: "yoga",
      durationSeconds: 1800,
      source: "app",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await ingestActivities(db, { userId, sources: [corosStrength(2)] });
    const merged = await db.select().from(schema.activities);
    expect(merged.map((r) => r.id)).toEqual(["app-mob"]);
    expect(merged[0]!.corosActivityId).toBe("c-1");

    const db2 = makeTestDb();
    const { userId: u2 } = await makeTestUser(db2);
    await db2.insert(schema.activities).values({
      id: "legacy-yoga",
      userId: u2,
      startTime: T,
      sport: "yoga",
      durationSeconds: 1800,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await ingestActivities(db2, { userId: u2, sources: [corosStrength(2)] });
    expect((await db2.select().from(schema.activities)).map((r) => r.id).sort()).toHaveLength(2);
  });

  it("rows inserted without a source read back as coros", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "legacy");
    const [row] = await db.select().from(schema.activities).where(eq(schema.activities.id, "legacy"));
    expect(row!.source).toBe("coros");
  });
});
