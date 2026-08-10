/**
 * garden_seen: the server-side arrival watermark (spec §3 of
 * docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md).
 * Table smoke test here; route coverage joins in the same file (Task 3).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { gardenRoutes } from "../src/routes/garden.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

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

describe("garden_seen table", () => {
  it("stores and reads a seen watermark row", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.gardenSeen).values({
      userId,
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 3,
      celebratedSpeciesIds: ["poppy"],
      updatedAt: nowInstant(),
    });
    const [row] = await db
      .select()
      .from(schema.gardenSeen)
      .where(eq(schema.gardenSeen.userId, userId));
    expect(row?.lastSeenDate).toBe("2026-08-04");
    expect(row?.lastSeenSeq).toBe(3);
    expect(row?.celebratedSpeciesIds).toEqual(["poppy"]);
  });
});

describe("seen state over the wire", () => {
  let db: Db;
  let userId: string;
  let cookie: string;

  function client() {
    const app = mountRoutes(db, "/api/garden", gardenRoutes);
    return {
      get: (path: string) => app.request(path, { headers: { Cookie: cookie } }, makeEnv()),
      post: (path: string, body: unknown) =>
        app.request(
          path,
          {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          makeEnv(),
        ),
    };
  }

  beforeEach(async () => {
    db = makeTestDb();
    ({ userId } = await makeTestUser(db));
    const token = await createSession(db, userId);
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  it("GET /api/garden returns seen: null before any mark", async () => {
    const res = await client().get("/api/garden");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seen: unknown };
    expect(body.seen).toBeNull();
  });

  it("POST /api/garden/seen upserts and GET returns it", async () => {
    const first = await client().post("/api/garden/seen", {
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 2,
      celebratedSpeciesIds: ["poppy"],
    });
    expect(first.status).toBe(200);

    const second = await client().post("/api/garden/seen", {
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 5,
      celebratedSpeciesIds: [],
    });
    expect(second.status).toBe(200);

    const res = await client().get("/api/garden");
    const body = (await res.json()) as {
      seen: {
        lastSeenDate: string;
        lastSeenSeq: number;
        celebratedSpeciesIds: string[];
        updatedAt: string;
      };
    };
    // updatedAt is server-stamped (C13 round 2: arrival admission gates
    // rebuilt-history events on it) — assert it round-trips as a real
    // timestamp rather than pinning its exact value.
    expect(body.seen).toMatchObject({
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 5,
      celebratedSpeciesIds: [],
    });
    expect(typeof body.seen.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.seen.updatedAt))).toBe(false);
  });

  it("POST /api/garden/seen rejects malformed bodies", async () => {
    const missing = await client().post("/api/garden/seen", { lastSeenDate: "2026-08-04" });
    expect(missing.status).toBe(400);
    const badDate = await client().post("/api/garden/seen", {
      lastSeenDate: "not-a-date",
      lastSeenSeq: 1,
      celebratedSpeciesIds: [],
    });
    expect(badDate.status).toBe(400);
    const badIds = await client().post("/api/garden/seen", {
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 1,
      celebratedSpeciesIds: [42],
    });
    expect(badIds.status).toBe(400);
  });

  it("accepts celebratedSpeciesIds up to 256 (codex-bounded permanent ledger) and rejects past it", async () => {
    const ok = await client().post("/api/garden/seen", {
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 1,
      celebratedSpeciesIds: Array.from({ length: 256 }, (_, i) => `species-${i}`),
    });
    expect(ok.status).toBe(200);
    const tooMany = await client().post("/api/garden/seen", {
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 1,
      celebratedSpeciesIds: Array.from({ length: 257 }, (_, i) => `species-${i}`),
    });
    expect(tooMany.status).toBe(400);
  });
});
