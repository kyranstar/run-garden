import { describe, expect, it } from "vitest";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activeSyncNotes, dismissSyncNote, postSyncNote } from "../src/services/sync-notes.js";

describe("sync notes", () => {
  it("posts, lists, dismisses", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await postSyncNote(db, {
      userId, workoutId: "w1", kind: "adopted_coros_change",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });
    let notes = await activeSyncNotes(db, userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("adopted_coros_change");
    await dismissSyncNote(db, userId, id);
    notes = await activeSyncNotes(db, userId);
    expect(notes).toHaveLength(0);
  });
});
