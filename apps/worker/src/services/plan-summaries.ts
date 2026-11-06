import { z } from "zod";
import { courseConfigSchema, defaultOnEnd, isLocalDate, planOnEndSchema, planPrompt, PLAN_BRIEF_MAX, PLAN_OBJECTIVES_MAX, PLAN_PURPOSE_MAX, type PlanOnEnd, type ProgramKind, type TrainingLine } from "@rg/domain";
import { courseDefinition } from "@rg/workout";

/**
 * A PLAN, AS THE APP LISTS IT (plans with a purpose, Stage 1): pure shaping, no reads. The plans are the `programs`
 * rows of kind adaptive, course, coach and coros_import. The `studio` kind is the one-off bucket and never appears,
 * and a row of `coach_plans` is a phase of a plan, never a plan.
 *
 *  - `lineKey`: the key of the training line whose blocks point at this plan, so a list row finds its plan.
 *  - `listedAs`: the id the existing list row carries: a Studio plan's own id for the coach plan that holds it; a
 *    programme or a course, its own id; null for any other plan.
 *  - `course`: where a course has got to, all from its definition and the sessions done (read with the row: `courseDone`): its
 *    `sessionLabel` while it counts them, then its own words for what comes after (`afterLabel`), so no screen has to know a
 *    course's numbers or words; null for any other kind, and with a definition gone or settings that don't read.
 *  - `prompt`: what the one rule (`planPrompt`, @rg/domain) says of the plan today, the same the chip reads: the tappable line the row shows,
 *    or null. Its last session comes with the row (`lastSessionDate`, computed in the same read: `planLastDaySql`), never stored.
 */

/** The kinds that are plans. */
export const PLAN_KINDS = ["adaptive", "course", "coach", "coros_import"] as const satisfies readonly ProgramKind[];

export const PURPOSE_MAX = PLAN_PURPOSE_MAX;
export const BRIEF_MAX = PLAN_BRIEF_MAX;
/** Objectives a plan may serve. */
export const OBJECTIVES_MAX = PLAN_OBJECTIVES_MAX;

/** `programs.disciplines` speaks "run", "strength" and "yoga"; a coach plan's discipline is "run", "lift" or "mobility". */
export const DISCIPLINE_WORD = { run: "run", lift: "strength", mobility: "yoga" } as const;

/**
 * What an edit may carry. Only the keys sent change; `null` clears a text or a pause. An unknown key is refused, so a
 * misspelt field never passes as an empty edit.
 */
export const planPatchSchema = z
  .object({
    purpose: z.string().trim().min(1).max(PURPOSE_MAX).nullable().optional(),
    brief: z.string().trim().min(1).max(BRIEF_MAX).nullable().optional(),
    onEnd: planOnEndSchema.optional(),
    objectiveIds: z.array(z.string().min(1)).max(OBJECTIVES_MAX).optional(),
    pausedUntil: z
      .string()
      .refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" })
      .nullable()
      .optional(),
    /** A course's: whether its next session is eased. */
    easeNext: z.boolean().optional(),
  })
  .strict();
export type PlanPatch = z.infer<typeof planPatchSchema>;

export interface PlanSummaryDto {
  id: string;
  kind: ProgramKind;
  name: string;
  purpose: string | null;
  brief: string | null;
  onEnd: PlanOnEnd;
  pausedUntil: string | null;
  objectiveIds: string[];
  status: "active" | "retired";
  lineKey: string | null;
  listedAs: string | null;
  course: { session: number; of: number } | { after: string } | null;
  prompt: { kind: "whats_next" | "draft_ready"; label: string; request: string } | null;
}

/** The columns of a `programs` row a summary reads. */
export interface PlanRow {
  id: string;
  kind: string;
  name: string;
  status: string;
  disciplines: string[];
  source: Record<string, unknown> | null;
  purpose: string | null;
  brief: string | null;
  onEnd: string | null;
  pausedUntil: string | null;
  objectiveIds: string[] | null;
  config: unknown;
  /** A course's own sessions done (`courseSessionsDone`); null for any other kind. */
  courseDone: number | null;
  /** A coach or COROS plan's last day, worked out with the row (`planLastDaySql`); null for any other kind, or with none. */
  lastSessionDate: string | null;
}

/** A training line's sport for a plan whose `programs.disciplines` speak "run", "strength" and "yoga"; null when it has not one of them. */
const LINE_DISCIPLINE = { run: "run", strength: "lift", yoga: "mobility" } as const;
function lineDisciplineOf(disciplines: readonly string[]): "run" | "lift" | "mobility" | null {
  const own = disciplines.length === 1 ? LINE_DISCIPLINE[disciplines[0] as keyof typeof LINE_DISCIPLINE] : undefined;
  return own ?? null;
}

/** Where a course plan has got to. */
function courseLabel(row: Pick<PlanRow, "kind" | "config" | "courseDone">): PlanSummaryDto["course"] {
  if (row.kind !== "course") return null;
  const config = courseConfigSchema.safeParse(row.config);
  const definition = config.success ? courseDefinition(config.data.course) : null;
  if (!definition) return null;
  return definition.sessionLabel(row.courseDone ?? 0) ?? { after: definition.afterLabel };
}

export const isPlanKind = (kind: string): kind is (typeof PLAN_KINDS)[number] => (PLAN_KINDS as readonly string[]).includes(kind);

/** Which line each plan's blocks make: a plan id → its line's key. */
export function lineKeysByPlan(lines: readonly TrainingLine[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) if (l.programId && !out.has(l.programId)) out.set(l.programId, l.key);
  return out;
}

export function planSummaryOf(row: PlanRow, lineKeys: ReadonlyMap<string, string>, today: string): PlanSummaryDto {
  const kind = row.kind as ProgramKind;
  const studioPlanId = typeof row.source?.studioPlanId === "string" ? row.source.studioPlanId : null;
  const onEnd = planOnEndSchema.safeParse(row.onEnd);
  const ending: PlanOnEnd = onEnd.success ? onEnd.data : defaultOnEnd(kind, row.disciplines);
  const status = row.status === "retired" || row.status === "archived" ? "retired" : "active";
  return {
    id: row.id,
    kind,
    name: row.name,
    purpose: row.purpose,
    brief: row.brief,
    onEnd: ending,
    pausedUntil: row.pausedUntil,
    objectiveIds: row.objectiveIds ?? [],
    status,
    lineKey: lineKeys.get(row.id) ?? null,
    listedAs: kind === "coach" ? studioPlanId : kind === "adaptive" || kind === "course" ? row.id : null,
    course: courseLabel(row),
    // Until a plan can hold a draft for its ending (Piece 5), none is ready.
    prompt: planPrompt(
      { kind, onEnd: ending, status, pausedUntil: row.pausedUntil, name: row.name, discipline: lineDisciplineOf(row.disciplines), lastSessionDate: row.lastSessionDate, hasDraft: false },
      today,
    ),
  };
}
