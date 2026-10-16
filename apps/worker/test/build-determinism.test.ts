/**
 * THE BUILD, BYTE FOR BYTE (the session-build CPU pass, 2026-10-15). A change made only to make a build cheaper — the
 * engine's caches, the worker's read of the history — must not change one byte of what a build makes. These digests
 * were recorded from the code before such a change, over many seeded builds, and the builds made now must match them
 * exactly:
 *  - the worker's build (`composeBuild`: the proposal, block upkeep, the plan with its alternatives, the payload and
 *    the view) for 200 programmes, each on several days of a seeded history (the build differential's: imports,
 *    renamed and retired ids, flags, stalls, breaks), from the trimmed sessions and the summary as the worker passes
 *    them, with varied places, prefs, saved moves, profiles, modes, checks, overrides and swaps;
 *  - the engine's own plan on every other one of those days (`Planner.planToday`, every slot's swap pool included);
 *  - the history a build reads from the database (`loadBuildHistory`) and the build made from it, at many days and
 *    blocks, over rows written the way saves write them (sides, loads, skipped sets, flags, sheet and daily checks, a
 *    session still being written, a second account);
 *  - whole build requests (`buildSession`): the inputs hash, version and payload each one stores.
 * The digests answer for one library. When the library changes (its fingerprint below), any build may change: the
 * check then skips and says so until they are recorded again (`UPDATE_BUILD_DIGESTS=1`). A change to the engine's
 * rules changes them on purpose: record them again with that change, never to make a cheaper build pass.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adaptiveConfigSchema, addDays } from "@rg/domain";
import { schema } from "@rg/database";
import { CORE_FAMILIES, COVERAGE_TARGETS, EXERCISES, FORMATS, MODES, PROFILES, SKELETON, THEMES } from "@rg/exercise-library";
import { Hist, Planner, Rng, type Block, type DayState, type HistorySession, type Mode, type ProgramState } from "@rg/session-engine";
import { LOCATIONS, WORLDS, seededHistory, type Seeded } from "../../../packages/session-engine/test/seeded-history.js";
import type { Db } from "../src/services/db.js";
import { buildSession, composeBuild, type BuildContext, type ComposeInput } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { loadBuildHistory, rowsOf } from "../src/services/engine-inputs.js";
import { PENDING_HASH } from "../src/services/watch-sets.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

// Hundreds of builds from seeded histories: slow on a loaded runner. A per-file timeout, not a cost question.
vi.setConfig({ testTimeout: 300_000 });

const DIGESTS = join(__dirname, "build-determinism.digests.json");
const UPDATE = process.env.UPDATE_BUILD_DIGESTS === "1";
const PROGRAMMES = 200;
const DAYS_PER_PROGRAMME = 4;

interface Recorded {
  /** The library the digests answer for (`libraryFingerprint`). */
  library: string;
  /** Per programme: its builds' digest. */
  programmes: string[];
  /** The database reads and the builds made from them, per account. */
  reads: string[];
  /** The stored builds of whole requests. */
  requests: string;
}

/** The library data a build reads, fingerprinted as the stored build's engine version fingerprints it. */
const libraryFingerprint = (): string =>
  sha256(JSON.stringify({ EXERCISES, THEMES, FORMATS, MODES, CORE_FAMILIES, COVERAGE_TARGETS, SKELETON, PROFILES })).slice(0, 12);

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const short = (s: string): string => sha256(s).slice(0, 16);
/** JSON with Maps and Sets as their entries (the engine's own output holds none, but say so if it ever does). */
const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Map ? ["Map", ...x] : x instanceof Set ? ["Set", ...x] : x));

// ── Seeded programmes ───────────────────────────────────────────────────────────────────────────────────────────

const ALL_MODES: Mode[] = ["recovery", "consistent", "build"];
const MODE_SETS: Mode[][] = [ALL_MODES, ["consistent", "build"], ["recovery", "consistent"], ["consistent"], ["build"]];

/** Each world's seeded histories (the build differential's, shorter). */
function histories(): Array<{ world: (typeof WORLDS)[number]; seed: string; seeded: Seeded }> {
  return WORLDS.flatMap((world) =>
    ["delta", "echo", "foxtrot"].map((seed, i) => ({ world, seed, seeded: seededHistory(world.data, world.renamed, `determinism|${world.name}|${seed}`, [90, 120, 150][i]!) })),
  );
}

/** One programme's builds as JSON lines: its days, each as the worker composes it, and the engine's own plan. */
function programmeBuilds(p: number, h: ReturnType<typeof histories>[number]): string[] {
  const rng = Rng.create(`programme|${p}`);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const { world, seeded } = h;
  const profiled = world.name !== "no profile";
  const care = profiled && rng() < 0.75 ? ["tmj"] : [];
  const locations = rng() < 0.2 ? [LOCATIONS[1]!, LOCATIONS[2]!] : [...LOCATIONS];
  const context: BuildContext = {
    prefs: rng() < 0.5 ? seeded.prefs : { ratings: {}, excluded: [], pinned: [] },
    savedIds: rng() < 0.3 ? world.data.exercises.filter((_, i) => i % 7 === p % 7).map((e) => e.id) : [],
    location: pick(locations),
    locations,
    unit: rng() < 0.5 ? "lb" : "kg",
    activeProfiles: profiled ? ["tmj"] : [],
    careProfiles: care,
    config: {
      weeklyGoal: 2 + Math.floor(rng() * 4),
      blockWeeks: 4 + Math.floor(rng() * 3),
      defaultMinutes: pick([15, 20, 30, 40, 45, 60]),
      modes: pick(MODE_SETS),
    },
  };
  const programId = `programme-${p}`;
  const out: string[] = [];
  const sessions = seeded.sessions;
  for (let d = 0; d < DAYS_PER_PROGRAMME; d++) {
    const cut = Math.min(sessions.length, 2 + Math.floor(rng() * sessions.length));
    const last = sessions[cut - 1]!;
    const date = addDays(last.date, pick([0, 1, 1, 2, 3, 6, 15, 45]));
    const whole = sessions.slice(0, cut);
    const stored = seeded.blocks[Math.min(cut, seeded.blocks.length - 1)] ?? null;
    const roll = rng();
    const block: Block | null = roll < 0.12 ? null : roll < 0.2 && stored ? { ...stored, startedAt: addDays(date, -55) } : stored;
    const pre = rng() < 0.15 ? null : Math.floor(rng() * 8);
    const checks: ComposeInput["checks"] = profiled && rng() < 0.85 ? { tmj: { pre, feelingOff: rng() < 0.05 } } : {};
    const overrides: ComposeInput["overrides"] = {};
    if (rng() < 0.25) overrides.mode = pick(ALL_MODES);
    if (rng() < 0.15) overrides.theme = pick(world.data.themes).id;
    if (rng() < 0.35) overrides.minutes = pick([10, 15, 25, 30, 40, 60, 90]);
    const input: ComposeInput = {
      date, programId, context, block, history: Hist.trim(whole, date, block), summary: Hist.summarize(whole, date),
      checks, overrides, swaps: {},
    };
    const built = composeBuild(input);
    out.push(json(built));
    // Swaps taken from the offered alternatives (and a stale one), in the order made.
    const slots = Object.entries(built.build.alternatives).filter(([, alts]) => alts.length);
    if (slots.length && rng() < 0.4) {
      const swaps: Record<string, { from: string; to: string }> = {};
      for (const [slotKey, alts] of slots.filter(() => rng() < 0.4).slice(0, 3)) {
        const from = built.build.items.find((it) => it.slotKey === slotKey)!.exerciseId;
        swaps[slotKey] = { from, to: pick(alts).id };
      }
      if (rng() < 0.3) swaps["prep:0"] = { from: "not-in-the-slot", to: world.data.exercises[0]!.id };
      out.push(json(composeBuild({ ...input, swaps })));
    }
    if (d % 2 === 0) {
      // The engine's own plan, with every slot's swap pool, from the world's library.
      const program: ProgramState = {
        programId,
        settings: { unit: context.unit, weeklyGoal: context.config.weeklyGoal, blockWeeks: context.config.blockWeeks, defaultMinutes: context.config.defaultMinutes, location: context.location.id },
        locations: context.locations, prefs: context.prefs, savedIds: context.savedIds, block,
        sessions: input.history, summary: input.summary!,
      };
      const day: DayState = {
        date, checks: profiled ? { tmj: { pre, post: null, feelingOff: false } } : {}, feelingOff: rng() < 0.04,
        override: { ...(overrides.mode ? { mode: overrides.mode } : {}), ...(overrides.minutes ? { minutes: overrides.minutes } : {}) }, swaps: {},
      };
      const planned = Planner.planToday(world.data, { today: date, day }, program);
      out.push(json({ ...planned, view: { ...planned.view, input: { ...planned.view.input, sessions: undefined, summary: undefined } } }));
    }
  }
  return out;
}

// ── The database: rows as saves write them ─────────────────────────────────────────────────────────────────────

/** A seeded history written as saves write it, with the odd row a real account has. Ids are fixed: reads order by them. */
async function write(db: Db, userId: string, sessions: readonly HistorySession[], seed: string): Promise<void> {
  const rng = Rng.create(`write|${seed}`);
  let n = 0;
  const id = (kind: string) => `${seed}-${kind}-${String(n++).padStart(6, "0")}`;
  const NOW = "2026-10-01T00:00:00.000Z";
  for (const [i, s] of sessions.entries()) {
    const workoutId = rng() < 0.6 ? `w-${seed}-${i % 9}` : null;
    // Now and then a session still being written: never history.
    const pending = rng() < 0.03;
    await db.insert(schema.performedSessions).values({
      id: s.id, userId, workoutId, activityId: null, buildId: null, source: s.mode ? "app" : "import", sourceRef: s.mode ? null : `ref-${s.id}`,
      localDate: s.date, startedAt: s.startedAt, endedAt: rng() < 0.5 ? null : `${s.date}T19:30:00.000Z`, seconds: 1800, plannedSeconds: rng() < 0.2 ? null : 1800,
      minutes: rng() < 0.2 ? null : 30, mode: s.mode, theme: s.theme, locationId: rng() < 0.3 ? "home" : null, blockRef: null, blockNumber: s.blockNumber,
      completed: rng() < 0.9, stepsTotal: null, stepsDone: null,
      movesDone: s.done.map((m, k) => ({ exerciseId: m.id, seconds: m.secs, ...(k % 3 === 0 ? { slotKey: `prep:${k}` } : {}) })),
      note: rng() < 0.1 ? "felt fine" : null, newMove: null, payloadHash: pending ? PENDING_HASH : "h", createdAt: NOW, updatedAt: NOW,
    });
    const sets = s.entries.flatMap((e, entryIndex) => {
      const sided = rng() < 0.1;
      const done = e.sets.flatMap((set, setIndex): Array<{ set: typeof set; setIndex: number; side: "left" | "right" | null; done: boolean }> =>
        sided ? (["left", "right"] as const).map((side) => ({ set, setIndex, side, done: true })) : [{ set, setIndex, side: null, done: true }],
      );
      // A set skipped at the end, and now and then an entry with nothing done (it is not history).
      const skipped = rng() < 0.15 ? [{ set: e.sets[0]!, setIndex: e.sets.length, side: null, done: false }] : [];
      const all = rng() < 0.04 ? done.map((x) => ({ ...x, done: false })) : [...done, ...skipped];
      const lb = rng() < 0.3;
      return all.map(({ set, setIndex, side, done: isDone }) => ({
        id: id("set"), performedSessionId: s.id, entryIndex, exerciseId: e.id, implement: e.implement ?? (rng() < 0.2 ? "kettlebell" : null),
        format: e.format, perSide: e.perSide || sided, setIndex, side, reps: set.reps, seconds: set.secs ?? (side ? 30 + Math.floor(rng() * 10) : null),
        loadValue: set.w ? (rng() < 0.05 ? 0 : set.w.v) : null, loadUnit: set.w ? (lb ? "lb" : set.w.u) : null, loadKg: null, done: isDone,
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
          id: id("check"), userId, profileId, kind: "pre", value: c.pre, feelingOff: c.feelingOff, localDate: s.date,
          at: `${s.date}T07:00:00.000Z`, performedSessionId: sheet ? null : s.id, workoutId: sheet ? workoutId : null,
        });
      }
      if (c.post != null) {
        await db.insert(schema.conditionChecks).values({
          id: id("check"), userId, profileId, kind: "post", value: c.post, feelingOff: false, localDate: s.date,
          at: `${s.date}T20:00:00.000Z`, performedSessionId: s.id, workoutId: null,
        });
      }
    }
    if (rng() < 0.1) {
      await db.insert(schema.conditionChecks).values({
        id: id("check"), userId, profileId: "tmj", kind: "daily", value: 3, feelingOff: false, localDate: s.date,
        at: `${s.date}T06:00:00.000Z`, performedSessionId: null, workoutId: null,
      });
    }
  }
}

const readContext: BuildContext = {
  prefs: { ratings: {}, excluded: [], pinned: [] },
  savedIds: [],
  location: LOCATIONS[0]!,
  locations: LOCATIONS,
  unit: "kg",
  activeProfiles: ["tmj"],
  careProfiles: ["tmj"],
  config: { weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, modes: ALL_MODES },
};

/** An account's reads at many days and blocks, and the build each read makes, as JSON lines. */
async function accountReads(db: Db, userId: string, seed: string, seeded: Seeded): Promise<string[]> {
  const rng = Rng.create(`reads|${seed}`);
  const out: string[] = [];
  const sessions = seeded.sessions;
  for (let i = 1; i < sessions.length + 3; i += 4 + Math.floor(rng() * 5)) {
    const last = sessions[Math.min(i, sessions.length - 1)]!;
    const date = addDays(last.date, i >= sessions.length ? [1, 4, 30][i - sessions.length]! : Math.floor(rng() * 3));
    const stored = seeded.blocks[Math.min(i, seeded.blocks.length - 1)] ?? null;
    const roll = rng();
    const block: Block | null = roll < 0.15 ? null : roll < 0.25 && stored ? { ...stored, startedAt: addDays(date, -50) } : stored;
    const read = await loadBuildHistory(db, userId, date, block);
    out.push(json(read));
    const built = composeBuild({
      date, programId: `reads-${seed}`, context: readContext, block, history: read.sessions, summary: read.summary,
      checks: { tmj: { pre: Math.floor(rng() * 6), feelingOff: false } }, overrides: rng() < 0.3 ? { minutes: 40 } : {}, swaps: {},
    });
    out.push(json(built));
  }
  return out;
}

/** Whole build requests on the days after a written history: what each one stores. */
async function requests(db: Db): Promise<string[]> {
  const { userId, prefs } = await makeTestUser(db);
  const seeded = seededHistory(WORLDS[0]!.data, WORLDS[0]!.renamed, "determinism|requests", 80);
  await write(db, userId, seeded.sessions, "requests");
  const now = "2026-10-01T12:00:00.000Z";
  const programId = "determinism-program";
  await db.insert(schema.programs).values({
    id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30, careProfiles: ["tmj"] }), createdAt: now, updatedAt: now, archivedAt: null,
  });
  await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2025-01-01", settings: {} });
  await db.insert(schema.locations).values({
    id: "home", userId, name: "Home", equipment: [...LOCATIONS[0]!.equipment], implements: { kettlebell: "8, 12, 16 kg, 35 lb" }, isDefault: true, createdAt: now, updatedAt: now,
  });
  const block = seeded.blocks[seeded.blocks.length - 1];
  if (block) {
    await db.insert(schema.programBlocks).values({
      id: "determinism-block", programId, number: block.number, kind: "core_block", startDate: block.startedAt, weeks: block.weeks,
      intent: { core: block.core, rotations: [...block.rotations] }, createdAt: now, updatedAt: now,
    });
  }
  const first = addDays(seeded.sessions[seeded.sessions.length - 1]!.date, 1);
  const out: string[] = [];
  for (let d = 0; d < 6; d++) {
    const today = addDays(first, d * 3);
    const workoutId = slotId(programId, today);
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: today, lastVerifiedCorosDate: "", effectiveDate: today, effectiveTime: "18:00",
      sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
      corosSyncState: "calendar_only", completionState: "scheduled", origin: "program", contentState: "outline", createdAt: now, updatedAt: now,
    });
    for (const [k, minutes] of [30, 40].entries()) {
      await buildSession(db, userId, workoutId, { overrides: { minutes } }, { today, now: `${today}T07:0${k}:00.000Z`, prefs });
      const rows = await db.select().from(schema.sessionBuilds).where(eq(schema.sessionBuilds.workoutId, workoutId));
      for (const r of rows) {
        const payload = r.payload as { build: { blockRef: string | null } };
        // A block the build started is a new row with a new id: what is recorded is whether it was the stored one.
        const blockRef = payload.build.blockRef === "determinism-block" || payload.build.blockRef === null ? payload.build.blockRef : "new-block-row";
        out.push(json({ version: r.version, engineVersion: r.engineVersion, inputsHash: r.inputsHash, payload: { ...payload, build: { ...payload.build, blockRef } } }));
      }
    }
  }
  return out;
}

// ── The check ──────────────────────────────────────────────────────────────────────────────────────────────────

let made: Recorded;
let lines = 0;
let db: Db;

beforeAll(async () => {
  const hs = histories();
  const programmes: string[] = [];
  for (let p = 0; p < PROGRAMMES; p++) {
    const builds = programmeBuilds(p, hs[p % hs.length]!);
    lines += builds.length;
    programmes.push(short(builds.join("\n")));
  }
  db = makeTestDb({ boundVariableCap: 100 });
  const reads: string[] = [];
  for (const [seed, n] of [["golf", 160], ["hotel", 110]] as const) {
    const { userId } = await makeTestUser(db);
    const seeded = seededHistory(WORLDS[0]!.data, WORLDS[0]!.renamed, `determinism|${seed}`, n);
    await write(db, userId, seeded.sessions, seed);
    const read = await accountReads(db, userId, seed, seeded);
    lines += read.length;
    reads.push(short(read.join("\n")));
  }
  const stored = await requests(db);
  lines += stored.length;
  made = { library: libraryFingerprint(), programmes, reads, requests: short(stored.join("\n")) };
  console.log(`[determinism] ${lines} builds, reads and stored builds (${PROGRAMMES} programmes; ${stored.length} stored rows); library ${made.library}`);
  if (UPDATE) writeFileSync(DIGESTS, `${JSON.stringify(made, null, 1)}\n`);
}, 600_000);

describe("the build, byte for byte", () => {
  it("makes exactly the builds recorded for this library", (ctx) => {
    const recorded = JSON.parse(readFileSync(DIGESTS, "utf8")) as Recorded;
    ctx.skip(
      recorded.library !== made.library,
      `the library changed since the digests were recorded (${recorded.library} → ${made.library}): record them again ` +
        `with UPDATE_BUILD_DIGESTS=1 (from the code before the change being checked)`,
    );
    expect(lines).toBeGreaterThan(1000);
    const differ = made.programmes.flatMap((d, p) => (d === recorded.programmes[p] ? [] : [p]));
    // A difference here is a change to what builds make: a cheaper build must make none. Only a change meant to change
    // builds (an engine rule) records the digests again, with UPDATE_BUILD_DIGESTS=1.
    expect(differ, `programmes whose builds changed (of ${PROGRAMMES})`).toEqual([]);
    expect(made.reads, "the database reads and the builds made from them").toEqual(recorded.reads);
    expect(made.requests, "the builds whole requests stored").toEqual(recorded.requests);
  });

  it("reads the history's rows exactly as drizzle maps them (`rowsOf`), whatever the library", async () => {
    const tables = [schema.performedSessions, schema.performedSets, schema.conditionChecks] as const;
    for (const table of tables) {
      const mapped = await db.select().from(table);
      const ours = rowsOf(table)(await db.select().from(table).values());
      expect(mapped.length).toBeGreaterThan(100);
      // Byte for byte: the same values, nulls, booleans and parsed JSON, keys in the same order.
      expect(json(ours) === json(mapped), "rowsOf differs from drizzle's own mapping").toBe(true);
      expect(ours).toEqual(mapped);
    }
    // A select of some columns is not a whole row: refused, never mapped onto the wrong keys.
    const partial = await db.select({ id: schema.performedSets.id, done: schema.performedSets.done }).from(schema.performedSets).values();
    expect(() => rowsOf(schema.performedSets)(partial)).toThrow(/rowsOf/);
    // The rows hold what the mapping has to get right: every column type, NULLs, both booleans, empty and full JSON.
    const sets = await db.select().from(schema.performedSets);
    expect(sets.some((s) => s.side !== null) && sets.some((s) => s.loadValue === null) && sets.some((s) => s.loadValue === 0)).toBe(true);
    expect(sets.some((s) => s.done) && sets.some((s) => !s.done) && sets.some((s) => s.perSide)).toBe(true);
    expect(sets.some((s) => s.flags.length === 0) && sets.some((s) => s.flags.length > 0)).toBe(true);
    const sessions = await db.select().from(schema.performedSessions);
    expect(sessions.some((s) => s.startedAt === null) && sessions.some((s) => !s.completed) && sessions.some((s) => s.movesDone.length > 0)).toBe(true);
  });
});
