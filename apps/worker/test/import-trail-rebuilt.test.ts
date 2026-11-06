/**
 * THE BACKFILL, AT READ TIME (design 2026-11-05 §6.6; phase 5a plan Task 1): a post imported before the trail shows its
 * steps rebuilt from what was kept — where it came from, its screening, the reading (each move's name, dose words and
 * what it stated or guessed), its links and their flags, its batch, the owner's choices, what was saved — each one
 * `rebuilt`, dated only by a time that was kept. No production write: nothing here stores a rebuilt step. Synthetic data:
 * Zorbex names, a made-up creator, the link assembled at runtime.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { TrailEventDto } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, exerciseProvenance, importEvents } = schema;

const CAPTURED = "2026-10-24T09:15:00.000Z";
const MATCHED = "2026-10-24T09:16:30.000Z";
const RELEASED = "2026-10-25T08:00:00.000Z";
const SAVED = "2026-10-26T18:40:00.000Z";
const FITTED = "2026-10-26T18:45:00.000Z";
/** The post's last touch: never a step's date (the controller's addition 2). */
const TOUCHED = "2026-11-06T07:00:00.000Z";

const KEY = ["Zx", "Old", "Post1"].join("");
const link = ["ht", "tps://www.", ["insta", "gram.com"].join(""), "/p/", KEY, "/"].join("");
const fixture = { FIXTURE_MODE: "1", SAVES_IMPORT: "1" } as unknown as Env;

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => { statements += 1; } });
  ({ userId } = await makeTestUser(db));
  statements = 0;
});

const move = (name: string, dose: string, evidence: Record<string, string>, purpose: string) => ({
  name, aliases: [], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose, dose: { text: dose, type: "reps" },
  patterns: ["mobility"], regions: ["hips"], equipment: [], position: "floor", laterality: "bilateral", load: "bodyweight",
  contraction: ["isotonic"], difficulty: 2, conditions: {}, evidence, confidence: "high",
});

/** A typical old Instagram post: read, matched (two of the owner's moves, one library move), batched, fitted, saved. */
async function oldPost(over: { status?: string; batch?: Partial<typeof saveBatches.$inferInsert> | null; seeded?: boolean } = {}) {
  const id = await savedPostId(userId, "instagram", KEY);
  const batchId = over.batch === null ? null : "batch-old";
  if (batchId) {
    await db.insert(saveBatches).values({
      id: batchId, userId, status: "saved", theme: null, createdAt: RELEASED, releasedAt: RELEASED, savedAt: SAVED, fittedAt: FITTED,
      fitStartedAt: SAVED, notice: null, ...(over.batch ?? {}),
    });
  }
  await db.insert(savedPosts).values({
    id, userId, source: "instagram", sourceKey: KEY, url: link, creatorHandle: "zorbex.coach", creatorName: "Zorbex Coach",
    caption: "Three slow hip moves for after a run.", hashtags: [], mediaType: "video", postedAt: "2026-10-20T00:00:00.000Z",
    firstSeenAt: CAPTURED, status: over.status ?? "matched", filterVerdict: "training", filterReason: "a hip mobility routine",
    filterStage: "model", seeded: over.seeded ?? false, batchId, updatedAt: TOUCHED, costMicros: 6_000,
    extraction: {
      kind: "routine", summary: "Three slow hip moves for after a run.", themes: ["mobility"],
      moves: [
        move("Zorbex hip lift", "2x30s", { name: "stated", dose: "stated", steps: "stated" }, "Opens the hips after a run"),
        move("Zorbex knee sways", "10 each side", { name: "stated", dose: "inferred", steps: "inferred" }, "Loosens the knees"),
        move("Goblet squat", "3x8", { name: "stated", dose: "stated", steps: "stated" }, "Strength"),
      ],
      insights: ["Do these after easy runs, not hard ones"],
    },
  });
  await db.insert(personalMoves).values([
    { id: "myZorbexHipLift0001", userId, status: "active", record: { name: "Zorbex hip lift" }, editedByOwner: true, fitChoice: "include", batchId, createdAt: MATCHED, updatedAt: SAVED },
    { id: "myZorbexKneeSway002", userId, status: "merged", mergedInto: "myZorbexKneeSwing03", record: { name: "Zorbex knee sway" }, batchId, createdAt: MATCHED, updatedAt: SAVED },
    { id: "myZorbexKneeSwing03", userId, status: "active", record: { name: "Zorbex knee swing" }, createdAt: CAPTURED, updatedAt: CAPTURED },
    { id: "myZorbexHipRaise004", userId, status: "active", record: { name: "Zorbex hip raise" }, createdAt: CAPTURED, updatedAt: CAPTURED },
  ]);
  await db.insert(savedPostMoves).values([
    { id: "lk0", userId, postId: id, position: 0, moveId: "myZorbexHipLift0001", moveKind: "personal", batchId, confidence: 1, checkFlag: true, likeMoveId: "myZorbexHipRaise004", status: "saved", createdAt: MATCHED },
    { id: "lk1", userId, postId: id, position: 1, moveId: "myZorbexKneeSway002", moveKind: "personal", batchId, confidence: 0.6, checkFlag: false, status: "saved", createdAt: MATCHED },
    { id: "lk2", userId, postId: id, position: 2, moveId: "gobletSquat", moveKind: "library", batchId, confidence: 1, checkFlag: false, status: "removed", createdAt: MATCHED },
  ]);
  await db.insert(exerciseProvenance).values([
    { id: "lk0", userId, exerciseId: "myZorbexHipLift0001", sourceType: "instagram", url: link, creator: "zorbex.coach", sourceKey: `imp:${KEY}#0`, createdAt: SAVED, note: "Opens the hips after a run" },
    { id: "lk1", userId, exerciseId: "myZorbexKneeSway002", sourceType: "instagram", url: link, creator: "zorbex.coach", sourceKey: `imp:${KEY}#1`, createdAt: SAVED, note: "Loosens the knees" },
  ]);
  return id;
}

const stepOf = (events: TrailEventDto[], stage: string) => events.find((e) => e.stage === stage)!;
const detailOf = (events: TrailEventDto[], stage: string) => stepOf(events, stage).detail as Record<string, any>;

describe("the rebuilt trail carries what was kept (§6.6)", () => {
  it("every kept step, in pipeline order, each rebuilt — and nothing is written", async () => {
    const id = await oldPost();
    const before = await db.select().from(importEvents);
    const trail = (await readPostTrail(db, userId, id))!;
    expect(trail.rebuilt).toBe(true);
    expect(trail.events.map((e) => [e.stage, e.rebuilt])).toEqual([
      ["submit", true], ["screen", true], ["extract", true], ["match", true], ["batch", true], ["choice", true], ["save", true],
    ]);
    expect(await db.select().from(importEvents)).toEqual(before);
  });

  it("provenance: where it came from, by whom, and when it was captured", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    const step = stepOf(trail.events, "submit");
    expect(step.summary).toBe("Found by the extension");
    expect(step.detail).toMatchObject({ source: "instagram", creator: "Zorbex Coach (zorbex.coach)", mediaType: "video", captured: CAPTURED, posted: "2026-10-20T00:00:00.000Z" });
    const seeded = (await readPostTrail(db, userId, await (async () => { await db.delete(savedPosts); await db.delete(saveBatches); await db.delete(personalMoves); await db.delete(savedPostMoves); await db.delete(exerciseProvenance); return oldPost({ seeded: true }); })()))!;
    expect(stepOf(seeded.events, "submit").summary).toBe("Brought in with the first import");
  });

  it("the reading: each move's name, dose words and what it stated or guessed, and the post's notes", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(stepOf(trail.events, "extract").summary).toBe("Read 3 moves (a routine)");
    const d = detailOf(trail.events, "extract");
    expect(d.kind).toBe("routine");
    expect(d.moves).toEqual([
      { position: 0, name: "Zorbex hip lift", dose: "2x30s", purpose: "Opens the hips after a run", evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high" },
      { position: 1, name: "Zorbex knee sways", dose: "10 each side", purpose: "Loosens the knees", evidence: { name: "stated", dose: "inferred", steps: "inferred" }, confidence: "high" },
      { position: 2, name: "Goblet squat", dose: "3x8", purpose: "Strength", evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high" },
    ]);
    expect(d.notes).toEqual(["Do these after easy runs, not hard ones"]);
  });

  it("links and their flags: check this, looks like, merged into, left out — by name", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(stepOf(trail.events, "match").summary).toBe("3 moves: 2 already yours, 1 from the library — 1 to check, 1 left out");
    expect(detailOf(trail.events, "match").moves).toEqual([
      { position: 0, name: "Zorbex hip lift", outcome: "personal", moveId: "myZorbexHipLift0001", check: true, like: { id: "myZorbexHipRaise004", name: "Zorbex hip raise" }, now: "saved", confidence: 1 },
      { position: 1, name: "Zorbex knee sways", outcome: "personal", moveId: "myZorbexKneeSway002", check: false, mergedInto: { id: "myZorbexKneeSwing03", name: "Zorbex knee swing" }, now: "saved", confidence: 0.6 },
      { position: 2, name: "Goblet squat", outcome: "library", moveId: "gobletSquat", check: false, now: "removed", confidence: 1 },
    ]);
  });

  it("the batch: which one, and how it stands", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(stepOf(trail.events, "batch")).toMatchObject({ summary: "Joined a batch — saved and fitted in", detail: { batchId: "batch-old", batch: "saved and fitted in" } });
  });

  it("each batch status in words", async () => {
    const words: Record<string, string> = {};
    for (const [status, over] of [
      ["released", { status: "released", savedAt: null, fittedAt: null, fitStartedAt: null }],
      ["held", { status: "held", releasedAt: null, savedAt: null, fittedAt: null, fitStartedAt: null }],
      ["dismissed", { status: "dismissed", savedAt: null, fittedAt: null, fitStartedAt: null, dismissedAt: SAVED }],
      ["superseded", { status: "superseded", savedAt: null, fittedAt: null, fitStartedAt: null }],
      ["saved", { fittedAt: null }],
    ] as const) {
      await db.delete(savedPosts); await db.delete(saveBatches); await db.delete(personalMoves); await db.delete(savedPostMoves); await db.delete(exerciseProvenance);
      const t = (await readPostTrail(db, userId, await oldPost({ batch: over })))!;
      words[status] = stepOf(t.events, "batch").summary;
    }
    expect(words).toEqual({
      released: "Joined a batch — waiting for you",
      held: "Joined a batch — held back",
      dismissed: "Joined a batch — put aside",
      superseded: "Joined a batch — a later one replaced it",
      saved: "Joined a batch — saved, not yet fitted in",
    });
  });

  it("the owner's choices: in or out per move, and the moves they edited", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(stepOf(trail.events, "choice")).toMatchObject({
      source: "owner",
      summary: "Your choices: 1 in, 1 edited",
      detail: { choices: { myZorbexHipLift0001: "include" }, edited: ["Zorbex hip lift"] },
    });
  });

  it("what was saved: each move with the note it was saved with", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(stepOf(trail.events, "save")).toMatchObject({
      summary: "Saved: 2 moves joined your library",
      detail: { moves: [{ position: 0, name: "Zorbex hip lift", note: "Opens the hips after a run" }, { position: 1, name: "Zorbex knee sway", note: "Loosens the knees" }] },
    });
  });

  it("each step is dated by the time that was kept for it, or not at all — never the post's last touch (controller's addition 2)", async () => {
    const trail = (await readPostTrail(db, userId, await oldPost()))!;
    expect(Object.fromEntries(trail.events.map((e) => [e.stage, e.at]))).toEqual({
      submit: CAPTURED, screen: "", extract: "", match: MATCHED, batch: RELEASED, choice: SAVED, save: SAVED,
    });
    expect(trail.events.some((e) => e.at === TOUCHED)).toBe(false);
  });

  it("a post the owner skipped or kept as a reference says so among its choices", async () => {
    const id = await oldPost({ status: "skipped_by_owner", batch: null });
    await db.update(personalMoves).set({ fitChoice: null, editedByOwner: false });
    const trail = (await readPostTrail(db, userId, id))!;
    expect(stepOf(trail.events, "choice")).toMatchObject({ summary: "You skipped it", detail: { post: "skipped" } });
  });

  it("the route reads it within its pin", async () => {
    const id = await oldPost();
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
    statements = 0;
    const res = await app.request(`/api/my-saves/posts/${id}/trail`, { headers: { Cookie: cookie } }, fixture);
    expect(res.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(6); // measured 5 (auth 1 + the read 4), 2026-11-06 (phase 5 backfill)
  });
});

describe("a rebuilt step never doubles one the trail recorded itself", () => {
  it("saved and fitted after the trail began: its own batch, choice and save steps stand alone", async () => {
    const id = await oldPost();
    await db.insert(importEvents).values([
      { id: "b1", userId, postId: id, batchId: "batch-old", stage: "batch", source: "worker", status: "info", summary: "Joined a batch of saved moves (oldest waiting first)", at: RELEASED },
      { id: "c1", userId, postId: id, batchId: "batch-old", stage: "choice", source: "owner", status: "info", summary: "You chose Fit them in", at: SAVED },
      { id: "s1", userId, postId: id, batchId: "batch-old", stage: "save", source: "worker", status: "ok", summary: "Saved: its new moves joined your library", at: SAVED },
    ]);
    const trail = (await readPostTrail(db, userId, id))!;
    expect(trail.events.map((e) => [e.stage, e.rebuilt])).toEqual([
      ["submit", true], ["screen", true], ["extract", true], ["match", true], ["batch", false], ["choice", false], ["save", false],
    ]);
  });
});
