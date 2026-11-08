/**
 * The coach designer's op kinds, as SQL reads them — an op the athlete can still decide (coach-runs.ts `OPEN_OP`), a plan's
 * draft's proposal (plan-ending.ts `planDraftsSql`) — named once: the kinds proposal-kinds.ts `isDesignedOp` knows (a test
 * holds the two together). A module of its own, with no imports, so the plans' reads take it without the proposal kinds'
 * own imports coming with it.
 */
export const DESIGNED_OP_KINDS = ["doc_workout", "plan_adjust", "plan_structure", "programme_change", "plan_change", "move_pins", "import_correction", "objective_change"] as const;
