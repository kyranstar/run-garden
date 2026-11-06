import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { coachPlans, programs, studioPlanPushes, trainingPlans } from "@rg/database";
import { defaultOnEnd, linesOf, nowInstant, type LineBlock } from "@rg/domain";
import { restoreInProgress } from "./account-state.js";
import { isLoosePlan, lineBlockOf, loadNonCoachPlanEntries } from "./coach-plans.js";
import type { Db } from "./db.js";

/**
 * THE REGISTRY'S BACKFILL (plans with a purpose, Stage 1): every plan the app already has gets a row in `programs`,
 * so a plan has an id of its own, a purpose to fill in later and an ending. Nothing is moved or rewritten; a row is
 * only ever added, and a block or session is only ever pointed at it.
 *
 *  - A training line (`linesOf`: a sport's blocks chained by date) is one `coach` plan, `plan-<its first block's id>`;
 *    its blocks' `program_id` says so. A block added to a line later joins the line's row.
 *  - The Studio's current plan is a `coach` plan whose id is its sessions' COROS container's `training_plans.id`
 *    (found through its pushes), so the sessions it already has belong to it. With no container yet, nothing is made.
 *  - Each listed COROS running plan is a `coros_import` plan under its own `training_plans.id`.
 *  - An adaptive programme that has no ending yet gets `continue`.
 *
 * Idempotent, and cheap on the hourly pass (the free plan allows about 45 statements): reads first, then writes in
 * order of cost until the budget is spent, the lines last. What doesn't fit waits for the next hour. A restore
 * replacing the account stops it at once, and nothing is written.
 */

/** The statements one call may spend, reads included (Workers Free: about 45 a request). */
const STATEMENT_BUDGET = 45;
/** Block ids per link statement: D1 binds 100 parameters, and the statement binds the program id too. */
const LINK_CHUNK = 90;
/** The reads that always happen: restore check, plans, registry, and the Studio's and COROS's entries (three at most). */
const FIXED_READS = 6;

/** `programs.disciplines` speaks "run", "strength" and "yoga"; a coach plan's discipline is "run", "lift" or "mobility". */
const DISCIPLINE_WORD = { run: "run", lift: "strength", mobility: "yoga" } as const;

/** A line's plan id: its first block's id, which never changes while the line holds that block. */
function planIdForLine(blockIds: readonly string[]): string {
  return `plan-${blockIds[0]!}`;
}

const chunks = <T>(xs: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

export async function backfillPlanRegistry(db: Db, userId: string, today: string, timezone = "UTC"): Promise<{ created: number; linked: number }> {
  const done = { created: 0, linked: 0 };
  if (await restoreInProgress(db, userId)) return done;

  const [coachRows, existing, nonCoach] = await Promise.all([
    db.select().from(coachPlans).where(eq(coachPlans.userId, userId)),
    db
      .select({ id: programs.id, kind: programs.kind, onEnd: programs.onEnd, source: programs.source })
      .from(programs)
      .where(eq(programs.userId, userId)),
    // In the account's own zone, as the plan list reads them.
    loadNonCoachPlanEntries(db, userId, { raceDate: null, timezone }),
  ]);
  let left = STATEMENT_BUDGET - FIXED_READS;
  const now = nowInstant();
  const known = new Set(existing.map((p) => p.id));
  const base = { userId, config: {}, createdAt: now, updatedAt: now, archivedAt: null } as const;

  // Cheapest first: one statement each.
  if (left >= 1 && existing.some((p) => p.kind === "adaptive" && p.onEnd === null)) {
    await db.update(programs).set({ onEnd: "continue" }).where(and(eq(programs.userId, userId), eq(programs.kind, "adaptive"), isNull(programs.onEnd)));
    left -= 1;
  }

  for (const e of nonCoach.corosEntries) {
    if (known.has(e.id) || left < 1) continue;
    await db
      .insert(programs)
      .values({
        ...base,
        id: e.id,
        kind: "coros_import",
        name: e.name,
        status: "active",
        disciplines: ["run"],
        startDate: e.startDate,
        endDate: e.endDate,
        raceDate: e.raceDate,
        source: null,
        onEnd: defaultOnEnd("coros_import", ["run"]),
      })
      .onConflictDoNothing();
    known.add(e.id);
    left -= 1;
    done.created += 1;
  }

  const studio = nonCoach.studioEntries[0];
  const studioHeld = studio && existing.some((p) => (p.source as { studioPlanId?: unknown } | null)?.studioPlanId === studio.id);
  if (studio && !studioHeld && left >= 2) {
    // Its sessions' container: the COROS plan its pushes landed in.
    const [container] = await db
      .select({ id: trainingPlans.id })
      .from(studioPlanPushes)
      .innerJoin(trainingPlans, and(eq(trainingPlans.sourcePlanId, studioPlanPushes.corosPlanId), eq(trainingPlans.userId, userId)))
      .where(eq(studioPlanPushes.planId, studio.id))
      .orderBy(desc(studioPlanPushes.updatedAt))
      .limit(1);
    left -= 1;
    if (!container) {
      console.warn("plan-registry: studio-container-unresolved");
    } else if (!known.has(container.id)) {
      await db
        .insert(programs)
        .values({
          ...base,
          id: container.id,
          kind: "coach",
          name: studio.name,
          status: "active", // ended is computed from the dates, never stored
          disciplines: ["strength"],
          startDate: studio.startDate,
          endDate: studio.endDate,
          raceDate: null,
          source: { studioPlanId: studio.id },
          // Kind "coach" without running continues, as `defaultOnEnd` says.
          onEnd: defaultOnEnd("coach", ["strength"]),
        })
        .onConflictDoNothing();
      known.add(container.id);
      left -= 1;
      done.created += 1;
    }
  }

  const programOf = new Map(coachRows.map((r) => [r.id, r.programId] as const));
  // The backfill finds the link, so it groups by dates alone: a block already linked is passed as none, or a block added
  // beside it could never join its line.
  const lines = linesOf(coachRows.filter((r) => !isLoosePlan(r)).map((r) => ({ ...lineBlockOf(r), programId: null })), today);
  for (const line of lines) {
    const ids = line.phases.map((p: LineBlock) => p.id);
    const unlinked = ids.filter((id) => !programOf.get(id));
    if (unlinked.length === 0) continue;
    // A block added to a line that already has its plan joins that plan.
    const target = ids.map((id) => programOf.get(id)).find((p): p is string => !!p) ?? planIdForLine(ids);
    const make = !known.has(target);
    const links = chunks(unlinked, LINK_CHUNK);
    if (left < (make ? 1 : 0) + links.length) break;
    if (make) {
      const disciplines = [DISCIPLINE_WORD[line.discipline]];
      await db
        .insert(programs)
        .values({
          ...base,
          id: target,
          kind: "coach",
          // As the plan list names it: a one-phase line by its block, a longer one by its sport.
          name: line.phases.length === 1 ? line.phases[0]!.name : line.name,
          status: "active",
          disciplines,
          startDate: line.startDate,
          endDate: line.endDate,
          raceDate: line.goalRaceDate,
          source: null,
          onEnd: defaultOnEnd("coach", disciplines),
        })
        .onConflictDoNothing();
      known.add(target);
      left -= 1;
      done.created += 1;
    }
    for (const chunk of links) {
      await db.update(coachPlans).set({ programId: target }).where(and(inArray(coachPlans.id, chunk), isNull(coachPlans.programId)));
      left -= 1;
      done.linked += chunk.length;
    }
  }
  return done;
}
