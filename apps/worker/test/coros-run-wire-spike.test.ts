/**
 * The owner-gated run-wire live check (§8 phase 2): `POST /api/coros/spike/run-wire` writes ONE stamped run program 14
 * days out through the production create executor — `v1`, phase 1's flat interval topology, or `v2`, a repeat group with
 * distance steps — reads it back, deletes it through the verified delete path, confirms the deletion with a fresh read,
 * and reports per step what was sent and what COROS stored. The variant picks the builder, whatever `RUN_WIRE_V2` says.
 *
 * Against the mocks: the echoing one proves the plumbing and the report's shape; the renormalizing one shows the report
 * naming what a COROS changed on save. What real COROS keeps is what the owner's live run is for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { CorosClient, createWorkout, spikeStamp } from "@rg/coros";
import { localDateToCorosDay, type RawCorosProgram } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { connectCoros } from "../src/services/coros-connection.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const RUN = (variant: string) => ({ confirm: "write a test run", variant });
const CLEANUP = { confirm: "remove test workouts" };

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret", TOKEN_ENCRYPTION_KEY: TEST_KEY, ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
    ...overrides,
  } as Env;
}

afterEach(() => vi.unstubAllGlobals());

type Server = ReturnType<typeof mockCorosServer>;

async function setup(opts: { writesEnabled?: boolean; renormalizing?: boolean; threshold?: number } = {}) {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: opts.writesEnabled ?? true });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const server: Server = opts.renormalizing ? renormalizingCoros() : mockCorosServer();
  const writes: Array<{ programs?: RawCorosProgram[]; versionObjects: Array<{ status: number }> }> = [];
  const recording = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") writes.push(JSON.parse(init.body));
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", recording);
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  const today = todayInZone(prefs.timezone);
  if (opts.threshold) {
    await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: today, thresholdPaceSecPerKm: opts.threshold, contentFingerprint: "h", updatedAt: nowInstant() });
  }
  const app = mountRoutes(db, "/api/coros", corosRoutes);
  const post = (body: unknown, env: Env = makeEnv()) =>
    app.request(
      "/api/coros/spike/run-wire",
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) },
      env,
    );
  return { db, userId, prefs, server, writes, post, today };
}

const programNames = (server: Server): string[] => (server.state.schedule.programs ?? []).map((p) => String(p.name ?? ""));
const creates = (writes: Array<{ programs?: RawCorosProgram[]; versionObjects: Array<{ status: number }> }>) =>
  writes.filter((w) => w.versionObjects[0]?.status === 1).flatMap((w) => w.programs ?? []);

interface StepReport {
  step: number;
  sent: Record<string, unknown>;
  stored: Record<string, unknown> | null;
  changed: string[];
}
interface Body {
  variant: "v1" | "v2";
  thresholdSecPerKm: number;
  steps: StepReport[];
  totals: { sent: Record<string, unknown>; stored: Record<string, unknown> | null };
  contentDelta: string | null;
  deleted: boolean;
  notes: string[];
}

describe("POST /api/coros/spike/run-wire — the gate", () => {
  it("is a 404 without the exact confirm body and a variant, and touches nothing", async () => {
    const { server, writes, post } = await setup();
    for (const body of [undefined, "not json", {}, { confirm: "write a test run" }, RUN("v3"), { ...RUN("v1"), extra: true }, { confirm: "Write a test run", variant: "v1" }, [RUN("v1")]]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(404);
    }
    expect(writes).toHaveLength(0);
    expect(server.counts.scheduleWrites).toBe(0);
  });

  it("is a 404 with COROS writes off, or in fixture mode", async () => {
    const off = await setup({ writesEnabled: false });
    expect((await off.post(RUN("v2"))).status).toBe(404);
    const on = await setup();
    expect((await on.post(RUN("v2"), makeEnv({ FIXTURE_MODE: "1" }))).status).toBe(404);
    expect(on.writes).toHaveLength(0);
  });

  it("refuses while an earlier spike's workout is still on COROS — nothing written — and the cleanup body removes it", async () => {
    const { server, writes, post, today } = await setup();
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const on = addDays(today, 5);
    const left = await createWorkout(
      client,
      { happenDay: String(localDateToCorosDay(on)), name: spikeStamp(addDays(today, -1)), session: { kind: "run_watch", title: "Left", segments: [{ rounds: 1, steps: [{ role: "work", effort: "easy", target: { kind: "time", seconds: 600 } }] }] } },
      { catalog: new Map(), today },
    );
    expect(left.ok).toBe(true);
    const before = writes.length;
    const refused = await post(RUN("v2"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "leftovers", count: 1, cleanup: CLEANUP });
    expect(writes.length).toBe(before);
    const cleanup = await post(CLEANUP);
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toMatchObject({ found: 1, removed: 1, remaining: 0 });
    expect(programNames(server).filter((n) => n.startsWith("RG SPIKE"))).toEqual([]);
  });
});

describe("POST /api/coros/spike/run-wire — the run", () => {
  it("v2: one stamped program 14 days out — a group of 800 m with its pace and a bare 90 s, a 2 km cool-down — read back, deleted, gone", async () => {
    const { server, writes, post, today } = await setup({ threshold: 289 });
    const res = await post(RUN("v2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ variant: "v2", thresholdSecPerKm: 289, deleted: true, contentDelta: null });
    // The program on the wire: the stamp, 14 days out, v2's group and distances.
    const [sent] = creates(writes);
    expect(sent!.name).toBe(spikeStamp(today));
    expect(sent!.exercises!.map((e) => [e.exerciseType, e.isGroup, e.sets, e.targetType, e.targetValue])).toEqual([
      [1, false, 1, 2, 600],
      [0, true, 3, 2, Math.round(0.8 * 276.5) + 90],
      [2, false, 1, 5, 80000],
      [4, false, 1, 2, 90],
      [3, false, 1, 5, 200000],
    ]);
    // The report: every field asked for, sent and stored, per step; nothing changed on an echoing COROS.
    expect(body.steps).toHaveLength(5);
    const FIELDS = ["exerciseType", "name", "originId", "targetType", "targetValue", "intensityType", "intensityValue", "intensityValueExtend", "intensityMultiplier", "intensityDisplayUnit", "isGroup", "sets", "group"];
    for (const s of body.steps) {
      expect(Object.keys(s.sent).sort()).toEqual([...FIELDS].sort());
      expect(Object.keys(s.stored!).sort()).toEqual([...FIELDS].sort());
      expect(s.changed).toEqual([]);
    }
    expect(body.steps[2]!.sent).toMatchObject({ targetType: 5, targetValue: 80000, intensityType: 3, intensityValue: 269_000, intensityValueExtend: 284_000, intensityMultiplier: 1000, intensityDisplayUnit: 2, group: 2 });
    expect(body.steps[3]!.sent).toMatchObject({ exerciseType: 4, intensityType: 5, group: 2 });
    expect(Object.keys(body.totals.stored!).sort()).toEqual(["distance", "duration", "estimatedDistance", "estimatedTime", "exerciseNum", "totalSets"]);
    // Deleted, and a fresh read finds nothing carrying the stamp.
    expect(programNames(server).filter((n) => n.startsWith("RG SPIKE"))).toEqual([]);
    // Only our own strings: the stamp and the step names this app writes.
    const names = new Set(body.steps.flatMap((s) => [s.sent.name, s.stored?.name]));
    expect([...names].every((n) => ["Warm up", "Group", "Run", "Recover", "Cool down"].includes(String(n)))).toBe(true);
  });

  it("v1: phase 1's flat intervals and one 20 s strides step, whatever the switch says", async () => {
    const { writes, post } = await setup({ threshold: 289 });
    const res = await post(RUN("v1"), makeEnv({ RUN_WIRE_V2: "1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ variant: "v1", deleted: true });
    const [sent] = creates(writes);
    expect(sent!.exercises!.every((e) => e.isGroup === false && e.targetType === 2)).toBe(true);
    expect(sent!.exercises!.map((e) => [e.exerciseType, e.targetValue])).toEqual([[1, 600], [2, 180], [4, 90], [2, 180], [4, 90], [2, 180], [4, 90], [2, 20], [3, 600]]);
    // …and v2 is v2 with the switch off.
    const v2 = await setup({ threshold: 289 });
    expect((await v2.post(RUN("v2"))).status).toBe(200);
    expect(creates(v2.writes)[0]!.exercises!.some((e) => e.isGroup)).toBe(true);
  });

  it("with no threshold known, a stand-in pace (5:00 /km) so the bands are on the wire to read — said in the report", async () => {
    const { post } = await setup();
    const body = (await (await post(RUN("v2"))).json()) as Body;
    expect(body.thresholdSecPerKm).toBe(300);
    expect(body.notes.some((n) => /no threshold.*300/.test(n))).toBe(true);
  });

  it("against a COROS that re-encodes what it stores, the report names what changed: the group's own target, the server's totals", async () => {
    const { post } = await setup({ renormalizing: true, threshold: 289 });
    const body = (await (await post(RUN("v2"))).json()) as Body;
    expect(body.deleted).toBe(true);
    // The container's seconds a round are the server's; its link and every child's fields are as sent.
    expect(body.steps[1]!.changed).toEqual(["targetValue"]);
    expect(body.steps.filter((s, i) => i !== 1).every((s) => s.changed.length === 0)).toBe(true);
    expect(body.totals.stored!.duration).not.toBe(body.totals.sent.duration);
    // The create's own read-back sets those aside: nothing to say.
    expect(body.contentDelta).toBeNull();
  });
});
