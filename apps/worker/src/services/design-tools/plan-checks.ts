/**
 * WHAT A PLAN'S SESSIONS WOULD MEET (2026-10-18, decision guidance; audit-decisions.md gaps 1 and 5): propose_plan's two
 * checks beside the thread coach's guardrails. Pure — no statement: the athlete's active profiles and today's reading
 * come with the athlete propose_plan already reads.
 *
 *  - `planConditionFindings`: every lift and mobility session's moves, resolved to the library as the apply resolves
 *    them (`resolveLibraryName`, then the move's current id — `docFromCoachSession`'s rule) or, failing that, through
 *    the athlete's synced COROS catalog (the wake's own name matcher, `resolveExerciseOriginId`, then the catalog row's
 *    T-code to the library move it maps: `libraryIdsByKey`). A name neither resolves can't be checked, so while a
 *    profile is on it is refused in words (fix round M3: "Jump squat", "Burpees" — free text the rules never saw).
 *    The moves are judged by `validateWorkoutDoc` against every
 *    active condition profile at the session's effort (`coachSessionEffort`) and day — a profile's never, its pattern
 *    and record gates, today's reading for a session today; on a later day a move a check could close needs an
 *    alternate that passes in recovery, and a session spec carries none — the way a document is judged (§2.7: a
 *    condition's "never" holds at every write path). Each hit is fatal. Judged a group at a time — one document per day
 *    (today or later) and effort, each name resolved once and each move judged once — since none of these rules reads
 *    the moves beside it: a validator call or two, not one a session (CPU: a plan of forty sessions).
 *  - `planOffWatchNote`: the runs the watch won't take (`watchPushable`: a run of duration blocks only), as one note
 *    for the card — a distance block keeps its session in the app.
 */
import { dayLabel, type CoachSession, type WorkoutDoc, type WorkoutItem } from "@rg/domain";
import type { CheckReading, ConditionProfile, ExerciseRecord } from "@rg/exercise-library";
import { coachSessionEffort, makeLibraryIndex, validateWorkoutDoc, type DocIssueCode } from "@rg/workout";
import { watchPushable } from "../coach-apply.js";
import { corosKeyOfName, libraryIdsByKey } from "../coros-exercise-map.js";
import { resolveExerciseOriginId, type ExerciseIndex } from "../exercise-catalog.js";
import { resolveLibraryName } from "../workout-doc-store.js";

/** What keeps a move out of a session: a document's condition codes (doc-build.ts GATE_CODES), as errors. */
const CONDITION_CODES: ReadonlySet<DocIssueCode> = new Set(["condition_never", "condition_pattern", "condition_gate", "condition_gate_pending"]);
/** A document part's most items (the domain's schema). */
const PART_ITEMS = 60;
/** The most dates the off-watch note names before "and N more". */
const NOTE_DAYS = 3;
const ITEM_ID = /^parts\[(\d+)\]\.items\[(\d+)\]\.libraryId$/;
/** The validator's fix for a later day's gate, which a session spec can't take: its words in a spec's terms. */
const ADD_ALTERNATE = /: add an alternate that suits a recovery day\.$/;
/** A catalog row's stored name when it is COROS's T-code (the sync stores the code; an older row may hold the words). */
const T_CODE = /^T\d+$/;

/** The athlete's synced COROS catalog: the wake's name index, and each row's stored name (its T-code) by id. */
export interface PlanCatalog {
  index: ExerciseIndex;
  names: ReadonlyMap<string, string>;
}

export interface PlanSession {
  date: string;
  session: CoachSession;
}

/**
 * Each move of the plan's lift and mobility sessions an active condition's rules keep out, in words: "Tue 19 May · Legs:
 * Pogo hops depends on that day's … check, and a plan session can't carry an alternate" (no closing stop). Empty when
 * none does.
 */
export function planConditionFindings(
  sessions: readonly PlanSession[],
  o: {
    profiles: readonly ConditionProfile[];
    readings: Readonly<Record<string, CheckReading>>;
    today: string;
    catalog?: PlanCatalog | null;
    /** What the moves are judged in: the account library's `all` (`loadAccountLibrary`). */
    library: readonly ExerciseRecord[];
  },
): string[] {
  if (o.profiles.length === 0) return [];
  const library = makeLibraryIndex(o.library);
  /** Through the catalog: the coach's words → the athlete's catalog row → its T-code → the library move it maps. */
  const viaCatalog = (name: string): string | undefined => {
    if (!o.catalog) return undefined;
    const originId = resolveExerciseOriginId(name, o.catalog.index);
    const stored = originId ? o.catalog.names.get(originId) : undefined;
    const key = stored ? (T_CODE.test(stored.trim()) ? stored.trim() : corosKeyOfName(stored)) : null;
    return key ? libraryIdsByKey().get(key) : undefined;
  };
  /** A name → the library move's current id, or null (no move to judge): each name resolved once. */
  const resolved = new Map<string, string | null>();
  const idOf = (name: string): string | null => {
    if (!resolved.has(name)) {
      const id = resolveLibraryName(name) ?? viaCatalog(name);
      resolved.set(name, id ? (library(id)?.id ?? null) : null);
    }
    return resolved.get(name)!;
  };
  const out: string[] = [];
  /** The names no move stands behind, each said once. */
  const unchecked = new Set<string>();
  /** A group: its day (today, or the first later one), its effort, and each move once with the first session holding it. */
  const groups = new Map<string, { date: string; effort: WorkoutDoc["intent"]["effort"]; moves: Map<string, string> }>();
  for (const { date, session } of sessions) {
    const body = session.lift ?? session.mobility;
    // A rest day holds no workout (`docFromCoachSession`).
    if (!body || session.category === "rest") continue;
    const later = date > o.today;
    const effort = coachSessionEffort(session.category);
    const key = `${later ? "later" : "today"}:${effort}`;
    const g = groups.get(key) ?? { date: later ? date : o.today, effort, moves: new Map<string, string>() };
    groups.set(key, g);
    const where = `${dayLabel(date)} · ${session.title}`;
    for (const e of body.exercises) {
      const id = idOf(e.name);
      // Said once a name: the first session holding it.
      if (id === null && !unchecked.has(e.name)) {
        unchecked.add(e.name);
        out.push(`${where}: I can't check '${e.name}' against your conditions — pick a move from the library`);
      }
      if (id && !g.moves.has(id)) g.moves.set(id, where);
    }
  }
  for (const g of groups.values()) {
    const ids = [...g.moves.keys()];
    if (ids.length === 0) continue;
    const parts = Array.from({ length: Math.ceil(ids.length / PART_ITEMS) }, (_, p) => ({
      purpose: "main" as const,
      format: "straight" as const,
      items: ids.slice(p * PART_ITEMS, (p + 1) * PART_ITEMS).map((libraryId): WorkoutItem => ({ kind: "exercise", libraryId, dose: { sets: 1, reps: 1 } })),
    }));
    const doc: WorkoutDoc = { version: 1, title: "Plan sessions", intent: { summary: "A plan's sessions.", goals: [], focus: [], effort: g.effort }, parts, source: { kind: "coach" } };
    const readings = g.date === o.today ? o.readings : {};
    for (const issue of validateWorkoutDoc(doc, { library: o.library, activeProfiles: o.profiles, day: { date: g.date, today: o.today, readings } })) {
      const at = ITEM_ID.exec(issue.path);
      // Every one of these is an error here: the document carries no alternates, the one thing that softens a later
      // day's gate to a note.
      if (!CONDITION_CODES.has(issue.code) || !at) continue;
      const id = ids[Number(at[1]) * PART_ITEMS + Number(at[2])];
      out.push(`${g.moves.get(id!)}: ${issue.message.replace(ADD_ALTERNATE, ", and a plan session can't carry an alternate").replace(/\.$/, "")}`);
    }
  }
  return out;
}

/** The card's note for the plan's runs that stay in the app — null when every run goes to the watch. */
export function planOffWatchNote(sessions: readonly PlanSession[]): { code: "plan_off_watch"; message: string } | null {
  const off = sessions.filter((s) => s.session.run && !watchPushable(s.session)).sort((a, b) => a.date.localeCompare(b.date));
  if (off.length === 0) return null;
  const why = "the watch takes timed sessions";
  if (off.length === 1) return { code: "plan_off_watch", message: `${dayLabel(off[0]!.date)} · ${off[0]!.session.title} stays in the app — ${why}` };
  const days = off.slice(0, NOTE_DAYS).map((s) => dayLabel(s.date));
  const more = off.length > NOTE_DAYS ? ` and ${off.length - NOTE_DAYS} more` : "";
  return { code: "plan_off_watch", message: `${off.length} runs stay in the app — ${why}: ${days.join(", ")}${more}` };
}
