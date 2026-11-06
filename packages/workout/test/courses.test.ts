/**
 * THE COURSES: fixed practices made in code. Placement, writing, Mark done, Pause and Stop read only `CourseDefinition`,
 * so every course must hold to it the same way: its sessions judged clean with easing either way, a purpose and a brief
 * that fit a plan's limits, and a lookup that answers null, never a stray object, for an id it doesn't know.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_BRIEF_MAX, PLAN_PURPOSE_MAX, type WorkoutDoc } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, TMJ, type CheckReading } from "@rg/exercise-library";
import { COURSES, courseDefinition, courseSessionOfRef, deriveDoc, treSessionDoc, validateWorkoutDoc, videosOfSource, type CourseDefinition, type DayContext } from "../src/index.js";
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

describe("the videos of a document's source", () => {
  /** A second course that needs nothing but its entry. Added and taken out again by the test. */
  const SECOND: CourseDefinition = { ...TRE, id: "second", videos: [{ label: "Watch", url: "https://example.com/second" }] };
  const courses = COURSES as Record<string, CourseDefinition>;

  afterEach(() => {
    delete courses[SECOND.id];
  });

  it("a course with videos works by adding its definition, and nothing else", () => {
    expect(videosOfSource("second-course:3")).toEqual([]);
    courses[SECOND.id] = SECOND;
    expect(videosOfSource("second-course:3")).toEqual(SECOND.videos);
    expect(videosOfSource("tre-course:3")).toEqual(TRE.videos);
  });

  it("a course with a hyphen in its id is found whole", () => {
    courses["two-part"] = { ...SECOND, id: "two-part" };
    expect(videosOfSource("two-part-course:1")).toEqual(SECOND.videos);
    delete courses["two-part"];
  });

  it("a course with no videos offers none", () => {
    courses[SECOND.id] = { ...SECOND, videos: [] };
    expect(videosOfSource("second-course:1")).toEqual([]);
  });

  it.each([undefined, "", "second-course", "second-course:", "second-course:x", "second-course:1x", "second-courses:1", "not-second-course:1", "constructor-course:1", "__proto__-course:1", "-course:1", "x\nsecond-course:1"])(
    "%s offers none",
    (ref) => {
      courses[SECOND.id] = SECOND;
      expect(videosOfSource(ref)).toEqual([]);
    },
  );

  it("can be asked to look elsewhere: a definition found there is the answer", () => {
    expect(videosOfSource("second-course:1", (id) => (id === SECOND.id ? SECOND : null))).toEqual(SECOND.videos);
  });
});

describe("which session of a course a document's source names", () => {
  it.each([
    ["tre-course:1", 1],
    ["tre-course:12", 12],
  ])("%s is session %i of that course", (ref, n) => {
    expect(courseSessionOfRef("tre", ref)).toBe(n);
  });

  it.each([undefined, null, "", "tre-course", "tre-course:", "tre-course:0", "tre-course:-1", "tre-course:1.5", "tre-course:1x", "tre-courses:1", "not-tre-course:1", "TRE-course:1", " tre-course:1", "x\ntre-course:1", "tre-course:99999999999999999999"])(
    "%s is no session of it",
    (ref) => {
      expect(courseSessionOfRef("tre", ref)).toBeNull();
    },
  );

  it("names only the course asked about", () => {
    expect(courseSessionOfRef("other", "tre-course:1")).toBeNull();
    expect(courseSessionOfRef("not-tre", "not-tre-course:1")).toBe(1);
  });

  it("every course's sessions name themselves by their number", () => {
    for (const course of COURSE_LIST) expect(courseSessionOfRef(course.id, course.sessionDoc(3, { ease: false }).source.ref)).toBe(3);
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
