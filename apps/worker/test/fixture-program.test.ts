/**
 * The fixture stack's synthetic program (Phase 2a Tasks 6–8 screenshot matrix): one adaptive program with a
 * cared-for condition switched on, two places, and its slots placed from today — re-seeding starts it over.
 * `today`/`now` are passed in, so the fixed dates here never go stale.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { seedFixtureProgram } from "../src/services/fixtures.js";
import { slotId } from "../src/services/program-slots.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { programs, plannedWorkouts, userConditions, locations, sessionBuilds, conditionChecks } = schema;

/** A Monday. */
const MON = "2026-10-05";
const NOW = "2026-10-05T09:00:00.000Z";

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
});

const live = async (programId: string) =>
  (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, programId))).filter((r) => r.archivedAt === null);

describe("seedFixtureProgram", () => {
  it("creates one active adaptive program caring for a switched-on condition, with a slot today and another this week", async () => {
    const id = await seedFixtureProgram(db, userId, MON, prefs, NOW);
    const all = await db.select().from(programs).where(eq(programs.userId, userId));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, kind: "adaptive", status: "active" });
    expect((all[0]!.config as { careProfiles: string[] }).careProfiles).toEqual(["tmj"]);
    expect(await db.select().from(userConditions).where(eq(userConditions.userId, userId))).toEqual([
      expect.objectContaining({ profileId: "tmj", active: true }),
    ]);
    const ids = (await live(id)).map((r) => r.id);
    expect(ids).toContain(slotId(id, MON));
    expect(ids).toContain(slotId(id, addDays(MON, 2)));
    for (const r of await live(id)) {
      expect(r).toMatchObject({ origin: "program", contentState: "outline", lastVerifiedCorosDate: "", corosSyncState: "calendar_only" });
    }
  });

  it("gives the account two places, one of them the default", async () => {
    await seedFixtureProgram(db, userId, MON, prefs, NOW);
    const places = await db.select().from(locations).where(eq(locations.userId, userId));
    expect(places.map((p) => p.name).sort()).toEqual(["Gym", "Home"]);
    expect(places.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it("re-seeding starts the program over: one program, fresh outline slots, no builds or checks left behind", async () => {
    const first = await seedFixtureProgram(db, userId, MON, prefs, NOW);
    await db.update(plannedWorkouts).set({ contentState: "built" }).where(eq(plannedWorkouts.id, slotId(first, MON)));
    await db.insert(sessionBuilds).values({
      id: "b1", userId, workoutId: slotId(first, MON), version: 1, engineVersion: "e", inputsHash: "h",
      payload: {}, lockedAt: null, createdAt: NOW,
    });
    await db.insert(conditionChecks).values({
      id: "c1", userId, profileId: "tmj", kind: "daily", value: 2, feelingOff: false, localDate: MON, at: NOW,
      performedSessionId: null, workoutId: null,
    });
    const second = await seedFixtureProgram(db, userId, MON, prefs, NOW);
    expect(await db.select().from(programs).where(eq(programs.userId, userId))).toHaveLength(1);
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, first))).toHaveLength(0);
    expect((await live(second)).every((r) => r.contentState === "outline")).toBe(true);
    expect(await db.select().from(sessionBuilds).where(eq(sessionBuilds.userId, userId))).toHaveLength(0);
    expect(await db.select().from(conditionChecks).where(and(eq(conditionChecks.userId, userId)))).toHaveLength(0);
    expect(await db.select().from(locations).where(eq(locations.userId, userId))).toHaveLength(2);
    expect(await db.select().from(userConditions).where(eq(userConditions.userId, userId))).toHaveLength(1);
  });
});
