/**
 * garden_seen: the server-side arrival watermark (spec §3 of
 * docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md).
 * Table smoke test here; route coverage joins in the same file (Task 3).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { makeTestDb, makeTestUser } from "./helpers.js";

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
