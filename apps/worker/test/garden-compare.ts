/**
 * Everything the garden keeps for one account, minus the wall-clock stamps a walk writes (`updatedAt`, `createdAt`)
 * and the random ids of unlock rows — for "this path lands exactly where that one does" (cron reliability, part 3).
 */
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { isoWeekday } from "@rg/domain";
import type { Db } from "../src/services/db.js";

export async function gardenTimeline(db: Db, userId: string, opts: { mondayCheckpointsOnly?: boolean } = {}) {
  const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
  const inputs = await db
    .select({ date: schema.gardenDayInputs.date, input: schema.gardenDayInputs.input })
    .from(schema.gardenDayInputs)
    .where(eq(schema.gardenDayInputs.userId, userId))
    .orderBy(asc(schema.gardenDayInputs.date));
  const events = (
    await db.select().from(schema.gardenEvents).where(eq(schema.gardenEvents.userId, userId)).orderBy(asc(schema.gardenEvents.id))
  ).map(({ createdAt: _c, ...e }) => e);
  const checkpoints = (
    await db
      .select({ date: schema.gardenSnapshots.date, snapshot: schema.gardenSnapshots.snapshot, version: schema.gardenSnapshots.simulationVersion })
      .from(schema.gardenSnapshots)
      .where(eq(schema.gardenSnapshots.userId, userId))
      .orderBy(asc(schema.gardenSnapshots.date))
  ).filter((c) => !opts.mondayCheckpointsOnly || isoWeekday(c.date) === 1);
  const plants = await db
    .select()
    .from(schema.gardenPlants)
    .where(eq(schema.gardenPlants.userId, userId))
    .orderBy(asc(schema.gardenPlants.id));
  const unlocks = (
    await db
      .select({ speciesId: schema.gardenUnlocks.speciesId, unlockedOn: schema.gardenUnlocks.unlockedOn })
      .from(schema.gardenUnlocks)
      .where(eq(schema.gardenUnlocks.userId, userId))
  ).sort((a, b) => a.speciesId.localeCompare(b.speciesId));
  const wildlife = (
    await db
      .select({ kind: schema.gardenWildlife.kind, present: schema.gardenWildlife.present, since: schema.gardenWildlife.since })
      .from(schema.gardenWildlife)
      .where(eq(schema.gardenWildlife.userId, userId))
  ).sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    state: state
      ? { snapshot: state.snapshot, lastSimulatedDate: state.lastSimulatedDate, simulationVersion: state.simulationVersion }
      : null,
    inputs,
    events,
    checkpoints,
    plants,
    unlocks,
    wildlife,
  };
}

/** The account's durable "replay from" record (`account_state.garden_changed_from`), or null. */
export async function replayMarker(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.select().from(schema.accountState).where(eq(schema.accountState.userId, userId));
  return row?.gardenChangedFrom ?? null;
}
