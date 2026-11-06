import type { PlanStopResponse, PlanSummaryDto } from "@rg/api-client";

/**
 * What a plan's sheet says of the plan (plans with a purpose §4.3): what it is for, how it ends, the longer brief the
 * coach acts on (one tap down in the sheet) and the day it is paused until. Pure shaping from the plan's summary. A
 * blank purpose or brief is none: the sheet draws no line for it. A stopped plan has neither an ending ahead of it nor a
 * pause: whatever its row still holds, it says neither.
 */
export function planSheetWords(plan: PlanSummaryDto): { purpose: string | null; ending: string | null; brief: string | null; pausedUntil: string | null } {
  const stopped = plan.status === "retired";
  return {
    purpose: plan.purpose?.trim() || null,
    ending: stopped ? null : ENDINGS[plan.onEnd],
    brief: plan.brief?.trim() || null,
    pausedUntil: stopped ? null : plan.pausedUntil,
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

/**
 * Where a course has got to, on its row and its sheet. The numbers and the words past them are the server's, from the course's
 * definition, so a second course needs nothing here. A stopped one says so, wherever it got to; one the server can't place (its
 * definition gone) says nothing.
 */
export function courseRowState(plan: Pick<PlanSummaryDto, "status" | "course">): string {
  if (plan.status === "retired") return "Stopped";
  const c = plan.course;
  if (!c) return "";
  return "after" in c ? c.after : `Session ${c.session} of ${c.of}`;
}

/**
 * The most sends one stop makes. A stop takes off one written session a request and its outlines a few at a time, so this leaves
 * room for a course's sessions ahead, and past it the hourly pass finishes the job (`course-plans.ts`).
 */
export const STOP_SENDS_MAX = 30;

/** How a stop's sends ended (`stopInTurns`): nothing left; only what's on its way to the watch; or left to the hourly pass. */
export type StopOutcome = "stopped" | "waiting" | "left";

/**
 * Send a stop until nothing's left, or a resend can't help (`waiting`), or its bound. The first send is what stops the plan, so
 * only its failure is a failure. One after it just leaves the rest to the hourly pass.
 */
export async function stopInTurns(send: () => Promise<PlanStopResponse>, max = STOP_SENDS_MAX): Promise<StopOutcome> {
  for (let i = 0; i < max; i += 1) {
    let step: PlanStopResponse;
    try {
      step = await send();
    } catch (e) {
      if (i === 0) throw e;
      return "left";
    }
    if (!step.more) return "stopped";
    if (step.waiting) return "waiting";
  }
  return "left";
}

/** What the sheet says once it has stopped. */
export function stopOutcomeWords(outcome: StopOutcome): string {
  switch (outcome) {
    case "stopped":
      return "Stopped. Its sessions ahead have come off.";
    case "waiting":
      return "Stopped. A session on its way to your watch comes off once it lands.";
    case "left":
      return "Stopped. The rest comes off by itself.";
  }
}
