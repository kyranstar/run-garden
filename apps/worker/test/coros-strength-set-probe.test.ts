/**
 * The masked strength-set scale probe (Phase 2a+ Task 1):
 * `GET /api/coros/debug/strength-set-stats` reads the athlete's recent
 * strength activities through the cloud client and returns COUNTS ONLY — how
 * many lap items carry reps, weight and intensityValue, order-of-magnitude
 * buckets, and how weight and intensityValue relate in scale. It runs on real
 * personal data, so the masking is the feature: the fixtures below are
 * synthetic, shaped like the real lap skeleton (spikes report §1), and every
 * value in them is swept through the serialized response.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { addDays, todayInZone } from "@rg/domain";
import type { RawCorosActivityDetail, RawCorosActivityListItem } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { connectCoros } from "../src/services/coros-connection.js";
import {
  strengthSetStats,
  SUBREQUEST_BUDGET,
  type StrengthSetProbeBody,
} from "../src/services/coros-strength-set-probe.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...overrides,
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type Server = ReturnType<typeof mockCorosServer>;

async function connect(db: Db, userId: string, server: Server): Promise<void> {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
}

function corosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

const isLapTypeCode = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99;

/**
 * Every primitive leaf of the fixture, as the string a leak would show up as —
 * except what carries nothing (0, the empty string: counts and every string
 * contain them) and small-integer lap types, which the probe reports as
 * `byLapType` keys by design. A lap type that is NOT a small integer stays in.
 */
function sweptLeaves(value: unknown, key = "", out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const v of value) sweptLeaves(v, key, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) sweptLeaves(v, k, out);
    return out;
  }
  if (key === "lapType" && isLapTypeCode(value)) return out;
  const text = String(value);
  if (text !== "" && text !== "0") out.push(text);
  return out;
}

/**
 * One strength lap item with every key of the real skeleton. The fields the
 * probe counts are passed in; the rest get distinctive filler (4-digit, so no
 * count or bucket label can contain them by accident).
 */
function lapItem(n: number, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    lapIndex: 8600 + n,
    time: 86_000 + n,
    avgHr: 8700 + n,
    exerciseIndex: 7100 + n,
    exerciseNameKey: `T${4400 + n}`,
    exerciseType: 8800 + n,
    setIndex: 7200 + n,
    sets: 7300 + n,
    targetSets: 7400 + n,
    targetType: 7500 + n,
    targetValue: 7600 + n,
    intensityType: 7700 + n,
    intensityValueExtend: 7800 + n,
    intensityMultiplier: 7900 + n,
    intensityCustom: 8000 + n,
    intensityDisplayUnit: 8100 + n,
    lapTrainIndex: 8200 + n,
    programExerciseIndex: 8300 + n,
    indexInOriginLap: 8400 + n,
    pauseTime: 8500 + n,
    ...fields,
  };
}

/**
 * Three strength activities in the default 60-day window (A newest), a run in
 * the window whose laps carry weights too, and a strength activity 75 days
 * back (only in a 120-day window). Values are chosen to land in known
 * buckets; the expected counts in the first test are worked out from them.
 */
function seedActivities(server: Server, today: string) {
  const dayA = addDays(today, -2);
  const base = Math.floor(Date.parse(`${dayA}T06:00:00Z`) / 1000);
  const list: RawCorosActivityListItem[] = [
    { labelId: "lbl-strength-a-4417", date: corosDay(dayA), name: "Synthetic Push Day", sportType: 402, startTime: base, totalTime: 2741 },
    { labelId: "lbl-strength-b-5528", date: corosDay(addDays(today, -6)), name: "Synthetic Pull Day", sportType: 402, startTime: base - 345_611, totalTime: 1893 },
    { labelId: "lbl-strength-c-6639", date: corosDay(addDays(today, -11)), name: "Synthetic Mobility Lift", sportType: 402, startTime: base - 777_731, totalTime: 1777 },
    { labelId: "lbl-run-7740", date: corosDay(dayA), name: "Synthetic Tempo", sportType: 101, startTime: base + 7_777, totalTime: 3137 },
    { labelId: "lbl-strength-stale-8851", date: corosDay(addDays(today, -75)), name: "Synthetic Old Lift", sportType: 402, startTime: base - 6_312_347, totalTime: 1999 },
  ];
  const details: Record<string, RawCorosActivityDetail> = {
    "lbl-strength-a-4417": {
      summary: {
        name: "Synthetic Push Day",
        sportType: 402,
        avgHr: 117,
        totalTime: 274_100,
        trainingLoad: 57.25,
        exercises: 913,
        sets: 917,
        totalReps: 389,
        totalWeight: 7_315_250,
      },
      lapList: [
        {
          type: 7302,
          lapItemList: [
            // weight == intensityValue
            lapItem(1, { reps: 37, weight: 47_250, intensityValue: 47_250, exerciseId: "exr-778899", lapType: 2 }),
            // weight == intensityValue × 1000
            lapItem(2, { reps: 41, weight: 52_500, intensityValue: 52.5, exerciseId: "exr-665544", lapType: 2 }),
            // intensityValue == weight × 1000
            lapItem(3, { reps: 43, weight: 61.75, intensityValue: 61_750, exerciseId: "exr-553311", lapType: 2 }),
            // bodyweight: weight 0, intensityValue ""
            lapItem(4, { reps: 29, weight: 0, intensityValue: "", exerciseId: "exr-442200", lapType: 2 }),
            // a rest lap: no weight, no intensity, no exercise
            { lapIndex: 8605, time: 86_005, reps: 0, lapType: 3 },
            // both set, no scale relation
            lapItem(6, { reps: 31, weight: 8.25, intensityValue: 3333, exerciseId: "exr-778899", lapType: 2 }),
            // numeric strings, a negative intensity, an empty id, a lap type that is not an enum code
            lapItem(7, { reps: "47", weight: "0.75", intensityValue: -5317, exerciseId: "", lapType: 54_017 }),
          ],
        },
      ],
      sportFeelInfo: { feelType: 4404, sportNote: "synthetic note about the session" },
    },
    "lbl-strength-b-5528": {
      summary: { name: "Synthetic Pull Day", avgHr: 109, totalReps: "523" },
      lapList: [
        {
          type: 7303,
          lapItemList: [
            lapItem(8, { reps: 53, weight: 123_456, intensityValue: 2_718_281, exerciseId: 778_812, lapType: 2 }),
            lapItem(9, { reps: 59, weight: 815.5, intensityValue: 815_500, exerciseId: 778_812 }),
            lapItem(10, { reps: null, weight: "n/a-9931", intensityValue: "fast-7731", exerciseId: null }),
          ],
        },
        { type: 7304, lapItemList: [] },
      ],
    },
    "lbl-strength-c-6639": {
      summary: { name: "Synthetic Mobility Lift", totalWeight: 0, totalReps: 0 },
    },
    "lbl-run-7740": {
      summary: { name: "Synthetic Tempo", totalWeight: 99_991 },
      lapList: [{ type: 7305, lapItemList: [lapItem(11, { reps: 61, weight: 99_992, intensityValue: 99_993, lapType: 2 })] }],
    },
    "lbl-strength-stale-8851": {
      summary: { name: "Synthetic Old Lift", totalWeight: 333_331 },
      lapList: [
        {
          type: 7306,
          lapItemList: [lapItem(12, { reps: 67, weight: 22_222, intensityValue: 22_222, exerciseId: "exr-990011", lapType: 2 })],
        },
      ],
    },
  };
  server.state.activities = list;
  server.state.details = details;
  return { list, details };
}

/** The mock COROS server behind a counter, so `subrequests` can be checked. */
function countingFetch(server: Server) {
  const paths: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    paths.push(url.pathname);
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  return { paths, impl };
}

async function setup() {
  const statements: string[] = [];
  const db = makeTestDb({ onStatement: (sql) => statements.push(sql) });
  const { userId, prefs } = await makeTestUser(db);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const server = mockCorosServer();
  const fetchCounter = countingFetch(server);
  vi.stubGlobal("fetch", fetchCounter.impl);
  const app = mountRoutes(db, "/api/coros", corosRoutes);
  const get = (path: string, env: Env = makeEnv()) => app.request(path, { headers: { Cookie: cookie } }, env);
  return { db, userId, prefs, server, get, statements, fetchCounter };
}

const ZERO_BUCKETS = { "<1": 0, "1-10": 0, "10-100": 0, "100-1k": 0, "1k-10k": 0, "10k-100k": 0, ">=100k": 0 };

describe("GET /api/coros/debug/strength-set-stats", () => {
  it("counts reps, weight and intensity on recent strength laps", async () => {
    const { db, userId, prefs, server, get, statements, fetchCounter } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    statements.length = 0;
    fetchCounter.paths.length = 0;

    const res = await get("/api/coros/debug/strength-set-stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StrengthSetProbeBody;

    expect(body).toEqual({
      windowDays: 60,
      // A, B and C; the run and the 75-day-old activity are never read.
      strengthActivities: 3,
      activitiesScanned: 3,
      detailFailures: 0,
      truncated: false,
      // The list, then one detail each (the session token is fresh).
      subrequests: 4,
      subrequestBudget: SUBREQUEST_BUDGET,
      activitiesWithLapItems: 2,
      lapListsWithItems: 2,
      lapItems: {
        total: 10,
        byLapType: { "2": 6, "3": 1, missing: 2, other: 1 },
        reps: {
          missing: 1,
          empty: 0,
          zero: 1,
          positive: 8,
          negative: 0,
          nonNumeric: 0,
          fromString: 1,
          magnitude: { ...ZERO_BUCKETS, "10-100": 8 },
        },
        weight: {
          missing: 1,
          empty: 0,
          zero: 1,
          positive: 7,
          negative: 0,
          nonNumeric: 1,
          fromString: 1,
          magnitude: { "<1": 1, "1-10": 1, "10-100": 1, "100-1k": 1, "1k-10k": 0, "10k-100k": 2, ">=100k": 1 },
        },
        intensityValue: {
          missing: 1,
          empty: 1,
          zero: 0,
          positive: 6,
          negative: 1,
          nonNumeric: 1,
          fromString: 0,
          magnitude: { ...ZERO_BUCKETS, "10-100": 1, "1k-10k": 1, "10k-100k": 2, ">=100k": 2 },
        },
        weightVsIntensity: {
          compared: 6,
          equal: 1,
          weightIsIntensityTimes1000: 1,
          intensityIsWeightTimes1000: 2,
          other: 2,
        },
        // 47,250 ÷ 47,250; 52,500 ÷ 52.5; and four far below (61.75 ÷ 61,750, 8.25 ÷ 3,333, 123,456 ÷ 2,718,281,
        // 815.5 ÷ 815,500).
        weightOverIntensity: {
          "<0.3": 4,
          "0.3-0.44": 0,
          "about 1/2.2046": 0,
          "0.465-0.9": 0,
          "0.9-0.99": 0,
          "about 1": 1,
          "1.01-1.1": 0,
          "1.1-2.1": 0,
          "about 2.2046": 0,
          "2.3-900": 0,
          "about 1000": 1,
          ">=1100": 0,
        },
        // 52,500 is half, 47,250 a quarter, the rest off the grid; 8.25 and 0.75 are within 0.02 lb of zero.
        weightSteps: {
          positive: 7,
          whole: 0,
          half: 1,
          quarter: 1,
          offGrid: 5,
          kgThousandthsOfWholePounds: 2,
          kgThousandthsOfTwoAndAHalfPounds: 2,
        },
        exerciseId: { present: 7, absent: 3, distinct: 5 },
      },
      summary: {
        present: 3,
        totalWeight: {
          missing: 1,
          empty: 0,
          zero: 1,
          positive: 1,
          negative: 0,
          nonNumeric: 0,
          fromString: 0,
          magnitude: { ...ZERO_BUCKETS, ">=100k": 1 },
        },
        totalReps: {
          missing: 0,
          empty: 0,
          zero: 1,
          positive: 2,
          negative: 0,
          nonNumeric: 0,
          fromString: 1,
          magnitude: { ...ZERO_BUCKETS, "100-1k": 2 },
        },
        totalWeightVsSets: {
          compared: 1,
          equal: 0,
          totalIsSumTimes1000: 0,
          totalIsSumOver1000: 0,
          totalIsSumInPounds: 0,
          totalIsSumInKilograms: 0,
          other: 1,
        },
      },
    });

    // `subrequests` is the real number of COROS calls, and every one is a read.
    expect(fetchCounter.paths).toEqual(["/activity/query", ...Array(3).fill("/activity/detail/query")]);
    expect(server.counts.scheduleWrites).toBe(0);
    // Nothing stored: no D1 write, and the D1 reads are fixed (session,
    // preferences, connection row) — not one per activity.
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.length).toBeLessThanOrEqual(4);
  });

  it("returns no value, id, name, date or title — every fixture leaf swept through the JSON", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    const { list, details } = seedActivities(server, todayInZone(prefs.timezone));
    const swept = [...sweptLeaves(list), ...sweptLeaves(details)];
    expect(swept.length).toBeGreaterThan(250);

    // The default window, and the widest (every strength activity read).
    for (const query of ["", "?days=120"]) {
      const res = await get(`/api/coros/debug/strength-set-stats${query}`);
      expect(res.status, query).toBe(200);
      const text = await res.text();
      expect((JSON.parse(text) as StrengthSetProbeBody).activitiesScanned).toBeGreaterThanOrEqual(3);
      // THE POINT: not one fixture value — list item or detail, read or
      // not — appears anywhere in the response.
      for (const value of swept) {
        expect(text, `${query || "default"}: leaked fixture value ${JSON.stringify(value)}`).not.toContain(value);
      }
    }
  });

  it("clamps the window to 1..120 days and refuses a non-integer", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    const window = async (q: string) => {
      const res = await get(`/api/coros/debug/strength-set-stats${q}`);
      expect(res.status, q).toBe(200);
      return (await res.json()) as StrengthSetProbeBody;
    };

    expect((await window("?days=0")).windowDays).toBe(1);
    expect((await window("?days=-40")).windowDays).toBe(1);
    const wide = await window("?days=100000");
    expect(wide.windowDays).toBe(120);
    // The 75-day-old strength activity is in a 120-day window.
    expect(wide.strengthActivities).toBe(4);
    expect(wide.lapItems.total).toBe(11);
    expect((await window("?days=30")).strengthActivities).toBe(3);

    for (const bad of ["abc", "", "2.5", "1e3"]) {
      expect((await get(`/api/coros/debug/strength-set-stats?days=${bad}`)).status, bad).toBe(400);
    }
  });

  it("stops before the subrequest ceiling and says so", async () => {
    const { db, userId, prefs, server, get, fetchCounter } = await setup();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const base = Math.floor(Date.parse(`${today}T06:00:00Z`) / 1000);
    server.state.activities = Array.from({ length: 45 }, (_, i) => ({
      labelId: `lbl-many-${i}`,
      date: corosDay(addDays(today, -1 - i)),
      sportType: 402,
      startTime: base - 86_400 * (i + 1),
    }));
    server.state.details = Object.fromEntries(
      server.state.activities.map((a) => [
        a.labelId,
        { lapList: [{ lapItemList: [lapItem(1, { reps: 37, weight: 47_250, lapType: 2 })] }] },
      ]),
    );
    fetchCounter.paths.length = 0;

    const res = await get("/api/coros/debug/strength-set-stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StrengthSetProbeBody;
    expect(body.strengthActivities).toBe(45);
    expect(body.truncated).toBe(true);
    expect(body.activitiesScanned).toBeLessThan(45);
    expect(body.lapItems.total).toBe(body.activitiesScanned);
    // Counted exactly, inside the budget, and the budget itself well under
    // Workers Free's 50.
    expect(body.subrequests).toBe(fetchCounter.paths.length);
    expect(body.subrequests).toBe(1 + body.activitiesScanned);
    expect(body.subrequests).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(SUBREQUEST_BUDGET).toBeLessThanOrEqual(40);
    // It went as far as one more worst-case detail (call, re-login, retry) allowed.
    expect(body.subrequests + 3).toBeGreaterThan(SUBREQUEST_BUDGET);
  });

  it("counts a re-login and retry on an expired token as subrequests", async () => {
    const { db, userId, prefs, server, get, fetchCounter } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    server.expireTokens();
    const loginsBefore = server.counts.login;
    fetchCounter.paths.length = 0;

    const res = await get("/api/coros/debug/strength-set-stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StrengthSetProbeBody;
    expect(server.counts.login).toBe(loginsBefore + 1);
    expect(body.activitiesScanned).toBe(3);
    // 1019, login, retried list, three details.
    expect(body.subrequests).toBe(6);
    expect(body.subrequests).toBe(fetchCounter.paths.length);
  });

  it("counts a detail that fails and carries on", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/activity/detail/query" && String(init?.body).includes("lbl-strength-b-5528")) {
        throw new Error("network down");
      }
      return server.fetchImpl(input, init);
    }) as typeof fetch);

    const res = await get("/api/coros/debug/strength-set-stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StrengthSetProbeBody;
    expect(body.detailFailures).toBe(1);
    expect(body.activitiesScanned).toBe(2);
    expect(body.lapItems.total).toBe(7);
  });

  it("our own subrequest ceiling is a runtime_limit, never a COROS error", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    for (const failing of ["/activity/detail/query", "/activity/query"]) {
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === failing) throw new Error("Too many subrequests.");
        return server.fetchImpl(input, init);
      }) as typeof fetch);
      const res = await get("/api/coros/debug/strength-set-stats");
      expect(res.status, failing).toBe(503);
      expect(await res.json()).toEqual({ error: "runtime_limit" });
    }
  });

  it("says not_connected without touching COROS when there is no connection", async () => {
    const { server, get, fetchCounter } = await setup();
    const res = await get("/api/coros/debug/strength-set-stats");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    expect(server.counts.login).toBe(0);
    expect(fetchCounter.paths).toEqual([]);
  });

  it("is not there in fixture mode", async () => {
    const { db, userId, server, get, fetchCounter } = await setup();
    await connect(db, userId, server);
    fetchCounter.paths.length = 0;
    const res = await get("/api/coros/debug/strength-set-stats", makeEnv({ FIXTURE_MODE: "1" }));
    expect(res.status).toBe(404);
    expect(fetchCounter.paths).toEqual([]);
  });

  it("requires a signed-in user", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/coros", corosRoutes);
    const res = await app.request("/api/coros/debug/strength-set-stats", {}, makeEnv());
    expect(res.status).toBe(401);
  });
});

describe("strengthSetStats", () => {
  it("buckets by order of magnitude with the lower bound inclusive", () => {
    const weights = [0.999, 1, 9.99, 10, 99.99, 100, 999.9, 1000, 9999, 10_000, 99_999, 100_000, 5e9];
    const stats = strengthSetStats([{ lapList: [{ lapItemList: weights.map((weight) => ({ weight })) }] }]);
    expect(stats.lapItems.weight.magnitude).toEqual({
      "<1": 1,
      "1-10": 2,
      "10-100": 2,
      "100-1k": 2,
      "1k-10k": 2,
      "10k-100k": 2,
      ">=100k": 2,
    });
  });

  it("tells a kg × 1000 grid from pounds typed in, and buckets weight ÷ intensity around unit mix-ups", () => {
    const lb = (pounds: number) => Math.round(pounds * 0.45359237 * 1000);
    const items = [
      { weight: 24_000, intensityValue: 24_000, reps: 5 }, // whole (kg × 1000), ratio 1
      { weight: 22_500, intensityValue: 22_500 / 2.20462, reps: 5 }, // half, ratio ≈ 2.2046
      { weight: 1_250 }, // quarter
      { weight: lb(35), intensityValue: lb(35) * 1000 }, // 35 lb as kg × 1000: off the grid, ratio 0.001
      { weight: lb(45) }, // 45 lb: a whole pound and a 2.5 lb step
      { weight: lb(47.5) }, // a 2.5 lb step, not a whole pound
      { weight: 0 }, // not positive: not counted
    ];
    const stats = strengthSetStats([{ lapList: [{ lapItemList: items }] }]);
    expect(stats.lapItems.weightSteps).toEqual({
      positive: 6,
      whole: 1,
      half: 1,
      quarter: 1,
      offGrid: 3,
      kgThousandthsOfWholePounds: 2,
      kgThousandthsOfTwoAndAHalfPounds: 3, // 35, 45 and 47.5 lb
    });
    expect(stats.lapItems.weightOverIntensity).toMatchObject({ "<0.3": 1, "about 1": 1, "about 2.2046": 1 });
    expect(Object.values(stats.lapItems.weightOverIntensity).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("relates the summary's total weight to Σ reps × weight of the activity's sets", () => {
    const sets = { lapList: [{ lapItemList: [{ reps: 5, weight: 20_000 }, { reps: 8, weight: 10_000 }] }] }; // Σ = 180,000
    const relation = (totalWeight: number) =>
      strengthSetStats([{ ...sets, summary: { totalWeight } }] as unknown as RawCorosActivityDetail[]).summary.totalWeightVsSets;
    expect(relation(180_000)).toMatchObject({ compared: 1, equal: 1 });
    expect(relation(180_000_000)).toMatchObject({ totalIsSumTimes1000: 1 });
    expect(relation(180)).toMatchObject({ totalIsSumOver1000: 1 });
    expect(relation(180_000 / 0.45359237)).toMatchObject({ totalIsSumInPounds: 1 });
    expect(relation(180_000 * 0.45359237)).toMatchObject({ totalIsSumInKilograms: 1 });
    expect(relation(123_457)).toMatchObject({ other: 1 });
  });

  it("survives details that are not the expected shape", () => {
    const odd = [
      {},
      { lapList: "x" },
      { lapList: [null, { lapItemList: "y" }, { lapItemList: [null, 7, "z"] }] },
      { summary: [] },
    ] as unknown as RawCorosActivityDetail[];
    const stats = strengthSetStats(odd);
    expect(stats.lapItems.total).toBe(3);
    expect(stats.lapItems.weight.missing).toBe(3);
    expect(stats.lapItems.byLapType).toEqual({ missing: 3 });
    expect(stats.summary.present).toBe(0);
  });
});
