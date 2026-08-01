import { and, eq, lt } from "drizzle-orm";
import { sessions, users } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../services/db.js";
import { randomToken, sha256Hex } from "./crypto.js";

export const SESSION_COOKIE = "rg_session";
const SESSION_TTL_DAYS = 30;

export async function createSession(db: Db, userId: string, userAgent?: string): Promise<string> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    lastUsedAt: now.toISOString(),
    userAgent: userAgent?.slice(0, 200),
  });
  return token;
}

export async function resolveSession(
  db: Db,
  token: string | undefined,
): Promise<{ userId: string; email: string } | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const rows = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt < nowInstant()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return { userId: row.userId, email: row.email };
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, nowInstant()));
}

export async function findOrCreateUser(
  db: Db,
  email: string,
  googleSub: string,
  name?: string,
): Promise<string> {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    if (!existing[0].googleSub) {
      await db.update(users).set({ googleSub }).where(eq(users.id, existing[0].id));
    }
    return existing[0].id;
  }
  const id = newId();
  await db.insert(users).values({
    id,
    email,
    name: name ?? null,
    googleSub,
    createdAt: nowInstant(),
  });
  return id;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_DAYS * 86400}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
