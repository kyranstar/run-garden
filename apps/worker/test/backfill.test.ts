import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import {
  CHUNK_DAYS,
  enqueueBackfill,
  firstChunk,
  nextBackfillAction,
  runBackfillChunkCloud,
} from "../src/services/backfill.js";
import { connectCoros } from "../src/services/coros-connection.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("firstChunk", () => {
  it("starts just behind the rolling snapshot window, not at today", () => {
    // The rolling snapshot already owns the last 14 days; backfill must not
    // redo that work.
    const { chunkStart, chunkEnd } = firstChunk("2026-08-04", 14);
    expect(chunkEnd).toBe("2026-07-21");
    // 90 days INCLUSIVE of chunkEnd — the same span nextBackfillAction uses.
    expect(chunkStart).toBe("2026-04-23");
  });
});

describe("nextBackfillAction", () => {
  const floor = "2021-08-04";

  it("continues into the next older chunk when a chunk had activities", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 0 },
      { activitiesFound: 12 },
      floor,
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2026-01-23",
      chunkEnd: "2026-04-22",
    });
  });

  it("keeps going after ONE empty chunk — a single gap is just a break from training", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 0 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops after two consecutive empty chunks", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 1 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action).toEqual({ kind: "done", reason: "empty_run" });
  });

  it("resets the empty run when a later chunk finds activities again", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-23", consecutiveEmptyChunks: 1 },
      { activitiesFound: 3 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops at the floor rather than walking back forever", () => {
    // Already standing on the floor: the next chunk would end at 2021-08-03,
    // below it, so there is nothing left to ask for.
    const action = nextBackfillAction(
      { earliestDateReached: "2021-08-04", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({ kind: "done", reason: "floor_reached" });
  });

  it("clamps a chunk that would straddle the floor", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2021-11-01", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2021-08-04",
      chunkEnd: "2021-10-31",
    });
  });

  it("uses a 90-day chunk", () => {
    expect(CHUNK_DAYS).toBe(90);
  });
});

describe("runBackfillChunkCloud (cloud-direct spec §3)", () => {
  const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
  const cloudEnv = {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;

  function chunkCoros(activityDates: string[]) {
    const counts: Record<string, number> = {};
    const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/account/login")) {
        bump("login");
        return json({ result: "0000", data: { accessToken: "tok", userId: "u1" } });
      }
      if (url.includes("/activity/query")) {
        bump("activityList");
        return json({
          result: "0000",
          data: {
            totalPage: 1,
            dataList: activityDates.map((d, i) => ({
              labelId: `bf-${i}`,
              sportType: 100,
              name: `History Run ${i}`,
              date: Number(d.replaceAll("-", "")),
              startTime: Math.floor(Date.parse(`${d}T09:00:00Z`) / 1000),
              endTime: Math.floor(Date.parse(`${d}T09:50:00Z`) / 1000),
              distance: 7000,
              totalTime: 3000,
              workoutTime: 2950,
            })),
          },
        });
      }
      bump("other");
      return json({ result: "0000", data: {} });
    }) as typeof fetch;
    return { fetchImpl, counts };
  }

  it("serves the queued chunk itself: pull, record, advance, complete the job", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const coros = chunkCoros([addDays(today, -30), addDays(today, -40)]);
    await connectCoros(db, cloudEnv, userId, { email: "a@b.c", pwdMd5: "5f4dcc3b5aa765d61d8327deb882cf99", region: "us" }, coros.fetchImpl);
    await enqueueBackfill(db, userId, today);

    const res = await runBackfillChunkCloud(db, cloudEnv, userId, prefs, coros.fetchImpl);
    expect(res.ran).toBe(true);

    const state = (await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId)))[0]!;
    expect(state.chunksCompleted).toBe(1);
    expect(state.activitiesIngested).toBe(2);
    expect(state.status).toBe("running");
    const acts = await db.select().from(schema.activities).where(eq(schema.activities.userId, userId));
    expect(acts).toHaveLength(2);
    // The served job is completed; the walk enqueued the NEXT chunk.
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "backfill")));
    expect(jobs.filter((j) => j.status === "completed")).toHaveLength(1);
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("no cloud connection → ran:false and the job stays queued for a device", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await enqueueBackfill(db, userId, today);
    const res = await runBackfillChunkCloud(db, cloudEnv, userId, prefs);
    expect(res.ran).toBe(false);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "backfill")));
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
  });
});
