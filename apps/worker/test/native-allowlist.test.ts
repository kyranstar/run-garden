/**
 * THE DEVICE SCOPE AGAINST EVERY ROUTE THE APP MOUNTS, EVERY METHOD (SLICE-CONTRACT revision 2 §10.3).
 *
 * `ROUTE_CLASSES` (native-allowlist.routes.ts) classifies each (method, path) the Worker's app mounts — `mountedRoutes()`
 * from the entry module, middleware included — and the first test fails while the two lists differ, so a route added
 * later fails here until someone classifies it:
 *
 *  - `device`: on the slice's list. Only these eight; a device's request reaches the handler.
 *  - `gated`: behind `requireUser`. A device is refused 403 `out_of_scope` before the handler runs.
 *  - `open`: not behind `requireUser` (sign-in, health, assets, the bridge's 410, a switch's 404 …). The device token is
 *    no credential there: a device's answer is exactly the anonymous one.
 *  - `bearer`: behind its own bearer door (LifeOS, the saves extension). The device token is not that door's token: the
 *    same 401 as anonymous.
 *
 * Then every path is probed with EVERY method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS), anonymous and with an
 * active device token, against the real default export, every switch on: wherever the anonymous request reached
 * `requireUser` (a spy on the real function says), the device must be on the list or get 403 `out_of_scope`; wherever
 * it did not, the device's answer must be the anonymous one. Synthetic data only; `fetch` stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { nativeEnv, seedDevice } from "./native-fixture.js";
import { ROUTE_CLASSES, type RouteClass } from "./native-allowlist.routes.js";

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
const { deviceRouteOf } = await import("../src/auth/device-scope.js");

vi.setConfig({ testTimeout: 600_000 });

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
/** The slice, as this test holds it — independent of the implementation's list, which is checked against it. */
const DEVICE_PAIRS = [
  "GET /api/native/me",
  "GET /api/native/today",
  "POST /api/native/sign-out",
  "GET /api/sessions/:workoutId",
  "GET /api/sessions/:workoutId/review-basis",
  "POST /api/sessions/:workoutId/build",
  "POST /api/sessions/:workoutId/start",
  "PUT /api/sessions/performed/:id",
];

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
/** A concrete path for a route's pattern: each parameter a probe id, a wildcard a probe segment. */
const concrete = (path: string) => path.replace(/:\w+/g, "probe-id").replace(/\*/g, "__probe__");
/** Whether a concrete request is one of the slice's pairs, as the router would match the template (this test's own matcher). */
const onSlice = (method: string, url: string) =>
  DEVICE_PAIRS.some((pair) => {
    const [m, template] = pair.split(" ") as [string, string];
    return m === method && new RegExp(`^${template.replace(/:\w+/g, "[^/]+")}$`).test(url);
  });
/** The method a middleware entry (ALL) is observed under: one no route registers, so only middleware answers it. */
const MIDDLEWARE_PROBE = "OPTIONS";

let env: Env;
let token: string;
let deviceId: string;

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
  ({ token, id: deviceId } = await seedDevice(db, userId, { expiresAt: "2099-01-01T00:00:00.000Z" }));
});
afterAll(() => vi.unstubAllGlobals());

interface Probe {
  status: number;
  error: string | null;
  reached: boolean;
}

async function probe(method: string, path: string, bearer?: string): Promise<Probe> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const headers: Record<string, string> = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const withBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (withBody) headers["Content-Type"] = "application/json";
  holder.reached = false;
  const res = await worker.fetch(new Request(`https://app.test${path}`, { method, headers, ...(withBody ? { body: "{}" } : {}) }), env, ctx);
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
  // A device's own sign-out revokes it; every probe starts from the same active device.
  await (holder.db as ReturnType<typeof makeTestDb>).update(schema.nativeDevices).set({ state: "active", revokedAt: null, revokedReason: null }).where(eq(schema.nativeDevices.id, deviceId));
  return { status: res.status, error, reached };
}

describe("every mounted route is classified", () => {
  it("ROUTE_CLASSES names exactly the (method, path) pairs the app mounts", () => {
    const mounted = [...new Set(mountedRoutes().map(keyOf))].sort();
    const classified = Object.keys(ROUTE_CLASSES).sort();
    expect({ unclassified: mounted.filter((k) => !(k in ROUTE_CLASSES)), gone: classified.filter((k) => !mounted.includes(k)) }).toEqual({ unclassified: [], gone: [] });
  });

  it("the device class is exactly the slice's eight pairs, and the implementation's list matches each and nothing else", () => {
    const device = Object.entries(ROUTE_CLASSES).filter(([, c]) => c === "device").map(([k]) => k).sort();
    expect(device).toEqual([...DEVICE_PAIRS].sort());
    // The implementation's matcher against this test's, for every mounted path under every method.
    for (const key of Object.keys(ROUTE_CLASSES)) {
      const path = key.split(" ")[1]!;
      for (const m of METHODS) expect([m, path, deviceRouteOf(m, concrete(path)) !== undefined]).toEqual([m, path, onSlice(m, concrete(path))]);
    }
    expect(mountedRoutes().some((r) => r.method === MIDDLEWARE_PROBE)).toBe(false);
  });
});

describe("a device token against every route, every method", () => {
  it("is refused wherever requireUser stands, answers only on the list, and changes no other door's answer", async () => {
    const failures: string[] = [];
    /** How each classified route behaves under its own method (an ALL entry, a middleware's, under MIDDLEWARE_PROBE). */
    const observed: Record<string, RouteClass> = {};
    const mounted = [...new Set(mountedRoutes().map(keyOf))];
    const paths = [...new Set(mounted.map((k) => k.split(" ")[1]!))];
    let probes = 0;
    for (const path of paths) {
      const url = concrete(path);
      for (const method of METHODS) {
        const anonymous = await probe(method, url);
        const device = await probe(method, url, token);
        probes += 2;
        const allowed = onSlice(method, url);
        const label = `${method} ${url}`;
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
        if (mounted.includes(`${method} ${path}`)) observed[`${method} ${path}`] = behaves;
        if (method === MIDDLEWARE_PROBE && mounted.includes(`ALL ${path}`)) observed[`ALL ${path}`] = behaves;
      }
    }
    if (process.env.NATIVE_ROUTES_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.NATIVE_ROUTES_OUT, JSON.stringify(Object.fromEntries(mounted.map((k) => [k, observed[k]])), null, 2));
    }
    console.info(`[allowlist] ${paths.length} paths × ${METHODS.length} methods: ${probes} requests`);
    expect(failures).toEqual([]);
    const mismatched = Object.entries(ROUTE_CLASSES)
      .filter(([k, c]) => observed[k] !== c)
      .map(([k, c]) => `${k}: classified ${c}, behaves ${observed[k]}`);
    expect(mismatched).toEqual([]);
  });
});
