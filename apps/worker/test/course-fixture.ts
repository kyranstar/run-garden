/**
 * A SECOND COURSE, MADE UP: worker code reads only `CourseDefinition`, and running its paths on a course that isn't the
 * real one proves it. A test adds it by mocking `@rg/workout` (there is no way in from production code):
 *
 *   vi.mock("@rg/workout", async (importOriginal) => {
 *     const { withIntroCourse } = await import("./course-fixture.js");
 *     return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
 *   });
 *
 * Its length by hand: `legsUp`'s hold plus 15 s of transition, rounded to the minute. Sessions 1 and 2 hold 660 s, so 11
 * minutes; session 3 on hold 1,320 s, so 22. Easing halves the hold. Neither is a whole five minutes on purpose: the
 * calendar books them rounded up, 900 s and 1,500 s.
 */
import type { WorkoutDoc } from "@rg/domain";
import type { CourseDefinition } from "@rg/workout";

export const INTRO_FIRST_SECONDS = 660;
export const INTRO_FIRST_BOOKED = 900;
export const INTRO_LATER_SECONDS = 1320;
export const INTRO_LATER_BOOKED = 1500;

const sessionDoc = (n: number, { ease }: { ease: boolean }): WorkoutDoc => {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`A session is numbered from 1 (got ${n}).`);
  const hold = n <= 2 ? INTRO_FIRST_SECONDS : INTRO_LATER_SECONDS;
  return {
    version: 1,
    title: `Intro ${n}`,
    intent: { summary: "Rest on the floor.", goals: ["recovery"], focus: ["hips"], effort: "recover" },
    parts: [{ purpose: "main", format: "holds", why: "Rest.", items: [{ kind: "exercise", libraryId: "legsUp", dose: { sets: 1, holdSec: ease ? hold / 2 : hold } }] }],
    source: { kind: "studio", ref: `intro-course:${n}` },
  };
};

export const INTRO_COURSE: CourseDefinition = {
  id: "intro",
  name: "Intro",
  sessionDoc,
  sessionLabel: (done) => (done < 4 ? { session: done + 1, of: 4 } : null),
  afterLabel: "Open practice",
  videos: [{ label: "Watch", url: "https://example.com/intro" }],
  purpose: "A made-up practice for tests.",
  brief: "Keep the order.",
  disciplines: ["yoga"],
};

/** `@rg/workout` with the made-up course beside the real ones, found the way the real lookup finds them. */
export function withIntroCourse<T extends Pick<typeof import("@rg/workout"), "COURSES" | "courseDefinition" | "videosOfSource">>(real: T) {
  const courseDefinition = (id: string): CourseDefinition | null => (id === INTRO_COURSE.id ? INTRO_COURSE : real.courseDefinition(id));
  return {
    ...real,
    COURSES: { ...real.COURSES, [INTRO_COURSE.id]: INTRO_COURSE },
    courseDefinition,
    videosOfSource: (ref: string | undefined) => real.videosOfSource(ref, courseDefinition),
  };
}
