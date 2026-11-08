/**
 * DRAFTING A PLAN'S NEXT STRETCH (plans with a purpose §4.2; rulings R51–R54). A coach plan that continues — a lifting plan,
 * say — doesn't ask what comes next: the hourly pass sees it ending and starts ONE coach run, a request the app writes,
 * at most once per ending. What the run makes is a normal reviewed proposal: nothing reaches the plan until the athlete
 * approves it. It is the one spend the athlete doesn't start, so every guard is the point:
 *
 *  - THE SWITCH (`planDraftsOn`): `PLAN_DRAFTS = "1"`, with the step alarm on (a run with no alarm never steps:
 *    coach-run-stepper.ts `stepAlarmOn`) and the coach designer. Off, nothing here runs, and every caller of the prompt
 *    rule reads every plan as it always has (the routes pass the same switch to `listPlans` and `readCoachOpening`).
 *  - WHICH PLAN: an active, unpaused `coach` plan whose ending is `continue`, ending as the chip reads it (the one rule,
 *    `promptOfPlan` with drafts off, over `plansAsRead`: its last session today or within PLAN_PROMPT_DAYS, no phase or
 *    outline week following, not followed by a later plan of its sport), with no proposal waiting that names it and no key
 *    yet for this ending — read in one statement (`readPlanEndings` with drafts: plan-ending.ts `planDraftsSql`), the same
 *    the chip and the row read, so the key and the prompt agree. The soonest ending of them; one an account a pass.
 *  - ONCE PER ENDING, HOWEVER PASSES RACE. The key is `plan-draft:<planId>:<lastSessionDate>`, the id of an `audit_events`
 *    row, written in the run's own insert batch (coach-runs.ts `createRun`'s `once`): the key only while no row has that id,
 *    the account has no live run, no restore is under way and the plan is still active and unpaused; the run only beside
 *    its own key. Both land or neither does: a later pass reads the key and finds nothing due, and a pass that raced it to
 *    the write finds the key taken (`RunKeyTakenError`) and starts nothing.
 *  - THE COST: the run's own ceiling (scope `next_n`: a set's, the athlete's lower limit if they set one) and the weekly
 *    cap — a run the week can't pay for never starts (`WeekBudgetError`): its key is written with `outcome: "week_budget"`
 *    and nothing retries. A run that ends without a proposal is read as such from the run itself (R52: never stored twice).
 *    Either way the plan's question comes back, saying plainly what happened (@rg/domain `planPrompt`'s `note`).
 *  - A RESTORE in progress starts nothing (checked first, and again in the key's own statement).
 *
 * STARTING IS ONE STEP: the create (its preferences, the week's check, the batch) and one word to the run's object
 * (`tellStepper` "arm", with a set's lease). The alarm does the rest, under the run's ceiling and the weekly cap; the hourly
 * pass never calls the model. A word that fails leaves the run live: the athlete's client arms it when the app opens, and
 * its window closes it otherwise.
 *
 * WHAT A PASS SPENDS: one statement for the whole pass (the accounts with a running coach plan, with their preferences);
 * an account, two when nothing is due (the restore marker, the plans with their drafts), and when one is: its blocks (for
 * which plans a later one followed), then the create — its preferences, the week's check, the batch's two — and, when it
 * starts nothing, the live run's read, or the week's key. Pinned in plan-drafts.test.ts.
 *
 * The request's words are the app's (`draftRequest`), naming the plan: read and shown as the app's, never as the athlete's
 * (coach-runs.ts `origin: "plan_draft"`), and the run knows the plan it is for (`planId`: plan_set's briefs and
 * propose_plan's new block default to it). It is a conversation of its own, and it can't ask the athlete anything: nobody
 * is there to answer (ask_athlete refuses it).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { coachPlans, programs, userPreferences, auditEvents } from "@rg/database";
import { linesOf, todayInZone, userPreferencesSchema } from "@rg/domain";
import { coachDesignerEnabled, type Env } from "../env.js";
import { restoreInProgress } from "./account-state.js";
import { isLoosePlan, lineBlockOf } from "./coach-plans.js";
import { createRun, RunKeyTakenError, WeekBudgetError } from "./coach-runs.js";
import { stepAlarmOn, stepperLeaseMs, tellStepper } from "./coach-run-stepper.js";
import type { Db } from "./db.js";
import { PLAN_DRAFT_KIND, planDraftKey, plansAsRead, readPlanEndings, type PlanEnding } from "./plan-ending.js";
import { draftOf, planOnEndOf, promptOfPlan } from "./plan-summaries.js";
import type { RunScope } from "./design-tools/types.js";

/** The switch (R51): `PLAN_DRAFTS = "1"`, the step alarm on, and the coach designer. A missing env is off. */
export const planDraftsOn = (env: Env | undefined): boolean => !!env && env.PLAN_DRAFTS === "1" && stepAlarmOn(env) && coachDesignerEnabled(env);

/** The request a draft sends, the app's words naming the plan (the brief's, verbatim). */
export const draftRequest = (planName: string): string => `Draft the next stretch of the plan ${planName}, from its purpose and brief. Nothing changes until I approve it.`;

/** A draft's scope: the next workouts, as many as the athlete's setting (Settings → Coach). */
export const DRAFT_SCOPE: RunScope = { kind: "next_n" };

/** The plan a draft is due for, of the account's plans as read with their drafts: see the header's WHICH PLAN. */
export function planDueForDraft(plans: readonly PlanEnding[], superseded: ReadonlySet<string>, today: string): PlanEnding | undefined {
  const due = plans.filter((p) => {
    if (!draftable(p)) return false;
    // Its ending as the chip has always read it: drafts off, so the draft's own state can't hide it.
    if (promptOfPlan({ ...p, drafts: undefined }, today, superseded)?.kind !== "whats_next") return false;
    const { hasDraft, draft } = draftOf(p, "continue");
    return !hasDraft && draft?.kind === "due";
  });
  return due.sort((a, b) => a.lastDay!.localeCompare(b.lastDay!) || a.id.localeCompare(b.id))[0];
}

/** A plan a draft can be for: a running coach plan that continues, with a last day, read with its drafts. */
const draftable = (p: PlanEnding): boolean => p.kind === "coach" && p.status === "active" && p.lastDay !== null && p.drafts !== undefined && planOnEndOf(p) === "continue";

/** The hourly pass (see the header): drafts started, one an account at most. Off, nothing. */
export async function draftEndingPlans(db: Db, env: Env, at: Date = new Date()): Promise<{ started: number }> {
  const out = { started: 0 };
  if (!planDraftsOn(env)) return out;
  // The accounts with a running coach plan, with their preferences: one statement for the pass.
  const accounts = await db
    .selectDistinct({ userId: programs.userId, prefs: userPreferences.prefs })
    .from(programs)
    .leftJoin(userPreferences, eq(userPreferences.userId, programs.userId))
    .where(and(eq(programs.kind, "coach"), eq(programs.status, "active"), isNull(programs.archivedAt)));
  for (const a of accounts) {
    try {
      if (await draftForAccount(db, env, a.userId, a.prefs, at)) out.started += 1;
    } catch (e) {
      console.error(`plan draft failed: ${e instanceof Error ? e.name : "unknown"}`);
    }
  }
  return out;
}

/** One account's draft, when one is due: started or not. */
async function draftForAccount(db: Db, env: Env, userId: string, storedPrefs: unknown, at: Date): Promise<boolean> {
  if (await restoreInProgress(db, userId)) return false;
  const prefs = userPreferencesSchema.safeParse(storedPrefs ?? {});
  const today = todayInZone(prefs.success ? prefs.data.timezone : "UTC", at);
  const plans = await readPlanEndings(db, userId, today, { drafts: true });
  // Nothing due before a later plan of its sport is weighed (which only takes plans away): no statement more.
  if (!planDueForDraft(plans, new Set(), today)) return false;
  const blocks = await db
    .select({
      id: coachPlans.id,
      name: coachPlans.name,
      discipline: coachPlans.discipline,
      status: coachPlans.status,
      startDate: coachPlans.startDate,
      endDate: coachPlans.endDate,
      raceDate: coachPlans.raceDate,
      programId: coachPlans.programId,
    })
    .from(coachPlans)
    .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active")));
  const lines = linesOf(blocks.filter((b) => !isLoosePlan(b)).map(lineBlockOf), today);
  const { superseded } = plansAsRead(plans, lines, today);
  const plan = planDueForDraft(plans, superseded, today);
  if (!plan) return false;
  const key = planDraftKey(plan.id, plan.lastDay!);
  const detail = { planId: plan.id, lastSessionDate: plan.lastDay! };
  let runId: string;
  try {
    const created = await createRun(
      db,
      userId,
      {
        scope: DRAFT_SCOPE,
        request: draftRequest(plan.name),
        conversationId: null,
        origin: "plan_draft",
        planId: plan.id,
        once: {
          key,
          kind: PLAN_DRAFT_KIND,
          detail,
          // The plan is still the one read: running, and not paused (checked again in the key's own statement).
          gate: sql`EXISTS (SELECT 1 FROM programs WHERE id = ${plan.id} AND user_id = ${userId} AND status = 'active' AND archived_at IS NULL
            AND (paused_until IS NULL OR paused_until < ${today}))`,
        },
      },
      at,
    );
    // The athlete's own run is live: nothing started, and the ending waits for the next pass.
    if (created.existing) return false;
    runId = created.run.id;
  } catch (e) {
    if (e instanceof RunKeyTakenError) return false;
    if (e instanceof WeekBudgetError) {
      // At the cap nothing retries: the key says why, and the plan's question comes back saying so.
      await db
        .insert(auditEvents)
        .values({ id: key, userId, kind: PLAN_DRAFT_KIND, detail: { ...detail, outcome: "week_budget" }, createdAt: at.toISOString() })
        .onConflictDoNothing();
      return false;
    }
    throw e;
  }
  // Starting is one step: the alarm does the rest, for a set's lease (nobody is watching).
  try {
    await tellStepper(env, runId, userId, "arm", { stepping: false, leaseMs: stepperLeaseMs(DRAFT_SCOPE) });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "plan-drafts: the draft's stepper was not armed", run: runId, error: e instanceof Error ? e.message : "unknown" }));
  }
  return true;
}
