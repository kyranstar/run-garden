/**
 * The table registry (Phase 0 Task 8): ONE list that says, for every table
 * the schema barrel exports, whether it belongs to an account and how it is
 * reached — so export, restore, the staging copier and the parity harness
 * cannot each keep their own list and drift apart the way the old export did
 * (it covered 11 of ~50 tables).
 *
 * Also pins the shared row ordering + hashing helpers (Ruling R2): rows are
 * ordered by primary key — never rowid, which a table rebuild renumbers — and
 * hashed over canonical JSON, so two databases holding the same rows hash the
 * same no matter how the rows were inserted.
 */
import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import {
  ACCOUNT_TABLES,
  accountTable,
  canonicalJson,
  hashRows,
  hashTable,
  orderedRows,
  secretColumns,
} from "../src/services/account-tables.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

function schemaTables(): Array<{ name: string; table: SQLiteTable }> {
  return Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => ({ name: getTableName(table as SQLiteTable), table: table as SQLiteTable }));
}

const sqlColumnNames = (table: SQLiteTable): string[] =>
  Object.values(getTableColumns(table)).map((c) => c.name);

describe("ACCOUNT_TABLES — classification", () => {
  it("lists every table the schema barrel exports exactly once, and nothing else", () => {
    const fromSchema = schemaTables();
    const registered = ACCOUNT_TABLES.map((t) => t.name);

    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(fromSchema.map((t) => t.name).sort());
    for (const { name, table } of fromSchema) {
      expect(accountTable(name).table).toBe(table);
    }
  });

  it("gives every child a user-scoped parent, and a column that really exists on both sides", () => {
    for (const entry of ACCOUNT_TABLES) {
      if (entry.scope.kind !== "child") continue;
      const parent = accountTable(entry.scope.parent);
      expect(parent.scope.kind, `${entry.name} → ${entry.scope.parent}`).toBe("user");
      expect(sqlColumnNames(entry.table)).toContain(entry.scope.column);
      expect(sqlColumnNames(parent.table)).toContain(entry.scope.parentKey ?? "id");
    }
  });

  it("orders parents before children, with one distinct order per table", () => {
    const orders = ACCOUNT_TABLES.map((t) => t.order);
    expect(new Set(orders).size).toBe(orders.length);
    for (const entry of ACCOUNT_TABLES) {
      if (entry.scope.kind !== "child") continue;
      expect(accountTable(entry.scope.parent).order).toBeLessThan(entry.order);
    }
  });

  it("scopes every user table by its own user_id column", () => {
    for (const entry of ACCOUNT_TABLES) {
      if (entry.scope.kind !== "user") continue;
      expect(sqlColumnNames(entry.table), entry.name).toContain("user_id");
    }
  });

  it("names the children the delete-all loops reach through a parent id", () => {
    const children = Object.fromEntries(
      ACCOUNT_TABLES.filter((t) => t.scope.kind === "child").map((t) => [
        t.name,
        t.scope.kind === "child" ? `${t.scope.parent}.${t.scope.column}` : "",
      ]),
    );
    expect(children).toEqual({
      activity_laps: "activities.activity_id",
      activity_source_links: "activities.activity_id",
      activity_stream_summaries: "activities.activity_id",
      planned_workout_stages: "planned_workouts.workout_id",
      schedule_overrides: "planned_workouts.workout_id",
      workout_completion_matches: "planned_workouts.workout_id",
      calendar_event_links: "planned_workouts.workout_id",
      calendar_event_suppressions: "planned_workouts.workout_id",
      training_plan_versions: "training_plans.plan_id",
      studio_plan_pushes: "studio_plans.plan_id",
      coach_plan_weeks: "coach_plans.plan_id",
      coros_write_attempts: "coros_write_jobs.job_id",
    });
  });

  it("marks users as identity and keeps auth, catalogs and versioning out of any account", () => {
    expect(accountTable("users").scope.kind).toBe("identity");
    const excluded = ACCOUNT_TABLES.filter((t) => t.scope.kind === "excluded").map((t) => t.name);
    expect(excluded.sort()).toEqual(
      ["account_state", "coros_exercises", "garden_species", "oauth_states", "schema_versions", "sessions"].sort(),
    );
    for (const entry of ACCOUNT_TABLES) {
      if (entry.scope.kind === "excluded") expect(entry.scope.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws on a table it has never heard of", () => {
    expect(() => accountTable("not_a_table")).toThrow(/not_a_table/);
  });

  it("names provider_connections' encrypted token columns as its only secrets", () => {
    expect([...secretColumns("provider_connections")].sort()).toEqual([
      "encrypted_access_token",
      "encrypted_refresh_token",
    ]);
    for (const col of secretColumns("provider_connections")) {
      expect(sqlColumnNames(schema.providerConnections)).toContain(col);
    }
    expect(secretColumns("activities")).toEqual([]);
    expect(() => secretColumns("not_a_table")).toThrow();
  });
});

/**
 * Audit 1 data finding 13: `SECRETS` is a hand-written list, so a new column
 * holding a credential would be exported in the clear the day it is added.
 * Every column whose name looks like one must be either a declared secret
 * (nulled on export, never restored) or on this list with the reason it is
 * not a secret — so adding one is a decision, not an accident.
 */
const SECRET_LOOKING = /token|secret|password|key|verifier|encrypted/i;
const NOT_SECRETS: Record<string, string> = {
  "provider_connections.access_token_expires_at": "an expiry time, not the token",
  "provider_cursor_state.cursor_key": "which cursor this is (e.g. events_sync_token:<calendar>)",
  "computed_metrics.metric_key": "a metric's name",
  "activity_laps.exercise_name_key": "the COROS catalog key of a lap's exercise",
  "llm_usage.input_tokens": "a count of model tokens",
  "llm_usage.output_tokens": "a count of model tokens",
  "coach_reads.claim_token": "a single-flight lock token, meaningless outside the claim",
  "coach_locks.token": "a single-flight lock token (and the table is not exported)",
};

describe("secret columns (finding 13)", () => {
  it("every column that looks like a credential is a declared secret or explained here", () => {
    const undeclared: string[] = [];
    for (const entry of ACCOUNT_TABLES) {
      if (entry.scope.kind === "excluded") continue;
      for (const name of sqlColumnNames(entry.table)) {
        if (!SECRET_LOOKING.test(name)) continue;
        const key = `${entry.name}.${name}`;
        if (secretColumns(entry.name).includes(name) || key in NOT_SECRETS) continue;
        undeclared.push(key);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("the explanations still name real columns", () => {
    for (const key of Object.keys(NOT_SECRETS)) {
      const [table, column] = key.split(".");
      expect(sqlColumnNames(accountTable(table!).table), key).toContain(column);
    }
  });
});

describe("orderedRows — primary-key order, optionally scoped to one account", () => {
  it("returns rows in primary-key order regardless of insertion order", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    for (const id of ["c", "a", "b"]) {
      await db.insert(schema.dismissedInsights).values({
        id,
        userId,
        cardId: `card-${id}`,
        dismissedAt: nowInstant(),
      });
    }
    const rows = await orderedRows(db, schema.dismissedInsights);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("falls back to every column, in declaration order, for a table with no primary key", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    // coach_locks has a unique index but no primary key.
    await db.insert(schema.coachLocks).values([
      { userId: "u2", kind: "wake", token: "t", claimedAt: "2026-01-01T00:00:00Z" },
      { userId, kind: "wake", token: "t", claimedAt: "2026-01-01T00:00:00Z" },
      { userId: "u1", kind: "wake", token: "t", claimedAt: "2026-01-01T00:00:00Z" },
    ]);
    const rows = await orderedRows(db, schema.coachLocks);
    const expected = ["u1", "u2", userId].sort();
    expect(rows.map((r) => r.userId)).toEqual(expected);
  });

  it("scopes user tables by user_id and child tables through their parent's ids", async () => {
    const db = makeTestDb();
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    const seed = async (userId: string, activityId: string) => {
      await db.insert(schema.activities).values({
        id: activityId,
        userId,
        startTime: "2026-01-02T14:00:00Z",
        sport: "run",
        durationSeconds: 1800,
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
      await db.insert(schema.activityLaps).values({
        id: newId(),
        activityId,
        lapIndex: 0,
        durationSeconds: 600,
      });
    };
    await seed(me, "act-mine");
    await seed(other, "act-theirs");

    const acts = await orderedRows(db, schema.activities, { userId: me });
    expect(acts.map((a) => a.id)).toEqual(["act-mine"]);
    const laps = await orderedRows(db, schema.activityLaps, { userId: me });
    expect(laps.map((l) => l.activityId)).toEqual(["act-mine"]);
    const users = await orderedRows(db, schema.users, { userId: me });
    expect(users.map((u) => u.id)).toEqual([me]);
    await expect(orderedRows(db, schema.sessions, { userId: me })).rejects.toThrow(/sessions/);
  });

  it("pages with offset + limit over the same order", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    for (const id of ["e", "d", "c", "b", "a"]) {
      await db.insert(schema.dismissedInsights).values({
        id,
        userId,
        cardId: `card-${id}`,
        dismissedAt: nowInstant(),
      });
    }
    const page1 = await orderedRows(db, schema.dismissedInsights, { userId, offset: 0, limit: 2 });
    const page2 = await orderedRows(db, schema.dismissedInsights, { userId, offset: 2, limit: 2 });
    const page3 = await orderedRows(db, schema.dismissedInsights, { userId, offset: 4, limit: 2 });
    expect([...page1, ...page2, ...page3].map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("hashRows / canonicalJson", () => {
  it("is independent of key order, and nested objects are canonical too", async () => {
    const a = [{ id: "1", meta: { b: 2, a: 1 }, n: null }];
    const b = [{ n: null, meta: { a: 1, b: 2 }, id: "1" }];
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await hashRows(a)).toBe(await hashRows(b));
    expect(await hashRows(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes undefined as null and -0 as 0, so equal rows never hash apart", () => {
    expect(canonicalJson({ a: undefined, b: -0 })).toBe(canonicalJson({ a: null, b: 0 }));
    expect(canonicalJson([1, "x", true, null, [2]])).toBe('[1,"x",true,null,[2]]');
  });

  it("changes with row order and with any value", async () => {
    const one = { id: "1", v: 1 };
    const two = { id: "2", v: 2 };
    expect(await hashRows([one, two])).not.toBe(await hashRows([two, one]));
    expect(await hashRows([one])).not.toBe(await hashRows([{ ...one, v: 1.5 }]));
  });
});

describe("hashTable — paged, equal to hashRows over orderedRows (Ruling R2)", () => {
  it("gives the one-read digest whatever the page size, scoped or whole-table", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: me } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    const seed: Array<[string, string[]]> = [
      [me, ["e", "c", "a", "d", "b"]],
      [other, ["z", "y"]],
    ];
    for (const [userId, ids] of seed) {
      for (const id of ids) {
        await db.insert(schema.dismissedInsights).values({ id, userId, cardId: `card-${id}`, dismissedAt: nowInstant() });
      }
    }
    const whole = await hashRows(await orderedRows(db, schema.dismissedInsights));
    const mine = await hashRows(await orderedRows(db, schema.dismissedInsights, { userId: me }));
    for (const pageSize of [1, 2, 5, 7, 500]) {
      expect(await hashTable(db, schema.dismissedInsights, { pageSize })).toEqual({ rows: 7, sha256: whole });
      expect(await hashTable(db, schema.dismissedInsights, { userId: me, pageSize })).toEqual({ rows: 5, sha256: mine });
    }
    expect(mine).not.toBe(whole);
  });

  it("reads a table with no single-column key in one query, and hashes masked columns as null", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.coachLocks).values([
      { userId: "u2", kind: "wake", token: "t2", claimedAt: "2026-01-01T00:00:00Z" },
      { userId, kind: "wake", token: "t1", claimedAt: "2026-01-01T00:00:00Z" },
    ]);
    const rows = await orderedRows(db, schema.coachLocks);
    expect(await hashTable(db, schema.coachLocks, { pageSize: 1 })).toEqual({ rows: 2, sha256: await hashRows(rows) });
    const masked = rows.map((r) => ({ ...r, token: null }));
    expect((await hashTable(db, schema.coachLocks, { mask: ["token"] })).sha256).toBe(await hashRows(masked));
  });
});
