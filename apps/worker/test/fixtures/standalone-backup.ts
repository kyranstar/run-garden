/**
 * SYNTHETIC standalone-tool backups for the import's tests (Phase 2c plan Task 4). Built from the shapes of the
 * standalone tool's own synthetic test fixtures (its `tests/fixtures.js`, `stats.test.js`, `store.test.js` and
 * `recorder.test.js`) — never from a real backup. Every id, date, name and number here is made up; there are no
 * links, handles, captions or health records, and the no-provenance test greps this file to keep it that way.
 */

type Weight = { v: number; u: "lb" | "kg" };
export const lb = (v: number): Weight => ({ v, u: "lb" });
export const kg = (v: number): Weight => ({ v, u: "kg" });

export interface SetLike {
  w?: Weight | number | null;
  reps?: number | null;
  secs?: number | null;
}

/** A version-2 entry, as the tool's recorder writes one. */
export const entry = (id: string, sets: SetLike[], extra: Record<string, unknown> = {}) => ({
  id,
  implement: null,
  format: "straight",
  log: "load",
  metric: "reps",
  perSide: false,
  clenched: false,
  sets: sets.map((s) => ({ w: s.w ?? null, reps: s.reps ?? null, secs: s.secs ?? null })),
  ...extra,
});

/** A version-2 session: the tool's recorder output (`version: 2`), a UTC start. */
export function v2Session(date: string, extra: Record<string, unknown> = {}) {
  const suffix = typeof extra.idSuffix === "string" ? extra.idSuffix : "";
  const { idSuffix: _s, ...rest } = extra;
  return {
    version: 2,
    id: `s2-${date}${suffix}`,
    date,
    startedAt: `${date}T18:00:00.000Z`,
    endedAt: `${date}T18:30:00.000Z`,
    seconds: 1800,
    plannedSeconds: 1800,
    mode: "consistent",
    theme: null,
    location: "home",
    minutes: 30,
    blockNumber: 1,
    pre: 2,
    post: 1,
    note: "",
    completed: true,
    stepsTotal: 10,
    stepsDone: 10,
    done: [] as Array<{ id: string; secs: number }>,
    entries: [] as unknown[],
    newMove: null,
    ...rest,
  };
}

/** A pass-1 session: no version, a plan with a phase, a start with no zone, `bilateral` for per side. */
export function v1Session(date: string, extra: Record<string, unknown> = {}) {
  return {
    id: `s1-${date}`,
    date,
    startedAt: `${date}T10:00:00`,
    seconds: 1800,
    pre: 2,
    post: 1,
    plan: { phase: "build", setup: "kettlebell" },
    entries: [] as unknown[],
    ...extra,
  };
}

/** A whole backup document with three places, preferences, a wishlist and a block. */
export function backup(sessions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    app: "tmj_tool",
    version: 2,
    settings: { unit: "lb", weeklyGoal: 3, blockWeeks: 5, defaultMinutes: 40, location: "home", autoAdvance: true, wakeLock: true },
    locations: [
      { id: "home", name: "Apartment", equipment: ["mat", "yoga-block", "kettlebell", "bench", "chair", "wall", "towel"], kettlebell: { weights: "10, 15, 20, 25, 30, 35 lb" } },
      { id: "gym", name: "Gym", equipment: ["mat", "kettlebell", "dumbbells", "bench", "band", "cable"], kettlebell: { weights: "8, 12, 16 kg" }, dumbbells: { weights: "10, 15, 20 lb, 12kg" } },
      { id: "mat", name: "Mat only", equipment: ["mat", "wall", "towel", "chair", "trampoline"] },
    ],
    prefs: { ratings: { chinTuck: 1, tempoSquat: -1, notInTheLibrary: 1 }, excluded: ["bandRow"], pinned: ["gobletSquat"] },
    wishlist: ["band", "massage-ball", "hovercraft"],
    block: {
      id: "b2",
      number: 2,
      startedAt: "2026-09-21",
      weeks: 5,
      core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" },
      rotations: [{ family: "row", from: "proneYTW", to: "supportedRow", date: "2026-09-24", why: "no progress in 3 sessions" }],
    },
    sessions,
    lastExport: "2026-09-30T00:00:00.000Z",
    ...extra,
  };
}

/**
 * A history like a real one in shape: two sessions a week from Aug 3 (a Monday) to Sep 30 2026, the first few
 * pass-1 (one of them a flare day), then version 2 with goblet squats, deadlifts and rows (one-arm, per side), a
 * clenched set, and holds. Deterministic.
 */
export function history(): unknown[] {
  const out: unknown[] = [];
  const days = ["2026-08-03", "2026-08-06", "2026-08-10", "2026-08-13"];
  // Pass-1 entries carry `log` and `metric` as the tool's own pass-1 shapes do (its stats.test.js): its Progress
  // volume counts only `load` × `reps` entries.
  const loadReps = { log: "load", metric: "reps" };
  out.push(
    v1Session(days[0]!, { entries: [{ id: "gobletSquat", ...loadReps, bilateral: false, implement: "Kettlebell", sets: [{ w: lb(20), reps: 8 }, { w: lb(20), reps: 8 }] }] }),
    v1Session(days[1]!, { plan: { phase: "flare" }, pre: 5, post: 4, entries: [{ id: "chinTuck", log: "time", metric: "time", sets: [{ w: null, reps: null, secs: 30 }] }] }),
    v1Session(days[2]!, { entries: [{ id: "supportedRow", ...loadReps, bilateral: true, implement: "Kettlebell", sets: [{ w: lb(20), reps: 10 }] }] }),
    v1Session(days[3]!, { pre: null, post: null, entries: [{ id: "deadlift", ...loadReps, bilateral: false, sets: [{ w: lb(30), reps: 8 }] }] }),
  );
  const v2Days = [
    "2026-08-17", "2026-08-20", "2026-08-24", "2026-08-27", "2026-08-31", "2026-09-03", "2026-09-07", "2026-09-10",
    "2026-09-14", "2026-09-17", "2026-09-21", "2026-09-24", "2026-09-28", "2026-09-30",
  ];
  v2Days.forEach((date, i) => {
    const w = 20 + 5 * Math.floor(i / 4);
    out.push(
      v2Session(date, {
        mode: i % 5 === 4 ? "recovery" : i % 3 === 0 ? "build" : "consistent",
        blockNumber: date >= "2026-09-21" ? 2 : 1,
        pre: i % 4,
        post: i === 6 ? null : (i % 4) + (i === 9 ? 2 : 0),
        done: [{ id: "chinTuck", secs: 60 }, { id: "catCow", secs: 45 }],
        entries: [
          entry("gobletSquat", [{ w: lb(w), reps: 8 }, { w: lb(w), reps: 8 - (i % 2) }], { implement: "kettlebell", clenched: i === 9 }),
          entry("supportedRow", [{ w: lb(w), reps: 10 }], { implement: "kettlebell", perSide: true }),
          ...(i % 2 === 0 ? [entry("deadlift", [{ w: kg(16), reps: 6 + (i % 3) }], { implement: "kettlebell" })] : []),
          entry("sidePlankKnees", [{ secs: 20 + i }], { log: "time", metric: "time", format: "holds" }),
        ],
        newMove: i === 2 ? "sidePlankKnees" : null,
      }),
    );
  });
  return out;
}
