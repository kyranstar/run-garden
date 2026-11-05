/**
 * The owner's own changes to an import are on its trail (design 2026-11-05 §4, §6.1): an edit to a move writes a
 * correction (before, after, basis "owner") and an event on each post the move came from; a re-match or a removal is an
 * event on its post. The record's history is never just an overwrite.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { editPersonalMove, rematchLink, removeLink } from "../src/services/saves-review.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { importEvents, importCorrections, savedPostMoves } = schema;
const NOW = "2026-11-05T10:00:00.000Z";
let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

const eventsOf = async (postId: string) => db.select().from(importEvents).where(eq(importEvents.postId, postId));
const linkOf = async (postId: string, position: number) =>
  (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, postId))).find((l) => l.position === position)!;

describe("the owner's changes on the trail", () => {
  it("an edit writes one correction per changed field, by the owner, and an event on each post the move came from", async () => {
    const draft = savedMoveDraft("Zorbex lantern reach");
    const seeded = await seedSavedBatch(db, userId, { savedAt: NOW, status: "released", posts: [{ moves: [{ draft }] }, { moves: [{ draft }] }] });
    const moveId = seeded.moveIds[0]![0]!;
    const out = await editPersonalMove(db, userId, moveId, { name: "Zorbex lantern reach long" }, NOW);
    expect(out.kind).toBe("ok");
    const corrections = await db.select().from(importCorrections);
    expect(corrections).toEqual([
      expect.objectContaining({
        target: "move", targetId: moveId, field: "name", before: "Zorbex lantern reach", after: "Zorbex lantern reach long",
        basis: "owner", by: "owner", why: "You edited it",
      }),
    ]);
    for (const postId of seeded.postIds) {
      expect((await eventsOf(postId)).filter((e) => e.stage === "choice")).toEqual([
        expect.objectContaining({ source: "owner", moveId, summary: "You edited Zorbex lantern reach long: name" }),
      ]);
    }
  });

  it("an edit that changes nothing writes nothing", async () => {
    const draft = savedMoveDraft("Zorbex lantern reach");
    const seeded = await seedSavedBatch(db, userId, { savedAt: NOW, status: "released", posts: [{ moves: [{ draft }] }] });
    await editPersonalMove(db, userId, seeded.moveIds[0]![0]!, { name: "Zorbex lantern reach" }, NOW);
    expect(await db.select().from(importCorrections)).toEqual([]);
    expect(await db.select().from(importEvents)).toEqual([]);
  });

  it("a re-match and a removal are each an event on their post, and the re-match a correction of the link", async () => {
    const seeded = await seedSavedBatch(db, userId, {
      savedAt: NOW, status: "released", posts: [{ moves: [{ draft: savedMoveDraft("Zorbex nod") }, { draft: savedMoveDraft("Zorbex tilt") }] }],
    });
    const [postId] = seeded.postIds;
    const first = await linkOf(postId!, 0);
    expect((await rematchLink(db, userId, first.id, "gobletSquat", NOW)).kind).toBe("ok");
    expect(await removeLink(db, userId, (await linkOf(postId!, 1)).id)).toBe("ok");
    const choices = (await eventsOf(postId!)).filter((e) => e.stage === "choice").map((e) => e.summary).sort();
    expect(choices).toEqual(["You removed Zorbex tilt from the batch", "You said Zorbex nod is the same as another move"]);
    expect(await db.select().from(importCorrections)).toEqual([
      expect.objectContaining({ target: "link", targetId: first.id, field: "move", before: first.moveId, after: "gobletSquat", basis: "owner", by: "owner" }),
    ]);
  });
});
