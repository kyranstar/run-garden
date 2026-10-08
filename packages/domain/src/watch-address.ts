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
 * A row the APP authored — an adaptive program's slot or an on-demand session (Phase 2 §2a). THE ONE PREDICATE
 * (ruling 2a-R4, extended by 3-R3 and 3-R9): its content is its build's, COROS never authors it, and nothing but the
 * athlete's own Send (and the cleanup of that send) may write it to the watch — no move, no rewrite, no create; the
 * import never rewrites it and never archives it by absence.
 */
export function appAuthoredRow(w: { origin: string | null }): boolean {
  return w.origin === "program" || w.origin === "on_demand";
}
