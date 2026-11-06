/**
 * THE COURSES: fixed practices made in code. Placement, writing, Mark done, Pause and Stop read only `CourseDefinition`,
 * so every course must hold to it the same way: its sessions judged clean with easing either way, a purpose and a brief
 * that fit a plan's limits, and a lookup that answers null, never a stray object, for an id it doesn't know.
 */
import { describe, expect, it } from "vitest";
import { PLAN_BRIEF_MAX, PLAN_PURPOSE_MAX, type WorkoutDoc } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, TMJ, type CheckReading } from "@rg/exercise-library";
import { COURSES, courseDefinition, deriveDoc, treSessionDoc, validateWorkoutDoc, videosOfSource, type DayContext } from "../src/index.js";
import { easedTremorSec } from "../src/tre-course.js";

const TRE = COURSES.tre!;
const COURSE_LIST = Object.values(COURSES);
const SESSIONS = Array.from({ length: 16 }, (_, i) => i + 1);

const holdOf = (doc: WorkoutDoc, id: string): number | undefined => {
  for (const part of doc.parts) for (const i of part.items) if (i.kind === "exercise" && i.libraryId === id) return i.dose.holdSec;
  return undefined;
};

const TODAY = "2026-03-10";
const calm: CheckReading = { pre: 1, post: null, feelingOff: false };
const calmDay: DayContext = { date: TODAY, today: TODAY, readings: { tmj: calm } };
const validate = (doc: WorkoutDoc, day: DayContext | null) => validateWorkoutDoc(doc, { library: EXERCISES, activeProfiles: [TMJ], day, excluded: [], equipment: EQUIPMENT_IDS });

describe("the lookup", () => {
  it("finds a course by its id, and each entry's key is its id", () => {
    expect(courseDefinition("tre")).toBe(TRE);
    for (const [key, course] of Object.entries(COURSES)) expect(course.id).toBe(key);
  });

  // A plain `COURSES[id]` answers `Object`'s own members for these, and placement would call one as a course.
  it.each(["gone", "", "constructor", "toString", "__proto__"])("answers null for %j", (id) => {
    expect(courseDefinition(id)).toBeNull();
  });
});

describe("easing TRE's next session", () => {
  it("halves the tremor: session 5's 600 s is 300", () => {
    expect(holdOf(TRE.sessionDoc(5, { ease: true }), "floorTremor")).toBe(300);
  });

  it("uneased, it is the course's own session", () => {
    expect(TRE.sessionDoc(5, { ease: false })).toEqual(treSessionDoc(5));
  });

  it("eases nothing but the tremor, and says the eased length", () => {
    const eased = TRE.sessionDoc(5, { ease: true });
    expect(holdOf(eased, "highWallSit")).toBe(300);
    expect(holdOf(eased, "legsUp")).toBe(300);
    expect(eased.intent.summary).toContain("for 5 minutes");
    expect(eased.source.ref).toBe("tre-course:5");
    // Session 1's 300 s halves to 150 s.
    expect(holdOf(TRE.sessionDoc(1, { ease: true }), "floorTremor")).toBe(150);
    expect(TRE.sessionDoc(1, { ease: true }).intent.summary).toContain("for 2.5 minutes");
  });

  // Half of any dose the course has today clears a minute, so the floor is held on the rule itself.
  it.each([
    [600, 300],
    [301, 150],
    [120, 60],
    [100, 60],
  ])("%i s eases to %i s, never under a minute", (sec, eased) => {
    expect(easedTremorSec(sec)).toBe(eased);
  });
});

describe("TRE's label", () => {
  it.each([
    [0, { session: 1, of: 10 }],
    [2, { session: 3, of: 10 }],
    [9, { session: 10, of: 10 }],
    [10, null],
    [11, null],
  ])("with %i done: %j", (done, label) => {
    expect(TRE.sessionLabel(done)).toEqual(label);
  });
});

describe("TRE's words and videos", () => {
  it("holds the rule the sessions used to carry", () => {
    expect(TRE.brief).toContain("first 10 sessions");
    expect(TRE.brief).toContain("48 hours");
    expect(TRE.brief).toContain("halve the next tremor");
  });

  it("offers the videos its sessions offer", () => {
    expect(TRE.videos.length).toBeGreaterThan(0);
    expect(TRE.videos).toEqual(videosOfSource(TRE.sessionDoc(1, { ease: false }).source.ref));
  });
});

describe.each(COURSE_LIST.map((c) => [c.id, c] as const))("every course: %s", (_id, course) => {
  it.each(SESSIONS)("session %i judges clean under the condition profile, eased or not", (n) => {
    for (const ease of [false, true]) {
      for (const day of [null, calmDay]) expect(validate(course.sessionDoc(n, { ease }), day)).toEqual([]);
    }
  });

  it("names a discipline its sessions count as", () => {
    for (const ease of [false, true]) {
      expect(course.disciplines).toContain(deriveDoc(course.sessionDoc(1, { ease }), EXERCISES).discipline);
    }
  });

  it("fits a plan's limits", () => {
    expect(course.name.length).toBeGreaterThan(0);
    expect(course.purpose.length).toBeGreaterThan(0);
    expect(course.purpose.length).toBeLessThanOrEqual(PLAN_PURPOSE_MAX);
    expect(course.brief.length).toBeGreaterThan(0);
    expect(course.brief.length).toBeLessThanOrEqual(PLAN_BRIEF_MAX);
  });
});
