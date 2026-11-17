/**
 * EACH DEVICE SCOPE AGAINST EVERY ROUTE THE APP MOUNTS, EVERY METHOD (SLICE-CONTRACT revision 2 §10.3; stage 2 DESIGN §5.1).
 *
 * `ROUTE_CLASSES` (native-allowlist.routes.ts) classifies each (method, path) the Worker's app mounts — `mountedRoutes()`
 * from the entry module, middleware included — under each scope, and the first test fails while the two lists differ, so
 * a route added later fails here until someone classifies it:
 *
 *  - `device`: on the scope's list. For `training-slice-v1` only the slice's eight; for `training-v2` those and stage
 *    2a's four. A device of that scope reaches the handler.
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
 * before v2 existed, and v2's is v1's, the same entries, plus four. Synthetic data only; `fetch` stubbed.
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
const { DEVICE_SCOPES, deviceRouteOf, deviceSaveBody, emptyObjectBody } = await import("../src/auth/device-scope.js");

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
/** Each scope's pairs: v2 is v1 and stage 2a's plan edits and the watch drain (DESIGN §9). */
const DEVICE_PAIRS: Record<Scope, readonly string[]> = {
  "training-slice-v1": V1_PAIRS,
  "training-v2": [
    ...V1_PAIRS,
    "POST /api/plan/workouts/:id/move",
    "POST /api/plan/workouts/:id/skip",
    "POST /api/plan/workouts/:id/unskip",
    "POST /api/sessions/watch/drain",
  ],
};
/** A probe's body where `{}` is outside the pair's body rule: a move in its grammar (the route then answers 404). */
const PROBE_BODIES: Record<string, string> = {
  "POST /api/plan/workouts/:id/move": JSON.stringify({ toDate: "2026-11-20", toTime: "07:30" }),
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
    expect(Object.keys(DEVICE_SCOPES).sort()).toEqual([...SCOPES].sort());
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
        const anonymous = await probe(method, url, undefined, body);
        probes += 1;
        for (const scope of SCOPES) {
          const device = await probe(method, url, tokens[scope], body);
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
