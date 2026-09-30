/**
 * Restore begin / rows / finish after audit 1 (data findings 1, 2, 5, 8, 11,
 * 12; rulings B1-B3, B10).
 *
 *  - begin needs a check session and page tokens of THAT session covering its
 *    manifest exactly, and `rows` only accepts a page whose rows are exactly
 *    the ones a clean check of this restore signed;
 *  - `rows` and `finish` need the id of the restore in progress, so a second
 *    tab's begin (or no begin at all) cannot merge a file into a live account;
 *  - unfinished work in the file lands switched off (B3) — a restored queued
 *    or claimed COROS job can never be claimed again;
 *  - an insert error is a 422 naming the table and row, and rows lost to a
 *    conflict are counted rather than reported as "ok";
 *  - "Start fresh" abandons an unfinished restore.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, SCHEMA_VERSION } from "@rg/database";
import { isTerminalJobStatus, newId, nowInstant, type CoachSession } from "@rg/domain";
import { enqueueWatchCreate } from "../src/services/coach-apply.js";
import type { Db } from "../src/services/db.js";
import { beginRestore, finishRestore, restoreRows, startFresh } from "../src/services/account-restore.js";
import { loadAccountState, restoreInProgress, restoreStatusOf } from "../src/services/account-state.js";
import { claimNextJob } from "../src/services/jobs.js";
import { exportManifest } from "../src/services/account-export.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { seedFullAccount } from "./account-fixture.js";
import { checkFile, exportAll, restoreAll, TEST_SECRET, type ExportFile } from "./restore-driver.js";

const secret = { secret: TEST_SECRET };
const now = () => nowInstant();

function file(tables: ExportFile["tables"]): ExportFile {
  return { format: "run-garden-export", schemaVersion: SCHEMA_VERSION, exportedAt: now(), tables };
}

function job(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: "old",
    workoutId: `w-${id}`,
    kind: "coach_create_workout",
    expectedContentFingerprint: "fp",
    originalDate: "2026-10-05",
    destinationDate: "2026-10-05",
    requestedAt: "2026-09-28T09:00:00.000Z",
    status,
    claimedByDeviceId: status === "claimed" ? "cloud" : null,
    claimedAt: status === "claimed" ? "2026-09-28T09:01:00.000Z" : null,
    attemptCount: 0,
    maxAttempts: 5,
    degraded: false,
    payload: { workoutId: `w-${id}` },
    updatedAt: "2026-09-28T09:00:00.000Z",
    ...over,
  };
}

async function begin(db: Db, userId: string, f: ExportFile) {
  const { session, tokens, errors } = await checkFile(db, userId, f);
  expect(errors).toEqual([]);
  const res = await beginRestore(db, userId, { session, replace: true, tokens: [...tokens.values()] }, secret);
  if (!res.ok) throw new Error(res.error);
  return { restoreId: res.restoreId, tokens };
}

/** Make the marked restore look like it stopped a while ago. */
async function stopBeating(db: Db, userId: string): Promise<void> {
  await db
    .update(schema.accountState)
    .set({ restoreHeartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    .where(eq(schema.accountState.userId, userId));
}

describe("begin needs a clean check", () => {
  it("refuses tokens that are missing, tampered, another account's, another check's or forged", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const mine = await checkFile(db, userId, f);
    const again = await checkFile(db, userId, f); // a second check: another session
    const theirs = await checkFile(db, other, f);
    const all = (c: { tokens: Map<string, string> }) => [...c.tokens.values()];
    const [body, sig] = mine.session.split(".");
    const tamperedSession = `${body!.slice(0, -2)}AA.${sig}`;
    const [pBody, pSig] = mine.tokens.get("activities#0")!.split(".");
    const tamperedPage = `${pBody!.slice(0, -2)}AA.${pSig}`;

    const attempts: Array<{ session: unknown; tokens: unknown }> = [
      { session: undefined, tokens: all(mine) },
      { session: "nonsense", tokens: all(mine) },
      { session: tamperedSession, tokens: all(mine) },
      { session: theirs.session, tokens: all(mine) },
      { session: mine.session, tokens: undefined },
      { session: mine.session, tokens: [...all(mine), "nonsense"] },
      { session: mine.session, tokens: all(mine).map((t) => (t === mine.tokens.get("activities#0") ? tamperedPage : t)) },
      // Pages from another check of the same file are not this session's (M3).
      { session: mine.session, tokens: all(again) },
      { session: again.session, tokens: all(mine) },
      { session: mine.session, tokens: all(theirs) },
      // A page (or a session) mistaken for the other.
      { session: mine.tokens.get("activities#0"), tokens: all(mine) },
      { session: mine.session, tokens: [...all(mine), mine.session] },
    ];
    for (const attempt of attempts) {
      const res = await beginRestore(db, userId, { ...attempt, replace: true }, secret);
      expect(res).toEqual({ ok: false, status: 422, error: "check_required" });
    }
    const forged = await checkFile(db, userId, f, 200);
    const forgedSession = await beginRestore(db, userId, { session: forged.session, replace: true, tokens: all(forged) }, { secret: "some-other-secret" });
    expect(forgedSession).toEqual({ ok: false, status: 422, error: "check_required" });
    // Nothing was wiped, and no marker was set.
    expect((await exportManifest(db, userId)).tables.find((t) => t.name === "activities")?.rows).toBe(2);
    expect(await restoreInProgress(db, userId)).toBe(false);
  });

  it("begin needs every row of the manifest, each page once (M1, M2)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const checked = await checkFile(db, userId, f);
    const all = [...checked.tokens.values()];
    const one = checked.tokens.get("dismissed_insights#0") ?? checked.tokens.get("activities#0")!;
    for (const tokens of [
      [], // nothing checked
      [one], // one page of a file that holds far more (the re-review's probe)
      all.filter((t) => t !== checked.tokens.get("planned_workouts#1")), // a page missing
      [...all, checked.tokens.get("activities#0")!], // a page twice
    ]) {
      const res = await beginRestore(db, userId, { session: checked.session, replace: true, tokens }, secret);
      expect(res).toEqual({ ok: false, status: 422, error: "check_incomplete" });
    }
    expect((await exportManifest(db, userId)).tables.find((t) => t.name === "planned_workouts")?.rows).toBe(250);
    expect(await restoreInProgress(db, userId)).toBe(false);
    // The whole file, each page once: begins, as the check session's restore.
    const res = await beginRestore(db, userId, { session: checked.session, replace: true, tokens: all }, secret);
    expect(res).toMatchObject({ ok: true, restoreId: checked.restoreId });
  });

  it("an expired check says so (M10), at begin and at rows", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const old = await checkFile(db, userId, f, 200, { now: new Date(Date.now() - 25 * 3600 * 1000) });
    expect(await beginRestore(db, userId, { session: old.session, replace: true, tokens: [...old.tokens.values()] }, secret)).toEqual({
      ok: false,
      status: 422,
      error: "check_expired",
    });
    // A restore in progress, sent a page from a check that has since expired.
    const { restoreId } = await begin(db, userId, f);
    const stale = await checkFile(db, userId, f, 200, { now: new Date(Date.now() - 25 * 3600 * 1000) });
    expect(
      await restoreRows(db, userId, { restoreId, table: "activities", rows: f.tables.activities, token: stale.tokens.get("activities#0") }, secret),
    ).toEqual({ ok: false, status: 422, error: "check_expired" });
  });

  it("rows refuses a page that is not exactly the page the check signed", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { restoreId, tokens } = await begin(db, userId, f);
    const token = tokens.get("activities#0");
    const rows = f.tables.activities!;
    const edited = [{ ...rows[0]!, durationSeconds: null }, ...rows.slice(1)];
    // The same page, checked in another session: not this restore's (M3).
    const elsewhere = (await checkFile(db, userId, f)).tokens.get("activities#0");
    for (const attempt of [
      { table: "activities", rows: edited, token },
      { table: "activities", rows: rows.slice(1), token },
      { table: "activity_laps", rows, token },
      { table: "activities", rows, token: undefined },
      { table: "activities", rows, token: elsewhere },
    ]) {
      expect(await restoreRows(db, userId, { restoreId, ...attempt }, secret)).toEqual({
        ok: false,
        status: 422,
        error: "check_required",
      });
    }
    expect(await db.select().from(schema.activities).where(eq(schema.activities.userId, userId))).toEqual([]);
  });
});

describe("rows and finish need the restore in progress (finding 12)", () => {
  it("refuses rows and finish with no begin, and a stale tab's pages after a second begin", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { tokens } = await checkFile(db, userId, f);
    const page = { table: "activities", rows: f.tables.activities, token: tokens.get("activities#0") };

    expect(await restoreRows(db, userId, { restoreId: "made-up", ...page }, secret)).toEqual({
      ok: false,
      status: 409,
      error: "no_active_restore",
    });
    expect(await finishRestore(db, userId, { restoreId: "made-up" })).toEqual({ ok: false, status: 409, error: "no_active_restore" });

    const first = await begin(db, userId, f);
    // "Restore again" in another tab while the first is still sending pages
    // is refused (M6)...
    const secondCheck = await checkFile(db, userId, f);
    const tokensOf = [...secondCheck.tokens.values()];
    expect(await beginRestore(db, userId, { session: secondCheck.session, replace: true, tokens: tokensOf }, secret)).toEqual({
      ok: false,
      status: 409,
      error: "restore_running",
    });
    // ...and once the first has stopped, it replaces it.
    await stopBeating(db, userId);
    const second = await beginRestore(db, userId, { session: secondCheck.session, replace: true, tokens: tokensOf }, secret);
    if (!second.ok) throw new Error(second.error);
    expect(second.restoreId).not.toBe(first.restoreId);
    const secondPage = { ...page, token: secondCheck.tokens.get("activities#0") };
    expect(await restoreRows(db, userId, { restoreId: first.restoreId, ...page }, secret)).toMatchObject({ status: 409 });
    expect(await restoreRows(db, userId, { restoreId: second.restoreId, ...secondPage }, secret)).toMatchObject({ ok: true });
    expect(await finishRestore(db, userId, { restoreId: first.restoreId })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("unfinished work in the file lands switched off (B3)", () => {
  it("write jobs that would still run become 'restored' and can never be claimed", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const f = file({
      coros_write_jobs: [
        job("queued", "queued"),
        job("claimed", "claimed"),
        job("in_progress", "in_progress"),
        job("verifying", "verifying"),
        job("verified", "verified", { verifiedAt: "2026-09-28T10:00:00.000Z", completedAt: "2026-09-28T10:00:00.000Z" }),
        job("failed", "failed"),
      ],
    });
    await restoreAll(db, userId, f);

    const rows = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      queued: "restored",
      claimed: "restored",
      in_progress: "restored",
      verifying: "restored",
      verified: "verified",
      failed: "failed",
    });
    const restored = rows.find((r) => r.id === "claimed")!;
    expect(restored.claimedAt).toBeNull();
    expect(restored.claimedByDeviceId).toBeNull();
    expect(restored.completedAt).not.toBeNull();
    expect(isTerminalJobStatus("restored")).toBe(true);
    // Even a claim that has gone stale (the reclaim path) finds nothing.
    expect(await claimNextJob(db, userId, "cloud")).toBeNull();
  });

  it("a restored job is revived when the athlete asks for the change again (Put on watch)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const session: CoachSession = {
      title: "Legs",
      category: "strength",
      durationMinutes: 30,
      lift: {
        exercises: [{ name: "Squat", sets: 3, reps: 8, restSeconds: 60, weight: { type: "bodyweight" }, originId: "425898928110747648" }],
      },
    };
    const id = "cw-1";
    await restoreAll(db, userId, file({ coros_write_jobs: [job(`${id}-push`, "queued", { workoutId: id })] }));
    // The live add path does not re-drive it…
    await enqueueWatchCreate(db, userId, id, "2026-10-05", session, now());
    const [kept] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, `${id}-push`));
    expect(kept!.status).toBe("restored");
    // …a human asking again does.
    await enqueueWatchCreate(db, userId, id, "2026-10-05", session, now(), undefined, true);
    const [revived] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, `${id}-push`));
    expect(revived!.status).toBe("queued");
  });

  it("coach reads, triggers, the backfill and open sync intents land switched off; llm_usage as it was", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const read = (id: string, status: string) => ({
      id,
      userId: "old",
      activityId: `a-${id}`,
      status,
      attempt: 0,
      nextAttemptAt: "2026-09-28T09:00:00.000Z",
      claimToken: status === "running" ? "tok" : null,
      claimedAt: status === "running" ? "2026-09-28T09:00:00.000Z" : null,
      flags: [],
      createdAt: "2026-09-28T09:00:00.000Z",
    });
    const intent = (id: string, over: Record<string, unknown>) => ({
      id,
      userId: "old",
      targetKind: "workout",
      targetId: `w-${id}`,
      kind: "content",
      source: "user_move",
      createdAt: "2026-09-28T09:00:00.000Z",
      supersededBy: null,
      resolvedAt: null,
      ...over,
    });
    const f = file({
      coach_reads: [read("q", "queued"), read("r", "running"), read("d", "done")],
      coach_triggers: [
        { id: "t1", userId: "old", kind: "missed_run", evidence: {}, firedAt: "2026-09-28T09:00:00.000Z", consumedAt: null },
        { id: "t2", userId: "old", kind: "missed_run", evidence: {}, firedAt: "2026-09-27T09:00:00.000Z", consumedAt: "2026-09-27T10:00:00.000Z" },
      ],
      backfill_state: [{ userId: "old", status: "running", chunksCompleted: 3, activitiesIngested: 40, consecutiveEmptyChunks: 0, updatedAt: "2026-09-28T09:00:00.000Z" }],
      sync_intents: [intent("open", {}), intent("resolved", { resolvedAt: "2026-09-28T10:00:00.000Z" })],
      llm_usage: [
        {
          id: "u1",
          userId: "old",
          kind: "coach_wake",
          model: "m",
          inputTokens: 10,
          outputTokens: 10,
          costMicros: 350000,
          createdAt: "2026-09-28T09:00:00.000Z",
        },
      ],
    });
    await restoreAll(db, userId, f);

    const reads = Object.fromEntries(
      (await db.select().from(schema.coachReads).where(eq(schema.coachReads.userId, userId))).map((r) => [r.id, r.status]),
    );
    expect(reads).toEqual({ q: "skipped", r: "skipped", d: "done" });
    const triggers = await db.select().from(schema.coachTriggers).where(eq(schema.coachTriggers.userId, userId));
    expect(triggers.every((t) => t.consumedAt !== null)).toBe(true);
    expect(triggers.find((t) => t.id === "t2")!.consumedAt).toBe("2026-09-27T10:00:00.000Z");
    const [backfill] = await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId));
    expect(backfill).toMatchObject({ status: "idle", chunksCompleted: 3, activitiesIngested: 40 });
    const intents = Object.fromEntries(
      (await db.select().from(schema.syncIntents).where(eq(schema.syncIntents.userId, userId))).map((i) => [i.id, i.supersededBy]),
    );
    expect(intents).toEqual({ open: "restored", resolved: null });
    const usage = await db.select().from(schema.llmUsage).where(eq(schema.llmUsage.userId, userId));
    expect(usage.map((u) => u.costMicros)).toEqual([350000]);
  });
});

describe("insert errors and silent losses (findings 2 and 5)", () => {
  it("an insert the database refuses is a 422 naming the table and the row", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { restoreId, tokens } = await begin(db, userId, f);
    const rows = f.tables.activities!;
    const poisoned = String(rows[1]!.id);
    const original = db.insert.bind(db);
    (db as unknown as { insert: unknown }).insert = ((table: unknown) => {
      const builder = (original as (t: unknown) => { values: (v: unknown) => unknown })(table);
      const values = builder.values.bind(builder);
      builder.values = (v: unknown) => {
        const list = Array.isArray(v) ? v : [v];
        if (list.some((r) => (r as { id?: unknown }).id === poisoned)) throw new Error("NOT NULL constraint failed: activities.sport");
        return values(v);
      };
      return builder;
    }) as never;
    const res = await restoreRows(db, userId, { restoreId, table: "activities", rows, token: tokens.get("activities#0") }, secret);
    expect(res).toEqual({
      ok: false,
      status: 422,
      error: "insert_failed",
      table: "activities",
      row: 1,
      detail: "NOT NULL constraint failed: activities.sport",
    });
  });

  it("counts rows lost to a conflict, and finish names the table that came back short", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { restoreId, tokens } = await begin(db, userId, f);
    // A writer that ran before it saw the marker: it imported one of the
    // file's workouts under a fresh id, taking its COROS address.
    const victim = f.tables.planned_workouts![0]!;
    await db.insert(schema.plannedWorkouts).values({ ...(victim as object), id: newId(), userId } as never);

    const pages = [f.tables.planned_workouts!.slice(0, 200), f.tables.planned_workouts!.slice(200)];
    let lost = 0;
    for (let p = 0; p < pages.length; p += 1) {
      const res = await restoreRows(
        db,
        userId,
        { restoreId, table: "planned_workouts", rows: pages[p], token: tokens.get(`planned_workouts#${p}`) },
        secret,
      );
      if (!res.ok) throw new Error(res.error);
      lost += res.lost;
    }
    expect(lost).toBe(1);
    const done = await finishRestore(db, userId, { restoreId });
    if (!done.ok) throw new Error(done.error);
    // 250 rows in the table, but only 249 of the FILE's — the count still
    // matches because the intruder took the slot; `lost` is what says so.
    expect(done.counts.planned_workouts).toBe(250);
    const state = await loadAccountState(db, userId);
    expect(state?.restoreId).toBeNull();
  });

  it("the file wins a one-row-per-account table even over a row a writer slipped in", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const prefs = { timezone: "Europe/Paris", units: "mi" };
    const f = file({ user_preferences: [{ userId: "old", prefs, updatedAt: "2026-09-01T00:00:00.000Z" }] });
    const { restoreId, tokens } = await begin(db, userId, f);
    await db.insert(schema.userPreferences).values({ userId, prefs: { timezone: "UTC" }, updatedAt: now() });
    const res = await restoreRows(
      db,
      userId,
      { restoreId, table: "user_preferences", rows: f.tables.user_preferences, token: tokens.get("user_preferences#0") },
      secret,
    );
    expect(res).toMatchObject({ ok: true, lost: 0 });
    const [row] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
    expect(row!.prefs).toEqual(prefs);
  });
});

describe("finish and Start fresh", () => {
  it("finish clears the marker and flags the garden catch-up and the calendar reconcile", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const outcome = await restoreAll(db, userId, f, {
      beforeFinish: async () => {
        expect(await restoreInProgress(db, userId)).toBe(true);
      },
    });
    expect(outcome.short).toEqual([]);
    const state = await loadAccountState(db, userId);
    expect(state).toMatchObject({
      restoreId: null,
      calendarReconcile: { phase: "pending", sweep: true },
      gardenCatchUpPending: true,
    });
    expect(state?.restoreFinishedAt).not.toBeNull();
  });

  it("a restore that came back short may link and recreate calendar events, never delete them", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { restoreId } = await begin(db, userId, f); // no rows sent at all
    const done = await finishRestore(db, userId, { restoreId });
    if (!done.ok) throw new Error(done.error);
    expect(done.short.map((s) => s.table)).toContain("planned_workouts");
    expect((await loadAccountState(db, userId))?.calendarReconcile).toEqual({ phase: "pending", sweep: false });
  });

  it("Start fresh wipes the half-restored account and clears the marker; refused when nothing is unfinished", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    expect(await startFresh(db, userId)).toEqual({ ok: false, status: 409, error: "no_active_restore" });
    const f = await exportAll(db, userId);
    const { restoreId, tokens } = await begin(db, userId, f);
    await restoreRows(db, userId, { restoreId, table: "activities", rows: f.tables.activities, token: tokens.get("activities#0") }, secret);

    // Still running — a page just landed: another device may not (M6)...
    expect(await startFresh(db, userId)).toEqual({ ok: false, status: 409, error: "restore_running" });
    expect(await startFresh(db, userId, { restoreId: "someone-elses" })).toEqual({ ok: false, status: 409, error: "restore_running" });
    expect(await restoreInProgress(db, userId)).toBe(true);
    // ...the one running it may, and so may anyone once it has stopped.
    await stopBeating(db, userId);
    expect(await startFresh(db, userId)).toEqual({ ok: true });
    expect(await restoreInProgress(db, userId)).toBe(false);
    const manifest = await exportManifest(db, userId);
    expect(manifest.tables.filter((t) => t.name !== "users" && t.rows > 0)).toEqual([]);
    expect(await restoreRows(db, userId, { restoreId, table: "activities", rows: f.tables.activities, token: tokens.get("activities#0") }, secret)).toMatchObject({
      status: 409,
    });
  });

  it("the device running the restore may start fresh at once; the heartbeat says running or stopped", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFullAccount(db, userId);
    const f = await exportAll(db, userId);
    const { restoreId, tokens } = await begin(db, userId, f);
    expect(restoreStatusOf(await loadAccountState(db, userId))).toMatchObject({ restoreId, running: true });
    // A refused page — a stale tab of this same restore, say — neither beats
    // nor stops the heartbeat (m5): the restore sending good pages is still
    // running, and another device may not start fresh over it.
    await stopBeating(db, userId);
    const before = (await loadAccountState(db, userId))?.restoreHeartbeatAt;
    const refused = await restoreRows(db, userId, { restoreId, table: "activities", rows: [], token: tokens.get("activities#0") }, secret);
    expect(refused).toMatchObject({ ok: false, error: "check_required" });
    expect((await loadAccountState(db, userId))?.restoreHeartbeatAt).toBe(before);
    await restoreRows(db, userId, { restoreId, table: "activities", rows: f.tables.activities, token: tokens.get("activities#0") }, secret);
    expect(restoreStatusOf(await loadAccountState(db, userId))).toMatchObject({ running: true });
    const again = await restoreRows(db, userId, { restoreId, table: "activities", rows: [], token: tokens.get("activities#0") }, secret);
    expect(again).toMatchObject({ ok: false });
    expect(restoreStatusOf(await loadAccountState(db, userId))).toMatchObject({ running: true });
    expect(await startFresh(db, userId)).toEqual({ ok: false, status: 409, error: "restore_running" });
    expect(restoreStatusOf(await loadAccountState(db, userId), new Date(Date.now() + 3 * 60_000))).toMatchObject({ running: false });
    expect(await startFresh(db, userId, { restoreId })).toEqual({ ok: true });
  });
});
