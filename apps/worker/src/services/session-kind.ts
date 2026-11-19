/**
 * WHAT A PLANNED ROW IS, IN THE PHONE'S TERMS (DESIGN-2c §2.1): where it comes from (`kind`, which the phone says in words)
 * and how *What's in it* can be read ahead of its day (`content`, which `/ahead` answers as its `basis`). Pure: read from the
 * row and its plan's kind as one read holds them, with no statement of its own. `/days` and `/ahead` share it, so a row's
 * content on the one is the basis the other builds.
 */
import { unwrittenCourseOutline } from "./course-sessions.js";

/** Where a session comes from (§2.1 `kind`). */
export type SessionKind = "course" | "programme" | "on_demand" | "studio" | "template" | "coach" | "watch_plan" | "other";
/** How *What's in it* can be read ahead (§2.1 `content`). */
export type SessionContent = "document" | "engine" | "outline" | "stages" | "none";

/** What the two read of a row: its own columns, and its plan's kind (null: no plan of the account's by that id). */
export interface KindFacts {
  id: string;
  origin: string | null;
  contentState: string | null;
  courseSession: number | null;
  planKind: string | null;
  sport: string;
  /** Whether the row holds a document (1/true) or a stage summary. */
  hasDoc: number | boolean;
  hasStages: number | boolean;
}

/** A course's own session: an outline of the course, or a row with its number (mark-done.ts's `OWN_SESSION`). */
const courseOwn = (r: KindFacts): boolean => r.planKind === "course" && (r.origin === "program" || r.courseSession !== null);

export function sessionKind(r: KindFacts): SessionKind {
  if (courseOwn(r)) return "course";
  if (r.origin === "program") return "programme";
  if (r.origin === "on_demand") return "on_demand";
  if (r.origin === "studio") return "studio";
  if (r.origin === "template") return "template";
  // A coach-designed run, a coach plan's row, or one the thread coach created (`cw-` ids: plan.ts's `appMadeRow`).
  if (r.origin === "coach" || r.planKind === "coach" || r.id.startsWith("cw-")) return "coach";
  if (r.planKind === "coros_import") return "watch_plan";
  return "other";
}

/**
 * How the row's *What's in it* is read ahead of its day: its document (held), the engine (a programme's or on-demand slot),
 * a course's unwritten outline, a run's stage summary, or nothing.
 */
export function sessionContent(r: KindFacts): SessionContent {
  if (Number(r.hasDoc)) return "document";
  if (unwrittenCourseOutline(r, r.planKind)) return "outline";
  // A course's row that isn't an outline and holds no document is never the engine's (`PROGRAM_IS_COURSE`).
  if (r.origin === "program" && r.planKind === "course") return "none";
  if (r.origin === "program" || r.origin === "on_demand") return "engine";
  if (r.sport === "run" && Number(r.hasStages)) return "stages";
  return "none";
}
