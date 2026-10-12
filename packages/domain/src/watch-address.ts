/**
 * The address COROS is holding a session at, when the row can prove one.
 *
 * ONE PREDICATE, for the worker and the manifest alike (audit 1, coach finding
 * 6). It used to live in the worker, and the manifest kept a second copy
 * (`hasWatchAddress`) whose comment said it was "the shape `watchAddressOf`
 * requires" while leaving out `lastVerifiedCorosDate` — so a pushed session
 * that had since been UNPUSHED (an ease into content the wire cannot carry
 * clears that date and keeps the source ids) still read "· watch unchanged".
 *
 * Every field is a CLAIM the executor re-proves; this function's whole job is to
 * refuse to produce a half-address. `sourceWorkoutId` is `${corosPlanId}:${idInPlan}`
 * for a wire row and the row's own uuid for an app-authored one, so the shape
 * test is what separates "COROS has this" from "the app made this up".
 *
 * `lastVerifiedCorosDate` is required and is the interesting half: `""` means
 * COROS has never confirmed this row (audit#2 #1) or has just had it removed by
 * an unpush, and a write addressed at a day COROS does not hold the session on
 * is a write aimed at nothing.
 */
export interface WatchAddress {
  corosPlanId: string;
  idInPlan: string;
  programId: string;
  happenDay: string;
}

export interface WatchAddressFields {
  sourceWorkoutId?: string | null;
  sourceIdInPlan?: string | null;
  sourceProgramId?: string | null;
  lastVerifiedCorosDate?: string | null;
}

export function watchAddressOf(w: WatchAddressFields): WatchAddress | null {
  if (!w.sourceWorkoutId || !/^\d+:\d+$/.test(w.sourceWorkoutId)) return null;
  if (!w.sourceIdInPlan || !w.sourceProgramId) return null;
  if (!w.lastVerifiedCorosDate) return null;
  return {
    corosPlanId: w.sourceWorkoutId.split(":")[0]!,
    idInPlan: w.sourceIdInPlan,
    programId: w.sourceProgramId,
    happenDay: w.lastVerifiedCorosDate,
  };
}

/**
 * The origins of a DOCUMENT WORKOUT (Stage 2 spec §10; programme spec §3.11): a workout made in the Studio, or from a
 * saved template. Its content is its workout document — played through a build materialised from it, and revised
 * only as new revisions of that document.
 */
export const DOC_ORIGINS = ["studio", "template"] as const;

/** The origins of the app's own sessions: a programme's slot, an on-demand session, and a document workout. */
export const APP_AUTHORED_ORIGINS = ["program", "on_demand", ...DOC_ORIGINS] as const;

/**
 * A row the APP authored — an adaptive program's slot, an on-demand session (Phase 2 §2a), or a document workout from
 * the Studio or a template (Stage 2). THE ONE PREDICATE (ruling 2a-R4, extended by 3-R3 and 3-R9): its content is its
 * build's, COROS never authors it, and nothing but the athlete's own Send (and the cleanup of that send) may write it
 * to the watch — no move, no rewrite, no create; the import never rewrites it and never archives it by absence. In SQL:
 * `inArray(origin, [...APP_AUTHORED_ORIGINS])`.
 */
export function appAuthoredRow(w: { origin: string | null }): boolean {
  return (APP_AUTHORED_ORIGINS as readonly (string | null)[]).includes(w.origin);
}

/** A document workout (`DOC_ORIGINS`): built from its document, never by the engine. */
export function docOriginRow(w: { origin: string | null }): boolean {
  return (DOC_ORIGINS as readonly (string | null)[]).includes(w.origin);
}
