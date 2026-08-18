/**
 * INTENT CONSERVATION — every mutating op that can carry a session.
 *
 * This is the store leg of the instrument described in `intent-corpus.ts`: the
 * whole corpus, through the REAL `applyOps` against the in-memory harness with
 * the real migrations, projected to the canonical shape and compared with the
 * coach's own intent.
 *
 * It is parametrised on purpose. The bug class this exists to catch is not "op
 * X is wrong", it is "feature Y was verified against op X and nobody ran it
 * through op Z" — so the matrix is fixture × op, and the op list is derived
 * from `coachOpSchema` rather than written out, so an op kind that grows a
 * session cannot join the union without joining the table.
 *
 * WHAT A FAILURE MEANS HERE
 *
 *  - a canonical diff: the stored row does not say what the coach said, in the
 *    field the diff names;
 *  - "declared but did not happen": a ledger entry has rotted — the loss it
 *    describes was fixed (delete the entry) or the fixture stopped exercising
 *    it (fix the fixture);
 *  - a coverage failure: a field, an op kind, a loss reason or a refusal reason
 *    exists that nothing in the corpus travels.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  coachExerciseBlockSchema,
  coachExerciseSchema,
  coachOpSchema,
  coachSessionSchema,
  nowInstant,
  type CoachExercise,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import { applyOps } from "../src/services/coach-apply.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import {
  applyLedger,
  canonicalOfSession,
  EXERCISE_FIELDS,
  FIXTURES,
  fixture,
  LOSSES,
  readStored,
  REFUSALS,
  ROUNDS_SPELLINGS,
  SURFACE_DIVERGENCES,
  surfaceDivergenceEntries,
  THRESHOLD_SEC_PER_KM,
  type LossReason,
  type RefusalReason,
  type SurfaceDivergence,
} from "./intent-corpus.js";

/** A Monday, comfortably in the future — so `weekStart` arithmetic is trivial
 * and no op ever races the real clock. */
const DATE = "2026-10-05";
const PLAN_ID = "cp-test-block";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The session an `ease` replaces — deliberately unlike everything in the
 * corpus (distance intervals, a distinctive title) so anything of it that
 * survives the ease is visible rather than plausible. */
const SEED_SESSION: CoachSession = coachSessionSchema.parse({
  category: "quality",
  title: "SEED — 6×640 threshold",
  durationMinutes: 75,
  run: {
    blocks: [
      { kind: "duration", value: 5, intensity: "easy" },
      { kind: "distance", value: 644, intensity: "threshold" },
      { kind: "distance", value: 644, intensity: "threshold" },
      { kind: "duration", value: 5, intensity: "easy" },
    ],
  },
});

interface Ctx {
  db: Db;
  userId: string;
  prefs: UserPreferences;
  session: CoachSession;
  date: string;
}

interface OpCase {
  /** The kind in `coachOpSchema` this exercises. */
  opKind: CoachOp["kind"];
  /** The workout ids the op created or rewrote, in the order it names them. */
  run(c: Ctx): Promise<string[]>;
}

async function seedCoachPlan(db: Db, userId: string): Promise<void> {
  await db.insert(schema.coachPlans).values({
    id: PLAN_ID,
    userId,
    discipline: "run",
    name: "Test block",
    status: "active",
    startDate: "2026-01-01",
    endDate: "2027-01-01",
    stampPrefix: "Test block",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

/** The athlete's COROS threshold, on file before anything is applied — so every
 * leg of the instrument derives pace bands from the same number. */
async function seedThreshold(db: Db, userId: string): Promise<void> {
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:2026-10-01`,
    userId,
    date: "2026-10-01",
    thresholdPaceSecPerKm: THRESHOLD_SEC_PER_KM,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
}

const apply = (c: Ctx, proposalId: string, ops: unknown[]) =>
  applyOps(c.db, c.userId, c.prefs, proposalId, ops.map((o) => coachOpSchema.parse(o)));

/**
 * EVERY OP THAT CAN CARRY A SESSION. `add` appears twice because a multi-date
 * add is a genuinely different code path — one op, N rows — and the count is
 * exactly the fact prose gets wrong.
 */
const OP_CASES: Record<string, OpCase> = {
  add: {
    opKind: "add",
    run: async (c) => (await apply(c, "p-add", [{ kind: "add", date: c.date, session: c.session }])).created,
  },
  "add (multi-date)": {
    opKind: "add",
    run: async (c) =>
      (
        await apply(c, "p-multi", [
          {
            kind: "add",
            date: c.date,
            dates: [addDays(c.date, 1), addDays(c.date, 2)],
            session: c.session,
          },
        ])
      ).created,
  },
  ease: {
    opKind: "ease",
    run: async (c) => {
      const seeded = await apply(c, "p-seed", [
        { kind: "add", date: c.date, session: SEED_SESSION },
      ]);
      const workoutId = seeded.created[0]!;
      const out = await apply(c, "p-ease", [{ kind: "ease", workoutId, session: c.session }]);
      expect(out.missed, "the ease found nothing to change").toEqual([]);
      return out.updated;
    },
  },
  firmUp: {
    opKind: "firmUp",
    run: async (c) => {
      await seedCoachPlan(c.db, c.userId);
      return (
        await apply(c, "p-firm", [
          {
            kind: "firmUp",
            planId: PLAN_ID,
            weekStart: c.date,
            sessions: [{ date: c.date, session: c.session }],
          },
        ])
      ).created;
    },
  },
  reshapeWeek: {
    opKind: "reshapeWeek",
    run: async (c) => {
      await seedCoachPlan(c.db, c.userId);
      return (
        await apply(c, "p-reshape", [
          {
            kind: "reshapeWeek",
            planId: PLAN_ID,
            weekStart: c.date,
            sessions: [{ date: c.date, session: c.session }],
          },
        ])
      ).created;
    },
  },
  windDown: {
    opKind: "windDown",
    run: async (c) => {
      await seedCoachPlan(c.db, c.userId);
      return (
        await apply(c, "p-wind", [
          { kind: "windDown", planId: PLAN_ID, sessions: [{ date: c.date, session: c.session }] },
        ])
      ).created;
    },
  },
  createPlan: {
    opKind: "createPlan",
    run: async (c) => {
      const out = await apply(c, "p-create", [
        {
          kind: "createPlan",
          discipline: "run",
          name: "Fresh block",
          startDate: c.date,
          endDate: addDays(c.date, 30),
          firmSessions: [{ date: c.date, session: c.session }],
          shapeWeeks: [],
        },
      ]);
      // `created` ends with the plan row's own id — the workouts are the rest.
      return out.created.filter((id) => id !== "cp-p-create-0");
    },
  },
};

async function harness(): Promise<Ctx> {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  await seedThreshold(db, userId);
  return { db, userId, prefs, session: SEED_SESSION, date: DATE };
}

// ── The matrix ──────────────────────────────────────────────────────────────

describe("the coach's intent survives every op that can carry a session", () => {
  for (const f of FIXTURES) {
    describe(`${f.name} — ${f.exercises}`, () => {
      for (const [opName, opCase] of Object.entries(OP_CASES)) {
        it(`is conserved through \`${opName}\``, async () => {
          const ctx = { ...(await harness()), session: f.session };
          const ids = await opCase.run(ctx);
          expect(ids.length, `${opName} wrote no row at all`).toBeGreaterThan(0);

          const intent = canonicalOfSession(f.session, THRESHOLD_SEC_PER_KM);
          for (const id of ids) {
            const { canonical } = await readStored(ctx.db, id);
            const { expected, vacuous } = applyLedger(intent, canonical, f.ledger.store);
            expect(
              vacuous,
              `declared store losses that no longer happen — delete them from the ledger` +
                ` for ${f.name}: ${vacuous.join(", ")}`,
            ).toEqual([]);
            expect(canonical, `${f.name} through ${opName} (row ${id})`).toEqual(expected);
          }
        });
      }
    });
  }
});

// ── Transitions ─────────────────────────────────────────────────────────────

/**
 * A mutation that updates the prose and leaves the structure behind is
 * invisible to a per-session test: the row it produces is self-consistent, it
 * is only wrong ABOUT WHAT IT USED TO BE. So every pair below is stored as one
 * session and then mutated into another, and the reference for "correct" is not
 * a hand-written expectation but a FRESH INSERT of the second session through
 * the same writer — whatever `add` produces IS the right row, by definition.
 */
const TRANSITIONS: Array<[from: string, to: string]> = [
  ["run/every-intensity-duration", "lift/ski-prep"],
  ["lift/ski-prep", "run/single-block-no-intensity"],
  ["run/26-block-interval-session", "session/rest-day"],
  ["lift/circuit", "mobility/flow"],
  ["run/every-intensity-distance", "run/single-block-no-intensity"],
  ["mobility/flow", "session/empty-lift-body"],
];

/** Columns of `planned_workouts` that a row's IDENTITY or lifecycle decides,
 * rather than its session. Everything else must match a fresh insert — so a
 * column added for one caller and missed by the other fails here without
 * anyone remembering to add it to a list. */
const NOT_SESSION_DECIDED = new Set([
  "id",
  "userId",
  "planId",
  "sourceWorkoutId",
  "sourceProgramId",
  "sourceIdInPlan",
  "sourceVersion",
  // Records the UPSTREAM copy as the app last observed it — written by import
  // and re-stamped by the write consumer from the wire, never decided by a
  // session (2026-08-17). It used to be in `sessionColumns`, so an ease
  // overwrote what COROS holds with a hash of the local edit and destroyed the
  // evidence the second ownership proof re-reads. An `add` still SEEDS it at
  // insert, which is the only reason a fresh insert and an eased row differ.
  "sourceContentFingerprint",
  "originalPlanDate",
  "lastVerifiedCorosDate",
  "effectiveDate",
  "effectiveTime",
  "calendarSyncState",
  "completionState",
  "missingReads",
  "snoozedUntil",
  "resolutionDate",
  "sanctionedBy",
  "archivedAt",
  "archiveReason",
  "createdAt",
  "updatedAt",
]);

function sessionFacts(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !NOT_SESSION_DECIDED.has(k)));
}

describe("a session that is mutated twice still says what the coach last said", () => {
  for (const [fromName, toName] of TRANSITIONS) {
    const from = fixture(fromName);
    const to = fixture(toName);

    it(`add → ease: ${fromName} → ${toName}`, async () => {
      const ctx = await harness();
      const seeded = await apply(ctx, "t1", [{ kind: "add", date: DATE, session: from.session }]);
      const id = seeded.created[0]!;
      await apply(ctx, "t2", [{ kind: "ease", workoutId: id, session: to.session }]);

      // The reference: the destination session, inserted fresh by the writer
      // the `add` path uses.
      const reference = (
        await apply(ctx, "t3", [{ kind: "add", date: addDays(DATE, 14), session: to.session }])
      ).created[0]!;

      const eased = await readStored(ctx.db, id);
      const fresh = await readStored(ctx.db, reference);
      const intent = canonicalOfSession(to.session, THRESHOLD_SEC_PER_KM);
      const { expected } = applyLedger(intent, eased.canonical, to.ledger.store);

      expect(eased.canonical, "the eased row does not describe the new session").toEqual(expected);
      expect(sessionFacts(eased.row), "the eased row differs from a fresh insert").toEqual(
        sessionFacts(fresh.row),
      );
      expect(eased.stages.map((s) => ({ ...s, id: "", workoutId: "" }))).toEqual(
        fresh.stages.map((s) => ({ ...s, id: "", workoutId: "" })),
      );
      // Nothing of the session it replaced, anywhere on the row.
      expect(JSON.stringify(eased.row)).not.toContain(from.session.title);
    });

    it(`add → move → ease: ${fromName} → ${toName}`, async () => {
      const ctx = await harness();
      const seeded = await apply(ctx, "t1", [{ kind: "add", date: DATE, session: from.session }]);
      const id = seeded.created[0]!;
      const moved = addDays(DATE, 2);
      await apply(ctx, "t2", [{ kind: "move", workoutId: id, toDate: moved }]);
      await apply(ctx, "t3", [{ kind: "ease", workoutId: id, session: to.session }]);

      const reference = (
        await apply(ctx, "t4", [{ kind: "add", date: addDays(DATE, 14), session: to.session }])
      ).created[0]!;

      const eased = await readStored(ctx.db, id);
      const fresh = await readStored(ctx.db, reference);
      const intent = canonicalOfSession(to.session, THRESHOLD_SEC_PER_KM);
      const { expected } = applyLedger(intent, eased.canonical, to.ledger.store);

      expect(eased.row.effectiveDate, "the move did not stick").toBe(moved);
      expect(eased.canonical, "the eased row does not describe the new session").toEqual(expected);
      expect(sessionFacts(eased.row), "the eased row differs from a fresh insert").toEqual(
        sessionFacts(fresh.row),
      );
      expect(JSON.stringify(eased.row)).not.toContain(from.session.title);
    });
  }
});

// ── Named cases: the losses no fixture can carry ────────────────────────────

/**
 * Losses that depend on CONTEXT rather than on the session, so no fixture can
 * declare them. Each one is named here and exercised by the test below — the
 * coverage check reads this map, so a reason listed here without a test is as
 * visible as one with no fixture.
 */
const LOSSES_EXERCISED_BY_NAMED_CASES: Partial<Record<LossReason, string>> = {
  store_pace_band_needs_a_threshold_at_apply_time:
    "the athlete has no COROS threshold on file when the proposal is approved",
};

describe("a session applied before the athlete has a threshold", () => {
  it("stores no pace bands — and nothing ever re-derives them", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    // Deliberately NO seedThreshold: this is the state every coach push was in
    // on 2026-08-13, hours before the day's own 289 s/km reading landed.
    const f = fixture("run/every-intensity-duration");
    const out = await applyOps(db, userId, prefs, "no-threshold", [
      coachOpSchema.parse({ kind: "add", date: DATE, session: f.session }),
    ]);
    const { canonical } = await readStored(db, out.created[0]!);
    const intent = canonicalOfSession(f.session, THRESHOLD_SEC_PER_KM);
    const { expected, vacuous } = applyLedger(intent, canonical, [
      ...f.ledger.store,
      "store_pace_band_needs_a_threshold_at_apply_time",
    ]);
    expect(vacuous).toEqual([]);
    expect(canonical).toEqual(expected);

    // The threshold arriving later changes nothing already stored. The WIRE
    // re-resolves at execution time (coros-write-cloud's latestThresholdPace),
    // so a pushed session can end up with bands on the watch that its own stage
    // rows in the app do not have.
    await seedThreshold(db, userId);
    const after = await readStored(db, out.created[0]!);
    expect(after.canonical).toEqual(canonical);
  });
});

// ── Structural exhaustiveness ───────────────────────────────────────────────

describe("the corpus cannot fall behind the vocabulary", () => {
  it("covers every op kind in the union that can carry a session", () => {
    const options = coachOpSchema.options as unknown as Array<{
      shape: Record<string, unknown> & { kind: { value: CoachOp["kind"] } };
    }>;
    const carriers = options
      .filter((o) => "session" in o.shape || "sessions" in o.shape || "firmSessions" in o.shape)
      .map((o) => o.shape.kind.value)
      .sort();
    const covered = [...new Set(Object.values(OP_CASES).map((c) => c.opKind))].sort();
    expect(covered, "op kinds that carry a session but travel no fixture").toEqual(carriers);
  });

  /**
   * What an exercise looks like when the coach says nothing but its name and a
   * set count. A field is only "exercised" by the corpus when some fixture
   * moves it OFF this baseline — which is what makes adding a field with a
   * default and no fixture a test failure rather than a quiet pass.
   */
  const baseline = coachExerciseSchema.parse({ name: "baseline", sets: 1 });

  it("exercises every field of the exercise vocabulary with a non-default value", () => {
    const corpusExercises: CoachExercise[] = FIXTURES.flatMap((f) => [
      ...(f.session.lift?.exercises ?? []),
      ...(f.session.mobility?.exercises ?? []),
    ]);
    const unexercised = (Object.keys(EXERCISE_FIELDS) as Array<keyof CoachExercise>).filter(
      (field) =>
        !corpusExercises.some(
          (e) => JSON.stringify(e[field] ?? null) !== JSON.stringify(baseline[field] ?? null),
        ),
    );
    expect(
      unexercised,
      "exercise fields no corpus session carries — add a fixture, or the field" +
        " reaches the athlete untested",
    ).toEqual([]);
  });

  it("parses every accepted spelling of every field to the value it declares", () => {
    for (const [field, account] of Object.entries(EXERCISE_FIELDS) as Array<
      [keyof CoachExercise, (typeof EXERCISE_FIELDS)[keyof CoachExercise]]
    >) {
      for (const spelling of account.spellings) {
        const parsed = coachExerciseSchema.safeParse({
          name: "x",
          sets: 1,
          [field]: spelling.raw,
        });
        expect(parsed.success, `${field}: ${JSON.stringify(spelling.raw)} did not parse`).toBe(true);
        if (!parsed.success) continue;
        expect(
          parsed.data[field],
          `${field}: ${JSON.stringify(spelling.raw)} parsed to the wrong value`,
        ).toEqual(spelling.parsed);
      }
    }
  });

  it("parses every accepted spelling of `rounds`", () => {
    for (const spelling of ROUNDS_SPELLINGS) {
      const parsed = coachExerciseBlockSchema.parse({ rounds: spelling.raw, exercises: [] });
      expect(parsed.rounds, `rounds: ${JSON.stringify(spelling.raw)}`).toBe(spelling.parsed);
    }
  });

  it("declares every loss reason against a fixture or a named case", () => {
    const declared = new Set<LossReason>();
    for (const f of FIXTURES) {
      for (const r of f.ledger.store) declared.add(r);
      if (Array.isArray(f.ledger.wire)) for (const r of f.ledger.wire) declared.add(r);
    }
    for (const r of Object.keys(LOSSES_EXERCISED_BY_NAMED_CASES) as LossReason[]) declared.add(r);
    const orphaned = (Object.keys(LOSSES) as LossReason[]).filter((r) => !declared.has(r));
    expect(
      orphaned,
      "loss reasons nothing travels — either the loss is gone (delete it) or the" +
        " corpus never exercises it (add a fixture)",
    ).toEqual([]);
  });

  it("declares every refusal reason and every surface divergence against a fixture", () => {
    const refusals = new Set<RefusalReason>();
    const divergences = new Set<SurfaceDivergence>();
    for (const f of FIXTURES) {
      if (!Array.isArray(f.ledger.wire)) refusals.add(f.ledger.wire.refused);
      for (const d of f.ledger.surfaces) divergences.add(d);
    }
    expect((Object.keys(REFUSALS) as RefusalReason[]).filter((r) => !refusals.has(r))).toEqual([]);
    expect(
      (Object.keys(SURFACE_DIVERGENCES) as SurfaceDivergence[]).filter((d) => !divergences.has(d)),
    ).toEqual([]);
  });

  it("prints the ledger, so a green run still says what is lost", () => {
    const lines: string[] = [];
    for (const [reason, loss] of Object.entries(LOSSES)) {
      lines.push(`${loss.severity === "defect" ? "DEFECT" : "structural"}  ${reason}`);
    }
    for (const [reason, refusal] of Object.entries(REFUSALS)) {
      lines.push(`${refusal.layer === "app_gate" ? "APP-GATE" : "wire-limit"}  ${reason}`);
    }
    for (const [reason, d] of surfaceDivergenceEntries()) {
      lines.push(`DEFECT    ${d.pair} / ${reason}`);
    }
    // Not an assertion about the world — a receipt. The count changing is the
    // signal; the reasons are in intent-corpus.ts with a sentence each.
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ── The harness itself ──────────────────────────────────────────────────────

describe("the instrument", () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("has a corpus that parses, covers both bodies, and includes the awkward shapes", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
    expect(FIXTURES.some((f) => f.session.run?.blocks.length === 26)).toBe(true);
    expect(FIXTURES.some((f) => f.session.mobility)).toBe(true);
    expect(FIXTURES.some((f) => f.session.durationMinutes === 0)).toBe(true);
    expect(FIXTURES.some((f) => f.session.lift?.exercises.length === 0)).toBe(true);
    expect(FIXTURES.some((f) => f.session.lift?.rounds != null)).toBe(true);
  });

  it("would notice a row that quietly kept the previous session's body", async () => {
    // A negative control: the instrument's own sensitivity, proven rather than
    // assumed. Store one session, hand-write the OLD body back onto the row,
    // and the canonical comparison must reject it.
    const { userId, prefs } = await makeTestUser(db);
    const f = fixture("lift/ski-prep");
    const out = await applyOps(db, userId, prefs, "control", [
      coachOpSchema.parse({ kind: "add", date: DATE, session: f.session }),
    ]);
    const id = out.created[0]!;
    await db
      .update(schema.plannedWorkouts)
      .set({ structuredJson: { exercises: [{ name: "Bench press", sets: 5, reps: 5 }] } })
      .where(eq(schema.plannedWorkouts.id, id));
    const { canonical } = await readStored(db, id);
    expect(canonical).not.toEqual(canonicalOfSession(f.session, THRESHOLD_SEC_PER_KM));
  });
});
