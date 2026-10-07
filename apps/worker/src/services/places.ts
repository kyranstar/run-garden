/**
 * PLACES AND THEIR GEAR (Phase 2 spec §2c "Settings sections"; plan Task 2, Review Focus 3).
 *
 * A place is a name, the gear there (ids from the library's vocabulary) and, for gear that takes weights, the
 * weights as the athlete typed them ("10, 15, 20 lb, 12kg") — stored exactly as typed, checked by
 * `weightListProblem`, and read by the build through `parseWeightList` (each weight in its own unit). A list for gear
 * the place does not have is not kept, and an empty one is no list.
 *
 * One place is the default: the first one made, or the one last marked; deleting it promotes the oldest other.
 * A place an active program builds at (`config.defaultLocationId`) cannot be deleted. Every write is refused while a
 * restore is replacing the account (ruling B2), and each one that touches two rows lands as one transaction.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { locations, programs } from "@rg/database";
import { formatWeight, newId, weightListProblem, type Weight } from "@rg/domain";
import { EQUIPMENT_IDS, LOAD_IMPLEMENTS } from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import { runAtomically, type AtomicStatement, type Db } from "./db.js";
import { RestoreInProgressError } from "./programs.js";

export interface PlaceView {
  id: string;
  name: string;
  equipment: string[];
  /** Weights per weighted gear id, exactly as typed. */
  implements: Record<string, string>;
  isDefault: boolean;
}

export class PlaceNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

export class PlaceInUseError extends Error {
  constructor(public readonly program: { id: string; name: string }) {
    super("place_in_use");
  }
}

const uniqueIds = (xs: readonly string[]) => new Set(xs).size === xs.length;

const implementsSchema = z
  .record(z.enum(LOAD_IMPLEMENTS), z.string().max(200))
  .superRefine((lists, ctx) => {
    for (const [key, text] of Object.entries(lists)) {
      if (text === undefined || text.trim() === "") continue;
      const problem = weightListProblem(text);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `not a weight: ${problem}` });
    }
  });

const nameSchema = z.string().trim().min(1).max(60);
const equipmentSchema = z.array(z.enum(EQUIPMENT_IDS)).max(EQUIPMENT_IDS.length).refine(uniqueIds, { message: "gear listed twice" });

export const placeCreateSchema = z
  .object({
    name: nameSchema,
    equipment: equipmentSchema,
    implements: implementsSchema.optional(),
    /** Only `true`: a place stops being the default when another becomes it. */
    isDefault: z.literal(true).optional(),
  })
  .strict();
export type PlaceCreate = z.input<typeof placeCreateSchema>;

export const placePatchSchema = z
  .object({
    name: nameSchema.optional(),
    equipment: equipmentSchema.optional(),
    /** Replaces the place's lists whole. */
    implements: implementsSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to change" });
export type PlacePatch = z.input<typeof placePatchSchema>;

/** The lists worth keeping: for gear the place has, typed text with something in it, trimmed. */
function keptLists(lists: Record<string, string | undefined> | undefined, equipment: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(lists ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof text !== "string" || text.trim() === "" || !equipment.includes(key)) continue;
    out[key] = text.trim();
  }
  return out;
}

/** A stored list as text: typed text as it is; weights an older writer stored parsed, written out. */
function asTyped(stored: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) {
      const weights = value.filter((w): w is Weight => typeof w === "object" && w !== null && typeof (w as Weight).v === "number");
      if (weights.length) out[key] = weights.map(formatWeight).join(", ");
    }
  }
  return out;
}

type Row = typeof locations.$inferSelect;
const view = (r: Row): PlaceView => ({
  id: r.id,
  name: r.name,
  equipment: [...r.equipment],
  implements: asTyped(r.implements),
  isDefault: r.isDefault,
});

/** The account's places, the default first, then oldest first. */
export async function listPlaces(db: Db, userId: string): Promise<PlaceView[]> {
  const rows = await db
    .select()
    .from(locations)
    .where(eq(locations.userId, userId))
    .orderBy(desc(locations.isDefault), asc(locations.createdAt), asc(locations.id));
  return rows.map(view);
}

async function ownRow(db: Db, userId: string, id: string): Promise<Row> {
  const [row] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.userId, userId))).limit(1);
  if (!row) throw new PlaceNotFoundError();
  return row;
}

async function refuseWhileRestoring(db: Db, userId: string): Promise<void> {
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
}

const clearOtherDefaults = (db: Db, userId: string, keep: string, now: string): AtomicStatement =>
  db
    .update(locations)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(locations.userId, userId), ne(locations.id, keep), eq(locations.isDefault, true)));

export async function createPlace(db: Db, userId: string, input: PlaceCreate, now: string): Promise<string> {
  const p = placeCreateSchema.parse(input);
  await refuseWhileRestoring(db, userId);
  const [any] = await db.select({ id: locations.id }).from(locations).where(eq(locations.userId, userId)).limit(1);
  const isDefault = p.isDefault === true || !any;
  const id = newId();
  const statements: AtomicStatement[] = [
    db.insert(locations).values({
      id,
      userId,
      name: p.name,
      equipment: [...p.equipment],
      implements: keptLists(p.implements, p.equipment),
      isDefault,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  if (isDefault && any) statements.push(clearOtherDefaults(db, userId, id, now));
  await runAtomically(db, statements);
  return id;
}

export async function updatePlace(db: Db, userId: string, id: string, input: PlacePatch, now: string): Promise<void> {
  const p = placePatchSchema.parse(input);
  await refuseWhileRestoring(db, userId);
  const row = await ownRow(db, userId, id);
  const equipment = p.equipment ?? row.equipment;
  const lists = p.implements ?? asTyped(row.implements);
  const statements: AtomicStatement[] = [
    db
      .update(locations)
      .set({
        name: p.name ?? row.name,
        equipment: [...equipment],
        implements: keptLists(lists, equipment),
        ...(p.isDefault ? { isDefault: true } : {}),
        updatedAt: now,
      })
      .where(and(eq(locations.id, id), eq(locations.userId, userId))),
  ];
  if (p.isDefault) statements.push(clearOtherDefaults(db, userId, id, now));
  await runAtomically(db, statements);
}

/** The first active program of the account that builds at this place, if any. */
async function programAt(db: Db, userId: string, placeId: string): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: programs.id, name: programs.name, config: programs.config })
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.status, "active")))
    .orderBy(asc(programs.createdAt), asc(programs.id));
  const hit = rows.find((r) => (r.config as { defaultLocationId?: unknown } | null)?.defaultLocationId === placeId);
  return hit ? { id: hit.id, name: hit.name } : null;
}

export async function deletePlace(db: Db, userId: string, id: string): Promise<void> {
  await refuseWhileRestoring(db, userId);
  const row = await ownRow(db, userId, id);
  const program = await programAt(db, userId, id);
  if (program) throw new PlaceInUseError(program);
  const statements: AtomicStatement[] = [db.delete(locations).where(and(eq(locations.id, id), eq(locations.userId, userId)))];
  if (row.isDefault) {
    const [next] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.userId, userId), ne(locations.id, id)))
      .orderBy(asc(locations.createdAt), asc(locations.id))
      .limit(1);
    if (next) statements.push(db.update(locations).set({ isDefault: true }).where(eq(locations.id, next.id)));
  }
  await runAtomically(db, statements);
}
