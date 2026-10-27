/**
 * Batches: matched posts are gathered into a batch only while no batch is open (released or saved, neither fitted in
 * nor dismissed), oldest first and at most 12 new moves a batch (a held one while SAVES_HOLD_BATCHES is on), with the
 * notice the coach will read and near-duplicates flagged at the cut; nothing in a batch is usable until it is saved,
 * and saving writes the links into `exercise_provenance` once, in a constant number of statements however big the batch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES, type ExerciseRecord } from "@rg/exercise-library";
import { batchNotice, personalMoveId, type Extraction, type ExtractedMove } from "@rg/saves";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import { insertBatches, type Db } from "../src/services/db.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { assembleBatch, BATCH_NEW_MAX, FIT_STARTED_TTL_MS, isFitting, saveBatch } from "../src/services/saves-batches.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, saveBatches, exerciseProvenance } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;

let db: Db;
let userId: string;
let statements = 0;
let writes = 0;

const ratings = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "Fine." },
  ]),
) as ExtractedMove["conditions"];
const move = (name: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name, aliases: [], summary: "A synthetic move.", steps: ["Start.", "Finish."], cues: [], mistakes: [], purpose: "mobility",
  dose: { text: "8", type: "reps", range: [6, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "seated",
  laterality: "alternating", load: "none", contraction: ["isotonic"], difficulty: 2, conditions: ratings,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high", ...over,
});
const extraction = (moves: ExtractedMove[]): Extraction => ({ kind: "routine", summary: "s", themes: [], moves });

const env = (over: Partial<Env> = {}): Env => ({ FIXTURE_MODE: "1", ...over }) as unknown as Env;
const noFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

/** An extracted post, matched (fixture mode: no judge). */
async function matched(key: string, moves: ExtractedMove[], owner = userId, now = T0) {
  const id = await savedPostId(owner, SRC, key);
  await db.insert(savedPosts).values({
    id, userId: owner, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: "someone",
    firstSeenAt: now, status: "extracted", extraction: extraction(moves), extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, env(), owner, id, now, noFetch);
  return id;
}

const batchOf = async (id: string) => (await db.select().from(saveBatches).where(eq(saveBatches.id, id)))[0]!;
const close = (id: string, set: { fittedAt?: string; dismissedAt?: string }) => db.update(saveBatches).set(set).where(eq(saveBatches.id, id));
const postBatches = async () => Object.fromEntries((await db.select().from(savedPosts)).map((p) => [p.sourceKey, p.batchId]));
/** Distinct names no two of which share more than one word: never near-duplicates of each other. */
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega"];
/** A new move to ride with: a batch is cut only when its posts bring one. */
const NECK = move("Zorbex neck nod", { regions: ["neck"] });
const greek = (from: number, n: number) => GREEK.slice(from, from + n).map((w) => move(`Zorbex ${w}`));
/** A personal move of the account's own, stored as the import stores one; its id. */
async function ownMove(name: string, status: "active" | "pending"): Promise<string> {
  const id = personalMoveId(name, `${userId}:${name}`);
  await db.insert(personalMoves).values({
    id, userId, status, mergedInto: null, batchId: null, record: toPersonalRecord(id, move(name)), editedByOwner: false, createdAt: T0, updatedAt: T0,
  });
  return id;
}
const linksOf = async (moveId: string) => db.select().from(savedPostMoves).where(eq(savedPostMoves.moveId, moveId));
const personalIdOf = async (postId: string, position: number) =>
  (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, postId))).find((l) => l.position === position)!.moveId;

beforeEach(async () => {
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      statements += 1;
      if (isWrite(sql)) writes += 1;
    },
  });
  ({ userId } = await makeTestUser(db));
  statements = 0;
  writes = 0;
});

describe("assembleBatch", () => {
  it("releases one batch of the matched posts, with the notice, and stamps posts, links and new moves", async () => {
    const a = await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const b = await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })]);
    statements = 0;
    const id = await assembleBatch(db, env(), userId, at(1));
    expect(id).toBeTruthy();
    // gate 1, waiting 1, personal moves 1, the batch and its stamps 4
    expect(statements).toBe(7);
    const records = (await db.select().from(personalMoves)).map((m) => m.record as ExerciseRecord);
    expect(records).toHaveLength(2);
    expect(await batchOf(id!)).toMatchObject({
      userId, status: "released", releasedAt: at(1), createdAt: at(1), savedAt: null, notice: batchNotice(records, 1),
    });
    expect((await batchOf(id!)).notice).toBe("From your saves: 2 new moves (1 hip, 1 neck), 1 you already had.");
    const posts = await db.select().from(savedPosts);
    expect(posts.map((p) => p.batchId)).toEqual([id, id]);
    expect((await db.select().from(savedPostMoves)).every((l) => l.batchId === id && l.status === "pending")).toBe(true);
    expect((await db.select().from(personalMoves)).every((m) => m.batchId === id && m.status === "pending")).toBe(true);
    expect([a, b]).toHaveLength(2);
  });

  it("no batch while one is open; fitted in or dismissed opens the gate", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = (await assembleBatch(db, env(), userId, at(0)))!;
    expect(first).toBeTruthy();
    await matched("b", [move("Zorbex neck nod", { regions: ["neck"] })], userId, at(2));
    // Released, not fitted in, not dismissed: open. No time opens it.
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(200))).toBeNull();
    expect(writes).toBe(0);
    // Saved, not yet fitted in: still open.
    await saveBatch(db, userId, first, at(201));
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(202))).toBeNull();
    expect(writes).toBe(0);
    expect(await postBatches()).toEqual({ a: first, b: null });
    // Fitted in: the gate opens, and what waited is gathered.
    await close(first, { fittedAt: at(203) });
    const second = (await assembleBatch(db, env(), userId, at(204)))!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await postBatches()).toEqual({ a: first, b: second });
    // The second is open now; dismissed ("Not now"), it opens the gate as well.
    await matched("c", [move("Zorbex calf rock", { regions: ["calves"] })], userId, at(205));
    expect(await assembleBatch(db, env(), userId, at(206))).toBeNull();
    await close(second, { dismissedAt: at(207) });
    const third = (await assembleBatch(db, env(), userId, at(208)))!;
    expect(third).toBeTruthy();
    expect(await postBatches()).toEqual({ a: first, b: second, c: third });
  });

  it("takes the oldest posts first up to 12 new moves; the rest wait for the next batch", async () => {
    expect(BATCH_NEW_MAX).toBe(12);
    // Arrival order, not key order: "c" came first.
    await matched("c", greek(0, 5), userId, at(0));
    await matched("a", greek(5, 5), userId, at(1));
    await matched("b", greek(10, 5), userId, at(2));
    const id = (await assembleBatch(db, env(), userId, at(3)))!;
    expect(await postBatches()).toEqual({ c: id, a: id, b: null });
    const carried = (await db.select().from(personalMoves)).filter((m) => m.batchId === id);
    expect(new Set(carried.map((m) => m.id)).size).toBe(10);
    expect((await batchOf(id)).notice).toBe("From your saves: 10 new moves (10 hip).");
    expect((await db.select().from(savedPostMoves)).filter((l) => l.batchId === null)).toHaveLength(5);
  });

  it("linked moves ride along and never count toward the cap", async () => {
    await matched("lib", [move("90/90 Hip Switch"), move("90-90 hip switches")], userId, at(0));
    await matched("new", greek(0, 12), userId, at(1));
    const id = (await assembleBatch(db, env(), userId, at(2)))!;
    expect(await postBatches()).toEqual({ lib: id, new: id });
    expect((await db.select().from(savedPostMoves)).every((l) => l.batchId === id)).toBe(true);
    expect((await batchOf(id)).notice).toBe("From your saves: 12 new moves (12 hip), 1 you already had.");
  });

  it("a pool whose moves are all the owner's makes no batch; they ride with the next new move", async () => {
    await matched("l1", [move("90/90 Hip Switch")], userId, at(0));
    await matched("l2", [move("90-90 hip switches")], userId, at(1));
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(2))).toBeNull();
    expect(writes).toBe(0);
    expect(await db.select().from(saveBatches)).toEqual([]);
    expect(await postBatches()).toEqual({ l1: null, l2: null });
    await matched("n", [move("Zorbex quad shuffle")], userId, at(3));
    const id = (await assembleBatch(db, env(), userId, at(4)))!;
    expect(await postBatches()).toEqual({ l1: id, l2: id, n: id });
  });

  it("a move shared across the cut counts once and stays new in the later batch while pending", async () => {
    // Post 1: twelve new moves, the quad shuffle among them. Post 2: the same quad shuffle and one more new move —
    // thirteen distinct together (not fourteen), so post 2 waits.
    const p1 = await matched("p1", [...greek(0, 11), move("Zorbex quad shuffle")], userId, at(0));
    const p2 = await matched("p2", [move("Zorbex quad shuffles"), move("Zorbex hip circle")], userId, at(1));
    const quad = await personalIdOf(p1, 11);
    expect(await personalIdOf(p2, 0)).toBe(quad);
    const first = (await assembleBatch(db, env(), userId, at(2)))!;
    expect(await postBatches()).toEqual({ p1: first, p2: null });
    expect((await batchOf(first)).notice).toBe("From your saves: 12 new moves (12 hip).");
    // "Not now": the quad shuffle stays pending, the first batch's. In the next batch it is new, never one "you had".
    await close(first, { dismissedAt: at(3) });
    const second = (await assembleBatch(db, env(), userId, at(4)))!;
    expect(await postBatches()).toEqual({ p1: first, p2: second });
    expect((await batchOf(second)).notice).toBe("From your saves: 2 new moves (2 hip).");
  });

  it("a move two posts share counts once toward the cap: eleven and one more make twelve, and both posts ride", async () => {
    await matched("p1", [...greek(0, 10), move("Zorbex quad shuffle")], userId, at(0));
    await matched("p2", [move("Zorbex quad shuffles"), move("Zorbex hip circle")], userId, at(1));
    const id = (await assembleBatch(db, env(), userId, at(2)))!;
    expect(await postBatches()).toEqual({ p1: id, p2: id });
    expect((await batchOf(id)).notice).toBe("From your saves: 12 new moves (12 hip).");
  });

  it("near-duplicates at the cut: like an active move, and the later of two like new moves — one statement", async () => {
    const hold = await ownMove("Zorbex cobra hold", "active");
    const p1 = await matched("p1", [move("Zorbex cobra chest lift"), move("Zorbex rotational swing")], userId, at(0));
    const p2 = await matched("p2", [move("Zorbex dynamic rotational swing")], userId, at(1));
    const lift = await personalIdOf(p1, 0);
    const swing = await personalIdOf(p1, 1);
    const dynamic = await personalIdOf(p2, 0);
    statements = 0;
    const id = (await assembleBatch(db, env(), userId, at(2)))!;
    // gate 1, waiting 1, personal moves 1, the batch and its stamps 4, the near-duplicate marks 1
    expect(statements).toBe(8);
    expect(await linksOf(lift)).toEqual([expect.objectContaining({ batchId: id, checkFlag: true, likeMoveId: hold })]);
    expect(await linksOf(dynamic)).toEqual([expect.objectContaining({ batchId: id, checkFlag: true, likeMoveId: swing })]);
    expect(await linksOf(swing)).toEqual([expect.objectContaining({ batchId: id, checkFlag: false, likeMoveId: null })]);
  });

  it("holds the batch while SAVES_HOLD_BATCHES is on: no release, no notice yet", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = await assembleBatch(db, env({ SAVES_HOLD_BATCHES: "1" }), userId, at(1));
    expect(await batchOf(id!)).toMatchObject({ status: "held", releasedAt: null, notice: null });
  });

  it("does nothing with no matched post waiting", async () => {
    await db.insert(savedPosts).values({
      id: "q", userId, source: SRC, sourceKey: "q", firstSeenAt: T0, status: "queued", updatedAt: T0,
    });
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect(writes).toBe(0);
    expect(await db.select().from(saveBatches)).toEqual([]);
  });

  it("does not make a batch of posts that showed no moves", async () => {
    await matched("tips", []);
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect(await db.select().from(saveBatches)).toEqual([]);
  });

  it("leaves another account's posts alone", async () => {
    const other = (await makeTestUser(db)).userId;
    await matched("theirs", [move("Zorbex quad shuffle")], other);
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect((await db.select().from(savedPosts))[0]!.batchId).toBeNull();
  });

  it("counts a move another post already brought as the owner's when it was saved before", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = await assembleBatch(db, env(), userId, at(0));
    await saveBatch(db, userId, first!, at(1));
    await close(first!, { fittedAt: at(1.5) });
    // A post of only moves the owner has waits for a new move: the neck nod rides with it.
    await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })], userId, at(2));
    const second = await assembleBatch(db, env(), userId, at(21));
    expect((await batchOf(second!)).notice).toBe("From your saves: 1 new move (neck), 1 you already had.");
  });

  it("isFitting: true for the hour after a fit starts, false before one starts and after", () => {
    expect(FIT_STARTED_TTL_MS).toBe(3_600_000);
    expect(isFitting(null, at(0))).toBe(false);
    expect(isFitting(at(0), at(0))).toBe(true);
    expect(isFitting(at(0), at(0.99))).toBe(true);
    expect(isFitting(at(0), at(1))).toBe(false);
  });
});

describe("assembleBatch's notice and the review page agree on what is new (final review M1)", () => {
  it("a pending move an earlier, unsaved batch brought reads as new in the later batch (§12.3)", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = await assembleBatch(db, env(), userId, at(0));
    expect((await batchOf(first!)).notice).toBe("From your saves: 1 new move (hip).");
    // Dismissed, never saved: the move stays pending, the first batch's. A later post shows it again, and a new one.
    await close(first!, { dismissedAt: at(1) });
    await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })], userId, at(2));
    const second = await assembleBatch(db, env(), userId, at(21));
    // Not yet the owner's: the page counts it New, and so does the notice.
    expect((await batchOf(second!)).notice).toBe("From your saves: 2 new moves (1 hip, 1 neck).");
  });
});

describe("saveBatch", () => {
  it("writes provenance only on save: moves active, links saved, the batch saved", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    await matched("b", [move("Zorbex quad shuffles")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await db.select().from(exerciseProvenance)).toEqual([]);
    statements = 0;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 3 });
    // The batch and its counts, then one transaction of 5 (the insights kept in memory, spec §17).
    expect(statements).toBe(6);
    const [pm] = await db.select().from(personalMoves);
    expect(pm).toMatchObject({ status: "active", updatedAt: at(2) });
    expect((await db.select().from(savedPostMoves)).every((l) => l.status === "saved")).toBe(true);
    expect(await batchOf(id)).toMatchObject({ status: "saved", savedAt: at(2) });
    const links = (await db.select().from(exerciseProvenance)).sort((x, y) => (x.sourceKey ?? "").localeCompare(y.sourceKey ?? ""));
    expect(links.map((l) => ({ ...l, id: undefined }))).toEqual([
      // Each with its note: the post's purpose for the move (spec §17).
      { id: undefined, userId, exerciseId: pm!.id, sourceType: SRC, url: "https://example.com/p/a", creator: "someone", sourceKey: "imp:a#0", createdAt: at(2), note: "mobility" },
      { id: undefined, userId, exerciseId: HIP_SWITCH.id, sourceType: SRC, url: "https://example.com/p/a", creator: "someone", sourceKey: "imp:a#1", createdAt: at(2), note: "mobility" },
      { id: undefined, userId, exerciseId: pm!.id, sourceType: SRC, url: "https://example.com/p/b", creator: "someone", sourceKey: "imp:b#0", createdAt: at(2), note: "mobility" },
    ]);
  });

  it("twice writes nothing new", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await saveBatch(db, userId, id, at(2));
    const before = await db.select().from(exerciseProvenance);
    writes = 0;
    expect(await saveBatch(db, userId, id, at(3))).toEqual({ moves: 0, links: 0 });
    expect(writes).toBe(0);
    expect(await db.select().from(exerciseProvenance)).toEqual(before);
    expect(await batchOf(id)).toMatchObject({ savedAt: at(2) });
  });

  it("is null for another account's batch, and writes nothing", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    const other = (await makeTestUser(db)).userId;
    writes = 0;
    expect(await saveBatch(db, other, id, at(2))).toBeNull();
    expect(writes).toBe(0);
    expect(await db.select().from(exerciseProvenance)).toEqual([]);
  });

  it("leaves a removed link out", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await db.update(savedPostMoves).set({ status: "removed" }).where(eq(savedPostMoves.position, 1));
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 1 });
    expect((await db.select().from(exerciseProvenance)).map((l) => l.sourceKey)).toEqual(["imp:a#0"]);
  });

  it("leaves a new move whose only link was removed pending, and does not count it", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await db.update(savedPostMoves).set({ status: "removed" }).where(eq(savedPostMoves.position, 0));
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 0, links: 1 });
    expect((await db.select().from(personalMoves))[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(exerciseProvenance)).map((l) => l.exerciseId)).toEqual([HIP_SWITCH.id]);
  });

  it("leaves a curated link to the same post and move exactly as it is, and adds no second one", async () => {
    await db.insert(exerciseProvenance).values({
      id: "curated", userId, exerciseId: HIP_SWITCH.id, sourceType: SRC, url: "https://example.com/p/a", creator: "curated",
      sourceKey: "a#3", createdAt: T0,
    });
    const [before] = await db.select().from(exerciseProvenance);
    // A batch is cut only with a new move: the neck nod rides along.
    await matched("a", [move("90/90 Hip Switch"), NECK]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 2 });
    expect((await db.select().from(exerciseProvenance)).filter((r) => r.exerciseId === HIP_SWITCH.id)).toEqual([before]);
  });

  it("never overwrites a curated link whose key reads like an import's, and adds its own under imp:", async () => {
    await db.insert(exerciseProvenance).values({
      id: "curated", userId, exerciseId: "someOtherMove", sourceType: SRC, url: "https://example.com/p/a", creator: "curated",
      sourceKey: "a#0", createdAt: T0,
    });
    const [before] = await db.select().from(exerciseProvenance);
    await matched("a", [move("90/90 Hip Switch"), NECK]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await saveBatch(db, userId, id, at(2));
    const rows = await db.select().from(exerciseProvenance);
    expect(rows.find((r) => r.id === "curated")).toEqual(before);
    expect(rows.filter((r) => r.id !== "curated").map((r) => r.sourceKey).sort()).toEqual(["imp:a#0", "imp:a#1"]);
    expect(rows.find((r) => r.sourceKey === "imp:a#0")?.exerciseId).toBe(HIP_SWITCH.id);
  });

  it("lists a move once per post, however many times the post shows it", async () => {
    await matched("a", [move("90/90 Hip Switch"), move("90-90 hip switches"), NECK]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 3 });
    expect((await db.select().from(exerciseProvenance)).filter((r) => r.exerciseId === HIP_SWITCH.id).map((r) => r.sourceKey)).toEqual(["imp:a#0"]);
    expect((await db.select().from(savedPostMoves)).every((l) => l.status === "saved")).toBe(true);
  });

  it("makes usable a pending move an earlier, unsaved batch brought, when this batch links to it", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    await close((await assembleBatch(db, env(), userId, at(0)))!, { dismissedAt: at(1) });
    await matched("b", [move("Zorbex quad shuffles")], userId, at(2));
    const second = (await assembleBatch(db, env(), userId, at(21)))!;
    expect(await saveBatch(db, userId, second, at(22))).toEqual({ moves: 1, links: 1 });
    expect((await db.select().from(personalMoves))[0]).toMatchObject({ status: "active" });
  });

  it("saveBatch stamps the moves it makes usable with its own batch", async () => {
    const a = await matched("a", [move("Zorbex quad shuffle")]);
    const first = (await assembleBatch(db, env(), userId, at(0)))!;
    const m = await personalIdOf(a, 0);
    expect((await db.select().from(personalMoves).where(eq(personalMoves.id, m)))[0]).toMatchObject({ status: "pending", batchId: first });
    await close(first, { dismissedAt: at(1) });
    const b = await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })], userId, at(2));
    const second = (await assembleBatch(db, env(), userId, at(3)))!;
    const neck = await personalIdOf(b, 1);
    expect(await saveBatch(db, userId, second, at(4))).toEqual({ moves: 2, links: 2 });
    const byId = Object.fromEntries((await db.select().from(personalMoves)).map((r) => [r.id, r]));
    expect(byId[m]).toMatchObject({ status: "active", batchId: second });
    expect(byId[neck]).toMatchObject({ status: "active", batchId: second });
  });

  it("saves a 600-link batch in the same few statements", async () => {
    const batchId = "big";
    await db.insert(saveBatches).values({ id: batchId, userId, status: "released", createdAt: T0, releasedAt: T0 });
    const posts = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, userId, source: SRC, sourceKey: `k${i}`, url: `https://example.com/p/k${i}`, creatorHandle: "someone",
      firstSeenAt: T0, status: "matched", batchId, updatedAt: T0,
    }));
    // Five a statement: the table's defaulted columns bind too.
    for (let i = 0; i < posts.length; i += 5) await db.insert(savedPosts).values(posts.slice(i, i + 5));
    const links = posts.flatMap((p) =>
      Array.from({ length: 12 }, (_, position) => ({
        id: newId(), userId, postId: p.id, position, moveId: EXERCISES[position]!.id, moveKind: "library" as const, batchId,
        confidence: 1, checkFlag: false, status: "pending" as const, createdAt: T0,
      })),
    );
    for (const chunk of insertBatches(links)) await db.insert(savedPostMoves).values(chunk);
    statements = 0;
    expect(await saveBatch(db, userId, batchId, at(1))).toEqual({ moves: 0, links: 600 });
    expect(statements).toBe(6);
    expect(await db.select().from(exerciseProvenance)).toHaveLength(600);
  });
});
