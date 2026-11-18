/**
 * THE QA ACCOUNT'S ROUTES (routes/qa.ts) AND THE PHONE'S WHOLE FLOW ON IT: owner's cookie only (any other account, a device
 * token, the harness token — refused); create, seed, mint, read, purge; the harness token's own door (`/api/qa/run/*`); the
 * plan door reading the QA account's plan with its plan token; and the phone, paired to the QA account, doing what the
 * on-device suite does — today's day, a move later today, a skip and an unskip, Build, Start and the save — then the state
 * read saying exactly that, the purge, and zero rows. The owner's account is hashed before and after: unchanged. Through
 * the real route modules on the repo's migrations, D1's bind cap on, `fetch` refused, the clock held at midday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, performedSessionSaveSchema } from "@rg/domain";
import { sha256Hex } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { lifeosRoutes } from "../src/routes/lifeos.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { qaRoutes } from "../src/routes/qa.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { tableHashes } from "../src/services/parity.js";
import { qaHarnessToken, QA_EMAIL } from "../src/services/qa-account.js";
import { seedFullAccount } from "./account-fixture.js";
import { makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { users } = schema;
const OWNER_PLAN_TOKEN = "a".repeat(64);

let today: string;
let w: NativeWorld;
let fetched: string[];

beforeEach(async () => {
  today = pinMiddayToday();
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    throw new Error("no external call in the QA account's tests");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/qa", qaRoutes],
      ["/api/native", nativeRoutes],
      ["/api/plan", planRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/lifeos", lifeosRoutes],
    ],
    { env: { LIFEOS_TOKEN_SHA256: await sha256Hex(OWNER_PLAN_TOKEN), WATCH_PUSH_ENABLED: "1" } },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const owner = (method: string, path: string, body?: unknown) => w.call(method, `/api/qa${path}`, body === undefined ? {} : { body });
const harness = (method: string, path: string, token: string, body?: unknown) =>
  w.call(method, `/api/qa/run${path}`, { cookie: false, headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) });

/** Create, seed and mint through the owner's routes: the minted answer and the seeded fixtures. */
async function setUp(): Promise<{ minted: Record<string, any>; fixtures: Array<Record<string, any>> }> {
  expect((await owner("POST", "/user")).status).toBe(201);
  const seeded = await owner("POST", "/seed");
  expect(seeded.status, seeded.text).toBe(200);
  const minted = await owner("POST", "/pairings");
  expect(minted.status, minted.text).toBe(200);
  return { minted: minted.json, fixtures: seeded.json.fixtures };
}

describe("the owner's routes: the owner's cookie only", () => {
  const ROUTES: Array<[string, string, unknown?]> = [
    ["GET", "/status"],
    ["POST", "/user"],
    ["POST", "/seed"],
    ["POST", "/setup"],
    ["POST", "/pairings"],
    ["GET", "/state"],
    ["POST", "/purge", { confirm: "purge qa" }],
  ];

  it("another signed-in account gets 404 on each, and nothing is written", async () => {
    const { userId: other } = await makeTestUser(w.db);
    const cookie = `${SESSION_COOKIE}=${await createSession(w.db, other, "test")}`;
    for (const [method, path, body] of ROUTES) {
      const a = await w.call(method, `/api/qa${path}`, { cookie, ...(body === undefined ? {} : { body }) });
      expect([path, a.status]).toEqual([path, 404]);
      expect(a.writes.filter((s) => !/sessions/.test(s))).toEqual([]);
    }
    expect(await w.db.select().from(users).where(eq(users.email, QA_EMAIL))).toEqual([]);
  });

  it("a device token gets 403 out_of_scope on each — the QA account's own phone included", async () => {
    const { minted } = await setUp();
    const { token } = (await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.code, label: "QA" } })).json;
    const { token: ownerPhone } = await seedDevice(w.db, w.userId, { scope: "training-v3" });
    for (const bearer of [token, ownerPhone]) {
      for (const [method, path, body] of ROUTES) {
        const a = await w.call(method, `/api/qa${path}`, { bearer, ...(body === undefined ? {} : { body }) });
        expect([path, a.status, a.json]).toEqual([path, 403, { error: "out_of_scope" }]);
      }
    }
  });

  it("anonymous: 401, as every signed-in route", async () => {
    for (const [method, path] of ROUTES) expect((await w.call(method, `/api/qa${path}`, { cookie: false })).status).toBe(401);
  });

  it("where the owner's address is the QA address, every route is 404", async () => {
    for (const [method, path, body] of ROUTES) {
      const a = await w.call(method, `/api/qa${path}`, { env: { ALLOWED_GOOGLE_EMAIL: QA_EMAIL }, ...(body === undefined ? {} : { body }) });
      expect([path, a.status]).toEqual([path, 404]);
    }
  });
});

describe("the owner's routes: create, seed, mint, read, purge", () => {
  it("status says none; create, seed and mint; status and state say what is there", async () => {
    expect((await owner("GET", "/status")).json).toMatchObject({ qa: null });
    const { minted, fixtures } = await setUp();
    expect(minted).toMatchObject({ code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/), scope: "training-v3", planToken: expect.stringMatching(/^[0-9a-f]{64}$/), harnessToken: expect.stringMatching(/^rgq_/) });
    expect(fixtures.map((f) => f.title)).toEqual(["QA Hips and back", "QA Mobility", "QA Mobility", "QA Easy run", "QA Core reset"]);
    const status = (await owner("GET", "/status")).json;
    expect(status).toMatchObject({ qa: { userId: expect.any(String), accountTag: expect.stringMatching(/^[0-9a-f]{8}$/) }, today, devices: [] });
    expect(status.qa.userId).not.toBe(w.userId);
    expect(status.rows).toBeGreaterThan(5);
    const state = (await owner("GET", "/state")).json;
    expect(state.plan.map((p: { title: string }) => p.title).sort()).toEqual(fixtures.map((f) => f.title).sort());
    expect(state.providers).toEqual({ connections: 0, corosWriteJobs: 0, calendarEventLinks: 0, studioPlanPushes: 0, syncRuns: 0, syncIntents: expect.any(Number) });
  });

  it("refuses a second create (409 qa_exists) and a second seed (409 already_seeded); seed and mint need an account (404)", async () => {
    expect((await owner("POST", "/seed")).json).toEqual({ error: "no_qa_account" });
    expect((await owner("POST", "/pairings")).status).toBe(404);
    await setUp();
    expect([(await owner("POST", "/user")).status, (await owner("POST", "/user")).json]).toEqual([409, { error: "qa_exists" }]);
    expect((await owner("POST", "/seed")).json).toEqual({ error: "already_seeded" });
  });

  it("setup does create, seed and mint in one, and again only mints", async () => {
    const first = await owner("POST", "/setup");
    expect(first.status, first.text).toBe(200);
    expect(first.json).toMatchObject({ created: true, seeded: true, code: expect.any(String), harnessToken: expect.stringMatching(/^rgq_/) });
    const again = await owner("POST", "/setup");
    expect(again.json).toMatchObject({ created: false, seeded: false, code: expect.any(String) });
  });

  it("purge asks for its words, then removes everything and says zero; the owner's account is as it was", async () => {
    await seedFullAccount(w.db, w.userId);
    const before = await tableHashes(w.db, w.userId);
    await setUp();
    expect((await owner("POST", "/purge", {})).json).toEqual({ error: "confirmation_required" });
    const purged = await owner("POST", "/purge", { confirm: "purge qa" });
    expect(purged.status, purged.text).toBe(200);
    expect(purged.json.total).toBe(0);
    expect(purged.json.removed.planned_workouts).toBe(5);
    expect((await owner("GET", "/status")).json.qa).toBeNull();
    expect(await tableHashes(w.db, w.userId)).toEqual(before);
    expect((await owner("POST", "/purge", { confirm: "purge qa" })).status).toBe(404);
  });
});

describe("the harness token's door: /api/qa/run/*", () => {
  it("reads the state, mints a fresh code, purges, and verifies zero — the last still answering once the account is gone", async () => {
    const { minted } = await setUp();
    const token = minted.harnessToken as string;
    const state = await harness("GET", "/state", token);
    expect([state.status, state.json.plan.length]).toEqual([200, 5]);
    const fresh = await harness("POST", "/pairings", token);
    expect(fresh.json).toMatchObject({ code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/) });
    expect((await harness("POST", "/purge", token, {})).json).toEqual({ error: "confirmation_required" });
    const purged = await harness("POST", "/purge", token, { confirm: "purge qa" });
    expect([purged.status, purged.json.total]).toEqual([200, 0]);
    const verify = await harness("GET", "/verify", token);
    expect(verify.json).toMatchObject({ exists: false, total: 0 });
    expect(Object.values(verify.json.rows as Record<string, number>).every((n) => n === 0)).toBe(true);
    for (const [method, path] of [["GET", "/state"], ["POST", "/pairings"], ["POST", "/purge"]] as const) {
      expect((await harness(method, path, token, method === "POST" ? { confirm: "purge qa" } : undefined)).json).toEqual({ error: "no_qa_account" });
    }
  });

  it("refuses anything but a genuine live harness token: 401, the same as none", async () => {
    const { minted } = await setUp();
    const { token: phone } = (await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.code, label: "QA" } })).json;
    const qaId = (await owner("GET", "/status")).json.qa.userId as string;
    const bad = [
      phone,
      minted.planToken,
      OWNER_PLAN_TOKEN,
      (minted.harnessToken as string).replace(/.$/, (c: string) => (c === "0" ? "1" : "0")),
      await qaHarnessToken({ SESSION_SECRET: "another" }, qaId, Date.now() + 60_000),
      await qaHarnessToken(w.env, w.userId, Date.now() + 60_000).then((t) => t.replace(w.userId, qaId)),
      await qaHarnessToken(w.env, qaId, Date.now() - 1_000),
    ];
    for (const t of bad) {
      expect((await harness("GET", "/state", t)).json).toEqual({ error: "unauthenticated" });
      expect((await harness("POST", "/purge", t, { confirm: "purge qa" })).status).toBe(401);
    }
    // The owner's cookie is no harness token either.
    expect((await w.call("GET", "/api/qa/run/state")).status).toBe(401);
    expect((await owner("GET", "/status")).json.qa.userId).toBe(qaId);
  });

  it("a harness token minted for the owner's id (as no route mints) names no QA account: 404, nothing purged", async () => {
    await seedFullAccount(w.db, w.userId);
    const before = await tableHashes(w.db, w.userId);
    const forged = await qaHarnessToken(w.env, w.userId, Date.now() + 60_000);
    expect((await harness("POST", "/purge", forged, { confirm: "purge qa" })).json).toEqual({ error: "no_qa_account" });
    expect((await harness("GET", "/verify", forged)).json).toEqual({ error: "no_qa_account" });
    expect(await tableHashes(w.db, w.userId)).toEqual(before);
  });
});

describe("the plan door: /api/lifeos/plan", () => {
  it("the QA plan token reads the QA account's plan; the owner's token the owner's; after the purge the QA token is 401", async () => {
    const { minted } = await setUp();
    const read = (token: string) =>
      w.call("GET", `/api/lifeos/plan?from=${today}&to=${today}`, { cookie: false, headers: { Authorization: `Bearer ${token}` } });
    const qa = await read(minted.planToken);
    expect(qa.status, qa.text).toBe(200);
    expect(qa.json.days[0].sessions.map((s: { title: string }) => s.title)).toEqual(["QA Hips and back", "QA Mobility", "QA Easy run"]);
    const own = await read(OWNER_PLAN_TOKEN);
    expect([own.status, own.json.days[0].sessions]).toEqual([200, []]);
    await owner("POST", "/purge", { confirm: "purge qa" });
    expect((await read(minted.planToken)).status).toBe(401);
    expect((await read(OWNER_PLAN_TOKEN)).status).toBe(200);
  });

  it("without the owner's secret the endpoint doesn't exist, for the QA token too", async () => {
    const { minted } = await setUp();
    const a = await w.call("GET", `/api/lifeos/plan?from=${today}&to=${today}`, {
      cookie: false,
      headers: { Authorization: `Bearer ${minted.planToken}` },
      env: { LIFEOS_TOKEN_SHA256: undefined },
    });
    expect(a.status).toBe(404);
  });
});

describe("the phone's whole flow on the QA account, as the on-device suite runs it", () => {
  it("pair, today, move later today, skip, unskip, Build, Start, save — the state says exactly that, then the purge leaves zero", async () => {
    await seedFullAccount(w.db, w.userId);
    const ownerBefore = await tableHashes(w.db, w.userId);
    const { minted, fixtures } = await setUp();
    const hips = fixtures.find((f) => f.title === "QA Hips and back")!;
    const paired = await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.code, label: "LifeOS phone" } });
    expect([paired.status, paired.json.state]).toEqual([200, "pending"]);
    const token = paired.json.token as string;
    const as = (method: string, path: string, body?: unknown) => w.call(method, path, { bearer: token, ...(body === undefined ? {} : { body }) });

    expect((await as("GET", "/api/native/me")).json.device.scope).toBe("training-v3");
    const day = (await as("GET", "/api/native/today")).json;
    expect(day.sessions.map((s: { title: string }) => s.title)).toEqual(["QA Hips and back", "QA Mobility", "QA Easy run"]);

    // Move later today, from where the phone saw it.
    const to = `${String(Number(hips.time.slice(0, 2)) + 1).padStart(2, "0")}:15`;
    const moved = await as("POST", `/api/plan/workouts/${hips.id}/move`, { toDate: today, toTime: to, from: { date: today, time: hips.time } });
    expect(moved.status, moved.text).toBe(200);
    expect((await as("POST", `/api/plan/workouts/${hips.id}/skip`)).json).toEqual({ ok: true });
    expect((await as("POST", `/api/plan/workouts/${hips.id}/unskip`)).json).toEqual({ ok: true });

    const built = await as("POST", `/api/sessions/${hips.id}/build`, {});
    expect(built.status, built.text).toBe(200);
    const b = built.json.build;
    expect((await as("POST", `/api/sessions/${hips.id}/start`, { buildId: b.buildId })).status).toBe(200);
    const items = (b.items ?? []) as Array<{ exerciseId: string; slotKey?: string }>;
    const performedId = newId();
    const save = performedSessionSaveSchema.parse({
      id: performedId, source: "app", sourceRef: null, workoutId: hips.id, buildId: b.buildId, localDate: b.date,
      startedAt: new Date(Date.now() - 600_000).toISOString(), endedAt: new Date().toISOString(), seconds: 600, plannedSeconds: b.plannedSeconds ?? null,
      minutes: b.minutes ?? null, mode: b.mode ?? null, theme: b.theme ?? null, locationId: b.locationId ?? null, blockRef: b.blockRef ?? null,
      blockNumber: null, completed: true, stepsTotal: (b.steps ?? []).length || null, stepsDone: (b.steps ?? []).length || null,
      movesDone: items.map((i) => ({ exerciseId: i.exerciseId, seconds: 60, ...(i.slotKey ? { slotKey: i.slotKey } : {}) })),
      note: null, newMove: b.newMove ?? null,
      entries: items.length > 0 ? [{ exerciseId: items[0]!.exerciseId, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }] }] : [],
      checks: [], review: {},
    });
    const saved = await as("PUT", `/api/sessions/performed/${performedId}`, save);
    expect([saved.status, saved.json.status]).toEqual([200, "saved"]);

    const state = (await harness("GET", "/state", minted.harnessToken)).json;
    const row = state.plan.find((p: { id: string }) => p.id === hips.id);
    expect(row).toMatchObject({ date: today, time: to, state: "completed", contentState: "done" });
    expect(state.audits.filter((a: { kind: string }) => a.kind === "workout_moved")).toEqual([expect.objectContaining({ workoutId: hips.id })]);
    // The seed's time, the move's (a move within the day is a time change, to its new time), and the unskip's restore.
    const overrides = state.overrides.filter((o: { workoutId: string }) => o.workoutId === hips.id) as Array<{ kind: string; toTime: string | null }>;
    expect(overrides.map((o) => o.kind).sort()).toEqual(["restore", "time_change", "time_change"]);
    expect(overrides.filter((o) => o.kind === "time_change").map((o) => o.toTime).sort()).toEqual([hips.time, to].sort());
    expect(state.performed).toEqual([expect.objectContaining({ id: performedId, workoutId: hips.id, completed: true, source: "app" })]);
    expect(state.matches).toEqual([expect.objectContaining({ workoutId: hips.id, activityId: performedId, method: "app_session", undoneAt: null })]);
    expect(state.devices).toEqual([expect.objectContaining({ state: "active", scope: "training-v3", label: "LifeOS phone" })]);
    expect(state.providers).toMatchObject({ connections: 0, corosWriteJobs: 0, calendarEventLinks: 0, studioPlanPushes: 0, syncRuns: 0 });
    expect(fetched).toEqual([]);

    const purged = await harness("POST", "/purge", minted.harnessToken, { confirm: "purge qa" });
    expect([purged.status, purged.json.total]).toEqual([200, 0]);
    expect((await harness("GET", "/verify", minted.harnessToken)).json.total).toBe(0);
    expect((await as("GET", "/api/native/me")).status).toBe(401);
    expect(await tableHashes(w.db, w.userId)).toEqual(ownerBefore);
  });
});
