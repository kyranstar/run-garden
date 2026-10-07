/**
 * THE REVIEW'S BASIS AS A SUMMARY (ruling 2b-R11; audit 2b-B I-3). `GET …/review-basis` used to read every performed
 * session, set and check of the account and fold them all (`Records.baseline` over `loadHistory`, and the graduation
 * basis filtered from the same) — 17 statements and 15 ms with no history, 30 statements (12 on `performed_sets`) and
 * 478 ms at 1,000 sessions, for a ~1.7 KB answer. It now asks the database for the summary itself, the 2a-R6
 * `BuildHistory` way: the records state from one query (bests for the build's moves, the weeks the session can touch,
 * the milestone counters) and the graduation basis from the newest few sessions per lift, read by id.
 *
 *  - the same answer as the whole history: the records state equal to `Records.baseline` over `loadHistory` (but the
 *    milestones only weeks long past could hold), and the review's records and milestones from it identical, at many
 *    days, weekly goals and move sets of seeded histories and of a hand-made one with near-equal weights;
 *  - the graduation basis identical to `graduationSessions` over the whole history;
 *  - its cost flat from 0 to 1,000 sessions: the same statements, and a bounded number of rows handed to the Worker.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adaptiveConfigSchema, addDays, newId, startOfIsoWeek, type UserPreferences } from "@rg/domain";
import { schema } from "@rg/database";
import { EXERCISES, type EngineData } from "@rg/exercise-library";
import { Hist, Records, Rng, type HistorySession, type RecordsState } from "@rg/session-engine";
import { WORLDS, seededHistory, type Seeded } from "../../../packages/session-engine/test/seeded-history.js";
import type { Db } from "../src/services/db.js";
import { buildSession, startSession } from "../src/services/session-build.js";
import { loadHistory } from "../src/services/engine-inputs.js";
import { slotId } from "../src/services/program-slots.js";
import { graduationSessions, loadGraduationSessions, recordsBaseline, reviewBasis } from "../src/services/session-review-basis.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { writeHistory } from "./history-writer.js";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** The state with its lists in a fixed order, and without what only weeks long past could award (never read again). */
function normal(state: RecordsState, date: string): RecordsState {
  const from = addDays(startOfIsoWeek(date), -7);
  const sorted = <T>(byKey: Record<string, T>) => Object.fromEntries(Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b)));
  return {
    ...state,
    awarded: state.awarded.filter((id) => !id.startsWith("all-core-") || id.slice("all-core-".length) >= from).sort(),
    bests: sorted(state.bests),
    weekCounts: sorted(state.weekCounts),
    weekStreaks: sorted(state.weekStreaks),
    weekFamilies: sorted(Object.fromEntries(Object.entries(state.weekFamilies).map(([w, f]) => [w, [...f].sort()]))),
    calm: sorted(state.calm),
  };
}

/** The session the review folds on: a played one, moved to `date` and made the newest. */
const playedOn = (s: HistorySession, date: string): HistorySession => ({ ...s, id: `played-${date}`, date, startedAt: `${date}T23:59:00.000Z` });

interface Account {
  name: string;
  data: EngineData;
  userId: string;
  seeded: Seeded;
  whole: HistorySession[];
}

let db: Db;
const accounts: Account[] = [];

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  for (const [i, world] of WORLDS.entries()) {
    const { userId } = await makeTestUser(db);
    const seeded = seededHistory(world.data, world.renamed, `review-basis|${i}`, i === 0 ? 160 : 110);
    await writeHistory(db, userId, seeded.sessions, `rb${i}`);
    accounts.push({ name: world.name, data: world.data, userId, seeded, whole: await loadHistory(db, userId) });
  }
}, 120_000);

describe("the records state from the database equals Records.baseline over the whole history", () => {
  it("at many days, weekly goals and move sets — and the review's records and milestones from it are the same", async () => {
    let cases = 0;
    let earned = 0;
    for (const a of accounts) {
      const rng = Rng.create(`cases|${a.name}`);
      for (let i = 3; i < a.whole.length + 3; i += 4 + Math.floor(rng() * 5)) {
        const at = a.whole[Math.min(i, a.whole.length - 1)]!;
        const date = addDays(at.date, i >= a.whole.length ? [1, 8, 30][i - a.whole.length]! : Math.floor(rng() * 3));
        // The build's moves: those of a session played that day, and a few more of the library (alternatives).
        const played = a.whole[Math.floor(rng() * a.whole.length)]!;
        const extra = EXERCISES.filter(() => rng() < 0.08).map((e) => e.id);
        const ids = [...new Set([...Hist.idsIn(played), ...extra].map((raw) => Hist.canonical(a.data, raw)))];
        const weeklyGoal = [2, 3, 4][Math.floor(rng() * 3)]!;
        const label = `${a.name} on ${date}, goal ${weeklyGoal}`;
        const full = Records.baseline(a.data, a.whole, { ids, date, weeklyGoal });
        const got = await recordsBaseline(db, a.userId, a.data, { ids, date, weeklyGoal });
        expect(normal(got, date), label).toEqual(normal(full, date));
        // As played, and played stronger (heavier, more reps, longer): what records the review would show.
        const stronger: HistorySession = {
          ...played,
          entries: played.entries.map((e) => ({
            ...e,
            sets: e.sets.map((set) => ({ ...set, w: set.w ? { ...set.w, v: set.w.v + 2 } : null, reps: set.reps === null ? null : set.reps + 2, secs: set.secs === null ? null : set.secs + 10 })),
          })),
        };
        const stored = JSON.parse(JSON.stringify(got)) as RecordsState;
        for (const s of [playedOn(played, date), playedOn(stronger, date)]) {
          const want = Records.forSessionFrom(a.data, full, s);
          expect(Records.forSessionFrom(a.data, stored, s), label).toEqual(want);
          if (want.records.length + want.milestones.length > 0) earned += 1;
        }
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(40);
    expect(earned).toBeGreaterThan(10);
  });

  it("near-equal weights (20 kg and 44 lb), a bell named twice, holds, ladders, a renamed id, calm runs and goal weeks", async () => {
    const data = WORLDS[0]!.data;
    const { userId } = await makeTestUser(db);
    const lift = "gobletSquat";
    const legacy = WORLDS[0]!.renamed.find((r) => r.to === lift)?.from ?? lift;
    const hold = EXERCISES.find((e) => e.dose.type === "time")!.id;
    const day = (n: number) => addDays("2026-06-01", n);
    const session = (n: number, entries: HistorySession["entries"], post: number | null = 1): HistorySession => ({
      id: `h${n}`, date: day(n), startedAt: `${day(n)}T18:00:00.000Z`, mode: "build", theme: "t", blockNumber: n < 20 ? 1 : 2,
      checks: { tmj: { pre: 2, post, feelingOff: false } }, done: [{ id: hold, secs: 30 }], entries,
    });
    const kb = (v: number, u: "kg" | "lb", reps: number) => ({ w: { v, u }, reps, secs: null });
    const entry = (id: string, sets: HistorySession["entries"][number]["sets"], format: HistorySession["entries"][number]["format"] = "straight") => ({
      id, implement: "kettlebell", perSide: false, format, flags: [], sets,
    });
    const sessions = [
      session(0, [entry(lift, [kb(12, "kg", 10)]), entry(hold, [{ w: null, reps: null, secs: 45 }])], 3),
      // 35 lb is 15.88 kg: a new heaviest bell, "bell-16"; then 16 kg, more than 0.05 kg heavier: "bell-16" again.
      session(1, [entry(legacy, [kb(35, "lb", 6)])]),
      session(2, [entry(lift, [kb(16, "kg", 4), kb(16, "kg", 6)])]),
      session(3, [entry(lift, [kb(20, "kg", 5)])]),
      // 44 lb is 19.96 kg and 20.04 kg is 20 kg give or take 0.05: the same weight as 20 kg — more reps at it.
      session(4, [entry(legacy, [kb(44, "lb", 8)])]),
      session(5, [entry(lift, [kb(20.04, "kg", 9), kb(44, "lb", 7)])]),
      // A ladder's rungs say nothing about bests (15 reps at 20 kg would be one).
      session(6, [entry(lift, [kb(20, "kg", 15)], "ladder")]),
      session(7, [entry(lift, [kb(16, "kg", 3)])]),
      ...[8, 9, 10, 11, 12, 15, 16, 17, 22, 23, 24, 25, 29, 30].map((n) => session(n, [entry(lift, [kb(16, "kg", 5)])], n % 5 === 0 ? 3 : 1)),
    ];
    await writeHistory(db, userId, sessions, "edge");
    const whole = await loadHistory(db, userId);
    for (const date of [day(31), day(33), day(40)]) {
      for (const weeklyGoal of [2, 4]) {
        const ids = [lift, hold];
        const full = Records.baseline(data, whole, { ids, date, weeklyGoal });
        const got = await recordsBaseline(db, userId, data, { ids, date, weeklyGoal });
        expect(normal(got, date)).toEqual(normal(full, date));
        expect(got.bests[lift]).toEqual({ kg: 20, w: { v: 20, u: "kg" }, reps: 9, secs: null });
        expect(got.awarded).toEqual(expect.arrayContaining(["bell-16", "bell-20"]));
        const nexts = [
          entry(lift, [kb(20.4, "kg", 4)]), // a new best weight; a new heaviest bell whose "bell-20" was awarded already
          entry(lift, [kb(21, "kg", 2)]),
          entry(lift, [kb(20, "kg", 10)]), // more reps at the best weight
          entry(legacy, [kb(44, "lb", 10)]), // …and at the same weight in pounds
          entry(hold, [{ w: null, reps: null, secs: 50 }]),
        ];
        for (const next of nexts) {
          const s = playedOn(session(41, [next], 0), date);
          const want = Records.forSessionFrom(data, full, s);
          expect(Records.forSessionFrom(data, got, s)).toEqual(want);
        }
      }
    }
  });

  it("is empty for an account with no sessions, as the whole history's is", async () => {
    const { userId } = await makeTestUser(db);
    const data = WORLDS[0]!.data;
    expect(await recordsBaseline(db, userId, data, { ids: ["gobletSquat"], date: "2026-10-01", weeklyGoal: 4 })).toEqual(
      Records.baseline(data, [], { ids: ["gobletSquat"], date: "2026-10-01", weeklyGoal: 4 }),
    );
  });
});

describe("the graduation basis from the database equals graduationSessions over the whole history", () => {
  it("for every block's lifts of the seeded histories", async () => {
    let compared = 0;
    for (const a of accounts) {
      const blocks = [...new Map(a.seeded.blocks.filter((b) => b !== null).map((b) => [JSON.stringify(b!.core), b!])).values()];
      for (const block of blocks) {
        const lifts = Object.values(block.core).filter((x): x is string => !!x);
        const want = graduationSessions(a.data, a.whole, lifts, Hist.TRIM.progressionEntries);
        const got = await loadGraduationSessions(db, a.userId, a.data, lifts, Hist.TRIM.progressionEntries);
        expect(got, `${a.name}: ${lifts.join(", ")}`).toEqual(want);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(2);
  });
});

describe("its cost does not grow with the history (ruling 2b-R11)", () => {
  it("the same statements, and a bounded number of rows, at 0, 100, 400 and 1,000 sessions", async () => {
    const statements: string[] = [];
    let rows = 0;
    const cost = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q), onRows: (_q, n) => (rows += n) });
    const world = WORLDS[0]!;
    const base = seededHistory(world.data, world.renamed, "review-basis|cost", 100).sessions;
    const last = base[base.length - 1]!.date;
    // Older copies of the same history, each 110 days further back.
    const copies = (n: number): HistorySession[] =>
      Array.from({ length: n / 100 }, (_, c) =>
        base.map((s) => ({
          ...s,
          id: `${s.id}-n${n}-c${c}`,
          date: addDays(s.date, -110 * c),
          startedAt: s.startedAt ? new Date(Date.parse(s.startedAt) - 110 * c * 86_400_000).toISOString() : null,
        })),
      ).flat();
    const day = addDays(last, 2);
    const noon = `${day}T19:00:00.000Z`;
    const measured: Array<{ n: number; statements: number; rows: number; ms: number }> = [];
    for (const n of [0, 100, 400, 1000]) {
      const { userId, prefs } = await makeTestUser(cost);
      await writeHistory(cost, userId, copies(n), `cost${n}`);
      const workoutId = await startedSlot(cost, userId, prefs, day, noon);
      // Once to warm SQLite's statement cache and the library index, then measured.
      await reviewBasis(cost, userId, workoutId, { today: day, unit: "lb" });
      statements.length = 0;
      rows = 0;
      const t0 = performance.now();
      await reviewBasis(cost, userId, workoutId, { today: day, unit: "lb" });
      measured.push({ n, statements: statements.length, rows, ms: Math.round(performance.now() - t0) });
    }
    console.log(`review-basis cost: ${measured.map((m) => `${m.n} sessions → ${m.statements} statements, ${m.rows} rows, ${m.ms} ms`).join("; ")}`);
    const [none, hundred, four, thousand] = measured as [(typeof measured)[0], (typeof measured)[0], (typeof measured)[0], (typeof measured)[0]];
    // The statements: the same from the first session on (with none, the by-id reads have nothing to read).
    expect(four.statements).toBe(hundred.statements);
    expect(thousand.statements).toBe(hundred.statements);
    expect(hundred.statements - none.statements).toBeLessThanOrEqual(4);
    // The rows the Worker maps: what the newest weeks and each lift's newest sessions hold, not the history — once each
    // lift has its newest few sessions (by 400 here), more history adds none.
    expect(thousand.rows).toBeLessThanOrEqual(four.rows + 10);
    expect(thousand.rows).toBeLessThan(600);
  });
});

/** A program slot on `day`, built and started (the review basis is asked for at Start). */
async function startedSlot(db: Db, userId: string, prefs: UserPreferences, day: string, noon: string): Promise<string> {
  const programId = newId();
  await db.insert(schema.programs).values({
    id: programId, userId, kind: "adaptive", name: "Program", status: "active", disciplines: ["yoga", "strength"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30, weeklyGoal: 3 }), createdAt: noon, updatedAt: noon, archivedAt: null,
  });
  await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-01-01", settings: {} });
  const id = slotId(programId, day);
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: "Program", category: "yoga", sport: "yoga",
    originalPlanDate: day, lastVerifiedCorosDate: "", effectiveDate: day, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: noon, updatedAt: noon,
  });
  const built = await buildSession(db, userId, id, { overrides: { mode: "build" }, checks: { tmj: { pre: 1, feelingOff: false } } }, { today: day, now: noon, prefs });
  await startSession(db, userId, id, built.build!.buildId, noon);
  return id;
}
