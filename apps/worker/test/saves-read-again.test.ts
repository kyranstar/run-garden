/**
 * READ IT AGAIN (design 2026-11-05 §6.6; phase 5a plan Tasks 6–7): an old post's trail offers a re-read under the
 * current prompt, at a cost said before the tap. The tap puts the post back in the queue keeping its reading; the
 * computer's extension finds it on its work list (`/work`) and reads it as any `extract` work. The re-read is lined up
 * with the post's links before it is stored, and never rewrites a move, a link, or an approved correction. Synthetic
 * data: Zorbex names, a made-up creator, the link assembled at runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { overridePost, savedPostId, workList } from "../src/services/saves-ledger.js";
import { EXTRACT_MODEL_DEFAULT, typicalReadingMicros } from "../src/services/saves-relay.js";
import { readAgain } from "../src/services/saves-reread.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, importEvents, importCorrections } = schema;
const NOW = "2026-11-06T10:00:00.000Z";
const CAPTURED = "2026-10-24T09:15:00.000Z";
const MODEL = EXTRACT_MODEL_DEFAULT;
const KEY = ["Zx", "Old", "Post2"].join("");
const link = ["ht", "tps://www.", ["insta", "gram.com"].join(""), "/p/", KEY, "/"].join("");
const fixture = { FIXTURE_MODE: "1", SAVES_IMPORT: "1" } as unknown as Env;

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => { statements += 1; } });
  ({ userId } = await makeTestUser(db));
  statements = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

/** The earlier reading as it was kept (extract-4: no quotes, no reasons), its first note dropped by an approved correction. */
const EARLIER = {
  kind: "routine", summary: "Two slow hip moves.", themes: ["mobility"],
  moves: [
    { name: "Zorbex hip lift", aliases: [], dose: { text: "2x30s" }, purpose: "Opens the hips", useWhen: [{ text: "after easy runs", evidence: "stated" }] },
    { name: "Zorbex knee sways", aliases: [], dose: { text: "10 each side" }, purpose: "Loosens the knees" },
  ],
  insights: [{ text: "Old note", scope: "general", dropped: true }, "Second note"],
};
const EDITED = { name: "Zorbex hip lift (mine)", dose: { type: "time", range: [30, 30], sets: [3, 3] } };

/**
 * A typical old Instagram post, read and matched before the trail, its batch saved and fitted in — and since then: the
 * owner edited its first move, the coach corrected that move's dose, its second link ("same as": now the owner's own
 * swing), the reading's use-when, and dropped a note.
 */
async function oldSaved(over: { status?: string; batch?: Partial<typeof saveBatches.$inferInsert>; linkStatus?: "saved" | "pending" } = {}) {
  const id = await savedPostId(userId, "instagram", KEY);
  await db.insert(saveBatches).values({
    id: "batch-old", userId, status: "saved", createdAt: CAPTURED, releasedAt: CAPTURED, savedAt: CAPTURED, fittedAt: CAPTURED, notice: null, ...(over.batch ?? {}),
  });
  await db.insert(savedPosts).values({
    id, userId, source: "instagram", sourceKey: KEY, url: link, creatorHandle: "zorbex.coach", creatorName: "Zorbex Coach",
    caption: "Two slow hip moves for after a run.", hashtags: [], mediaType: "video", firstSeenAt: CAPTURED, status: over.status ?? "matched",
    filterVerdict: "training", filterReason: "a hip routine", filterStage: "model", extraction: EARLIER, batchId: "batch-old",
    extractAttempts: 1, updatedAt: CAPTURED,
  });
  await db.insert(personalMoves).values([
    { id: "myZorbexHipLift0001", userId, status: "active", record: EDITED, editedByOwner: true, batchId: "batch-old", createdAt: CAPTURED, updatedAt: CAPTURED },
    { id: "myZorbexKneeSway002", userId, status: "merged", mergedInto: "myZorbexKneeSwing03", record: { name: "Zorbex knee sway" }, batchId: "batch-old", createdAt: CAPTURED, updatedAt: CAPTURED },
    { id: "myZorbexKneeSwing03", userId, status: "active", record: { name: "Zorbex knee swing" }, createdAt: CAPTURED, updatedAt: CAPTURED },
  ]);
  await db.insert(savedPostMoves).values([
    { id: "lk0", userId, postId: id, position: 0, moveId: "myZorbexHipLift0001", moveKind: "personal", batchId: "batch-old", confidence: 1, status: over.linkStatus ?? "saved", createdAt: CAPTURED },
    { id: "lk1", userId, postId: id, position: 1, moveId: "myZorbexKneeSwing03", moveKind: "personal", batchId: "batch-old", confidence: 1, status: over.linkStatus ?? "saved", createdAt: CAPTURED },
  ]);
  const fix = (n: string, target: "move" | "link" | "reading" | "insight", targetId: string, field: string, before: unknown, after: unknown) => ({
    id: n, userId, target, targetId, field, before, after, why: "the post says so", basis: "evidence" as const, by: "coach" as const, at: CAPTURED,
  });
  await db.insert(importCorrections).values([
    fix("fx1", "move", "myZorbexHipLift0001", "dose", { text: "8-12 reps" }, EDITED.dose),
    fix("fx2", "link", `${id}:1`, "same_as", "myZorbexKneeSway002", "myZorbexKneeSwing03"),
    fix("fx3", "reading", `${id}:0`, "useWhen", null, [{ text: "after easy runs", evidence: "stated" }]),
    fix("fx4", "insight", `${id}:0`, "drop", null, true),
  ]);
  return id;
}
const post = async (id: string) => (await db.select().from(savedPosts).where(eq(savedPosts.id, id)))[0]!;
const linksOf = async (id: string) =>
  (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, id))).map((l) => [l.position, l.moveId, l.status, l.batchId]).sort();

describe("what a reading costs, said before the tap", () => {
  it("a reel: a typical one's words and a minute of video; a video page: its words, and its length when it's watched", () => {
    const reel = typicalReadingMicros(MODEL, { source: "instagram", mediaType: "video", durationSec: null, textChars: 200 });
    const photo = typicalReadingMicros(MODEL, { source: "instagram", mediaType: "image", durationSec: null, textChars: 200 });
    const short = typicalReadingMicros(MODEL, { source: "youtube", mediaType: "video", durationSec: 600, textChars: 20_000 });
    const long = typicalReadingMicros(MODEL, { source: "youtube", mediaType: "video", durationSec: 2_400, textChars: 20_000 });
    expect(reel).toBeGreaterThan(photo);
    expect(short).toBeGreaterThan(long); // a long one is read from its words unless the owner asks
    expect(reel).toBeGreaterThan(0);
  });
});

describe("Read it again: the ask", () => {
  it("puts the post back in the queue keeping its reading, says so on its trail with the cost, and /work hands it out", async () => {
    const id = await oldSaved();
    statements = 0;
    expect(await readAgain(db, userId, id, NOW)).toBe("ok");
    expect(statements).toBeLessThanOrEqual(3); // the post 1, then the event and the post's update in one batch (2)
    expect(await post(id)).toMatchObject({ status: "queued", extraction: EARLIER, extractAttempts: 0, lastErrorCode: null, batchId: "batch-old" });
    expect(await linksOf(id)).toEqual([[0, "myZorbexHipLift0001", "saved", "batch-old"], [1, "myZorbexKneeSwing03", "saved", "batch-old"]]);
    const asked = (await db.select().from(importEvents).where(eq(importEvents.postId, id)))[0]!;
    expect(asked).toMatchObject({ stage: "choice", source: "owner", status: "info", detail: { action: "reread" } });
    expect(asked.summary).toMatch(/^You asked for it to be read again \((about \$0\.\d\d|under \$0\.01)\)$/);
    // The computer's extension picks it up as any reading (old and new extensions alike: an Instagram post).
    expect((await workList(db, userId, NOW)).map((w) => [w.key, w.action])).toEqual([[KEY, "extract"]]);
    expect((await workList(db, userId, NOW, 20, { links: true })).map((w) => [w.key, w.action])).toEqual([[KEY, "extract"]]);
  });

  it("the trail offers it on an old post, with its cost; asked, it waits for the extension", async () => {
    const id = await oldSaved();
    const before = (await readPostTrail(db, userId, id, NOW))!;
    expect(before.post.readAgain).toEqual({
      offer: true, asked: false,
      costMicros: typicalReadingMicros(MODEL, { source: "instagram", mediaType: "video", durationSec: null, textChars: "Two slow hip moves for after a run.".length }),
    });
    await readAgain(db, userId, id, NOW);
    const after = (await readPostTrail(db, userId, id, NOW))!;
    expect(after.post.readAgain).toMatchObject({ offer: false, asked: true });
    expect(after.rebuilt).toBe(true); // still its kept steps until the new reading is in
  });

  it("refused — and not offered — for a post with a reading of its own, one being fitted in, one with moves waiting in an open batch, one the owner skipped or kept as a reference, or filtered out", async () => {
    const cases: [string, () => Promise<string>][] = [
      ["own reading", async () => {
        const id = await oldSaved();
        await db.insert(importEvents).values({ id: "x1", userId, postId: id, stage: "extract", source: "gateway", status: "ok", summary: "Read 2 moves", detail: { kind: "routine", moves: 2 }, at: CAPTURED });
        return id;
      }],
      ["fitting", () => oldSaved({ batch: { fittedAt: null, fitStartedAt: "2026-11-06T09:50:00.000Z" } })],
      ["waiting", () => oldSaved({ batch: { status: "released", savedAt: null, fittedAt: null }, linkStatus: "pending" })],
      ["skipped", () => oldSaved({ status: "skipped_by_owner" })],
      ["reference", () => oldSaved({ status: "reference_only" })],
      ["filtered", () => oldSaved({ status: "filtered_out" })],
    ];
    for (const [name, make] of cases) {
      for (const t of [importEvents, importCorrections, savedPostMoves, personalMoves, savedPosts, saveBatches]) await db.delete(t);
      const id = await make();
      expect([name, await readAgain(db, userId, id, NOW)]).toEqual([name, "conflict"]);
      expect([name, (await readPostTrail(db, userId, id, NOW))!.post.readAgain?.offer ?? false]).toEqual([name, false]);
      expect([name, (await post(id)).status]).not.toEqual([name, "queued"]);
    }
  });

  it("asked once, a second tap is refused; another account's post isn't found", async () => {
    const id = await oldSaved();
    expect(await readAgain(db, userId, id, NOW)).toBe("ok");
    expect(await readAgain(db, userId, id, NOW)).toBe("conflict");
    expect(await readAgain(db, (await makeTestUser(db)).userId, id, NOW)).toBe("not_found");
  });

  it("the route: 200, 409 when it can't be, 404 for another's", async () => {
    const id = await oldSaved();
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
    const tap = (pid: string) => app.request(`/api/my-saves/posts/${pid}/read-again`, { method: "POST", headers: { Cookie: cookie } }, fixture);
    expect((await tap(id)).status).toBe(200);
    const again = await tap(id);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_readable" });
    expect((await tap("nope")).status).toBe(404);
  });
});

describe("Retry on a post that has links keeps its reading (phase 5a)", () => {
  it("a re-read that failed and is retried still has the reading its links are lined up with", async () => {
    const id = await oldSaved({ status: "failed" });
    await db.update(savedPosts).set({ lastErrorCode: "media_failed" }).where(eq(savedPosts.id, id));
    expect(await overridePost(db, userId, { id }, "process", NOW)).toBe("ok");
    expect(await post(id)).toMatchObject({ status: "queued", extraction: EARLIER });
  });
});
