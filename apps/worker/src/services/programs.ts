/**
 * ADAPTIVE PROGRAMS — create, list, update (Phase 2 spec §2a "Programs API"; programme spec §8.1).
 *
 * A program row holds the athlete's settings (`config`, validated by `adaptiveConfigSchema`); its slots are
 * placed by `program-slots.ts` and its blocks written by the session build. This file never places anything
 * itself: the routes call `placeSlots` after a create or an update, so the hourly pass and an edit run the one
 * placement rule.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2): `updateProgram` returns
 * without writing, and `createAdaptiveProgram`, which cannot return an id it did not write, throws
 * `RestoreInProgressError`.
 */
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { plannedWorkouts, programBlocks, programs } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  coreBlockIntentSchema,
  daysBetween,
  newId,
  startOfIsoWeek,
  type AdaptiveConfig,
} from "@rg/domain";
import { CORE_FAMILIES, EXERCISES } from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import { chunkIds, type Db } from "./db.js";

export interface ProgramCoreLift {
  /** A core family id (`CORE_FAMILIES`: squat, hinge, row, press, carry). */
  family: string;
  /** The block's lift for the family; null = none yet. */
  exerciseId: string | null;
  /** The lift's library name; null when there is no lift or the library no longer has it. */
  name: string | null;
}

export interface ProgramDto {
  id: string;
  kind: "adaptive";
  name: string;
  status: "active" | "retired";
  config: AdaptiveConfig;
  /** The latest block: its number, which week of it today falls in, and its core lifts. Null before the first
   * build starts one. */
  block: { number: number; week: number; weeks: number; core: ProgramCoreLift[] } | null;
  /** This ISO week, by where each slot sits now: live slots, the ones done, and the weekly goal. */
  week: { placed: number; done: number; goal: number };
}

export class ProgramNotFoundError extends Error {
  constructor() {
    super("program_not_found");
  }
}

export class RestoreInProgressError extends Error {
  constructor() {
    super("restore_in_progress");
  }
}

/** A program's name as the athlete typed it, trimmed. */
export const programNameSchema = z.string().trim().min(1).max(80);
/** The statuses an athlete can set on an adaptive program. */
export const adaptiveStatusSchema = z.enum(["active", "retired"]);

/** An adaptive program schedules both: a slot's session is strength or yoga once built (programme spec §9.2);
 * until then it carries the first (`defaultDiscipline` in `program-slots.ts`). */
const ADAPTIVE_DISCIPLINES = ["yoga", "strength"];

export async function createAdaptiveProgram(
  db: Db,
  userId: string,
  input: { name: string; config: AdaptiveConfig },
  now: string,
): Promise<string> {
  const name = programNameSchema.parse(input.name);
  const config = adaptiveConfigSchema.parse(input.config);
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  const id = newId();
  await db.insert(programs).values({
    id,
    userId,
    kind: "adaptive",
    name,
    status: "active",
    disciplines: ADAPTIVE_DISCIPLINES,
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return id;
}

/**
 * Update a program's name, status, or config. The config patch is MERGED over the stored config and the result
 * validated whole, so `{weeklyGoal: 3}` changes the goal and nothing else. Throws `ProgramNotFoundError` for a
 * program that is not this user's adaptive program, and a ZodError for an invalid patch.
 */
export async function updateProgram(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; config?: Partial<AdaptiveConfig>; status?: "active" | "retired" },
  now: string,
): Promise<void> {
  if (await restoreInProgress(db, userId)) return;
  const [row] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, id), eq(programs.userId, userId), eq(programs.kind, "adaptive")))
    .limit(1);
  if (!row) throw new ProgramNotFoundError();

  const set: Partial<typeof programs.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = programNameSchema.parse(patch.name);
  if (patch.status !== undefined) set.status = adaptiveStatusSchema.parse(patch.status);
  if (patch.config !== undefined) {
    const changes = Object.fromEntries(Object.entries(patch.config).filter(([, v]) => v !== undefined));
    set.config = adaptiveConfigSchema.parse({ ...row.config, ...changes });
  }
  await db.update(programs).set(set).where(and(eq(programs.id, id), eq(programs.userId, userId)));
}

let exerciseNames: Map<string, string> | null = null;
function exerciseName(id: string): string | null {
  exerciseNames ??= new Map(EXERCISES.map((e) => [e.id, e.name]));
  return exerciseNames.get(id) ?? null;
}

const FAMILY_ORDER = new Map(CORE_FAMILIES.map((f, i) => [f.id, i]));

function blockSummary(block: typeof programBlocks.$inferSelect | undefined, today: string): ProgramDto["block"] {
  if (!block || block.kind !== "core_block") return null;
  const intent = coreBlockIntentSchema.safeParse(block.intent);
  const core = intent.success ? intent.data.core : {};
  const families = Object.keys(core).sort(
    (a, b) => (FAMILY_ORDER.get(a) ?? FAMILY_ORDER.size) - (FAMILY_ORDER.get(b) ?? FAMILY_ORDER.size) || a.localeCompare(b),
  );
  // The engine's week of a block (`Blocks.weekOf`), held to the block's own length for display.
  const week = Math.min(block.weeks, Math.max(1, Math.floor(daysBetween(block.startDate, today) / 7) + 1));
  return {
    number: block.number,
    week,
    weeks: block.weeks,
    core: families.map((family) => {
      const exerciseId = core[family] ?? null;
      return { family, exerciseId, name: exerciseId ? exerciseName(exerciseId) : null };
    }),
  };
}

/** Bound per statement: the ids, plus this query's own few (user, origin, dates). */
const PROGRAM_ID_CHUNK = 80;

/** This user's adaptive programs, oldest first, each with its current block and this week's count vs goal. */
export async function listPrograms(db: Db, userId: string, today: string): Promise<ProgramDto[]> {
  const rows = await db
    .select()
    .from(programs)
    .where(
      and(
        eq(programs.userId, userId),
        eq(programs.kind, "adaptive"),
        inArray(programs.status, [...adaptiveStatusSchema.options]),
      ),
    )
    .orderBy(asc(programs.createdAt), asc(programs.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const monday = startOfIsoWeek(today);
  const sunday = addDays(monday, 6);
  const thisWeek: Array<{ planId: string; completionState: string; contentState: string | null }> = [];
  const blocks: Array<typeof programBlocks.$inferSelect> = [];
  for (const batch of chunkIds(ids, PROGRAM_ID_CHUNK)) {
    thisWeek.push(
      ...(await db
        .select({
          planId: plannedWorkouts.planId,
          completionState: plannedWorkouts.completionState,
          contentState: plannedWorkouts.contentState,
        })
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            inArray(plannedWorkouts.planId, batch),
            eq(plannedWorkouts.origin, "program"),
            isNull(plannedWorkouts.archivedAt),
            gte(plannedWorkouts.effectiveDate, monday),
            lte(plannedWorkouts.effectiveDate, sunday),
          ),
        )),
    );
    blocks.push(...(await db.select().from(programBlocks).where(inArray(programBlocks.programId, batch))));
  }
  const latestBlock = new Map<string, typeof programBlocks.$inferSelect>();
  for (const b of blocks) {
    const seen = latestBlock.get(b.programId);
    if (!seen || b.number > seen.number) latestBlock.set(b.programId, b);
  }

  const out: ProgramDto[] = [];
  for (const r of rows) {
    const config = adaptiveConfigSchema.safeParse(r.config);
    if (!config.success) {
      // Never one bad row taking the whole list down; it is visible in the logs instead.
      console.error(`program ${r.id}: stored config does not parse`);
      continue;
    }
    const slots = thisWeek.filter((s) => s.planId === r.id);
    out.push({
      id: r.id,
      kind: "adaptive",
      name: r.name,
      status: r.status === "active" ? "active" : "retired",
      config: config.data,
      block: blockSummary(latestBlock.get(r.id), today),
      week: {
        placed: slots.length,
        done: slots.filter((s) => s.completionState === "completed" || s.contentState === "done").length,
        goal: config.data.weeklyGoal,
      },
    });
  }
  return out;
}

/** One program's DTO, or null when it is not this user's adaptive program. */
export async function loadProgram(db: Db, userId: string, id: string, today: string): Promise<ProgramDto | null> {
  return (await listPrograms(db, userId, today)).find((p) => p.id === id) ?? null;
}
