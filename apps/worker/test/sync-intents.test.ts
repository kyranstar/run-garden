import { describe, expect, it } from "vitest";
import { makeTestDb, makeTestUser } from "./helpers.js";
import {
  appRequestedDates,
  openIntentFor,
  recordIntent,
  resolveIntent,
} from "../src/services/sync-intents.js";
import { nowInstant, newId } from "@rg/domain";
import { schema } from "@rg/database";

describe("sync intents", () => {
  it("records an intent and finds it open", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10", toTime: "07:00", fromDate: "2026-08-08" },
      source: "user_move",
    });
    const open = await openIntentFor(db, userId, "w1");
    expect(open?.id).toBe(id);
    expect(open?.payload?.["toDate"]).toBe("2026-08-10");
  });

  it("a newer intent supersedes the older one of the same kind+target", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const first = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10" }, source: "user_move",
    });
    const second = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-11" }, source: "calendar_drag",
    });
    const open = await openIntentFor(db, userId, "w1");
    expect(open?.id).toBe(second);
    const rows = await db.select().from(schema.syncIntents);
    expect(rows.find((r) => r.id === first)?.supersededBy).toBe(second);
  });

  it("resolveIntent closes it", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10" }, source: "user_move",
    });
    await resolveIntent(db, id, nowInstant());
    expect(await openIntentFor(db, userId, "w1")).toBeNull();
  });

  it("appRequestedDates maps sourceWorkoutId to requested dates, resolved included", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = newId();
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: "p", sourceWorkoutId: "4738:12",
      title: "Upper A — wk 1", category: "strength", sport: "strength",
      originalPlanDate: "2026-08-08", lastVerifiedCorosDate: "2026-08-08",
      effectiveDate: "2026-08-08", effectiveTime: "07:00",
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: workoutId, kind: "move",
      payload: { toDate: "2026-08-09" }, source: "user_move",
    });
    await resolveIntent(db, id, nowInstant());
    const map = await appRequestedDates(db, userId);
    expect(map.get("4738:12")?.has("2026-08-09")).toBe(true);
  });
});
