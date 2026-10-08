/**
 * THE PROGRESS TILES' NUMBERS (Phase 2d Task 3; spec §2d "Progress"): the condition trend per switched-on profile,
 * weekly strength volume, and the current block's core lifts — each a MetricResult, from the last eight weeks of
 * logged sessions only.
 *
 * - Parity: over an imported history the weekly volume is the standalone tool's own (the import's oracle), the
 *   pairs and means are the file's, and the core lifts' bests agree with the oracle.
 * - One physical session once: a merged app + watch activity counts the app's sets, never both.
 * - The live account today (watch strength sessions with sets, no app or imported sessions, no checks): honest
 *   tiles, never an error.
 * - Cost: a 200-session history reads what the window holds — the same rows as a 400-session one.
 *
 * `today` is passed explicitly everywhere; nothing here reads the clock.
 */
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, startOfIsoWeek, type UserPreferences } from "@rg/domain";
import { importStandalone, type ImportSummary } from "../src/services/standalone-import.js";
import { ingestActivities } from "../src/services/completion.js";
import { loadProgress } from "../src/services/progress.js";
import { PENDING_HASH } from "../src/services/watch-sets.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { detailOf, workView } from "./watch-sets-fixture.js";
import { backup, entry, history, kg, lb, v2Session } from "./fixtures/standalone-backup.js";

const { conditionChecks, performedSessions, performedSets, programBlocks, userConditions } = schema;

/** The fixture history's last day (a Wednesday): the window is the eight weeks from Monday 2026-08-10. */
const TODAY = "2026-09-30";
const NOW = "2026-09-30T19:00:00.000Z";
const FIRST = addDays(startOfIsoWeek(TODAY), -49);

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
});

const runImport = async (file: unknown, today = TODAY): Promise<ImportSummary> =>
  importStandalone(db, userId, file, { today, now: NOW, timezone: prefs.timezone, dryRun: false });

type FileSession = { date: string; pre?: number | null; post?: number | null };

describe("over an imported history: the standalone tool's own numbers", () => {
  it("weekly volume is the oracle's, week by week; this week's is the last", async () => {
    const summary = await runImport(backup(history()));
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.weightUnit).toBe("lb");
    expect(p.volume.status).toBe("ok");
    if (p.volume.status !== "ok") return;
    // The tool keeps whole kilos (Audit 2c-A MINOR-1); the tile keeps a tenth.
    expect(p.volume.value.weeks.map((w) => ({ week: w.weekStart, kg: Math.round(w.kg) }))).toEqual(summary.oracle.weeklyVolume.map((w) => ({ week: w.week, kg: w.kg })));
    expect(Math.round(p.volume.value.thisWeekKg)).toBe(summary.oracle.weeklyVolume.at(-1)!.kg);
  });

  it("the condition trend: the file's pairs inside the window, their means, labelled by the profile", async () => {
    const file = history() as FileSession[];
    await runImport(backup(file));
    const pairs = file.filter((s) => s.date >= FIRST && s.date <= TODAY && s.pre != null && s.post != null);
    const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.conditions).toHaveLength(1);
    const [tmj] = p.conditions;
    expect(tmj!.profileId).toBe("tmj");
    expect(tmj!.label).toBe("Jaw / head");
    expect(tmj!.trend).toMatchObject({
      status: "ok",
      value: { pairs: pairs.length, preMean: mean(pairs.map((s) => s.pre!)), postMean: mean(pairs.map((s) => s.post!)), flareDays: 0 },
    });
  });

  it("flare days follow the profile's rule over the day's readings — a daily check counts", async () => {
    await runImport(backup(history()));
    for (const [date, value] of [["2026-09-29", 6], ["2026-09-29", 7], ["2026-09-25", 4], ["2026-08-06", 8]] as const) {
      await db.insert(conditionChecks).values({
        id: newId(), userId, profileId: "tmj", kind: "daily", value, feelingOff: false, localDate: date, at: `${date}T15:00:00Z`,
        performedSessionId: null, workoutId: null,
      });
    }
    const p = await loadProgress(db, userId, TODAY, "lb");
    // 09-29 twice is one day; a 4 is not a flare; 08-06 is before the window.
    expect(p.conditions[0]!.trend).toMatchObject({ status: "ok", value: { flareDays: 1 } });
  });

  it("the block's core lifts, in family order: a line where two weeks have a top set, the oracle's best, the unit last used", async () => {
    const summary = await runImport(backup(history()));
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.lifts.map((l) => l.exerciseId)).toEqual(summary.oracle.bestByCoreLift.map((b) => b.exerciseId));
    const byId = new Map(p.lifts.map((l) => [l.exerciseId, l]));
    const squat = byId.get("gobletSquat")!;
    expect(squat.name).toBe("Goblet squat");
    expect(squat.trend).toMatchObject({ status: "ok", value: { unit: "lb" } });
    const oracleBest = (id: string) => summary.oracle.bestByCoreLift.find((b) => b.exerciseId === id)!.best!;
    if (squat.trend.status === "ok") expect(squat.trend.value.best.w).toEqual(oracleBest("gobletSquat").w);
    // Typed in kilograms all along (and once in pounds, before): labelled in kilograms.
    const deadlift = byId.get("deadlift")!;
    expect(deadlift.trend).toMatchObject({ status: "ok", value: { unit: "kg", best: { w: oracleBest("deadlift").w, reps: 8 } } });
    // Never logged: says so — needs two weeks, has none.
    expect(byId.get("floorPress")!.trend).toMatchObject({ status: "insufficient_data", needed: 2, have: 0 });
  });
});

describe("Review Focus 4 and 5 at the service", () => {
  it("one paired check this week: the condition result needs more sessions and carries no trend", async () => {
    await runImport(backup([v2Session("2026-09-29", { pre: 3, post: 1, entries: [entry("gobletSquat", [{ w: lb(25), reps: 8 }])] })]));
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.conditions[0]!.trend).toEqual({ status: "insufficient_data", needed: 4, have: 1, explanation: expect.any(String) });
  });

  it("four pairs: the before mean and the after mean, each from its own check, and a weekly line of both", async () => {
    await runImport(
      backup([
        v2Session("2026-09-08", { pre: 5, post: 1 }),
        v2Session("2026-09-15", { pre: 4, post: 1 }),
        v2Session("2026-09-22", { pre: 3, post: 2 }),
        v2Session("2026-09-29", { pre: 4, post: 0 }),
        v2Session("2026-09-30", { pre: 6, post: null }),
      ]),
    );
    const p = await loadProgress(db, userId, TODAY, "lb");
    const trend = p.conditions[0]!.trend;
    expect(trend).toMatchObject({ status: "ok", value: { pairs: 4, preMean: 4, postMean: 1, flareDays: 2 } });
    if (trend.status === "ok") {
      expect(trend.value.weeks.slice(-4).map((w) => [w.pre, w.post])).toEqual([[5, 1], [4, 1], [3, 2], [4, 0]]);
    }
  });

  it("mixed units for one lift: the line in kilograms, labelled in the unit last used", async () => {
    await runImport(
      backup([
        v2Session("2026-09-14", { entries: [entry("gobletSquat", [{ w: lb(30), reps: 8 }])] }),
        v2Session("2026-09-29", { entries: [entry("gobletSquat", [{ w: kg(14), reps: 8 }])] }),
      ]),
    );
    const p = await loadProgress(db, userId, TODAY, "lb");
    const squat = p.lifts.find((l) => l.exerciseId === "gobletSquat")!;
    expect(squat.trend.status).toBe("ok");
    if (squat.trend.status !== "ok") return;
    expect(squat.trend.value.unit).toBe("kg");
    expect(squat.trend.value.series.map((x) => Number(x.kg.toFixed(2)))).toEqual([13.61, 14]);
    expect(squat.trend.value.best.w).toEqual({ v: 14, u: "kg" });
  });
});

describe("one physical session counts once", () => {
  it("an activity with the app's session and a watch copy beside it counts the app's sets only", async () => {
    const activityId = newId();
    for (const [source, kgs] of [["app", 20], ["watch", 50]] as const) {
      const id = newId();
      await db.insert(performedSessions).values({
        id, userId, activityId, source, localDate: "2026-09-29", payloadHash: "h", createdAt: NOW, updatedAt: NOW,
      });
      await db.insert(performedSets).values({
        id: newId(), performedSessionId: id, entryIndex: 0, exerciseId: "gobletSquat", setIndex: 0,
        reps: 10, loadValue: kgs, loadUnit: "kg", loadKg: kgs, done: true,
      });
    }
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.volume).toMatchObject({ status: "ok", value: { thisWeekKg: 200 }, sampleSize: 1 });
  });

  it("a watch session still being written (pending) is not there yet: it counts nothing (Audit 2d M-2)", async () => {
    const settled = newId();
    const pending = newId();
    for (const [id, hash, kgs] of [[settled, "h", 20], [pending, PENDING_HASH, 50]] as const) {
      await db.insert(performedSessions).values({
        id, userId, activityId: newId(), source: "watch", localDate: "2026-09-29", payloadHash: hash, createdAt: NOW, updatedAt: NOW,
      });
      await db.insert(performedSets).values({
        id: newId(), performedSessionId: id, entryIndex: 0, exerciseId: "gobletSquat", setIndex: 0,
        reps: 10, loadValue: kgs, loadUnit: "kg", loadKg: kgs, done: true,
      });
    }
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.volume).toMatchObject({ status: "ok", value: { thisWeekKg: 200 }, sampleSize: 1 });
  });
});

describe("the live account today: watch strength sessions with sets, nothing from the app, no checks", () => {
  it("weekly volume from the watch's sets; the condition tile honestly empty; no block, no lift tiles — never an error", async () => {
    await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    await ingestActivities(db, {
      userId,
      sources: [
        {
          provider: "coros", providerActivityId: "lbl-lift-1", startTime: "2026-09-29T15:00:00Z", startTimeLocal: "2026-09-29T08:00:00",
          sport: "strength", durationSeconds: 2400, contentFingerprint: "fp",
        },
      ],
      strengthDetailsByProviderId: { "lbl-lift-1": detailOf(workView()) },
    });
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.volume.status).toBe("ok");
    expect(p.conditions).toEqual([
      { profileId: "tmj", label: "Jaw / head", trend: { status: "insufficient_data", needed: 4, have: 0, explanation: expect.any(String) } },
    ]);
    expect(p.lifts).toEqual([]);
  });

  it("a brand-new account: no profile, nothing logged, no program", async () => {
    const p = await loadProgress(db, userId, TODAY, "kg");
    expect(p).toEqual({
      weightUnit: "kg",
      conditions: [],
      volume: { status: "insufficient_data", needed: 1, have: 0, explanation: expect.any(String) },
      lifts: [],
    });
  });

  it("a block whose stored intent is damaged costs the lift tiles, not the page", async () => {
    await runImport(backup(history()));
    await db.update(programBlocks).set({ intent: { core: "not a record" } as unknown as Record<string, unknown> });
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.lifts).toEqual([]);
    expect(p.volume.status).toBe("ok");
  });
});

describe("cost: the window, never the history", () => {
  /** `n` sessions every other day back from TODAY, three logged moves and a before/after check each. */
  function longHistory(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const date = addDays(TODAY, -2 * i);
      return v2Session(date, {
        pre: i % 4,
        post: Math.max(0, (i % 4) - 1),
        entries: [
          entry("gobletSquat", [{ w: lb(20 + (i % 5) * 5), reps: 8 }, { w: lb(20 + (i % 5) * 5), reps: 8 }], { implement: "kettlebell" }),
          entry("supportedRow", [{ w: lb(20), reps: 10 }], { implement: "kettlebell", perSide: true }),
          entry("deadlift", [{ w: kg(16), reps: 6 }], { implement: "kettlebell" }),
        ],
      });
    });
  }

  async function measure(n: number) {
    const rowsByTable = new Map<string, number>();
    let statements = 0;
    let counting = false;
    db = makeTestDb({
      boundVariableCap: 100,
      onStatement: () => {
        if (counting) statements += 1;
      },
      onRows: (sql, rows) => {
        if (!counting) return;
        const table = /from "(\w+)"/i.exec(sql)?.[1] ?? "?";
        rowsByTable.set(table, (rowsByTable.get(table) ?? 0) + rows);
      },
    });
    ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
    await runImport(backup(longHistory(n)));
    counting = true;
    const progress = await loadProgress(db, userId, TODAY, "lb");
    counting = false;
    // JS-side time over the warm path (the database's own work is not the Worker's CPU, but mapping its rows is).
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      await loadProgress(db, userId, TODAY, "lb");
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { progress, statements, rowsByTable, p50: times[7]!, bytes: JSON.stringify(progress).length };
  }

  it("200 sessions read the same rows and statements as 400: only the eight weeks' sessions, sets and checks", async () => {
    const at200 = await measure(200);
    const at400 = await measure(400);
    expect(at400.statements).toBe(at200.statements);
    expect(Object.fromEntries(at400.rowsByTable)).toEqual(Object.fromEntries(at200.rowsByTable));
    // The sessions every other day in the window (Aug 10 – Sep 30), four loaded sets each.
    const windowSessions = longHistory(400).filter((s) => s.date >= FIRST).length;
    expect(at200.rowsByTable.get("performed_sessions")).toBe(windowSessions);
    expect(at200.rowsByTable.get("performed_sets")).toBe(windowSessions * 4);
    expect(at200.statements).toBeLessThanOrEqual(8);
    // The payload the tiles add is small and bounded by the window: 1 profile, 8 weeks, 5 core lifts.
    expect(at200.bytes).toBeLessThan(4_000);
    expect(at400.bytes).toBe(at200.bytes);
    console.info(
      `progress cost — 200 sessions: ${at200.statements} statements, rows ${JSON.stringify(Object.fromEntries(at200.rowsByTable))}, ` +
        `${at200.bytes} bytes, p50 ${at200.p50.toFixed(2)} ms; 400 sessions: p50 ${at400.p50.toFixed(2)} ms`,
    );
  });
});

describe("the bound-variable cap", () => {
  it("a window of more than 90 sessions stays inside D1's 100 binds per statement", async () => {
    // Three sessions a day for five weeks: 105 sessions in the window.
    const file = Array.from({ length: 105 }, (_, i) =>
      v2Session(addDays(TODAY, -Math.floor(i / 3)), { idSuffix: `-${i % 3}`, pre: 2, post: 1, entries: [entry("gobletSquat", [{ w: lb(25), reps: 8 }])] }),
    );
    await runImport(backup(file));
    const p = await loadProgress(db, userId, TODAY, "lb");
    expect(p.volume).toMatchObject({ status: "ok", sampleSize: 105 });
    expect(p.conditions[0]!.trend).toMatchObject({ status: "ok", value: { pairs: 105 } });
    expect(await db.select().from(performedSessions).where(eq(performedSessions.userId, userId))).toHaveLength(105);
  });
});
