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
import type { ExerciseRecord } from "@rg/exercise-library";
import { deriveDoc, type DocIssue } from "@rg/workout";
import { libraryForDocs, loadAccountLibrary } from "./account-library.js";
import type { Db } from "./db.js";
import { judgeDoc } from "./doc-build.js";
import { accepted, keyedRowId, parsedDoc, profilesAndSetAside } from "./doc-workouts.js";

/** The most templates an account keeps. */
export const MAX_TEMPLATES = 200;

export class TemplateNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/** A write built on a copy the template has since moved past (its `updatedAt` is the template's own, now). */
export class StaleTemplateError extends Error {
  constructor(readonly updatedAt: string) {
    super("stale_revision");
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
/** A template's columns: its document the plain JSON text it is stored as, parsed only by `parseStoredWorkoutDoc`. */
const columns = {
  id: t.id,
  name: t.name,
  doc: t.doc,
  pinned: t.pinned,
  uses: t.uses,
  lastUsedAt: t.lastUsedAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};
type Row = { id: string; name: string; doc: unknown; pinned: boolean; uses: number; lastUsedAt: string | null; createdAt: string; updatedAt: string };

/**
 * The rows as the client reads them, each document's minutes and discipline derived in the account's library when one
 * holds one of the athlete's own moves (`libraryForDocs`: one statement then — none when the request read it already).
 */
async function dtosOf(db: Db, userId: string, rows: readonly Row[]): Promise<TemplateDto[]> {
  const docs = rows.map((r) => parseStoredWorkoutDoc(r.doc));
  const library = (await libraryForDocs(db, userId, docs)).all;
  return rows.map((r, i) => dtoOf(r, docs[i]!, library));
}

function dtoOf(r: Row, doc: WorkoutDoc | null, library: readonly ExerciseRecord[]): TemplateDto {
  const derived = doc ? deriveDoc(doc, library) : null;
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
  const doc = await parsedDoc(db, userId, raw);
  const [{ profiles, excluded }, library] = await Promise.all([profilesAndSetAside(db, userId), loadAccountLibrary(db, userId)]);
  return { doc, warnings: accepted(judgeDoc(doc, { library: library.all, offered: library.offered, activeProfiles: profiles, day: null, excluded })) };
}

/** The account's templates: pinned first, then the most recently used, then by name. */
export async function listTemplates(db: Db, userId: string): Promise<TemplateDto[]> {
  const rows = await db
    .select(columns)
    .from(t)
    .where(eq(t.userId, userId))
    .orderBy(desc(t.pinned), sql`${t.lastUsedAt} is null`, desc(t.lastUsedAt), asc(t.name), asc(t.id))
    .limit(MAX_TEMPLATES);
  return dtosOf(db, userId, rows);
}

/**
 * A save with a client's key (`clientId`, a draft's, made once on the device) is made once (`keyedRowId`, as a
 * workout's): a repeat answers the template it saved, as it now is, writing nothing (`repeated`).
 */
export async function createTemplate(
  db: Db,
  userId: string,
  input: { name: string; doc: unknown; pinned?: boolean; clientId?: string },
  now: string,
): Promise<{ template: TemplateDto; warnings: DocIssue[]; repeated?: true }> {
  const id = input.clientId ? await keyedRowId(userId, input.clientId) : newId();
  const saved = async (): Promise<{ template: TemplateDto; warnings: DocIssue[]; repeated: true } | null> => {
    const [made] = await db.select(columns).from(t).where(and(eq(t.id, id), eq(t.userId, userId))).limit(1);
    return made ? { template: (await dtosOf(db, userId, [made]))[0]!, warnings: [], repeated: true } : null;
  };
  if (input.clientId) {
    const made = await saved();
    if (made) return made;
  }
  const { doc, warnings } = await validated(db, userId, input.doc);
  const row = { id, userId, name: input.name, doc: JSON.stringify(doc), pinned: input.pinned ?? false, uses: 0, lastUsedAt: null, createdAt: now, updatedAt: now };
  // The cap in the insert itself: a save that would pass it writes nothing.
  let inserted: Array<{ id: string }>;
  try {
    inserted = await db
      .insert(t)
      .select(
        sql`select ${row.id}, ${userId}, ${row.name}, ${row.doc}, ${row.pinned ? 1 : 0}, 0, null, ${now}, ${now} where (select count(*) from ${t} where ${t.userId} = ${userId}) < ${MAX_TEMPLATES}`,
      )
      .returning({ id: t.id });
  } catch (e) {
    // Two saves with one key raced: the one that landed is the answer.
    const made = input.clientId ? await saved() : null;
    if (made) return made;
    throw e;
  }
  if (inserted.length === 0) throw new TooManyTemplatesError();
  return { template: (await dtosOf(db, userId, [row]))[0]!, warnings };
}

export async function updateTemplate(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; doc?: unknown; pinned?: boolean; baseUpdatedAt?: string },
  now: string,
): Promise<{ template: TemplateDto; warnings: DocIssue[] }> {
  const [row] = await db.select(columns).from(t).where(and(eq(t.id, id), eq(t.userId, userId))).limit(1);
  if (!row) throw new TemplateNotFoundError();
  const checked = patch.doc === undefined ? null : await validated(db, userId, patch.doc);
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(checked ? { doc: JSON.stringify(checked.doc) } : {}),
    updatedAt: now,
  };
  // With a base, the write lands only on that version: one made since the copy was read is refused, never written over.
  const written = await db
    .update(t)
    .set(set)
    .where(and(eq(t.id, id), eq(t.userId, userId), ...(patch.baseUpdatedAt !== undefined ? [eq(t.updatedAt, patch.baseUpdatedAt)] : [])))
    .returning({ id: t.id });
  if (written.length === 0) {
    const [current] = await db.select({ updatedAt: t.updatedAt }).from(t).where(and(eq(t.id, id), eq(t.userId, userId))).limit(1);
    if (!current) throw new TemplateNotFoundError();
    throw new StaleTemplateError(current.updatedAt);
  }
  return { template: (await dtosOf(db, userId, [{ ...row, ...set }]))[0]!, warnings: checked?.warnings ?? [] };
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
  const [template] = await dtosOf(db, userId, [row]);
  return { template: template!, doc: template!.doc ? { ...template!.doc, basedOn: { kind: "template", id } } : null };
}
