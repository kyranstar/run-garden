/**
 * WHERE THE ATHLETE STANDS (spec 2026-11-05 §7.1–§7.2; principles §6.3 as amended, §12): the facts read in one statement
 * and the measures their key results need; the block every main run opens with, against captured text; and the drift
 * rules. A made-up athlete (Zorbex objectives); every date relative to a fixed day.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, keyResultMeasureSchema, newId, type KeyResultProgress } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import {
  disciplineOf,
  driftNudge,
  driftsOf,
  paceOf,
  readStandFacts,
  standBlock,
  standStatements,
  type StandFacts,
  type StandKeyResult,
  type StandPlanRow,
} from "../src/services/where-you-stand.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const TODAY = "2026-11-05"; // a Thursday
const d = (n: number) => addDays(TODAY, n);

const progress = (current: number | null, evidence: KeyResultProgress["evidence"], series: number[] = current === null ? [] : [current]): KeyResultProgress => ({
  unit: "s",
  current,
  series: series.map((v, i) => ({ date: d(-i - 1), value: v, display: v })),
  lastMeasuredAt: series.length ? d(-1) : null,
  sampleSize: series.length,
  evidence,
  display: { unit: "s", current },
});

const kr = (over: Partial<StandKeyResult>): StandKeyResult => ({
  id: "kr",
  objectiveId: "obj",
  label: "Zorbex hold",
  measure: null,
  direction: "up",
  baseline: null,
  target: null,
  unit: "s",
  due: null,
  createdOn: d(-30),
  progress: null,
  ...over,
});

let rowN = 0;
const row = (date: string, category: string, state: string, over: Partial<StandPlanRow> = {}): StandPlanRow => ({
  id: `w${(rowN += 1)}`,
  date,
  time: "07:00",
  category,
  origin: category === "strength" || category === "yoga" ? "studio" : null,
  state,
  sanctionedBy: null,
  subtype: null,
  sport: category === "strength" ? "strength" : category === "yoga" ? "yoga" : "run",
  seconds: 1800,
  ...over,
});

/** The synthetic athlete the captured block is read for. */
function athlete(): StandFacts {
  rowN = 0;
  const health = Array.from({ length: 14 }, (_, i) => {
    const date = d(-i);
    const hrv7 = [63, 62, 60, 61, null, 58, 55]; // today first
    const rhr7 = [49, 50, 50, 51, null, 51, 52];
    return { date, hrv: i < 7 ? hrv7[i]! : 58, restingHeartRate: i < 7 ? rhr7[i]! : 51, recoveryScore: null, sleepHrvBase: null, sleepHrvSd: null };
  });
  return {
    today: TODAY,
    objectives: [
      {
        id: "obj-ski",
        keyResults: [
          kr({ id: "kr-hold", objectiveId: "obj-ski", label: "Wall sit hold", baseline: 60, target: 120, due: d(20), createdOn: d(-30), progress: progress(75, "measured", [70, 72, 75]) }),
          kr({ id: "kr-5k", objectiveId: "obj-ski", label: "5K time", direction: "down", baseline: 1500, target: 1380, due: "2027-02-01", createdOn: "2026-09-01", progress: progress(1450, "sparse") }),
        ],
      },
      { id: "obj-calm", keyResults: [kr({ id: "kr-energy", objectiveId: "obj-calm", label: "Energy", unit: "score", target: 8, createdOn: d(-35), progress: { ...progress(6.5, "measured", [6, 6.5, 6.5]), unit: "score" } })] },
    ],
    plan: [
      // Strength: 14 d — 1 done, 1 missed, 1 skipped, 1 not known; one more done in the 21 days; one in the 4 weeks.
      row(d(-1), "strength", "completed"),
      row(d(-3), "strength", "unresolved"),
      row(d(-6), "strength", "skipped"),
      row(d(-9), "strength", "missed"),
      row(d(-16), "strength", "completed"),
      row(d(-23), "strength", "completed"),
      // Not planned work: the coach's own skip, a rest day.
      row(d(-8), "strength", "skipped", { sanctionedBy: "coach" }),
      row(d(-10), "rest", "scheduled"),
      // Runs: all done in 14 d; one the athlete missed in the 4 weeks.
      row(d(-2), "easy", "completed"),
      row(d(-5), "long", "completed", { seconds: 5400 }),
      row(d(-7), "easy", "completed"),
      row(d(-12), "quality", "completed", { subtype: "tempo" }),
      row(d(-19), "easy", "completed"),
      row(d(-26), "easy", "missed"),
      // Mobility and care.
      row(d(-4), "yoga", "completed"),
      row(d(-11), "yoga", "completed"),
      // The next 14 days.
      row(d(0), "easy", "scheduled", { time: "18:00", seconds: 2400 }),
      row(d(0), "strength", "scheduled"),
      row(d(1), "rest", "scheduled", { seconds: 0 }),
      row(d(2), "long", "scheduled", { seconds: 5400 }),
      row(d(5), "quality", "scheduled", { subtype: "tempo", seconds: 3000 }),
      row(d(7), "strength", "scheduled"),
      row(d(9), "yoga", "scheduled", { origin: null, seconds: 3600 }),
    ],
    unplanned: [{ date: d(-4), discipline: "runs" }],
    health,
    sleep: Array.from({ length: 7 }, (_, i) => ({ date: d(-i), seconds: i === 6 ? 6.5 * 3600 : i === 4 ? 7.5 * 3600 : 7 * 3600 })),
    review: { weekStart: "2026-10-26", narrative: "Solid week: three runs and two lifts. Next week, add a mobility session." },
    reads: [{ date: d(-2), sport: "run", seconds: 2520, flags: ["hr_drift"], glance: "Heart rate crept up in the last third." }],
    beyondCore: { note: 3, observation: 2 },
    conclusions: [],
  };
}

const EMPTY: StandFacts = { today: TODAY, objectives: [], plan: [], unplanned: [], health: [], sleep: [], review: null, reads: [], beyondCore: {}, conclusions: [] };

const U = (from: string, text: string) => `<untrusted from="${from}">${text}</untrusted>`;

const CAPTURED = [
  "# Where you stand (the app's own figures)",
  "Objectives — current → target by due: pace:",
  `- obj-ski: ${U("athlete", "Wall sit hold")} 75 s → 120 s by 2026-11-25: behind (25% there, 60% of time gone)`,
  `- obj-ski: ${U("athlete", "5K time")} 24:10 (few readings) → 23:00 by 2027-02-01: on track (42% there, 42% of time gone)`,
  `- obj-calm: ${U("athlete", "Energy")} 6.5 → 8: no data (no due date)`,
  "Planned → done, last 14 d | 4 wk (missed · skipped · not known):",
  "- runs 4/4 | 5/6 (0·0·0 | 1·0·0), +1 off the plan in 4 wk",
  "- strength 1/4 | 3/6 (1·1·1 | 1·1·1)",
  "- mobility and care 2/2 | 2/2",
  "Next 14 days (a day not listed: nothing planned):",
  "Thu 5 Nov: strength 30 min; easy run 40 min",
  "Fri 6 Nov: rest",
  "Sat 7 Nov: long run 90 min",
  "Tue 10 Nov: tempo 50 min",
  "Thu 12 Nov: strength 30 min",
  "Sat 14 Nov: yoga 60 min",
  "Readiness: good. Last 7 d, oldest first — HRV 55 58 – 61 60 62 63 (usual 58, rising) · resting HR 52 51 – 51 50 50 49 (usual 51, falling) · sleep 7.0 h a night (6.5–7.5)",
  `Last weekly review (week of Mon 26 Oct): ${U("coach read", "Solid week: three runs and two lifts.")}`,
  "Activity reads flagged in 7 d:",
  `- Tue 3 Nov run 42 min — hr_drift: ${U("coach read", "Heart rate crept up in the last third.")}`,
  "Memory beyond the core: 3 notes, 2 observations (recall_memory).",
  "Needs you (each a chip on Today and in the coach):",
  "- 2 of 5 planned lifts logged in 3 weeks (drift:discipline:strength)",
  `- ${U("athlete", "Wall sit hold")} is behind pace with 3 weeks left (drift:key_result:kr-hold)`,
].join("\n");

const CAPTURED_EMPTY = [
  "# Where you stand (the app's own figures)",
  "Objectives: none active.",
  "Planned → done: nothing planned in the last 4 weeks.",
  "Next 14 days: nothing planned.",
  "Readiness: no verdict (too little data). Last 7 d: no HRV, resting HR or sleep recorded.",
  "Last weekly review: none yet.",
  "Activity reads flagged in 7 d: none.",
  "Memory beyond the core: none.",
  "Needs you: nothing the app sees.",
].join("\n");

describe("the rules, pure", () => {
  it("a planned row's discipline: runs, strength, the app's yoga kind as mobility and care, an import's as yoga; rest and cross-training none", () => {
    for (const c of ["recovery", "easy", "long", "quality", "race", "unknown"]) expect(disciplineOf({ category: c, origin: null })).toBe("runs");
    expect(disciplineOf({ category: "strength", origin: "program" })).toBe("strength");
    expect(disciplineOf({ category: "yoga", origin: "studio" })).toBe("mobility and care");
    expect(disciplineOf({ category: "yoga", origin: "program" })).toBe("mobility and care");
    expect(disciplineOf({ category: "yoga", origin: null })).toBe("yoga");
    expect(disciplineOf({ category: "rest", origin: null })).toBeNull();
    expect(disciplineOf({ category: "cross_training", origin: null })).toBeNull();
  });

  it("pace: behind, on track, ahead, reached, and no data with its reason — never a division by zero", () => {
    const up = { direction: "up" as const, start: 60, target: 120, startDate: d(-40), due: d(30) };
    expect(paceOf(up, 75, TODAY)).toEqual({ pace: "behind", done: 0.25, elapsed: 40 / 70 });
    expect(paceOf(up, 95, TODAY).pace).toBe("on track");
    expect(paceOf(up, 110, TODAY).pace).toBe("ahead");
    expect(paceOf(up, 120, TODAY).pace).toBe("reached");
    expect(paceOf({ ...up, direction: "down", start: 1500, target: 1380 }, 1440, TODAY).pace).toBe("on track");
    expect(paceOf({ ...up, due: d(-1) }, 100, TODAY).pace).toBe("behind");
    expect(paceOf(up, null, TODAY)).toEqual({ pace: "no data", why: "nothing measured" });
    expect(paceOf({ ...up, target: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no target" });
    expect(paceOf({ ...up, due: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no due date" });
    expect(paceOf({ ...up, start: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no starting value" });
    expect(paceOf({ ...up, target: 60 }, 80, TODAY)).toEqual({ pace: "reached", done: 1, elapsed: 40 / 70 });
    expect(paceOf({ ...up, target: 60, start: 60 }, 50, TODAY)).toEqual({ pace: "no data", why: "the target is the start" });
  });
});

describe("the block, against captured text", () => {
  it("reads for the synthetic athlete exactly as captured, within about 1,500 characters", () => {
    const f = athlete();
    const block = standBlock(f, driftsOf(f));
    expect(block).toBe(CAPTURED);
    // About 1,500 (spec §7.1): measured 1,580 — five marked texts are 190 of it.
    expect(block.length).toBeLessThanOrEqual(1600);
  });

  it("an empty account: every part in a few words, no drift", () => {
    expect(driftsOf(EMPTY)).toEqual([]);
    expect(standBlock(EMPTY, [])).toBe(CAPTURED_EMPTY);
  });

  it("a rich account stays bounded: three key-result lines and a pointer, two reads and a pointer, three moves a day, a long review cut at a word", () => {
    const f = athlete();
    f.objectives = Array.from({ length: 12 }, (_, o) => ({
      id: `obj-${o}`,
      keyResults: Array.from({ length: 10 }, (_, k) => kr({ id: `kr-${o}-${k}`, objectiveId: `obj-${o}`, label: `Zorbex key result number ${k} of a long label`, target: 100 })),
    }));
    f.reads = Array.from({ length: 3 }, (_, i) => ({ date: d(-i), sport: "run", seconds: 1800, flags: ["strain_high", "hr_drift"], glance: "A very long glance ".repeat(20) }));
    f.review = { weekStart: "2026-10-26", narrative: `${"A long first sentence that goes on ".repeat(10)}. Then more.` };
    f.plan.push(...Array.from({ length: 5 }, () => row(d(3), "strength", "scheduled")));
    const block = standBlock(f, driftsOf(f));
    expect(block).toContain("- and 117 more key results (read_objectives)");
    expect(block).toContain("and 1 more (read_history)");
    expect(block).toContain("Sun 8 Nov: strength 30 min; strength 30 min; strength 30 min; +2");
    expect(block.match(/Zorbex key result/g)).toHaveLength(3);
    expect(block).toMatch(/A long first sentence[^\n]{0,120}…<\/untrusted>/);
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});

describe("drift (§7.2)", () => {
  const strength = (planned: number, done: number, from = -2): StandPlanRow[] =>
    Array.from({ length: planned }, (_, i) => row(d(from - i), "strength", i < done ? "completed" : "skipped"));
  const only = (plan: StandPlanRow[], over: Partial<StandFacts> = {}): StandFacts => ({ ...EMPTY, plan, ...over });

  it("a discipline under half its planned sessions over 3 weeks (at least 3 planned) — at its edge", () => {
    expect(driftsOf(only(strength(4, 1))).map((x) => x.observation)).toEqual(["1 of 4 planned lifts logged in 3 weeks"]);
    expect(driftsOf(only(strength(4, 2)))).toEqual([]);
    expect(driftsOf(only(strength(3, 1)))[0]).toMatchObject({ id: "drift:discipline:strength", rule: "discipline" });
    // Older than 3 weeks: not counted.
    expect(driftsOf(only(strength(4, 0, -22)))).toEqual([]);
  });

  it("none of a planned discipline in 3 weeks — unless it was done off the plan", () => {
    expect(driftsOf(only([row(d(-3), "yoga", "skipped", { origin: null })]))).toMatchObject([
      { id: "drift:none:yoga", rule: "none", observation: "No yoga sessions logged in 3 weeks, with 1 planned" },
    ]);
    expect(driftsOf(only([row(d(-3), "strength", "unresolved"), row(d(-5), "strength", "missed")], { unplanned: [{ date: d(-4), discipline: "strength" }] }))).toEqual([]);
  });

  it("3 or more sessions missed or not logged in 2 weeks: said as not logged, never as missed", () => {
    const plan = [row(d(-1), "easy", "unresolved"), row(d(-4), "easy", "unresolved"), row(d(-13), "long", "missed"), row(d(-2), "easy", "completed"), row(d(-3), "easy", "completed"), row(d(-6), "easy", "completed")];
    const [x] = driftsOf(only(plan));
    expect(x).toMatchObject({ id: "drift:missed", rule: "missed", observation: "3 sessions not logged in 2 weeks" });
    expect(driftsOf(only(plan.slice(1)))).toEqual([]);
  });

  it("a key result behind pace by more than a quarter with under half its time left", () => {
    const k = (current: number, due: number) => ({
      ...EMPTY,
      objectives: [{ id: "o", keyResults: [kr({ id: "k1", label: "Zorbex plank", baseline: 60, target: 120, createdOn: d(-30), due: d(due), progress: progress(current, "measured") })] }],
    });
    // 60% of the time gone, a quarter there: 0.35 behind.
    expect(driftsOf(k(75, 20))).toMatchObject([{ id: "drift:key_result:k1", rule: "key_result", observation: "Zorbex plank is behind pace with 3 weeks left" }]);
    expect(driftsOf(k(75, 10))[0]!.observation).toBe("Zorbex plank is behind pace with 10 days left");
    // Behind, but half its time still ahead.
    expect(driftsOf(k(61, 31))).toEqual([]);
    // Under half its time left, behind by less than a quarter.
    expect(driftsOf(k(86, 20))).toEqual([]);
  });

  it("the most pressing first: the lowest share of a discipline, then not logged, then key results", () => {
    const plan = [...strength(4, 1), row(d(-2), "yoga", "skipped", { origin: null }), row(d(-1), "easy", "unresolved"), row(d(-4), "easy", "unresolved"), row(d(-6), "easy", "unresolved")];
    // Runs 0 of 3 and yoga 0 of 1 share the lowest share: the discipline's order breaks the tie.
    expect(driftsOf(only(plan)).map((x) => x.id)).toEqual(["drift:discipline:runs", "drift:none:yoga", "drift:discipline:strength", "drift:missed"]);
  });

  it("a conclusion with a check-back after today holds the drift; on the check-back day it comes back, with what was concluded", () => {
    const held = only(strength(4, 1), { conclusions: [{ id: "mem:r:1", drift: "drift:discipline:strength", checkBack: d(1), at: `${d(-6)}T09:00:00.000Z` }] });
    const [x] = driftsOf(held);
    expect(x!.held).toEqual({ until: d(1), memoryId: "mem:r:1", at: d(-6) });
    expect(standBlock(held, [x!])).toContain(`- 1 of 4 planned lifts logged in 3 weeks (drift:discipline:strength) — talked through ${d(-6)}, held until ${d(1)} (mem:r:1)`);
    const due = only(strength(4, 1), { conclusions: [{ id: "mem:r:1", drift: "drift:discipline:strength", checkBack: TODAY, at: `${d(-6)}T09:00:00.000Z` }] });
    const [y] = driftsOf(due);
    expect(y!.held).toBeNull();
    expect(y!.since).toEqual({ at: d(-6), memoryId: "mem:r:1" });
    expect(standBlock(due, [y!])).toContain(`(drift:discipline:strength) — talked through ${d(-6)} (mem:r:1): check back now`);
  });

  it("a chip: an observation and a question; its request the athlete's words", () => {
    const [x] = driftsOf(only(strength(4, 1)));
    expect(driftNudge(x!)).toEqual({
      id: "drift:discipline:strength",
      label: "1 of 4 planned lifts logged in 3 weeks — talk it through?",
      request: "1 of 4 planned lifts logged in 3 weeks — let's talk it through.",
    });
  });
});

// ── The read ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("readStandFacts: one statement and the measures its key results need", () => {
  let db: Db;
  let userId: string;
  let other: string;
  let statements: string[];
  const at = (date: string, hhmm = "12:00") => `${date}T${hhmm}:00.000Z`;

  const planned = (id: string, date: string, category: string, state: string, over: Record<string, unknown> = {}, owner = userId) =>
    db.insert(schema.plannedWorkouts).values({
      id,
      userId: owner,
      planId: "p",
      sourceWorkoutId: `src-${id}`,
      title: "PLAN-TITLE-SENTINEL",
      category,
      sport: category === "strength" ? "strength" : "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState: state,
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1800,
      createdAt: at(date),
      updatedAt: at(date),
      ...over,
    });
  const activity = (id: string, date: string, seconds: number, over: Record<string, unknown> = {}) =>
    db.insert(schema.activities).values({
      id,
      userId,
      startTime: `${date}T15:00:00Z`,
      startTimeLocal: `${date}T08:00:00`,
      sport: "run",
      durationSeconds: seconds,
      sourceMergeConfidence: 1,
      createdAt: at(date),
      updatedAt: at(date),
      ...over,
    });
  const memory = (id: string, kind: string, over: Record<string, unknown> = {}) =>
    db.insert(schema.coachMemory).values({
      id,
      userId,
      kind,
      body: "MEMORY-NOTE-SENTINEL",
      provenance: { source: "coach_inference", at: at(d(-3)) },
      learnedAt: at(d(-3)),
      active: true,
      pinned: false,
      confidence: "inferred",
      ...over,
    });

  beforeEach(async () => {
    statements = [];
    db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
    ({ userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
    ({ userId: other } = await makeTestUser(db));
    await planned("s1", d(-1), "strength", "completed", { origin: "studio" });
    await planned("s2", d(-3), "strength", "unresolved", { origin: "studio" });
    await planned("s3", d(-8), "strength", "skipped", { origin: "studio", sanctionedBy: "coach" });
    await planned("s4", d(-2), "strength", "missed", { origin: "studio", archivedAt: at(d(-1)) });
    await planned("r1", d(0), "easy", "scheduled");
    await planned("r2", d(13), "long", "scheduled");
    await planned("r3", d(14), "long", "scheduled");
    await planned("r4", d(-29), "easy", "missed");
    await planned("x1", d(-1), "strength", "missed", {}, other);
    // Off the plan: a run of 40 minutes; a 3-minute walk; a run that completed a planned one.
    await activity("a1", d(-4), 2400);
    await activity("a2", d(-4), 180);
    await db.insert(schema.workoutCompletionMatches).values({ id: "m1", userId, activityId: "a3", workoutId: "r4", confidence: 1, method: "scored_auto", matchedAt: at(d(-6)) } as never);
    await activity("a3", d(-6), 2400, { completionMatchId: "m1" });
    await db.insert(schema.dailyHealth).values([
      { id: `${userId}:1`, userId, date: d(-1), hrv: 61.4, restingHeartRate: 50.2, contentFingerprint: "f", updatedAt: at(d(-1)) },
      { id: `${userId}:20`, userId, date: d(-20), hrv: 40, contentFingerprint: "f", updatedAt: at(d(-20)) },
    ]);
    await db.insert(schema.sleepRecords).values({ id: `${userId}:s`, userId, date: d(-1), durationSeconds: 25200, contentFingerprint: "f", updatedAt: at(d(-1)) } as never);
    await db.insert(schema.weeklyReviews).values([
      { id: "wr1", userId, weekStart: "2026-10-19", facts: {}, narrative: "Older review.", createdAt: at("2026-10-27") },
      { id: "wr2", userId, weekStart: "2026-10-26", facts: {}, narrative: "Newest review. More.", createdAt: at("2026-11-03") },
    ]);
    await db.insert(schema.coachReads).values([
      { id: "cr1", userId, activityId: "a1", status: "done", nextAttemptAt: at(d(-4)), glance: "Flagged glance.", flags: ["hr_drift"], createdAt: at(d(-4)) },
      { id: "cr2", userId, activityId: "a3", status: "done", nextAttemptAt: at(d(-6)), glance: "Quiet glance.", flags: [], createdAt: at(d(-6)) },
    ]);
    await memory("core-fact", "fact");
    await memory("beyond-note", "note", { expiresAt: d(30) });
    await memory("beyond-obs-1", "observation");
    await memory("beyond-obs-2", "observation");
    await memory("rehearsal", "observation", { provenance: { source: "coach_inference", at: at(d(-3)), rehearsal: true } });
    await memory("conclusion", "rule", { pinned: true, provenance: { source: "coach_inference", at: at(d(-3)), runId: "r", drift: "drift:discipline:strength", checkBack: d(10) } });
    await db.insert(schema.objectives).values({ id: "o1", userId, title: "Zorbex calm", status: "active", goalIds: [], sort: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) });
    await db.insert(schema.objectives).values({ id: "o2", userId, title: "Zorbex paused", status: "paused", goalIds: [], sort: 1, createdAt: at(d(-40)), updatedAt: at(d(-40)) });
    await db.insert(schema.keyResults).values([
      { id: "k1", userId, objectiveId: "o1", label: "Energy", measure: { kind: "checkin", questionId: "energy" }, direction: "up", target: 8, unit: "score", position: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) },
      { id: "k2", userId, objectiveId: "o2", label: "Paused", measure: { kind: "threshold_pace", windowDays: 90 }, direction: "down", unit: "s/km", position: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) },
    ]);
    await db.insert(schema.athleteAnswers).values({ id: "an1", userId, questionId: "energy", valueNum: 6, source: "checkin", localDate: d(-2), at: at(d(-2)) });
  });

  it("reads the facts, the athlete's only, and spends exactly what standStatements says", async () => {
    statements.length = 0;
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "America/Los_Angeles" });
    expect(statements.length).toBe(standStatements([keyResultMeasureSchema.parse({ kind: "checkin", questionId: "energy" })]));
    expect(statements.length).toBe(2);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(f.plan.map((p) => p.id).sort()).toEqual(["r1", "r2", "s1", "s2", "s3"]);
    expect(f.unplanned).toEqual([{ date: d(-4), discipline: "runs" }]);
    expect(f.health.map((h) => h.date)).toEqual([d(-1)]);
    expect(f.sleep).toEqual([{ date: d(-1), seconds: 25200 }]);
    expect(f.review).toEqual({ weekStart: "2026-10-26", narrative: "Newest review. More." });
    expect(f.reads).toEqual([{ date: d(-4), sport: "run", seconds: 2400, flags: ["hr_drift"], glance: "Flagged glance." }]);
    expect(f.beyondCore).toEqual({ note: 1, observation: 2 });
    expect(f.conclusions).toEqual([{ id: "conclusion", drift: "drift:discipline:strength", checkBack: d(10), at: at(d(-3)) }]);
    expect(f.objectives).toHaveLength(1);
    expect(f.objectives[0]!.keyResults[0]).toMatchObject({ id: "k1", label: "Energy", target: 8, createdOn: d(-40), progress: { current: 6 } });
    expect(JSON.stringify(f)).not.toContain("PLAN-TITLE-SENTINEL");
    expect(JSON.stringify(f)).not.toContain("MEMORY-NOTE-SENTINEL");
  });

  it("an empty account: one statement, nothing measured", async () => {
    const { userId: empty } = await makeTestUser(db);
    statements.length = 0;
    const f = await readStandFacts(db, empty, { today: TODAY, tz: "UTC" });
    expect(statements.length).toBe(1);
    expect(standStatements([])).toBe(1);
    expect(f).toMatchObject({ objectives: [], plan: [], unplanned: [], health: [], sleep: [], review: null, reads: [], beyondCore: {}, conclusions: [] });
  });

  it("a key result whose measure no longer reads: no data, never a throw", async () => {
    await db.insert(schema.keyResults).values({ id: newId(), userId, objectiveId: "o1", label: "Broken", measure: { kind: "nope" }, direction: "up", unit: "s", position: 1, createdAt: at(d(-1)), updatedAt: at(d(-1)) });
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "UTC" });
    expect(f.objectives[0]!.keyResults[1]).toMatchObject({ label: "Broken", measure: null, progress: null });
  });
});
