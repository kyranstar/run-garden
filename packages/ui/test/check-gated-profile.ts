import { PROFILES, TMJ, isPlyometric, type CheckReading, type ConditionProfile, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import { afterEach, beforeEach } from "vitest";

/**
 * A stand-in profile whose gates read today's check — TMJ's own rules until 2026-10-23: overhead pressing only on a
 * Develop or Peak day with an answered check of 2 or less, and jumps only above recovery, not feeling off, with one.
 *
 * Since 2026-10-23 TMJ's gates read only the mode and "feeling off" (an evidence review relaxed them), so no real
 * profile closes a move on an unanswered or high check any more. The Studio's own flows for such a gate — block with
 * the reason and a Fix, ask today's check instead of blocking, wait on a day ahead — are profile-agnostic and stay;
 * the tests that hold them use this stand-in in TMJ's place. Everything else is TMJ's.
 */
const calm = (today: CheckReading): boolean => today.pre != null && today.pre <= 2;
export const CHECK_GATED: ConditionProfile = {
  ...TMJ,
  allowPattern: (pattern, mode: Mode, today) => pattern !== "push-v" || (mode === "build" && calm(today)),
  allowRecord: (ex: ExerciseRecord, mode: Mode, today) => !isPlyometric(ex) || (mode !== "recovery" && !today.feelingOff && calm(today)),
  recordReason(ex, mode, today) {
    if (!isPlyometric(ex)) return null;
    if (mode === "recovery") return "No jumps on a recovery day.";
    if (today.feelingOff) return "No jumps while you're feeling off.";
    if (today.pre == null) return "Jumps need a jaw check first.";
    if (today.pre > 2) return `Jumps need a calm jaw (2 or less) — you're at ${today.pre}.`;
    return null;
  },
};

/** For the tests of the describe it is called in: the app's "tmj" (PROFILES.tmj) is the stand-in, then TMJ again. */
export function useCheckGatedTmj(): void {
  const profiles = PROFILES as unknown as Record<string, ConditionProfile>;
  beforeEach(() => {
    profiles.tmj = CHECK_GATED;
  });
  afterEach(() => {
    profiles.tmj = TMJ;
  });
}
