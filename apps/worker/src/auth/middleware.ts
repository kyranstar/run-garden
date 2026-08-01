import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { desktopDevices } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import { makeDb, type Db } from "../services/db.js";
import { resolveSession, SESSION_COOKIE } from "./sessions.js";
import { deviceSigningMessage, sha256Hex, verifyEd25519 } from "./crypto.js";

export interface AppContext {
  Bindings: Env;
  Variables: {
    db: Db;
    userId: string;
    userEmail: string;
    deviceId: string;
  };
}

export async function withDb(c: Context<AppContext>, next: Next): Promise<void | Response> {
  c.set("db", makeDb(c.env.DB));
  await next();
}

/** Browser-session authentication (cookie). */
export async function requireUser(c: Context<AppContext>, next: Next): Promise<void | Response> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c.get("db"), token);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", session.userId);
  c.set("userEmail", session.email);
  await next();
}

const SIGNATURE_WINDOW_MS = 5 * 60_000;

/**
 * Desktop-device authentication: every bridge request is signed with the
 * device's Ed25519 key over (method, path, timestamp, body hash).
 */
export async function requireDevice(c: Context<AppContext>, next: Next): Promise<void | Response> {
  const deviceId = c.req.header("x-device-id");
  const timestamp = c.req.header("x-device-timestamp");
  const signature = c.req.header("x-device-signature");
  if (!deviceId || !timestamp || !signature) {
    return c.json({ error: "missing_device_auth" }, 401);
  }
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) {
    return c.json({ error: "stale_timestamp" }, 401);
  }

  const db = c.get("db");
  const rows = await db
    .select()
    .from(desktopDevices)
    .where(and(eq(desktopDevices.id, deviceId), isNull(desktopDevices.revokedAt)))
    .limit(1);
  const device = rows[0];
  if (!device) return c.json({ error: "unknown_device" }, 401);

  const bodyText = await c.req.raw.clone().text();
  const message = deviceSigningMessage(
    c.req.method,
    new URL(c.req.url).pathname,
    timestamp,
    await sha256Hex(bodyText),
  );
  const valid = await verifyEd25519(device.publicKey, message, signature);
  if (!valid) return c.json({ error: "bad_signature" }, 401);

  await db
    .update(desktopDevices)
    .set({ lastSeenAt: nowInstant() })
    .where(eq(desktopDevices.id, deviceId));

  c.set("deviceId", deviceId);
  c.set("userId", device.userId);
  await next();
}
