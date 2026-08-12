/**
 * The whole cloud-direct feature through its real HTTP routes: connect →
 * status → read-now ingests → the activity is visible through the same API
 * the UI reads → honesty states (fresh, bad password, disconnected). One
 * mock COROS server underneath everything; no bridge anywhere. The pieces
 * have unit suites — this proves the wiring a user actually travels.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { createHash } from "node:crypto";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { corosRoutes } from "../src/routes/coros.js";
import { activityRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud-direct COROS, end to end over HTTP", () => {
  it("connect → status → read-now → the activity shows up in the API", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const server = mockCorosServer();
    // Routes reach COROS (and the locale CDN) through the global fetch.
    vi.stubGlobal("fetch", server.fetchImpl);

    const coros = mountRoutes(db, "/api/coros", corosRoutes);
    const acts = mountRoutes(db, "/api/activities", activityRoutes);
    const post = (app: ReturnType<typeof mountRoutes>, path: string, body?: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        makeEnv(),
      );
    const get = (app: ReturnType<typeof mountRoutes>, path: string) =>
      app.request(path, { headers: { Cookie: cookie } }, makeEnv());

    // 1 · Connect with the browser-hashed password.
    const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
    const connectRes = await post(coros, "/api/coros/connect", {
      email: server.email,
      pwdMd5,
      region: "us",
    });
    expect(connectRes.status).toBe(200);
    expect(((await connectRes.json()) as { status: string }).status).toBe("connected");

    // 2 · Status reflects it.
    const status = (await (await get(coros, "/api/coros/status")).json()) as {
      connected: boolean;
      email: string | null;
    };
    expect(status.connected).toBe(true);
    expect(status.email).toBe(server.email);

    // 3 · The connect itself kicked the first pull (background). A read-now
    // right behind it coalesces — "busy" while the pull runs, "fresh" once
    // it lands — never a second full pull (exactly-once requirement).
    let readStatus = "";
    for (let i = 0; i < 100 && readStatus !== "fresh"; i++) {
      readStatus = ((await (await post(coros, "/api/coros/read-now")).json()) as { status: string })
        .status;
      expect(["busy", "fresh", "ok"]).toContain(readStatus);
      if (readStatus !== "fresh") await new Promise((r) => setTimeout(r, 25));
    }
    expect(readStatus).toBe("fresh");

    // 4 · The run arrived with NO further user action — visible through the
    // API the UI reads.
    const list = (await (await get(acts, "/api/activities")).json()) as {
      activities: Array<{ sport: string; title: string | null }>;
    };
    expect(list.activities.length).toBeGreaterThanOrEqual(1);
    expect(list.activities.some((a) => a.sport === "run")).toBe(true);

    // 4½ · The exercise catalog rode the same pull (stale → included) — the
    // studio no longer needs a desktop app for names.
    const catalog = await db.select().from(schema.corosExercises);
    expect(catalog.length).toBeGreaterThanOrEqual(1);

    // 5 · A second read-now inside the 90s freshness window is free.
    const again = (await (await post(coros, "/api/coros/read-now")).json()) as { status: string };
    expect(again.status).toBe("fresh");

    // 6 · A wrong password is reported honestly, not stored.
    const bad = (await (
      await post(coros, "/api/coros/connect", {
        email: server.email,
        pwdMd5: "0".repeat(32),
        region: "us",
      })
    ).json()) as { status: string };
    expect(bad.status).toBe("bad_credentials");

    // 7 · Disconnect wipes secrets; read-now says not_connected out loud.
    await coros.request(
      "/api/coros/connect",
      { method: "DELETE", headers: { Cookie: cookie } },
      makeEnv(),
    );
    const after = (await (await post(coros, "/api/coros/read-now")).json()) as { status: string };
    expect(after.status).toBe("not_connected");
    const [row] = await db
      .select()
      .from(schema.providerConnections)
      .where(eq(schema.providerConnections.userId, userId));
    expect(row!.status).toBe("disconnected");
    expect(row!.encryptedRefreshToken).toBeNull();
    expect(row!.encryptedAccessToken).toBeNull();
  });
});
