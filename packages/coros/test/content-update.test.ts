/**
 * CONVERGENCE: the app and the watch stop holding different workouts.
 *
 * The live failure this file is about: the coach eased a session that had
 * already been pushed, the app said "Easy first run back, 35min easy", and the
 * athlete's COROS calendar kept the original hard session forever, because the
 * write path had no verb for "change what this workout IS". Every test below
 * ends at the real `normalizeCorosSchedule` reading the stateful mock — what the
 * WATCH would receive, never the shape of the code that built it.
 *
 * The adversarial half is the point of the module. An update WRITES OVER
 * whatever is at the address it is given, and COROS recycles `idInPlan` slots,
 * so a stale remembered id can point at a workout the athlete built by hand. An
 * earlier audit reproduced exactly that destruction in the move fallback. Every
 * case here asserts the same two things: the refusal category, and that not one
 * byte was written.
 */

import { describe, expect, it } from "vitest";
import type { CoachSession } from "@rg/domain";
import {
  corosProgramFingerprint,
  normalizeCorosSchedule,
  type RawCorosEntity,
} from "@rg/providers";
import { CorosClient } from "../src/client.js";
import {
  createWorkout,
  type CreateResult,
  type CreateWorkoutSpec,
} from "../src/create-executor.js";
import {
  updateWorkoutContent,
  type ImportProvenTarget,
  type StampProvenTarget,
  type UpdateWorkoutContentOptions,
} from "../src/content-executor.js";
import { mockCorosServer, nextMonday, type MockCorosServer } from "./mock-coros-server.js";

import { createHash } from "node:crypto";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);
/** The athlete's real COROS threshold (prod: 289 s/km since 2026-08-13). */
const THRESHOLD = 289;

const SQUAT_ID = "425898928110747648";
const BENCH_ID = "426109589008859137";
const CATALOG = new Map([
  [SQUAT_ID, "Back Squat"],
  [BENCH_ID, "Bench Press"],
]);

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const corosDay = (iso: string): string => iso.replaceAll("-", "");

/** The day everything in this file happens on, and its wire form. */
const DATE = addDaysIso(TODAY, 20);
const HAPPEN_DAY = corosDay(DATE);

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.loginWithHash(
    server.email,
    createHash("md5").update(server.password, "utf8").digest("hex"),
  );
  return { server, client };
}

/** The session as it went to the watch: 15 easy / 3×(4 threshold + 2 walk) / 10 easy. */
const hardSession: CoachSession = {
  category: "quality",
  title: "Threshold 3×4",
  durationMinutes: 43,
  run: {
    blocks: [
      { kind: "duration", value: 15, intensity: "easy" },
      { kind: "duration", value: 4, intensity: "threshold" },
      { kind: "duration", value: 2, intensity: "rest" },
      { kind: "duration", value: 4, intensity: "threshold" },
      { kind: "duration", value: 2, intensity: "rest" },
      { kind: "duration", value: 10, intensity: "easy" },
    ],
  },
};

/** What the coach wrote after a bad night: one easy 35. */
const easedSession: CoachSession = {
  category: "easy",
  title: "Easy first run back",
  durationMinutes: 35,
  run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
};

/** The coach's stamp grammar (`coros-stamp.ts`): title — date. */
const stamp = (title: string): string => `${title} — ${DATE}`;

const pushSpec = (over: Partial<CreateWorkoutSpec> = {}): CreateWorkoutSpec => ({
  happenDay: HAPPEN_DAY,
  name: stamp(hardSession.title),
  session: hardSession,
  thresholdPaceSecPerKm: THRESHOLD,
  ...over,
});

/** Push a session for real, then hand back the address the server chose. */
async function pushed(
  spec: CreateWorkoutSpec = pushSpec(),
): Promise<{
  server: MockCorosServer;
  client: CorosClient;
  result: CreateResult;
  target: StampProvenTarget;
}> {
  const { server, client } = await setup();
  const result = await createWorkout(client, spec, { today: TODAY, catalog: CATALOG, log: noop });
  expect(result.ok, result.error).toBe(true);
  return {
    server,
    client,
    result,
    target: {
      happenDay: spec.happenDay,
      name: spec.name,
      idInPlan: result.serverIdInPlan!,
      programId: result.serverProgramId!,
      planId: result.serverPlanId!,
    },
  };
}

const options = (over: Partial<UpdateWorkoutContentOptions> = {}): UpdateWorkoutContentOptions => ({
  catalog: CATALOG,
  today: TODAY,
  log: noop,
  ...over,
});

/** What the watch holds for `name`, straight out of the real normalizer. */
async function onTheWatch(client: CorosClient, name: string) {
  const raw = await client.getRawSchedule(addDaysIso(DATE, -3), addDaysIso(DATE, 3));
  return normalizeCorosSchedule(raw).workouts.find((w) => w.title === name);
}

/** How many workouts the mock's target plan holds on the day under test. */
function entitiesOnTheDay(server: MockCorosServer): number {
  return (server.state.schedule.entities ?? []).filter(
    (e) => Number(e.happenDay) === Number(HAPPEN_DAY),
  ).length;
}

/** Every program in the mock's target plan, by idInPlan → fingerprint. */
function planSnapshot(server: MockCorosServer): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of server.state.schedule.programs ?? []) {
    out.set(String(p.idInPlan), corosProgramFingerprint(p));
  }
  return out;
}

// ── 1. The whole point: an eased session reaches the watch ───────────────────

describe("an eased session is rewritten on the watch, in place", () => {
  it("replaces the hard prescription with the easy one and keeps the address", async () => {
    const spec = pushSpec();
    const { server, client, target, result: created } = await pushed(spec);

    // What the watch held before: six blocks, threshold bands and walk-backs.
    const before = await onTheWatch(client, spec.name);
    expect(before!.stages).toHaveLength(6);
    expect(before!.stages[1]).toMatchObject({ targetType: "pace", targetLow: 289 });

    const writesBefore = server.counts.scheduleWrites;
    const onDayBefore = entitiesOnTheDay(server);
    const update = await updateWorkoutContent(
      client,
      {
        target,
        name: stamp(easedSession.title), // the ease renamed the session
        session: easedSession,
        thresholdPaceSecPerKm: THRESHOLD,
      },
      options(),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.reason).toBeUndefined();
    expect(update.pathUsed).toBe("in_place_update");
    expect(update.code).toBe("0000");
    // ONE write. Not a delete and a create — the workout's COROS identity is
    // exactly what it was, which is what makes a later move still addressable.
    expect(server.counts.scheduleWrites).toBe(writesBefore + 1);
    expect(update.serverIdInPlan).toBe(created.serverIdInPlan);
    expect(update.serverProgramId).toBe(created.serverProgramId);
    expect(update.serverPlanId).toBe(created.serverPlanId);
    expect(update.serverHappenDay).toBe(DATE);

    // …and the wire now IS the new intent, read back through the real
    // normalizer: one easy 35-minute block with the easy band.
    const after = await onTheWatch(client, stamp(easedSession.title));
    expect(after, "the eased session must be on the watch under its new stamp").toBeDefined();
    expect(after!.stages).toHaveLength(1);
    expect(after!.stages[0]).toMatchObject({
      kind: "work",
      durationType: "time",
      durationSeconds: 2100,
      targetType: "pace",
      targetLow: 349,
      targetHigh: 409,
    });
    expect(after!.date).toBe(DATE); // the day never moved
    expect(after!.sport).toBe("run");
    // The old session is GONE — not sitting alongside as a duplicate — and the
    // day gained nothing (the fixture plan has its own workouts there too).
    expect(await onTheWatch(client, spec.name)).toBeUndefined();
    expect(entitiesOnTheDay(server)).toBe(onDayBefore);
  });

  it("hands back the fingerprint the next read will return", async () => {
    // The create path returns `wireFingerprint` for exactly this reason: the
    // app-side fingerprint of an eased session describes a program that was
    // never written, and a later move's content guard reads that as
    // `content_changed`. A rewrite has to refresh it or it re-breaks the guard.
    const { client, target } = await pushed();

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    const after = await onTheWatch(client, target.name);
    expect(update.wireFingerprint).toBe(after!.contentFingerprint);
    expect(update.observedFingerprint).toBe(update.wireFingerprint);
  });

  it("is idempotent: running it twice sends one write", async () => {
    const { server, client, target } = await pushed();
    const spec = { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD };

    const first = await updateWorkoutContent(client, spec, options());
    const writesAfterFirst = server.counts.scheduleWrites;
    const second = await updateWorkoutContent(client, spec, options());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe("already_current");
    expect(second.pathUsed).toBeUndefined();
    expect(server.counts.scheduleWrites).toBe(writesAfterFirst); // no second write
    expect(second.wireFingerprint).toBe(first.wireFingerprint);
  });

  it("reports the pace debt when there is no threshold to band with", async () => {
    const { client, target } = await pushed();

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession }, // no threshold: bare timer
      options(),
    );

    expect(update.ok).toBe(true);
    expect(update.paceTargetsOwed).toBe(1);
    const after = await onTheWatch(client, target.name);
    expect(after!.stages[0]!.targetType).toBe("none");
  });

  it("refuses a session the builders refuse, before any wire call", async () => {
    const { server, client, target } = await pushed();
    const writesBefore = server.counts.scheduleWrites;
    const queriesBefore = server.counts.scheduleQuery;

    const update = await updateWorkoutContent(
      client,
      {
        target,
        session: {
          category: "quality",
          title: "Five k",
          durationMinutes: 25,
          run: { blocks: [{ kind: "distance", value: 5000, intensity: "threshold" }] },
        } as CoachSession,
      },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("error");
    expect(update.error).toMatch(/distance targets are not spike-verified/);
    // Not one request, let alone one write: validation happens first.
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(server.counts.scheduleQuery).toBe(queriesBefore);
  });
});

// ── 2. The coach's full vocabulary, rewritten ───────────────────────────────

describe("a lift session is rewritten with all four of its numbers", () => {
  /** 3×10 goblet squats at 24 kg, 90s rest — as pushed. */
  const heavy: CoachSession = {
    category: "strength",
    title: "Legs A",
    durationMinutes: 40,
    lift: {
      exercises: [
        {
          name: "Goblet Squat",
          originId: SQUAT_ID,
          sets: 3,
          reps: 10,
          weight: { type: "kg", value: 24 },
          restSeconds: 90,
        },
      ],
    },
  } as CoachSession;

  /** The ease: two sets of eight at 16 kg, and a 4-second lowering. */
  const backedOff: CoachSession = {
    category: "strength",
    title: "Legs A",
    durationMinutes: 25,
    lift: {
      exercises: [
        {
          name: "Goblet Squat",
          originId: SQUAT_ID,
          sets: 2,
          reps: 8,
          eccentricSeconds: 4,
          weight: { type: "kg", value: 16 },
          restSeconds: 120,
        },
      ],
    },
  } as CoachSession;

  it("carries sets, reps, load and rest across the rewrite", async () => {
    const spec = pushSpec({ name: stamp("Legs A"), session: heavy, thresholdPaceSecPerKm: undefined });
    const { server, client, target } = await pushed(spec);

    const before = await onTheWatch(client, spec.name);
    expect(before!.sport).toBe("strength");
    expect(before!.stages.find((s) => s.kind === "repeat")!.repeatCount).toBe(3);
    expect(before!.stages.find((s) => s.kind === "work")).toMatchObject({
      reps: 10,
      loadKg: 24,
      restSeconds: 90,
    });

    const writesBefore = server.counts.scheduleWrites;
    const update = await updateWorkoutContent(client, { target, session: backedOff }, options());

    expect(update.ok, update.error).toBe(true);
    expect(update.pathUsed).toBe("in_place_update");
    expect(server.counts.scheduleWrites).toBe(writesBefore + 1);

    const after = await onTheWatch(client, spec.name);
    expect(after!.stages.find((s) => s.kind === "repeat")!.repeatCount).toBe(2);
    expect(after!.stages.find((s) => s.kind === "work")).toMatchObject({
      reps: 8,
      loadKg: 16,
      restSeconds: 120,
      note: "4s down", // the tempo the wire has no field for
    });
  });

  it("rewrites a mobility session, holds and per-side work included", async () => {
    const flow: CoachSession = {
      category: "yoga",
      title: "Hips",
      durationMinutes: 15,
      mobility: {
        exercises: [
          {
            name: "Couch stretch",
            originId: BENCH_ID,
            sets: 2,
            holdSeconds: 60,
            perSide: true,
            weight: { type: "bodyweight" },
            restSeconds: 0,
          },
        ],
      },
    } as CoachSession;
    const shorter: CoachSession = {
      ...flow,
      durationMinutes: 8,
      mobility: {
        rounds: 2, // …and it becomes a circuit
        exercises: [
          {
            name: "Couch stretch",
            originId: BENCH_ID,
            sets: 1,
            holdSeconds: 30,
            perSide: true,
            weight: { type: "bodyweight" },
            restSeconds: 0,
          },
        ],
      },
    } as CoachSession;

    const spec = pushSpec({ name: stamp("Hips"), session: flow, thresholdPaceSecPerKm: undefined });
    const { client, target } = await pushed(spec);
    const before = await onTheWatch(client, spec.name);
    // 2 sets × 60s per side = two 60-second children under one container.
    expect(before!.stages.filter((s) => s.durationSeconds === 60)).toHaveLength(2);

    const update = await updateWorkoutContent(client, { target, session: shorter }, options());
    expect(update.ok, update.error).toBe(true);

    const after = await onTheWatch(client, spec.name);
    const repeat = after!.stages.find((s) => s.kind === "repeat")!;
    expect(repeat.repeatCount).toBe(2); // rounds
    const children = after!.stages.filter((s) => s.parentStageId === repeat.id);
    expect(children).toHaveLength(2); // per side
    expect(children.map((s) => s.durationSeconds)).toEqual([30, 30]);
    expect(children[0]!.loadBodyweight).toBe(true);
    expect(children[0]!.note).toBe("each side");
  });
});

// ── 3. Nothing that is not ours is ever written over ─────────────────────────

describe("ownership is re-proven, and a stale address is never trusted", () => {
  it("refuses when the address now holds a FOREIGN workout (idInPlan recycled)", async () => {
    const { server, client, target } = await pushed();
    // The athlete deleted our session in COROS and built their own; the server
    // handed the recycled slot to it. The recorded address is intact and points
    // at a workout we did not write — the exact destruction the move fallback
    // once reproduced.
    const stolen = server.programByIdInPlan(target.idInPlan)!;
    stolen.name = "Sunday hills with the club";
    const foreignBefore = corosProgramFingerprint(stolen);
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("stamp_mismatch");
    expect(server.counts.scheduleWrites).toBe(writesBefore); // not one byte
    expect(corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!)).toBe(foreignBefore);
    expect(server.programByIdInPlan(target.idInPlan)!.name).toBe("Sunday hills with the club");
    // The athlete's own title never reaches a caller-visible string.
    expect(JSON.stringify(update)).not.toContain("Sunday hills");
  });

  it("refuses — and creates nothing — when the workout is gone from COROS", async () => {
    const { server, client, target } = await pushed();
    server.state.schedule.entities = (server.state.schedule.entities ?? []).filter(
      (e) => String(e.idInPlan) !== target.idInPlan,
    );
    server.state.schedule.programs = (server.state.schedule.programs ?? []).filter(
      (p) => String(p.idInPlan) !== target.idInPlan,
    );
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("not_found");
    // The DEFAULT is to refuse: a missing workout usually means the athlete
    // removed it, and re-creating it would overrule them.
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("refuses when our own stamp sits on another day", async () => {
    const { server, client, target } = await pushed();
    const moved = addDaysIso(DATE, 2);
    server.entityByIdInPlan(target.idInPlan)!.happenDay = Number(corosDay(moved));
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("moved");
    expect(update.serverHappenDay).toBe(moved); // actionable: the caller can re-address
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("refuses when two workouts share the stamp", async () => {
    const { server, client, target } = await pushed();
    // A second placement carrying the same stamp: ownership is no longer
    // decidable, so nothing may be rewritten (INVARIANT 5). The same read also
    // makes the write address shared, which the delete-address guard would
    // catch even if this check were removed.
    const twin = server.entityByIdInPlan(target.idInPlan)!;
    server.state.schedule.entities!.push({
      ...twin,
      id: "sv-entity-twin",
      happenDay: Number(corosDay(addDaysIso(DATE, 1))),
    });
    const writesBefore = server.counts.scheduleWrites;
    const snapshot = planSnapshot(server);

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(planSnapshot(server)).toEqual(snapshot); // every program untouched
  });

  it("refuses when the link key resolves to both our program and one we did not write", async () => {
    const { server, client, target } = await pushed();
    server.state.schedule.programs!.push({
      id: "sv-program-foreign",
      idInPlan: target.idInPlan, // same link key, different program
      planId: target.planId,
      name: "Coach Jo's tempo",
      sportType: 1,
    });
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(JSON.stringify(update)).not.toContain("Coach Jo");
  });

  it("refuses a rename onto a stamp the plan already carries", async () => {
    const { server, client, target } = await pushed();
    // The athlete already has our other session on the calendar under the name
    // this rewrite wants. Two placements under one stamp make every later
    // delete ambiguous, so the rename is refused rather than performed.
    await createWorkout(
      client,
      pushSpec({
        happenDay: corosDay(addDaysIso(DATE, 3)),
        name: stamp(easedSession.title),
        session: easedSession,
      }),
      { today: TODAY, catalog: CATALOG, log: noop },
    );
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      {
        target,
        name: stamp(easedSession.title),
        session: easedSession,
        thresholdPaceSecPerKm: THRESHOLD,
      },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("writes to the PROVEN address when the server renumbered the workout", async () => {
    const { server, client, target } = await pushed();
    // The server moved our workout to another slot (live-observed on create).
    // The recorded id is stale; the stamp is the authority.
    const entity = server.entityByIdInPlan(target.idInPlan)!;
    const program = server.programByIdInPlan(target.idInPlan)!;
    entity.idInPlan = "45";
    entity.planProgramId = "45";
    program.idInPlan = "45";

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.serverIdInPlan).toBe("45"); // the caller can heal its record
    const after = await onTheWatch(client, target.name);
    expect(after!.stages).toHaveLength(1);
  });

  it("refuses without a plan scope, and outside the observable span", async () => {
    const { server, client, target } = await pushed();
    const writesBefore = server.counts.scheduleWrites;

    const unscoped = await updateWorkoutContent(
      client,
      { target: { ...target, planId: "" }, session: easedSession },
      options(),
    );
    const faraway = await updateWorkoutContent(
      client,
      { target: { ...target, happenDay: corosDay(addDaysIso(TODAY, 400)) }, session: easedSession },
      options(),
    );

    expect(unscoped.reason).toBe("no_target_plan");
    expect(faraway.reason).toBe("out_of_span");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });
});

// ── 4. Server and network failures ──────────────────────────────────────────

describe("a write that does not land is never reported as one that did", () => {
  it("reports a clean server rejection and leaves the workout untouched", async () => {
    const { server, client, target } = await pushed();
    server.updateRejectResult = "1031";
    const before = corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!);

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("rejected");
    expect(update.code).toBe("1031");
    expect(update.observedFingerprint).toBe(before); // provably unchanged
    expect(corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!)).toBe(before);
  });

  it("verifies from the read-back when the response is lost mid-write", async () => {
    const { server, client, target } = await pushed();
    // The write lands, the response never arrives. The only honest answer comes
    // from reading: the wire matches the intent, so the rewrite IS verified.
    server.throwAfterApplyOnce = true;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.pathUsed).toBe("in_place_update");
    expect(update.code).toBeUndefined(); // no envelope ever came back
    const after = await onTheWatch(client, target.name);
    expect(after!.stages).toHaveLength(1);
  });

  it("refuses to call it verified when the write also changed a workout it did not target", async () => {
    // A server that matched the write address loosely would land our program on
    // somebody else's workout as well as ours — and a read-back that only
    // checks OUR half would call that a success. `deleteWorkout` has always
    // asserted "nothing was taken with it"; this is the same assertion for an
    // overwrite.
    const { server, target } = await pushed();
    const victim = (server.state.schedule.programs ?? []).find(
      (p) => String(p.idInPlan) !== target.idInPlan,
    )!;
    const sloppy: typeof fetch = async (input, init) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const res = await server.fetchImpl(input, init);
      if (href.includes("/training/schedule/update") && String(init?.body).includes('"status":2')) {
        victim.name = `${String(victim.name)} (clobbered)`;
      }
      return res;
    };
    const client = new CorosClient({ region: "us", fetchImpl: sloppy, logger: noop });
    await client.loginWithHash(
      server.email,
      createHash("md5").update(server.password, "utf8").digest("hex"),
    );

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("verification_failed");
    expect(update.error).toMatch(/DID NOT TARGET/);
    expect(update.error).toContain(String(victim.idInPlan));
  });

  it("reports a retryable error when the request dies before landing", async () => {
    const { server, client, target } = await pushed();
    server.throwBeforeApplyOnce = true;
    const before = corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!);

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options(),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("error"); // nothing written: safe to retry
    expect(update.observedFingerprint).toBe(before);
    expect(corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!)).toBe(before);
  });
});

// ── 5. The opt-in fallback: converge by re-creating ─────────────────────────

describe("fallback: \"recreate\" converges through the two proven executors", () => {
  it("creates the eased session when the workout is gone from COROS", async () => {
    const { server, client, target } = await pushed();
    server.state.schedule.entities = (server.state.schedule.entities ?? []).filter(
      (e) => String(e.idInPlan) !== target.idInPlan,
    );
    server.state.schedule.programs = (server.state.schedule.programs ?? []).filter(
      (p) => String(p.idInPlan) !== target.idInPlan,
    );

    const update = await updateWorkoutContent(
      client,
      {
        target,
        name: stamp(easedSession.title),
        session: easedSession,
        thresholdPaceSecPerKm: THRESHOLD,
      },
      options({ fallback: "recreate" }),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.pathUsed).toBe("delete_and_create");
    // A NEW address — the caller must re-record all four fields.
    expect(update.serverIdInPlan).not.toBe(target.idInPlan);
    expect(update.serverHappenDay).toBe(DATE);
    const after = await onTheWatch(client, stamp(easedSession.title));
    expect(after!.stages).toHaveLength(1);
    expect(after!.stages[0]!.durationSeconds).toBe(2100);
  });

  it("deletes-then-creates when the server refuses the in-place rewrite", async () => {
    const { server, client, target } = await pushed();
    const onDayBefore = entitiesOnTheDay(server);
    server.updateRejectResult = "1031"; // status:2 is refused; 1 and 3 still work

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options({ fallback: "recreate" }),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.pathUsed).toBe("delete_and_create");
    const after = await onTheWatch(client, target.name);
    expect(after!.stages).toHaveLength(1);
    expect(after!.contentFingerprint).toBe(update.wireFingerprint);
    // The day holds no more than it did: the old workout was removed, not
    // duplicated, even though its identity changed.
    expect(entitiesOnTheDay(server)).toBe(onDayBefore);
  });

  it("still refuses to touch a foreign workout, fallback or not", async () => {
    const { server, client, target } = await pushed();
    const stolen = server.programByIdInPlan(target.idInPlan)!;
    stolen.name = "Sunday hills with the club";
    const foreignBefore = corosProgramFingerprint(stolen);
    const writesBefore = server.counts.scheduleWrites;

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options({ fallback: "recreate" }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("stamp_mismatch");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(corosProgramFingerprint(server.programByIdInPlan(target.idInPlan)!)).toBe(foreignBefore);
  });

  it("still refuses an ambiguous stamp, fallback or not", async () => {
    const { server, client, target } = await pushed();
    const twin = server.entityByIdInPlan(target.idInPlan)!;
    server.state.schedule.entities!.push({
      ...twin,
      id: "sv-entity-twin",
      happenDay: Number(corosDay(addDaysIso(DATE, 1))),
    });
    const snapshot = planSnapshot(server);

    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession, thresholdPaceSecPerKm: THRESHOLD },
      options({ fallback: "recreate" }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("ambiguous");
    expect(planSnapshot(server)).toEqual(snapshot);
  });
});

// ── 6. THE SECOND PROOF: the sessions COROS authored ─────────────────────────

/**
 * THE MAJORITY OF THE ATHLETE'S PLAN, and the half the stamp could not reach.
 *
 * Everything above proves ownership by a program-name STAMP — a name only this
 * app emits, which only exists for workouts this app CREATED. The athlete's plan
 * is mostly IMPORTED: COROS authored those workouts and the coach only eases
 * them, so not one of them carries a stamp and every convergence refused
 * `no_recorded_stamp`. The app could rewrite the sessions it made up and none of
 * the ones the athlete actually follows.
 *
 * The fixture plan below is exactly that shape — "Threshold 5x5", "Easy Run 45
 * min", real COROS exercise ids, no stamp anywhere — so these tests import from
 * it the way the real importer does (address, day, `corosProgramFingerprint`)
 * and then ask for the rewrite. Same discipline as the stamp suites: every
 * refusal asserts the category AND that not one byte was written.
 */
describe("a session COROS authored can be eased, proven by what the import recorded", () => {
  /**
   * What `import-plan.ts` stores for one wire workout: the address, the day it
   * was verified on, and `source_content_fingerprint`. Read out of the mock
   * through the same fingerprint function the importer uses, so the test cannot
   * agree with the executor by sharing a bug the importer does not have.
   */
  async function imported(
    server: MockCorosServer,
    programName: string,
  ): Promise<{ target: ImportProvenTarget; date: string; entity: RawCorosEntity }> {
    const program = (server.state.schedule.programs ?? []).find((p) => p.name === programName);
    expect(program, `the fixture plan must hold "${programName}"`).toBeDefined();
    const entity = (server.state.schedule.entities ?? []).find(
      (e) => String(e.planProgramId ?? e.idInPlan) === String(program!.idInPlan),
    );
    expect(entity, "…and an entity placing it on a day").toBeDefined();
    const date = isoFromDay(entity!.happenDay);
    return {
      entity: entity!,
      date,
      target: {
        happenDay: String(entity!.happenDay),
        idInPlan: String(entity!.idInPlan),
        programId: String(entity!.planProgramId ?? entity!.idInPlan),
        planId: String(server.state.schedule.id ?? ""),
        // Exactly what `normalize.ts` records for an imported row: COROS's own
        // program id, and the fingerprint of the program as read.
        importedProgramId: String(program!.id ?? ""),
        importedFingerprint: corosProgramFingerprint(program!),
      },
    };
  }

  const isoFromDay = (day: number | string): string =>
    String(day).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

  /** Read one day of the plan back through the REAL normalizer. */
  async function watchOn(client: CorosClient, date: string) {
    const raw = await client.getRawSchedule(addDaysIso(date, -1), addDaysIso(date, 1));
    return normalizeCorosSchedule(raw).workouts.filter((w) => w.date === date);
  }

  it("rewrites the imported workout in place and leaves NO stamp on it", async () => {
    const { server, client } = await setup();
    const { target, date } = await imported(server, "Threshold 5x5");

    const before = (await watchOn(client, date)).find((w) => w.title === "Threshold 5x5");
    expect(before, "COROS's own session is on the watch first").toBeDefined();
    expect(before!.stages.length).toBeGreaterThan(1);

    const writesBefore = server.counts.scheduleWrites;
    const snapshot = planSnapshot(server);
    const update = await updateWorkoutContent(
      client,
      {
        target,
        // The PLAIN TITLE, not `${title} — ${date}`. The app does not claim
        // authorship of a workout COROS wrote.
        name: easedSession.title,
        session: easedSession,
        thresholdPaceSecPerKm: THRESHOLD,
      },
      options({ today: TODAY }),
    );

    expect(update.ok, update.error).toBe(true);
    expect(update.pathUsed).toBe("in_place_update");
    // ONE write, at the address the import recorded — the COROS identity of the
    // athlete's own session is untouched, which is what keeps it movable.
    expect(server.counts.scheduleWrites).toBe(writesBefore + 1);
    expect(update.serverIdInPlan).toBe(target.idInPlan);
    expect(update.serverProgramId).toBe(target.programId);
    expect(update.serverHappenDay).toBe(date);

    const after = await watchOn(client, date);
    const eased = after.find((w) => w.title === easedSession.title);
    expect(eased, "the eased session is on the watch under its plain title").toBeDefined();
    expect(eased!.stages).toHaveLength(1);
    expect(eased!.stages[0]).toMatchObject({
      durationType: "time",
      durationSeconds: 2100,
      targetType: "pace",
      targetLow: 349,
      targetHigh: 409,
    });
    // NOT stamped: the name carries no " — <date>" discriminator, so the next
    // import reads it as a title and has nothing to strip.
    expect(eased!.title).not.toContain(" — ");
    // The old prescription is gone, not sitting beside it as a duplicate.
    expect(after.find((w) => w.title === "Threshold 5x5")).toBeUndefined();

    // AND NOTHING ELSE MOVED. Every other program in the plan is byte-identical.
    const now = planSnapshot(server);
    for (const [id, fp] of snapshot) {
      if (id === target.idInPlan) continue;
      expect(now.get(id), `program ${id} must be untouched`).toBe(fp);
    }
  });

  it("is idempotent: asked twice, the second call writes nothing", async () => {
    const { server, client } = await setup();
    const { target, date } = await imported(server, "Threshold 5x5");
    const spec = {
      target,
      name: easedSession.title,
      session: easedSession,
      thresholdPaceSecPerKm: THRESHOLD,
    };
    const first = await updateWorkoutContent(client, spec, options({ today: TODAY }));
    expect(first.ok, first.error).toBe(true);

    // The recorded fingerprint is now stale by construction — the write
    // consumer re-stamps the row with `wireFingerprint`, which is what the
    // SECOND rewrite proves against. That self-healing is what lets a session be
    // eased twice.
    const retry = {
      ...spec,
      target: { ...target, importedFingerprint: first.wireFingerprint! },
    };
    const writesBefore = server.counts.scheduleWrites;
    const second = await updateWorkoutContent(client, retry, options({ today: TODAY }));
    expect(second.ok).toBe(true);
    expect(second.reason).toBe("already_current");
    expect(server.counts.scheduleWrites, "nothing on the wire").toBe(writesBefore);
    expect((await watchOn(client, date)).find((w) => w.title === easedSession.title)).toBeDefined();
  });

  // ── The adversarial half ───────────────────────────────────────────────────

  it("REFUSES when the address holds different content than we imported", async () => {
    // The athlete edited this session in COROS after the app last read it — or
    // COROS recycled the slot. Either way the thing at the address is not the
    // thing the athlete asked to change, and the stamp path's `stamp_mismatch`
    // is exactly the right refusal.
    const { server, client } = await setup();
    const { target } = await imported(server, "Threshold 5x5");
    const program = server.programByIdInPlan(target.idInPlan)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: 1234 }];
    const drifted = corosProgramFingerprint(program);

    const writesBefore = server.counts.scheduleWrites;
    const snapshot = planSnapshot(server);
    const update = await updateWorkoutContent(
      client,
      { target, name: easedSession.title, session: easedSession },
      options({ today: TODAY }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("stamp_mismatch");
    // The evidence an operator needs: what is actually there.
    expect(update.observedFingerprint).toBe(drifted);
    // The refusal must carry its EVIDENCE, not a guessed cause. Live, this
    // message said "its content has changed (the athlete edited it in COROS)"
    // for a slot nothing had touched — two reads eighteen minutes apart hashed
    // identically — and that wrong story cost an hour. It now reports expected
    // vs found so the reader can tell drift from the two sides disagreeing.
    expect(update.error).toMatch(/does not hold what this app imported/);
    expect(update.error).toMatch(/Expected program .* content \w+; found program/);
    expect(server.counts.scheduleWrites, "not one byte").toBe(writesBefore);
    expect(planSnapshot(server)).toEqual(snapshot);
  });

  it("REFUSES when the address holds nothing at all", async () => {
    const { server, client } = await setup();
    const { target } = await imported(server, "Threshold 5x5");
    server.state.schedule.entities = (server.state.schedule.entities ?? []).filter(
      (e) => String(e.idInPlan) !== target.idInPlan,
    );
    server.state.schedule.programs = (server.state.schedule.programs ?? []).filter(
      (p) => String(p.idInPlan) !== target.idInPlan,
    );

    const writesBefore = server.counts.scheduleWrites;
    const update = await updateWorkoutContent(
      client,
      { target, name: easedSession.title, session: easedSession },
      options({ today: TODAY }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("not_found");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("REFUSES when the content matches but the day moved", async () => {
    // The athlete dragged the session to another day in COROS. The content
    // still proves it is ours to change; the DAY says the app is addressing a
    // stale placement, and rewriting blind would edit a day the caller cannot
    // even record the change against.
    const { server, client } = await setup();
    const { target, entity, date } = await imported(server, "Threshold 5x5");
    const movedTo = addDaysIso(date, 2);
    entity.happenDay = Number(movedTo.replaceAll("-", ""));

    const writesBefore = server.counts.scheduleWrites;
    const snapshot = planSnapshot(server);
    const update = await updateWorkoutContent(
      client,
      { target, name: easedSession.title, session: easedSession },
      options({ today: TODAY }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("moved");
    expect(update.serverHappenDay).toBe(movedTo);
    expect(server.counts.scheduleWrites).toBe(writesBefore);
    expect(planSnapshot(server)).toEqual(snapshot);
  });

  it("REFUSES two placements that both match the recorded content", async () => {
    // Fingerprints are not unique inside a plan — that is precisely why the
    // address locates and the fingerprint only confirms. When both resolve to
    // two entities, nothing observable separates them.
    const { server, client } = await setup();
    const { target, entity, date } = await imported(server, "Threshold 5x5");
    server.state.schedule.entities!.push({
      ...entity,
      id: "sv-entity-twin",
      happenDay: Number(addDaysIso(date, 1).replaceAll("-", "")),
    });

    const writesBefore = server.counts.scheduleWrites;
    const update = await updateWorkoutContent(
      client,
      { target, name: easedSession.title, session: easedSession },
      options({ today: TODAY }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("ambiguous");
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("REFUSES `fallback: recreate` outright — it did not author this plan", async () => {
    // The stamp path may re-create a workout it wrote and lost. An imported one
    // that has vanished from a COROS-authored plan vanished for a reason this
    // app does not own, and putting it back would overrule the athlete inside
    // their own plan at a brand-new idInPlan.
    const { server, client } = await setup();
    const { target } = await imported(server, "Threshold 5x5");

    const writesBefore = server.counts.scheduleWrites;
    const update = await updateWorkoutContent(
      client,
      { target, name: easedSession.title, session: easedSession },
      options({ today: TODAY, fallback: "recreate" }),
    );

    expect(update.ok).toBe(false);
    expect(update.reason).toBe("error");
    expect(update.error).toMatch(/must not re-create it inside a COROS-authored plan/);
    // Refused BEFORE any read — nothing on the wire, at all.
    expect(server.counts.scheduleWrites).toBe(writesBefore);
  });

  it("REFUSES a rewrite with no name to write — there is no stamp to default to", async () => {
    const { server, client } = await setup();
    const { target } = await imported(server, "Threshold 5x5");
    const update = await updateWorkoutContent(
      client,
      { target, session: easedSession },
      options({ today: TODAY }),
    );
    expect(update.ok).toBe(false);
    expect(update.reason).toBe("error");
    expect(update.error).toMatch(/no stamp to reuse/);
    expect(server.counts.scheduleWrites).toBe(0);
  });
});
