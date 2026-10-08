/**
 * THE STAMP READER LEARNS THE PROGRAM PUSH (Phase 3 Task 5; spec §4.2). A sent program session's program name on
 * COROS is its stamp — `<program name> — <date>`, cut to 36 characters, " (2)" on a same-day collision — and the
 * import must show the session's title, never the stamp. The newest verified stamp is what authorizes its removal.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { loadOwnProgramNames, recordedStampFor } from "../src/services/coros-stamp.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { corosWriteJobs } = schema;
const DAY = "2026-10-09";
const AT = `${DAY}T19:00:00.000Z`;

async function push(db: Db, userId: string, over: { id: string; workoutId?: string; name: string; title: string; status?: string; verifiedAt?: string | null }) {
  await db.insert(corosWriteJobs).values({
    id: over.id,
    userId,
    workoutId: over.workoutId ?? "slot-1",
    kind: "program_session_push",
    expectedContentFingerprint: "",
    originalDate: DAY,
    destinationDate: DAY,
    requestedAt: AT,
    status: over.status ?? "verified",
    verifiedAt: over.verifiedAt === undefined ? AT : over.verifiedAt,
    updatedAt: AT,
    payload: {
      workoutId: over.workoutId ?? "slot-1",
      buildId: over.id.replace("push:", ""),
      happenDay: DAY,
      name: over.name,
      session: { kind: "program_watch", title: over.title, steps: [] },
    },
  });
}

describe("loadOwnProgramNames — program stamps", () => {
  it("maps a program stamp, with or without (2), to the session's title", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await push(db, userId, { id: "push:b1", name: `Strength program — ${DAY}`, title: "Strength program · Hips and back" });
    await push(db, userId, { id: "push:b2", workoutId: "slot-2", name: `Strength program — ${DAY} (2)`, title: "Strength program · Upper" });
    // A long program name, cut to fit 36 characters: the stamp no longer starts with the title.
    await push(db, userId, { id: "push:b3", workoutId: "slot-3", name: `Strength and — ${DAY}`, title: "Strength and conditioning for the hills" });
    const names = await loadOwnProgramNames(db, userId, { start: DAY, end: DAY });
    expect(names.get(`Strength program — ${DAY}`)).toBe("Strength program · Hips and back");
    expect(names.get(`Strength program — ${DAY} (2)`)).toBe("Strength program · Upper");
    expect(names.get(`Strength and — ${DAY}`)).toBe("Strength and conditioning for the hills");
  });

  it("never maps another user's stamp", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);
    await push(db, other.userId, { id: "push:x", name: `Strength program — ${DAY}`, title: "Strength program" });
    expect((await loadOwnProgramNames(db, userId)).size).toBe(0);
  });
});

describe("recordedStampFor — program pushes", () => {
  it("returns the newest verified program stamp for the row", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await push(db, userId, { id: "push:old", name: `Strength program — ${DAY}`, title: "Strength program", verifiedAt: `${DAY}T08:00:00.000Z` });
    await push(db, userId, { id: "push:new", name: `Strength program — ${DAY} (2)`, title: "Strength program", verifiedAt: `${DAY}T09:00:00.000Z` });
    // Queued, never verified: it has put nothing on the wire.
    await push(db, userId, { id: "push:queued", name: `Strength program — ${DAY} (3)`, title: "Strength program", status: "queued", verifiedAt: null });
    expect(await recordedStampFor(db, userId, "slot-1")).toBe(`Strength program — ${DAY} (2)`);
  });

  it("is null for a row whose push never verified", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await push(db, userId, { id: "push:q", name: `Strength program — ${DAY}`, title: "Strength program", status: "queued", verifiedAt: null });
    expect(await recordedStampFor(db, userId, "slot-1")).toBeNull();
  });
});
