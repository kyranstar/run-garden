import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, type SourceActivity } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const T = "2026-08-10T12:00:00Z";

async function insertActivity(db: Db, userId: string, id: string, source?: "coros" | "app" | "import") {
  await db.insert(schema.activities).values({
    id,
    userId,
    startTime: T,
    sport: "strength",
    durationSeconds: 1800,
    corosActivityId: null,
    ...(source ? { source } : {}),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

function corosStrength(offsetMin: number, extra: Partial<SourceActivity> = {}): SourceActivity {
  return {
    provider: "coros",
    providerActivityId: "c-1",
    startTime: new Date(Date.parse(T) + offsetMin * 60_000).toISOString().replace(".000Z", "Z"),
    sport: "strength",
    durationSeconds: 1750,
    contentFingerprint: "fp-1",
    ...extra,
  };
}

describe("activities.source", () => {
  it("never adopts an import-source activity", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "imp", "import");
    await ingestActivities(db, { userId, sources: [corosStrength(5)] });
    const rows = await db.select().from(schema.activities);
    expect(rows).toHaveLength(2);
    const imp = rows.find((r) => r.id === "imp")!;
    expect(imp.source).toBe("import");
    expect(imp.corosActivityId).toBeNull();
  });

  it("adopts an app-source activity as the merge: same id, COROS metrics, source becomes coros", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "app1", "app");
    await ingestActivities(db, { userId, sources: [corosStrength(2, { avgHeartRate: 120 })] });
    const rows = await db.select().from(schema.activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("app1");
    expect(rows[0]!.avgHeartRate).toBe(120);
    expect(rows[0]!.source).toBe("coros");
    expect(rows[0]!.corosActivityId).toBe("c-1");
  });

  it("rows inserted without a source read back as coros", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await insertActivity(db, userId, "legacy");
    const [row] = await db.select().from(schema.activities).where(eq(schema.activities.id, "legacy"));
    expect(row!.source).toBe("coros");
  });
});
