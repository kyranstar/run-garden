/**
 * The masked lap-key probe (Task 15): `GET /api/coros/debug/lap-keys` reads the
 * athlete's most recent strength activities through the cloud client and
 * returns the SHAPE of their lap items and summary — keys and types, never a
 * value. It runs on real personal data, so the masking is the feature: every
 * test here seeds distinctive values and then scans the serialized response for
 * each one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { addDays, todayInZone } from "@rg/domain";
import type { RawCorosActivityDetail, RawCorosActivityListItem } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { keySkeleton } from "../src/services/coros-lap-probe.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

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
  const res = await connectCoros(
    db,
    makeEnv(),
    userId,
    { email: server.email, pwdMd5, region: "us" },
    server.fetchImpl,
  );
  expect(res.status).toBe("connected");
}

function corosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

/** Every primitive leaf of a value, as the string a leak would show up as. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const v of value) leaves(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out);
    return out;
  }
  out.push(String(value));
  return out;
}

/**
 * Two strength activities in the window (the newest carries the extra lap keys
 * the probe exists to find), a run in the window, and a strength activity
 * OUTSIDE it. Every value is distinctive — no small integers that could
 * collide with a count like "array(2)" — so a scan for it is meaningful.
 */
function seedActivities(server: Server, today: string) {
  const recentDay = addDays(today, -3);
  const olderDay = addDays(today, -9);
  const staleDay = addDays(today, -44);
  const base = Math.floor(Date.parse(`${recentDay}T06:00:00Z`) / 1000);
  const list: RawCorosActivityListItem[] = [
    {
      labelId: "lbl-strength-recent-4417",
      date: corosDay(recentDay),
      name: "Tuesday Chin Tucks",
      sportType: 402,
      startTime: base,
      totalTime: 2741,
      workoutTime: 2699,
      avgHr: 117,
      calorie: 351_917,
    },
    {
      labelId: "lbl-strength-older-5528",
      date: corosDay(olderDay),
      name: "Garage Session Alpha",
      sportType: 402,
      startTime: base - 518_400,
      totalTime: 1893,
    },
    {
      labelId: "lbl-run-6639",
      date: corosDay(recentDay),
      name: "Lakeside Tempo",
      sportType: 100,
      startTime: base + 7_777,
      totalTime: 3137,
    },
    {
      labelId: "lbl-strength-stale-7740",
      date: corosDay(staleDay),
      name: "Ancient Lift",
      sportType: 402,
      startTime: base - 3_542_400,
      totalTime: 1777,
    },
  ];
  const details: Record<string, RawCorosActivityDetail> = {
    "lbl-strength-recent-4417": {
      summary: {
        name: "Tuesday Chin Tucks",
        avgHr: 117,
        maxHr: 163,
        totalTime: 274_100,
        trainingLoad: 57.25,
        sportType: 402,
        timezone: -28,
        nested: { deviceSerial: "SN-PRIVATE-9911", firmware: "V3.0419" },
      },
      lapList: [
        {
          type: 7302,
          lapDistance: 8080,
          lapItemList: [
            {
              lapIndex: 9101,
              time: 45_678,
              exerciseNameKey: "T1231",
              exerciseId: "exr-778899",
              intensityValue: 47_250,
              sets: 911,
              totalReps: 173,
              avgHr: 129,
            },
            {
              lapIndex: 9102,
              time: 39_123,
              exerciseNameKey: "T1150",
              exerciseId: "exr-665544",
              intensityValue: "",
              sets: 912,
              totalReps: 174,
              restTime: 6011,
              repList: [141, 142, 143],
            },
          ],
        },
      ],
      sportFeelInfo: { feelType: 4404, sportNote: "felt strong despite the neck" },
      weather: { temperature: 219 },
    },
    "lbl-strength-older-5528": {
      summary: { name: "Garage Session Alpha", avgHr: 109, workoutTime: 189_300 },
      lapList: [
        {
          type: 7303,
          lapItemList: [{ lapIndex: 9201, time: 60_606, exerciseId: "exr-112233", totalReps: 188 }],
        },
      ],
    },
    "lbl-run-6639": {
      summary: { name: "Lakeside Tempo", avgHr: 158, runOnlyKey: 4242 },
      lapList: [{ type: 7304, lapItemList: [{ lapIndex: 9301, runLapOnlyKey: 5353 }] }],
    },
    "lbl-strength-stale-7740": {
      summary: { name: "Ancient Lift", staleOnlyKey: 6464 },
      lapList: [{ type: 7305, lapItemList: [{ lapIndex: 9401, staleLapOnlyKey: 7575 }] }],
    },
  };
  server.state.activities = list;
  server.state.details = details;
  return { list, details };
}

async function setup() {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const server = mockCorosServer();
  vi.stubGlobal("fetch", server.fetchImpl);
  const app = mountRoutes(db, "/api/coros", corosRoutes);
  const get = (path: string, env: Env = makeEnv()) =>
    app.request(path, { headers: { Cookie: cookie } }, env);
  return { db, userId, prefs, server, get };
}

describe("GET /api/coros/debug/lap-keys", () => {
  it("returns the key skeleton of recent strength laps and summaries — and no value at all", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const { list, details } = seedActivities(server, today);

    const res = await get("/api/coros/debug/lap-keys?days=30");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      strengthActivities: number;
      probed: number;
      activities: Array<{
        detailKeys: Record<string, unknown>;
        skeleton: Record<string, unknown>;
      }>;
    };

    // The two in-window strength activities, newest first; the run and the
    // out-of-window strength activity are never probed.
    expect(body.strengthActivities).toBe(2);
    expect(body.probed).toBe(2);
    expect(body.activities).toHaveLength(2);
    expect(text).not.toContain("runOnlyKey");
    expect(text).not.toContain("runLapOnlyKey");
    expect(text).not.toContain("staleOnlyKey");
    expect(text).not.toContain("staleLapOnlyKey");

    const newest = body.activities[0]!;
    const lapItems = (newest.skeleton["lapList[]"] as Record<string, unknown>)["lapItemList[]"] as Record<
      string,
      unknown
    >;
    // The keys the probe exists to discover, typed but never valued.
    expect(lapItems.exerciseId).toBe("string");
    expect(lapItems.sets).toBe("number");
    expect(lapItems.totalReps).toBe("number");
    // A key whose type varies across items shows both types, not a value.
    expect(lapItems.intensityValue).toBe("number|string");
    // Present on only one item — the union still lists it.
    expect(lapItems.restTime).toBe("number");
    expect(lapItems.repList).toBe("array(3)");
    expect(lapItems["repList[]"]).toBe("number");
    expect(newest.skeleton.lapList).toBe("array(1)");

    const summary = newest.skeleton.summary as Record<string, unknown>;
    expect(summary.avgHr).toBe("number");
    expect(summary.name).toBe("string");
    expect(summary.nested).toEqual({ deviceSerial: "string", firmware: "string" });

    // The detail's own top-level keys, one level deep, so a reps/load field
    // living outside the laps is visible too.
    expect(newest.detailKeys).toEqual({
      summary: "object",
      lapList: "array(1)",
      sportFeelInfo: "object",
      weather: "object",
    });

    // THE POINT: not one seeded value — list item or detail, probed or not —
    // appears anywhere in the response.
    // (An empty string carries nothing and is contained by every string.)
    const seeded = [...leaves(list), ...leaves(details)].filter((v) => v !== "");
    expect(seeded.length).toBeGreaterThan(40);
    for (const value of seeded) {
      expect(text, `leaked seeded value ${JSON.stringify(value)}`).not.toContain(value);
    }
  });

  it("defaults to 30 days and refuses a nonsense window", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));

    const res = await get("/api/coros/debug/lap-keys");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);

    expect((await get("/api/coros/debug/lap-keys?days=0")).status).toBe(400);
    expect((await get("/api/coros/debug/lap-keys?days=abc")).status).toBe(400);
    expect((await get("/api/coros/debug/lap-keys?days=100000")).status).toBe(400);
  });

  it("says not_connected without touching COROS when there is no connection", async () => {
    const { server, get } = await setup();
    const res = await get("/api/coros/debug/lap-keys?days=30");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    expect(server.counts.login).toBe(0);
  });

  it("is not there in fixture mode", async () => {
    const { db, userId, server, get } = await setup();
    await connect(db, userId, server);
    const loginsBefore = server.counts.login;
    const res = await get("/api/coros/debug/lap-keys?days=30", makeEnv({ FIXTURE_MODE: "1" }));
    expect(res.status).toBe(404);
    expect(server.counts.login).toBe(loginsBefore);
  });

  it("a lap keyed `constructor` is probed, not reported as a COROS error (Audit 2 E2E M7)", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    const { details } = seedActivities(server, todayInZone(prefs.timezone));
    const lap = details["lbl-strength-recent-4417"]!.lapList![0] as Record<string, unknown>;
    lap.lapItemList = [JSON.parse('{"constructor":{"a":1},"__proto__":{"b":2}}'), { constructor: "x" }];
    const res = await get("/api/coros/debug/lap-keys?days=30");
    expect(res.status).toBe(200);
  });

  it("our own subrequest ceiling is a runtime_limit, never a COROS error or a failed detail (Audit 2 E2E M7)", async () => {
    const { db, userId, prefs, server, get } = await setup();
    await connect(db, userId, server);
    seedActivities(server, todayInZone(prefs.timezone));
    for (const failing of ["/activity/detail/query", "/activity/query"]) {
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === failing) throw new Error("Too many subrequests.");
        return server.fetchImpl(input, init);
      }) as typeof fetch);
      const res = await get("/api/coros/debug/lap-keys?days=30");
      expect(res.status, failing).toBe(503);
      expect(await res.json()).toEqual({ error: "runtime_limit" });
    }
  });

  it("requires a signed-in user", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/coros", corosRoutes);
    const res = await app.request("/api/coros/debug/lap-keys", {}, makeEnv());
    expect(res.status).toBe(401);
  });
});

describe("keySkeleton", () => {
  it("keeps keys and types, drops every value", () => {
    expect(
      keySkeleton({ a: 17, b: "secret", c: true, d: null, e: { f: 3.5 }, g: [], h: undefined }),
    ).toEqual({
      a: "number",
      b: "string",
      c: "boolean",
      d: "null",
      e: { f: "number" },
      g: "array(0)",
      h: "undefined",
    });
  });

  it("merges array elements into one skeleton and collapses differing lengths", () => {
    expect(
      keySkeleton({
        list: [
          { x: 1, inner: [1, 2] },
          { x: "y", z: false, inner: [1, 2, 3, 4, 5] },
          null,
        ],
      }),
    ).toEqual({
      list: "array(3)",
      "list[]": {
        x: "number|string",
        z: "boolean",
        inner: "array(2..5)",
        "inner[]": "number",
        "(type)": "null|object",
      },
    });
  });

  it("masks keys that are themselves data (ids, dates, very long keys)", () => {
    const skeleton = keySkeleton({
      "20260927": { hr: 140 },
      "426109589008859137": { hr: 141 },
      ["k".repeat(80)]: 1,
      ok: 2,
    }) as Record<string, unknown>;
    const text = JSON.stringify(skeleton);
    expect(text).not.toContain("20260927");
    expect(text).not.toContain("426109589008859137");
    expect(text).not.toContain("k".repeat(80));
    expect(skeleton.ok).toBe("number");
    expect(skeleton["(masked key)"]).toEqual({ hr: "number", "(type)": "number|object" });
  });

  it("passes only plain camelCase field names with at most two digits; every other key is masked (Audit 2 E2E M6)", () => {
    const data = [
      "Kyran Adams",
      "runner@example.com",
      "123",
      "555-123-987",
      "e5c4a1b2d3f6",
      "37.774,-122.419",
      "06:30",
      "a1b2c3d4-e5f6",
      "snake_case",
      "Capitalised",
    ];
    const skeleton = keySkeleton(
      Object.fromEntries([...data.map((k) => [k, 1]), ["lapItemList", "x"], ["hrZone2Time", "y"]]),
    ) as Record<string, unknown>;
    const text = JSON.stringify(skeleton);
    for (const key of data) expect(text, key).not.toContain(key);
    expect(skeleton).toEqual({ "(masked key)": "number", lapItemList: "string", hrZone2Time: "string" });
  });

  it("survives keys that name Object.prototype members (Audit 2 E2E M7)", () => {
    const hostile = JSON.parse('{"constructor":{"a":1},"toString":2,"__proto__":{"x":3},"hasOwnProperty":[1]}');
    expect(keySkeleton({ lapList: [hostile, hostile] })).toEqual({
      lapList: "array(2)",
      "lapList[]": {
        constructor: { a: "number" },
        toString: "number",
        hasOwnProperty: "array(1)",
        "hasOwnProperty[]": "number",
        "(masked key)": { x: "number" },
      },
    });
  });

  it("stops descending past a depth cap", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const text = JSON.stringify(keySkeleton(deep));
    expect(text).not.toContain("leaf");
    expect(text).toContain('"object"');
  });
});
