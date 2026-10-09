/**
 * A READ KILLED BETWEEN ITS INGEST AND ITS REPLAY STILL CREDITS THE NEW ACTIVITIES (cron reliability, part 3).
 *
 * The read ingests new activities, then replays the garden from the earliest day they touched. An invocation killed
 * between the two left the activities stored — and seen, so no later read touches them again — with nothing on record
 * to replay: their days were already simulated, so they were never credited. The read now puts the new activities'
 * earliest day on record before it ingests them; the next walk (the hourly's garden step, a garden read) replays it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";

const kill = vi.hoisted(() => ({ resim: false }));
vi.mock("../src/services/garden-sync.js", async (orig) => {
  const real = await orig<typeof import("../src/services/garden-sync.js")>();
  return {
    ...real,
    resimulateFrom: async (...args: Parameters<typeof real.resimulateFrom>) => {
      // Killed where the replay would begin: the platform's error, before any of the replay's own writes.
      if (kill.resim) throw new Error("Exceeded CPU time limit (simulated kill)");
      return real.resimulateFrom(...args);
    },
  };
});

import { advanceGarden, loadGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { makeTestDb } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";
import { gardenTimeline, replayMarker } from "./garden-compare.js";

afterEach(() => {
  vi.unstubAllGlobals();
  kill.resim = false;
});

describe("the cloud read records the new activities' day before it ingests them", () => {
  it("killed after the ingest, before the replay: the next walk credits the new activities", { timeout: 60_000 }, async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    // The mock's activities land on last week's Tuesday — a day the garden has already simulated.
    const lastMonday = addDays(startOfIsoWeek(todayInZone("America/Los_Angeles")), -7);
    const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: lastMonday });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const tuesday = addDays(lastMonday, 1);
    expect((await loadGarden(db, acct.userId))!.state.lastSimulatedDate > tuesday).toBe(true);

    kill.resim = true;
    const read = await corosReadNow(db, acct.env, acct.userId, acct.prefs, { force: true });
    kill.resim = false;
    expect(read.runtimeLimited).toBe(true);
    const tuesdays = (await db.select().from(schema.activities).where(eq(schema.activities.userId, acct.userId))).filter(
      (a) => (a.startTimeLocal ?? a.startTime).slice(0, 10) === tuesday,
    );
    // Stored by the killed read: sessions the garden credits by id, and an adventure it credits by sport.
    const tuesdayIds = tuesdays.filter((a) => ["run", "strength", "yoga"].includes(a.sport)).map((a) => a.id);
    const adventures = tuesdays.filter((a) => !["run", "strength", "yoga"].includes(a.sport)).map((a) => a.sport);
    expect(tuesdayIds.length).toBeGreaterThan(0);
    expect(adventures.length).toBeGreaterThan(0);
    expect(await replayMarker(db, acct.userId)).toBe(tuesday);

    // The next walk: the hourly's garden step, a few days a run, until nothing is left.
    for (let i = 0; i < 6; i++) {
      const r = await advanceGarden(db, acct.userId, acct.prefs, new Date(), { maxWalkDays: 3, maxResimDays: 3 });
      if (r.simulatedDays === 0 && !r.resimPending) break;
    }
    expect(await replayMarker(db, acct.userId)).toBeNull();
    const landed = await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true });
    const input = landed.inputs.find((i) => i.date === tuesday)!.input as {
      completedRuns: Array<{ activityId?: string }>;
      adventures?: Array<{ sport: string }>;
    };
    expect(input.completedRuns.map((r) => r.activityId)).toEqual(expect.arrayContaining(tuesdayIds));
    expect((input.adventures ?? []).map((a) => a.sport)).toEqual(expect.arrayContaining(adventures));
    // And the garden is the one an uninterrupted replay makes: replaying again changes nothing.
    await resimulateFrom(db, acct.userId, tuesday, acct.prefs);
    expect(await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true })).toEqual(landed);
  });
});
