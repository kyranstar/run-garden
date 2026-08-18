/**
 * GET /api/coach/analyze/:activityId (System 2): a peek at a CACHED read.
 * The dashboard's expanded session shows an existing read automatically —
 * so this must return the done row verbatim, return null for anything else,
 * and NEVER mint a ledger row or trigger generation (a peek that spends is
 * the exact defect the endpoint exists to avoid).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachReads } = schema;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

let db: Db;
let userId: string;
let cookie: string;

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db);
  userId = user.userId;
  const token = await createSession(db, userId);
  cookie = `${SESSION_COOKIE}=${token}`;
});

function client() {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  return (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv());
}

describe("GET /api/coach/analyze/:activityId (peek)", () => {
  it("returns a done read verbatim", async () => {
    const readId = newId();
    await db.insert(coachReads).values({
      id: readId,
      userId,
      activityId: "act-1",
      status: "done",
      attempt: 1,
      nextAttemptAt: nowInstant(),
      glance: "Strong and steady.",
      body: "The reps held their pace.",
      flags: [],
      completedAt: "2026-08-17T12:00:00.000Z",
      createdAt: nowInstant(),
    });
    const res = await client()(`/api/coach/analyze/act-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: { id: string; glance: string; at: string } | null };
    expect(body.read?.id).toBe(readId);
    expect(body.read?.glance).toBe("Strong and steady.");
    expect(body.read?.at).toBe("2026-08-17T12:00:00.000Z");
  });

  it("returns null for a missing row and for one still generating — and never mints a row", async () => {
    let res = await client()(`/api/coach/analyze/act-none`);
    expect(((await res.json()) as { read: unknown }).read).toBeNull();

    await db.insert(coachReads).values({
      id: newId(),
      userId,
      activityId: "act-running",
      status: "running",
      attempt: 1,
      nextAttemptAt: nowInstant(),
      flags: [],
      createdAt: nowInstant(),
    });
    res = await client()(`/api/coach/analyze/act-running`);
    expect(((await res.json()) as { read: unknown }).read).toBeNull();

    // The peek spent nothing: exactly the one row we inserted exists.
    const rows = await db.select().from(coachReads).where(eq(coachReads.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");
  });
});
