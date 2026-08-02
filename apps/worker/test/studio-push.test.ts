/**
 * Plan Studio push orchestration (plan-studio-design §5): the happenDay
 * mapping, the draft-vs-pushed diff, drift detection, and the push-row state
 * machine that decides what is created and deleted on the user's real COROS
 * calendar.
 *
 * The state machine is the reason this file is exhaustive: the safety module
 * it calls fails closed, but THIS logic decides what it is asked to do.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  DEFAULT_USER_PREFERENCES,
  fingerprint,
  newId,
  nowInstant,
  type LiftingPlan,
  type StudioJobResult,
  type StudioSession,
} from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyJobResult, claimNextJob } from "../src/services/jobs.js";
import {
  applyStudioJobResult,
  bridgeJobPayload,
  desiredSessions,
  detectDrift,
  mapCreateResult,
  mapDeleteResult,
  planPush,
  pushStudioPlan,
  sessionHappenDay,
  sessionStamp,
  type PushRow,
} from "../src/services/studio-push.js";
import { makeTestDb, makeTestUser, registerTestDevice } from "./helpers.js";

const { corosExercises, corosWriteJobs, plannedWorkouts, studioPlanPushes, studioPlans, trainingPlans } =
  schema;

const SQUAT = "425898928110747648";
const BENCH = "426109589008859137";

function session(over: Partial<StudioSession> = {}): StudioSession {
  return {
    title: "Upper A",
    weekday: 1,
    exercises: [
      {
        originId: SQUAT,
        name: "Back Squat",
        sets: 3,
        reps: 10,
        weight: { type: "bodyweight" },
        restSeconds: 60,
      },
    ],
    ...over,
  };
}

function plan(over: Partial<LiftingPlan> = {}): LiftingPlan {
  const startDate = "2026-09-07"; // a Monday
  return {
    name: "Autumn Strength",
    brief: {
      goal: "strength",
      durationWeeks: 2,
      sessionsPerWeek: 1,
      preferredDays: [1],
      sessionMinutes: 60,
      equipment: "full gym",
      constraints: "",
      notes: "",
      startDate,
    },
    weeks: [{ sessions: [session()] }, { sessions: [session()] }],
    ...over,
  } as LiftingPlan;
}

function row(over: Partial<PushRow> = {}): PushRow {
  return {
    id: "row-1",
    planId: "plan-1",
    happenDay: "2026-09-07",
    sessionTitle: "Upper A — wk 1",
    sessionFingerprint: null,
    corosIdInPlan: null,
    corosProgramId: null,
    corosPlanId: null,
    status: "pending",
    error: null,
    ...over,
  };
}

function verifiedRow(over: Partial<PushRow> = {}): PushRow {
  return row({
    status: "verified",
    corosIdInPlan: "21",
    corosProgramId: "21",
    corosPlanId: "coros-plan",
    ...over,
  });
}

function result(over: Partial<StudioJobResult> = {}): StudioJobResult {
  return { pushId: "row-1", kind: "create_scheduled_workout", ok: true, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("sessionHappenDay — week/weekday → calendar day", () => {
  /**
   * happenDay = startOfIsoWeek(startDate) + (weekIndex × 7) + (weekday − 1).
   * The plan grid is anchored to the ISO week CONTAINING startDate, so weekday
   * 1 of week 0 is that week's Monday whatever day the user picked to start.
   */

  it("puts week 0 weekday 1 on the Monday of the start week", () => {
    expect(sessionHappenDay("2026-09-07", 0, 1)).toBe("2026-09-07"); // Mon
  });

  it("walks the ISO weekdays across the start week", () => {
    expect(sessionHappenDay("2026-09-07", 0, 3)).toBe("2026-09-09"); // Wed
    expect(sessionHappenDay("2026-09-07", 0, 5)).toBe("2026-09-11"); // Fri
    expect(sessionHappenDay("2026-09-07", 0, 7)).toBe("2026-09-13"); // Sun
  });

  it("advances a whole week per week index", () => {
    expect(sessionHappenDay("2026-09-07", 1, 1)).toBe("2026-09-14");
    expect(sessionHappenDay("2026-09-07", 3, 4)).toBe("2026-10-01");
    expect(sessionHappenDay("2026-09-07", 15, 7)).toBe("2026-12-27");
  });

  it("anchors a MID-WEEK startDate to that week's Monday, not to startDate", () => {
    // Thursday 2026-09-10 → its ISO week starts Monday 2026-09-07.
    expect(sessionHappenDay("2026-09-10", 0, 1)).toBe("2026-09-07");
    expect(sessionHappenDay("2026-09-10", 0, 4)).toBe("2026-09-10"); // startDate itself
    expect(sessionHappenDay("2026-09-10", 1, 1)).toBe("2026-09-14");
  });

  it("anchors a SUNDAY startDate to the Monday six days earlier (ISO weeks start Monday)", () => {
    expect(sessionHappenDay("2026-09-13", 0, 1)).toBe("2026-09-07");
    expect(sessionHappenDay("2026-09-13", 0, 7)).toBe("2026-09-13");
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(sessionHappenDay("2026-12-28", 0, 4)).toBe("2026-12-31");
    expect(sessionHappenDay("2026-12-28", 0, 5)).toBe("2027-01-01");
    expect(sessionHappenDay("2026-12-28", 1, 1)).toBe("2027-01-04");
  });
});

describe("sessionStamp", () => {
  it("is the title plus the 1-based week, which is what makes it unique plan-wide", () => {
    expect(sessionStamp("Upper A", 0)).toBe("Upper A — wk 1");
    expect(sessionStamp("Upper A", 2)).toBe("Upper A — wk 3");
  });
});

describe("desiredSessions", () => {
  it("expands every week's sessions onto concrete days with stamps and fingerprints", () => {
    const desired = desiredSessions(plan());
    expect(desired).toHaveLength(2);
    expect(desired[0]).toMatchObject({
      weekIndex: 0,
      happenDay: "2026-09-07",
      sessionTitle: "Upper A — wk 1",
    });
    expect(desired[1]).toMatchObject({ weekIndex: 1, happenDay: "2026-09-14", sessionTitle: "Upper A — wk 2" });
    expect(desired[0]!.fingerprint).toBe(fingerprint(desired[0]!.session));
  });

  it("gives deep-unequal sessions different fingerprints and equal ones the same", () => {
    const a = desiredSessions(plan())[0]!;
    const heavier = session({
      exercises: [{ ...session().exercises[0]!, weight: { type: "kg", value: 60 } }],
    });
    const b = desiredSessions(plan({ weeks: [{ sessions: [heavier] }] }))[0]!;
    const same = desiredSessions(plan())[0]!;

    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(same.fingerprint).toBe(a.fingerprint);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("detectDrift", () => {
  const observed = (over: Record<string, unknown> = {}): Map<string, never> =>
    new Map(
      Object.entries({
        "coros-plan:21": {
          sourceWorkoutId: "coros-plan:21",
          title: "Upper A — wk 1",
          corosDate: "2026-09-07",
          archived: false,
          ...over,
        },
      }) as never,
    );

  it("finds no drift when the observed workout still matches", () => {
    expect(detectDrift([verifiedRow()], observed())).toEqual([]);
  });

  it("flags a workout the importer confirmed gone from COROS", () => {
    expect(detectDrift([verifiedRow()], observed({ archived: true }))).toEqual([
      { pushId: "row-1", kind: "missing" },
    ]);
  });

  it("flags a rename (the stamp is the only thing that authorizes a delete)", () => {
    expect(detectDrift([verifiedRow()], observed({ title: "Leg Day" }))).toEqual([
      { pushId: "row-1", kind: "renamed" },
    ]);
  });

  it("flags a move to another day", () => {
    expect(detectDrift([verifiedRow()], observed({ corosDate: "2026-09-09" }))).toEqual([
      { pushId: "row-1", kind: "moved" },
    ]);
  });

  it("does NOT flag a row the snapshot simply has not seen — absence proves nothing", () => {
    expect(detectDrift([verifiedRow()], new Map())).toEqual([]);
  });

  it("ignores rows that are not verified", () => {
    for (const status of ["pending", "failed", "deleted"] as const) {
      expect(detectDrift([verifiedRow({ status })], observed({ archived: true }))).toEqual([]);
    }
  });

  it("ignores verified rows with no recorded address", () => {
    expect(
      detectDrift([verifiedRow({ corosIdInPlan: null })], observed({ archived: true })),
    ).toEqual([]);
  });

  it("scopes the match to the recorded container plan", () => {
    // Same idInPlan, different plan: COROS idInPlan counters are per-plan and
    // overlap freely, so an unscoped match would compare unrelated workouts.
    expect(detectDrift([verifiedRow({ corosPlanId: "other-plan" })], observed())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("planPush — the diff", () => {
  const base = {
    rows: [] as PushRow[],
    otherLiveTitles: [] as string[],
    driftedPushIds: new Set<string>(),
    catalogIds: new Set([SQUAT, BENCH]),
    today: "2026-08-01",
  };

  it("creates every session of a plan that has never been pushed", () => {
    const batch = planPush({ ...base, desired: desiredSessions(plan()) });
    expect(batch.creates.map((c) => c.desired.sessionTitle)).toEqual([
      "Upper A — wk 1",
      "Upper A — wk 2",
    ]);
    expect(batch.deletes).toEqual([]);
    expect(batch.failures).toEqual([]);
  });

  it("leaves an unchanged verified session alone", () => {
    const desired = desiredSessions(plan());
    const rows = desired.map((d, i) =>
      verifiedRow({ id: `row-${i}`, happenDay: d.happenDay, sessionTitle: d.sessionTitle, sessionFingerprint: d.fingerprint, corosIdInPlan: String(20 + i), corosProgramId: String(20 + i) }),
    );
    const batch = planPush({ ...base, desired, rows });

    expect(batch.creates).toEqual([]);
    expect(batch.deletes).toEqual([]);
    expect(batch.unchanged).toEqual(["row-0", "row-1"]);
  });

  it("a changed session becomes a delete that CARRIES its follow-up create", () => {
    const desired = desiredSessions(plan());
    const rows = [
      verifiedRow({
        id: "row-0",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
        sessionFingerprint: "stale-fingerprint",
      }),
    ];
    const batch = planPush({ ...base, desired, rows });

    expect(batch.deletes).toHaveLength(1);
    expect(batch.deletes[0]!.row.id).toBe("row-0");
    // The create is NOT enqueued alongside: it rides on the delete and is only
    // enqueued once the delete reaches a terminal "gone" state. Otherwise a
    // refused delete would be followed by a create that adopts the stale
    // workout via already_present and reports a content change that never
    // happened.
    expect(batch.deletes[0]!.followUp?.sessionTitle).toBe("Upper A — wk 1");
    expect(batch.creates.map((c) => c.desired.sessionTitle)).toEqual(["Upper A — wk 2"]);
  });

  it("a removed session becomes a plain delete with no follow-up", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      verifiedRow({ id: "row-0", happenDay: desired[0]!.happenDay, sessionTitle: desired[0]!.sessionTitle, sessionFingerprint: desired[0]!.fingerprint }),
      verifiedRow({ id: "row-1", happenDay: "2026-09-14", sessionTitle: "Upper A — wk 2" }),
    ];
    const batch = planPush({ ...base, desired, rows });

    expect(batch.deletes).toHaveLength(1);
    expect(batch.deletes[0]!.row.id).toBe("row-1");
    expect(batch.deletes[0]!.followUp).toBeUndefined();
  });

  it("re-pushes a previously deleted session as a plain create (its ids no longer address anything)", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      row({
        id: "row-0",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
        status: "deleted",
      }),
    ];
    const batch = planPush({ ...base, desired, rows });

    expect(batch.creates).toHaveLength(1);
    expect(batch.deletes).toEqual([]);
  });

  it("removes an ADDRESSABLE stray left by a failed create before recreating it", () => {
    // A create that landed on the wrong day records its ids (something
    // materialized); re-pushing must remove it rather than leak a duplicate.
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      verifiedRow({
        id: "row-0",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
        status: "failed",
      }),
    ];
    const batch = planPush({ ...base, desired, rows });

    expect(batch.deletes).toHaveLength(1);
    expect(batch.deletes[0]!.followUp?.sessionTitle).toBe("Upper A — wk 1");
    expect(batch.creates).toEqual([]);
  });

  it("marks a removed row that was never addressable as deleted locally, with no job", () => {
    const rows = [row({ id: "row-9", status: "failed", happenDay: "2026-09-21", sessionTitle: "Gone" })];
    const batch = planPush({ ...base, desired: [], rows });

    expect(batch.deletes).toEqual([]);
    expect(batch.localDeletes).toEqual(["row-9"]);
  });

  it("surfaces a removed PENDING row with no recorded address rather than claiming it is gone", () => {
    const rows = [row({ id: "row-9", status: "pending", happenDay: "2026-09-21", sessionTitle: "Gone" })];
    const batch = planPush({ ...base, desired: [], rows });

    expect(batch.localDeletes).toEqual([]);
    expect(batch.failures).toEqual([{ pushId: "row-9", happenDay: "2026-09-21", sessionTitle: "Gone", error: "unaddressable" }]);
  });
});

describe("planPush — refusals that never reach COROS", () => {
  const base = {
    rows: [] as PushRow[],
    otherLiveTitles: [] as string[],
    driftedPushIds: new Set<string>(),
    catalogIds: new Set([SQUAT, BENCH]),
    today: "2026-08-01",
  };

  it("fails a title that collides with a live row of ANOTHER studio plan", () => {
    // Stamp uniqueness is plan-WIDE on COROS: two workouts sharing a name make
    // both undeletable, because ownership stops being decidable.
    const batch = planPush({
      ...base,
      desired: desiredSessions(plan()),
      otherLiveTitles: ["Upper A — wk 2"],
    });

    expect(batch.creates.map((c) => c.desired.sessionTitle)).toEqual(["Upper A — wk 1"]);
    expect(batch.failures).toEqual([
      { pushId: undefined, happenDay: "2026-09-14", sessionTitle: "Upper A — wk 2", error: "duplicate_title" },
    ]);
  });

  it("fails BOTH sides of a within-batch title collision (neither is arbitrarily preferred)", () => {
    // Two sessions in the same week under one title produce one stamp.
    const p = plan({
      weeks: [{ sessions: [session(), session({ weekday: 3 })] }],
    });
    const batch = planPush({ ...base, desired: desiredSessions(p) });

    expect(batch.creates).toEqual([]);
    expect(batch.failures.map((f) => f.error)).toEqual(["duplicate_title", "duplicate_title"]);
  });

  it("collapses a same-day same-title duplicate into ONE failed row (the identity key is unique)", () => {
    const p = plan({ weeks: [{ sessions: [session(), session()] }] });
    const batch = planPush({ ...base, desired: desiredSessions(p) });

    expect(batch.failures).toHaveLength(1);
    expect(batch.failures[0]).toMatchObject({ happenDay: "2026-09-07", error: "duplicate_title" });
  });

  it("does NOT count a row that this push is deleting as a live collision", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      // Same stamp, different day → removed by this push, so it frees the name.
      verifiedRow({ id: "row-old", happenDay: "2026-08-31", sessionTitle: "Upper A — wk 1" }),
    ];
    const batch = planPush({ ...base, desired, rows });

    expect(batch.deletes.map((d) => d.row.id)).toEqual(["row-old"]);
    expect(batch.failures).toEqual([]);
    expect(batch.creates).toHaveLength(1);
  });

  it("fails a session whose exercise is not in the synced COROS catalog", () => {
    const p = plan({
      weeks: [{ sessions: [session({ exercises: [{ ...session().exercises[0]!, originId: "nope" }] })] }],
    });
    const batch = planPush({ ...base, desired: desiredSessions(p) });

    expect(batch.creates).toEqual([]);
    expect(batch.failures[0]!.error).toBe("unknown_exercise");
  });

  it("fails a session with no exercises rather than letting the builder throw on the bridge", () => {
    const p = plan({ weeks: [{ sessions: [session({ exercises: [] })] }] });
    const batch = planPush({ ...base, desired: desiredSessions(p) });

    expect(batch.failures[0]!.error).toBe("no_exercises");
  });

  it("fails a day that has already happened rather than writing onto the past", () => {
    const batch = planPush({ ...base, desired: desiredSessions(plan()), today: "2026-09-10" });

    expect(batch.creates.map((c) => c.desired.sessionTitle)).toEqual(["Upper A — wk 2"]);
    expect(batch.failures[0]).toMatchObject({ happenDay: "2026-09-07", error: "day_in_past" });
  });

  it("still allows a session pushed for TODAY", () => {
    const batch = planPush({ ...base, desired: desiredSessions(plan()), today: "2026-09-07" });
    expect(batch.creates).toHaveLength(2);
  });

  it("checks duplicate_title before the other refusals, so the reason is deterministic", () => {
    const p = plan({
      weeks: [
        { sessions: [session({ exercises: [] }), session({ weekday: 3, exercises: [] })] },
      ],
    });
    const batch = planPush({ ...base, desired: desiredSessions(p) });
    expect(batch.failures.map((f) => f.error)).toEqual(["duplicate_title", "duplicate_title"]);
  });
});

describe("planPush — drifted rows are never clobbered", () => {
  const base = {
    otherLiveTitles: [] as string[],
    catalogIds: new Set([SQUAT, BENCH]),
    today: "2026-08-01",
  };

  it("excludes a drifted row from the delete batch and does not recreate over it", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      verifiedRow({
        id: "row-0",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
        sessionFingerprint: "stale",
      }),
    ];
    const batch = planPush({
      ...base,
      desired,
      rows,
      driftedPushIds: new Set(["row-0"]),
    });

    expect(batch.deletes).toEqual([]);
    expect(batch.creates).toEqual([]);
    expect(batch.failures).toEqual([]); // already marked changed_on_coros
  });

  it("excludes a drifted REMOVED row from deletion too", () => {
    const rows = [verifiedRow({ id: "row-0" })];
    const batch = planPush({ ...base, desired: [], rows, driftedPushIds: new Set(["row-0"]) });

    expect(batch.deletes).toEqual([]);
    expect(batch.localDeletes).toEqual([]);
  });

  it("keeps protecting a row an EARLIER push already marked changed_on_coros", () => {
    // The mark moved the row off `verified`, so detectDrift no longer looks at
    // it. Without the error-code check, this push would delete the workout the
    // user had taken over.
    const rows = [
      verifiedRow({ id: "row-0", status: "failed", error: "changed_on_coros" }),
    ];
    const batch = planPush({ ...base, desired: [], rows, driftedPushIds: new Set() });

    expect(batch.deletes).toEqual([]);
    expect(batch.localDeletes).toEqual([]);
    expect(batch.failures).toEqual([]);
  });

  it("does not recreate over a row an earlier push marked changed_on_coros", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      verifiedRow({
        id: "row-0",
        status: "failed",
        error: "changed_on_coros",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
      }),
    ];
    const batch = planPush({ ...base, desired, rows, driftedPushIds: new Set() });

    expect(batch.creates).toEqual([]);
    expect(batch.deletes).toEqual([]);
  });

  it("still re-plans an ordinary failure — only changed_on_coros is untouchable", () => {
    const desired = desiredSessions(plan()).slice(0, 1);
    const rows = [
      verifiedRow({
        id: "row-0",
        status: "failed",
        error: "rejected",
        happenDay: desired[0]!.happenDay,
        sessionTitle: desired[0]!.sessionTitle,
      }),
    ];
    const batch = planPush({ ...base, desired, rows, driftedPushIds: new Set() });

    expect(batch.deletes).toHaveLength(1);
    expect(batch.deletes[0]!.followUp).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("mapCreateResult — every create outcome", () => {
  it("a verified create → verified, ids persisted", () => {
    expect(mapCreateResult(result({ ok: true }), false)).toEqual({
      status: "verified",
      error: null,
      persistIds: true,
      clearIds: false,
      job: "verified",
    });
  });

  it("an idempotent already_present (same day) → verified, ids persisted", () => {
    expect(mapCreateResult(result({ ok: true, reason: "already_present" }), false)).toMatchObject({
      status: "verified",
      persistIds: true,
      job: "verified",
    });
  });

  it("reason 'error' is RETRYABLE with the same spec — already_present makes the retry idempotent", () => {
    expect(mapCreateResult(result({ ok: false, reason: "error" }), false)).toEqual({
      status: "pending",
      error: null,
      persistIds: true, // something may have materialized
      clearIds: false,
      job: "retry",
    });
  });

  it("reason 'error' becomes terminal only once the attempt budget is spent", () => {
    expect(mapCreateResult(result({ ok: false, reason: "error" }), true)).toMatchObject({
      status: "failed",
      error: "create_failed",
      persistIds: true,
      job: "failed",
    });
  });

  it("slot_occupied is a genuine race — retried against a freshly derived id", () => {
    expect(mapCreateResult(result({ ok: false, reason: "slot_occupied" }), false)).toMatchObject({
      status: "pending",
      persistIds: false,
      job: "retry",
    });
    expect(mapCreateResult(result({ ok: false, reason: "slot_occupied" }), true)).toMatchObject({
      status: "failed",
      error: "slot_occupied",
      job: "failed",
    });
  });

  it("no_target_plan → failed / plan_identity_changed, NEVER retried", () => {
    for (const exhausted of [false, true]) {
      expect(mapCreateResult(result({ ok: false, reason: "no_target_plan" }), exhausted)).toEqual({
        status: "failed",
        error: "plan_identity_changed",
        persistIds: false,
        clearIds: false,
        job: "failed",
      });
    }
  });

  it("a cross-day already_present → failed / changed_on_coros, and NO ids are stored", () => {
    // The executor deliberately strips ids here; storing anything would invite
    // a delete addressed at the wrong day.
    expect(mapCreateResult(result({ ok: false, reason: "already_present" }), false)).toEqual({
      status: "failed",
      error: "changed_on_coros",
      persistIds: false,
      clearIds: false,
      job: "failed",
    });
  });

  it("rejected and wrong_date are terminal but DO store whatever materialized", () => {
    expect(mapCreateResult(result({ ok: false, reason: "rejected" }), false)).toMatchObject({
      status: "failed",
      error: "rejected",
      persistIds: true,
      job: "failed",
    });
    expect(mapCreateResult(result({ ok: false, reason: "wrong_date" }), false)).toMatchObject({
      status: "failed",
      error: "wrong_date",
      persistIds: true,
      job: "failed",
    });
  });

  it("not_visible and out_of_span are terminal with nothing to store", () => {
    expect(mapCreateResult(result({ ok: false, reason: "not_visible" }), false)).toMatchObject({
      status: "failed",
      error: "not_visible",
      persistIds: false,
      job: "failed",
    });
    expect(mapCreateResult(result({ ok: false, reason: "out_of_span" }), false)).toMatchObject({
      status: "failed",
      error: "out_of_span",
      persistIds: false,
      job: "failed",
    });
  });

  it("a failure with no reason at all is terminal, never a silent success", () => {
    expect(mapCreateResult(result({ ok: false }), false)).toMatchObject({
      status: "failed",
      error: "create_failed",
      job: "failed",
    });
  });
});

describe("mapDeleteResult — every delete outcome", () => {
  const del = (over: Partial<StudioJobResult> = {}): StudioJobResult =>
    result({ kind: "delete_scheduled_workout", ok: false, ...over });

  it("a verified delete → deleted, and the recorded ids are cleared", () => {
    expect(mapDeleteResult(del({ ok: true }), false)).toEqual({
      status: "deleted",
      error: null,
      persistIds: false,
      clearIds: true,
      job: "verified",
    });
  });

  it("not_found is TERMINAL 'deleted' — the thing is already gone", () => {
    expect(mapDeleteResult(del({ refused: "not_found" }), false)).toEqual({
      status: "deleted",
      error: null,
      persistIds: false,
      clearIds: true,
      job: "verified",
    });
  });

  it("stamp_mismatch → failed / changed_on_coros, NEVER auto-retried", () => {
    for (const exhausted of [false, true]) {
      expect(mapDeleteResult(del({ refused: "stamp_mismatch" }), exhausted)).toEqual({
        status: "failed",
        error: "changed_on_coros",
        persistIds: false,
        clearIds: false,
        job: "failed",
      });
    }
  });

  it("ambiguous → failed / delete_ambiguous, never retried", () => {
    expect(mapDeleteResult(del({ refused: "ambiguous" }), false)).toMatchObject({
      status: "failed",
      error: "delete_ambiguous",
      job: "failed",
    });
  });

  it("an unproven delete is terminal and surfaced — a destructive path is never looped", () => {
    expect(mapDeleteResult(del({}), false)).toEqual({
      status: "failed",
      error: "delete_unverified",
      persistIds: false,
      clearIds: false,
      job: "failed",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

let db: Db;
let userId: string;

const TODAY = "2026-08-01";

async function seedPlan(over: Partial<LiftingPlan> = {}, version = 1): Promise<string> {
  const id = newId();
  await db.insert(studioPlans).values({
    id,
    userId,
    brief: plan(over).brief as unknown as Record<string, unknown>,
    plan: plan(over) as unknown as Record<string, unknown>,
    version,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

async function seedCatalog(): Promise<void> {
  await db.insert(corosExercises).values([
    { id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() },
    { id: BENCH, name: "Bench Press", raw: {}, updatedAt: nowInstant() },
  ]);
}

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
  await seedCatalog();
});

describe("pushStudioPlan", () => {
  it("writes a pending row and a create job per session", async () => {
    const planId = await seedPlan();
    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.ok).toBe(true);
    expect(summary.creates).toBe(2);

    const rows = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, planId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.planVersion === 1)).toBe(true);
    expect(rows.every((r) => r.sessionFingerprint)).toBe(true);

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.kind === "create_scheduled_workout")).toBe(true);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
    // studioPushId is what code reads; workoutId mirrors it only to satisfy
    // the column's NOT NULL.
    expect(jobs.every((j) => j.studioPushId && j.workoutId === j.studioPushId)).toBe(true);
  });

  it("puts only the entries the session needs into the job's catalog", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const job = (await db.select().from(corosWriteJobs))[0]!;
    const payload = job.payload as { catalog: Array<{ id: string }> };
    expect(payload.catalog).toEqual([{ id: SQUAT, name: "Back Squat" }]);
  });

  it("is idempotent: a second push of an unchanged plan enqueues nothing new", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    // Mark the rows verified as the bridge would.
    await db.update(studioPlanPushes).set({ status: "verified" });
    await db.update(corosWriteJobs).set({ status: "verified" });

    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.creates).toBe(0);
    expect(summary.unchanged).toBe(2);
    const queued = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.status, "queued"));
    expect(queued).toHaveLength(0);
  });

  it("UPSERTS by identity, so a re-push after a delete reuses the row", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const first = await db.select().from(studioPlanPushes);
    await db.update(studioPlanPushes).set({ status: "deleted" });

    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    const after = await db.select().from(studioPlanPushes);
    expect(after).toHaveLength(2); // not 4 — the unique index would have rejected inserts
    expect(after.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    expect(after.every((r) => r.status === "pending")).toBe(true);
  });

  it("enqueues the delete BEFORE the create for a changed session, and carries the follow-up", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    await db
      .update(studioPlanPushes)
      .set({
        status: "verified",
        corosIdInPlan: "21",
        corosProgramId: "21",
        corosPlanId: "coros-plan",
        sessionFingerprint: "stale",
      })
      .where(eq(studioPlanPushes.happenDay, "2026-09-07"));
    await db.update(studioPlanPushes).set({ status: "verified" }).where(eq(studioPlanPushes.happenDay, "2026-09-14"));
    await db.update(corosWriteJobs).set({ status: "verified" });

    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    const jobs = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.status, "queued"))
      .orderBy(corosWriteJobs.requestedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("delete_scheduled_workout");
    const payload = jobs[0]!.payload as { followUpCreate?: { name: string }; corosPlanId: string };
    expect(payload.corosPlanId).toBe("coros-plan");
    expect(payload.followUpCreate?.name).toBe("Upper A — wk 1");
  });

  it("marks drifted rows changed_on_coros and never enqueues a delete for them", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    await db
      .update(studioPlanPushes)
      .set({ status: "verified", corosIdInPlan: "21", corosProgramId: "21", corosPlanId: "coros-plan" })
      .where(eq(studioPlanPushes.happenDay, "2026-09-07"));
    await db.update(corosWriteJobs).set({ status: "verified" });

    // The user renamed it in COROS; the importer wrote the new title.
    const trainingPlanId = newId();
    await db.insert(trainingPlans).values({
      id: trainingPlanId,
      userId,
      provider: "coros",
      sourcePlanId: "coros-plan",
      name: "My Plan",
      status: "active",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(plannedWorkouts).values({
      id: newId(),
      userId,
      planId: trainingPlanId,
      sourceWorkoutId: "coros-plan:21",
      sourceIdInPlan: "21",
      title: "Renamed By User",
      category: "strength",
      sport: "strength",
      originalPlanDate: "2026-09-07",
      lastVerifiedCorosDate: "2026-09-07",
      effectiveDate: "2026-09-07",
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    // Remove the session from the draft so it would otherwise be deleted.
    await db
      .update(studioPlans)
      .set({ plan: plan({ weeks: [{ sessions: [] }, { sessions: [session()] }] }) as unknown as Record<string, unknown> })
      .where(eq(studioPlans.id, planId));

    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.drifted).toBe(1);
    const drifted = (
      await db
        .select()
        .from(studioPlanPushes)
        .where(eq(studioPlanPushes.happenDay, "2026-09-07"))
    )[0]!;
    expect(drifted.status).toBe("failed");
    expect(drifted.error).toBe("changed_on_coros");
    const deletes = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.kind, "delete_scheduled_workout"));
    expect(deletes).toHaveLength(0);
  });

  it("refuses a stored plan that no longer matches the studio schema", async () => {
    const id = newId();
    await db.insert(studioPlans).values({
      id,
      userId,
      brief: {},
      plan: { name: "Broken", weeks: "not-an-array" },
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    const summary = await pushStudioPlan(db, { userId, studioPlanId: id, today: TODAY });
    expect(summary).toMatchObject({ ok: false, error: "invalid_plan" });
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });

  it("refuses another user's plan", async () => {
    const planId = await seedPlan();
    const other = await makeTestUser(db);
    const summary = await pushStudioPlan(db, {
      userId: other.userId,
      studioPlanId: planId,
      today: TODAY,
    });
    expect(summary).toMatchObject({ ok: false, error: "plan_not_found" });
  });

  it("supersedes an in-flight job for a row it is re-pushing", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const before = await db.select().from(corosWriteJobs);

    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    const superseded = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.status, "superseded"));
    expect(superseded.map((j) => j.id).sort()).toEqual(before.map((j) => j.id).sort());
    const queued = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.status, "queued"));
    expect(queued).toHaveLength(2);
  });

  it("records a duplicate_title failure without enqueueing anything for it", async () => {
    const planId = await seedPlan({
      weeks: [{ sessions: [session(), session({ weekday: 3 })] }],
    });
    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.failures).toBe(2);
    const rows = await db.select().from(studioPlanPushes);
    expect(rows.every((r) => r.status === "failed" && r.error === "duplicate_title")).toBe(true);
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });

  it("counts a live title from another studio plan of the same user", async () => {
    await db.insert(studioPlanPushes).values({
      id: "other-row",
      planId: await seedPlan(),
      planVersion: 1,
      happenDay: "2026-10-05",
      sessionTitle: "Upper A — wk 1",
      status: "verified",
      updatedAt: nowInstant(),
    });

    const planId = await seedPlan();
    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.failures).toBe(1);
    expect(summary.creates).toBe(1);
  });

  it("ignores a colliding title belonging to a DIFFERENT user's plan", async () => {
    const other = await makeTestUser(db);
    const otherPlanId = newId();
    await db.insert(studioPlans).values({
      id: otherPlanId,
      userId: other.userId,
      brief: {},
      plan: plan() as unknown as Record<string, unknown>,
      version: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(studioPlanPushes).values({
      id: "other-user-row",
      planId: otherPlanId,
      planVersion: 1,
      happenDay: "2026-10-05",
      sessionTitle: "Upper A — wk 1",
      status: "verified",
      updatedAt: nowInstant(),
    });

    const planId = await seedPlan();
    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    expect(summary.failures).toBe(0);
    expect(summary.creates).toBe(2);
  });
});

describe("applyStudioJobResult", () => {
  async function pushed(): Promise<{ planId: string; jobId: string; pushId: string }> {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const job = (
      await db.select().from(corosWriteJobs).orderBy(corosWriteJobs.requestedAt)
    )[0]!;
    return { planId, jobId: job.id, pushId: job.studioPushId! };
  }

  it("a verified create stores the server ids and the container plan", async () => {
    const { jobId, pushId } = await pushed();
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "verified",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: {
        pushId,
        kind: "create_scheduled_workout",
        ok: true,
        code: "0000",
        serverIdInPlan: "21",
        serverProgramId: "9001",
        serverEntityId: "555",
        serverPlanId: "coros-plan",
      },
    });

    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("verified");
    expect(row.corosIdInPlan).toBe("21");
    expect(row.corosProgramId).toBe("9001");
    expect(row.corosEntityId).toBe("555");
    expect(row.corosPlanId).toBe("coros-plan");
    expect(row.error).toBeNull();

    const job = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0]!;
    expect(job.status).toBe("verified");
  });

  it("requeues a retryable failure and keeps the row pending", async () => {
    const { jobId, pushId } = await pushed();
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "write_failed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "create_scheduled_workout", ok: false, reason: "error" },
    });

    const job = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0]!;
    expect(job.status).toBe("queued");
    expect(job.attemptCount).toBe(1);
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("pending");
  });

  it("fails the row once the attempt budget is spent", async () => {
    const { jobId, pushId } = await pushed();
    await db.update(corosWriteJobs).set({ attemptCount: 4 }).where(eq(corosWriteJobs.id, jobId));
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "write_failed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "create_scheduled_workout", ok: false, reason: "error" },
    });

    const job = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0]!;
    expect(job.status).toBe("failed");
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("create_failed");
  });

  it("never retries a stamp_mismatch and surfaces it as changed_on_coros", async () => {
    const { jobId, pushId } = await pushed();
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "upstream_changed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "delete_scheduled_workout", ok: false, refused: "stamp_mismatch" },
    });

    const job = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, jobId)))[0]!;
    expect(job.status).toBe("failed");
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("changed_on_coros");
  });

  it("enqueues the follow-up create only once a delete has terminally gone", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    await db
      .update(studioPlanPushes)
      .set({ status: "verified", corosIdInPlan: "21", corosProgramId: "21", corosPlanId: "coros-plan", sessionFingerprint: "stale" })
      .where(eq(studioPlanPushes.happenDay, "2026-09-07"));
    await db.update(studioPlanPushes).set({ status: "verified" }).where(eq(studioPlanPushes.happenDay, "2026-09-14"));
    await db.update(corosWriteJobs).set({ status: "verified" });
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    const deleteJob = (
      await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.status, "queued"))
    )[0]!;
    await applyStudioJobResult(db, userId, {
      jobId: deleteJob.id,
      deviceId: "dev",
      outcome: "verified",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId: deleteJob.studioPushId!, kind: "delete_scheduled_workout", ok: true, code: "0000" },
    });

    const queued = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.status, "queued"));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe("create_scheduled_workout");
    // The row goes back to pending, not "deleted" — the session is being
    // replaced, not removed.
    const row = (
      await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, deleteJob.studioPushId!))
    )[0]!;
    expect(row.status).toBe("pending");
    expect(row.corosIdInPlan).toBeNull();
  });

  it("does NOT enqueue the follow-up create when the delete was refused", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    await db
      .update(studioPlanPushes)
      .set({ status: "verified", corosIdInPlan: "21", corosProgramId: "21", corosPlanId: "coros-plan", sessionFingerprint: "stale" })
      .where(eq(studioPlanPushes.happenDay, "2026-09-07"));
    await db.update(studioPlanPushes).set({ status: "verified" }).where(eq(studioPlanPushes.happenDay, "2026-09-14"));
    await db.update(corosWriteJobs).set({ status: "verified" });
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    const deleteJob = (
      await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.status, "queued"))
    )[0]!;
    await applyStudioJobResult(db, userId, {
      jobId: deleteJob.id,
      deviceId: "dev",
      outcome: "upstream_changed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: {
        pushId: deleteJob.studioPushId!,
        kind: "delete_scheduled_workout",
        ok: false,
        refused: "stamp_mismatch",
      },
    });

    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.status, "queued"))).toHaveLength(0);
  });

  it("treats a delete not_found as terminally deleted", async () => {
    const { jobId, pushId } = await pushed();
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "already_in_desired_state",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "delete_scheduled_workout", ok: false, refused: "not_found" },
    });

    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("deleted");
    expect(row.error).toBeNull();
  });

  it("ignores a result for an already-terminal job", async () => {
    const { jobId, pushId } = await pushed();
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, jobId));
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "write_failed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "create_scheduled_workout", ok: false, reason: "rejected" },
    });

    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("pending"); // untouched
  });

  it("refuses a result whose pushId does not belong to the job", async () => {
    const { jobId } = await pushed();
    await expect(
      applyStudioJobResult(db, userId, {
        jobId,
        deviceId: "dev",
        outcome: "verified",
        finishedAt: nowInstant(),
        signature: "sig",
        studio: { pushId: "someone-elses-row", kind: "create_scheduled_workout", ok: true },
      }),
    ).rejects.toThrow(/push_id_mismatch/);
  });

  it("fails the row terminally when the bridge reported no studio result at all", async () => {
    // The bridge refused a payload it could not validate: there is no executor
    // outcome to map, and the same payload would fail identically on a retry.
    const { jobId, pushId } = await pushed();
    const applied = await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "unsupported",
      errorCategory: "malformed_studio_payload",
      finishedAt: nowInstant(),
      signature: "sig",
    });

    expect(applied.jobStatus).toBe("failed");
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("bridge_rejected");
  });

  it("never writes a free-text message into the row's error column", async () => {
    const { jobId, pushId } = await pushed();
    await applyStudioJobResult(db, userId, {
      jobId,
      deviceId: "dev",
      outcome: "verification_failed",
      finishedAt: nowInstant(),
      signature: "sig",
      studio: { pushId, kind: "create_scheduled_workout", ok: false, reason: "wrong_date" },
    });
    const row = (await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)))[0]!;
    expect(row.error).toBe("wrong_date"); // a code, not a sentence
    expect(row.error!.includes(" ")).toBe(false);
  });
});

describe("job flow wiring", () => {
  it("claims a studio job with no planned workout attached", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const deviceId = await registerTestDevice(db, userId);

    const job = await claimNextJob(db, userId, deviceId);

    expect(job).not.toBeNull();
    expect(job!.kind).toBe("create_scheduled_workout");
    expect(job!.workout).toBeNull();
    expect(job!.status).toBe("claimed");
    expect(bridgeJobPayload(job!)!.name).toBe("Upper A — wk 1");
  });

  it("routes a studio result through applyJobResult without touching planned workouts", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });
    const deviceId = await registerTestDevice(db, userId);
    const job = (await claimNextJob(db, userId, deviceId))!;

    const applied = await applyJobResult(
      db,
      userId,
      {
        jobId: job.id,
        deviceId,
        outcome: "verified",
        finishedAt: nowInstant(),
        signature: "sig",
        studio: {
          pushId: job.studioPushId!,
          kind: "create_scheduled_workout",
          ok: true,
          code: "0000",
          serverIdInPlan: "21",
          serverProgramId: "21",
          serverPlanId: "coros-plan",
        },
      },
      DEFAULT_USER_PREFERENCES,
    );

    expect(applied.jobStatus).toBe("verified");
    const row = (
      await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, job.studioPushId!))
    )[0]!;
    expect(row.status).toBe("verified");
    expect(await db.select().from(plannedWorkouts)).toHaveLength(0);
  });

  it("hands the bridge only the fields it needs — the follow-up create stays server-side", () => {
    const payload = bridgeJobPayload({
      kind: "delete_scheduled_workout",
      payload: {
        pushId: "p",
        happenDay: "2026-09-07",
        name: "Upper A — wk 1",
        idInPlan: "21",
        programId: "21",
        corosPlanId: "coros-plan",
        followUpCreate: { pushId: "p", happenDay: "2026-09-07", name: "Upper A — wk 1", session: session(), catalog: [] },
      },
    });
    expect(payload).toBeDefined();
    expect(Object.keys(payload!)).not.toContain("followUpCreate");
  });
});

describe("full push → result → re-push loop", () => {
  it("verifies, then leaves the plan alone, then removes what the draft dropped", async () => {
    const planId = await seedPlan();
    await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    // Both creates come back verified.
    const jobs = await db.select().from(corosWriteJobs).orderBy(corosWriteJobs.requestedAt);
    for (const [i, job] of jobs.entries()) {
      await applyStudioJobResult(db, userId, {
        jobId: job.id,
        deviceId: "dev",
        outcome: "verified",
        finishedAt: nowInstant(),
        signature: "sig",
        studio: {
          pushId: job.studioPushId!,
          kind: "create_scheduled_workout",
          ok: true,
          code: "0000",
          serverIdInPlan: String(21 + i),
          serverProgramId: String(21 + i),
          serverPlanId: "coros-plan",
        },
      });
    }
    expect(
      (await db.select().from(studioPlanPushes)).every((r) => r.status === "verified"),
    ).toBe(true);

    // A second push finds nothing to do.
    expect((await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY })).unchanged).toBe(2);

    // Drop week 2 from the draft → a delete for exactly that row.
    await db
      .update(studioPlans)
      .set({ plan: plan({ weeks: [{ sessions: [session()] }] }) as unknown as Record<string, unknown> })
      .where(eq(studioPlans.id, planId));
    const summary = await pushStudioPlan(db, { userId, studioPlanId: planId, today: TODAY });

    expect(summary.deletes).toBe(1);
    const del = (
      await db
        .select()
        .from(corosWriteJobs)
        .where(
          and(eq(corosWriteJobs.status, "queued"), eq(corosWriteJobs.kind, "delete_scheduled_workout")),
        )
    )[0]!;
    const payload = del.payload as { idInPlan: string; name: string };
    expect(payload.idInPlan).toBe("22");
    expect(payload.name).toBe("Upper A — wk 2");
  });
});
