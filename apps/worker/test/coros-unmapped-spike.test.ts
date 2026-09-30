/**
 * The owner-gated unmapped-move write spike (Task 16):
 * `POST /api/coros/spike/unmapped-moves` writes ONE stamped strength workout
 * through the production create executor, reads it back, deletes it through
 * the verified delete path, and reports what was stored per step.
 *
 * The mock COROS server ECHOES what it is sent, so "stored equals sent" here
 * proves only the plumbing — what real COROS keeps is what the live run is
 * for. What these tests do prove: the gate, the exact program on the wire, the
 * create → read → delete sequence, the leftover cleanup, and that nothing but
 * our own test strings comes back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, coachSessionSchema, nowInstant, todayInZone } from "@rg/domain";
import {
  buildSpikeProgram,
  CorosClient,
  createWorkout,
  SPIKE_STAMP_PREFIX,
  spikeStamp,
  spikeWorkout,
} from "@rg/coros";
import {
  FIXTURE_PLAN_ID,
  localDateToCorosDay,
  type RawCorosEntity,
  type RawCorosProgram,
} from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { claimUserLock } from "../src/services/locks.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const CONFIRM = { confirm: "write a test workout" };

const GENERIC_ID = "900000000000001121";
const BIRD_DOG_ID = "900000000000001150";
const CATALOG_ROWS: Array<[string, string]> = [
  ["900000000000001120", "T1120"],
  [GENERIC_ID, "T1121"],
  ["900000000000001123", "T1123"],
  [BIRD_DOG_ID, "T1150"],
];

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

interface WireWrite {
  entities?: RawCorosEntity[];
  programs?: RawCorosProgram[];
  versionObjects: Array<{ status: number }>;
}

async function seedCatalog(db: Db, rows: Array<[string, string]> = CATALOG_ROWS): Promise<void> {
  await db
    .insert(schema.corosExercises)
    .values(rows.map(([id, name]) => ({ id, name, raw: { id, name }, updatedAt: nowInstant() })));
}

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

async function setup(opts: { writesEnabled?: boolean; connected?: boolean; catalog?: boolean } = {}) {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: opts.writesEnabled ?? true });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const server = mockCorosServer();
  // Every schedule write the route makes, as sent — the program on the wire.
  const writes: WireWrite[] = [];
  const recording = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") {
      writes.push(JSON.parse(init.body) as WireWrite);
    }
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", recording);
  if (opts.catalog ?? true) await seedCatalog(db);
  if (opts.connected ?? true) await connect(db, userId, server);
  const app = mountRoutes(db, "/api/coros", corosRoutes);
  const post = (body: unknown, env: Env = makeEnv()) =>
    app.request(
      "/api/coros/spike/unmapped-moves",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  const today = todayInZone(prefs.timezone);
  return { db, userId, prefs, server, writes, post, today };
}

/** A logged-in client straight onto the mock, for planting leftovers. */
async function plantingClient(server: Server): Promise<CorosClient> {
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
  await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
  return client;
}

const programNames = (server: Server): string[] =>
  (server.state.schedule.programs ?? []).map((p) => String(p.name ?? ""));

interface Body {
  stored: Array<{
    step: string;
    about: string;
    sent: {
      name: string | null;
      originId: string | null;
      overview: string | null;
      targetType: number | null;
      targetValue: number | null;
    };
    storedName: string | null;
    storedOriginId: string | null;
    storedOverview: string | null;
    storedTarget: { targetType: number | null; targetValue: number | null } | null;
    changed: string[];
  }>;
  deleted: boolean;
  notes: string[];
}

describe("POST /api/coros/spike/unmapped-moves — the gate", () => {
  it("is a 404 without the exact confirm body, and touches nothing", async () => {
    const { server, writes, post } = await setup();
    const loginsBefore = server.counts.login;
    const queriesBefore = server.counts.scheduleQuery;
    for (const body of [
      undefined,
      "not json",
      {},
      { confirm: "yes" },
      { confirm: "Write a test workout" },
      { ...CONFIRM, extra: true },
      [CONFIRM],
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    expect(writes).toHaveLength(0);
    expect(server.counts.scheduleWrites).toBe(0);
    expect(server.counts.scheduleQuery).toBe(queriesBefore);
    expect(server.counts.login).toBe(loginsBefore);
  });

  it("is a 404 when COROS writes are disabled for the account, even with the confirm body", async () => {
    const { server, writes, post } = await setup({ writesEnabled: false });
    const queriesBefore = server.counts.scheduleQuery;
    const res = await post(CONFIRM);
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
    expect(server.counts.scheduleQuery).toBe(queriesBefore);
  });

  it("is a 404 in fixture mode", async () => {
    const { writes, post } = await setup();
    const res = await post(CONFIRM, makeEnv({ FIXTURE_MODE: "1" }));
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("refuses clearly, before any COROS call, when the catalog lacks T1121", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { corosWritesEnabled: true });
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const server = mockCorosServer();
    vi.stubGlobal("fetch", server.fetchImpl);
    await seedCatalog(db, CATALOG_ROWS.filter(([, name]) => name !== "T1121"));
    await connect(db, userId, server);
    const queriesBefore = server.counts.scheduleQuery;
    const app = mountRoutes(db, "/api/coros", corosRoutes);
    const res = await app.request(
      "/api/coros/spike/unmapped-moves",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(CONFIRM),
      },
      makeEnv(),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("catalog_incomplete");
    expect(body.message).toMatch(/T1121/);
    expect(server.counts.scheduleQuery).toBe(queriesBefore);
    expect(server.counts.scheduleWrites).toBe(0);
  });

  it("says not_connected without a COROS connection", async () => {
    const { writes, post } = await setup({ connected: false });
    const res = await post(CONFIRM);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    expect(writes).toHaveLength(0);
  });

  it("waits its turn behind another COROS write for the athlete", async () => {
    const { db, userId, writes, post } = await setup();
    expect(await claimUserLock(db, userId, "coros_write", 10)).toBeTruthy();
    const res = await post(CONFIRM);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(writes).toHaveLength(0);
  });
});

describe("POST /api/coros/spike/unmapped-moves — the run", () => {
  it("creates the four-question program, reads it back, deletes it, and reports per step", async () => {
    const { server, writes, post, today } = await setup();
    const date = addDays(today, 14);
    const stamp = spikeStamp(today);
    const entitiesBefore = server.state.schedule.entities!.length;
    const foreignNames = [
      ...programNames(server),
      ...server.state.schedule.entities!.map((e) => String(e.name ?? "")),
      String(server.state.schedule.name ?? ""),
    ].filter((n) => n.length > 0);
    expect(foreignNames.length).toBeGreaterThan(3);

    const res = await post(CONFIRM);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Body;

    // One create, one delete — nothing else written.
    expect(writes.map((w) => w.versionObjects[0]!.status)).toEqual([1, 3]);

    // The program on the wire is buildSpikeProgram's, placed 14 days out.
    const create = writes[0]!;
    expect(create.entities![0]!.happenDay).toBe(localDateToCorosDay(date));
    const onWire = create.programs![0]!;
    expect(onWire.name).toBe(stamp);
    const expected = buildSpikeProgram({
      happenDay: String(localDateToCorosDay(date)),
      name: stamp,
      catalog: new Map(CATALOG_ROWS),
      genericTrainingOriginId: GENERIC_ID,
      exerciseOriginId: BIRD_DOG_ID,
    });
    expect(onWire.exercises).toEqual(expected.exercises);

    // Per step: what was sent, and (the mock echoing) the same stored.
    expect(body.stored.map((s) => s.step)).toEqual(["a", "b", "c", "d1", "d2"]);
    expect(body.stored.map((s) => s.sent)).toEqual([
      { name: "Chin tuck hold", originId: "0", overview: "", targetType: 2, targetValue: 30 },
      { name: "Chin tuck hold (generic)", originId: GENERIC_ID, overview: "", targetType: 2, targetValue: 30 },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "cue: long neck", targetType: 3, targetValue: 8 },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "each side", targetType: 3, targetValue: 8 },
      { name: "T1150", originId: BIRD_DOG_ID, overview: "each side", targetType: 3, targetValue: 8 },
    ]);
    for (const step of body.stored) {
      expect(step.changed).toEqual([]);
      expect(step.storedName).toBe(step.sent.name);
      expect(step.storedOriginId).toBe(step.sent.originId);
      expect(step.storedOverview).toBe(step.sent.overview);
      expect(step.storedTarget).toEqual({
        targetType: step.sent.targetType,
        targetValue: step.sent.targetValue,
      });
    }

    // Deleted, verified on a fresh read, and nothing else touched.
    expect(body.deleted).toBe(true);
    expect(body.notes.some((n) => n.startsWith("create: ok"))).toBe(true);
    expect(body.notes.some((n) => n.startsWith("delete: ok"))).toBe(true);
    expect(body.notes).toContain("fresh read: no workout carries the spike stamp");
    expect(programNames(server)).not.toContain(stamp);
    expect(server.state.schedule.entities!.length).toBe(entitiesBefore);

    // Our own test strings only: no other workout, the plan, or the account.
    for (const name of foreignNames) {
      expect(text, `leaked "${name}"`).not.toContain(name);
    }
    expect(text).not.toContain(FIXTURE_PLAN_ID);
    expect(text).not.toContain(server.email);
    expect(text).not.toContain(server.userId);
  });

  it("clears a leftover spike workout first — exact stamps only — then runs clean", async () => {
    const { server, writes, post, today } = await setup();
    const date = addDays(today, 14);
    const stamp = spikeStamp(today);
    const client = await plantingClient(server);
    const catalog = new Map(CATALOG_ROWS);
    const plant = async (name: string, on: string) => {
      const inputs = {
        happenDay: String(localDateToCorosDay(on)),
        name,
        catalog,
        genericTrainingOriginId: GENERIC_ID,
        exerciseOriginId: BIRD_DOG_ID,
      };
      const { session, catalog: spikeCatalog } = spikeWorkout(inputs);
      const res = await createWorkout(client, { happenDay: inputs.happenDay, name, session }, {
        catalog: spikeCatalog,
        today,
      });
      expect(res.ok).toBe(true);
    };
    // A run that died before its delete: today's stamp, on the target day.
    await plant(stamp, date);
    // An older spike's leftover on another day.
    const staleStamp = spikeStamp(addDays(today, -2));
    await plant(staleStamp, addDays(today, 12));
    // Carries the prefix but is NOT a spike stamp: never touched.
    const decoy = `${SPIKE_STAMP_PREFIX} ${today} — keep me`;
    const decoySession = coachSessionSchema.parse({
      category: "strength",
      title: "Decoy",
      durationMinutes: 10,
      lift: { exercises: [{ name: "Bird Dog", originId: BIRD_DOG_ID, sets: 1, reps: 5 }] },
    });
    const planted = await createWorkout(
      client,
      { happenDay: String(localDateToCorosDay(addDays(today, 13))), name: decoy, session: decoySession },
      { catalog: new Map([[BIRD_DOG_ID, "T1150"]]), today },
    );
    expect(planted.ok).toBe(true);
    expect(programNames(server).filter((n) => n === stamp)).toHaveLength(1);
    const entitiesBefore = server.state.schedule.entities!.length;
    writes.length = 0;

    const res = await post(CONFIRM);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    expect(body.notes).toContain(`cleanup: spike workout on ${date} deleted`);
    expect(body.notes).toContain(`cleanup: spike workout on ${addDays(today, 12)} deleted`);
    // Two cleanups, then the run's own create and delete.
    expect(writes.map((w) => w.versionObjects[0]!.status)).toEqual([3, 3, 1, 3]);
    expect(body.stored.every((s) => s.changed.length === 0)).toBe(true);
    expect(body.deleted).toBe(true);

    const after = programNames(server);
    expect(after).not.toContain(stamp);
    expect(after).not.toContain(staleStamp);
    expect(after).toContain(decoy);
    // Both leftovers gone, the decoy and every foreign workout still there.
    expect(server.state.schedule.entities!.length).toBe(entitiesBefore - 2);
  });

  it("reports an honest failure and leaves nothing behind when the create never materializes", async () => {
    const { server, post } = await setup();
    // Accepted with 0000, never stored — the executor's `not_visible`.
    server.addSilentlyFails = true;
    const res = await post(CONFIRM);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.notes.some((n) => n.startsWith("create: failed") && n.includes("not_visible"))).toBe(true);
    expect(body.stored.every((s) => s.changed.join() === "not stored" && s.storedName === null)).toBe(true);
    expect(body.notes).toContain("fresh read: no workout carries the spike stamp");
    expect(body.deleted).toBe(true);
  });
});
