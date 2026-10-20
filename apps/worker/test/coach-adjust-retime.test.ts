/**
 * A STRUCTURED RUN'S LENGTH, RE-TIMED BY THE RULE (the owner's decision, 2026-10-20): `retimeOfRow` reads a planned row's
 * structure into @rg/domain's `retimeRun` — a designed run by its document, a plan run (imported, or the thread coach's)
 * by its stage rows — and `applyOps`' `adjust`, given the card's expectation, writes it as an ease writes: the row, its
 * stages, its document, the app's claim, a queued create's session and the watch's rewrite. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, parseStoredWorkoutDoc, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { retimeOfRow, type RetimeExpectation } from "../src/services/adjust-retime.js";
import { createDesignedRun } from "../src/services/designed-runs.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, plannedWorkoutStages, corosWriteJobs } = schema;

/** 10 min easy · 3 × (8 min tempo / 2 min jog) · 10 min easy: fifty minutes. */
const tempoDoc = (over: Partial<WorkoutDoc> = {}): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: ["speed"], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    {
      purpose: "run",
      format: "intervals",
      rounds: 3,
      items: [
        { kind: "run", effort: "tempo", target: { durationSec: 480 } },
        { kind: "run", effort: "recovery", target: { durationSec: 120 } },
      ],
    },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
  ],
  source: { kind: "coach" },
  basedOn: { kind: "proposal", id: "dp-1", opId: "run-1" },
  ...over,
});

async function setup(o: { writes?: boolean } = {}) {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: o.writes ?? true });
  return { db, userId, prefs, today: todayInZone(prefs.timezone) };
}

const rowOf = async (db: Db, id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const stagesOf = (db: Db, id: string) => db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id)).orderBy(asc(plannedWorkoutStages.ord));
const jobsOf = (db: Db, id: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));

/** What adjust_plan keeps on the op when the coach proposes the length: the rule, run on the row as it stands. */
async function cardOf(db: Db, id: string, minutes: number, threshold: number | null = null): Promise<RetimeExpectation> {
  const r = retimeOfRow(await rowOf(db, id), await stagesOf(db, id), minutes, { thresholdSecPerKm: threshold, runWire: "v1" });
  if (r.kind !== "retimed") throw new Error(`not re-timed: ${JSON.stringify(r)}`);
  return r.expect;
}

async function designedRun(db: Db, userId: string, prefs: UserPreferences, today: string, doc = tempoDoc()): Promise<string> {
  const made = await createDesignedRun(db, userId, { date: addDays(today, 2), time: "07:00", doc, clientId: "k-1" }, { today, now: nowInstant(), prefs, runWire: "v1" }, { sourceKind: "coach", sourceRef: "dp-1" });
  return made.workout.id;
}

/** The create verified at a COROS address: the run is on the watch. */
async function onTheWatch(db: Db, id: string, date: string) {
  await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: nowInstant() }).where(eq(corosWriteJobs.id, `${id}-push`));
  await db
    .update(plannedWorkouts)
    .set({ sourceWorkoutId: "123:9", sourceIdInPlan: "9", sourceProgramId: "456", lastVerifiedCorosDate: date, sourceContentFingerprint: "0123456789abcdef", corosSyncState: "synced" })
    .where(eq(plannedWorkouts.id, id));
}

describe("a designed run re-timed by its document", () => {
  it("not yet on the watch: its document, stage rows and length re-timed, and its queued create carries the new session", async () => {
    const { db, userId, prefs, today } = await setup();
    const id = await designedRun(db, userId, prefs, today);
    expect((await rowOf(db, id)).fallbackEstimatedDurationSeconds).toBe(3000);
    const card = await cardOf(db, id, 40);
    expect(card).toMatchObject({ minutes: 40, summary: "2 × 8 min (was 3 × 8)" });

    const out = await applyOps(db, userId, prefs, "dp-2", [{ kind: "adjust", workoutId: id, durationMinutes: 40 }], { retimes: new Map([[id, card]]) });
    expect(out).toMatchObject({ updated: [id], missed: [] });

    const row = await rowOf(db, id);
    expect([row.fallbackEstimatedDurationSeconds, row.calendarBlockDurationSeconds, row.sourceEstimatedDurationSeconds]).toEqual([2400, 2400, null]);
    expect(row.stageSummary).toBe(card.stageSummary);
    expect(row.stageSummary).toBe("10 min easy · 2 × 8 min tempo / 2 min recovery · 10 min easy");
    expect(row.workoutDocRev).toBe(2);
    const doc = parseStoredWorkoutDoc(row.workoutDoc)!;
    expect(doc.parts[1]!.rounds).toBe(2);
    expect(doc.setting?.targetMinutes).toBe(40);
    expect(doc.basedOn).toEqual({ kind: "proposal", id: "dp-1", opId: "run-1" });
    const stages = await stagesOf(db, id);
    expect(stages.find((s) => s.kind === "repeat")!.repeatCount).toBe(2);
    expect(stages).toHaveLength(card.stageRows);
    // The create still queued now carries two rounds: the watch never gets the old run.
    const [create] = await jobsOf(db, id);
    expect(create!.kind).toBe("coach_create_workout");
    expect((create!.payload as { session: { segments: Array<{ rounds: number }> } }).session.segments.map((s) => s.rounds)).toEqual([1, 2, 1]);
    // The app's claim on its content; no rewrite (nothing is on the watch to rewrite).
    expect((await openIntentFor(db, userId, id, "content"))?.source).toBe("coach_adjust");
  });

  it("on the watch: the rewrite of its copy is queued, on what the watch holds, as an ease's", async () => {
    const { db, userId, prefs, today } = await setup();
    const id = await designedRun(db, userId, prefs, today);
    await onTheWatch(db, id, addDays(today, 2));
    const card = await cardOf(db, id, 40);
    await applyOps(db, userId, prefs, "dp-2", [{ kind: "adjust", workoutId: id, durationMinutes: 40 }], { retimes: new Map([[id, card]]) });
    const update = (await jobsOf(db, id)).find((j) => j.kind === "coach_update_workout")!;
    expect(update).toMatchObject({ status: "queued", expectedContentFingerprint: "0123456789abcdef" });
    const session = (update.payload as { session: { kind: string; segments: Array<{ rounds: number }> } }).session;
    expect(session.kind).toBe("run_watch");
    expect(session.segments.map((s) => s.rounds)).toEqual([1, 2, 1]);
    expect((await rowOf(db, id)).corosSyncState).toBe("calendar_only");
  });

  it("a card the session no longer matches: nothing is written, and the applier says why", async () => {
    const { db, userId, prefs, today } = await setup();
    const id = await designedRun(db, userId, prefs, today);
    const card = await cardOf(db, id, 40);
    const before = await rowOf(db, id);
    const out = await applyOps(db, userId, prefs, "dp-2", [{ kind: "adjust", workoutId: id, durationMinutes: 40 }], { retimes: new Map([[id, { ...card, summary: "3 × 8 min (was 4 × 8)" }]]) });
    expect(out.updated).toEqual([]);
    expect(out.missed).toEqual(["a session it re-times has changed since it was suggested, so it is as it was"]);
    expect(await rowOf(db, id)).toEqual(before);
    expect((await jobsOf(db, id)).map((j) => j.kind)).toEqual(["coach_create_workout"]);
  });

  it("with no card (the thread coach's adjust): the length alone, as it always was — its steps untouched", async () => {
    const { db, userId, prefs, today } = await setup();
    const id = await designedRun(db, userId, prefs, today);
    const stages = await stagesOf(db, id);
    await applyOps(db, userId, prefs, "p", [{ kind: "adjust", workoutId: id, durationMinutes: 40 }]);
    const row = await rowOf(db, id);
    expect(row.fallbackEstimatedDurationSeconds).toBe(2400);
    expect(row.stageSummary).toBe("10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy");
    expect(await stagesOf(db, id)).toEqual(stages);
    expect(parseStoredWorkoutDoc(row.workoutDoc)!.parts[1]!.rounds).toBe(3);
  });

  it("a distance in it is timed at its pace, re-timed to the 100 m, and its typed words go", async () => {
    const { db, userId, prefs, today } = await setup();
    const doc = tempoDoc({
      parts: [
        { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
        { purpose: "run", format: "steady", items: [{ kind: "run", effort: "long", target: { distanceM: 16093, typed: "10 mi" } }] },
        { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
      ],
    });
    // With a threshold of 4:49 the long run's pace is known: the rule times it there.
    await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: addDays(today, -1), thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: nowInstant() });
    const id = await designedRun(db, userId, prefs, today, doc);
    const was = Math.round(((await rowOf(db, id)).fallbackEstimatedDurationSeconds ?? 0) / 60);
    const target = was - 30;
    const r = retimeOfRow(await rowOf(db, id), [], target, { thresholdSecPerKm: 289, runWire: "v2" });
    if (r.kind !== "retimed" || r.write.family !== "designed") throw new Error("not re-timed");
    const long = r.write.doc.parts[1]!.items[0]!;
    if (long.kind !== "run") throw new Error("not a run");
    expect(long.target.distanceM! % 100).toBe(0);
    expect(long.target.distanceM!).toBeLessThan(16093);
    expect(long.target.typed).toBeUndefined();
    expect(r.minutes).toBe(target);
    expect(r.summary).toBe(`long ${Number((long.target.distanceM! / 1000).toFixed(2))} km (was 16.09)`);
  });

  it("more reps than the watch can hold on its wire: refused, the coach told to use ease", async () => {
    const { db, userId, prefs, today } = await setup();
    const doc = tempoDoc({
      parts: [
        { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
        { purpose: "run", format: "intervals", rounds: 20, items: [{ kind: "run", effort: "interval", target: { durationSec: 60 } }, { kind: "run", effort: "recovery", target: { durationSec: 60 } }] },
        { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
      ],
    });
    const id = await designedRun(db, userId, prefs, today, doc);
    // 20 → 30 reps: 62 steps written out on v1 — past its 60; v2 holds them as a group.
    const v1 = retimeOfRow(await rowOf(db, id), [], 80, { thresholdSecPerKm: null, runWire: "v1" });
    expect(v1).toMatchObject({ kind: "refused", refusal: "too_many_steps" });
    if (v1.kind === "refused") expect(v1.reason).toContain("ease");
    expect(retimeOfRow(await rowOf(db, id), [], 80, { thresholdSecPerKm: null, runWire: "v2" })).toMatchObject({ kind: "retimed", minutes: 80 });
  });
});

describe("a plan run re-timed by its stage rows", () => {
  /** 5 min easy · 5 × 5 min threshold · 5 min easy — the thread coach's blocks, written out. */
  const tempo35 = {
    category: "quality" as const,
    title: "Tempo",
    durationMinutes: 35,
    run: {
      blocks: [
        { kind: "duration" as const, value: 5, intensity: "easy" as const },
        ...Array.from({ length: 5 }, () => ({ kind: "duration" as const, value: 5, intensity: "threshold" as const })),
        { kind: "duration" as const, value: 5, intensity: "easy" as const },
      ],
    },
  };

  it("the owner's example — a thread-coach tempo of 5 × 5 min cut to 25 is 3 × 5 min: its blocks, its name kept, its create's session", async () => {
    const { db, userId, prefs, today } = await setup();
    const added = await applyOps(db, userId, prefs, "tp-1", [{ kind: "add", date: addDays(today, 3), session: tempo35 }]);
    const id = added.created[0]!;
    await db.update(plannedWorkouts).set({ qualitySubtype: "tempo" }).where(eq(plannedWorkouts.id, id));
    const card = await cardOf(db, id, 25);
    expect(card).toMatchObject({ minutes: 25, summary: "3 × 5 min (was 5 × 5)", stageRows: 5 });

    await applyOps(db, userId, prefs, "dp-2", [{ kind: "adjust", workoutId: id, durationMinutes: 25 }], { retimes: new Map([[id, card]]) });
    const row = await rowOf(db, id);
    expect([row.title, row.category, row.qualitySubtype, row.fallbackEstimatedDurationSeconds]).toEqual(["Tempo", "quality", "tempo", 1500]);
    expect(row.stageSummary).toBe(card.stageSummary);
    const stages = await stagesOf(db, id);
    expect(stages.map((s) => [s.kind, s.durationSeconds, s.label])).toEqual([
      ["warmup", 300, "easy"],
      ["work", 300, "threshold"],
      ["work", 300, "threshold"],
      ["work", 300, "threshold"],
      ["cooldown", 300, "easy"],
    ]);
    const [create] = await jobsOf(db, id);
    expect((create!.payload as { session: { run: { blocks: unknown[] } } }).session.run.blocks).toHaveLength(5);
  });

  it("an imported run on the watch whose watch version the athlete kept: re-claimed, its distances on the watch as their time (review-S3 A1)", async () => {
    const { db, userId, prefs, today } = await setup();
    const date = addDays(today, 4);
    await db.insert(plannedWorkouts).values({
      id: "imp-1", userId, planId: "coros-plan", sourceWorkoutId: "700:5", sourceIdInPlan: "5", sourceProgramId: "55", title: "VO2 6x1k", category: "quality",
      qualitySubtype: "intervals", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00",
      sourceContentFingerprint: "take-watch-copy:0123456789abcdef", sourceEstimatedDurationSeconds: 3600, calendarBlockDurationSeconds: 5100,
      corosSyncState: "synced", completionState: "scheduled", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    // 2 km warm-up · 6 × (1 km / 400 m jog) · 2 km cool-down, as COROS sends them: a repeat stage holding its two.
    const stage = (id: string, ord: number, kind: string, meters: number | null, o: Record<string, unknown> = {}) => ({
      id, workoutId: "imp-1", parentStageId: null, ord, kind, repeatCount: null, durationType: meters ? "distance" : "none", durationSeconds: null, distanceMeters: meters, label: null, ...o,
    });
    // Its labels are COROS's names for the steps, never intensities: "Recovery" is a recovery, whatever the word reads as.
    await db.insert(plannedWorkoutStages).values([
      stage("s0", 0, "warmup", 2000, { label: "Warm Up" }),
      stage("s1", 1, "repeat", null, { repeatCount: 6 }),
      stage("s2", 2, "work", 1000, { parentStageId: "s1", label: "Run" }),
      stage("s3", 3, "recovery", 400, { parentStageId: "s1", label: "Recovery" }),
      stage("s4", 4, "cooldown", 2000, { label: "Cool Down" }),
    ] as never);
    const card = await cardOf(db, "imp-1", 45);
    // 3600 s over 12.4 km: 290 s a km. Four reps make 46 min, three 40 — four is nearer 45.
    expect(card).toMatchObject({ minutes: 46, summary: "4 × 1 km (was 6 × 1)" });

    await applyOps(db, userId, prefs, "dp-3", [{ kind: "adjust", workoutId: "imp-1", durationMinutes: 45 }], { retimes: new Map([["imp-1", card]]) });
    const row = await rowOf(db, "imp-1");
    // The mark lifted: the app's claim is live, and its rewrite is on what the watch holds.
    expect(row.sourceContentFingerprint).toBe("0123456789abcdef");
    expect([row.title, row.category, row.qualitySubtype, row.sourceEstimatedDurationSeconds, row.fallbackEstimatedDurationSeconds]).toEqual(["VO2 6x1k", "quality", "intervals", null, 46 * 60]);
    // The app keeps its distances; the watch's copy has each as its time.
    expect((await stagesOf(db, "imp-1")).map((s) => [s.durationType, s.distanceMeters ?? s.durationSeconds, s.label])).toEqual([
      ["distance", 2000, "easy"],
      ...Array.from({ length: 4 }, () => [["distance", 1000, "interval"], ["distance", 400, "rest"]]).flat(),
      ["distance", 2000, "easy"],
    ]);
    const update = (await jobsOf(db, "imp-1")).find((j) => j.kind === "coach_update_workout")!;
    expect(update).toMatchObject({ status: "queued", expectedContentFingerprint: "0123456789abcdef" });
    const blocks = (update.payload as { session: { run: { blocks: Array<{ kind: string; value: number }> } } }).session.run.blocks;
    expect(blocks.every((b) => b.kind === "duration")).toBe(true);
    expect(blocks.map((b) => Math.round(b.value * 60))).toEqual([581, ...Array.from({ length: 4 }, () => [290, 116]).flat(), 581]);
    expect((update.payload as { importedProgramId?: string }).importedProgramId).toBe("55");
    expect((await openIntentFor(db, userId, "imp-1", "content"))?.source).toBe("coach_adjust");
  });
});

describe("what keeps its length alone", () => {
  const plain = { id: "x", title: "Run", category: "easy", qualitySubtype: null, sourceEstimatedDurationSeconds: null, fallbackEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 1800, workoutDoc: null };
  const block = { id: "x:0", parentStageId: null, ord: 0, kind: "work", repeatCount: null, durationType: "time", durationSeconds: 1800, distanceMeters: null, label: "easy" };
  const ctx = { thresholdSecPerKm: null, runWire: "v1" as const };

  it("a lift or a mobility session, a race, a run with no stages, a stage it can't read", () => {
    expect(retimeOfRow({ ...plain, sport: "strength" }, [block], 20, ctx)).toEqual({ kind: "length_only" });
    expect(retimeOfRow({ ...plain, sport: "yoga" }, [block], 20, ctx)).toEqual({ kind: "length_only" });
    expect(retimeOfRow({ ...plain, sport: "run", category: "race" }, [block], 20, ctx)).toEqual({ kind: "length_only" });
    expect(retimeOfRow({ ...plain, sport: "run" }, [], 20, ctx)).toEqual({ kind: "length_only" });
    expect(retimeOfRow({ ...plain, sport: "run" }, [{ ...block, durationType: "lap_button", durationSeconds: null }], 20, ctx)).toEqual({ kind: "length_only" });
    // A repeat inside a repeat (the inner one even stating a time of its own).
    const nested = [
      { ...block, id: "r1", kind: "repeat", durationType: "none", repeatCount: 2 },
      { ...block, id: "r2", parentStageId: "r1", ord: 1, kind: "repeat", durationType: "time", durationSeconds: 300, repeatCount: 2 },
      { ...block, id: "w", parentStageId: "r2", ord: 2 },
    ];
    expect(retimeOfRow({ ...plain, sport: "run" }, nested, 20, ctx)).toEqual({ kind: "length_only" });
  });

  it("a thread-coach run keeps the intensities it was written with — one it wrote without stays without", () => {
    const own = (i: number, kind: string, minutes: number, label: string | null) => ({ ...block, id: `x:${i}`, ord: i, kind, durationSeconds: minutes * 60, label });
    const stages = [own(0, "warmup", 10, "easy"), own(1, "work", 20, "steady"), own(2, "work", 3, "interval"), own(3, "work", 3, "interval"), own(4, "work", 10, null), own(5, "cooldown", 10, "easy")];
    const r = retimeOfRow({ ...plain, sport: "run", category: "quality", fallbackEstimatedDurationSeconds: 3360 }, stages, 46, ctx);
    if (r.kind !== "retimed" || r.write.family !== "plan") throw new Error(`not re-timed: ${JSON.stringify(r)}`);
    // 56 → 46: the reps first (two to one), then the two blocks share the rest.
    expect(r.write.session.run!.blocks.map((b) => b.intensity ?? null)).toEqual(["easy", "steady", "interval", null, "easy"]);
  });

  it("a single block re-times (it is a structured run: one step on the watch)", () => {
    expect(retimeOfRow({ ...plain, sport: "run" }, [block], 20, ctx)).toMatchObject({ kind: "retimed", minutes: 20, summary: "" });
  });

  it("the rule's refusal and its no-change come through as they are", () => {
    const wu = { ...block, id: "x:0", kind: "warmup", durationSeconds: 600 };
    const cd = { ...block, id: "x:1", ord: 1, kind: "cooldown", durationSeconds: 600 };
    expect(retimeOfRow({ ...plain, sport: "run" }, [wu, cd], 30, ctx)).toMatchObject({ kind: "refused", refusal: "nothing_to_scale" });
    expect(retimeOfRow({ ...plain, sport: "run" }, [block], 30, ctx)).toEqual({ kind: "unchanged", minutes: 30 });
    expect(retimeOfRow({ ...plain, sport: "run" }, [block], 4, ctx)).toMatchObject({ kind: "refused", refusal: "too_short" });
  });
});

describe("a designed run's rows stay in step with what the watch is sent", () => {
  it("the stage rows are the document's: a re-timed run's rows equal a run designed that way", async () => {
    const { db, userId, prefs, today } = await setup({ writes: false });
    const id = await designedRun(db, userId, prefs, today);
    const card = await cardOf(db, id, 40);
    await applyOps(db, userId, prefs, "dp-2", [{ kind: "adjust", workoutId: id, durationMinutes: 40 }], { retimes: new Map([[id, card]]) });
    const twoRounds = tempoDoc();
    twoRounds.parts[1]!.rounds = 2;
    const fresh = (await setup({ writes: false }));
    const other = await designedRun(fresh.db, fresh.userId, fresh.prefs, fresh.today, twoRounds);
    const strip = (rows: Array<typeof plannedWorkoutStages.$inferSelect>, wid: string) =>
      rows.map(({ id: sid, workoutId: _w, parentStageId, ...rest }) => ({ ...rest, id: sid.slice(wid.length), parentStageId: parentStageId?.slice(wid.length) ?? null }));
    expect(strip(await stagesOf(db, id), id)).toEqual(strip(await stagesOf(fresh.db, other), other));
    // Writes off: no create, no rewrite — the new stages only.
    expect(await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.userId, userId)))).toEqual([]);
  });
});
