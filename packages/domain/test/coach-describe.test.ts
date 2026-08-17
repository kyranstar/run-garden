/**
 * `describeOps` — the manifest the app computes so the model never has to
 * count (2026-08-17).
 *
 * The fixture below is the live proposal that motivated the whole change,
 * copied out of prod ops JSON: an `ease` on Monday's 600s, a 40-minute
 * ski-legs `add`, and ONE mobility `add` carrying a primary date plus three
 * more in `dates`. Its briefing said the mobility piece landed "on four
 * days" — and the review that reported the briefing as wrong by one had
 * counted only the `dates` array and got three. Two readers, opposite
 * errors, one cause: the count lived in prose and nowhere else.
 */
import { describe, expect, it } from "vitest";
import { coachOpSchema, type CoachOp } from "../src/coach.js";
import { describeOps, type PlannedRef } from "../src/coach-describe.js";

const LIVE_OPS: unknown[] = [
  {
    kind: "ease",
    workoutId: "4d2708c7",
    session: {
      category: "easy",
      title: "Easy 35 — legs back under you",
      durationMinutes: 35,
      run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
    },
  },
  {
    kind: "add",
    date: "2026-08-17",
    session: {
      category: "strength",
      title: "Ski legs — holds and eccentrics",
      durationMinutes: 40,
      lift: {
        exercises: [
          { name: "Wall Sit", sets: 3, holdSeconds: 45, weight: { type: "bodyweight" }, restSeconds: 60 },
          {
            name: "Reverse Step-Down",
            sets: 3,
            reps: 8,
            perSide: true,
            eccentricSeconds: 4,
            weight: { type: "bodyweight" },
            restSeconds: 90,
          },
          {
            name: "Lateral Squats or Side Squats",
            sets: 3,
            reps: 8,
            perSide: true,
            weight: { type: "bodyweight" },
            restSeconds: 75,
          },
          { name: "Single-Leg Calf Raise", sets: 3, reps: 12, perSide: true, restSeconds: 45 },
          { name: "Copenhagen Plank", sets: 2, holdSeconds: 20, perSide: true, restSeconds: 60 },
          { name: "Foam Rolling - IT Bands", sets: 1, holdSeconds: 60, perSide: true, restSeconds: 0 },
        ],
      },
    },
  },
  {
    kind: "add",
    date: "2026-08-18",
    dates: ["2026-08-20", "2026-08-23", "2026-08-24"],
    session: {
      category: "yoga",
      title: "Ankles, hips and desk posture",
      durationMinutes: 10,
      mobility: {
        exercises: [
          { name: "Greatest Stretch", sets: 1, reps: 5, perSide: true, restSeconds: 0 },
          { name: "Lunge Stretch", sets: 1, holdSeconds: 40, perSide: true, restSeconds: 0 },
          { name: "Thoracic Spine Rotation", sets: 1, reps: 6, perSide: true, restSeconds: 0 },
          { name: "Neck Flexion With Positive Pressure Of", sets: 2, reps: 8, restSeconds: 20 },
          { name: "Banded Ankle Eversion", sets: 1, reps: 15, perSide: true, restSeconds: 0 },
        ],
      },
    },
  },
];

const liveOps = LIVE_OPS.map((o) => coachOpSchema.parse(o));

describe("describeOps — the live ski-prep proposal", () => {
  it("expands the multi-date add to one line per date, not one line per op", () => {
    const lines = describeOps(liveOps);
    // Three ops. SIX lines: the ease, the strength session, and FOUR
    // mobility days — the primary `date` is a date like any other, which is
    // the off-by-one both the prose and its reviewer were exposed to.
    expect(lines).toHaveLength(6);
    const mobility = lines.filter((l) => l.summary.startsWith("Ankles, hips and desk posture"));
    expect(mobility.map((l) => l.date)).toEqual(["2026-08-18", "2026-08-20", "2026-08-23", "2026-08-24"]);
    // …and it is the same session on each of them: identical but for date.
    for (const l of mobility) {
      expect({ ...l, date: null }).toEqual({ ...mobility[0]!, date: null });
    }
    // The `dates` array alone — the number a careless reader quotes — is
    // three, and no line count anywhere may come from it.
    expect(mobility).not.toHaveLength(3);
  });

  it("sorts chronologically, and leaves the undated ease where it can be seen", () => {
    const lines = describeOps(liveOps);
    const dated = lines.filter((l) => l.date !== null).map((l) => l.date);
    expect(dated).toEqual([...dated].sort());
    expect(dated).toHaveLength(5);
    // The ease is the one line the ops cannot date: `ease` carries a
    // workoutId and the new session, never the day it sits on.
    const ease = lines.find((l) => l.kind === "ease")!;
    expect(ease.date).toBeNull();
    expect(ease.summary).toBe("Easy 35 — legs back under you · 35 min");
    expect(ease.detail).toEqual(["35 min easy"]);
  });

  it("formats session contents with the session sheet's own formatter", () => {
    const strength = describeOps(liveOps).find((l) => l.summary.startsWith("Ski legs"))!;
    expect(strength.date).toBe("2026-08-17");
    expect(strength.summary).toBe("Ski legs — holds and eccentrics · 40 min");
    // The rests are the coach's own numbers (2026-08-17): this proposal wrote
    // 90/75/45 seconds and a foam-roll with none, and the athlete could not see
    // one of them — the same fields the dossier was quoting back to the model.
    // Wall Sit and the Copenhagen say nothing because they carry the schema's
    // default, which nobody chose.
    expect(strength.detail).toEqual([
      "Wall Sit 3×45s",
      "Reverse Step-Down 3×8/side (4s down), 90s rest",
      "Lateral Squats or Side Squats 3×8/side, 75s rest",
      "Single-Leg Calf Raise 3×12/side, 45s rest",
      "Copenhagen Plank 2×20s/side",
      "Foam Rolling - IT Bands 1×60s/side, no rest",
    ]);
    expect(strength.change).toBeNull();
  });

  it("names what an eased session was, when the caller knows", () => {
    const planned = new Map<string, PlannedRef>([
      ["4d2708c7", { date: "2026-08-24", summary: "6×600m at 10K pace" }],
    ]);
    const lines = describeOps(liveOps, planned);
    const ease = lines.find((l) => l.kind === "ease")!;
    expect(ease.date).toBe("2026-08-24");
    expect(ease.change).toBe("6×600m at 10K pace → Easy 35 — legs back under you");
    // …and with that date it takes its real place in the manifest.
    expect(lines.map((l) => l.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-20",
      "2026-08-23",
      "2026-08-24",
      "2026-08-24",
    ]);
  });

  it("counts the primary date once when the model repeats it inside dates", () => {
    // The same proposal as the reviewer described it — the recurring piece
    // on 20/23/24 with the primary date inside the set. FIVE lines, not
    // three: the de-duplication is `addOpDates`, the same reader `applyOps`
    // uses to write the rows, so manifest and calendar cannot disagree.
    const ops = liveOps.map((op) =>
      op.kind === "add" && op.dates
        ? coachOpSchema.parse({ ...op, date: "2026-08-20", dates: ["2026-08-20", "2026-08-23", "2026-08-24"] })
        : op,
    );
    const lines = describeOps(ops);
    expect(lines).toHaveLength(5);
    expect(lines.filter((l) => l.summary.startsWith("Ankles")).map((l) => l.date)).toEqual([
      "2026-08-20",
      "2026-08-23",
      "2026-08-24",
    ]);
  });

  it("says what a sub-minute block and a unit-bearing one actually are", () => {
    // The manifest is the ONE place the athlete reads what they are approving,
    // so the vocabulary that lets a coach write "15s" has to arrive here as
    // fifteen seconds. A duration block's `value` is minutes — 0.25 of one —
    // and the shared stage formatter is what keeps this line, the stored stage
    // summary and the session sheet from disagreeing about it.
    const strides = coachOpSchema.parse({
      kind: "add",
      date: "2026-08-20",
      session: {
        category: "quality",
        title: "Strides",
        durationMinutes: 40,
        run: {
          blocks: [
            { kind: "duration", value: "15 min", intensity: "easy" },
            { kind: "duration", value: "15s", intensity: "interval" },
            { kind: "duration", value: "45s", intensity: "easy" },
            { kind: "duration", value: "90s", intensity: "threshold" },
            { kind: "distance", value: "1km", intensity: "steady" },
          ],
        },
      },
    });
    expect(describeOps([strides])[0]!.detail).toEqual([
      "15 min easy",
      "15s interval",
      "45s easy",
      "90s threshold",
      "1 km steady",
    ]);
  });
});

/**
 * One sample op per kind. The coverage test below fails if the discriminated
 * union grows a kind that is missing here — the same guard the wake prompt's
 * example-coverage test applies to the shapes the model is shown.
 */
const easyRun = {
  category: "easy",
  title: "Easy 40",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
};
const datedSession = { date: "2026-09-02", session: easyRun };
const shapeWeek = { weekStart: "2026-09-07", volumeTarget: "hold, one quality", keySessions: ["long run"] };

const SAMPLES: Record<CoachOp["kind"], unknown> = {
  ease: { kind: "ease", workoutId: "w1", session: easyRun },
  move: { kind: "move", workoutId: "w1", toDate: "2026-08-20" },
  swap: { kind: "swap", dayA: "2026-08-19", dayB: "2026-08-21" },
  skip: { kind: "skip", workoutId: "w1", reason: "you're travelling" },
  add: { kind: "add", date: "2026-08-20", session: easyRun },
  reshapeWeek: { kind: "reshapeWeek", planId: "cp1", weekStart: "2026-08-24", sessions: [datedSession] },
  firmUp: { kind: "firmUp", planId: "cp1", weekStart: "2026-08-31", sessions: [datedSession] },
  extendPlan: { kind: "extendPlan", planId: "cp1", shapeWeeks: [shapeWeek] },
  windDown: { kind: "windDown", planId: "cp1", sessions: [datedSession] },
  createPlan: {
    kind: "createPlan",
    discipline: "run",
    name: "Post-race block",
    startDate: "2026-08-24",
    endDate: "2026-11-20",
    raceDate: null,
    firmSessions: [datedSession],
    shapeWeeks: [shapeWeek],
  },
  retirePlan: { kind: "retirePlan", planId: "cp1" },
  resolveRaceConflict: { kind: "resolveRaceConflict", keep: "settings" },
};

describe("describeOps — every op kind is described", () => {
  it("has a sample for every kind in the union", () => {
    const advertised = (coachOpSchema.options as Array<{ shape: { kind: { value: CoachOp["kind"] } } }>).map(
      (o) => o.shape.kind.value,
    );
    expect(advertised.filter((k) => !(k in SAMPLES)), "op kinds with no describeOps test").toEqual([]);
  });

  it("produces at least one non-empty line for each, and never a blank summary", () => {
    for (const [kind, raw] of Object.entries(SAMPLES)) {
      const lines = describeOps([coachOpSchema.parse(raw)]);
      expect(lines.length, `${kind} produced no line`).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l.kind, `${kind} mislabelled its line`).toBe(kind);
        expect(l.summary.trim().length, `${kind} produced a blank summary`).toBeGreaterThan(0);
      }
    }
  });

  it("puts plan-level ops last and dates the rest", () => {
    const ops = [SAMPLES.retirePlan, SAMPLES.resolveRaceConflict, SAMPLES.add].map((o) =>
      coachOpSchema.parse(o),
    );
    const lines = describeOps(ops);
    expect(lines.map((l) => l.kind)).toEqual(["add", "retirePlan", "resolveRaceConflict"]);
    expect(lines[0]!.date).toBe("2026-08-20");
    expect(lines[1]!.date).toBeNull();
    expect(lines[2]!.date).toBeNull();
  });

  it("describes both sides of a swap and both ends of a move", () => {
    const swap = describeOps([coachOpSchema.parse(SAMPLES.swap)]);
    expect(swap.map((l) => l.date)).toEqual(["2026-08-19", "2026-08-21"]);
    expect(swap[0]!.summary).toBe("Swaps days with Fri 21 Aug");
    expect(swap[1]!.summary).toBe("Swaps days with Wed 19 Aug");

    const planned = new Map<string, PlannedRef>([["w1", { date: "2026-08-18", summary: "Threshold 4×8" }]]);
    const move = describeOps([coachOpSchema.parse(SAMPLES.move)], planned);
    expect(move.map((l) => [l.date, l.change])).toEqual([
      ["2026-08-18", "moves to Thu 20 Aug"],
      ["2026-08-20", "moves here from Tue 18 Aug"],
    ]);
    // Without the lookup there is only the day it lands on — never invented.
    expect(describeOps([coachOpSchema.parse(SAMPLES.move)]).map((l) => l.date)).toEqual(["2026-08-20"]);
  });

  it("renders a circuit as rounds rather than as loose sets", () => {
    const op = coachOpSchema.parse({
      kind: "add",
      date: "2026-08-20",
      session: {
        category: "yoga",
        title: "Ankles and hips",
        durationMinutes: 10,
        mobility: {
          rounds: 2,
          exercises: [
            { name: "Couch stretch", sets: 1, holdSeconds: 45, perSide: true },
            { name: "Ankle rocks", sets: 1, reps: 12, perSide: true, restSeconds: 0 },
          ],
        },
      },
    });
    expect(describeOps([op])[0]!.detail).toEqual([
      "2 rounds: Couch stretch 1×45s/side · Ankle rocks 1×12/side, no rest",
    ]);
  });

  it("lists a created plan's firm sessions and its sketched weeks", () => {
    const lines = describeOps([coachOpSchema.parse(SAMPLES.createPlan)]);
    expect(lines.map((l) => l.date)).toEqual(["2026-08-24", "2026-09-02", "2026-09-07"]);
    expect(lines[0]!.summary).toBe("New plan: Post-race block · Mon 24 Aug to Fri 20 Nov");
    expect(lines[2]!.summary).toBe("Week of Mon 7 Sep — hold, one quality");
    expect(lines[2]!.change).toBe("sketched: long run");
  });
});
