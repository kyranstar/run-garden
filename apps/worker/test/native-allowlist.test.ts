/**
 * EACH DEVICE SCOPE AGAINST EVERY ROUTE THE APP MOUNTS, EVERY METHOD (SLICE-CONTRACT revision 2 §10.3; stage 2 DESIGN §5.1).
 *
 * `ROUTE_CLASSES` (native-allowlist.routes.ts) classifies each (method, path) the Worker's app mounts — `mountedRoutes()`
 * from the entry module, middleware included — under each scope, and the first test fails while the two lists differ, so
 * a route added later fails here until someone classifies it:
 *
 *  - `device`: on the scope's list. For `training-slice-v1` only the slice's eight; for `training-v2` those and stage
 *    2a's four; for `training-v3` v2's twelve and stage 2b's two document routes; for `training-v4` v3's fourteen and
 *    stage 2c's three plan reads, each probed with a query in its rule's grammar. A device of that scope reaches the
 *    handler.
 *  - `gated`: behind `requireUser`. A device of that scope is refused 403 `out_of_scope` before the handler runs.
 *  - `open`: not behind `requireUser` (sign-in, health, assets, the bridge's 410, a switch's 404 …). The device token is
 *    no credential there: a device's answer is exactly the anonymous one.
 *  - `bearer`: behind its own bearer door (LifeOS, the saves extension). The device token is not that door's token: the
 *    same 401 as anonymous.
 *
 * Then every path is probed with EVERY method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS), anonymous and with an
 * active device token of each scope, against the real default export, every switch on: wherever the anonymous request
 * reached `requireUser` (a spy on the real function says), each device must be on its scope's list or get 403
 * `out_of_scope`; wherever it did not, each device's answer must be the anonymous one. v1's list is pinned as it was
 * before v2 existed, and v2's is v1's, the same entries, plus four; v3's is v2's in v2's order with Build's and the save's
 * body rules widened (kit v0.15), plus two; v4's is v3's, the very same entries, plus three, each with a query rule (kit
 * v0.16, DESIGN-2c §2.5) — and every pair before them has none; v5's is v4's, the very same entries, plus R1's (kit v0.20,
 * DESIGN-3 §3.5), each with a body or a query rule. Synthetic data only; `fetch` stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { nativeEnv, seedDevice } from "./native-fixture.js";
import { classUnder, ROUTE_CLASSES, SCOPES, type RouteClass, type Scope } from "./native-allowlist.routes.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown, reached: false }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});
vi.mock("../src/auth/middleware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/middleware.js")>();
  return {
    ...actual,
    requireUser: async (...args: Parameters<typeof actual.requireUser>) => {
      holder.reached = true;
      return actual.requireUser(...args);
    },
  };
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

const { default: worker, mountedRoutes } = await import("../src/index.js");
const {
  DEVICE_SCOPES,
  deviceAfterSeqQuery,
  deviceAheadQuery,
  deviceApproveBody,
  deviceConversationQuery,
  deviceDeclineBody,
  deviceLibraryQuery,
  deviceMemoryBody,
  deviceMemoryPatchBody,
  devicePlaceBody,
  deviceSharingBody,
  deviceTakeBackBody,
  deviceNudgesQuery,
  deviceRunAnswerBody,
  deviceRunCreateBody,
  deviceUndoAnswerBody,
  noQuery,
  deviceBuildBody,
  deviceDaysQuery,
  deviceDocBody,
  deviceDrainBody,
  deviceFeedbackSaveBody,
  deviceHistoryQuery,
  deviceMoveBody,
  deviceRouteOf,
  deviceSaveBody,
  emptyBody,
  emptyObjectBody,
} = await import("../src/auth/device-scope.js");
const { RUN_CREATE_KEYS } = await import("../src/routes/coach-runs.js");

vi.setConfig({ testTimeout: 600_000 });

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
/** The slice, as this test holds it — independent of the implementation's lists, which are checked against it. */
const V1_PAIRS = [
  "GET /api/native/me",
  "GET /api/native/today",
  "POST /api/native/sign-out",
  "GET /api/sessions/:workoutId",
  "GET /api/sessions/:workoutId/review-basis",
  "POST /api/sessions/:workoutId/build",
  "POST /api/sessions/:workoutId/start",
  "PUT /api/sessions/performed/:id",
];
/** v2: v1 and stage 2a's plan edits and the watch drain (DESIGN §9). */
const V2_PAIRS = [
  ...V1_PAIRS,
  "POST /api/plan/workouts/:id/move",
  "POST /api/plan/workouts/:id/skip",
  "POST /api/plan/workouts/:id/unskip",
  "POST /api/sessions/watch/drain",
];
/** v3: v2 and stage 2b's document read and edit (kit v0.15). */
const V3_PAIRS = [...V2_PAIRS, "GET /api/workouts/:id/doc", "PUT /api/workouts/:id/doc"];
/** v4: v3 and stage 2c's three plan reads (kit v0.16, DESIGN-2c §2). */
const V4_PAIRS = [...V3_PAIRS, "GET /api/native/days", "GET /api/native/history", "GET /api/native/sessions/:id/ahead"];
/** v5: v4 and R1's (kit v0.20, DESIGN-3 §3.5): the coach designer's runs, conversation, proposals, drain, memory, nudges and spend. */
const V5_PAIRS = [
  ...V4_PAIRS,
  "GET /api/native/templates",
  "GET /api/native/templates/:id",
  "GET /api/native/library",
  "GET /api/native/library/:id",
  "POST /api/native/templates/:id/place",
  "POST /api/native/take-back",
  "GET /api/native/receipts/:id",
  "GET /api/native/sharing",
  "PUT /api/native/sharing",
  "POST /api/coach/runs",
  "POST /api/coach/runs/:id/step",
  "GET /api/coach/runs/current",
  "GET /api/coach/runs/:id",
  "POST /api/coach/runs/:id/answer",
  "POST /api/coach/runs/:id/cancel",
  "POST /api/coach/runs/:id/undo-answer",
  "GET /api/coach/conversation",
  "GET /api/coach/proposals/:id",
  "GET /api/coach/proposals/:id/ops/:opId/draft",
  "POST /api/coach/proposals/:id/approve",
  "POST /api/coach/proposals/:id/decline",
  "POST /api/coach/drain",
  "GET /api/coach/memory",
  "PATCH /api/coach/memory/:id",
  "DELETE /api/coach/memory/:id",
  "POST /api/coach/memory",
  "GET /api/coach/nudges",
  "GET /api/coach/spend",
];
/** Each scope's pairs. */
const DEVICE_PAIRS: Record<Scope, readonly string[]> = {
  "training-slice-v1": V1_PAIRS,
  "training-v2": V2_PAIRS,
  "training-v3": V3_PAIRS,
  "training-v4": V4_PAIRS,
  "training-v5": V5_PAIRS,
};
/**
 * A probe's body where `{}` is outside the pair's body rule: a move in its grammar (the route then answers 404), and the
 * phone's drain naming a session (which claims nothing for an id that isn't the account's).
 */
const PROBE_BODIES: Record<string, string> = {
  "POST /api/plan/workouts/:id/move": JSON.stringify({ toDate: "2026-11-20", toTime: "07:30" }),
  "POST /api/sessions/watch/drain": JSON.stringify({ workoutId: "probe-id" }),
  // A document edit in v3's grammar (the route then answers 404 for an id that isn't the account's).
  "PUT /api/workouts/:id/doc": JSON.stringify({ doc: {}, baseRev: 0 }),
  // v5's in their grammars: the routes then answer 404 or 400 for ids that aren't the account's.
  "POST /api/coach/runs/:id/undo-answer": JSON.stringify({ handle: "probe-handle" }),
  "POST /api/coach/proposals/:id/approve": JSON.stringify({ opIds: ["probe-op"], version: "0".repeat(64) }),
  "PATCH /api/coach/memory/:id": JSON.stringify({ pinned: true }),
  "POST /api/native/templates/:id/place": JSON.stringify({ date: "2026-11-20", clientId: "probe-place" }),
  "POST /api/native/take-back": JSON.stringify({ receiptIds: ["probe-receipt"], requestId: "probe-request" }),
  "PUT /api/native/sharing": JSON.stringify({ toTraining: false, disclosureVersion: "probe" }),
  "POST /api/coach/memory": JSON.stringify({ kind: "rule", body: "Probe.", clientId: "probe-memory", consent: "probe-1" }),
};
/**
 * A probe's query where a pair's query rule refuses none (DESIGN-2c §2.5): `/days` takes exactly `from` and `to` (the route
 * then answers the days, or 400 for days outside its horizon). `/history` and `/ahead` take none here.
 */
const PROBE_QUERIES: Record<string, string> = {
  "GET /api/native/days": "?from=2026-11-18&to=2026-11-18",
};

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
/** A concrete path for a route's pattern: each parameter a probe id, a wildcard a probe segment. */
const concrete = (path: string) => path.replace(/:\w+/g, "probe-id").replace(/\*/g, "__probe__");
/** Whether a concrete request is one of the scope's pairs, as the router would match the template (this test's own matcher). */
const onSlice = (scope: Scope, method: string, url: string) =>
  DEVICE_PAIRS[scope].some((pair) => {
    const [m, template] = pair.split(" ") as [string, string];
    return m === method && new RegExp(`^${template.replace(/:\w+/g, "[^/]+")}$`).test(url);
  });
/** The method a middleware entry (ALL) is observed under: one no route registers, so only middleware answers it. */
const MIDDLEWARE_PROBE = "OPTIONS";

let env: Env;
/** An active device of each scope. */
const tokens = {} as Record<Scope, string>;

beforeAll(async () => {
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  const db = makeTestDb();
  holder.db = db;
  const { userId } = await makeTestUser(db);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  // Every switch on, so every door that exists anywhere is open as far as it opens.
  env = nativeEnv({
    ALLOWED_GOOGLE_EMAIL: user!.email,
    APP_URL: "https://app.test",
    FIXTURE_MODE: "1",
    COACH_DESIGNER: "1",
    PARITY_ENABLED: "1",
    SAVES_IMPORT: "1",
    IMPORT_ENABLED: "1",
    WATCH_PUSH_ENABLED: "1",
    THREAD_COACH: "1",
    SPOTIFY_CLIENT_ID: "fixture-client",
    LIFEOS_TOKEN_SHA256: "a".repeat(64),
    SAVES_TOKEN_SHA256: "b".repeat(64),
    ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) } as unknown as Env["ASSETS"],
  });
  for (const scope of SCOPES) tokens[scope] = (await seedDevice(db, userId, { scope, expiresAt: "2099-01-01T00:00:00.000Z" })).token;
});
afterAll(() => vi.unstubAllGlobals());

interface Probe {
  status: number;
  error: string | null;
  reached: boolean;
}

async function probe(method: string, path: string, bearer?: string, body = "{}"): Promise<Probe> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const headers: Record<string, string> = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const withBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (withBody) headers["Content-Type"] = "application/json";
  holder.reached = false;
  const res = await worker.fetch(new Request(`https://app.test${path}`, { method, headers, ...(withBody ? { body } : {}) }), env, ctx);
  await Promise.allSettled(pending);
  const reached = holder.reached;
  const text = await res.text();
  let error: string | null = null;
  try {
    error = (JSON.parse(text) as { error?: unknown }).error as string | null ?? null;
    if (typeof error !== "string") error = error === null ? null : JSON.stringify(error);
  } catch {
    error = null;
  }
  // A device's own sign-out revokes it; every probe starts from the same active devices.
  await (holder.db as ReturnType<typeof makeTestDb>).update(schema.nativeDevices).set({ state: "active", revokedAt: null, revokedReason: null });
  return { status: res.status, error, reached };
}

describe("every mounted route is classified", () => {
  it("ROUTE_CLASSES names exactly the (method, path) pairs the app mounts", () => {
    const mounted = [...new Set(mountedRoutes().map(keyOf))].sort();
    const classified = Object.keys(ROUTE_CLASSES).sort();
    expect({ unclassified: mounted.filter((k) => !(k in ROUTE_CLASSES)), gone: classified.filter((k) => !mounted.includes(k)) }).toEqual({ unclassified: [], gone: [] });
  });

  it.each(SCOPES)("under %s, the device class is exactly the scope's pairs, and the implementation's list matches each and nothing else", (scope) => {
    const device = Object.entries(ROUTE_CLASSES).filter(([, c]) => classUnder(c, scope) === "device").map(([k]) => k).sort();
    expect(device).toEqual([...DEVICE_PAIRS[scope]].sort());
    // The implementation's matcher against this test's, for every mounted path under every method.
    for (const key of Object.keys(ROUTE_CLASSES)) {
      const path = key.split(" ")[1]!;
      for (const m of METHODS) expect([m, path, deviceRouteOf(scope, m, concrete(path)) !== undefined]).toEqual([m, path, onSlice(scope, m, concrete(path))]);
    }
    expect(mountedRoutes().some((r) => r.method === MIDDLEWARE_PROBE)).toBe(false);
  });

  it("v1's list is the slice exactly as it was, and v2's is v1's own entries, then four", () => {
    const v1 = DEVICE_SCOPES["training-slice-v1"];
    expect(v1.map((r) => [r.method, String(r.pattern), r.body ?? null])).toEqual([
      ["GET", String(/^\/api\/native\/me$/), null],
      ["GET", String(/^\/api\/native\/today$/), null],
      ["POST", String(/^\/api\/native\/sign-out$/), null],
      ["GET", String(/^\/api\/sessions\/[^/]+$/), null],
      ["GET", String(/^\/api\/sessions\/[^/]+\/review-basis$/), null],
      ["POST", String(/^\/api\/sessions\/[^/]+\/build$/), emptyObjectBody],
      ["POST", String(/^\/api\/sessions\/[^/]+\/start$/), null],
      ["PUT", String(/^\/api\/sessions\/performed\/[^/]+$/), deviceSaveBody],
    ]);
    const v2 = DEVICE_SCOPES["training-v2"];
    expect(v2).toHaveLength(v1.length + 4);
    v1.forEach((r, i) => expect(v2[i]).toBe(r));
    // v2's own four, as exact anchored pairs with their body rules (one path segment for the id, never more).
    expect(v2.slice(v1.length).map((r) => [r.method, String(r.pattern), r.body ?? null])).toEqual([
      ["POST", String(/^\/api\/plan\/workouts\/[^/]+\/move$/), deviceMoveBody],
      ["POST", String(/^\/api\/plan\/workouts\/[^/]+\/skip$/), emptyBody],
      ["POST", String(/^\/api\/plan\/workouts\/[^/]+\/unskip$/), emptyBody],
      ["POST", String(/^\/api\/sessions\/watch\/drain$/), deviceDrainBody],
    ]);
    expect(Object.keys(DEVICE_SCOPES).sort()).toEqual([...SCOPES].sort());
  });

  it("v3's list is v2's twelve in v2's order — the same entries but Build's and the save's, whose body rules widen — then two", () => {
    const v2 = DEVICE_SCOPES["training-v2"];
    const v3 = DEVICE_SCOPES["training-v3"];
    expect(v3).toHaveLength(v2.length + 2);
    const widened = new Map<number, unknown>([
      [5, deviceBuildBody],
      [7, deviceFeedbackSaveBody],
    ]);
    v2.forEach((r, i) => {
      if (widened.has(i)) {
        // The same pair, its body rule the wider one: never another path or method.
        expect([v3[i]!.method, String(v3[i]!.pattern), v3[i]!.body]).toEqual([r.method, String(r.pattern), widened.get(i)]);
        expect(v3[i]).not.toBe(r);
      } else expect(v3[i]).toBe(r);
    });
    // v2's own entries are untouched by v3: Build is still exactly `{}`, the save still refuses graduations and "not for me".
    expect([v2[5]!.body, v2[7]!.body]).toEqual([emptyObjectBody, deviceSaveBody]);
    expect(v3.slice(v2.length).map((r) => [r.method, String(r.pattern), r.body ?? null])).toEqual([
      ["GET", String(/^\/api\/workouts\/[^/]+\/doc$/), null],
      ["PUT", String(/^\/api\/workouts\/[^/]+\/doc$/), deviceDocBody],
    ]);
  });

  it("v4's list is v3's fourteen, the very same entries in v3's order, then the three plan reads, each with its query rule", () => {
    const v3 = DEVICE_SCOPES["training-v3"];
    const v4 = DEVICE_SCOPES["training-v4"];
    expect(v4).toHaveLength(v3.length + 3);
    // A released scope is never widened, and v4 holds v3 exactly: the same objects, so no body rule of v3's moves.
    v3.forEach((r, i) => expect(v4[i]).toBe(r));
    expect(v4.slice(v3.length).map((r) => [r.method, String(r.pattern), r.body ?? null, r.query ?? null])).toEqual([
      ["GET", String(/^\/api\/native\/days$/), null, deviceDaysQuery],
      ["GET", String(/^\/api\/native\/history$/), null, deviceHistoryQuery],
      ["GET", String(/^\/api\/native\/sessions\/[^/]+\/ahead$/), null, deviceAheadQuery],
    ]);
    // Only v4's three (and v5's own) hold a query rule: every pair of v1–v3 behaves exactly as before, its query never checked.
    for (const r of v3) expect(r.query).toBeUndefined();
  });

  it("v5's list is v4's seventeen, the very same entries in v4's order, then R1's, each with its body or query rule", () => {
    const v4 = DEVICE_SCOPES["training-v4"];
    const v5 = DEVICE_SCOPES["training-v5"];
    // A released scope is never widened: v5 holds v4 exactly, the same objects, so no rule of v4's moves.
    v4.forEach((r, i) => expect(v5[i]).toBe(r));
    expect(v5.slice(v4.length).map((r) => [r.method, String(r.pattern), r.body ?? null, r.query ?? null])).toEqual([
      ["GET", String(/^\/api\/native\/templates$/), null, noQuery],
      ["GET", String(/^\/api\/native\/templates\/[^/]+$/), null, noQuery],
      ["GET", String(/^\/api\/native\/library$/), null, deviceLibraryQuery],
      ["GET", String(/^\/api\/native\/library\/[^/]+$/), null, noQuery],
      ["POST", String(/^\/api\/native\/templates\/[^/]+\/place$/), devicePlaceBody, null],
      ["POST", String(/^\/api\/native\/take-back$/), deviceTakeBackBody, null],
      ["GET", String(/^\/api\/native\/receipts\/[^/]+$/), null, noQuery],
      ["GET", String(/^\/api\/native\/sharing$/), null, noQuery],
      ["PUT", String(/^\/api\/native\/sharing$/), deviceSharingBody, null],
      ["POST", String(/^\/api\/coach\/runs$/), deviceRunCreateBody, null],
      ["POST", String(/^\/api\/coach\/runs\/[^/]+\/step$/), emptyBody, deviceAfterSeqQuery],
      ["GET", String(/^\/api\/coach\/runs\/current$/), null, noQuery],
      ["GET", String(/^\/api\/coach\/runs\/[^/]+$/), null, deviceAfterSeqQuery],
      ["POST", String(/^\/api\/coach\/runs\/[^/]+\/answer$/), deviceRunAnswerBody, null],
      ["POST", String(/^\/api\/coach\/runs\/[^/]+\/cancel$/), emptyBody, null],
      ["POST", String(/^\/api\/coach\/runs\/[^/]+\/undo-answer$/), deviceUndoAnswerBody, null],
      ["GET", String(/^\/api\/coach\/conversation$/), null, deviceConversationQuery],
      ["GET", String(/^\/api\/coach\/proposals\/[^/]+$/), null, noQuery],
      ["GET", String(/^\/api\/coach\/proposals\/[^/]+\/ops\/[^/]+\/draft$/), null, noQuery],
      ["POST", String(/^\/api\/coach\/proposals\/[^/]+\/approve$/), deviceApproveBody, null],
      ["POST", String(/^\/api\/coach\/proposals\/[^/]+\/decline$/), deviceDeclineBody, null],
      ["POST", String(/^\/api\/coach\/drain$/), emptyBody, null],
      ["GET", String(/^\/api\/coach\/memory$/), null, noQuery],
      ["PATCH", String(/^\/api\/coach\/memory\/[^/]+$/), deviceMemoryPatchBody, null],
      ["DELETE", String(/^\/api\/coach\/memory\/[^/]+$/), emptyBody, null],
      ["POST", String(/^\/api\/coach\/memory$/), deviceMemoryBody, null],
      ["GET", String(/^\/api\/coach\/nudges$/), null, deviceNudgesQuery],
      ["GET", String(/^\/api\/coach\/spend$/), null, noQuery],
    ]);
    // Every v5 pair of its own holds a rule: none is reached with a query or a body it doesn't name.
    for (const r of v5.slice(v4.length)) expect([String(r.pattern), r.body !== undefined || r.query !== undefined]).toEqual([String(r.pattern), true]);
  });
});

describe("v5's body rules (DESIGN-3 §3.5): the shapes only, the routes check the values", () => {
  const V = "a".repeat(64);
  const j = (v: unknown) => JSON.stringify(v);
  it("approve from the phone names its ops and the version it was shown — never a bare {} or ops without the version", () => {
    for (const ok of [{ opIds: ["w1"], version: V }, { opIds: ["w1", "c:2"], version: V }, { edit: { opId: "w1", doc: {} }, version: V }, { edit: { opId: "w1", doc: {}, date: "2026-11-20", time: "07:00" }, version: V }]) {
      expect([j(ok), deviceApproveBody(j(ok))]).toEqual([j(ok), true]);
    }
    for (const bad of [{}, { opIds: ["w1"] }, { version: V }, { opIds: [], version: V }, { opIds: ["w1"], version: "v1" }, { opIds: ["w1"], version: V.toUpperCase() }, { opIds: ["w1"], version: V, extra: 1 }, { opIds: ["w1"], edit: { opId: "w1", doc: {} }, version: V }, { edit: { opId: "w1" }, version: V }, { edit: { opId: "w1", doc: {}, title: "x" }, version: V }, { opIds: "w1", version: V }, { opIds: [1], version: V }, [], "x"]) {
      expect([j(bad), deviceApproveBody(j(bad))]).toEqual([j(bad), false]);
    }
    expect(deviceApproveBody("not json")).toBe(false);
  });
  it("approve at a time the owner chose (R1.2): {opIds, version, at} with at a plain object — the route checks one new op and the time", () => {
    const at = { date: "2026-11-20", time: "07:00" };
    // The gate holds the keys and that `at` is an object; the route holds one op, a new workout, and the day and time (400, 422).
    for (const ok of [{ opIds: ["w1"], version: V, at }, { opIds: ["w1"], version: V, at: { date: "2026-11-20", time: null } }, { opIds: ["w1", "w2"], version: V, at }]) {
      expect([j(ok), deviceApproveBody(j(ok))]).toEqual([j(ok), true]);
    }
    for (const bad of [{ opIds: ["w1"], at }, { version: V, at }, { opIds: ["w1"], version: V, at: "07:00" }, { opIds: ["w1"], version: V, at: null }, { opIds: ["w1"], version: V, at: [] }, { edit: { opId: "w1", doc: {} }, version: V, at }, { opIds: ["w1"], version: V, at, extra: 1 }]) {
      expect([j(bad), deviceApproveBody(j(bad))]).toEqual([j(bad), false]);
    }
  });
  it("a run from the phone: keys among scope, request, focus, conversationId, nudge, frame, chip and clientId — never rehearsal or savesBatchId", () => {
    const U = "7d1c9f0e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
    for (const ok of [{}, { scope: { kind: "later_today" }, request: "x" }, { focus: { kind: "day", id: "2026-11-20" } }, { frame: {} }, { conversationId: null, nudge: "missed" }, { request: "x", clientId: U }, { chip: "c1", clientId: U }]) {
      expect([j(ok), deviceRunCreateBody(j(ok))]).toEqual([j(ok), true]);
    }
    for (const bad of [{ rehearsal: true }, { rehearsal: false }, { savesBatchId: "b1" }, { request: "x", extra: 1 }, { frame: "free 17:30" }, { frame: [] }, { frame: null }, { clientId: U, via: "lifeos" }, [], "x"]) {
      expect([j(bad), deviceRunCreateBody(j(bad))]).toEqual([j(bad), false]);
    }
  });
  it("the phone's run keys are the route's own but the laptop's two (R1.2: clientId among them): the gate and the route agree", () => {
    // One value of each key the route reads (routes/coach-runs.ts RUN_CREATE_KEYS); the gate lets each through alone, or not.
    const sample: Record<(typeof RUN_CREATE_KEYS)[number], unknown> = {
      scope: { kind: "now" }, request: "x", rehearsal: true, focus: { kind: "day", id: "2026-11-20" }, conversationId: null, savesBatchId: "b1",
      nudge: "missed", frame: {}, chip: "c1", clientId: "7d1c9f0e-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
    };
    expect(RUN_CREATE_KEYS.filter((k) => deviceRunCreateBody(j({ [k]: sample[k] })))).toEqual(RUN_CREATE_KEYS.filter((k) => k !== "rehearsal" && k !== "savesBatchId"));
    expect(RUN_CREATE_KEYS).toContain("clientId");
  });
  it("the rest: answers, undo, decline, memory edits, the step's and drain's empty bodies", () => {
    expect([deviceRunAnswerBody(j({ answers: ["a"] })), deviceRunAnswerBody(j({ dismissed: true })), deviceRunAnswerBody(j({ answers: [], x: 1 }))]).toEqual([true, true, false]);
    expect([deviceUndoAnswerBody(j({ handle: "h" })), deviceUndoAnswerBody(j({})), deviceUndoAnswerBody(j({ handle: "h", x: 1 })), deviceUndoAnswerBody(j({ handle: "" }))]).toEqual([true, false, false, false]);
    expect([deviceDeclineBody(j({})), deviceDeclineBody(j({ opIds: ["w1"], reason: "no" })), deviceDeclineBody(j({ all: true }))]).toEqual([true, true, false]);
    expect([deviceMemoryPatchBody(j({ pinned: true })), deviceMemoryPatchBody(j({ body: "x", confirm: true })), deviceMemoryPatchBody(j({})), deviceMemoryPatchBody(j({ kind: "rule" }))]).toEqual([true, true, false, false]);
    expect([emptyBody(""), emptyBody("{}"), emptyBody(j({ afterSeq: 1 }))]).toEqual([true, true, false]);
  });
  it("place, take-back and switch A: exactly their keys", () => {
    for (const ok of [{ date: "2026-11-20", clientId: "c1" }, { date: "2026-11-20", time: "18:15", clientId: "c1" }, { date: "2026-11-20", time: null, clientId: "c1" }]) expect([j(ok), devicePlaceBody(j(ok))]).toEqual([j(ok), true]);
    for (const bad of [{ date: "2026-11-20" }, { clientId: "c1" }, { date: "20-11-2026", clientId: "c1" }, { date: "2026-11-20", time: "6pm", clientId: "c1" }, { date: "2026-11-20", clientId: "c1", doc: {} }, { date: "2026-11-20", clientId: "" }]) {
      expect([j(bad), devicePlaceBody(j(bad))]).toEqual([j(bad), false]);
    }
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `tb_${i}`);
    expect([deviceTakeBackBody(j({ receiptIds: ids(1), requestId: "r" })), deviceTakeBackBody(j({ receiptIds: ids(12), requestId: "r" }))]).toEqual([true, true]);
    for (const bad of [{ receiptIds: [], requestId: "r" }, { receiptIds: ids(13), requestId: "r" }, { receiptIds: ["a", "a"], requestId: "r" }, { receiptIds: ids(1) }, { receiptIds: ids(1), requestId: "r", force: true }, { receiptIds: [1], requestId: "r" }]) {
      expect([j(bad), deviceTakeBackBody(j(bad))]).toEqual([j(bad), false]);
    }
    expect([deviceSharingBody(j({ toTraining: true, disclosureVersion: "2026-11-19.1" })), deviceSharingBody(j({ toTraining: false, disclosureVersion: "1" }))]).toEqual([true, true]);
    for (const bad of [{ toTraining: "yes", disclosureVersion: "1" }, { toTraining: true }, { toTraining: true, disclosureVersion: "1", fromTraining: true }, { toTraining: true, disclosureVersion: "a b" }]) {
      expect([j(bad), deviceSharingBody(j(bad))]).toEqual([j(bad), false]);
    }
  });

  it("the library's query: keys among q, family, region, equipment, limit 1–100 and cursor, each once", () => {
    const q = (s: string) => new URLSearchParams(s);
    for (const ok of ["", "q=hip", "family=mobility&region=hips&equipment=band", "limit=1", "limit=100", "cursor=50&limit=50"]) expect([ok, deviceLibraryQuery(q(ok))]).toEqual([ok, true]);
    for (const bad of ["limit=0", "limit=101", "limit=01", "cursor=-1", "q=", "q=a&q=b", "family=Mobility", "location=home", "safe=1", "x=1"]) expect([bad, deviceLibraryQuery(q(bad))]).toEqual([bad, false]);
  });

  it("the queries: afterSeq digits once; the conversation's id once; nudges' seen once; none elsewhere", () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(["", "afterSeq=0", "afterSeq=123456789"].map((s) => deviceAfterSeqQuery(q(s)))).toEqual([true, true, true]);
    expect(["afterSeq=-1", "afterSeq=1234567890", "afterSeq=1&afterSeq=2", "afterSeq=", "x=1"].map((s) => deviceAfterSeqQuery(q(s)))).toEqual([false, false, false, false, false]);
    expect(["", "id=abc_1-2", "id=a&id=b", "id=a/b", "x=1"].map((s) => deviceConversationQuery(q(s)))).toEqual([true, true, false, false, false]);
    expect(["", "seen=a,b", "seen=a&seen=b", "x=1"].map((s) => deviceNudgesQuery(q(s)))).toEqual([true, true, false, false]);
    expect(["", "x=1", "&"].map((s) => noQuery(q(s)))).toEqual([true, false, true]);
  });
});

describe("the gate's query rule (DESIGN-2c §2.5): the shape only, the route checks the values", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("/days: exactly the keys from and to, each once, each YYYY-MM-DD", () => {
    for (const ok of ["from=2026-11-18&to=2026-11-18", "to=2026-12-01&from=2026-11-18", "from=2026-11-18&to=2026-11-18&", "from=2026%2D11%2D18&to=2026-11-18", "from=2026-02-30&to=9999-99-99"]) {
      expect([ok, deviceDaysQuery(q(ok))]).toEqual([ok, true]);
    }
    for (const bad of ["", "from=2026-11-18", "to=2026-11-18", "from=2026-11-18&to=2026-11-18&x=1", "from=2026-11-18&from=2026-11-18&to=2026-11-18", "from=2026-1-1&to=2026-11-18", "from=2026-11-18&to=2026-11-18T00", "from=&to=2026-11-18", "from=2026-11-18&to= 2026-11-18", "FROM=2026-11-18&to=2026-11-18", "from=2026-11-18&to=2026-11-18&to=2026-11-19", "from[]=2026-11-18&to=2026-11-18", "from=+2026-11-18&to=2026-11-18"]) {
      expect([bad, deviceDaysQuery(q(bad))]).toEqual([bad, false]);
    }
  });
  it("/history: keys among before and limit, each at most once; before YYYY-MM-DD, limit 1–99 with no leading zero", () => {
    for (const ok of ["", "before=2026-11-18", "limit=1", "limit=30", "limit=99", "before=2026-11-18&limit=7", "limit=7&before=2026-11-18"]) {
      expect([ok, deviceHistoryQuery(q(ok))]).toEqual([ok, true]);
    }
    for (const bad of ["limit=0", "limit=01", "limit=100", "limit=-1", "limit=1.5", "limit=", "before=2026-1-1", "before=", "before=2026-11-18&before=2026-11-17", "limit=1&limit=2", "after=2026-11-18", "before=2026-11-18&x=", "x"]) {
      expect([bad, deviceHistoryQuery(q(bad))]).toEqual([bad, false]);
    }
  });
  it("/ahead: no query at all", () => {
    expect(deviceAheadQuery(q(""))).toBe(true);
    for (const bad of ["x=1", "date=2026-11-18", "&x", "x"]) expect([bad, deviceAheadQuery(q(bad))]).toEqual([bad, false]);
  });
});

describe("a device token of each scope against every route, every method", () => {
  it("is refused wherever requireUser stands, answers only on its scope's list, and changes no other door's answer", async () => {
    const failures: string[] = [];
    /** How each classified route behaves under its own method (an ALL entry, a middleware's, under MIDDLEWARE_PROBE), per scope. */
    const observed = Object.fromEntries(SCOPES.map((s) => [s, {} as Record<string, RouteClass>])) as Record<Scope, Record<string, RouteClass>>;
    const mounted = [...new Set(mountedRoutes().map(keyOf))];
    const paths = [...new Set(mounted.map((k) => k.split(" ")[1]!))];
    let probes = 0;
    for (const path of paths) {
      const url = concrete(path);
      for (const method of METHODS) {
        const body = PROBE_BODIES[`${method} ${path}`];
        const target = `${url}${PROBE_QUERIES[`${method} ${path}`] ?? ""}`;
        const anonymous = await probe(method, target, undefined, body);
        probes += 1;
        for (const scope of SCOPES) {
          const device = await probe(method, target, tokens[scope], body);
          probes += 1;
          const allowed = onSlice(scope, method, url);
          const label = `${scope} ${method} ${url}`;
          let behaves: RouteClass;
          if (allowed) {
            behaves = "device";
            if (!device.reached || [401, 403].includes(device.status)) failures.push(`${label}: on the list, but the device got ${device.status} ${device.error}`);
          } else if (anonymous.reached) {
            behaves = "gated";
            // A HEAD answer has no body to name the error; its status says it.
            if (device.status !== 403 || device.error !== (method === "HEAD" ? null : "out_of_scope")) failures.push(`${label}: behind requireUser, but the device got ${device.status} ${device.error}`);
          } else {
            // Its own bearer door answers 401 `unauthenticated` without requireUser; anything else is open.
            behaves = anonymous.status === 401 && anonymous.error === "unauthenticated" ? "bearer" : "open";
            if (device.status !== anonymous.status || device.error !== anonymous.error || device.reached) {
              failures.push(`${label}: not requireUser's, but the device got ${device.status} ${device.error} where anonymous got ${anonymous.status} ${anonymous.error}`);
            }
          }
          if (mounted.includes(`${method} ${path}`)) observed[scope][`${method} ${path}`] = behaves;
          if (method === MIDDLEWARE_PROBE && mounted.includes(`ALL ${path}`)) observed[scope][`ALL ${path}`] = behaves;
        }
      }
    }
    if (process.env.NATIVE_ROUTES_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.NATIVE_ROUTES_OUT, JSON.stringify(Object.fromEntries(SCOPES.map((s) => [s, Object.fromEntries(mounted.map((k) => [k, observed[s][k]]))])), null, 2));
    }
    console.info(`[allowlist] ${paths.length} paths × ${METHODS.length} methods × (anonymous + ${SCOPES.length} scopes): ${probes} requests`);
    expect(failures).toEqual([]);
    const mismatched = SCOPES.flatMap((scope) =>
      Object.entries(ROUTE_CLASSES)
        .filter(([k, c]) => observed[scope][k] !== classUnder(c, scope))
        .map(([k, c]) => `${scope} ${k}: classified ${classUnder(c, scope)}, behaves ${observed[scope][k]}`),
    );
    expect(mismatched).toEqual([]);
  });
});
