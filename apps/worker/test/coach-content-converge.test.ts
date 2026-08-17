/**
 * THE APP AND THE WATCH CONVERGE — the athlete's own complaint, end to end.
 *
 * *"my plan for today on the app and in coros completely don't match."* That was
 * structural, not a slip: every job kind could create a workout, remove one or
 * move one to another day, and none could change what a workout SAYS. So an
 * approved `ease` rewrote the app's copy, wrote the intent recording that the two
 * now disagreed, and COROS kept the original forever.
 *
 * Three legs, in the order a change travels:
 *
 *  1. `ease` queues a `coach_update_workout` carrying the ownership claim and the
 *     new content — or refuses, honestly, when the session is not on the watch.
 *  2. The write consumer executes it against the real mock account, proves the
 *     wire carries the new intent, and closes the content intent that could never
 *     close before.
 *  3. The one-shot backfill finds what diverged before any of this existed, and
 *     is honest about the rows it cannot fix.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, nowInstant, todayInZone, type CoachSession } from "@rg/domain";
import { corosProgramFingerprint, normalizeCorosSchedule } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyOps, watchPushable } from "../src/services/coach-apply.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { stampName } from "../src/services/coros-stamp.js";
import {
  convergeDivergedContent,
  countDivergedContent,
  sessionFromRow,
} from "../src/services/content-converge.js";
import { syncRoutes } from "../src/routes/sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const THRESHOLD = 289;
/** The two entries the mock COROS server's sportType=4 catalog returns. */
const SQUAT = "425898928110747648";
const BENCH = "426109589008859137";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

async function connect(db: Db, userId: string, server: ReturnType<typeof mockCorosServer>) {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(
    db,
    makeEnv(),
    userId,
    { email: server.email, pwdMd5, region: "us" },
    server.fetchImpl,
  );
  expect(res.status).toBe("connected");
}

async function seedThreshold(db: Db, userId: string, date: string) {
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${date}`,
    userId,
    date,
    thresholdPaceSecPerKm: THRESHOLD,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
}

/** The interval session the coach pushed, and the gentle one an ease replaces it
 * with — deliberately unalike, so anything of the first surviving is visible. */
const PUSHED: CoachSession = {
  category: "quality",
  title: "Threshold 5×3",
  durationMinutes: 55,
  run: {
    blocks: [
      { kind: "duration", value: 15, intensity: "easy" },
      { kind: "duration", value: 3, intensity: "threshold" },
      { kind: "duration", value: 2, intensity: "rest" },
      { kind: "duration", value: 10, intensity: "easy" },
    ],
  },
} as unknown as CoachSession;

const EASED: CoachSession = {
  category: "easy",
  title: "Easy first run back",
  durationMinutes: 35,
  run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
} as unknown as CoachSession;

const parse = (s: unknown): CoachSession =>
  (coachOpSchema.parse({ kind: "add", date: "2026-10-05", session: s }) as { session: CoachSession })
    .session;

/**
 * A coach session pushed to the mock account for real, then eased. Returns
 * everything the assertions need, so no test hand-builds a job payload: the
 * whole point is that the app is being ASKED the right thing.
 */
async function pushThenEase(
  over: { easedTo?: unknown; corosWritesEnabled?: boolean } = {},
): Promise<{
  db: Db;
  userId: string;
  prefs: Awaited<ReturnType<typeof makeTestUser>>["prefs"];
  server: ReturnType<typeof mockCorosServer>;
  workoutId: string;
  date: string;
}> {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, {
    corosWritesEnabled: over.corosWritesEnabled ?? true,
  });
  const server = mockCorosServer();
  await connect(db, userId, server);
  const today = todayInZone(prefs.timezone);
  await seedThreshold(db, userId, today);
  const date = addDays(today, 6);

  const added = await applyOps(db, userId, prefs, "p-push", [
    coachOpSchema.parse({ kind: "add", date, session: PUSHED }),
  ]);
  const workoutId = added.created[0]!;
  // Execute the create for real, so the row carries a genuine COROS address and
  // a genuine wire fingerprint — the two claims the rewrite is built from.
  await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

  const eased = await applyOps(db, userId, prefs, "p-ease", [
    coachOpSchema.parse({ kind: "ease", workoutId, session: over.easedTo ?? EASED }),
  ]);
  expect(eased.missed).toEqual([]);
  return { db, userId, prefs, server, workoutId, date };
}

const updateJobs = (db: Db, userId: string) =>
  db
    .select()
    .from(schema.corosWriteJobs)
    .where(
      and(
        eq(schema.corosWriteJobs.userId, userId),
        eq(schema.corosWriteJobs.kind, "coach_update_workout"),
      ),
    );

// ── Leg 1: the enqueue ──────────────────────────────────────────────────────

describe("an ease tells the watch", () => {
  it("queues a content rewrite carrying the ownership claim and the new session", async () => {
    const { db, userId, workoutId, date } = await pushThenEase();

    const jobs = await updateJobs(db, userId);
    expect(jobs, "the ease queued no content rewrite — COROS keeps the old body").toHaveLength(1);
    const job = jobs[0]!;
    const payload = job.payload as Record<string, unknown>;
    expect(job.workoutId).toBe(workoutId);
    expect(job.status).toBe("queued");

    // The claim: the stamp the create left, plus the whole delete triple. Every
    // field is re-proven by the executor, which is why all of them must be here.
    expect(payload.recordedName).toBe(stampName(PUSHED.title, date));
    expect(payload.idInPlan).toBeTruthy();
    expect(payload.programId).toBeTruthy();
    expect(payload.corosPlanId).toBeTruthy();
    expect(payload.happenDay).toBe(date);

    // The new content, and the stamp the rewrite will leave — the ease renamed
    // the session, and the name is what the athlete reads on the watch.
    expect(payload.name).toBe(stampName(EASED.title, date));
    expect((payload.session as CoachSession).title).toBe(EASED.title);
    expect((payload.session as CoachSession).run!.blocks).toHaveLength(1);

    // The optimistic-concurrency claim is the WIRE's fingerprint, which the
    // create stamped — not the app-side hash the ease then wrote over it.
    expect(job.expectedContentFingerprint.startsWith("coach-")).toBe(false);
  });

  it("refuses honestly when the session was never on the watch, and says so in the row", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    await seedThreshold(db, userId, today);
    const date = addDays(today, 4);
    // Added but never pushed (no COROS connection at all).
    const added = await applyOps(db, userId, prefs, "p-add", [
      coachOpSchema.parse({ kind: "add", date, session: PUSHED }),
    ]);
    const workoutId = added.created[0]!;
    await applyOps(db, userId, prefs, "p-ease", [
      coachOpSchema.parse({ kind: "ease", workoutId, session: EASED }),
    ]);

    expect(await updateJobs(db, userId)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    // Not "synced", and not an error either: COROS does not have this session.
    expect(row!.corosSyncState).toBe("calendar_only");
    expect(row!.lastVerifiedCorosDate).toBe("");
  });

  it("queues nothing at all when watch writes are off", async () => {
    const { db, userId } = await pushThenEase({ corosWritesEnabled: false });
    expect(await updateJobs(db, userId)).toHaveLength(0);
  });

  it("supersedes a rewrite that has not run yet, so the LAST ease is what lands", async () => {
    const { db, userId, prefs, workoutId } = await pushThenEase();
    const third = parse({
      category: "easy",
      title: "Twenty, very easy",
      durationMinutes: 20,
      run: { blocks: [{ kind: "duration", value: 20, intensity: "easy" }] },
    });
    await applyOps(db, userId, prefs, "p-ease-2", [
      coachOpSchema.parse({ kind: "ease", workoutId, session: third }),
    ]);

    const jobs = await updateJobs(db, userId);
    expect(jobs).toHaveLength(2);
    const live = jobs.filter((j) => j.status === "queued");
    expect(live, "two live rewrites would race, and the stale one could land last").toHaveLength(1);
    expect((live[0]!.payload as { session: CoachSession }).session.title).toBe("Twenty, very easy");
    expect(jobs.find((j) => j.status === "superseded")).toBeTruthy();
  });

  it("does not collapse an A → B → A round trip onto one job", async () => {
    // The job id is `${from}-${to}`, for exactly this. A fingerprint of the
    // DESTINATION alone would make the second leg identical to the first, and
    // `onConflictDoNothing` — which is what makes re-applying an approve
    // idempotent — would silently skip it, leaving the watch holding B forever.
    const { db, userId, prefs, server, workoutId } = await pushThenEase();
    // Let the first rewrite land, so the wire really is holding B.
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    await applyOps(db, userId, prefs, "p-back", [
      coachOpSchema.parse({ kind: "ease", workoutId, session: PUSHED }),
    ]);

    const jobs = await updateJobs(db, userId);
    expect(jobs, "the second leg was collapsed onto the first job").toHaveLength(2);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
    const queued = jobs.filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as { session: CoachSession }).session.title).toBe(PUSHED.title);
  });

  it("UNPUSHES instead when the eased session cannot cross the wire at all", async () => {
    // "Forty by feel" is a real prescription with no structure to write. Leaving
    // the watch holding 5×3 at threshold is the one indefensible option: the
    // athlete has been told the session is now forty easy minutes.
    const { db, userId, workoutId } = await pushThenEase({
      easedTo: { category: "easy", title: "Forty by feel", durationMinutes: 40, run: { blocks: [] } },
    });
    expect(await updateJobs(db, userId)).toHaveLength(0);
    const unpush = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(
        and(
          eq(schema.corosWriteJobs.workoutId, workoutId),
          eq(schema.corosWriteJobs.kind, "coach_delete_workout"),
        ),
      );
    expect(unpush, "the stale interval session was left prescribing withdrawn work").toHaveLength(1);
    expect((unpush[0]!.payload as { name: string }).name).toContain(PUSHED.title);
  });
});

// ── Leg 1b: the archive path's own version of the same hole ──────────────────

describe("archiving an eased session still takes it off the watch", () => {
  it("unpushes a row whose sync state is calendar_only because it was eased", async () => {
    // The gate here used to be `corosSyncState === "synced"`, and an eased row is
    // `calendar_only` (correctly — COROS has the old body) while still sitting on
    // the athlete's watch. So reshaping the week away skipped the unpush and left
    // the pre-ease intervals scheduled forever, inside the code path that exists
    // to prevent exactly that.
    const { db, userId, prefs, workoutId } = await pushThenEase();
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(row!.corosSyncState).not.toBe("synced");

    await applyOps(db, userId, prefs, "p-retire", [
      coachOpSchema.parse({ kind: "retirePlan", planId: row!.planId }),
    ]);
    const unpush = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(
        and(
          eq(schema.corosWriteJobs.workoutId, workoutId),
          eq(schema.corosWriteJobs.kind, "coach_delete_workout"),
        ),
      );
    expect(unpush).toHaveLength(1);
  });
});

// ── Leg 2: the wire ─────────────────────────────────────────────────────────

describe("the rewrite reaches the watch", () => {
  it("puts the eased session on COROS, restamps the row, and closes the content intent", async () => {
    const { db, userId, prefs, server, workoutId, date } = await pushThenEase();

    const res = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(res.executed).toBe(1);

    const [job] = await updateJobs(db, userId);
    expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");
    expect(job!.verifiedAt, "a verified job must say when").toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(row!.corosSyncState).toBe("synced");
    expect(row!.lastVerifiedCorosDate).toBe(date);
    // The stamp is the WIRE's own fingerprint, so a later move's content guard
    // compares like with like instead of reading `content_changed`.
    expect(row!.sourceContentFingerprint.startsWith("coach-")).toBe(false);

    // The intent that could never resolve, resolved. This is what turns
    // `content_stale` from a permanent state into one a session passes through.
    const [intent] = await db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intent!.resolvedAt, "the content intent stayed open after a verified rewrite").toBeTruthy();

    // …AND THE ACCOUNT ITSELF, which is the only claim that matters. The mock
    // server's own state, not a response object the write left behind: exactly
    // ONE placement on the day carries our stamp, and its program is the eased
    // session — one step, not four.
    const wireDay = date.replace(/-/g, "");
    const stamped = server.state.schedule.programs!.filter(
      (p) => p.name === stampName(EASED.title, date),
    );
    expect(stamped, "nothing on the wire carries the eased session's stamp").toHaveLength(1);
    const program = stamped[0]!;
    const entity = server.state.schedule.entities!.find(
      (e) => String(e.idInPlan) === String(program.idInPlan),
    );
    expect(String(entity!.happenDay)).toBe(wireDay);
    expect((program.exercises ?? []).length).toBe(1);
    expect(corosProgramFingerprint(program)).toBe(row!.sourceContentFingerprint);
    // The interval session is GONE, not sitting beside its replacement.
    expect(
      server.state.schedule.programs!.filter((p) => p.name === stampName(PUSHED.title, date)),
    ).toHaveLength(0);
  });

  it("a rewrite it cannot prove ownership of fails terminally, and the row says so", async () => {
    const { db, userId, prefs, server } = await pushThenEase();
    // The athlete renamed it in COROS: our recorded stamp is no longer there.
    // (Simulated at the source of truth — the program name IS the ownership
    // proof, so editing it is exactly the drift the executor must refuse on.)
    const jobs = await updateJobs(db, userId);
    const claim = jobs[0]!.payload as { recordedName: string };
    const program = server.state.schedule.programs!.find((p) => p.name === claim.recordedName);
    expect(program, "the fixture never actually pushed the session").toBeTruthy();
    program!.name = "My own interval session";

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [job] = await updateJobs(db, userId);
    expect(job!.status).toBe("failed");
    expect(["stamp_mismatch", "not_found", "ambiguous", "moved"]).toContain(job!.lastErrorCategory);
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, jobs[0]!.workoutId));
    // NOT a state that claims success.
    expect(row!.corosSyncState).toBe("sync_issue");
    const [intent] = await db
      .select()
      .from(schema.syncIntents)
      .where(
        and(eq(schema.syncIntents.targetId, jobs[0]!.workoutId), eq(schema.syncIntents.kind, "content")),
      );
    expect(intent!.resolvedAt, "a failed rewrite must not close the divergence").toBeNull();
  });

  it("fails a malformed payload instead of writing something it cannot read", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-bad",
      userId,
      planId: "p",
      sourceWorkoutId: "1:1",
      title: "x",
      category: "easy",
      sport: "run",
      originalPlanDate: "2026-09-01",
      lastVerifiedCorosDate: "2026-09-01",
      effectiveDate: "2026-09-01",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1800,
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(schema.corosWriteJobs).values({
      id: "j-bad",
      userId,
      workoutId: "wo-bad",
      kind: "coach_update_workout",
      expectedContentFingerprint: "fp",
      originalDate: "2026-09-01",
      destinationDate: "2026-09-01",
      payload: { workoutId: "wo-bad" }, // no claim, no session
      requestedAt: nowInstant(),
      status: "queued",
      updatedAt: nowInstant(),
    });
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, "j-bad"));
    expect(job!.status).toBe("failed");
    expect(job!.lastErrorCategory).toBe("malformed_payload");
  });
});

// ── Leg 3: the backfill ─────────────────────────────────────────────────────

describe("the convergence backfill", () => {
  /** A row eased BEFORE the content-write kind existed: the divergence is on the
   * watch and no job was ever queued for it. */
  async function legacyDivergence() {
    const ctx = await pushThenEase();
    // Delete the rewrite the ease queued, so the row is in the state the
    // athlete's live rows are in: eased, on the watch, and nothing pending.
    await db_deleteUpdateJobs(ctx.db, ctx.userId);
    return ctx;
  }
  async function db_deleteUpdateJobs(db: Db, userId: string) {
    await db
      .delete(schema.corosWriteJobs)
      .where(
        and(
          eq(schema.corosWriteJobs.userId, userId),
          eq(schema.corosWriteJobs.kind, "coach_update_workout"),
        ),
      );
  }

  it("finds an eased row whose COROS copy is stale, and says what it would write", async () => {
    const { db, userId, workoutId } = await legacyDivergence();

    const census = await countDivergedContent(db, userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(1);
    expect(census.unfixable).toBe(0);

    const dry = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.backup, "a dry run must write nothing, backup included").toBeNull();
    const row = dry.rows[0]!;
    expect(row.workoutId).toBe(workoutId);
    expect(row.evidence).toContain("open_content_intent");
    expect(row.action).toBe("rewrite");
    // What would go on the wire, visible BEFORE it goes.
    expect(row.prescription).toContain("35 min");
    expect(row.address!.stamp).toContain(PUSHED.title);
    // And nothing was queued.
    expect(await updateJobs(db, userId)).toHaveLength(0);
  });

  it("a live run backs up first, then queues the same job the ease would have", async () => {
    const { db, userId, prefs, server, workoutId } = await legacyDivergence();

    const live = await convergeDivergedContent(db, userId, { dryRun: false });
    expect(live.backup).toEqual({
      auditEventId: expect.any(String),
      kind: "coach_content_convergence_backfilled",
      table: "audit_events",
    });
    const [backup] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, live.backup!.auditEventId));
    const detail = backup!.detail as { previousWorkouts: unknown[]; workoutIds: string[] };
    expect(detail.workoutIds).toEqual([workoutId]);
    expect(detail.previousWorkouts).toHaveLength(1);

    expect(live.rows[0]!.jobId).toBeTruthy();
    expect(await updateJobs(db, userId)).toHaveLength(1);

    // …and it converges for real.
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await updateJobs(db, userId);
    expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");
    // Re-running the backfill now finds nothing: the intent is closed.
    expect((await countDivergedContent(db, userId)).candidates).toBe(0);
  });

  it("calls a row with no structure of its own UNFIXABLE, and does not invent one", async () => {
    // THE LIVE CASE. An earlier repair deleted today's stale stage rows —
    // correctly, since they described the pre-ease workout — so the app's own
    // copy of that session is now the string "35min easy" and nothing else.
    // Converging it would mean parsing a prescription out of prose.
    const { db, userId, workoutId } = await legacyDivergence();
    await db
      .delete(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, workoutId));

    const census = await countDivergedContent(db, userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(0);
    expect(census.unfixable).toBe(1);
    expect(census.unfixableIds).toEqual([workoutId]);

    const live = await convergeDivergedContent(db, userId, { dryRun: false });
    expect(live.rows[0]!.action).toBe("unfixable");
    expect(live.rows[0]!.reason).toContain("no structure to send");
    expect(live.rows[0]!.reason, "the remedy that actually works must be named").toMatch(/re-ease/i);
    expect(live.backup, "nothing to write, so nothing was written").toBeNull();
    expect(await updateJobs(db, userId)).toHaveLength(0);
  });

  it("finds a pushed session whose pace bands were never written, once a threshold exists", async () => {
    // The other live shape: the create went out before the day's threshold
    // landed, so every block reached the watch as a bare timer and nothing
    // re-pushes when a reading arrives. The create RECORDED that debt.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 8);
    // No threshold on file at apply time — the 2026-08-13 state exactly.
    const added = await applyOps(db, userId, prefs, "p-owed", [
      coachOpSchema.parse({ kind: "add", date, session: PUSHED }),
    ]);
    const workoutId = added.created[0]!;
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [push] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, workoutId));
    expect(push!.status).toBe("verified");
    expect(push!.lastErrorCategory, "the create did not record its pace debt").toBe(
      "pace_targets_owed",
    );

    // With no threshold yet, there is nothing better to write — so nothing is.
    expect((await countDivergedContent(db, userId)).candidates).toBe(0);

    // The reading arrives.
    await seedThreshold(db, userId, today);
    const census = await countDivergedContent(db, userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(1);
    const dry = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(dry.rows[0]!.evidence).toEqual(["pace_targets_never_pushed"]);

    await convergeDivergedContent(db, userId, { dryRun: false });
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await updateJobs(db, userId);
    expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");
    expect(job!.lastErrorCategory, "the rewrite still owes pace targets").toBeNull();
  });

  it("never touches a completed or archived row — its watch copy is history", async () => {
    const { db, userId, workoutId } = await legacyDivergence();
    await db
      .update(schema.plannedWorkouts)
      .set({ completionState: "completed" })
      .where(eq(schema.plannedWorkouts.id, workoutId));
    const census = await countDivergedContent(db, userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(0);
    expect(census.skipped).toBe(1);
    const dry = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(dry.rows[0]!.reason).toContain("history");
  });

  it("ignores an id it was handed that no evidence identifies", async () => {
    const { db, userId } = await legacyDivergence();
    const report = await convergeDivergedContent(db, userId, {
      dryRun: true,
      workoutIds: ["some-other-row"],
    });
    expect(report.rows).toHaveLength(0);
  });
});

// ── The projection ──────────────────────────────────────────────────────────

describe("the app's own copy, as a session", () => {
  it("is a faithful projection of the stage rows, not a re-read of the summary", async () => {
    const { db, userId, workoutId } = await pushThenEase({ easedTo: PUSHED });
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, workoutId));
    const session = sessionFromRow(row!, stages)!;
    expect(session).toBeTruthy();
    expect(session.run!.blocks.map((b) => b.value)).toEqual([15, 3, 2, 10]);
    expect(session.run!.blocks.map((b) => b.intensity)).toEqual([
      "easy",
      "threshold",
      "rest",
      "easy",
    ]);
    expect(watchPushable(session)).toBe(true);
    void userId;
  });

  it("is null when there is nothing stored to project", async () => {
    const { db, workoutId } = await pushThenEase();
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(sessionFromRow(row!, [])).toBeNull();
  });

  it("carries a lift's movements through verbatim, so it can cross the wire", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    const lift = parse({
      category: "strength",
      title: "Ski legs",
      durationMinutes: 40,
      lift: {
        exercises: [
          { name: "Wall sit", originId: SQUAT, sets: 3, holdSeconds: "45s" },
        ],
      },
    });
    const added = await applyOps(db, userId, prefs, "p-lift", [
      coachOpSchema.parse({ kind: "add", date: addDays(today, 3), session: lift }),
    ]);
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, added.created[0]!));
    const session = sessionFromRow(row!, [])!;
    expect(session.lift!.exercises[0]!.originId).toBe(SQUAT);
    expect(session.lift!.exercises[0]!.holdSeconds).toBe(45);
    expect(watchPushable(session)).toBe(true);
  });
});

// ── The route contract ──────────────────────────────────────────────────────

describe("POST /api/sync/converge-content", () => {
  const ENV = makeEnv();

  async function app() {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { corosWritesEnabled: true });
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    return { db, userId, cookie, app: mountRoutes(db, "/api/sync", syncRoutes) };
  }

  it("refuses a body with no dryRun — it is never defaulted in the writing direction", async () => {
    const { app: a, cookie } = await app();
    const res = await a.request(
      "/api/sync/converge-content",
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("refuses an unknown field, so a typo cannot silently mean 'live'", async () => {
    const { app: a, cookie } = await app();
    const res = await a.request(
      "/api/sync/converge-content",
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, dry_run: false }),
      },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it("serves a read-only census", async () => {
    const { app: a, cookie } = await app();
    const res = await a.request(
      "/api/sync/converge-content/census",
      { headers: { Cookie: cookie } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      candidates: 0,
      rewrites: 0,
      unfixable: 0,
    });
  });
});

// ── The strength prescription's last mile ───────────────────────────────────

describe("a lift session survives the round trip through the watch", () => {
  /**
   * THE ATHLETE'S GOBLET SQUAT, as a chain rather than a symptom. It rendered
   * as a bare movement name — no sets, no reps, no weight — and every link was
   * broken at once: the push path wrote all four numbers, `normalize.ts`
   * discarded three of them, and `planned_workout_stages` had nowhere to put
   * them if it hadn't. Fixing the reader alone just moved the wall to the
   * database, so this asserts the WHOLE chain: coach session → real wire →
   * real normalizer → stored columns.
   */
  it("stores the reps, load, rest and cue that used to stop at the database", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    // The athlete's synced COROS catalog. Without it `buildStrengthProgram`
    // refuses every movement — which is the gate's own rule, correctly, and
    // would make this test pass for the wrong reason.
    await db.insert(schema.corosExercises).values([
      { id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() },
      { id: BENCH, name: "Bench Press", raw: {}, updatedAt: nowInstant() },
    ]);
    const today = todayInZone(prefs.timezone);
    const date = addDays(today, 5);

    const lift = parse({
      category: "strength",
      title: "Goblet day",
      durationMinutes: 40,
      lift: {
        exercises: [
          {
            name: "Goblet squat",
            originId: SQUAT,
            sets: 3,
            reps: 8,
            weight: "20kg",
            restSeconds: 90,
            eccentricSeconds: 4,
          },
          {
            name: "Copenhagen plank",
            originId: BENCH,
            sets: 2,
            holdSeconds: 30,
            perSide: true,
            restSeconds: 20,
          },
        ],
      },
    });

    // The gate lets it through, and the executor writes it — both halves of the
    // change that opened lift pushes.
    expect(watchPushable(lift)).toBe(true);
    const added = await applyOps(db, userId, prefs, "p-goblet", [
      coachOpSchema.parse({ kind: "add", date, session: lift }),
    ]);
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [pushJob] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.workoutId, added.created[0]!));
    expect(pushJob!.status, pushJob!.lastErrorCategory ?? "").toBe("verified");

    // …and now the way back in, as the athlete's own Goblet Squat arrives: a
    // strength session COROS holds, imported fresh. The local row is dropped
    // first so the import CREATES one — with the row still present the two
    // fingerprints agree (the create stamped the wire's own), import rule 7
    // correctly does nothing, and this would assert against stage rows nobody
    // wrote.
    await db.delete(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, userId));
    const normalized = normalizeCorosSchedule(server.state.schedule);
    const arrived = normalized.workouts.find((w) => w.title === stampName(lift.title, date));
    expect(arrived, "the pushed lift did not come back out of the normalizer").toBeDefined();
    await importPlanSnapshot(
      db,
      {
        userId,
        plan: {
          sourcePlanId: normalized.planId,
          name: normalized.planName,
          ...(normalized.planStart ? { startDate: normalized.planStart } : {}),
          ...(normalized.planEnd ? { endDate: normalized.planEnd } : {}),
        },
        workouts: [arrived!],
        rangeStart: addDays(date, -1),
        rangeEnd: addDays(date, 1),
        source: "fixture",
      },
      prefs,
    );

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.sourceWorkoutId, arrived!.sourceWorkoutId));
    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, row!.id));
    const leaves = stages.filter((s) => s.kind !== "repeat").sort((a, b) => a.ord - b.ord);
    expect(leaves.length).toBeGreaterThan(0);

    // SETS always survived (the repeat container). These four did not.
    const goblet = leaves[0]!;
    expect(goblet.reps, "reps stopped at the database").toBe(8);
    expect(goblet.loadKg, "load stopped at the database").toBeCloseTo(20, 3);
    expect(goblet.restSeconds, "rest stopped at the database").toBe(90);
    // Tempo and per-side have no wire field at all — they ride in the step's
    // own prose, which is now kept rather than dropped.
    expect(goblet.note, "the eccentric tempo disclosure was dropped").toContain("4s down");
    const perSide = leaves.find((s) => (s.note ?? "").includes("each side"));
    expect(perSide, "the per-side disclosure was dropped").toBeTruthy();
    // A bodyweight step is a real prescription, not a missing load — recorded
    // in its own column because the wire states it with the value ABSENT.
    expect(perSide!.loadBodyweight).toBe(true);
    expect(perSide!.loadKg).toBeNull();
  });
});
