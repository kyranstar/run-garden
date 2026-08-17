/**
 * INTENT CONSERVATION — the wire.
 *
 * The store leg (`intent-conservation.test.ts`) proves the app keeps what the
 * coach said. This one continues each corpus session to the watch and back:
 * the payload `applyOps` actually queued → the real `createWorkout` against the
 * stateful mock COROS server → the real `normalizeCorosSchedule` → the
 * canonical shape → compared with the coach's intent, with only the declared
 * losses applied.
 *
 * THE PAYLOAD IS NOT HAND-BUILT. For every session the app is willing to push,
 * the spec comes out of the `coros_write_jobs` row `applyOps` wrote, exactly as
 * `coros-write-cloud.ts` reads it. A test that constructs its own spec proves
 * the executor works; this one proves the executor is being ASKED the right
 * thing, which is where a dead branch hides.
 *
 * LIFT AND MOBILITY SESSIONS ARE PUSHED ANYWAY, from a spec assembled the same
 * way, because the app gate (`watchPushable`) never queues them — see the
 * app-gate test at the bottom, which is the finding rather than a workaround.
 * Their ledger entries describe what the executor really does deliver today, so
 * they stay honest for the day the gate opens instead of being written from
 * memory then.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { coachOpSchema, coachSessionSchema, nowInstant, type CoachSession } from "@rg/domain";
import { CorosClient, createWorkout, type CreateWorkoutSpec } from "@rg/coros";
import { localDateToCorosDay, normalizeCorosSchedule } from "@rg/providers";
import { applyOps, watchPushable } from "../src/services/coach-apply.js";
import { stampName } from "../src/services/coros-stamp.js";
import { mockCorosServer, nextMonday } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import {
  applyLedger,
  BENCH_ORIGIN_ID,
  canonicalOfReadback,
  canonicalOfSession,
  FIXTURES,
  REFUSALS,
  SQUAT_ORIGIN_ID,
  THRESHOLD_SEC_PER_KM,
  type Fixture,
} from "./intent-corpus.js";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);

/** Far enough out to be a real future session, well inside the executor's
 * ±(180, 240) day observation span. */
const DATE = addDaysIso(TODAY, 30);

/** The athlete's synced COROS catalog, as `exerciseNameMap` would hand it over. */
const CATALOG = new Map([
  [SQUAT_ORIGIN_ID, "Back Squat"],
  [BENCH_ORIGIN_ID, "Bench Press"],
]);

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Apply an `add` for this session with watch writes ON, and hand back both the
 * stored row and the push job the apply queued — which is `undefined` whenever
 * `watchPushable` refused, and that absence is itself an assertion elsewhere.
 */
async function applyAndQueue(session: CoachSession): Promise<{
  workoutId: string;
  job: typeof schema.corosWriteJobs.$inferSelect | undefined;
}> {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${TODAY}`,
    userId,
    date: TODAY,
    thresholdPaceSecPerKm: THRESHOLD_SEC_PER_KM,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
  const out = await applyOps(db, userId, prefs, "wire", [
    coachOpSchema.parse({ kind: "add", date: DATE, session }),
  ]);
  const workoutId = out.created[0]!;
  const [job] = await db
    .select()
    .from(schema.corosWriteJobs)
    .where(
      and(
        eq(schema.corosWriteJobs.workoutId, workoutId),
        eq(schema.corosWriteJobs.kind, "coach_create_workout"),
      ),
    );
  return { workoutId, job };
}

/**
 * The spec `coros-write-cloud.ts` would hand the executor. Built from the
 * queued job when there is one; otherwise assembled exactly as
 * `insertSession` would have, so an app-gated session is still measured
 * against the same contract rather than a convenient one.
 */
function specOf(session: CoachSession, jobPayload: unknown): CreateWorkoutSpec {
  const payload = jobPayload as
    | { happenDay: string; name: string; session: CoachSession }
    | undefined;
  return {
    happenDay: String(localDateToCorosDay(payload?.happenDay ?? DATE)),
    name: payload?.name ?? stampName(session.title, DATE),
    session: payload?.session ?? session,
    thresholdPaceSecPerKm: THRESHOLD_SEC_PER_KM,
  };
}

async function connectedClient() {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.loginWithHash(
    server.email,
    createHash("md5").update(server.password, "utf8").digest("hex"),
  );
  return { server, client };
}

async function pushAndReadBack(spec: CreateWorkoutSpec) {
  const { server, client } = await connectedClient();
  const result = await createWorkout(client, spec, { today: TODAY, catalog: CATALOG, log: noop });
  return { server, client, result };
}

describe("the coach's intent survives the trip to the watch", () => {
  for (const f of FIXTURES) {
    const refusal = Array.isArray(f.ledger.wire) ? undefined : f.ledger.wire.refused;

    if (refusal && REFUSALS[refusal].layer === "executor") {
      it(`${f.name} — the executor refuses it: ${refusal}`, async () => {
        const { job } = await applyAndQueue(f.session);
        expect(job, "a session the executor refuses must never be queued").toBeUndefined();
        const { result } = await pushAndReadBack(specOf(f.session, undefined));
        expect(result.ok, "the executor accepted a session declared unwritable").toBe(false);
        expect(result.reason).toBe("error");
        expect(result.error, "the refusal must say what it could not write").toBeTruthy();
      });
      continue;
    }

    if (refusal) {
      it(`${f.name} — the app gate refuses it: ${refusal}`, async () => {
        const { job } = await applyAndQueue(f.session);
        expect(job, "the app gate did not refuse after all").toBeUndefined();
        expect(watchPushable(f.session)).toBe(false);
        // The executor has no opinion — it would write it. Naming that keeps
        // "app-only" from being read as "the wire cannot".
        const { result } = await pushAndReadBack(specOf(f.session, undefined));
        expect(result.ok, "the executor turned out to refuse it too — reclassify").toBe(true);
      });
      continue;
    }

    const declaredLosses = Array.isArray(f.ledger.wire) ? f.ledger.wire : [];

    it(`${f.name} — ${f.exercises}`, async () => {
      const { job } = await applyAndQueue(f.session);
      const spec = specOf(f.session, job?.payload);
      const { server, client, result } = await pushAndReadBack(spec);
      expect(result.ok, result.error).toBe(true);

      // A genuine fresh read through the same client the executor used — never
      // the object the write happened to leave behind.
      const readback = normalizeCorosSchedule(
        await client.getRawSchedule(addDaysIso(DATE, -1), addDaysIso(DATE, 1)),
      );
      const arrived = readback.workouts.find((w) => w.title === spec.name);
      expect(arrived, "the pushed workout did not come back out of the normalizer").toBeDefined();

      const intent = canonicalOfSession(f.session, THRESHOLD_SEC_PER_KM);
      const actual = canonicalOfReadback(arrived!);
      const { expected, vacuous } = applyLedger(intent, actual, declaredLosses);
      expect(
        vacuous,
        `declared wire losses that no longer happen — delete them from the` +
          ` ledger for ${f.name}: ${vacuous.join(", ")}`,
      ).toEqual([]);
      expect(actual, `${f.name} did not arrive as the coach wrote it`).toEqual(expected);

      // The two losses that are not really losses but substitutions, pinned
      // precisely rather than by "whatever came back".
      expect(arrived!.title, "the wire name must be the ownership stamp").toBe(
        stampName(f.session.title, DATE),
      );
      const sent = server.programByIdInPlan(result.serverIdInPlan!);
      expect(
        arrived!.estimatedDurationSeconds,
        "the duration on the watch must be COROS's own computed one",
      ).toBe(sent!.duration);
    });
  }
});

// ── The app gate ────────────────────────────────────────────────────────────

describe("what the app is willing to send", () => {
  it("queues a push exactly when `watchPushable` says so, for every corpus session", async () => {
    for (const f of FIXTURES) {
      const { job } = await applyAndQueue(f.session);
      expect(
        job !== undefined,
        `${f.name}: watchPushable and the queue disagree`,
      ).toBe(watchPushable(f.session));
    }
  });

  it("never sends a lift or mobility session, though the executor writes them fine", async () => {
    const bodied: Fixture[] = FIXTURES.filter(
      (f) =>
        (f.session.lift?.exercises.length ?? 0) > 0 ||
        (f.session.mobility?.exercises.length ?? 0) > 0,
    );
    expect(bodied.length, "the corpus carries no lift or mobility content").toBeGreaterThan(5);

    const appOnly: string[] = [];
    const executorWrites: string[] = [];
    for (const f of bodied) {
      expect(watchPushable(f.session), `${f.name}`).toBe(false);
      appOnly.push(f.name);
      if (!Array.isArray(f.ledger.wire)) continue;
      const { result } = await pushAndReadBack(specOf(f.session, undefined));
      if (result.ok) executorWrites.push(f.name);
    }
    // The finding, as an assertion: every one of these is app-only because of
    // `watchPushable`, NOT because the wire cannot carry it. coach-apply.ts's
    // comment on that predicate says the executor "builds a structured RUN
    // program and nothing else"; it dispatches to buildStrengthProgram, and
    // coros-write-cloud already resolves the COROS catalog for exactly this case.
    expect(executorWrites.length, "no lift/mobility session reached the wire at all").toBe(
      bodied.filter((f) => Array.isArray(f.ledger.wire)).length,
    );
    expect(appOnly.length).toBe(bodied.length);
  });
});

// ── Threshold timing ────────────────────────────────────────────────────────

describe("a pace band the app does not have", () => {
  it("still reaches the watch, because the wire re-resolves the threshold at execution", async () => {
    // The live 2026-08-13 shape: the proposal is approved before the day's
    // threshold lands, so the STORED stage rows carry no target — while the
    // push, executed later, resolves the freshest reading and does.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const session = coachSessionSchema.parse({
      category: "quality",
      title: "Threshold 4×5",
      durationMinutes: 45,
      run: {
        blocks: [
          { kind: "duration", value: 15, intensity: "easy" },
          { kind: "duration", value: 5, intensity: "threshold" },
        ],
      },
    });
    const out = await applyOps(db, userId, prefs, "late-threshold", [
      coachOpSchema.parse({ kind: "add", date: DATE, session }),
    ]);
    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, out.created[0]!));
    expect(stages.every((s) => s.targetType === "none")).toBe(true);

    // …and the same session pushed WITH a threshold arrives banded.
    const { client, result } = await pushAndReadBack({
      happenDay: String(localDateToCorosDay(DATE)),
      name: stampName(session.title, DATE),
      session,
      thresholdPaceSecPerKm: THRESHOLD_SEC_PER_KM,
    });
    expect(result.ok, result.error).toBe(true);
    const arrived = normalizeCorosSchedule(
      await client.getRawSchedule(addDaysIso(DATE, -1), addDaysIso(DATE, 1)),
    ).workouts.find((w) => w.title === stampName(session.title, DATE));
    expect(arrived!.stages.map((s) => s.targetType)).toEqual(["pace", "pace"]);
    expect(result.paceTargetsOwed).toBeUndefined();
  });
});
