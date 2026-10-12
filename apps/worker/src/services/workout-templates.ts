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
 *  - At most `MAX_TEMPLATES` an account (the list reads them all), held by the insert itself (insert … select where the
 *    count is under the cap), so two saves at once cannot pass it. User-scoped: another account's id is not found.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { workoutTemplates } from "@rg/database";
import { newId, parseStoredWorkoutDoc, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, type DocIssue } from "@rg/workout";
import type { Db } from "./db.js";
import { judgeDoc } from "./doc-build.js";
import { accepted, parsedDoc, profilesAndSetAside } from "./doc-workouts.js";

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

/** The document, schema-checked, then judged with no day (`judgeDoc`): refused on any error, its warnings answered. */
async function validated(db: Db, userId: string, raw: unknown): Promise<{ doc: WorkoutDoc; warnings: DocIssue[] }> {
  const doc = parsedDoc(raw);
  const { profiles, excluded } = await profilesAndSetAside(db, userId);
  return { doc, warnings: accepted(judgeDoc(doc, { library: EXERCISES, activeProfiles: profiles, day: null, excluded })) };
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
  const row = { id: newId(), userId, name: input.name, doc: doc as unknown as Record<string, unknown>, pinned: input.pinned ?? false, uses: 0, lastUsedAt: null, createdAt: now, updatedAt: now };
  // The cap in the insert itself: a save that would pass it writes nothing.
  const inserted = await db
    .insert(t)
    .select(
      sql`select ${row.id}, ${userId}, ${row.name}, ${JSON.stringify(doc)}, ${row.pinned ? 1 : 0}, 0, null, ${now}, ${now} where (select count(*) from ${t} where ${t.userId} = ${userId}) < ${MAX_TEMPLATES}`,
    )
    .returning({ id: t.id });
  if (inserted.length === 0) throw new TooManyTemplatesError();
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
