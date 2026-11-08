import { z } from "zod";
import {
  courseConfigSchema,
  defaultOnEnd,
  isLocalDate,
  planOnEndSchema,
  planPrompt,
  PLAN_BRIEF_MAX,
  PLAN_OBJECTIVES_MAX,
  PLAN_PURPOSE_MAX,
  type PlanDraftState,
  type PlanOnEnd,
  type PlanPrompt,
  type ProgramKind,
  type TrainingLine,
} from "@rg/domain";
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
 *    With drafts on (plans with a purpose §4.2) a coach plan that continues also brings what the hourly draft made of its endings
 *    (`drafts`, read in the same statement: plan-ending.ts `planDraftsSql`), and `draftStateOf` reads it: its next stretch ready
 *    while a proposal naming it waits; for this ending, its draft due, at work, or over — and why, as the prompt's `note`, which
 *    the wire carries only when it says something (drafts off, every prompt is as it was, byte for byte).
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
  /** `note`: what happened to the plan's draft, when it came to nothing (drafts on only); absent otherwise. */
  prompt: { kind: "whats_next" | "draft_ready"; label: string; request: string; note?: string } | null;
}

/**
 * What the hourly draft has made of a coach plan's endings (plans with a purpose §4.2), read with the plan (plan-ending.ts
 * `planDraftsSql`) while drafts are on: each ending's key (`plan-draft:<planId>:<lastSessionDate>`, newest first) with the
 * run it started, or the outcome when none started, the run's status and its proposal's — and whether a proposal that names
 * the plan waits for the athlete. Nothing of it is stored twice: a draft is over when its run is.
 */
export interface PlanDraftFacts {
  keys: Array<{
    /** The ending the key is for: its last session's date. */
    lastSessionDate: string;
    runId: string | null;
    /** Why no run started (`week_budget`); null when one did. */
    outcome: string | null;
    /** Its run is still at work (a live status). */
    runLive: boolean;
    /** Its run's proposal reached the athlete (made pending once: whatever came of it since). */
    proposalSeen: boolean;
    /** Its run's proposal still has something for the athlete to decide, today or later, and isn't past its day. */
    proposalOpen: boolean;
  }>;
  /** A proposal that names the plan — a workout filed under it or a block of it, or a change to its shape — waits. */
  waiting: boolean;
}

/**
 * What the rule is told of a plan's draft (plans with a purpose §4.2): nothing with drafts off, or for any plan but a coach
 * plan that continues — the rule as it was. Otherwise its next stretch is ready while a proposal waits that names it, or that
 * one of its drafts made; and this ending's draft (the key for its last day) is due when there is no key yet, at work while
 * its run is live, else over — with no run started (the week's budget), with no proposal that reached the athlete, or with
 * one they decided.
 */
export function draftOf(row: Pick<PlanEndingRow, "kind" | "lastDay" | "drafts">, onEnd: PlanOnEnd): { hasDraft: boolean; draft?: PlanDraftState } {
  const f = row.drafts;
  if (!f || row.kind !== "coach" || onEnd !== "continue") return { hasDraft: false };
  const hasDraft = f.waiting || f.keys.some((k) => k.proposalOpen);
  const key = row.lastDay === null ? undefined : f.keys.find((k) => k.lastSessionDate === row.lastDay);
  if (!key) return { hasDraft, draft: { kind: "due" } };
  if (key.runId === null) return { hasDraft, draft: { kind: "over", outcome: key.outcome === "week_budget" ? "week_budget" : "no_proposal" } };
  if (key.runLive) return { hasDraft, draft: { kind: "live" } };
  return { hasDraft, draft: { kind: "over", outcome: key.proposalSeen ? "decided" : "no_proposal" } };
}

/** A draft facts column as read (JSON text, plan-ending.ts `planDraftsSql`): null for none, or one that doesn't read. */
export function draftFactsOf(text: string | null | undefined): PlanDraftFacts | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const raw = JSON.parse(text) as { keys?: unknown; waiting?: unknown };
    const keys = (Array.isArray(raw.keys) ? raw.keys : []).flatMap((k): PlanDraftFacts["keys"] => {
      const x = k as Record<string, unknown>;
      const date = typeof x.id === "string" ? x.id.slice(x.id.lastIndexOf(":") + 1) : "";
      if (!isLocalDate(date)) return [];
      return [
        {
          lastSessionDate: date,
          runId: typeof x.runId === "string" ? x.runId : null,
          outcome: typeof x.outcome === "string" ? x.outcome : null,
          runLive: x.runLive === 1 || x.runLive === true,
          proposalSeen: x.proposalSeen === 1 || x.proposalSeen === true,
          proposalOpen: x.proposalOpen === 1 || x.proposalOpen === true,
        },
      ];
    });
    return { keys, waiting: raw.waiting === 1 || raw.waiting === true };
  } catch {
    return undefined;
  }
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
  /** The disciplines of its blocks that aren't stopped, as a training line speaks them; [] for a plan with no blocks. */
  blockDisciplines: readonly string[];
  /** With drafts on, a coach plan's: what the hourly draft made of its endings (`planDraftsSql`). Absent with drafts off. */
  drafts?: PlanDraftFacts;
}

/** `programs.disciplines`' words back to a training line's. */
const LINE_DISCIPLINE = { run: "run", strength: "lift", yoga: "mobility" } as const;

/**
 * A plan, as the rule that asks what comes next reads it: the one shape the chip, the plan's row and the dormant trigger
 * all build (`promptOfPlan`), so their words and their reading of "ending" are one. `lastDay` is worked out in SQL
 * (`planLastDaySql`), never stored.
 */
export interface PlanEndingRow {
  id: string;
  kind: ProgramKind;
  name: string;
  /** The plan row's own status; a stopped plan ("retired" or "archived") never asks. */
  status: string;
  /** `programs.on_end` as stored (null: the kind's own ending). */
  onEnd: string | null;
  pausedUntil: string | null;
  /** `programs.disciplines`: "run", "strength", "yoga". */
  disciplines: readonly string[];
  /** The disciplines of the plan's blocks that aren't stopped, as a training line speaks them ("run", "lift", "mobility"). */
  blockDisciplines: readonly string[];
  lastDay: string | null;
  /** With drafts on, a coach plan's: what the hourly draft made of its endings, read with the row. Absent with drafts off,
   * and the rule is then the one it always was. */
  drafts?: PlanDraftFacts;
}

/**
 * The sport a plan is called by ("my running plan"): the one its blocks share, else (no blocks) the one its row names; null
 * for a plan of several, which is called by its own name.
 */
export function planSport(row: Pick<PlanEndingRow, "disciplines" | "blockDisciplines">): "run" | "lift" | "mobility" | null {
  const own = row.blockDisciplines.length > 0 ? [...new Set(row.blockDisciplines)] : [...new Set(row.disciplines.map((d) => LINE_DISCIPLINE[d as keyof typeof LINE_DISCIPLINE]))];
  const only = own.length === 1 ? own[0] : undefined;
  return only === "run" || only === "lift" || only === "mobility" ? only : null;
}

/**
 * The plans that have run out and been followed: another plan of the same sport is running (not stopped) with a later last
 * day, as a phase placed after a plan follows it. The question what comes after them is answered, so they stop asking (a
 * plan of another sport doesn't answer it; nor does one of no single sport, called by its name). The chip and the row both
 * leave these out.
 */
export function plansSuperseded(rows: readonly PlanEndingRow[], today: string): Set<string> {
  const out = new Set<string>();
  const stopped = (r: PlanEndingRow) => r.status === "retired" || r.status === "archived";
  for (const r of rows) {
    const sport = planSport(r);
    if (stopped(r) || sport === null || r.lastDay === null || r.lastDay >= today) continue;
    // A follower is running (its last day is today or later, so later than this plan's), not stopped, and of the same sport.
    if (rows.some((s) => s.id !== r.id && !stopped(s) && s.lastDay !== null && s.lastDay >= today && planSport(s) === sport)) out.add(r.id);
  }
  return out;
}

/** How a plan ends, as the rule reads it: its row's own, else its kind's (`defaultOnEnd`: a coach plan of running asks). */
export function planOnEndOf(row: Pick<PlanEndingRow, "onEnd" | "kind" | "disciplines">): PlanOnEnd {
  const parsed = planOnEndSchema.safeParse(row.onEnd);
  return parsed.success ? parsed.data : defaultOnEnd(row.kind, row.disciplines);
}

/** What the rule says of a plan today — with drafts on, of a coach plan that continues, its draft too (`draftOf`). The one
 * reading of it. */
export function promptOfPlan(row: PlanEndingRow, today: string, superseded: ReadonlySet<string> = new Set()): PlanPrompt | null {
  if (superseded.has(row.id)) return null;
  const onEnd = planOnEndOf(row);
  const { hasDraft, draft } = draftOf(row, onEnd);
  return planPrompt(
    {
      kind: row.kind,
      onEnd,
      status: row.status === "retired" || row.status === "archived" ? "retired" : "active",
      pausedUntil: row.pausedUntil,
      name: row.name,
      discipline: planSport(row),
      lastSessionDate: row.lastDay,
      hasDraft,
      ...(draft ? { draft } : {}),
    },
    today,
  );
}

/** A prompt as the wire carries it: its note only when it says something, so with drafts off it is what it always was. */
export function promptDto(p: PlanPrompt | null): PlanSummaryDto["prompt"] {
  if (!p) return null;
  return { kind: p.kind, label: p.label, request: p.request, ...(p.note ? { note: p.note } : {}) };
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

export function planSummaryOf(row: PlanRow, lineKeys: ReadonlyMap<string, string>, today: string, superseded: ReadonlySet<string> = new Set()): PlanSummaryDto {
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
    prompt: promptDto(promptOfPlan(endingRowOf(row), today, superseded)),
  };
}

/** A plan's row as the rule that asks what comes next reads it. */
export function endingRowOf(row: PlanRow): PlanEndingRow {
  return {
    id: row.id,
    kind: row.kind as ProgramKind,
    name: row.name,
    status: row.status,
    onEnd: row.onEnd,
    pausedUntil: row.pausedUntil,
    disciplines: row.disciplines,
    blockDisciplines: row.blockDisciplines,
    lastDay: row.lastSessionDate,
    ...(row.drafts ? { drafts: row.drafts } : {}),
  };
}
