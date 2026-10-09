/**
 * THE GARDEN-HOLE DIAGNOSTIC (cron reliability, part 3): read-only, counts and dates only.
 *
 * Before the replay was put on record, an invocation killed inside `resimulateFrom` (the half-hourly sweep's, on the
 * free plan, Oct 3–7) could leave a late activity's credit out of the garden: its day's stored input without it, days
 * after the replay's checkpoint with no stored input at all, or every input right but `garden_state` never moved. This
 * finds each kind in a database — so the lead can look at prod — and names the day a replay must start from to heal
 * them. Fixed calendar throughout (nothing reads the real clock).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { advanceGarden, ensureGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { findGardenHoles } from "../src/services/garden-holes.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";

const GENESIS = "2026-04-06"; // A Monday: checkpoints on GENESIS, +7, +14, +21.
const NOW = new Date(`${addDays(GENESIS, 24)}T19:00:00Z`); // noon in Los Angeles; walks reach GENESIS+23
const LAST = addDays(GENESIS, 23);
const LATE_DAY = addDays(GENESIS, 17);
const HISTORY: Array<[number, string]> = [
  [1, "run"], [2, "strength"], [3, "run"], [4, "hike"], [5, "run"], [6, "yoga"], [8, "run"], [9, "strength"],
  [10, "run"], [12, "run"], [13, "yoga"], [15, "run"], [16, "strength"], [18, "bike"], [19, "run"], [22, "run"],
];

async function insertActivity(db: Db, userId: string, date: string, sport: string, localTime = "07:00"): Promise<string> {
  const id = newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    title: `Secret title ${id}`,
    startTime: `${date}T${localTime}:00Z`,
    startTimeLocal: `${date}T${localTime}:00`,
    sport,
    durationSeconds: 3600,
    distanceMeters: sport === "run" ? 8000 : null,
    trainingLoad: 60,
    sourceMergeConfidence: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

/** A garden grown through LAST from runs, lifts, yoga and two adventures (a hike, a ride). */
async function grown(): Promise<{ db: Db; userId: string; prefs: Awaited<ReturnType<typeof makeTestUser>>["prefs"] }> {
  const db = makeTestDb({ boundVariableCap: 100 });
  const { userId, prefs } = await makeTestUser(db);
  for (const [d, sport] of HISTORY) await insertActivity(db, userId, addDays(GENESIS, d), sport);
  await ensureGarden(db, userId, prefs, GENESIS);
  expect((await advanceGarden(db, userId, prefs, NOW)).lastSimulatedDate).toBe(LAST);
  return { db, userId, prefs };
}

const clean = {
  dayInputGaps: { count: 0, dates: [] },
  sessions: { missing: 0, dates: [] },
  adventures: { missing: 0, dates: [] },
  replayFrom: null,
};

describe("findGardenHoles", () => {
  it("a healthy garden: every session and adventure credited, no gaps, and the stored inputs fold to garden_state", async () => {
    const { db, userId } = await grown();
    const report = await findGardenHoles(db, userId, { fold: true });
    expect(report).toMatchObject({ simulated: { from: GENESIS, through: LAST, days: 24 }, replayPending: null, ...clean });
    expect(report.sessions.checked).toBe(14);
    expect(report.adventures.checked).toBe(2);
    expect(report.fold).toEqual({ checked: true, matchesState: true, firstMismatchCheckpoint: null, stoppedAtGap: null });
  });

  it("no garden: nothing to check", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    expect(await findGardenHoles(db, userId, { fold: true })).toMatchObject({ simulated: null, ...clean });
  });

  it("an activity that landed on a simulated day and was never replayed: its credit is missing", async () => {
    const { db, userId } = await grown();
    await insertActivity(db, userId, LATE_DAY, "strength", "18:00");
    await insertActivity(db, userId, addDays(GENESIS, 20), "bike", "10:00");
    const report = await findGardenHoles(db, userId, { fold: true });
    expect(report.sessions).toMatchObject({ missing: 1, dates: [LATE_DAY] });
    expect(report.adventures).toMatchObject({ missing: 1, dates: [addDays(GENESIS, 20)] });
    expect(report.dayInputGaps.count).toBe(0);
    expect(report.fold!.matchesState).toBe(true); // consistent with its inputs — they just lack the credit
    expect(report.replayFrom).toBe(LATE_DAY);
    // Counts and dates only: no titles, no ids.
    expect(JSON.stringify(report)).not.toMatch(/Secret title|[0-9a-f]{8}-[0-9a-f]{4}-/);

    // Healed by a replay from the day it names.
    await resimulateFrom(db, userId, report.replayFrom!, (await makeTestUserPrefs(db, userId)), NOW);
    expect(await findGardenHoles(db, userId, { fold: true })).toMatchObject(clean);
  });

  it("what the old replay left when killed part-way: days with no stored input, the credit out of garden_state", async () => {
    const { db: base, userId, prefs } = await grown();
    await insertActivity(base, userId, LATE_DAY, "run", "18:00");
    // The pre-fix replay: purge after the checkpoint, walk a few days, killed before it persisted; no record.
    let writes = 0;
    let armed = true;
    const db = cloneTestDb(base, {
      boundVariableCap: 100,
      onStatement: (sql) => {
        if (armed && isWrite(sql) && !/"account_state"/.test(sql) && ++writes === 12) throw new Error("Exceeded CPU time limit");
      },
    });
    await expect(resimulateFrom(db, userId, LATE_DAY, prefs, NOW)).rejects.toThrow();
    armed = false;
    await db.update(schema.accountState).set({ gardenChangedFrom: null }).where(eq(schema.accountState.userId, userId));

    const report = await findGardenHoles(db, userId, { fold: true });
    expect(report.dayInputGaps.count).toBeGreaterThan(0);
    expect(report.dayInputGaps.dates[0]! > LATE_DAY).toBe(true);
    expect(report.fold!.matchesState).toBe(false);
    expect(report.fold!.stoppedAtGap).toBe(report.dayInputGaps.dates[0]);
    expect(report.replayFrom! <= LATE_DAY).toBe(true);

    await resimulateFrom(db, userId, report.replayFrom!, prefs, NOW);
    expect(await findGardenHoles(db, userId, { fold: true })).toMatchObject({ ...clean, fold: { matchesState: true } });
  });

  it("killed as it persisted: every input credited, garden_state never moved — only the fold sees it", async () => {
    const { db: base, userId, prefs } = await grown();
    await insertActivity(base, userId, LATE_DAY, "strength", "18:00");
    let armed = true;
    const db = cloneTestDb(base, {
      boundVariableCap: 100,
      onStatement: (sql) => {
        if (armed && /^update "garden_state"/.test(sql)) throw new Error("Exceeded CPU time limit");
      },
    });
    await expect(resimulateFrom(db, userId, LATE_DAY, prefs, NOW)).rejects.toThrow();
    armed = false;
    await db.update(schema.accountState).set({ gardenChangedFrom: null }).where(eq(schema.accountState.userId, userId));

    const quick = await findGardenHoles(db, userId);
    expect(quick).toMatchObject(clean); // the per-day checks cannot see it…
    expect(quick.fold).toBeUndefined();
    const report = await findGardenHoles(db, userId, { fold: true });
    expect(report.fold).toMatchObject({ checked: true, matchesState: false, stoppedAtGap: null });
    // …the fold names the day after the last checkpoint it agrees with: a replay from there heals it.
    expect(report.replayFrom).toBe(addDays(GENESIS, 22));
    await resimulateFrom(db, userId, report.replayFrom!, prefs, NOW);
    expect(await findGardenHoles(db, userId, { fold: true })).toMatchObject({ ...clean, fold: { matchesState: true } });
  });

  it("on a realistic account (months of plan, matches, lifts, yoga, health): clean, and what the report costs", { timeout: 60_000 }, async () => {
    let statements = 0;
    const db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (statements += 1) });
    const acct = await seedRealisticAccount(db);
    statements = 0;
    const cpu = process.cpuUsage();
    const quick = await findGardenHoles(db, acct.userId);
    const quickMs = process.cpuUsage(cpu);
    const quickStatements = statements;
    const cpu2 = process.cpuUsage();
    const full = await findGardenHoles(db, acct.userId, { fold: true });
    const fullMs = process.cpuUsage(cpu2);
    console.log(
      `garden-holes on a realistic account (${full.simulated!.days} simulated days, ${full.sessions.checked} sessions, ` +
        `${full.adventures.checked} adventures): ${((quickMs.user + quickMs.system) / 1000).toFixed(1)} ms CPU and ` +
        `${quickStatements} statements without the fold; ${((fullMs.user + fullMs.system) / 1000).toFixed(1)} ms with it (node)`,
    );
    expect(quickStatements).toBeLessThanOrEqual(6);
    expect(full).toMatchObject({ ...clean, fold: { checked: true, matchesState: true, firstMismatchCheckpoint: null, stoppedAtGap: null } });
    expect(full.sessions.checked).toBeGreaterThan(50);
  });

  it("a replay on record shows as pending", async () => {
    const { db, userId } = await grown();
    await db.insert(schema.accountState).values({ userId, gardenChangedFrom: LATE_DAY, gardenChangedSeq: 1, updatedAt: nowInstant() });
    expect((await findGardenHoles(db, userId)).replayPending).toBe(LATE_DAY);
  });

  it("GET /api/settings/diagnostics/garden answers the signed-in account's report", async () => {
    const { db, userId } = await grown();
    await insertActivity(db, userId, LATE_DAY, "strength", "18:00");
    const token = await createSession(db, userId, "test");
    const app = mountRoutes(db, "/api/settings", settingsRoutes);
    const res = await app.request("/api/settings/diagnostics/garden?fold=1", { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, {
      APP_URL: "https://app.test",
      SESSION_SECRET: "test-session-secret",
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof findGardenHoles>>;
    expect(body.sessions).toMatchObject({ missing: 1, dates: [LATE_DAY] });
    expect(body.fold!.checked).toBe(true);
    expect(body.replayFrom).toBe(LATE_DAY);
  });
});

async function makeTestUserPrefs(db: Db, userId: string) {
  const { loadPreferences } = await import("../src/services/calendar-sync.js");
  return loadPreferences(db, userId);
}
