/**
 * THE POSTURE AND NECK COURSE: a few minutes of neck and posture work, then a minute of jaw-reset breathing, from moves that
 * need nothing beyond a wall or a chair. Two sessions take turns for as long as the course runs, and easing one plays the
 * short version. Each starts on the floor and gets up from there, never back down. Every session validates clean for an
 * athlete with an active condition profile at a real place (the "Mat only" preset, a bare room) whatever the day, plays 5 to
 * 8 minutes in the player, counts as a calm session (never a lift), and its course keeps it off the watch. Synthetic; nothing
 * personal.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc, WorkoutItem } from "@rg/domain";
import { EXERCISES, LOCATION_PRESETS, NO_EQUIPMENT_GEAR, TMJ, isPracticeMove, type CheckReading } from "@rg/exercise-library";
import {
  COURSES,
  courseDefinition,
  courseSessionOfRef,
  deriveDoc,
  playerStepsFromDoc,
  postureNeckSessionDoc,
  validateWorkoutDoc,
  videosOfSource,
  type DayContext,
} from "../src/index.js";

/** Odd sessions: the shoulders' turn. */
const DOOR_OPENERS = ["chinNodHold", "neckRotations", "chairThoracicExtension", "doorOpeners", "breath"];
/** Even sessions: the wall's turn. */
const WALL_ANGELS = ["chinNodHold", "neckRotations", "chairThoracicExtension", "wallAngels", "breath"];
/** Any session eased: the turn's own standing move left out. */
const SHORT = ["chinNodHold", "neckRotations", "chairThoracicExtension", "breath"];
const EVERY_MOVE = [...new Set([...DOOR_OPENERS, ...WALL_ANGELS])];

const exercises = (doc: WorkoutDoc): Array<Extract<WorkoutItem, { kind: "exercise" }>> =>
  doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i] : [])));
const moves = (doc: WorkoutDoc): string[] => exercises(doc).map((i) => i.libraryId);
const record = (id: string) => EXERCISES.find((e) => e.id === id)!;

/** Real places' gear: the "Mat only" preset, and the bare room a "No equipment" place stands for. */
const MAT_ONLY = LOCATION_PRESETS.find((p) => p.id === "mat")!.equipment;
const PLACES = [
  ["Mat only", MAT_ONLY],
  ["No equipment", NO_EQUIPMENT_GEAR],
] as const;

const TODAY = "2026-03-10";
const reading = (pre: number | null, feelingOff = false): CheckReading => ({ pre, post: null, feelingOff });
const dayOf = (r: CheckReading | null, o: Partial<DayContext> = {}): DayContext => ({ date: TODAY, today: TODAY, readings: { tmj: r }, ...o });
const validate = (doc: WorkoutDoc, day: DayContext | null, equipment: readonly string[]) =>
  validateWorkoutDoc(doc, { library: EXERCISES, activeProfiles: [TMJ], day, excluded: [], equipment: [...equipment] });
const SESSIONS = Array.from({ length: 8 }, (_, i) => i + 1);
const BOTH = [false, true];

describe("the course's sessions", () => {
  it.each([1, 3, 5, 99])("session %i is the shoulders' turn", (n) => {
    expect(moves(postureNeckSessionDoc(n))).toEqual(DOOR_OPENERS);
  });

  it.each([2, 4, 6, 100])("session %i is the wall's turn", (n) => {
    expect(moves(postureNeckSessionDoc(n))).toEqual(WALL_ANGELS);
  });

  it.each([1, 2, 7, 8])("session %i eased is the short one", (n) => {
    expect(moves(postureNeckSessionDoc(n, { ease: true }))).toEqual(SHORT);
  });

  // Getting onto the floor is the slow change: it comes first, before the player starts, and never mid-session.
  it("starts lying down, then sits, then stands, then the breathing: never back down to the floor", () => {
    const positions = (doc: WorkoutDoc) => moves(doc).map((id) => record(id).position);
    expect(positions(postureNeckSessionDoc(1))).toEqual(["supine", "seated", "seated", "standing", "seated"]);
    expect(positions(postureNeckSessionDoc(2))).toEqual(["supine", "seated", "seated", "standing", "seated"]);
    expect(positions(postureNeckSessionDoc(1, { ease: true }))).toEqual(["supine", "seated", "seated", "seated"]);
  });

  it("reads well in the plan list: the course's name, then which turn it is", () => {
    expect(postureNeckSessionDoc(1).title).toBe("Posture & neck · door openers");
    expect(postureNeckSessionDoc(2).title).toBe("Posture & neck · wall angels");
    expect(postureNeckSessionDoc(1, { ease: true }).title).toBe("Posture & neck · short");
    expect(postureNeckSessionDoc(2, { ease: true }).title).toBe("Posture & neck · short");
  });

  it("says what it is, generically, and carries no notes: the course's rule is the plan's brief, once", () => {
    for (const ease of BOTH) {
      for (const n of [1, 2]) {
        const doc = postureNeckSessionDoc(n, { ease });
        expect(doc).not.toHaveProperty("notes");
        expect(doc.intent.summary).toMatch(/jaw-reset breathing/);
        expect(doc.intent.effort).toBe("recover");
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses session %s", (n) => {
    expect(() => postureNeckSessionDoc(n)).toThrow(RangeError);
  });

  // Past the last safe whole number its source would name a session nothing could read back (`courseSessionOfRef`).
  it("refuses a number past the last safe whole one", () => {
    expect(courseSessionOfRef("posture-neck", `posture-neck-course:${2 ** 53}`)).toBeNull();
    expect(() => postureNeckSessionDoc(2 ** 53)).toThrow(RangeError);
  });
});

describe("the rotation repeats without a number that ends", () => {
  it("two sessions apart is the same session, whatever the number", () => {
    for (const n of [...Array.from({ length: 60 }, (_, i) => i + 1), 10_001, 2 ** 40]) {
      for (const ease of BOTH) {
        const { source: a, ...one } = postureNeckSessionDoc(n, { ease });
        const { source: b, ...two } = postureNeckSessionDoc(n + 2, { ease });
        expect(two).toEqual(one);
        expect([a.ref, b.ref]).toEqual([`posture-neck-course:${n}`, `posture-neck-course:${n + 2}`]);
      }
    }
  });

  it("the last safe whole number is a session too, and names itself", () => {
    const n = Number.MAX_SAFE_INTEGER;
    expect(moves(postureNeckSessionDoc(n))).toEqual(DOOR_OPENERS);
    expect(courseSessionOfRef("posture-neck", postureNeckSessionDoc(n).source.ref)).toBe(n);
  });

  it("the course never counts toward an end: no session is ever a numbered one of so many", () => {
    const course = courseDefinition("posture-neck")!;
    for (const done of [0, 1, 2, 9, 10, 500]) expect(course.sessionLabel(done)).toBeNull();
    expect(course.afterLabel).toBe("A few minutes, off the watch");
  });
});

describe("the course's doses: the record's own", () => {
  // A reps move plays its record's middle, as the record's own dose reads (`deriveDoc`, a dose with no amount): a range's
  // halves rounded up. Neck rotations alternate, so their count is each side's.
  it.each([
    ["neckRotations", { reps: 7, perSide: true }],
    ["chairThoracicExtension", { reps: 10 }],
    ["doorOpeners", { reps: 10 }],
    ["wallAngels", { reps: 8 }],
    ["chinNodHold", { reps: 7 }],
  ])("%s: %j, one set", (id, dose) => {
    const rec = record(id);
    expect(rec.dose.type).toBe("reps");
    const [lo, hi] = rec.dose.range;
    expect(dose.reps).toBe(Math.round((lo + hi) / 2));
    for (const doc of [postureNeckSessionDoc(1), postureNeckSessionDoc(2), postureNeckSessionDoc(1, { ease: true })]) {
      for (const item of exercises(doc).filter((i) => i.libraryId === id)) expect(item.dose).toEqual({ sets: 1, ...dose });
    }
  });

  it("a minute of the jaw-reset breathing, the low end of its record's time", () => {
    const rec = record("breath");
    expect(rec.name).toBe("Jaw reset breathing");
    expect(rec.dose).toMatchObject({ type: "time", range: [60, 120] });
    for (const doc of [postureNeckSessionDoc(1), postureNeckSessionDoc(2), postureNeckSessionDoc(2, { ease: true })]) {
      expect(exercises(doc).at(-1)).toEqual({ kind: "exercise", libraryId: "breath", dose: { sets: 1, holdSec: 60 } });
    }
  });
});

describe("the course's moves", () => {
  it("are all in the library", () => {
    const ids = new Set(EXERCISES.map((e) => e.id));
    expect(EVERY_MOVE.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("are rated clean for the jaw profile: no clench, no neck load, never face down", () => {
    for (const id of EVERY_MOVE) expect([id, record(id).conditions.tmj]).toEqual([id, { clench: 0, neckLoad: 0, faceDown: false }]);
  });

  it("are general moves, not a fixed practice's own: the day's build may pick them as ever", () => {
    expect(EVERY_MOVE.filter((id) => isPracticeMove(record(id)))).toEqual([]);
  });

  it("need nothing beyond a wall or a chair, which both real places hold", () => {
    for (const id of EVERY_MOVE) {
      const { all, oneOf } = record(id).equipment;
      expect([id, all.filter((e) => e !== "wall" && e !== "chair"), oneOf]).toEqual([id, [], []]);
    }
    for (const [, gear] of PLACES) expect([...gear]).toEqual(expect.arrayContaining(["wall", "chair"]));
    expect(deriveDoc(postureNeckSessionDoc(1), EXERCISES).equipment).toEqual({ all: ["chair"], oneOf: [] });
    expect(deriveDoc(postureNeckSessionDoc(2), EXERCISES).equipment).toEqual({ all: ["chair", "wall"], oneOf: [] });
    expect(deriveDoc(postureNeckSessionDoc(1, { ease: true }), EXERCISES).equipment).toEqual({ all: ["chair"], oneOf: [] });
  });
});

describe("the course as a workout", () => {
  describe.each(PLACES)("at a place with %s's gear", (_place, gear) => {
    it.each(SESSIONS)("session %i, eased or not, raises nothing at all: calm, flare, feeling off, unanswered, a day ahead, a template", (n) => {
      const days: Array<DayContext | null> = [null, dayOf(reading(1)), dayOf(reading(7)), dayOf(reading(10)), dayOf(reading(2, true)), dayOf(null), dayOf(null, { date: "2026-03-13" })];
      for (const ease of BOTH) for (const day of days) expect(validate(postureNeckSessionDoc(n, { ease }), day, gear)).toEqual([]);
    });
  });

  it("somewhere with neither a wall nor a chair, it says what's missing and nothing else", () => {
    const codes = (n: number, ease: boolean) => [...new Set(validate(postureNeckSessionDoc(n, { ease }), dayOf(reading(7)), []).map((i) => `${i.severity}:${i.code}`))];
    expect(codes(1, false)).toEqual(["warning:equipment_unavailable"]);
    expect(codes(2, false)).toEqual(["warning:equipment_unavailable"]);
    expect(codes(1, true)).toEqual(["warning:equipment_unavailable"]);
  });

  it.each(SESSIONS)("session %i, eased or not, counts as a calm session, not a lift", (n) => {
    for (const ease of BOTH) {
      const derived = deriveDoc(postureNeckSessionDoc(n, { ease }), EXERCISES);
      expect([derived.discipline, derived.category]).toEqual(["yoga", "yoga"]);
    }
  });

  // What the calendar books from, by hand: each move's work plus 15 s to set up. Chin nods 7 x 12 s = 84 s; neck rotations 7
  // a side x 6 s = 84 s; chair thoracic extension and door openers 10 x 6 s = 60 s; wall angels 8 x 5 s = 40 s; the breathing
  // 60 s. Door openers: 99 + 99 + 75 + 75 + 75 = 423 s. Wall angels: 99 + 99 + 75 + 55 + 75 = 403 s. Short: 99 + 99 + 75 + 75
  // = 348 s.
  it.each([
    [1, false, 7],
    [2, false, 7],
    [1, true, 6],
    [2, true, 6],
  ])("session %i (eased: %s) books about %i minutes", (n, ease, minutes) => {
    expect(deriveDoc(postureNeckSessionDoc(n, { ease }), EXERCISES).estimatedMinutes).toBe(minutes);
  });
});

describe("the course in the player", () => {
  const steps = (doc: WorkoutDoc) => playerStepsFromDoc(doc, EXERCISES);
  const played = (doc: WorkoutDoc) => steps(doc).map((s) => [s.exerciseId, s.kind, s.seconds, s.prepGap, s.side]);
  /** What the player really takes: every window, and the get-ready before it (`readyMs`). */
  const playedSeconds = (doc: WorkoutDoc) => steps(doc).reduce((sum, s) => sum + s.seconds + s.prepGap, 0);

  // Every move on a timer, hands free, each with the 8 s get-ready a hold has: every move but the first changes position. A
  // window of reps is the record's seconds a rep, rounded to 5 s: chin nods 7 x 12 s = 84 s; neck rotations 7 a side x 6 s =
  // 84 s, one window for both sides (they alternate); chair thoracic extension and door openers 10 x 6 s; wall angels 8 x 5 s.
  it("plays the shoulders' turn on timers, straight through", () => {
    expect(played(postureNeckSessionDoc(1))).toEqual([
      ["chinNodHold", "timed", 85, 8, null],
      ["neckRotations", "timed", 85, 8, null],
      ["chairThoracicExtension", "timed", 60, 8, null],
      ["doorOpeners", "timed", 60, 8, null],
      ["breath", "timed", 60, 8, null],
    ]);
  });

  it("plays the wall's turn the same way", () => {
    expect(played(postureNeckSessionDoc(2))).toEqual([
      ["chinNodHold", "timed", 85, 8, null],
      ["neckRotations", "timed", 85, 8, null],
      ["chairThoracicExtension", "timed", 60, 8, null],
      ["wallAngels", "timed", 40, 8, null],
      ["breath", "timed", 60, 8, null],
    ]);
  });

  it("plays the short one, and ends on the breathing", () => {
    expect(played(postureNeckSessionDoc(3, { ease: true }))).toEqual([
      ["chinNodHold", "timed", 85, 8, null],
      ["neckRotations", "timed", 85, 8, null],
      ["chairThoracicExtension", "timed", 60, 8, null],
      ["breath", "timed", 60, 8, null],
    ]);
  });

  // By hand, from the windows above and 8 s before each: door openers 350 + 40 = 390 s (6.5 minutes); wall angels 330 + 40 =
  // 370 s (about 6); the short one 290 + 32 = 322 s (about 5).
  it.each([
    [1, false, 390],
    [2, false, 370],
    [1, true, 322],
    [2, true, 322],
  ])("session %i (eased: %s) really takes %i s in the player", (n, ease, seconds) => {
    expect(playedSeconds(postureNeckSessionDoc(n, { ease }))).toBe(seconds);
  });

  it.each(SESSIONS)("session %i plays 5 to 8 minutes, eased or not, and easing makes it shorter", (n) => {
    const full = playedSeconds(postureNeckSessionDoc(n));
    const eased = playedSeconds(postureNeckSessionDoc(n, { ease: true }));
    for (const s of [full, eased]) {
      expect(s).toBeGreaterThanOrEqual(5 * 60 - 30);
      expect(s).toBeLessThanOrEqual(8 * 60);
    }
    expect(eased).toBeLessThan(full);
  });
});

describe("the course's definition", () => {
  const course = COURSES["posture-neck"]!;

  it("is found by its id, and makes its sessions with this module", () => {
    expect(courseDefinition("posture-neck")).toBe(course);
    expect(course).toMatchObject({ id: "posture-neck", name: "Posture & neck", disciplines: ["yoga"], videos: [] });
    for (const ease of BOTH) for (const n of [1, 2, 3]) expect(course.sessionDoc(n, { ease })).toEqual(postureNeckSessionDoc(n, { ease }));
  });

  it("keeps its sessions off the watch, by its one flag; TRE's go as any session's do", () => {
    expect(course.watch).toBe(false);
    expect(COURSES.tre!.watch).toBeUndefined();
  });

  it("offers no video", () => {
    expect(videosOfSource(postureNeckSessionDoc(1).source.ref)).toEqual([]);
  });

  it("its plan's words are its own to begin with: what it's for, and the rule its sessions keep, easing among it", () => {
    expect(course.purpose).toMatch(/neck/);
    expect(course.brief).toMatch(/ease/i);
    expect(course.brief).toMatch(/teeth apart/);
  });
});
