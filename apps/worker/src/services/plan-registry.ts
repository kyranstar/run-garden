import { and, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { coachPlans, programs, programVersions, studioPlanPushes, trainingPlans } from "@rg/database";
import { courseConfigSchema, defaultOnEnd, linesOf, newId, nowInstant, onEndAllowed, type LineBlock, type ProgramKind } from "@rg/domain";
import { sha256Hex } from "../auth/crypto.js";
import { restoreInProgress } from "./account-state.js";
import { isLoosePlan, lineBlockOf, loadNonCoachPlanEntries } from "./coach-plans.js";
import { runAtomically, type Db } from "./db.js";
import { planStoppedIfNoBlockLeft } from "./plan-status.js";
import { studioPlanRetired } from "./studio-push.js";
import { DISCIPLINE_WORD, isPlanKind, lineKeysByPlan, planPatchSchema, planSummaryOf, PLAN_KINDS, type PlanPatch, type PlanSummaryDto } from "./plan-summaries.js";

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
 * A plan's dates are computed from its sessions, never stored: a row leaves `start_date`, `end_date` and `race_date` null.
 *
 * Idempotent, and cheap on the hourly pass (the free plan allows about 45 statements): reads first, then writes in
 * order of cost until the budget is spent, the lines last. What doesn't fit waits for the next hour. A restore
 * replacing the account stops it at once, and nothing is written.
 *
 * It also corrects a coach plan whose row says running though it was stopped (rulings R31, R38; since then every stop writes the
 * row itself, `plan-status.ts`). The evidence has to be real: its last-ending block retired and none left to run, or the Studio's
 * own retired mark. A line that ran to its end isn't stopped, though a phase of it was retired early: ended is computed, not
 * stored, and marked stopped it could never be continued.
 *
 * THE READ AND THE EDIT: `listPlans` answers the plans in two reads (the plans, the blocks), and `applyPlanPatch` is
 * the one write of a plan's purpose, brief, ending, pause, objectives and a course's easing. The route calls it, and
 * the coach's approval will. It checks the edit and writes the row with one `program_versions` row in one batch: both
 * land or neither does. The version's fingerprint is the editable fields after the edit.
 */

/** The statements one call may spend, reads included (Workers Free: about 45 a request). */
const STATEMENT_BUDGET = 45;
/** Block ids per link statement: D1 binds 100 parameters, and the statement binds the program id too. */
const LINK_CHUNK = 90;
/** The reads that always happen: restore check, plans, registry, and the Studio's and COROS's entries (three at most). */
const FIXED_READS = 6;

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
      .select({ id: programs.id, kind: programs.kind, status: programs.status, onEnd: programs.onEnd, source: programs.source })
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

  for (const p of existing) {
    if (p.kind !== "coach" || p.status !== "active" || left < 1) continue;
    const blocks = coachRows.filter((b) => b.programId === p.id);
    const lastEnd = blocks.reduce((latest, b) => (b.endDate > latest ? b.endDate : latest), "");
    const endedStopped = blocks.length > 0 && blocks.filter((b) => b.endDate === lastEnd).every((b) => b.status === "retired");
    if (!endedStopped || blocks.some((b) => b.status !== "retired" && b.endDate >= today)) continue;
    await planStoppedIfNoBlockLeft(db, { userId, today, now }, { plan: p.id });
    left -= 1;
  }
  // The Studio's plan on the list isn't retired, so only another one's row needs its mark read.
  for (const p of existing) {
    const held = (p.source as { studioPlanId?: unknown } | null)?.studioPlanId;
    if (p.kind !== "coach" || p.status !== "active" || typeof held !== "string" || held === nonCoach.studioEntries[0]?.id || left < 2) continue;
    left -= 1;
    if (!(await studioPlanRetired(db, userId, held))) continue;
    await planStoppedIfNoBlockLeft(db, { userId, today, now }, { studioPlan: held });
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
        startDate: null,
        endDate: null,
        raceDate: null,
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
          startDate: null,
          endDate: null,
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
          startDate: null,
          endDate: null,
          raceDate: null,
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

/**
 * The plans the account has, shaped for the list: two reads (the plans, the blocks), no more. A course's sessions done come
 * with its row, counted as `courseSessionsDone` counts them.
 */
export async function listPlans(db: Db, userId: string, today: string): Promise<PlanSummaryDto[]> {
  const [rows, blocks] = await Promise.all([
    db
      .select({
        ...getTableColumns(programs),
        // Raw names: Drizzle strips a column's table inside a single table's select, and `"id"` would be the subquery's own.
        courseDone: sql<number | null>`case when programs.kind = 'course' then (select count(*) from planned_workouts d where d.user_id = programs.user_id and d.plan_id = programs.id and d.course_session is not null and d.completion_state = 'completed') end`,
      })
      .from(programs)
      .where(and(eq(programs.userId, userId), inArray(programs.kind, [...PLAN_KINDS]), isNull(programs.archivedAt))),
    db.select().from(coachPlans).where(eq(coachPlans.userId, userId)),
  ]);
  const lines = linesOf(blocks.filter((r) => !isLoosePlan(r)).map(lineBlockOf), today);
  const keys = lineKeysByPlan(lines);
  return rows.map((r) => planSummaryOf(r, keys));
}

export type PlanPatchResult =
  | { ok: true; changed: string[] }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "restore_in_progress" }
  | { ok: false; error: "invalid"; issues: Array<{ path: Array<string | number>; message: string }> };

/**
 * Edit a plan. `today` is the account's day (a pause may not end before it); it defaults to `now`'s UTC day. Answers
 * what changed; an edit that changes nothing writes nothing and records no version.
 */
export async function applyPlanPatch(db: Db, userId: string, id: string, patch: unknown, now: string, today = now.slice(0, 10)): Promise<PlanPatchResult> {
  const invalid = (path: string, message: string): PlanPatchResult => ({ ok: false, error: "invalid", issues: [{ path: [path], message }] });
  const parsed = planPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path as Array<string | number>, message: i.message })) };
  }
  const p: PlanPatch = parsed.data;

  if (await restoreInProgress(db, userId)) return { ok: false, error: "restore_in_progress" };
  const [row] = await db.select().from(programs).where(and(eq(programs.id, id), eq(programs.userId, userId))).limit(1);
  // An archived row is no plan: the list leaves it out, so an edit of it would answer with nothing to show.
  if (!row || row.archivedAt !== null || !isPlanKind(row.kind)) return { ok: false, error: "not_found" };
  const kind = row.kind as ProgramKind;

  if (p.onEnd !== undefined && !onEndAllowed(kind, p.onEnd)) return invalid("onEnd", `a ${kind} plan cannot end by "${p.onEnd}"`);
  if (typeof p.pausedUntil === "string" && p.pausedUntil < today) return invalid("pausedUntil", "a pause cannot end before today");

  let config = row.config;
  if (p.easeNext !== undefined) {
    if (kind !== "course") return invalid("easeNext", "only a course can ease its next session");
    const merged = courseConfigSchema.safeParse({ ...row.config, easeNext: p.easeNext });
    if (!merged.success) return invalid("easeNext", "the course's settings are not complete");
    config = merged.data;
  }

  const next = {
    purpose: p.purpose === undefined ? row.purpose : p.purpose,
    brief: p.brief === undefined ? row.brief : p.brief,
    onEnd: p.onEnd ?? row.onEnd,
    pausedUntil: p.pausedUntil === undefined ? row.pausedUntil : p.pausedUntil,
    objectiveIds: p.objectiveIds ?? row.objectiveIds,
    config,
  };
  const changed: string[] = [];
  for (const k of ["purpose", "brief", "onEnd", "pausedUntil", "objectiveIds"] as const) {
    if (JSON.stringify(next[k]) !== JSON.stringify(row[k])) changed.push(k);
  }
  if (JSON.stringify(next.config) !== JSON.stringify(row.config)) changed.push("easeNext");
  if (changed.length === 0) return { ok: true, changed };

  await runAtomically(db, [
    db
      .update(programs)
      .set({ ...next, updatedAt: now })
      .where(and(eq(programs.id, id), eq(programs.userId, userId))),
    (await planVersionInsert(db, id, next, changed, now)).insert,
  ]);
  return { ok: true, changed };
}

/**
 * The `program_versions` row of a change to a plan, for the change's own batch: the next number (one read), a fingerprint of
 * the editable fields as they'll stand (purpose, brief, ending, pause, objectives, settings), and what changed. Wrapped, since a
 * statement resolved from an async function would run there and then.
 */
export async function planVersionInsert(db: Db, id: string, fields: Record<string, unknown>, changed: readonly string[], now: string) {
  const [last] = await db
    .select({ n: programVersions.versionNum })
    .from(programVersions)
    .where(eq(programVersions.programId, id))
    .orderBy(desc(programVersions.versionNum))
    .limit(1);
  const fingerprint = await sha256Hex(JSON.stringify(fields));
  return { insert: db.insert(programVersions).values({ id: newId(), programId: id, versionNum: (last?.n ?? 0) + 1, capturedAt: now, fingerprint, summary: { changed: [...changed] } }) };
}
