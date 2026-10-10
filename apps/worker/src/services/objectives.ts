/**
 * OBJECTIVES AND KEY RESULTS (principles §5.2; programme spec §3.6–3.7 and its Amendment A).
 *
 * An objective is something the athlete is working on; its key results are numbers measured from logged data
 * (services/key-result-measures.ts). Everything is the account's own: an objective another account holds reads as
 * not found. A key result keeps its `target` and `baseline` in its `unit` — the athlete's unit for its measure unless
 * one is given — and its `direction` — the measure's own way unless the measure can go either (a check-in, a test).
 * Measures are stored as parsed (defaults filled) with each move's current library id.
 *
 * Key results are listed in the athlete's order: `position` is each one's index in the list last sent (POST, or a
 * PUT's whole list), so a new one sent before a kept one stays before it and a reorder sticks.
 *
 * Every write is refused while a restore is replacing the account (ruling B2) and lands as one transaction.
 */
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { ZodError, type z } from "zod";
import { keyResults, objectives } from "@rg/database";
import {
  defaultUnitFor,
  GOAL_IDS,
  KEY_RESULT_DIRECTIONS,
  KEY_RESULT_UNITS,
  keyResultMeasureSchema,
  naturalDirection,
  newId,
  objectiveCreateSchema,
  objectiveUpdateSchema,
  OBJECTIVE_STATUSES,
  canonicalUnitOf,
  unitsFor,
  type KeyResultDirection,
  type KeyResultDto,
  type KeyResultMeasure,
  type KeyResultUnit,
  type ObjectiveDto,
  type ObjectiveProgressDto,
  type ObjectiveStatus,
  type UserPreferences,
} from "@rg/domain";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { insertBatches, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { libraryMove, measureKeyResults, unreadableProgress, type MeasureContext } from "./key-result-measures.js";
import { RestoreInProgressError } from "./programs.js";

export class ObjectiveNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const objectiveColumns = {
  id: objectives.id,
  title: objectives.title,
  why: objectives.why,
  status: objectives.status,
  // JSON columns as text: a damaged one reads as empty, never a throw in the driver.
  goalIds: sql<string | null>`${objectives.goalIds}`,
  sort: objectives.sort,
  createdAt: objectives.createdAt,
  updatedAt: objectives.updatedAt,
};

const keyResultColumns = {
  id: keyResults.id,
  objectiveId: keyResults.objectiveId,
  label: keyResults.label,
  measure: sql<string | null>`${keyResults.measure}`,
  direction: keyResults.direction,
  baseline: keyResults.baseline,
  target: keyResults.target,
  unit: keyResults.unit,
  dueDate: keyResults.dueDate,
  position: keyResults.position,
  createdAt: keyResults.createdAt,
  updatedAt: keyResults.updatedAt,
};

interface ObjectiveRow {
  id: string;
  title: string;
  why: string | null;
  status: string;
  goalIds: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

interface KeyResultRow {
  id: string;
  objectiveId: string;
  label: string;
  measure: string | null;
  direction: string;
  baseline: number | null;
  target: number | null;
  unit: string;
  dueDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

function parsedJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

function keyResultDto(r: KeyResultRow): KeyResultDto {
  const parsed = keyResultMeasureSchema.safeParse(parsedJson(r.measure));
  const measure = parsed.success ? parsed.data : null;
  const unit: KeyResultUnit = isOneOf(KEY_RESULT_UNITS, r.unit) ? r.unit : measure ? canonicalUnitOf(measure) : "score";
  return {
    id: r.id,
    objectiveId: r.objectiveId,
    label: r.label,
    measure,
    direction: isOneOf(KEY_RESULT_DIRECTIONS, r.direction) ? r.direction : "up",
    baseline: r.baseline,
    target: r.target,
    unit,
    dueDate: r.dueDate,
    position: r.position,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function objectiveDto(o: ObjectiveRow, krs: readonly KeyResultRow[]): ObjectiveDto {
  const goals = parsedJson(o.goalIds);
  return {
    id: o.id,
    title: o.title,
    why: o.why,
    status: isOneOf(OBJECTIVE_STATUSES, o.status) ? o.status : ("active" as ObjectiveStatus),
    goalIds: Array.isArray(goals) ? goals.filter((g): g is string => isOneOf(GOAL_IDS, g)) : [],
    sort: o.sort,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    keyResults: krs.map(keyResultDto),
  };
}

/** The athlete's order; rows written before positions differed (or a restored file's ties) by age, then id. */
const krOrder = [asc(keyResults.position), asc(keyResults.createdAt), asc(keyResults.id)];

/** The account's objectives in board order (sort, then oldest first), each with its key results. */
export async function listObjectives(db: Db, userId: string): Promise<ObjectiveDto[]> {
  const [rows, krs] = await Promise.all([
    db
      .select(objectiveColumns)
      .from(objectives)
      .where(eq(objectives.userId, userId))
      .orderBy(asc(objectives.sort), asc(objectives.createdAt), asc(objectives.id)),
    db.select(keyResultColumns).from(keyResults).where(eq(keyResults.userId, userId)).orderBy(...krOrder),
  ]);
  const byObjective = new Map<string, KeyResultRow[]>();
  for (const kr of krs) byObjective.set(kr.objectiveId, [...(byObjective.get(kr.objectiveId) ?? []), kr]);
  return rows.map((o) => objectiveDto(o, byObjective.get(o.id) ?? []));
}

/** One of the account's objectives; `ObjectiveNotFoundError` for any other id. */
export async function getObjective(db: Db, userId: string, id: string): Promise<ObjectiveDto> {
  const [[row], krs] = await Promise.all([
    db.select(objectiveColumns).from(objectives).where(and(eq(objectives.id, id), eq(objectives.userId, userId))).limit(1),
    db
      .select(keyResultColumns)
      .from(keyResults)
      .where(and(eq(keyResults.objectiveId, id), eq(keyResults.userId, userId)))
      .orderBy(...krOrder),
  ]);
  if (!row) throw new ObjectiveNotFoundError();
  return objectiveDto(row, krs);
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface KeyResultInputParsed {
  id?: string;
  label: string;
  measure: KeyResultMeasure;
  direction?: KeyResultDirection;
  baseline?: number | null;
  target?: number | null;
  unit?: KeyResultUnit;
  dueDate?: string | null;
}

/** Each move a measure names must be the library's; issues point at the id. */
function libraryIssues(krs: readonly KeyResultInputParsed[] | undefined): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  krs?.forEach((kr, i) => {
    if (kr.measure.kind !== "hold_max" && kr.measure.kind !== "best_set") return;
    kr.measure.libraryIds.forEach((id, j) => {
      if (!libraryMove(id)) {
        issues.push({ code: "custom", path: ["keyResults", i, "measure", "libraryIds", j], message: "not a move the library holds" });
      }
    });
  });
  return issues;
}

/** The measure with each move's current library id (a legacy id becomes the move's id now). */
function withCurrentIds(m: KeyResultMeasure): KeyResultMeasure {
  if (m.kind !== "hold_max" && m.kind !== "best_set") return m;
  return { ...m, libraryIds: [...new Set(m.libraryIds.map((id) => libraryMove(id)?.id ?? id))] };
}

/**
 * A key result's row at `stamps.position` in the list sent. Its unit: the one sent; else, for a key result that
 * already exists, the unit it was kept in (its target and baseline are in it) while the measure still fits it; else
 * the athlete's unit for the measure.
 */
function keyResultRow(
  userId: string,
  objectiveId: string,
  kr: KeyResultInputParsed,
  prefs: Pick<UserPreferences, "weightUnit" | "units">,
  stamps: { id: string; position: number; createdAt: string; updatedAt: string },
  keptUnit?: KeyResultUnit,
): typeof keyResults.$inferInsert {
  const measure = withCurrentIds(kr.measure);
  const unit = kr.unit ?? (keptUnit !== undefined && unitsFor(measure).includes(keptUnit) ? keptUnit : defaultUnitFor(measure, prefs));
  return {
    id: stamps.id,
    userId,
    objectiveId,
    label: kr.label,
    measure: measure as unknown as Record<string, unknown>,
    // The schema requires a direction exactly when the measure has no way of its own.
    direction: kr.direction ?? naturalDirection(measure) ?? "up",
    baseline: kr.baseline ?? null,
    target: kr.target ?? null,
    unit,
    dueDate: kr.dueDate ?? null,
    position: stamps.position,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
}

async function refuseWhileRestoring(db: Db, userId: string): Promise<void> {
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
}

export async function createObjective(db: Db, userId: string, input: unknown, now: string): Promise<ObjectiveDto> {
  const p = objectiveCreateSchema.parse(input);
  const issues = libraryIssues(p.keyResults);
  if (issues.length > 0) throw new ZodError(issues);
  await refuseWhileRestoring(db, userId);
  const prefs = p.keyResults.length > 0 ? await loadPreferences(db, userId) : { weightUnit: "lb" as const, units: "km" as const };

  const id = newId();
  const rows = p.keyResults.map((kr, i) => keyResultRow(userId, id, kr, prefs, { id: newId(), position: i, createdAt: now, updatedAt: now }));
  const statements: AtomicStatement[] = [
    db.insert(objectives).values({
      id,
      userId,
      title: p.title,
      why: p.why ?? null,
      status: p.status,
      goalIds: p.goalIds,
      sort: p.sort,
      createdAt: now,
      updatedAt: now,
    }),
    ...insertBatches(rows).map((batch) => db.insert(keyResults).values(batch)),
  ];
  await runAtomically(db, statements);
  return getObjective(db, userId, id);
}

/**
 * Change what is sent. `keyResults`, when sent, is the whole list in the athlete's order: an entry with the id of one
 * of this objective's key results changes it (its creation stamp kept), one without is new, one left out is deleted,
 * and each takes its index as its position. An id that is not one of this objective's is a ZodError — nothing is
 * written.
 */
export async function updateObjective(db: Db, userId: string, id: string, input: unknown, now: string): Promise<ObjectiveDto> {
  const p = objectiveUpdateSchema.parse(input);
  const issues = libraryIssues(p.keyResults as KeyResultInputParsed[] | undefined);
  await refuseWhileRestoring(db, userId);
  const current = await getObjective(db, userId, id);
  const held = new Map(current.keyResults.map((k) => [k.id, k]));
  p.keyResults?.forEach((kr, i) => {
    if (kr.id !== undefined && !held.has(kr.id)) {
      issues.push({ code: "custom", path: ["keyResults", i, "id"], message: "not one of this objective's key results" });
    }
  });
  if (issues.length > 0) throw new ZodError(issues);

  const ours = and(eq(objectives.id, id), eq(objectives.userId, userId));
  const statements: AtomicStatement[] = [
    db
      .update(objectives)
      .set({
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.why !== undefined ? { why: p.why } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
        ...(p.goalIds !== undefined ? { goalIds: p.goalIds } : {}),
        ...(p.sort !== undefined ? { sort: p.sort } : {}),
        updatedAt: now,
      })
      .where(ours),
  ];
  if (p.keyResults !== undefined) {
    const prefs = await loadPreferences(db, userId);
    const sent = p.keyResults as KeyResultInputParsed[];
    const keep = sent.map((kr) => kr.id).filter((k): k is string => k !== undefined);
    const mine = and(eq(keyResults.objectiveId, id), eq(keyResults.userId, userId));
    statements.push(db.delete(keyResults).where(keep.length > 0 ? and(mine, notInArray(keyResults.id, keep)) : mine));
    const rows = sent.map((kr, position) => {
      const kept = kr.id !== undefined ? held.get(kr.id) : undefined;
      const stamps = { id: kept?.id ?? newId(), position, createdAt: kept?.createdAt ?? now, updatedAt: now };
      return keyResultRow(userId, id, kr, prefs, stamps, kept?.unit);
    });
    const fromRow = (col: string) => sql.raw(`excluded.${col}`);
    for (const batch of insertBatches(rows)) {
      statements.push(
        db
          .insert(keyResults)
          .values(batch)
          .onConflictDoUpdate({
            target: keyResults.id,
            set: {
              label: fromRow("label"),
              measure: fromRow("measure"),
              direction: fromRow("direction"),
              baseline: fromRow("baseline"),
              target: fromRow("target"),
              unit: fromRow("unit"),
              dueDate: fromRow("due_date"),
              position: fromRow("position"),
              updatedAt: fromRow("updated_at"),
            },
            // Only ever this objective's own key result.
            setWhere: and(eq(keyResults.objectiveId, id), eq(keyResults.userId, userId)),
          }),
      );
    }
  }
  await runAtomically(db, statements);
  return getObjective(db, userId, id);
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every key result of the objective measured from logged data, in one pass over each source. `ctx` carries what the
 * caller has read of the user's preferences already: the athlete's today and the race hub's race date.
 */
export async function objectiveProgress(db: Db, userId: string, id: string, ctx: MeasureContext): Promise<ObjectiveProgressDto> {
  const objective = await getObjective(db, userId, id);
  const measurable = objective.keyResults.filter((k): k is KeyResultDto & { measure: KeyResultMeasure } => k.measure !== null);
  const measured = await measureKeyResults(
    db,
    userId,
    measurable.map((k) => ({ measure: k.measure, unit: k.unit })),
    ctx,
  );
  const byId = new Map(measurable.map((k, i) => [k.id, measured[i]!]));
  return {
    objectiveId: objective.id,
    today: ctx.today,
    keyResults: objective.keyResults.map((k) => ({ keyResult: k, progress: byId.get(k.id) ?? unreadableProgress(k.unit) })),
  };
}
