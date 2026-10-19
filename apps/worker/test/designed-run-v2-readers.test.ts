/**
 * WHAT READS A DESIGNED RUN, ON THE v2 WIRE (§8 phase 2, `RUN_WIRE_V2`): whether it can go to the watch, the approve
 * that queues it, the body check's Undo that writes it back, and the operator's absent push. On v2 a distance needs no
 * pace to run (it goes as a distance) and a part's rounds count as one group, so a run v1 would keep here — a distance
 * with no threshold known, or 30 rounds of two — goes; off, each answers as phase 1 did. Synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, runWatchSessionOf, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { watchPushable } from "../src/services/coach-apply.js";
import { createDesignedRun } from "../src/services/designed-runs.js";
import { pushAbsentSessions } from "../src/services/push-absent.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

const doc = (rounds: number, cooldown: Record<string, unknown> = { distanceM: 2000 }): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Tempo.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds, items: [{ kind: "run", effort: "tempo", target: { durationSec: 300 } }, { kind: "run", effort: "recovery", target: { durationSec: 60 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: cooldown }] },
  ],
  source: { kind: "coach" },
  basedOn: { kind: "proposal", id: "dp-x", opId: "x" },
});
const sessionOf = (d: WorkoutDoc, wire: "v1" | "v2") => {
  const made = runWatchSessionOf(d, wire);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
};

describe("whether a designed run can go to the watch", () => {
  it("a distance with no threshold: v2 runs it as a distance, v1 can't time it", () => {
    const s = sessionOf(doc(3), "v1");
    expect(watchPushable(s, null)).toBe(false);
    expect(watchPushable(s, null, "v2")).toBe(true);
    expect(watchPushable(s, 289)).toBe(true);
  });
  it("30 rounds of two: 5 steps on v2, 62 written out on v1 — which can't hold it", () => {
    const s = sessionOf(doc(30, { durationSec: 600 }), "v2");
    expect(watchPushable(s, 289, "v2")).toBe(true);
    expect(watchPushable(s, 289)).toBe(false);
  });
});

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  today = todayInZone(prefs.timezone);
});
afterEach(() => vi.useRealTimers());

describe("the approve, on the wire in force", () => {
  const approve = (d: WorkoutDoc, key: string, runWire?: "v1" | "v2") =>
    createDesignedRun(db, userId, { date: addDays(today, 2), time: null, doc: d, clientId: key }, { today, now: nowInstant(), prefs, ...(runWire ? { runWire } : {}) }, { sourceKind: "coach" });

  it("with no threshold known, a run with a distance is queued to the watch on v2, and kept here on v1", async () => {
    expect((await approve(doc(3), "a", "v2")).queued).toBe(true);
    expect((await approve(doc(3), "b")).queued).toBe(false);
  });

  it("30 rounds of two is a run on v2; on v1 the validator refuses it", async () => {
    const made = await approve(doc(30, { durationSec: 600 }), "c", "v2");
    expect(made.queued).toBe(true);
    const [job] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, made.workout.id));
    expect((job!.payload as { session: { segments: Array<{ rounds: number }> } }).session.segments[1]!.rounds).toBe(30);
    await expect(approve(doc(30, { durationSec: 600 }), "d")).rejects.toThrow();
  });
});

describe("the operator's absent push, on the wire it is given", () => {
  it("a designed run with a distance and no threshold: pushed on v2, unpushable on v1", async () => {
    const made = await createDesignedRun(db, userId, { date: addDays(today, 2), time: null, doc: doc(3), clientId: "e" }, { today, now: nowInstant(), prefs }, { sourceKind: "coach" });
    const id = made.workout.id;
    expect(made.queued).toBe(false);
    const v1 = await pushAbsentSessions(db, userId, { dryRun: true });
    expect(v1.rows.find((r) => r.workoutId === id)?.action).toBe("unpushable");
    await pushAbsentSessions(db, userId, { dryRun: false, runWire: "v2" });
    const jobs = await db.select().from(schema.corosWriteJobs).where(and(eq(schema.corosWriteJobs.workoutId, id), eq(schema.corosWriteJobs.kind, "coach_create_workout")));
    expect(jobs).toHaveLength(1);
  });
});
