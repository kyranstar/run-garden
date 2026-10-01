/**
 * The one-workout-system model's tables (migrations 0024–0027, Phase 1 spec
 * §6): the Drizzle declarations agree with the hand-authored DDL column by
 * column and index by index (nothing generates one from the other), a fully
 * populated row of every new table round-trips under D1's 100-variable cap,
 * the DDL's own defaults read back as the Drizzle types say, and the unique
 * keys Phase 2's writers lean on hold.
 */
import { describe, expect, it } from "vitest";
import { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NEW_TABLES: SQLiteTable[] = [
  schema.programs,
  schema.programVersions,
  schema.programBlocks,
  schema.sessionBuilds,
  schema.performedSessions,
  schema.performedSets,
  schema.conditionChecks,
  schema.userConditions,
  schema.locations,
  schema.exercisePrefs,
  schema.exerciseProvenance,
];

type Row = Record<string, unknown>;

const rawAll = (db: Db, query: string): Row[] =>
  (db as unknown as { all: (q: unknown) => Row[] }).all(sql.raw(query));

/** The SQL text a Drizzle default is stored as in the DDL. */
function ddlDefault(value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value}'`;
  return `'${JSON.stringify(value)}'`;
}

describe("Drizzle matches the migrated DDL", () => {
  it("has the same columns, NOT NULL, primary key and defaults on every new table", () => {
    const db = makeTestDb();
    for (const table of NEW_TABLES) {
      const name = getTableName(table);
      const info = rawAll(db, `PRAGMA table_info(\`${name}\`)`);
      const columns = Object.values(getTableColumns(table));
      expect(info.map((c) => c.name).sort(), name).toEqual(columns.map((c) => c.name).sort());
      for (const col of columns) {
        const ddl = info.find((c) => c.name === col.name)!;
        const where = `${name}.${col.name}`;
        expect(Boolean(ddl.notnull) || col.primary, where).toBe(col.notNull);
        expect(Boolean(ddl.pk), where).toBe(col.primary);
        expect(ddl.dflt_value ?? null, where).toBe(col.hasDefault ? ddlDefault(col.default) : null);
      }
    }
  });

  it("has the same indexes, unique where Drizzle says unique", () => {
    const db = makeTestDb();
    for (const table of NEW_TABLES) {
      const name = getTableName(table);
      const ddl = rawAll(db, `PRAGMA index_list(\`${name}\`)`)
        .filter((i) => i.origin === "c")
        .map((i) => ({ name: i.name, unique: Boolean(i.unique) }));
      const drizzle = getTableConfig(table).indexes.map((i) => ({ name: i.config.name, unique: Boolean(i.config.unique) }));
      const byName = (a: { name: unknown }, b: { name: unknown }) => String(a.name).localeCompare(String(b.name));
      expect(ddl.sort(byName), name).toEqual(drizzle.sort(byName));
    }
  });

  it("adds planned_workouts.origin, content_state and session_params as nullable columns with no default", () => {
    const db = makeTestDb();
    const info = rawAll(db, "PRAGMA table_info(`planned_workouts`)");
    for (const column of ["origin", "content_state", "session_params"]) {
      const ddl = info.find((c) => c.name === column);
      expect(ddl, column).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    }
    const cols = Object.values(getTableColumns(schema.plannedWorkouts)).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["origin", "content_state", "session_params"]));
  });
});

async function seedPlannedWorkout(db: Db, userId: string, id: string, extra: Row = {}): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "program-1",
    sourceWorkoutId: id,
    title: "Strength",
    category: "strength",
    originalPlanDate: "2026-10-05",
    lastVerifiedCorosDate: "",
    effectiveDate: "2026-10-05",
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1800,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  });
}

describe("one fully populated row per new table round-trips (D1's 100-variable cap)", () => {
  it("reads back exactly what was written, JSON, booleans and reals included", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const at = "2026-10-01T12:00:00.000Z";
    const rows: Array<[SQLiteTable, Row]> = [
      [
        schema.programs,
        {
          id: "prog-1", userId, kind: "adaptive", name: "Strength", status: "active", disciplines: ["strength"],
          startDate: "2026-10-01", endDate: "2026-12-31", raceDate: null, source: { stampPrefix: "rg" },
          config: { weeklyGoal: 4, preferredDays: [1, 3, 5], careProfiles: [] }, createdAt: at, updatedAt: at, archivedAt: null,
        },
      ],
      [schema.programVersions, { id: "pv-1", programId: "prog-1", versionNum: 1, capturedAt: at, fingerprint: "f1", summary: { weeks: 12 } }],
      [
        schema.programBlocks,
        {
          id: "pb-1", programId: "prog-1", number: 1, kind: "core_block", startDate: "2026-10-01", weeks: 5,
          intent: { core: { squat: "goblet-squat", hinge: null }, rotations: [] }, createdAt: at, updatedAt: at,
        },
      ],
      [
        schema.sessionBuilds,
        {
          id: "sb-1", userId, workoutId: "pw-1", version: 1, engineVersion: "1", inputsHash: "h1",
          payload: { steps: [{ kind: "rest", seconds: 30 }], alternatives: {} }, lockedAt: at, createdAt: at,
        },
      ],
      [
        schema.performedSessions,
        {
          id: "ps-1", userId, workoutId: "pw-1", activityId: "ps-1", buildId: "sb-1", source: "app", sourceRef: null,
          localDate: "2026-10-01", startedAt: at, endedAt: "2026-10-01T12:31:00.000Z", seconds: 1860, plannedSeconds: 1800,
          minutes: 30, mode: "build", theme: "pull-day", locationId: "loc-1", blockRef: "pb-1", blockNumber: 1, completed: true,
          stepsTotal: 24,
          stepsDone: 22, movesDone: [{ exerciseId: "goblet-squat", seconds: 240 }, { exerciseId: "cat-cow", seconds: 60 }],
          note: "felt good", newMove: "cat-cow", payloadHash: "ph", createdAt: at, updatedAt: at,
        },
      ],
      [
        schema.performedSets,
        {
          id: "set-1", performedSessionId: "ps-1", entryIndex: 0, exerciseId: "goblet-squat", implement: "kettlebell",
          format: "straight", perSide: false, setIndex: 0, side: "left", reps: 8, seconds: 45, loadValue: 35,
          loadUnit: "lb", loadKg: 15.87573295, done: true, flags: ["flag-a"],
        },
      ],
      [
        schema.conditionChecks,
        {
          id: "cc-1", userId, profileId: "profile-a", kind: "pre", value: 2, feelingOff: true, localDate: "2026-10-01", at,
          performedSessionId: "ps-1", workoutId: "pw-1",
        },
      ],
      [
        schema.userConditions,
        { id: `${userId}:profile-a`, userId, profileId: "profile-a", active: true, since: "2026-09-01", settings: { care: true } },
      ],
      [
        schema.locations,
        {
          id: "loc-1", userId, name: "Home", equipment: ["mat", "kettlebell"],
          implements: { kettlebell: [{ v: 25, u: "lb" }, { v: 16, u: "kg" }] }, isDefault: true, createdAt: at, updatedAt: at,
        },
      ],
      [
        schema.exercisePrefs,
        {
          id: `${userId}:goblet-squat`, userId, exerciseId: "goblet-squat", rating: -1, excluded: true, pinned: true,
          introducedOn: "2026-09-15", updatedAt: at,
        },
      ],
      [
        schema.exerciseProvenance,
        {
          id: "prov-1", userId, exerciseId: "goblet-squat", sourceType: "video", url: "https://example.com/v/1",
          creator: "example-creator", sourceKey: "example-1", createdAt: at,
        },
      ],
    ];
    expect(rows.map(([t]) => t)).toEqual(NEW_TABLES);

    for (const [table, row] of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.insert(table as any).values(row as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const back = await db.select().from(table as any);
      expect(back, getTableName(table)).toEqual([row]);
    }

    const params = { minutes: 40, locationId: "loc-1", swaps: { "main-0": { from: "a", to: "b" } } };
    await seedPlannedWorkout(db, userId, "pw-1", { origin: "program", contentState: "built", sessionParams: params });
    const [workout] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "pw-1"));
    expect(workout).toMatchObject({ origin: "program", contentState: "built", sessionParams: params });
  });

  it("an existing-style planned workout (written without the new columns) reads them as null", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedPlannedWorkout(db, userId, "pw-old");
    const [workout] = await db.select().from(schema.plannedWorkouts);
    expect(workout).toMatchObject({ origin: null, contentState: null, sessionParams: null });
  });
});

describe("the DDL's own defaults", () => {
  it("fill every defaulted column of a row written by plain SQL, read back as the Drizzle types", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const run = (q: string) => (db as unknown as { run: (q: unknown) => unknown }).run(sql.raw(q));
    run(
      `INSERT INTO performed_sessions (id, user_id, source, local_date, payload_hash, created_at, updated_at)
       VALUES ('ps-d', '${userId}', 'app', '2026-10-01', 'h', 't', 't')`,
    );
    run(`INSERT INTO performed_sets (id, performed_session_id, entry_index, exercise_id, set_index) VALUES ('s-d', 'ps-d', 0, 'x', 0)`);
    run(
      `INSERT INTO condition_checks (id, user_id, profile_id, kind, local_date, at)
       VALUES ('c-d', '${userId}', 'p', 'daily', '2026-10-01', 't')`,
    );
    run(`INSERT INTO user_conditions (id, user_id, profile_id, active, since) VALUES ('u-d', '${userId}', 'p', 1, '2026-10-01')`);
    run(
      `INSERT INTO locations (id, user_id, name, equipment, created_at, updated_at)
       VALUES ('l-d', '${userId}', 'Park', '[]', 't', 't')`,
    );
    run(`INSERT INTO exercise_prefs (id, user_id, exercise_id, updated_at) VALUES ('e-d', '${userId}', 'x', 't')`);

    const [session] = await db.select().from(schema.performedSessions);
    expect(session).toMatchObject({ seconds: 0, completed: false, movesDone: [] });
    const [set] = await db.select().from(schema.performedSets);
    expect(set).toMatchObject({ perSide: false, done: true, flags: [] });
    const [check] = await db.select().from(schema.conditionChecks);
    expect(check).toMatchObject({ value: null, feelingOff: false });
    const [condition] = await db.select().from(schema.userConditions);
    expect(condition).toMatchObject({ active: true, settings: {} });
    const [location] = await db.select().from(schema.locations);
    expect(location).toMatchObject({ implements: {}, isDefault: false, equipment: [] });
    const [pref] = await db.select().from(schema.exercisePrefs);
    expect(pref).toMatchObject({ rating: null, excluded: false, pinned: false, introducedOn: null });
  });
});

describe("unique keys", () => {
  const base = (userId: string, id: string, extra: Row = {}): Row => ({
    id, userId, source: "app", sourceRef: null, localDate: "2026-10-01", payloadHash: "h", createdAt: "t", updatedAt: "t", ...extra,
  });

  it("performed_sessions: app saves (no source_ref) never collide; an import's source_ref is once per account", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insert = (row: Row) => db.insert(schema.performedSessions).values(row as any);
    await insert(base(me, "a1"));
    await insert(base(me, "a2"));
    await insert(base(me, "i1", { source: "import", sourceRef: "standalone-1" }));
    await expect(insert(base(me, "i2", { source: "import", sourceRef: "standalone-1" }))).rejects.toThrow(/UNIQUE/);
    await insert(base(other, "i3", { source: "import", sourceRef: "standalone-1" }));
    await insert(base(me, "w1", { source: "watch_review", sourceRef: "standalone-1" }));
    const mine = await db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, me));
    expect(mine.map((r) => r.id).sort()).toEqual(["a1", "a2", "i1", "w1"]);
  });

  it("session_builds: one row per (workout, version)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const build = (id: string, version: number) =>
      db.insert(schema.sessionBuilds).values({
        id, userId, workoutId: "pw-1", version, engineVersion: "1", inputsHash: "h", payload: {}, createdAt: "t",
      });
    await build("b1", 1);
    await build("b2", 2);
    await expect(build("b3", 2)).rejects.toThrow(/UNIQUE/);
  });

  it("program_blocks: one row per (program, number)", async () => {
    const db = makeTestDb();
    const block = (id: string, programId: string, number: number) =>
      db.insert(schema.programBlocks).values({
        id, programId, number, kind: "core_block", startDate: "2026-10-01", weeks: 5, intent: {}, createdAt: "t", updatedAt: "t",
      });
    await block("pb1", "p1", 1);
    await block("pb2", "p2", 1);
    await expect(block("pb3", "p1", 1)).rejects.toThrow(/UNIQUE/);
  });

  it("user_conditions, exercise_prefs, exercise_provenance: once per account, and upsertable on the pair", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.userConditions).values({ id: "c1", userId, profileId: "p", active: true, since: "2026-10-01" });
    await expect(
      db.insert(schema.userConditions).values({ id: "c2", userId, profileId: "p", active: true, since: "2026-10-02" }),
    ).rejects.toThrow(/UNIQUE/);

    const pref = (rating: number) => ({ id: `${userId}:x`, userId, exerciseId: "x", rating, updatedAt: "t" });
    await db.insert(schema.exercisePrefs).values(pref(1));
    await expect(db.insert(schema.exercisePrefs).values({ ...pref(1), id: "other-id" })).rejects.toThrow(/UNIQUE/);
    // Phase 2's write: an upsert on (user, exercise) — the unique index is its target.
    await db
      .insert(schema.exercisePrefs)
      .values(pref(-1))
      .onConflictDoUpdate({
        target: [schema.exercisePrefs.userId, schema.exercisePrefs.exerciseId],
        set: { rating: -1 },
      });
    const prefs = await db
      .select()
      .from(schema.exercisePrefs)
      .where(and(eq(schema.exercisePrefs.userId, userId), eq(schema.exercisePrefs.exerciseId, "x")));
    expect(prefs.map((p) => p.rating)).toEqual([-1]);

    const prov = (id: string) => ({
      id, userId, exerciseId: "x", sourceType: "video", sourceKey: "k1", createdAt: "t",
    });
    await db.insert(schema.exerciseProvenance).values(prov("v1"));
    await expect(db.insert(schema.exerciseProvenance).values(prov("v2"))).rejects.toThrow(/UNIQUE/);
  });
});
