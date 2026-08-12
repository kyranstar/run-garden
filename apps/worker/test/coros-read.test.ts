/**
 * Cloud read-now (cloud-direct spec §3): one COROS pull ingests activities
 * end-to-end; racing calls share one pull; the 90s freshness window makes
 * repeats free; errors surface honestly and never throw into callers.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import { localDateToCorosDay } from "@rg/providers";
import { connectCoros } from "../src/services/coros-connection.js";
import { corosReadNow, READ_FRESHNESS_MS } from "../src/services/coros-read.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
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
}

const PWD_MD5 = "5f4dcc3b5aa765d61d8327deb882cf99";

/** A COROS cloud in one function: login, schedule, activities, detail,
 * day metrics, dashboard, and the public locale bundle. Counts calls. */
function fakeCoros(today: string) {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const activityDay = localDateToCorosDay(addDays(today, -1));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("static.coros.com/locale")) {
      bump("locale");
      return new Response('window.en_US = {"T1004": "Push-ups"};', { status: 200 });
    }
    if (url.endsWith("/account/login")) {
      bump("login");
      return json({ result: "0000", data: { accessToken: "tok", userId: "u1" } });
    }
    if (url.includes("/training/schedule/query")) {
      bump("schedule");
      return json({ result: "0000", data: { plan: null, scheduleList: [] } });
    }
    if (url.includes("/activity/query")) {
      bump("activityList");
      return json({
        result: "0000",
        data: {
          totalPage: 1,
          dataList: [
            {
              labelId: "act-cloud-1",
              sportType: 100,
              name: "Evening Run",
              date: Number(activityDay),
              startTime: Math.floor(Date.parse(`${addDays(today, -1)}T17:30:00Z`) / 1000),
              endTime: Math.floor(Date.parse(`${addDays(today, -1)}T18:20:00Z`) / 1000),
              distance: 8500,
              totalTime: 3000,
              workoutTime: 2950,
              trainingLoad: 95,
              avgHr: 152,
            },
          ],
        },
      });
    }
    if (url.includes("/activity/detail/query") || url.includes("/activity/query/detail")) {
      bump("detail");
      return json({ result: "0000", data: { summary: {}, lapList: [] } });
    }
    if (url.includes("dayDetail") || url.includes("analyse")) {
      bump("dayDetail");
      return json({ result: "0000", data: { dayList: [{ happenDay: Number(activityDay), rhr: 48 }] } });
    }
    bump(`other:${new URL(url).pathname}`);
    return json({ result: "0000", data: {} });
  }) as typeof fetch;
  return { fetchImpl, counts };
}

async function setup() {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db);
  const today = todayInZone(prefs.timezone);
  const coros = fakeCoros(today);
  const res = await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
  expect(res.status).toBe("connected");
  return { db, userId, prefs, today, coros };
}

async function markSynced(db: Db, userId: string, agoMs: number) {
  await db
    .update(schema.providerConnections)
    .set({ lastSyncAt: new Date(Date.now() - agoMs).toISOString() })
    .where(and(eq(schema.providerConnections.userId, userId), eq(schema.providerConnections.provider, "coros")));
}

describe("corosReadNow", () => {
  it("pulls, ingests the new activity, and stamps the sync", async () => {
    const { db, userId, prefs, coros } = await setup();
    const res = await corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl });
    expect(res.status).toBe("ok");
    expect(res.ingested).toBe(1);
    const acts = await db.select().from(schema.activities).where(eq(schema.activities.userId, userId));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.sport).toBe("run");
    const reads = await db.select().from(schema.coachReads).where(eq(schema.coachReads.userId, userId));
    expect(reads).toHaveLength(1); // ambient read enqueued for the fresh activity
    const [conn] = await db
      .select()
      .from(schema.providerConnections)
      .where(eq(schema.providerConnections.userId, userId));
    expect(conn!.lastSyncAt).not.toBeNull();
  });

  it("is fresh within the 90s window and pulls again after it", async () => {
    const { db, userId, prefs, coros } = await setup();
    await markSynced(db, userId, 5_000);
    const fresh = await corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl });
    expect(fresh.status).toBe("fresh");
    expect(coros.counts.activityList ?? 0).toBe(0);

    await markSynced(db, userId, READ_FRESHNESS_MS + 1_000);
    const again = await corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl });
    expect(again.status).toBe("ok");
    expect(coros.counts.activityList).toBe(1);
  });

  it("EXACTLY-ONCE: concurrent read-nows share one pull", async () => {
    const { db, userId, prefs, coros } = await setup();
    const [a, b] = await Promise.all([
      corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl }),
      corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["busy", "ok"]);
    expect(coros.counts.activityList).toBe(1);
  });

  it("skips detail calls for already-ingested activities", async () => {
    const { db, userId, prefs, coros } = await setup();
    await corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl });
    const detailsAfterFirst = coros.counts.detail ?? 0;
    await markSynced(db, userId, READ_FRESHNESS_MS + 1_000);
    await corosReadNow(db, makeEnv(), userId, prefs, { fetchImpl: coros.fetchImpl });
    expect(coros.counts.detail ?? 0).toBe(detailsAfterFirst); // no re-detail for the same labelId
  });

  it("not connected → not_connected; network failure → coros_unreachable", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    expect((await corosReadNow(db, makeEnv(), userId, prefs)).status).toBe("not_connected");

    const { db: db2, userId: u2, prefs: p2 } = await setup();
    const dead = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await markSynced(db2, u2, READ_FRESHNESS_MS + 1_000);
    const res = await corosReadNow(db2, makeEnv(), u2, p2, { fetchImpl: dead });
    expect(res.status).toBe("coros_unreachable");
  });
});
