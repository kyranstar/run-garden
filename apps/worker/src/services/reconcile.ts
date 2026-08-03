/**
 * SYNC RECONCILER CORE — the single decision table for workout-date sync.
 *
 * Policy (spec §2): last-edit-wins with the tie broken toward the app. An OPEN
 * intent is by definition the most recent thing the user did in-app; COROS's
 * change time is unknowable inside a snapshot window, so when both changed,
 * the intent stands and the COROS value is surfaced as an undo note. With no
 * open intent, COROS is adopted automatically.
 *
 * Pure on purpose: every transition is unit-testable without a database.
 */

export interface WorkoutFacts {
  workoutId: string;
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  observedDate: string;
  openIntent: { id: string; toDate: string } | null;
  pendingJob: { id: string; destinationDate: string } | null;
}

export type ReconcileAction =
  | { act: "none" }
  | { act: "verify_job"; jobId: string; intentId: string | null }
  | { act: "adopt_coros"; toDate: string; note: { previousDate: string } | null }
  | {
      act: "app_wins";
      intentId: string;
      keepDate: string;
      supersedeJobId: string | null;
      note: { displacedDate: string };
    };

export function reconcileWorkout(f: WorkoutFacts): ReconcileAction {
  const upstreamChanged = f.observedDate !== f.lastVerifiedCorosDate;

  if (!upstreamChanged) {
    return { act: "none" }; // includes "our move hasn't landed yet"
  }

  // COROS now shows a new date.
  if (f.pendingJob && f.observedDate === f.pendingJob.destinationDate) {
    return { act: "verify_job", jobId: f.pendingJob.id, intentId: f.openIntent?.id ?? null };
  }
  if (f.openIntent && f.observedDate === f.openIntent.toDate) {
    // No job (or a job aimed elsewhere), but COROS already agrees with the
    // intent — converged by the user's own hand on the other side.
    return { act: "verify_job", jobId: f.pendingJob?.id ?? "", intentId: f.openIntent.id };
  }
  if (f.openIntent) {
    return {
      act: "app_wins",
      intentId: f.openIntent.id,
      keepDate: f.openIntent.toDate,
      supersedeJobId: f.pendingJob?.id ?? null,
      note: { displacedDate: f.observedDate },
    };
  }
  return {
    act: "adopt_coros",
    toDate: f.observedDate,
    note: { previousDate: f.lastVerifiedCorosDate },
  };
}
