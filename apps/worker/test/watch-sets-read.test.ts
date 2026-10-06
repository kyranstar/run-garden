/**
 * Watch sets arrive through the real read paths (Phase 2a+ Task 2): the
 * cloud read-now pulls a new strength activity's detail and logs its sets;
 * the deep backfill's chunk does the same for history. Read-only on COROS:
 * the only calls are the list and detail reads the paths already made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import type { RawCorosActivityListItem } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { recordChunk } from "../src/services/backfill.js";
import { buildActivityBackfill, CorosClient } from "@rg/coros";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { detailOf, makeEnv, workView } from "./watch-sets-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Server = ReturnType<typeof mockCorosServer>;

async function connect(db: Db, userId: string, server: Server): Promise<void> {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
}

const corosDay = (iso: string): number => Number(iso.replaceAll("-", ""));

/** A strength activity and a run on the given day; both details carry the same lap items. */
function seedLift(server: Server, day: string, labelId = "lbl-lift-41") {
  const start = Math.floor(Date.parse(`${day}T13:00:00Z`) / 1000);
  const items: RawCorosActivityListItem[] = [
    { labelId, date: corosDay(day), name: "Synthetic Upper", sportType: 402, startTime: start, totalTime: 2400, workoutTime: 2400 },
    { labelId: `${labelId}-run`, date: corosDay(day), name: "Synthetic Easy", sportType: 100, startTime: start + 9_000, totalTime: 1800 },
  ];
  server.state.activities = [...server.state.activities, ...items];
  const detail = detailOf(workView());
  server.state.details = {
    ...server.state.details,
    [labelId]: { ...detail, summary: { name: "Synthetic Upper", workoutTime: 240_000, totalTime: 260_000, avgHr: 101 } },
    [`${labelId}-run`]: { ...detail, summary: { name: "Synthetic Easy", workoutTime: 180_000, totalTime: 180_000, avgHr: 140 } },
  };
}

const watchSessions = (db: Db, userId: string) =>
  db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, userId));

describe("watch sets through the read paths", () => {
  it("the cloud read-now logs a new strength activity's sets, and nothing for the run", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    vi.stubGlobal("fetch", server.fetchImpl);
    await connect(db, userId, server);
    seedLift(server, addDays(todayInZone(prefs.timezone), -2));

    const res = await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: server.fetchImpl });
    expect(res.status).toBe("ok");
    const sessions = await watchSessions(db, userId);
    expect(sessions.map((s) => [s.source, s.sourceRef])).toEqual([["watch", "lbl-lift-41"]]);
    const sets = await db.select().from(schema.performedSets);
    expect(sets).toHaveLength(6);
  });

  it("the deep backfill's chunk logs history's sets", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    const day = addDays(todayInZone(prefs.timezone), -40);
    seedLift(server, day, "lbl-old-lift");
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const chunk = await buildActivityBackfill(client, addDays(day, -5), addDays(day, 5), undefined, { delayMs: 0 });

    await recordChunk(db, userId, {
      chunkStart: addDays(day, -5),
      chunkEnd: addDays(day, 5),
      activities: chunk.activities,
      lapsByProviderId: chunk.lapsByProviderId as never,
      strengthDetailsByProviderId: chunk.strengthDetailsByProviderId,
      skippedSportTypes: chunk.skippedSportTypes,
    });
    expect((await watchSessions(db, userId)).map((s) => s.sourceRef)).toEqual(["lbl-old-lift"]);
  });
});
