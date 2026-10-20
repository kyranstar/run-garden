import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { auditEvents, coachPlans, plannedWorkouts, studioPlanPushes, studioPlans, trainingPlans } from "@rg/database";
import { looksLikeCodeTitle, todayInZone, type LineBlock, type LocalDate, type TrainingLine, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { STUDIO_PLAN_RETIRED, studioPlanEnd } from "./studio-push.js";

/**
 * Block adherence (fairness spec §4): completed ÷ (completed + skipped +
 * missed) over the plan's non-rest workouts — with coach-sanctioned skips
 * EXCLUDED from the denominator, so mercy never tanks the block.
 * Deterministic from resolution rows; replay-stable.
 */
export const COACHED_BLOCK_ADHERENCE = 0.85;

/**
 * `ensureAdhocPlan` mints one bucket per discipline with this id prefix, to
 * hold coach sessions that land outside any block. The prefix is the writer's
 * own tag, so it identifies the two rows already in production without a
 * migration or any data repair.
 */
export const LOOSE_PLAN_ID_PREFIX = "adhoc-";

/**
 * A container for loose sessions is NOT a training block.
 *
 * A block has a planned duration: a start, an end someone chose, and
 * `coach_plan_weeks` rows describing each week of it. Everything the app says
 * about a block — "week 3 of 4", a progress bar, "your plan is ending", "block
 * complete — 92% adherence", the garden's coached-block credit — is a statement
 * about that duration. A bucket has none of it; it has CONTENTS. Its dates are
 * wherever its sessions happen to fall, so a bucket holding one session was
 * rendering as a one-week plan at 100% progress in week 1 of 1, was winning the
 * weekly brief's week counter from the real four-week block underneath it, and
 * was earning a "block complete" receipt (plus the garden's Keystone credit)
 * the morning after a single one-off.
 *
 * So every surface that speaks in durations asks this question first.
 */
export function isLoosePlan(plan: { id: string }): boolean {
  return plan.id.startsWith(LOOSE_PLAN_ID_PREFIX);
}

/**
 * A completion the garden does not see is not done (Audit 2d I-2; rulings 2d-R1, 2d-R3): `unseen` is the garden's own
 * reader of which completed rows those are (garden-sync's `unseenCompletions` — passed in, so this module never
 * imports the garden and no caller can count without it). Such a row stays in the denominator, as a miss would.
 */
export async function coachBlockAdherence(
  db: Db,
  userId: string,
  planId: string,
  startDate: string,
  endDate: string,
  unseen: (db: Db, workoutIds: string[]) => Promise<Set<string>>,
): Promise<number | null> {
  const rows = await db
    .select({
      id: plannedWorkouts.id,
      state: plannedWorkouts.completionState,
      category: plannedWorkouts.category,
      sanctionedBy: plannedWorkouts.sanctionedBy,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, planId),
        gte(plannedWorkouts.effectiveDate, startDate),
        lte(plannedWorkouts.effectiveDate, endDate),
      ),
    );
  const resolved = rows.filter(
    (r) => r.category !== "rest" && ["completed", "skipped", "missed"].includes(r.state),
  );
  const denom = resolved.filter((r) => r.state === "completed" || r.sanctionedBy !== "coach");
  if (denom.length === 0) return null;
  const completed = denom.filter((r) => r.state === "completed");
  const notSeen = await unseen(db, completed.map((r) => r.id));
  const done = completed.filter((r) => !notSeen.has(r.id)).length;
  return done / denom.length;
}

/** Coached BLOCKS whose final day was exactly `endDate` (any live status —
 * deterministic regardless of when the status-flip cron ran). Loose-session
 * buckets are excluded: a bucket's last date is where its last one-off
 * happened, not a finish line, and the garden's coached-block credit is for
 * finishing a block. */
export async function plansEndedOn(
  db: Db,
  userId: string,
  endDate: string,
): Promise<Array<{ id: string; name: string; startDate: string; endDate: string }>> {
  const rows = await db
    .select({
      id: coachPlans.id,
      name: coachPlans.name,
      startDate: coachPlans.startDate,
      endDate: coachPlans.endDate,
    })
    .from(coachPlans)
    .where(
      and(
        eq(coachPlans.userId, userId),
        eq(coachPlans.endDate, endDate),
        inArray(coachPlans.status, ["active", "completed"]),
      ),
    );
  return rows.filter((p) => !isLoosePlan(p));
}


/**
 * A coach plan row as a training line's block (the one mapping every reader of lines uses). The block's OWN race (the
 * row's), never Settings'.
 */
export function lineBlockOf(r: {
  id: string;
  discipline: string;
  status: string;
  name: string;
  startDate: string;
  endDate: string;
  raceDate: string | null;
}): LineBlock {
  return {
    id: r.id,
    discipline: r.discipline as LineBlock["discipline"],
    status: r.status as LineBlock["status"],
    name: r.name,
    startDate: r.startDate,
    endDate: r.endDate,
    planRaceDate: r.raceDate,
  };
}

/** A training line's last phase: the one its end is (of phases ending that day, the later-starting) — the phase its
 * Extend and Wind down act on (training lines §3.3), and what "Plan what comes after" follows. */
export function lastPhaseOf(line: TrainingLine): LineBlock {
  return line.phases.filter((p) => p.endDate === line.endDate).at(-1)!;
}

/** Whether the newest Studio plan is listed, by its pushes' statuses: something of it is (or was) on the watch. A plan
 * the athlete retired is not listed either (`STUDIO_PLAN_RETIRED`, read with it). */
export function studioPlanOnWatch(pushStatuses: readonly string[]): boolean {
  return pushStatuses.some((s) => s !== "deleted");
}

/**
 * The newest Studio plan as the plan list shows it — its name, its real span and its status — from its row and its
 * pushes' statuses: the one mapping the plan list (`loadNonCoachPlanEntries`) and the coach's `read_plans` both use.
 */
export function studioPlanEntryOf(
  studio: { id: string; plan: unknown; brief: unknown; createdAt: string },
  pushStatuses: readonly string[],
  today: string,
  raceDate: string | null,
) {
  // Real span from the brief the plan was generated with — createdAt-based
  // dates rendered "wk 1/1 · ends <creation day>" for a 16-week plan that
  // hadn't even started (2026-08-12 audit finding 6).
  const brief = studio.brief as { startDate?: string } | null;
  const start = brief?.startDate ?? studio.createdAt.slice(0, 10);
  const end = studioPlanEnd(studio);
  // "Written to COROS" only when a push has actually materialized there —
  // generate and push are separate actions.
  const status: "active" | "draft" | "completed" =
    end < today ? "completed" : pushStatuses.includes("verified") ? "active" : "draft";
  return {
    id: studio.id,
    discipline: "lift" as const,
    name: ((studio.plan as { name?: string } | null)?.name ?? "Lifting plan"),
    status,
    startDate: start,
    endDate: end,
    raceDate,
    source: "studio" as const,
  };
}

/**
 * The plans that are no coach rows — the Studio's newest lifting plan and the imported COROS running plan — as the
 * plan list shows them (`GET /api/coach/plans`) and the week brief names weeks from them (`GET /api/plan/week`): ONE
 * reader, so the two sides' candidate sets are the same, with the same real dates.
 *
 * Two round trips deep, three statements at most: the Studio's one statement and the COROS plans' read go together,
 * then the COROS plans' sessions (pinned in coach-routes.test.ts).
 */
export async function loadNonCoachPlanEntries(db: Db, userId: string, prefs: Pick<UserPreferences, "raceDate" | "timezone">) {
  const today = todayInZone(prefs.timezone);
  const [studioEntries, corosEntries] = await Promise.all([
    studioEntriesOf(db, userId, prefs.raceDate, today),
    corosEntriesOf(db, userId, prefs.raceDate, today),
  ]);
  return { studioEntries, corosEntries };
}

/**
 * Studio-authored lifting plans are real plans this app created and wrote to COROS — "Manage plans" claiming "no plans"
 * while one is live on the watch reads as a lie. They carry source:"studio" so the UI renders them with Studio
 * affordances instead of coach ones.
 *
 * Newest studio plan only: generate keeps full history and each replace retires the previous plan's COROS sessions —
 * listing superseded rows as live would be the same lie pointed the other way. And only while something of it is (or
 * was) on the watch: the generator's screens are retired (Stage 2), so a draft it never pushed is nothing the athlete
 * can act on, and listing it hid the lifting intake card. One that was retired leaves the list; one past its last day
 * reads as completed.
 *
 * One statement: the newest plan, its pushes' statuses (one row each: a plan's sessions, not more) and whether the
 * athlete retired it (as `studioPlanRetired` reads it).
 */
async function studioEntriesOf(db: Db, userId: string, raceDate: string | null, today: LocalDate) {
  const [studio] = await db
    .select({
      id: studioPlans.id,
      plan: studioPlans.plan,
      brief: studioPlans.brief,
      createdAt: studioPlans.createdAt,
      // Spelled with aliases: in a select's fields drizzle names a column without its table, which a subquery would
      // read as its own table's.
      pushes: sql<string>`(select json_group_array(p.status) from ${studioPlanPushes} p where p.plan_id = ${studioPlans}.id)`,
      retired: sql<number>`exists (select 1 from ${auditEvents} a where a.user_id = ${userId} and a.kind = ${STUDIO_PLAN_RETIRED}
        and json_extract(a.detail, '$.studioPlanId') = ${studioPlans}.id)`,
    })
    .from(studioPlans)
    .where(eq(studioPlans.userId, userId))
    .orderBy(desc(studioPlans.createdAt), desc(studioPlans.id))
    .limit(1);
  if (!studio) return [];
  const pushStatuses = (JSON.parse(studio.pushes ?? "[]") as unknown[]).filter((s): s is string => typeof s === "string");
  if (!studioPlanOnWatch(pushStatuses) || Number(studio.retired) === 1) return [];
  return [studioPlanEntryOf(studio, pushStatuses, today, raceDate)];
}

/**
 * The imported COROS plan IS the user's running plan — a page that shows its 35 workouts while the run slot claims "no
 * plan" denies reality (audit finding 6). Read-only card: the app doesn't author these. Two statements: the plans,
 * then their sessions.
 */
async function corosEntriesOf(db: Db, userId: string, raceDate: string | null, today: LocalDate) {
  const corosPlans = await db
    .select()
    .from(trainingPlans)
    .where(
      and(
        eq(trainingPlans.userId, userId),
        eq(trainingPlans.status, "active"),
        eq(trainingPlans.provider, "coros"),
      ),
    );
  const corosEntries = [];
  if (corosPlans.length > 0) {
    const owned = await db
      .select({
        planId: plannedWorkouts.planId,
        sport: plannedWorkouts.sport,
        date: plannedWorkouts.effectiveDate,
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          isNull(plannedWorkouts.archivedAt),
          inArray(
            plannedWorkouts.planId,
            corosPlans.map((p) => p.id),
          ),
        ),
      );
    for (const p of corosPlans) {
      const mine = owned.filter((w) => w.planId === p.id);
      const runs = mine.filter((w) => w.sport === "run");
      // A RUN card only for the plan that is actually the running plan:
      // majority-run and still holding future run work. (The strength
      // container the studio pushes into also lives in training_plans and
      // owns a couple of stray runs — it must not masquerade as one.)
      const futureRun = runs.some((w) => w.date >= today);
      if (!futureRun || runs.length * 2 < mine.length) continue;
      const dates = mine.map((w) => w.date).sort();
      // COROS containers often carry NULL spans and code names — derive the
      // span from the workouts themselves and never render a bare code.
      const name = !p.name || p.name === "COROS plan" || looksLikeCodeTitle(p.name)
        ? "COROS running plan"
        : p.name;
      corosEntries.push({
        id: p.id,
        discipline: "run" as const,
        name,
        status: "active" as const,
        startDate: p.startDate ?? dates[0]!,
        endDate: p.endDate ?? dates[dates.length - 1]!,
        raceDate,
        source: "coros" as const,
      });
    }
  }
  return corosEntries;
}
