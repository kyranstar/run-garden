/**
 * THE BUILD'S HISTORY, IN SQL (ruling 2a-R6). `loadBuildHistory` reads what a build reads — the sessions the engine's
 * `Hist.trim` keeps and `Hist.summarize` of the rest — in four queries, however long the history. Seeded histories
 * (the build differential's: imports, renamed and retired ids, flags, stalls, breaks) are written the way saves write
 * them — sets not done, flags on some sets, a slot's pre-check recorded before the save, a second user — and at many
 * build days and blocks:
 *  - the summary equals the engine's summary of the whole history (`loadHistory`);
 *  - the sessions are whole-history sessions, mapped identically, in the same order, and include every one the trim
 *    keeps;
 *  - the build composed from them is byte-identical to the build composed from the whole history.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { adaptiveConfigSchema, addDays, newId } from "@rg/domain";
import { schema } from "@rg/database";
import { Hist, Rng, type Block, type HistorySession } from "@rg/session-engine";
import { LOCATIONS, WORLDS, seededHistory, type Seeded } from "../../../packages/session-engine/test/seeded-history.js";
import type { Db } from "../src/services/db.js";
import { composeBuild } from "../src/services/session-build.js";
import { loadBuildHistory, loadHistory, type EngineContext } from "../src/services/engine-inputs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NOW = "2026-10-01T00:00:00.000Z";
const world = WORLDS[0]!;

/** A seeded history written as the save writes it, with the odd row a real account has. */
async function write(db: Db, userId: string, sessions: readonly HistorySession[], seed: string): Promise<void> {
  const rng = Rng.create(`write|${seed}`);
  for (const [i, s] of sessions.entries()) {
    const workoutId = rng() < 0.6 ? `w-${seed}-${i % 9}` : null;
    await db.insert(schema.performedSessions).values({
      id: s.id, userId, workoutId, activityId: null, buildId: null, source: s.mode ? "app" : "import", sourceRef: s.mode ? null : `ref-${s.id}`,
      localDate: s.date, startedAt: s.startedAt, endedAt: null, seconds: 1800, plannedSeconds: 1800, minutes: 30,
      mode: s.mode, theme: s.theme, locationId: null, blockRef: null, blockNumber: s.blockNumber, completed: true,
      stepsTotal: null, stepsDone: null, movesDone: s.done.map((m) => ({ exerciseId: m.id, seconds: m.secs })), note: null,
      newMove: null, payloadHash: "h", createdAt: NOW, updatedAt: NOW,
    });
    const sets = s.entries.flatMap((e, entryIndex) => {
      const done = e.sets.map((set, setIndex) => ({ set, setIndex, done: true }));
      // A set skipped at the end, and now and then an entry with nothing done (it is not history).
      const skipped = rng() < 0.15 ? [{ set: e.sets[0]!, setIndex: e.sets.length, done: false }] : [];
      const all = rng() < 0.04 ? done.map((d) => ({ ...d, done: false })) : [...done, ...skipped];
      return all.map(({ set, setIndex, done: isDone }) => ({
        id: newId(), performedSessionId: s.id, entryIndex, exerciseId: e.id, implement: e.implement, format: e.format,
        perSide: e.perSide, setIndex, side: null, reps: set.reps, seconds: set.secs, loadValue: set.w?.v ?? null,
        loadUnit: set.w?.u ?? null, loadKg: null, done: isDone,
        // The entry's flags on its first set only, now and then (an entry's flags are all its sets').
        flags: setIndex === 0 || rng() < 0.5 ? [...e.flags] : [],
      }));
    });
    for (let k = 0; k < sets.length; k += 5) await db.insert(schema.performedSets).values(sets.slice(k, k + 5));
    for (const [profileId, c] of Object.entries(s.checks)) {
      if (c.pre != null || c.feelingOff) {
        // The session sheet's pre-check, recorded for the slot before the save, now and then.
        const sheet = workoutId !== null && rng() < 0.3;
        await db.insert(schema.conditionChecks).values({
          id: newId(), userId, profileId, kind: "pre", value: c.pre, feelingOff: c.feelingOff, localDate: s.date,
          at: `${s.date}T07:00:00.000Z`, performedSessionId: sheet ? null : s.id, workoutId: sheet ? workoutId : null,
        });
      }
      if (c.post != null) {
        await db.insert(schema.conditionChecks).values({
          id: newId(), userId, profileId, kind: "post", value: c.post, feelingOff: false, localDate: s.date,
          at: `${s.date}T20:00:00.000Z`, performedSessionId: s.id, workoutId: null,
        });
      }
    }
    if (rng() < 0.1) {
      await db.insert(schema.conditionChecks).values({
        id: newId(), userId, profileId: "tmj", kind: "daily", value: 3, feelingOff: false, localDate: s.date,
        at: `${s.date}T06:00:00.000Z`, performedSessionId: null, workoutId: null,
      });
    }
  }
}

const context: EngineContext = {
  prefs: { ratings: {}, excluded: [], pinned: [] },
  savedIds: [],
  location: LOCATIONS[0]!,
  locations: LOCATIONS,
  unit: "kg",
  activeProfiles: ["tmj"],
  careProfiles: ["tmj"],
  config: adaptiveConfigSchema.parse({ defaultMinutes: 30, careProfiles: ["tmj"] }),
};

interface Account {
  seed: string;
  userId: string;
  seeded: Seeded;
  whole: HistorySession[];
}

let db: Db;
let statements: string[];
const accounts: Account[] = [];

beforeAll(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  for (const [seed, n] of [["alpha", 200], ["bravo", 120]] as const) {
    const { userId } = await makeTestUser(db);
    const seeded = seededHistory(world.data, world.renamed, `build-history|${seed}`, n);
    await write(db, userId, seeded.sessions, seed);
    accounts.push({ seed, userId, seeded, whole: await loadHistory(db, userId) });
  }
}, 120_000);

describe("loadBuildHistory", () => {
  it("is what the engine trims and summarizes, and builds byte-identically, at many days and blocks", async () => {
    let cases = 0;
    for (const a of accounts) {
      const rng = Rng.create(`cases|${a.seed}`);
      const byId = new Map(a.whole.map((s) => [s.id, s]));
      const order = new Map(a.whole.map((s, i) => [s.id, i]));
      for (let i = 2; i < a.whole.length + 3; i += 6 + Math.floor(rng() * 6)) {
        const last = a.whole[Math.min(i, a.whole.length - 1)]!;
        // Days inside the history (later sessions exist) and after it.
        const date = addDays(last.date, i >= a.whole.length ? [1, 3, 20][i - a.whole.length]! : Math.floor(rng() * 3));
        const stored = a.seeded.blocks[Math.min(i, a.seeded.blocks.length - 1)] ?? null;
        const roll = rng();
        const block: Block | null = roll < 0.15 ? null : roll < 0.25 && stored ? { ...stored, startedAt: addDays(date, -50) } : stored;
        const label = `${a.seed} on ${date}`;

        const got = await loadBuildHistory(db, a.userId, date, block);
        expect(got.summary, `${label}: summary`).toEqual(Hist.summarize(a.whole, date));
        for (const s of got.sessions) expect(s, `${label}: session ${s.id}`).toEqual(byId.get(s.id));
        const ids = got.sessions.map((s) => s.id);
        expect(ids, `${label}: history order`).toEqual([...ids].sort((x, y) => order.get(x)! - order.get(y)!));
        const kept = new Set(ids);
        for (const s of Hist.trim(a.whole, date, block)) expect(kept.has(s.id), `${label}: keeps ${s.id}`).toBe(true);

        const input = { date, programId: `p-${a.seed}`, context, block, checks: { tmj: { pre: Math.floor(rng() * 6), feelingOff: false } }, overrides: rng() < 0.3 ? { minutes: 40 } : {}, swaps: {} };
        const whole = composeBuild({ ...input, history: a.whole });
        const trimmed = composeBuild({ ...input, history: got.sessions, summary: got.summary });
        const json = (c: typeof whole) => JSON.stringify({ build: c.build, view: c.view, blockUpdate: c.blockUpdate, hasCoreLift: c.hasCoreLift });
        expect(json(trimmed) === json(whole), `${label}: the build differs`).toBe(true);
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(30);
  });

  it("reads the facts in one query, then the held sessions by id: a bounded part of a long history", async () => {
    const a = accounts[0]!;
    const date = addDays(a.whole[a.whole.length - 1]!.date, 1);
    const block = a.seeded.blocks[a.seeded.blocks.length - 1] ?? null;
    statements.length = 0;
    const got = await loadBuildHistory(db, a.userId, date, block);
    // The facts; then sessions, sets, their checks and their slots' pre-checks, 90 ids a query.
    expect(statements.length).toBeLessThanOrEqual(1 + 4 * Math.ceil(got.sessions.length / 90));
    // The window's sessions, the last few, and those holding each move's newest entries (this history logs moves
    // from the whole library under two ids each, and the SQL keeps a few more than the trim for safety: a real one keeps
    // far fewer; see the bench).
    expect(got.sessions.length).toBeLessThan(a.whole.length * 0.8);
    expect(got.sessions.length).toBeGreaterThanOrEqual(Hist.trim(a.whole, date, block).length);
  });

  it("keeps the last themed session behind a long run of imports, and a running block's sessions since it started", async () => {
    const { userId } = await makeTestUser(db);
    const T = "2026-09-29";
    const imported = (n: number): HistorySession => ({
      id: `imp${-n}`, date: addDays(T, n), startedAt: null, mode: null, theme: null, blockNumber: null, checks: {},
      done: [{ id: "catCow", secs: 60 }], entries: [],
    });
    const themed: HistorySession = { ...imported(-70), id: "themed", startedAt: `${addDays(T, -70)}T18:00:00.000Z`, mode: "consistent", theme: "hipsPosture" };
    await write(db, userId, [themed, ...[-60, -50, -45, -40, -35, -30, -25, -20].map(imported)], "themed");
    const whole = await loadHistory(db, userId);
    const block: Block = { id: "b", number: 1, startedAt: addDays(T, -41), weeks: 6, core: {}, rotations: [] };
    const got = await loadBuildHistory(db, userId, T, block);
    const ids = got.sessions.map((s) => s.id);
    expect(ids).toContain("themed");
    expect(ids).toEqual(expect.arrayContaining(["imp40", "imp35", "imp30", "imp25", "imp20"]));
    expect(ids).not.toContain("imp50");
    expect(got.summary).toEqual(Hist.summarize(whole, T));
    // No block, nothing in the last 14 days: the last three sessions (and two more) still, and the themed one.
    const unblocked = (await loadBuildHistory(db, userId, T, null)).sessions.map((s) => s.id);
    expect(unblocked).toEqual(["themed", "imp40", "imp35", "imp30", "imp25", "imp20"]);
  });

  it("never mixes two users", async () => {
    const [a, b] = accounts as [Account, Account];
    const date = addDays(a.whole[a.whole.length - 1]!.date, 1);
    const got = await loadBuildHistory(db, a.userId, date, null);
    const theirs = new Set(b.whole.map((s) => s.id));
    expect(got.sessions.some((s) => theirs.has(s.id))).toBe(false);
    expect(got.summary).toEqual(Hist.summarize(a.whole, date));
  });

  it("is empty for an account with no sessions", async () => {
    const { userId } = await makeTestUser(db);
    expect(await loadBuildHistory(db, userId, "2026-10-01", null)).toEqual({ sessions: [], summary: { asOf: "2026-10-01", moves: {} } });
  });
});
