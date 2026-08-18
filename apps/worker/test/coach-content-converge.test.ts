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
import { applyOps, enqueueContentConvergence, watchPushable } from "../src/services/coach-apply.js";
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
    // A session THIS APP created: ownership is proven by the stamp it left.
    expect(row.address!.proof).toBe("stamp");
    expect(row.address!.proof === "stamp" && row.address!.stamp).toContain(PUSHED.title);
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

// ── Leg 4: the sessions COROS authored — most of the athlete's plan ──────────

/**
 * THE HALF THE FIRST SHIP COULD NOT REACH.
 *
 * Everything above converges sessions THIS APP CREATED, because ownership was
 * provable only by a stamp this app had written. The athlete's plan is mostly
 * IMPORTED: COROS authored those workouts and the coach only eases them, so not
 * one of them carries a stamp, `enqueueContentConvergence` refused every one
 * with `no_recorded_stamp`, and the two sessions they actually eased (17 and 22
 * Aug) sat `calendar_only` with the original intervals still on the watch.
 *
 * The proof for those rows is the one the import already recorded — the address,
 * the day, and `source_content_fingerprint` — re-checked on the wire before a
 * byte is written. This suite is that path end to end, on real COROS-authored
 * fixture workouts, plus the failure mode that would be worse than divergence:
 * a COROS read AFTER the rewrite putting the original back.
 */
describe("an imported COROS session converges too", () => {
  /** One full COROS read → import, exactly as the sync route runs it. */
  async function readAndImport(
    db: Db,
    userId: string,
    prefs: Awaited<ReturnType<typeof makeTestUser>>["prefs"],
    server: ReturnType<typeof mockCorosServer>,
  ): Promise<void> {
    const today = todayInZone(prefs.timezone);
    const normalized = normalizeCorosSchedule(server.state.schedule);
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
        workouts: normalized.workouts,
        rangeStart: addDays(today, -40),
        rangeEnd: addDays(today, 80),
        source: "fixture",
      },
      prefs,
    );
  }

  /**
   * The live shape: a COROS-authored workout, imported, then eased. Nothing here
   * is hand-built — the row's address and fingerprint come from a real import of
   * a real fixture program the app never wrote.
   */
  async function importThenEase(title = "Threshold 5x5") {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    await seedThreshold(db, userId, todayInZone(prefs.timezone));
    await readAndImport(db, userId, prefs, server);

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.title, title)));
    expect(row, `the fixture plan's "${title}" must import`).toBeDefined();
    // The two facts the second proof is built from, both written by the import.
    expect(row!.sourceWorkoutId).toMatch(/^\d+:\d+$/);
    expect(row!.lastVerifiedCorosDate).toBe(row!.effectiveDate);
    expect(row!.sourceContentFingerprint).toBeTruthy();

    const eased = await applyOps(db, userId, prefs, "p-ease-imported", [
      coachOpSchema.parse({ kind: "ease", workoutId: row!.id, session: EASED }),
    ]);
    expect(eased.missed).toEqual([]);
    return { db, userId, prefs, server, workoutId: row!.id, date: row!.effectiveDate, row: row! };
  }

  /** Every program in the mock's plan, by idInPlan → fingerprint. */
  const planSnapshot = (server: ReturnType<typeof mockCorosServer>): Map<string, string> =>
    new Map(
      (server.state.schedule.programs ?? []).map((p) => [
        String(p.idInPlan),
        corosProgramFingerprint(p),
      ]),
    );

  it("queues a rewrite proven by what the import recorded, not by a stamp", async () => {
    const { db, userId, workoutId, date, row } = await importThenEase();

    const jobs = await updateJobs(db, userId);
    expect(jobs, "an imported session must be convergeable — this is most of the plan").toHaveLength(1);
    const payload = jobs[0]!.payload as Record<string, unknown>;
    expect(jobs[0]!.workoutId).toBe(workoutId);
    // THE SECOND PROOF, and not the first: there is no stamp, because this app
    // never created this workout and does not claim it did.
    expect(payload.recordedName).toBeUndefined();
    expect(payload.importedFingerprint).toBe(row.sourceContentFingerprint);
    expect(payload.idInPlan).toBeTruthy();
    expect(payload.programId).toBeTruthy();
    expect(payload.happenDay).toBe(date);
    // The name it will leave is the PLAIN TITLE — no ` — <date>` stamp on a
    // session inside the athlete's own COROS plan.
    expect(payload.name).toBe(EASED.title);
    expect(payload.name).not.toContain(" — ");
  });

  it("converges for real: the watch ends up holding the eased session, and nothing else moves", async () => {
    const { db, userId, prefs, server, workoutId, date } = await importThenEase();
    const before = planSnapshot(server);
    const targetIdInPlan = ((await updateJobs(db, userId))[0]!.payload as { idInPlan: string })
      .idInPlan;

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await updateJobs(db, userId);
    expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");

    // What the WATCH holds, through the real normalizer.
    const onWire = normalizeCorosSchedule(server.state.schedule).workouts.filter(
      (w) => w.date === date,
    );
    const eased = onWire.find((w) => w.title === EASED.title);
    expect(eased, "the eased session must be on the watch").toBeDefined();
    expect(eased!.stages).toHaveLength(1);
    expect(eased!.stages[0]).toMatchObject({ durationType: "time", durationSeconds: 2100 });
    expect(onWire.find((w) => w.title === "Threshold 5x5")).toBeUndefined();

    // NOTHING ELSE MOVED — every other program in the athlete's COROS plan is
    // byte-identical. An update writes over whatever is at an address.
    const after = planSnapshot(server);
    for (const [id, fp] of before) {
      if (id === targetIdInPlan) continue;
      expect(after.get(id), `program ${id} must be untouched`).toBe(fp);
    }

    // The row now says the two agree, stamped with the WIRE's own fingerprint…
    const [stored] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(stored!.corosSyncState).toBe("synced");
    expect(stored!.sourceContentFingerprint).toBe(eased!.contentFingerprint);
    // …and the content intent, which could never close, is closed.
    const intents = await db
      .select()
      .from(schema.syncIntents)
      .where(and(eq(schema.syncIntents.targetId, workoutId), eq(schema.syncIntents.kind, "content")));
    expect(intents[0]!.resolvedAt, "the approved edit is settled").toBeTruthy();
  });

  it("SURVIVES THE NEXT COROS READ — import rule 7 does not put the original back", async () => {
    // The failure mode that would be worse than the divergence itself. Rule 7
    // overwrites a row whose upstream content changed, and after the rewrite the
    // upstream content HAS changed — we changed it. If the fingerprints did not
    // line up, the very next pull would hand the athlete their intervals back
    // and the ease would flip-flop every eleven minutes.
    const { db, userId, prefs, server, workoutId, date } = await importThenEase();
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await updateJobs(db, userId))[0]!.status).toBe("verified");

    const stagesOf = async (id: string) =>
      (
        await db
          .select()
          .from(schema.plannedWorkoutStages)
          .where(eq(schema.plannedWorkoutStages.workoutId, id))
      ).sort((a, b) => a.ord - b.ord);
    const [afterWrite] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    const stagesAfterWrite = await stagesOf(workoutId);

    // TWO full reads — rule 8's absence sweep needs two to act, so one read
    // proves nothing about what a second one does.
    await readAndImport(db, userId, prefs, server);
    await readAndImport(db, userId, prefs, server);

    const [reread] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(reread, "the row must still exist").toBeDefined();
    expect(reread!.title, "the eased title must survive the read").toBe(EASED.title);
    expect(reread!.archivedAt, "and must not be archived").toBeNull();
    expect(reread!.effectiveDate).toBe(date);
    expect(reread!.sourceContentFingerprint).toBe(afterWrite!.sourceContentFingerprint);
    // The BODY, which is what the athlete actually runs: one easy 35, not the
    // interval session COROS used to hold.
    const stagesNow = await stagesOf(workoutId);
    expect(stagesNow.map((s) => [s.durationType, s.durationSeconds])).toEqual(
      stagesAfterWrite.map((s) => [s.durationType, s.durationSeconds]),
    );
    expect(stagesNow.filter((s) => s.kind !== "repeat")).toHaveLength(1);
    // And no second copy of the session appeared beside it.
    const sameDay = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.effectiveDate, date)));
    expect(sameDay.filter((w) => w.archivedAt === null)).toHaveLength(1);
  });

  it("NEVER rewrites an imported session the athlete has not edited", async () => {
    // The row is on the watch and has both halves of the second proof — and
    // that is deliberately not enough. A COROS-authored session is not ours to
    // overwrite; the only thing that entitles the app to change one is the
    // athlete having approved the change.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    await readAndImport(db, userId, prefs, server);
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(
        and(
          eq(schema.plannedWorkouts.userId, userId),
          eq(schema.plannedWorkouts.title, "Threshold 5x5"),
        ),
      );
    expect(row).toBeDefined();

    const outcome = await enqueueContentConvergence(db, {
      userId,
      workout: row!,
      session: EASED,
      now: nowInstant(),
      corosWritesEnabled: true,
    });
    expect(outcome.jobId).toBeUndefined();
    expect(outcome.refused).toBe("not_athlete_approved");
    expect(await updateJobs(db, userId)).toHaveLength(0);
  });

  it("REFUSES to unpush an imported session, because rule 8 would then delete it from the app", async () => {
    // The one place "never leave the watch prescribing withdrawn work" loses.
    // A `coach_delete_workout` is authorized BY THE STAMP and there is none —
    // and worse, removing the workout from the athlete's COROS plan makes it
    // absent upstream, which import rule 8 turns into an archive of the very
    // session they approved. A divergence beats a deletion.
    const distanceEase = parse({
      category: "easy",
      title: "Five easy kilometres",
      durationMinutes: 30,
      run: { blocks: [{ kind: "distance", value: 5000, intensity: "easy" }] },
    });
    expect(watchPushable(distanceEase), "a distance block cannot cross the wire").toBe(false);

    const { db, userId, prefs, server } = await importThenEase();
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.title, EASED.title)));
    const outcome = await enqueueContentConvergence(db, {
      userId,
      workout: row!,
      session: distanceEase,
      now: nowInstant(),
      corosWritesEnabled: true,
    });
    expect(outcome.jobId).toBeUndefined();
    expect(outcome.refused).toBe("cannot_unpush_imported");
    const deletes = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(
        and(
          eq(schema.corosWriteJobs.userId, userId),
          eq(schema.corosWriteJobs.kind, "coach_delete_workout"),
        ),
      );
    expect(deletes, "nothing may be removed from a plan this app does not own").toHaveLength(0);
    // …and the watch still holds what it held.
    expect(
      normalizeCorosSchedule(server.state.schedule).workouts.some((w) => w.title === "Threshold 5x5"),
    ).toBe(true);
  });

  it("the census calls an imported diverged row REWRITABLE, not unfixable", async () => {
    // The live prediction for `GET /api/sync/converge-content/census`: the two
    // eased rows that reported `unfixable / no_recorded_stamp` are rewrites.
    const { db, userId, prefs, server, workoutId } = await importThenEase();
    // Clear the job the ease queued, so the census is answering about the ROW
    // and the backfill has something to queue — the state those live rows are
    // in, where the ease predates the content-write kind entirely.
    await db.delete(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));

    const census = await countDivergedContent(db, userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(1);
    expect(census.unfixable).toBe(0);
    expect(census.unfixableIds).toEqual([]);

    const dry = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(dry.rows[0]!.action).toBe("rewrite");
    expect(dry.rows[0]!.evidence).toContain("open_content_intent");
    // The report says HOW ownership would be proven, so an operator can see the
    // claim before it is written.
    expect(dry.rows[0]!.address!.proof).toBe("imported");

    // And the live run queues a real job that really converges.
    const live = await convergeDivergedContent(db, userId, { dryRun: false });
    expect(live.rows[0]!.jobId).toBeTruthy();
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await updateJobs(db, userId))[0]!.status).toBe("verified");
    expect(
      normalizeCorosSchedule(server.state.schedule).workouts.some((w) => w.title === EASED.title),
    ).toBe(true);
    // Re-running finds nothing: the intent is closed.
    expect((await countDivergedContent(db, userId)).candidates).toBe(0);
    expect(workoutId).toBeTruthy();
  });

  it("an ease no longer destroys the evidence the rewrite needs", async () => {
    // `sessionColumns` used to write `fingerprint(session)` — a hash of the
    // LOCAL edit — into `source_content_fingerprint`, a column that means "the
    // upstream copy as the app last observed it". Every eased imported row
    // therefore destroyed its own ownership evidence at the exact moment it
    // created the need for it.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    await readAndImport(db, userId, prefs, server);
    const [before] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(
        and(
          eq(schema.plannedWorkouts.userId, userId),
          eq(schema.plannedWorkouts.title, "Threshold 5x5"),
        ),
      );
    expect(before!.sourceContentFingerprint.startsWith("coach-")).toBe(false);

    await applyOps(db, userId, prefs, "p-ease-keep-fp", [
      coachOpSchema.parse({ kind: "ease", workoutId: before!.id, session: EASED }),
    ]);
    const [after] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, before!.id));
    // The app's copy changed…
    expect(after!.title).toBe(EASED.title);
    // …and the record of what COROS holds did not, because COROS still holds it.
    expect(after!.sourceContentFingerprint).toBe(before!.sourceContentFingerprint);
  });

  it("a COROS read REPAIRS a row whose fingerprint an older ease overwrote", async () => {
    // THE TWO LIVE ROWS (17 and 22 Aug). They were eased before the fix above,
    // so they hold a `coach-…` hash of the eased session where the import's wire
    // fingerprint belongs, and no amount of re-easing puts it back. Import rule
    // 7's content-intent branch is the repair: it has just READ upstream, so it
    // is entitled to record what upstream says — while the app's content claim
    // still wins for the title, the stages and the dates.
    const { db, userId, prefs, server, workoutId } = await importThenEase();
    const legacy = "coach-deadbeef";
    await db
      .update(schema.plannedWorkouts)
      .set({ sourceContentFingerprint: legacy })
      .where(eq(schema.plannedWorkouts.id, workoutId));
    await db.delete(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));

    // In that state the proof cannot be made — and the census SAYS so rather
    // than promising a rewrite that would come back `stamp_mismatch`. A local
    // `coach-…` hash is not sixteen hex characters, so it is structurally not an
    // observation of the wire.
    const stuck = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(stuck.rows[0]!.action).toBe("unfixable");
    expect(stuck.rows[0]!.reason).toMatch(/NEXT COROS READ REPAIRS THIS/);
    expect(await updateJobs(db, userId)).toHaveLength(0);

    // One ordinary COROS read later, the column says what COROS says again…
    await readAndImport(db, userId, prefs, server);
    const [repaired] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(repaired!.sourceContentFingerprint).not.toBe(legacy);
    // …while the athlete's approved edit is untouched by the repair.
    expect(repaired!.title).toBe(EASED.title);
    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, workoutId));
    expect(stages.filter((st) => st.kind !== "repeat")).toHaveLength(1);

    // …and now it converges.
    await convergeDivergedContent(db, userId, { dryRun: false });
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await updateJobs(db, userId))[0]!.status).toBe("verified");
    expect(
      normalizeCorosSchedule(server.state.schedule).workouts.some((w) => w.title === EASED.title),
    ).toBe(true);
  });

  it("keeps COROS's own program id on the row, so a SECOND ease can still prove ownership", async () => {
    // `source_program_id` holds COROS's `program.id` for an imported row and
    // `planProgramId` for a created one. Re-stamping it from an in-place rewrite
    // would swap the first for the second and strand the row: the next ease
    // could never prove ownership again.
    const { db, userId, prefs, server, workoutId } = await importThenEase();
    const [before] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [after] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    expect(after!.sourceProgramId).toBe(before!.sourceProgramId);

    // And prove it by easing again, for real, end to end.
    const second = parse({
      category: "easy",
      title: "Twenty, very easy",
      durationMinutes: 20,
      run: { blocks: [{ kind: "duration", value: 20, intensity: "easy" }] },
    });
    await applyOps(db, userId, prefs, "p-ease-2", [
      coachOpSchema.parse({ kind: "ease", workoutId, session: second }),
    ]);
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const jobs = await updateJobs(db, userId);
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect(j.status, j.lastErrorCategory ?? "").toBe("verified");
    // BOTH rewrites took the imported path. The first one's payload `name` is a
    // plain title, and `recordedStampFor` must not promote it into a stamp — if
    // it did, this second ease would rename the athlete's own COROS session to
    // "Twenty, very easy — <date>" on their watch.
    for (const j of jobs) {
      const payload = j.payload as { name: string; recordedName?: string };
      expect(payload.recordedName).toBeUndefined();
      expect(payload.name).not.toContain(" — ");
    }
    expect(
      normalizeCorosSchedule(server.state.schedule).workouts.some((w) => w.title === second.title),
    ).toBe(true);
  });

  it("REFUSES when COROS's copy drifted after the import — the athlete edited it there", async () => {
    // The second proof's whole job. The address still resolves, but what is
    // there is not what we imported, so the app must not overwrite it.
    const { db, userId, prefs, server } = await importThenEase();
    const idInPlan = ((await updateJobs(db, userId))[0]!.payload as { idInPlan: string }).idInPlan;
    const program = server.programByIdInPlan(idInPlan)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: 4321 }];
    const drifted = corosProgramFingerprint(program);

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await updateJobs(db, userId);
    expect(job!.status).toBe("failed");
    expect(job!.lastErrorCategory).toBe("stamp_mismatch");
    // Nothing written, and the row says so rather than claiming success.
    expect(corosProgramFingerprint(server.programByIdInPlan(idInPlan)!)).toBe(drifted);
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, job!.workoutId));
    expect(row!.corosSyncState).toBe("sync_issue");
    // The old copy is still there, so the column that says COROS confirmed it
    // on that date is still true.
    expect(row!.lastVerifiedCorosDate).not.toBe("");
    const intents = await db
      .select()
      .from(schema.syncIntents)
      .where(
        and(eq(schema.syncIntents.targetId, job!.workoutId), eq(schema.syncIntents.kind, "content")),
      );
    expect(intents[0]!.resolvedAt, "the disagreement is not settled").toBeNull();
    // AND THE ROW SAYS WHICH REFUSAL IT WAS. Three structurally different
    // failures bucket into `stamp_mismatch` — nothing matched, several did, or
    // the match is on another day — and in prod the category alone sent an
    // operator back to the athlete's live watch to find out which. The sentence
    // the executor already produced is now kept beside it.
    expect(job!.lastErrorDetail, "the executor's own sentence is recorded").toBeTruthy();
    expect(job!.lastErrorDetail).toMatch(/does not hold what this app imported/);
    expect(job!.lastErrorDetail, "expected and found are both named").toMatch(
      /Expected program .* found program/,
    );
  });

  it("an operator re-running the backfill RETRIES a failed job; a wake does not", async () => {
    // Job ids are content-derived, so a re-request for an unchanged session
    // collides with the row already there. Live, that made the backfill report
    // "1 rewrite" while the drain then executed 0 — queued nothing, said it had.
    const { db, userId, prefs, server } = await importThenEase();
    const idInPlan = ((await updateJobs(db, userId))[0]!.payload as { idInPlan: string }).idInPlan;
    const program = server.programByIdInPlan(idInPlan)!;
    // A value the drift test above does not also use: these suites share a
    // mock server, so reusing its number would re-apply content the import had
    // already recorded and there would be no drift to refuse.
    program.exercises = [{ ...program.exercises![0]!, targetValue: 9137 }];
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await updateJobs(db, userId))[0]!.status).toBe("failed");

    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, (await updateJobs(db, userId))[0]!.workoutId));
    const args = {
      userId,
      workout: row!,
      session: EASED,
      now: nowInstant(),
      corosWritesEnabled: true,
      thresholdPaceSecPerKm: THRESHOLD,
    };

    // The automatic path leaves the failure alone — a permanently-refusing job
    // must not be re-driven on every page visit.
    await enqueueContentConvergence(db, args);
    expect((await updateJobs(db, userId))[0]!.status, "a wake does not revive it").toBe("failed");

    // The operator's explicit re-run does retry it, and clears the stale verdict
    // so the next failure cannot be read as the last one.
    await enqueueContentConvergence(db, { ...args, reviveFailed: true });
    const [revived] = await updateJobs(db, userId);
    expect(revived!.status).toBe("queued");
    expect(revived!.lastErrorCategory).toBeNull();
    expect(revived!.lastErrorDetail).toBeNull();
    expect(revived!.completedAt).toBeNull();
  });
});
