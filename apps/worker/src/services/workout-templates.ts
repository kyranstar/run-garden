/**
 * SAVED TEMPLATES (Stage 2 spec §9–§10): workout documents the athlete keeps to use again (`workout_templates`).
 *
 *  - A template's document is validated with NO day (`day: null`, the validator's template context: does it fit at
 *    all, with the athlete's profiles and set-aside moves) — an error refuses it, warnings come back with it. Whether
 *    a jump is open is the day's question, asked when it is scheduled (`doc-workouts.ts`) and again at Start.
 *  - The list: pinned first, then the most recently used, then by name; with each document's derived minutes and
 *    discipline. A stored document that no longer reads is listed with none (`doc: null`), never a 500 — the column
 *    is read as raw text and parsed with `parseStoredWorkoutDoc`.
 *  - Using one bumps its uses and its last use, and answers its document stamped `basedOn: template` — scheduled, it
 *    is a `template` row.
 *  - At most `MAX_TEMPLATES` an account (the list reads them all). User-scoped: another account's id is not found.
 */
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { exercisePrefs, userConditions, workoutTemplates } from "@rg/database";
import { newId, parseStoredWorkoutDoc, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILES, isProfileId } from "@rg/exercise-library";
import { deriveDoc, validateWorkoutDoc, type DocIssue } from "@rg/workout";
import type { Db } from "./db.js";
import { DocInvalidError } from "./doc-workouts.js";

/** The most templates an account keeps. */
export const MAX_TEMPLATES = 200;

export class TemplateNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

export class TooManyTemplatesError extends Error {
  constructor() {
    super("too_many");
  }
}

export interface TemplateDto {
  id: string;
  name: string;
  /** Null when the stored document no longer reads. */
  doc: WorkoutDoc | null;
  pinned: boolean;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived from the document; null without one. */
  minutes: number | null;
  discipline: string | null;
}

const t = workoutTemplates;
/** A template's columns, its document as the raw text it is stored as (never parsed by the driver). */
const columns = {
  id: t.id,
  name: t.name,
  doc: sql<string | null>`${t.doc}`,
  pinned: t.pinned,
  uses: t.uses,
  lastUsedAt: t.lastUsedAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};
type Row = { id: string; name: string; doc: unknown; pinned: boolean; uses: number; lastUsedAt: string | null; createdAt: string; updatedAt: string };

function dtoOf(r: Row): TemplateDto {
  const doc = parseStoredWorkoutDoc(r.doc);
  const derived = doc ? deriveDoc(doc, EXERCISES) : null;
  return {
    id: r.id,
    name: r.name,
    doc,
    pinned: Boolean(r.pinned),
    uses: r.uses,
    lastUsedAt: r.lastUsedAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    minutes: derived?.estimatedMinutes ?? null,
    discipline: derived?.discipline ?? null,
  };
}

/** The document, schema-checked, then validated with no day: refused on any error, its warnings answered. */
async function validated(db: Db, userId: string, raw: unknown): Promise<{ doc: WorkoutDoc; warnings: DocIssue[] }> {
  const parsed = workoutDocSchema.safeParse(raw);
  if (!parsed.success) throw new DocInvalidError(validateWorkoutDoc(raw, { library: EXERCISES, activeProfiles: [], day: null }));
  const [conditionRows, setAside] = await Promise.all([
    db
      .select({ profileId: userConditions.profileId })
      .from(userConditions)
      .where(and(eq(userConditions.userId, userId), eq(userConditions.active, true))),
    db
      .select({ exerciseId: exercisePrefs.exerciseId })
      .from(exercisePrefs)
      .where(and(eq(exercisePrefs.userId, userId), eq(exercisePrefs.excluded, true))),
  ]);
  const active = [...new Set(conditionRows.map((r) => r.profileId).filter(isProfileId))].sort();
  const issues = validateWorkoutDoc(parsed.data, {
    library: EXERCISES,
    activeProfiles: active.map((id) => PROFILES[id]),
    day: null,
    excluded: setAside.map((r) => r.exerciseId),
  });
  if (issues.some((i) => i.severity === "error")) throw new DocInvalidError(issues);
  return { doc: parsed.data, warnings: issues };
}

/** The account's templates: pinned first, then the most recently used, then by name. */
export async function listTemplates(db: Db, userId: string): Promise<TemplateDto[]> {
  const rows = await db
    .select(columns)
    .from(t)
    .where(eq(t.userId, userId))
    .orderBy(desc(t.pinned), sql`${t.lastUsedAt} is null`, desc(t.lastUsedAt), asc(t.name), asc(t.id))
    .limit(MAX_TEMPLATES);
  return rows.map(dtoOf);
}

export async function createTemplate(
  db: Db,
  userId: string,
  input: { name: string; doc: unknown; pinned?: boolean },
  now: string,
): Promise<{ template: TemplateDto; warnings: DocIssue[] }> {
  const { doc, warnings } = await validated(db, userId, input.doc);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(t).where(eq(t.userId, userId));
  if (n >= MAX_TEMPLATES) throw new TooManyTemplatesError();
  const row = { id: newId(), userId, name: input.name, doc: doc as unknown as Record<string, unknown>, pinned: input.pinned ?? false, uses: 0, lastUsedAt: null, createdAt: now, updatedAt: now };
  await db.insert(t).values(row);
  return { template: dtoOf(row), warnings };
}

export async function updateTemplate(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; doc?: unknown; pinned?: boolean },
  now: string,
): Promise<{ template: TemplateDto; warnings: DocIssue[] }> {
  const [row] = await db.select(columns).from(t).where(and(eq(t.id, id), eq(t.userId, userId))).limit(1);
  if (!row) throw new TemplateNotFoundError();
  const checked = patch.doc === undefined ? null : await validated(db, userId, patch.doc);
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(checked ? { doc: checked.doc as unknown as Record<string, unknown> } : {}),
    updatedAt: now,
  };
  await db.update(t).set(set).where(and(eq(t.id, id), eq(t.userId, userId)));
  return { template: dtoOf({ ...row, ...set }), warnings: checked?.warnings ?? [] };
}

export async function deleteTemplate(db: Db, userId: string, id: string): Promise<void> {
  const gone = await db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId))).returning({ id: t.id });
  if (gone.length === 0) throw new TemplateNotFoundError();
}

/** Bump the template's uses; its document, stamped `basedOn: template`, to open or schedule. */
export async function useTemplate(db: Db, userId: string, id: string, now: string): Promise<{ template: TemplateDto; doc: WorkoutDoc | null }> {
  const [row] = await db
    .update(t)
    .set({ uses: sql`${t.uses} + 1`, lastUsedAt: now })
    .where(and(eq(t.id, id), eq(t.userId, userId)))
    .returning(columns);
  if (!row) throw new TemplateNotFoundError();
  const template = dtoOf(row);
  return { template, doc: template.doc ? { ...template.doc, basedOn: { kind: "template", id } } : null };
}
