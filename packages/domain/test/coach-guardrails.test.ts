/**
 * Guardrail validator (Plan A Task A3, spec §4): hard rules reject, soft
 * rules flag — and the validator injects soft flags the model forgot, so the
 * UI's "breaks your rule" chip is guaranteed truthful.
 */
import { describe, expect, it } from "vitest";
import { datedEventsFromMemory, validateOps, type GuardrailCtx } from "../src/coach-guardrails.js";
import { addOpDates } from "../src/coach.js";
import type { CoachOp } from "../src/coach.js";

const easy = (title = "Easy 40", durationMinutes = 40) => ({
  category: "easy" as const,
  title,
  durationMinutes,
  run: { blocks: [{ kind: "duration" as const, value: durationMinutes, intensity: "easy" as const }] },
});
const quality = () => ({
  category: "quality" as const,
  title: "Tempo 3×10",
  durationMinutes: 50,
  run: { blocks: [{ kind: "duration" as const, value: 50, intensity: "threshold" as const }] },
});
/** A lift session of any length — duration is the only intensity signal. */
const lift = (durationMinutes: number, title = "Legs") => ({
  category: "strength" as const,
  title,
  durationMinutes,
  lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45 }] },
});
const mobility = (durationMinutes: number) => ({
  category: "yoga" as const,
  title: "Ankles and hips",
  durationMinutes,
  mobility: { exercises: [{ name: "Couch stretch", sets: 2, holdSeconds: 45 }] },
});

function ctx(overrides: Partial<GuardrailCtx> = {}): GuardrailCtx {
  return {
    today: "2026-08-05",
    workouts: [
      { id: "w-past", date: "2026-08-04", category: "quality", completionState: "completed", durationMinutes: 50, discipline: "run" },
      { id: "w-thu", date: "2026-08-06", category: "quality", completionState: "scheduled", durationMinutes: 50, discipline: "run" },
      { id: "w-fri", date: "2026-08-07", category: "strength", completionState: "scheduled", durationMinutes: 45, discipline: "strength" },
      { id: "w-sat", date: "2026-08-08", category: "long", completionState: "scheduled", durationMinutes: 90, discipline: "run" },
      { id: "w-race", date: "2026-08-16", category: "race", completionState: "scheduled", durationMinutes: 100, discipline: "run" },
    ],
    weeklyMinutesByDiscipline: { run: [180, 190, 200, 190], strength: [90, 90, 90, 90] },
    raceDates: ["2026-08-16"],
    firmHorizonEnd: "2026-08-23",
    rules: [
      { id: "r-sat-long", kind: "anchor_day", category: "long", weekday: 6 },
      { id: "r-tue-quality", kind: "fixed_slot", category: "quality", weekday: 2 },
    ],
    coachPlanIds: ["cp1"],
    datedEvents: [],
    ...overrides,
  };
}

describe("hard rules", () => {
  it("H1: ramp beyond 10% of trailing average is rejected", () => {
    // Trailing avg 190min; adding 3×80min easy runs to next week blows past 209.
    const ops: CoachOp[] = [
      { kind: "add", date: "2026-08-10", session: { ...easy(), durationMinutes: 80 } },
      { kind: "add", date: "2026-08-11", session: { ...easy(), durationMinutes: 80 } },
      { kind: "add", date: "2026-08-12", session: { ...easy(), durationMinutes: 80 } },
    ];
    const out = validateOps(ops, ctx());
    expect(out.hard.some((v) => v.rule === "ramp")).toBe(true);
  });

  it("H2: hard sessions on consecutive days are rejected", () => {
    // Adding quality on Friday puts quality(Fri) next to long(Sat).
    const out = validateOps([{ kind: "add", date: "2026-08-07", session: quality() }], ctx());
    expect(out.hard.some((v) => v.rule === "hard_adjacency")).toBe(true);
  });

  it("H3: touching a completed or past workout is rejected", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-past", toDate: "2026-08-09" }], ctx());
    expect(out.hard.some((v) => v.rule === "touch_resolved")).toBe(true);
  });

  it("resolveRaceConflict edits no training day and passes clean", () => {
    const out = validateOps([{ kind: "resolveRaceConflict", keep: "settings" }], ctx());
    expect(out.hard).toEqual([]);
  });

  it("H4: edits beyond the firm horizon are rejected (except firmUp/extend/reshape)", () => {
    const out = validateOps([{ kind: "add", date: "2026-09-01", session: easy() }], ctx());
    expect(out.hard.some((v) => v.rule === "beyond_horizon")).toBe(true);
    const ok = validateOps(
      [
        {
          kind: "firmUp",
          planId: "cp1",
          weekStart: "2026-08-31",
          sessions: [{ date: "2026-09-01", session: easy() }],
        },
      ],
      ctx(),
    );
    expect(ok.hard.filter((v) => v.rule === "beyond_horizon")).toHaveLength(0);
  });

  it("H5: new intensity inside race week is rejected", () => {
    const out = validateOps([{ kind: "add", date: "2026-08-12", session: quality() }], ctx());
    expect(out.hard.some((v) => v.rule === "race_week_intensity")).toBe(true);
  });

  it("H6: skipping a race is rejected", () => {
    const out = validateOps([{ kind: "skip", workoutId: "w-race", reason: "tired" }], ctx());
    expect(out.hard.some((v) => v.rule === "never_skip_race")).toBe(true);
  });

  it("a clean easing passes with no hard violations", () => {
    const out = validateOps(
      [{ kind: "ease", workoutId: "w-thu", session: easy("Steady 40 Z2") }],
      ctx(),
    );
    expect(out.hard).toHaveLength(0);
  });

  it("H7: structural ops on a plan the coach did not author are rejected", () => {
    const out = validateOps([{ kind: "retirePlan", planId: "coros-import-4738" }], ctx());
    expect(out.hard.some((v) => v.rule === "imported_plan_structure")).toBe(true);
    const reshape = validateOps(
      [
        {
          kind: "reshapeWeek",
          planId: "coros-import-4738",
          weekStart: "2026-08-10",
          sessions: [{ date: "2026-08-11", session: easy() }],
        },
      ],
      ctx(),
    );
    expect(reshape.hard.some((v) => v.rule === "imported_plan_structure")).toBe(true);
  });

  it("H7: skipping or moving an imported session stays allowed", () => {
    // w-sat belongs to no coached plan (workout-level ops carry no planId) —
    // session-level ops must never trip the structural rule.
    const out = validateOps([{ kind: "skip", workoutId: "w-thu", reason: "backpacking weekend" }], ctx());
    expect(out.hard.filter((v) => v.rule === "imported_plan_structure")).toHaveLength(0);
  });

  it("H7: structural ops on a coach-authored plan pass", () => {
    const out = validateOps([{ kind: "retirePlan", planId: "cp1" }], ctx());
    expect(out.hard.filter((v) => v.rule === "imported_plan_structure")).toHaveLength(0);
  });
});

/**
 * The 2026-08-16 ski-prep failure, rule by rule. Every case below is a thing
 * the coach actually did to a real athlete and nothing stopped it.
 */
describe("the detrained athlete (2026-08-16)", () => {
  it("a 45-minute leg session the day after the long run is now hard enough to reject", () => {
    // HARD_LIFT_MINUTES was 60, so a 45-minute lift was not a "hard" day and
    // hard_adjacency could never fire for one — which rewarded prescribing
    // 55-minute sessions next to hard runs.
    const out = validateOps([{ kind: "add", date: "2026-08-09", session: lift(45) }], ctx());
    expect(out.hard.some((v) => v.rule === "hard_adjacency")).toBe(true);
    expect(out.hard.find((v) => v.rule === "hard_adjacency")!.detail).toContain("Sat 8 Aug");
  });

  it("with no strength history, even a 20-minute lift counts as a hard day", () => {
    const detrained = ctx({ weeklyMinutesByDiscipline: { run: [180, 190, 200, 190], strength: [0, 0, 0, 0] } });
    const out = validateOps([{ kind: "add", date: "2026-08-09", session: lift(20) }], detrained);
    expect(out.hard.some((v) => v.rule === "hard_adjacency")).toBe(true);
    // …and for someone who lifts every week, the same 20 minutes is not.
    const trained = validateOps([{ kind: "add", date: "2026-08-09", session: lift(20) }], ctx());
    expect(trained.hard.filter((v) => v.rule === "hard_adjacency")).toHaveLength(0);
  });

  it("the few-minute daily piece is never a hard day, however detrained", () => {
    const detrained = ctx({ weeklyMinutesByDiscipline: { strength: [0, 0, 0, 0] } });
    const out = validateOps([{ kind: "add", date: "2026-08-09", session: mobility(10) }], detrained);
    expect(out.hard).toHaveLength(0);
  });

  it("cold start: a strength block for someone with no strength history is capped in absolute minutes", () => {
    // The ramp check is multiplicative, so with a trailing average of zero it
    // said nothing at all — silent for exactly the athlete it protects.
    const detrained = ctx({ weeklyMinutesByDiscipline: { run: [180, 190, 200, 190], strength: [0, 0, 0, 0] } });
    const ops: CoachOp[] = [
      { kind: "add", date: "2026-08-10", session: lift(50) },
      { kind: "add", date: "2026-08-12", session: lift(50) },
      { kind: "add", date: "2026-08-14", session: lift(50) },
    ];
    const out = validateOps(ops, detrained);
    const v = out.hard.find((x) => x.rule === "cold_start");
    expect(v, "150 minutes of strength from a standing start must be rejected").toBeTruthy();
    // Legible to the ATHLETE — this string is printed into their receipt.
    expect(v!.detail).toContain("no strength work in the last four weeks");
    expect(v!.detail).toContain("150 minutes");
    expect(v!.detail).toContain("week of Mon 10 Aug");
  });

  it("cold start stays quiet for someone who already trains that discipline", () => {
    const ops: CoachOp[] = [{ kind: "add", date: "2026-08-10", session: lift(45) }];
    expect(validateOps(ops, ctx()).hard.filter((v) => v.rule === "cold_start")).toHaveLength(0);
  });

  it("a week with no rest day left in it is rejected", () => {
    // Next week holds only the race; fill the other six days and the athlete
    // has nine consecutive days on. Trailing run volume is set high enough
    // that the ramp rule is not what catches this.
    const roomy = ctx({ weeklyMinutesByDiscipline: { run: [300, 300, 300, 300], strength: [90, 90, 90, 90] } });
    const ops: CoachOp[] = ["10", "11", "12", "13", "14", "15"].map((d) => ({
      kind: "add" as const,
      date: `2026-08-${d}`,
      session: easy("Easy 30", 30),
    }));
    const out = validateOps(ops, roomy);
    const v = out.hard.find((x) => x.rule === "no_rest_day");
    expect(v, "seven loaded days in a week must be rejected").toBeTruthy();
    expect(v!.detail).toContain("no rest day at all");
  });

  it("…but a day carrying only the ten-minute daily piece still counts as rest", () => {
    const roomy = ctx({ weeklyMinutesByDiscipline: { run: [300, 300, 300, 300], strength: [90, 90, 90, 90] } });
    const ops: CoachOp[] = ["10", "11", "12", "14", "15"]
      .map((d) => ({ kind: "add" as const, date: `2026-08-${d}`, session: easy("Easy 30", 30) }))
      .concat([{ kind: "add" as const, date: "2026-08-13", session: mobility(10) }]);
    expect(validateOps(ops, roomy).hard.filter((v) => v.rule === "no_rest_day")).toHaveLength(0);
  });

  it("loading inside 48h of a remembered trip is rejected", () => {
    const trip = ctx({
      firmHorizonEnd: "2026-08-31",
      datedEvents: [{ id: "mem1", label: "ski trip", date: "2026-08-26" }],
    });
    const out = validateOps([{ kind: "add", date: "2026-08-25", session: lift(45) }], trip);
    const v = out.hard.find((x) => x.rule === "event_taper");
    expect(v, "a heavy leg session the day before the trip must be rejected").toBeTruthy();
    expect(v!.detail).toContain("ski trip");
    expect(v!.detail).toContain("Wed 26 Aug");
    // Four days out is the coach's business, not the guardrail's.
    expect(
      validateOps([{ kind: "add", date: "2026-08-22", session: lift(45) }], trip).hard.filter(
        (x) => x.rule === "event_taper",
      ),
    ).toHaveLength(0);
  });

  it("dated events are read out of memory prose, and only when they carry a real date", () => {
    expect(
      datedEventsFromMemory([
        { id: "m1", body: "Ski trip 2026-08-26 to 2026-08-30 — ski prep is the priority." },
        { id: "m2", body: "Prefers the long run on Saturday." },
        { id: "m3", body: "Old trip 2026-01-04", active: false },
        { id: "m4", body: "Wedding on 2026-09-12" },
      ]),
    ).toEqual([
      { id: "m1", label: "Ski trip", date: "2026-08-26" },
      { id: "m4", label: "Wedding", date: "2026-09-12" },
    ]);
  });
});

describe("two sessions of one category on one day", () => {
  /**
   * Reachable today — the fixture calendar already has two run rows on
   * Tuesday 18 Aug. `entryFor` matched on date+category, so both ids
   * resolved to whichever row came first and an op aimed at the second
   * silently rewrote the first.
   */
  const twoOnADay = (): GuardrailCtx =>
    ctx({
      today: "2026-08-16",
      workouts: [
        { id: "r1", date: "2026-08-18", category: "easy", completionState: "scheduled", durationMinutes: 30, discipline: "run" },
        { id: "r2", date: "2026-08-18", category: "easy", completionState: "scheduled", durationMinutes: 90, discipline: "run" },
      ],
      weeklyMinutesByDiscipline: { run: [100, 100, 100, 100] },
      raceDates: [],
      rules: [],
      firmHorizonEnd: "2026-08-31",
    });

  it("an ease lands on the workout it names, not the day's first row", () => {
    // Easing r2 (90) up to 120 leaves the day at 120 + r1's 30 = 150.
    // The old lookup eased r1 instead, leaving 120 + r2's 90 = 210.
    const out = validateOps(
      [{ kind: "ease", workoutId: "r2", session: easy("Easy 120", 120) }],
      twoOnADay(),
    );
    const ramp = out.hard.find((v) => v.rule === "ramp");
    expect(ramp).toBeTruthy();
    expect(ramp!.detail).toContain("150 minutes");
    expect(ramp!.detail).not.toContain("210");
  });

  it("a skip removes the workout it names, not the day's first row", () => {
    // Skipping r2 (90) leaves r1's 30 + the new 100 = 130. The old lookup
    // removed r1 instead, leaving r2's 90 + 100 = 190 — the guardrail
    // reasoning about a calendar the athlete would never have had.
    const out = validateOps(
      [
        { kind: "skip", workoutId: "r2", reason: "doubling up isn't helping" },
        { kind: "add", date: "2026-08-19", session: easy("Easy 100", 100) },
      ],
      twoOnADay(),
    );
    const ramp = out.hard.find((v) => v.rule === "ramp");
    expect(ramp).toBeTruthy();
    expect(ramp!.detail).toContain("130 minutes");
    expect(ramp!.detail).not.toContain("190");
  });
});

describe("soft rules", () => {
  it("moving the long run off Saturday flags the anchor rule", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-sat", toDate: "2026-08-09" }], ctx());
    expect(out.hard).toHaveLength(0);
    expect(out.soft.some((v) => v.rule === "r-sat-long")).toBe(true);
  });

  it("keeping the long run on a Saturday stays unflagged", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-sat", toDate: "2026-08-15" }], ctx());
    expect(out.soft.filter((v) => v.rule === "r-sat-long")).toHaveLength(0);
  });
});

/**
 * A recurring session is ONE op carrying N dates (2026-08-17). The whole
 * point of the cheaper vocabulary is token cost, so the one thing that must
 * NOT get cheaper is the load: an add with ten dates has to weigh exactly
 * what ten adds weighed, or `dates` becomes the way around the ramp check.
 */
describe("add ops carrying multiple dates", () => {
  it("addOpDates unions date and dates, de-duplicates, and orders", () => {
    expect(
      addOpDates({
        kind: "add",
        date: "2026-08-20",
        dates: ["2026-08-22", "2026-08-20", "2026-08-21"],
        session: mobility(10),
      } as Extract<CoachOp, { kind: "add" }>),
    ).toEqual(["2026-08-20", "2026-08-21", "2026-08-22"]);
  });

  it("every date is a real day of load — one op cannot smuggle a week past the ramp", () => {
    const dates = ["2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"];
    const oneOp: CoachOp[] = [
      { kind: "add", date: dates[0]!, dates: dates.slice(1), session: lift(60) } as CoachOp,
    ];
    const manyOps: CoachOp[] = dates.map((d) => ({ kind: "add", date: d, session: lift(60) }) as CoachOp);
    const c = ctx({ raceDates: [], workouts: [] });
    const one = validateOps(oneOp, c);
    const many = validateOps(manyOps, c);
    // Same rules fire either way — the vocabulary changed, the physics didn't.
    expect(one.hard.length).toBeGreaterThan(0);
    expect(new Set(one.hard.map((h) => h.rule))).toEqual(new Set(many.hard.map((h) => h.rule)));
  });

  it("a genuinely cheap daily piece still passes as one op", () => {
    const res = validateOps(
      [
        {
          kind: "add",
          date: "2026-08-09",
          dates: ["2026-08-10", "2026-08-11", "2026-08-12"],
          session: mobility(10),
        } as CoachOp,
      ],
      ctx(),
    );
    expect(res.hard).toEqual([]);
  });
});
