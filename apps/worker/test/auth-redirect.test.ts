/**
 * Security audit S1 (open redirect) + S5 (email_verified) — auth routes.
 *
 * S1: the `redirect` query param must only ever land the browser on a
 * same-app path. Validated at store time (google/start persists into
 * oauth_states) AND defensively at redirect time (google/callback), so even a
 * stale pre-validation row can't send the browser off-site.
 *
 * S5: the single-user gate additionally requires Google's own
 * `email_verified` assertion — a matching-but-unverified address is rejected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import { authRoutes } from "../src/routes/auth.js";
import { emailAllowed } from "../src/auth/google.js";
import { makeTestDb, mountRoutes } from "./helpers.js";

const { oauthStates } = schema;

function makeEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function makeIdToken(payload: Record<string, unknown>): string {
  return `header.${b64url(JSON.stringify(payload))}.signature`;
}

/** Scripts the Google token-exchange response for the callback handler. */
function stubTokenExchange(idToken: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at", expires_in: 3600, id_token: idToken }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
}

async function seedState(db: ReturnType<typeof makeTestDb>, redirectTo: string): Promise<string> {
  const state = `st-${Math.random().toString(36).slice(2)}`;
  await db.insert(oauthStates).values({
    state,
    provider: "google",
    codeVerifier: "verifier",
    redirectTo,
    createdAt: nowInstant(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google/start — redirect validated at store time (S1)", () => {
  it.each([
    ["https://evil.example/phish", "/"],
    ["//evil.example/phish", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/plan?week=2", "/plan?week=2"],
  ])("stores %j as %j", async (redirect, stored) => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    const res = await app.request(
      `/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`,
      {},
      makeEnv(),
    );
    expect(res.status).toBe(302);
    const rows = await db.select().from(oauthStates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.redirectTo).toBe(stored);
  });
});

describe("google/callback — redirect validated at redirect time (S1)", () => {
  const verifiedIdentity = {
    email: "runner@example.com",
    email_verified: true,
    sub: "sub-1",
    name: "Runner",
  };

  it("a poisoned stored redirect falls back to /", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    // Simulates a stale row persisted before store-time validation existed.
    const state = await seedState(db, "https://evil.example/phish");
    stubTokenExchange(makeIdToken(verifiedIdentity));
    const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`, {}, makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("a protocol-relative stored redirect falls back to /", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    const state = await seedState(db, "//evil.example");
    stubTokenExchange(makeIdToken(verifiedIdentity));
    const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`, {}, makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("a valid local path passes through", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    const state = await seedState(db, "/plan?week=2");
    stubTokenExchange(makeIdToken(verifiedIdentity));
    const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`, {}, makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/plan?week=2");
  });

  it("rejects the allowed email when email_verified is false (S5)", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    const state = await seedState(db, "/");
    stubTokenExchange(makeIdToken({ ...verifiedIdentity, email_verified: false }));
    const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`, {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it("rejects the allowed email when email_verified is absent (S5)", async () => {
    const db = makeTestDb();
    const app = mountRoutes(db, "/api/auth", authRoutes);
    const state = await seedState(db, "/");
    stubTokenExchange(makeIdToken({ email: "runner@example.com", sub: "sub-1" }));
    const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`, {}, makeEnv());
    expect(res.status).toBe(403);
  });
});

describe("emailAllowed (S5)", () => {
  const env = makeEnv();
  it("accepts the configured email only when verified", () => {
    expect(emailAllowed(env, { email: "runner@example.com", email_verified: true })).toBe(true);
    // Some flows have historically sent the claim as a string.
    expect(emailAllowed(env, { email: "runner@example.com", email_verified: "true" })).toBe(true);
    expect(emailAllowed(env, { email: "runner@example.com", email_verified: false })).toBe(false);
    expect(emailAllowed(env, { email: "runner@example.com" })).toBe(false);
    expect(emailAllowed(env, { email: "other@example.com", email_verified: true })).toBe(false);
    expect(emailAllowed(env, { email_verified: true })).toBe(false);
  });
});
