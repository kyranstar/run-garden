/**
 * THE REVIEW'S MODEL (Phase 2b Task 7; spec §2b "Review and save"; mocks §5). Pure: what the review shows of the
 * session just played and what Save sends.
 *
 *  - The moves reached, in order, each with its done sets (editable: the recorder's own edit rules) — a logged move
 *    with none says so.
 *  - Ratings, "not for me" and accepted graduations are the engine's pending change set (`Review`): nothing is
 *    decided until Save, and the server applies them with the save.
 *  - Records come from the history folded at Start (`Records.forSessionFrom` over the review basis); graduation
 *    offers from the basis's block and its lifts' recent entries (`Graduation.offers`), judged with the session's
 *    place's gear, as the server judges them on Save. Without a basis (Start went offline at once) there are none.
 */
import type { ReviewBasisDto, SessionExerciseDto } from "@rg/api-client";
import type { Weight } from "@rg/domain";
import { formatWeight } from "@rg/domain";
import type { EngineData } from "@rg/exercise-library";
import {
  Graduation,
  Recorder,
  Records,
  Review,
  toPerformedSave,
  type GraduationOffer,
  type Milestone,
  type PerformedSessionSave,
  type RecordEvent,
  type ReviewState,
} from "@rg/session-engine";
import type { PerformedSessionWire } from "@rg/domain";
import { isComplete, playerData, saveOf, withLive, type PlayerSource, type PlayerState } from "./run.js";

export interface ReviewSet {
  index: number;
  w: Weight | null;
  reps: number | null;
  secs: number | null;
  done: boolean;
}

export interface ReviewRow {
  exerciseId: string;
  name: string;
  isNew: boolean;
  /** A logged move (its sets are kept); otherwise only that it was done. */
  logged: boolean;
  /** Done, as the save counts it: a logged move with a done set; an unlogged one held half its time (ruling 2b-R15). */
  done: boolean;
  log: "load" | "time" | "reps" | null;
  metric: "reps" | "time" | null;
  perSide: boolean;
  sets: ReviewSet[];
}

/** The engine data the review reads: the build's slice plus the harder moves the basis brought. */
export const reviewData = (src: Pick<PlayerSource, "build" | "profiles">, basis: ReviewBasisDto | null): EngineData =>
  playerData(src, basis?.exercises ?? {});

/** Every move the session reached, in the order played, with its sets. */
export function reviewRows(state: PlayerState, exercises: Readonly<Record<string, SessionExerciseDto | undefined>>, newMove: string | null): ReviewRow[] {
  const ids: string[] = [];
  [...state.live.reached]
    .sort((a, b) => a - b)
    .forEach((i) => {
      const id = state.live.steps[i]?.exerciseId;
      if (id && !ids.includes(id)) ids.push(id);
    });
  const done = new Set(Recorder.movesDone(state.live));
  return ids.map((id) => {
    const e = state.live.entries[id];
    return {
      exerciseId: id,
      name: exercises[id]?.name ?? id,
      isNew: id === newMove,
      logged: !!e,
      done: done.has(id),
      log: e?.log ?? null,
      metric: e?.metric ?? null,
      perSide: e?.perSide ?? false,
      sets: (e?.sets ?? []).map((s, index) => ({ index, w: s.w, reps: s.reps, secs: s.secs, done: s.done })),
    };
  });
}

/** "30 lb × 6 · 30 lb × 6 · 30 lb × 9 each side", "40 s · 40 s", "8 · 8". */
export function setsLine(row: ReviewRow): string {
  const one = (s: ReviewSet) => {
    if (row.metric === "time") return `${s.w ? `${formatWeight(s.w)} · ` : ""}${s.secs ?? 0} s`;
    return s.w && row.log === "load" ? `${formatWeight(s.w)} × ${s.reps ?? 0}` : `${s.reps ?? 0}`;
  };
  const done = row.sets.filter((s) => s.done);
  return done.length ? `${done.map(one).join(" · ")}${row.perSide ? " each side" : ""}` : "";
}

/** A set's values edited on the review (the recorder's edit: later sets not touched yet follow). */
export function editSet(state: PlayerState, exerciseId: string, index: number, values: { w?: Weight | null; reps?: number | null; secs?: number | null }): PlayerState {
  return withLive(state, (live) => {
    if (values.w !== undefined) Recorder.update(live, exerciseId, index, "w", values.w);
    if (values.reps !== undefined) Recorder.update(live, exerciseId, index, "reps", values.reps);
    if (values.secs !== undefined) Recorder.update(live, exerciseId, index, "secs", values.secs);
  });
}

export function setDone(state: PlayerState, exerciseId: string, index: number, done: boolean): PlayerState {
  return withLive(state, (live) => Recorder.setDone(live, exerciseId, index, done));
}

export interface ReviewInputs {
  post: Readonly<Record<string, number | null>>;
  note: string;
  review: ReviewState;
}

export interface ReviewFacts {
  save: PerformedSessionSave;
  offers: GraduationOffer[];
  records: RecordEvent[];
  milestones: Milestone[];
}

/** The session as Save would send it, and what it earned, as of `endedAt`. */
export function reviewFacts(
  state: PlayerState,
  src: PlayerSource,
  data: EngineData,
  basis: ReviewBasisDto | null,
  inputs: Pick<ReviewInputs, "post" | "note">,
  endedAt: string,
): ReviewFacts {
  const save = saveOf(state, { endedAt, post: inputs.post, note: inputs.note, completed: isComplete(state) });
  if (!basis || basis.buildId !== src.build.buildId) return { save, offers: [], records: [], milestones: [] };
  const offers = Graduation.offers(
    data,
    { block: basis.graduation.block, sessions: basis.graduation.sessions, locations: [src.view.location], settings: { unit: basis.graduation.unit } },
    save,
  );
  const earned = Records.forSessionFrom(data, basis.records, save);
  return { save, offers, records: earned.records, milestones: earned.milestones };
}

/** The saved prefs the review's 👍 / 👎 / not-for-me toggle against. */
export const savedPrefs = (basis: ReviewBasisDto | null) => ({ ratings: basis?.prefs.ratings ?? {}, excluded: basis?.prefs.excluded ?? [], pinned: [] as string[] });

/** What Save puts in the outbox: the wire payload, validated (throws here rather than sitting in the outbox). */
export function wireOf(src: PlayerSource, facts: ReviewFacts, review: ReviewState): PerformedSessionWire {
  return toPerformedSave(facts.save, Review.pending(Review.prune(review, facts.offers), facts.offers), {
    source: "app",
    workoutId: src.workoutId,
    buildId: src.build.buildId,
  });
}
