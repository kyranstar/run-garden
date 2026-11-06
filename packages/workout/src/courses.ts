/**
 * THE COURSES: fixed practices made in code. Pure. A course's plan makes its sessions from its definition here: placing
 * them ahead, writing one on its day, Mark done, Pause and Stop all read only `CourseDefinition`, so nothing outside a
 * course's own entry names that course or what's in it. A new course is a new entry.
 */
import type { WorkoutDoc } from "@rg/domain";
import { TRE_VIDEOS, TRE_WHOLE_SEQUENCE_SESSIONS, treSessionDoc, type PracticeVideo } from "./tre-course.js";

export interface CourseDefinition {
  /** What a plan's config names it by (`courseConfigSchema.course`). */
  id: string;
  name: string;
  /** Session `n`'s document, numbered from 1. `ease` is what easing the next session means for this course. */
  sessionDoc(n: number, opts: { ease: boolean }): WorkoutDoc;
  /** Where `done` sessions leave the plan, while the course counts them; null once it no longer does. */
  sessionLabel(done: number): { session: number; of: number } | null;
  /** To watch instead of playing a session here. */
  videos: readonly PracticeVideo[];
  /** Why a plan of it exists, and what its next sessions must respect: its plan's own words to begin with. */
  purpose: string;
  brief: string;
  /** The disciplines its sessions count as. */
  disciplines: readonly string[];
}

const TRE: CourseDefinition = {
  id: "tre",
  name: "TRE",
  sessionDoc: (n, { ease }) => treSessionDoc(n, { ease }),
  sessionLabel: (done) => (done < TRE_WHOLE_SEQUENCE_SESSIONS ? { session: done + 1, of: TRE_WHOLE_SEQUENCE_SESSIONS } : null),
  videos: TRE_VIDEOS,
  purpose: "Looser hips and adductors and a calmer body, through a fixed sequence that lets the legs tremor.",
  brief:
    "A fixed sequence: keep the order. The whole sequence for the first 10 sessions, then the floor alone is often enough. " +
    "Up to 3 sessions a week. If you still feel worse after 48 hours, above 6 out of 10, halve the next tremor.",
  disciplines: ["yoga"],
};

export const COURSES: Readonly<Record<string, CourseDefinition>> = { [TRE.id]: TRE };

/**
 * The course with this id; null when there's none, such as an old id a plan still holds. Own keys only: a stored id of
 * "constructor" is no course. (Not Object.hasOwn: this package reaches older phones' browsers, which lack it.)
 */
export function courseDefinition(id: string): CourseDefinition | null {
  return Object.prototype.hasOwnProperty.call(COURSES, id) ? COURSES[id]! : null;
}

/** What a document a course made says it is, in its `source.ref`: `<id>-course:<n>`. */
const COURSE_REF = /^(.+)-course:(\d+)$/;

/**
 * The videos for a document with this `source.ref`: its course's, read from the ref, not stored in the document, so
 * offering them revises no planned session (a new revision would take its copy off the watch and send it again). A ref
 * that names no course, or a course gone, offers none. `find` is the lookup; only a test asks another.
 */
export function videosOfSource(ref: string | undefined, find: (id: string) => CourseDefinition | null = courseDefinition): readonly PracticeVideo[] {
  const named = COURSE_REF.exec(ref ?? "");
  return named ? (find(named[1]!)?.videos ?? []) : [];
}

/** The session of this course a document's `source.ref` names, numbered from 1; null for anything else. */
export function courseSessionOfRef(courseId: string, ref: string | null | undefined): number | null {
  const named = COURSE_REF.exec(ref ?? "");
  if (named?.[1] !== courseId) return null;
  const n = Number(named[2]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
