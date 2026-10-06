/**
 * The restore race on slot ids (audit 2a-model M5, the B9 class). Slot ids are derived from the program and the
 * date, and `planned_workouts` restores insert-or-ignore: a placement pass that passed its restore-marker check
 * just before `begin` fired would insert fresh outlines under the very ids the file's rows (moved, completed,
 * started) arrive with — the file's row lost, the restore reported short.
 *
 * So placement looks at the marker again right before it writes. Here the marker appears the moment the pass's
 * first check has passed, exactly as a `begin` landing between the check and the writes would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const race = vi.hoisted(() => ({ begin: null as null | (() => Promise<void>) }));
vi.mock("../src/services/account-state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/account-state.js")>();
  return {
    ...real,
    restoreInProgress: vi.fn(async (db: Db, userId: string) => {
      const marked = await real.restoreInProgress(db, userId);
      // `begin` lands right after this check said "no restore".
      if (!marked && race.begin) {
        const begin = race.begin;
        race.begin = null;
        await begin();
      }
      return marked;
    }),
  };
});

import { placeSlots, slotId } from "../src/services/program-slots.js";

const { plannedWorkouts, programs, accountState, calendarEventSuppressions } = schema;
const MON = "2026-10-05";
const NOW = "2026-10-05T12:00:00.000Z";

let db: Db;
let writes: string[];
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  writes = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => isWrite(s) && writes.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  race.begin = null;
});

async function seedProgram(weeklyGoal: number): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ weeklyGoal, preferredDays: [0, 2, 4, 5], placementWeeksAhead: 1 }),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  return id;
}

const beginRestore = async () => {
  await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
};

describe("a restore beginning mid-pass", () => {
  it("stops placement before it inserts a slot", async () => {
    const p = await seedProgram(4);
    writes.length = 0;
    race.begin = beginRestore;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).toEqual([]);
    expect(writes.filter((s) => !/account_state/.test(s))).toEqual([]);
  });

  it("stops placement before it retracts a slot", async () => {
    const p = await seedProgram(4);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 3, preferredDays: [0, 2, 4, 5], placementWeeksAhead: 1 }) }).where(eq(programs.id, p));
    const before = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p));
    writes.length = 0;
    race.begin = beginRestore;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).toEqual(before);
    expect(await db.select().from(calendarEventSuppressions)).toEqual([]);
    expect(writes.filter((s) => !/account_state/.test(s))).toEqual([]);
  });

  it("stops placement before it revives or refreshes a slot", async () => {
    const p = await seedProgram(4);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    // Lower the goal (Saturdays retracted), then raise it and rename: the next pass would revive the Saturdays and
    // refresh every slot's name — with the marker landing after its first check, none of it may be written.
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 3, preferredDays: [0, 2, 4, 5], placementWeeksAhead: 1 }) }).where(eq(programs.id, p));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const sat = slotId(p, "2026-10-17");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, sat)))[0]).toMatchObject({ archiveReason: "program_replaced" });
    await db
      .update(programs)
      .set({ name: "Jaw care", config: adaptiveConfigSchema.parse({ weeklyGoal: 4, preferredDays: [0, 2, 4, 5], placementWeeksAhead: 1 }) })
      .where(eq(programs.id, p));
    const before = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p));
    const suppressions = await db.select().from(calendarEventSuppressions);
    writes.length = 0;
    race.begin = beginRestore;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).toEqual(before);
    expect(await db.select().from(calendarEventSuppressions)).toEqual(suppressions);
    expect(writes.filter((s) => !/account_state/.test(s))).toEqual([]);
  });
});
