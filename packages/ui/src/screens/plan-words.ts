import type { PlanSummaryDto } from "@rg/api-client";

/**
 * What a plan's sheet says of the plan (plans with a purpose §4.3): what it is for, how it ends, the longer brief the
 * coach acts on (one tap down in the sheet) and the day it is paused until. Pure shaping from the plan's summary. A
 * blank purpose or brief is none: the sheet draws no line for it.
 */
export function planSheetWords(plan: PlanSummaryDto): { purpose: string | null; ending: string; brief: string | null; pausedUntil: string | null } {
  return {
    purpose: plan.purpose?.trim() || null,
    ending: ENDINGS[plan.onEnd],
    brief: plan.brief?.trim() || null,
    pausedUntil: plan.pausedUntil,
  };
}

const ENDINGS = {
  ask: "Asks you when it ends",
  continue: "Continues on its own",
  finish: "Ends when its sessions do",
} as const satisfies Record<PlanSummaryDto["onEnd"], string>;

/** The words "Change" writes in the coach's box: the athlete's to finish and send, never sent for them. */
export function changePlanRequest(name: string): string {
  return `Change how my ${name} plan works: `;
}
