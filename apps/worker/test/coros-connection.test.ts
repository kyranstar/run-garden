/**
 * Cloud COROS connection (cloud-direct spec §1): connect verifies with a
 * live login and stores only encrypted secrets; corosClient reuses a fresh
 * cached token (zero logins), re-logins once stale, and a bad-credentials
 * rejection parks the row in error until the password changes.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  connectCoros,
  corosClient,
  corosConnectionStatus,
  disconnectCoros,
} from "../src/services/coros-connection.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

// 32 zero bytes, base64 — matches auth/crypto.ts's expected key shape.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

const PWD_MD5 = "5f4dcc3b5aa765d61d8327deb882cf99";

/** COROS-shaped fetch: counts logins, scripts the login envelope. */
function corosFetch(script: { loginResult?: string } = {}) {
  let logins = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/account/login")) {
      logins += 1;
      const result = script.loginResult ?? "0000";
      const body =
        result === "0000"
          ? { result, data: { accessToken: `token-${logins}`, userId: "98765" } }
          : { result, message: "The login credentials you entered do not match our records." };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ result: "0000", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, logins: () => logins };
}

async function row(db: Db, userId: string) {
  return (
    await db
      .select()
      .from(schema.providerConnections)
      .where(and(eq(schema.providerConnections.userId, userId), eq(schema.providerConnections.provider, "coros")))
  )[0];
}

describe("connectCoros", () => {
  it("verifies with a live login and stores only encrypted secrets", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch();
    const res = await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    expect(res.status).toBe("connected");
    expect(coros.logins()).toBe(1);
    const r = (await row(db, userId))!;
    expect(r.status).toBe("connected");
    expect(r.externalAccountId).toBe("98765");
    // Nothing stored in the clear.
    expect(r.encryptedRefreshToken).not.toContain(PWD_MD5);
    expect(r.encryptedAccessToken).not.toContain("token-1");
    expect((r.meta as { email?: string }).email).toBe("a@b.c");
  });

  it("a COROS 1030 comes back as bad_credentials and stores nothing usable", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch({ loginResult: "1030" });
    const res = await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    expect(res.status).toBe("bad_credentials");
    expect(await row(db, userId)).toBeUndefined();
  });

  it("any other COROS rejection surfaces its result code (login_failed, not a lie about reachability)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch({ loginResult: "1031" });
    const res = await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    expect(res.status).toBe("login_failed");
    expect(res.code).toBe("1031");
    expect(await row(db, userId)).toBeUndefined();
  });

  it("a network failure is login_failed with NO code", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const boom: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const res = await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, boom);
    expect(res.status).toBe("login_failed");
    expect(res.code).toBeUndefined();
  });
});

describe("corosClient", () => {
  it("reuses a fresh cached token — one login across two client builds", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch();
    await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    expect(coros.logins()).toBe(1);

    const c1 = await corosClient(db, makeEnv(), userId, coros.fetchImpl);
    const c2 = await corosClient(db, makeEnv(), userId, coros.fetchImpl);
    expect(c1?.isAuthenticated).toBe(true);
    expect(c2?.isAuthenticated).toBe(true);
    expect(coros.logins()).toBe(1); // token cache did its job
  });

  it("re-logins once when the cached token is stale, and persists the renewal", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch();
    await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    const r = (await row(db, userId))!;
    await db
      .update(schema.providerConnections)
      .set({ accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(schema.providerConnections.id, r.id));

    const client = await corosClient(db, makeEnv(), userId, coros.fetchImpl);
    expect(client?.isAuthenticated).toBe(true);
    expect(coros.logins()).toBe(2);
    const after = (await row(db, userId))!;
    expect(after.accessTokenExpiresAt! > "2025-01-01").toBe(true);
  });

  it("bad credentials during renewal parks the row and stops retrying", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const good = corosFetch();
    await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, good.fetchImpl);
    const r = (await row(db, userId))!;
    await db
      .update(schema.providerConnections)
      .set({ accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(schema.providerConnections.id, r.id));

    const bad = corosFetch({ loginResult: "1030" });
    expect(await corosClient(db, makeEnv(), userId, bad.fetchImpl)).toBeNull();
    const after = (await row(db, userId))!;
    expect(after.status).toBe("error");
    expect(after.lastErrorCategory).toBe("bad_credentials");
    // Parked: another attempt makes no login call at all.
    expect(await corosClient(db, makeEnv(), userId, bad.fetchImpl)).toBeNull();
    expect(bad.logins()).toBe(1);
    const status = await corosConnectionStatus(db, userId);
    expect(status.connected).toBe(false);
    expect(status.lastErrorCategory).toBe("bad_credentials");
  });

  it("disconnect wipes the secrets", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const coros = corosFetch();
    await connectCoros(db, makeEnv(), userId, { email: "a@b.c", pwdMd5: PWD_MD5, region: "us" }, coros.fetchImpl);
    await disconnectCoros(db, userId);
    const r = (await row(db, userId))!;
    expect(r.status).toBe("disconnected");
    expect(r.encryptedRefreshToken).toBeNull();
    expect(r.encryptedAccessToken).toBeNull();
    expect(await corosClient(db, makeEnv(), userId, coros.fetchImpl)).toBeNull();
  });
});
