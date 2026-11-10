/**
 * Shared by the native device suites (SLICE-CONTRACT revision 2 §10): a test database on the repo's migrations with
 * D1's bind cap on, an owner account (its email is the env's ALLOWED_GOOGLE_EMAIL), a signed-in cookie, an env with
 * the kill switch on, and a client that calls the real route modules with a cookie, a device token, both or neither,
 * recording every statement each request ran. Synthetic data only.
 */
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, nowInstant } from "@rg/domain";
import type { Hono } from "hono";
import type { AppContext } from "../src/auth/middleware.js";
import { randomToken, sha256Hex } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { slotId } from "../src/services/program-slots.js";
import type { Db } from "../src/services/db.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { nativeDevices, plannedWorkouts, programs, users } = schema;

export const NATIVE_SCOPE = "training-slice-v1";

export function nativeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "synthetic-session-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "owner@example.test",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    NATIVE_DEVICES: "1",
    ...over,
  } as Env;
}

export interface Answer {
  status: number;
  json: Record<string, any>;
  text: string;
  /** Every statement the request ran, and the writes among them. */
  statements: string[];
  writes: string[];
}

export interface CallOpts {
  body?: unknown;
  /** A raw body, sent as it is. */
  raw?: string;
  /** Send the owner's session cookie (default: only when no bearer is given). */
  cookie?: boolean | string;
  bearer?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>;
}

export interface NativeWorld {
  db: Db;
  userId: string;
  email: string;
  cookie: string;
  env: Env;
  statements: string[];
  binds: unknown[][];
  app: Hono<AppContext>;
  call: (method: string, path: string, opts?: CallOpts) => Promise<Answer>;
}

/** A world whose app mounts `mount` (path → routes). */
export async function nativeWorld(mount: Array<[string, Hono<AppContext>]>, opts: { env?: Partial<Env>; db?: Db } = {}): Promise<NativeWorld> {
  const statements: string[] = [];
  const binds: unknown[][] = [];
  const db = opts.db ?? makeTestDb({ boundVariableCap: 100, onStatement: (s) => void statements.push(s), onBind: (_s, p) => void binds.push(p) });
  const { userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const email = user!.email;
  const env = nativeEnv({ ALLOWED_GOOGLE_EMAIL: email, ...opts.env });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const [first, ...rest] = mount;
  const app = mountRoutes(db, first![0], first![1]);
  for (const [path, routes] of rest) app.route(path, routes);
  const call = async (method: string, path: string, o: CallOpts = {}): Promise<Answer> => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    const withCookie = o.cookie === undefined ? o.bearer === undefined : o.cookie;
    if (withCookie) headers.Cookie = typeof withCookie === "string" ? withCookie : cookie;
    if (o.bearer !== undefined) headers.Authorization = `Bearer ${o.bearer}`;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const pending: Promise<unknown>[] = [];
    const from = statements.length;
    const res = await app.request(
      path,
      { method, headers, ...(body === undefined ? {} : { body }) },
      { ...env, ...o.env },
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as never,
    );
    await Promise.allSettled(pending);
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    const ran = statements.slice(from);
    return { status: res.status, json, text, statements: ran, writes: ran.filter(isWrite) };
  };
  return { db, userId, email, cookie, env, statements, binds, app, call };
}

/** A device row for `userId`, and its token: active and live for 30 days unless `over` says otherwise. */
export async function seedDevice(
  db: Db,
  userId: string,
  over: Partial<typeof nativeDevices.$inferInsert> = {},
): Promise<{ token: string; id: string }> {
  const token = `rgd_${randomToken(32)}`;
  const id = await sha256Hex(token);
  await db.insert(nativeDevices).values({
    id,
    userId,
    scope: NATIVE_SCOPE,
    label: "Synthetic phone",
    state: "active",
    checkNumber: "0420",
    createdAt: nowInstant(),
    confirmedAt: nowInstant(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...over,
  });
  return { token, id };
}

/** A program slot on `date` (an app session's row), as the session suites seed one. */
export async function seedSlot(db: Db, userId: string, date: string): Promise<string> {
  const programId = newId();
  const at = `${date}T12:00:00.000Z`;
  await db.insert(programs).values({
    id: programId,
    userId,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  });
  const id = slotId(programId, date);
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: programId,
    sourceWorkoutId: id,
    title: "Mobility",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "18:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin: "program",
    contentState: "outline",
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

/** Statements that touch the native tables. */
export const nativeStatements = (statements: string[]) => statements.filter((s) => /native_(devices|pairings)/.test(s));
