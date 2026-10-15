/**
 * WHERE A WORKOUT HAPPENS, AS ITS GEAR IS JUDGED — one rule for the worker's readers (Stage 3 Task 5, fix round 1):
 * the coach's validate_workout and propose_workout (design-tools/act-common.ts), search_library's place filter
 * (design-tools/read-library.ts), the Studio's library (library-view.ts), a workout document's save
 * (`docDayContext`) and its build (`loadDocEngineContext`), and the engine's place (`loadEngineContext`).
 *
 *  - THE DEFAULT PLACE: the profile's chosen default (`athlete_profiles.preferences.defaultPlaceId`, while it is still
 *    one of the athlete's places), else the place marked default, else the first made; with no place at all, the
 *    library's Home preset.
 *  - A NAMED PLACE: one of the athlete's places; else a preset (home, gym, mat); else "No equipment"
 *    (`NO_EQUIPMENT_PLACE`): a bare room's own props. Any other id is no place.
 *
 * Each read is one scalar subquery (`defaultPlaceSql`, `ownPlaceSql`), so a caller folds it into a statement it already
 * runs; `defaultPlace` / `namedPlace` are the one-statement forms.
 */
import { sql, type SQL } from "drizzle-orm";
import { athleteProfiles, locations } from "@rg/database";
import { NO_EQUIPMENT_PLACE } from "@rg/domain";
import { LOCATION_PRESETS, NO_EQUIPMENT_GEAR, noEquipmentPlace } from "@rg/exercise-library";
import type { Db } from "./db.js";

export interface PlaceGear {
  id: string;
  name: string;
  equipment: string[];
  /** One of the athlete's places, a library preset, or "No equipment". */
  kind: "own" | "preset" | "none";
}

const l = locations;
const asJson = sql`json_object('id', ${l.id}, 'name', ${l.name}, 'equipment', case when json_valid(${l.equipment}) then json(${l.equipment}) else json('[]') end)`;

/**
 * The athlete's places in the default place's order — the first is the default: the profile's chosen default, the
 * place marked default, the first made. The engine's place read orders by it too (`loadEngineContext`).
 */
export function defaultPlaceOrder(userId: string): SQL[] {
  const p = athleteProfiles;
  const chosen = sql`(select case when json_valid(${p.preferences}) then json_extract(${p.preferences}, '$.defaultPlaceId') end from ${p} where ${p.userId} = ${userId})`;
  return [sql`(${l.id} = coalesce(${chosen}, '')) desc`, sql`${l.isDefault} desc`, sql`${l.createdAt} asc`, sql`${l.id} asc`];
}

/** The athlete's default place among their own, as one row of JSON text ({ id, name, equipment }), or null. */
export function defaultPlaceSql(userId: string): SQL {
  return sql`(select ${asJson} from ${l} where ${l.userId} = ${userId} order by ${sql.join(defaultPlaceOrder(userId), sql`, `)} limit 1)`;
}

/** One of the athlete's places by id, as one row of JSON text, or null. */
export function ownPlaceSql(userId: string, id: string): SQL {
  return sql`(select ${asJson} from ${l} where ${l.userId} = ${userId} and ${l.id} = ${id})`;
}

function ownFrom(row: unknown): PlaceGear | null {
  let v: unknown = row;
  if (typeof row === "string") {
    try {
      v = JSON.parse(row);
    } catch {
      return null;
    }
  }
  const o = v as { id?: unknown; name?: unknown; equipment?: unknown } | null;
  if (!o || typeof o.id !== "string") return null;
  const equipment = Array.isArray(o.equipment) ? o.equipment.filter((g): g is string => typeof g === "string") : [];
  return { id: o.id, name: typeof o.name === "string" ? o.name : o.id, equipment, kind: "own" };
}

const presetOf = (id: string): PlaceGear | null => {
  const p = LOCATION_PRESETS.find((x) => x.id === id);
  return p ? { id: p.id, name: p.name, equipment: [...p.equipment], kind: "preset" } : null;
};

/** "No equipment": bodyweight plus a bare room's own props, wherever it is done (the library's `noEquipmentPlace`). */
export const NO_EQUIPMENT: PlaceGear = Object.freeze({ ...noEquipmentPlace(), equipment: [...NO_EQUIPMENT_GEAR], kind: "none" }) as PlaceGear;

/** The default place from `defaultPlaceSql`'s row: that place, or (no place at all) the Home preset. */
export function defaultFromRow(row: unknown): PlaceGear {
  return ownFrom(row) ?? presetOf("home")!;
}

/** A named place from `ownPlaceSql`'s row: the athlete's own, else a preset, else "No equipment"; null for no place. */
export function namedFromRow(id: string, row: unknown): PlaceGear | null {
  const own = ownFrom(row);
  if (own) return own;
  if (id === NO_EQUIPMENT_PLACE) return { ...NO_EQUIPMENT, equipment: [...NO_EQUIPMENT.equipment] };
  return presetOf(id);
}

/** The athlete's default place. One statement. */
export async function defaultPlace(db: Db, userId: string): Promise<PlaceGear> {
  const [row] = (await db.all(sql`select ${defaultPlaceSql(userId)} as place`)) as Array<{ place: unknown }>;
  return defaultFromRow(row?.place ?? null);
}

/**
 * A workout document's place, as its save (`docDayContext`) and its build (`loadDocEngineContext`) read it: the place
 * it names, else — none named, or one deleted since — the default. One statement; two for an id that is no place.
 */
export async function placeOrDefault(db: Db, userId: string, id: string | undefined): Promise<PlaceGear> {
  return (id ? await namedPlace(db, userId, id) : null) ?? defaultPlace(db, userId);
}

/** A named place (see the module comment), or null when the id is none. One statement. */
export async function namedPlace(db: Db, userId: string, id: string): Promise<PlaceGear | null> {
  const [row] = (await db.all(sql`select ${ownPlaceSql(userId, id)} as place`)) as Array<{ place: unknown }>;
  return namedFromRow(id, row?.place ?? null);
}
