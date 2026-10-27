/**
 * Matching an extracted post's moves: a library move by name or alias, then the owner's own moves, then a fuzzy library
 * candidate a cheap judge confirms (Review Focus 3), else one new personal move however many times it shows up. A fake
 * gateway arrives as `fetchImpl`; the ledger, the personal moves and the links are checked against the test database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import type { Extraction, ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { IMPORT_KINDS } from "../src/services/saves-budget.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchMoves, matchPost } from "../src/services/saves-match.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, llmUsage, exerciseProvenance } = schema;
const NOW = "2026-10-23T10:00:00.000Z";
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;

let db: Db;
let userId: string;
let statements = 0;
let writes = 0;

/** A rating every profile accepts: each scale at its floor, each flag off. */
const ratings = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    {
      attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])),
      note: "Fine for the jaw.",
    },
  ]),
) as ExtractedMove["conditions"];

const move = (name: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name,
  aliases: [],
  summary: "A synthetic move.",
  steps: ["Start here.", "Finish there."],
  cues: ["Stay tall."],
  mistakes: [],
  purpose: "mobility",
  dose: { text: "8 each side", type: "reps", range: [6, 10] },
  patterns: ["mobility"],
  regions: ["hips"],
  equipment: [],
  position: "seated",
  laterality: "alternating",
  load: "none",
  contraction: ["isotonic"],
  difficulty: 2,
  conditions: ratings,
  evidence: { name: "stated", dose: "inferred", steps: "stated" },
  confidence: "high",
  ...over,
});
const extraction = (moves: ExtractedMove[]): Extraction => ({ kind: "routine", summary: "s", themes: ["mobility"], moves });

async function extracted(key: string, moves: ExtractedMove[], over: Partial<typeof savedPosts.$inferInsert> = {}) {
  const id = await savedPostId(userId, SRC, key);
  await db.insert(savedPosts).values({
    id, userId, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: "someone",
    firstSeenAt: NOW, status: "extracted", extraction: extraction(moves), extractAttempts: 1, updatedAt: NOW, ...over,
  });
  return id;
}

/** One of the owner's moves, active unless `over` says; `draft` changes what its record is built from (its load, its dose). */
async function personal(name: string, over: Partial<typeof personalMoves.$inferInsert> = {}, draft: Partial<ExtractedMove> = {}) {
  const id = `my${name.replace(/[^A-Za-z0-9]/g, "")}abc123`;
  await db.insert(personalMoves).values({
    id, userId, status: "active", record: toPersonalRecord(id, move(name, draft)), createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

const env = (over: Partial<Env> = {}): Env =>
  ({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "k", AI_GATEWAY_BASE_URL: "https://gw.test/v1", ...over }) as unknown as Env;

/** A fake judge: answers `content` (JSON text) and records each request body. */
function judge(content: unknown, over: { status?: number; throws?: boolean } = {}) {
  const calls: any[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    if (over.throws) throw new Error("network down");
    if (over.status) return new Response("nope", { status: over.status });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
        usage: { prompt_tokens: 400, completion_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, spy: fetchImpl };
}

const linksOf = async (postId: string) =>
  (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, postId))).sort((a, b) => a.position - b.position);
const postOf = async (id: string) => (await db.select().from(savedPosts).where(eq(savedPosts.id, id)))[0]!;

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
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("matchMoves", () => {
  it("matches '90/90 Hip Switch' and '90-90 hip switches' to the library move by name, high, with no check", () => {
    const out = matchMoves(extraction([move("90/90 Hip Switch"), move("90-90 hip switches")]), EXERCISES, []);
    expect(out).toEqual([
      expect.objectContaining({ position: 0, kind: "library", id: HIP_SWITCH.id, confidence: "high", check: false }),
      expect.objectContaining({ position: 1, kind: "library", id: HIP_SWITCH.id, confidence: "high", check: false }),
    ]);
  });

  it("matches by an alias too", () => {
    const [d] = matchMoves(extraction([move("Seated windmill knees", { aliases: ["90 90 hip switch"] })]), EXERCISES, []);
    expect(d).toMatchObject({ kind: "library", id: HIP_SWITCH.id, confidence: "high" });
  });

  it("offers 'the 90 90 switch' to the judge with the library move as a candidate", () => {
    const [d] = matchMoves(extraction([move("the 90 90 switch")]), EXERCISES, []);
    expect(d!.kind).toBe("new");
    expect(d!.candidates?.map((c) => c.id)).toContain(HIP_SWITCH.id);
  });

  it("makes a name with no near library name a new move, with its draft and no candidates", () => {
    const [d] = matchMoves(extraction([move("Zorbex quad shuffle")]), EXERCISES, []);
    expect(d).toMatchObject({ position: 0, kind: "new", check: false });
    expect(d!.draft?.name).toBe("Zorbex quad shuffle");
    expect(d!.candidates ?? []).toEqual([]);
  });

  it("matches the owner's own moves (active, pending, archived) by name, high", () => {
    const rows = [
      { id: "myZorbexShuffleaaaaaa", status: "active", mergedInto: null, name: "Zorbex shuffle" },
      { id: "myPendingThingbbbbbb", status: "pending", mergedInto: null, name: "Pending thing" },
      { id: "myOldThingcccccc", status: "archived", mergedInto: null, name: "Old thing" },
    ];
    const out = matchMoves(extraction([move("Zorbex Shuffles"), move("pending things"), move("The old thing")]), EXERCISES, rows);
    expect(out.map((d) => [d.kind, d.id, d.confidence])).toEqual([
      ["personal", "myZorbexShuffleaaaaaa", "high"],
      ["personal", "myPendingThingbbbbbb", "high"],
      ["personal", "myOldThingcccccc", "high"],
    ]);
  });

  it("resolves a merged personal move to the move it was merged into", () => {
    const rows = [
      { id: "myGoneMoveaaaaaa", status: "merged", mergedInto: "myKeptMovebbbbbb", name: "Zorbex shuffle" },
      { id: "myKeptMovebbbbbb", status: "active", mergedInto: null, name: "Kept move" },
    ];
    const [d] = matchMoves(extraction([move("zorbex shuffle")]), EXERCISES, rows);
    expect(d).toMatchObject({ kind: "personal", id: "myKeptMovebbbbbb" });
  });

  it("offers the owner's own near names to the judge too (never a merged one), marked as theirs", () => {
    const rows = [
      { id: "myZorbexHipSwitchaaaaaa", status: "active", mergedInto: null, name: "Zorbex hip switch" },
      // As near by its words as the active one, but merged away: never a candidate.
      { id: "myZorbexBigSwitchbbbbbb", status: "merged", mergedInto: "myZorbexHipSwitchaaaaaa", name: "Zorbex big switch" },
    ];
    const [d] = matchMoves(extraction([move("the zorbex switch")]), EXERCISES, rows);
    expect(d).toMatchObject({ kind: "new", check: true });
    expect(d!.candidates?.map((c) => [c.kind, c.id])).toEqual([["personal", "myZorbexHipSwitchaaaaaa"]]);
  });

  it("an equal name whose load or dose type differs from the owner's move is new and flagged, with no candidates — like it only when it is active", () => {
    const rows = [
      { id: "myZorbexShuffleaaaaaa", status: "active", mergedInto: null, name: "Zorbex shuffle", load: "none", doseType: "reps" },
      { id: "myZorbexHoldbbbbbb", status: "pending", mergedInto: null, name: "Zorbex hold", load: "none", doseType: "reps" },
    ];
    const out = matchMoves(
      extraction([
        move("Zorbex shuffles", { load: "bodyweight" }),
        move("zorbex hold", { dose: { text: "30 s", type: "time", range: [20, 40] } }),
        // Unknown on one side is no difference: an unstated dose type links as before.
        move("Zorbex shuffle", { dose: { text: "a few" } }),
      ]),
      EXERCISES,
      rows,
    );
    expect(out[0]).toEqual({ position: 0, kind: "new", confidence: "high", check: true, draft: expect.anything(), like: "myZorbexShuffleaaaaaa" });
    // A pending move (another batch's) is no like target: the cut flags the pair when they meet.
    expect(out[1]).toEqual({ position: 1, kind: "new", confidence: "high", check: true, draft: expect.anything() });
    expect(out[1]).not.toHaveProperty("like");
    expect(out[2]).toMatchObject({ kind: "personal", id: "myZorbexShuffleaaaaaa", check: false });
    expect(out[2]!.like).toBeUndefined();
  });

  it("makes two new moves with one normalised name in one post one move", () => {
    const out = matchMoves(extraction([move("Zorbex shuffle"), move("zorbex shuffles")]), EXERCISES, []);
    expect(out[0]).toMatchObject({ kind: "new" });
    expect(out[1]).toMatchObject({ kind: "new", sameAs: 0 });
  });
});

describe("matchPost", () => {
  it("Review Focus 3: three spellings end on the one library move; the fuzzy one through the judge, checked", async () => {
    const id = await extracted("rf3", [move("90/90 Hip Switch"), move("90-90 hip switches"), move("the 90 90 switch")]);
    const gw = judge({ matches: [{ move: 2, id: HIP_SWITCH.id }] });
    const out = await matchPost(db, env(), userId, id, NOW, gw.fetchImpl);
    expect(out).toEqual({ newMoves: 0, linked: 3 });
    const links = await linksOf(id);
    expect(links.map((l) => [l.position, l.moveId, l.moveKind, l.checkFlag, l.status])).toEqual([
      [0, HIP_SWITCH.id, "library", false, "pending"],
      [1, HIP_SWITCH.id, "library", false, "pending"],
      [2, HIP_SWITCH.id, "library", true, "pending"],
    ]);
    expect(links[2]!.confidence).toBeLessThan(links[0]!.confidence!);
    expect(await db.select().from(personalMoves)).toEqual([]);
    expect(await postOf(id)).toMatchObject({ status: "matched", batchId: null });
    // One call for the post, asking only about the move the names could not settle.
    expect(gw.spy).toHaveBeenCalledTimes(1);
    const asked = JSON.stringify(gw.calls[0].messages);
    expect(asked).toContain("the 90 90 switch");
    expect(asked).toContain(HIP_SWITCH.id);
    expect(asked).not.toContain("90-90 hip switches");
  });

  it("asks about a fuzzy move shown twice once, and both take the answer", async () => {
    const id = await extracted("k", [move("the 90 90 switch"), move("The 90 90 switches")]);
    const gw = judge({ matches: [{ move: 0, id: HIP_SWITCH.id }] });
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 0, linked: 2 });
    expect((await linksOf(id)).map((l) => [l.moveId, l.checkFlag])).toEqual([[HIP_SWITCH.id, true], [HIP_SWITCH.id, true]]);
    expect(JSON.stringify(gw.calls[0].messages)).not.toContain("move 1");
  });

  it("the judge's spend is reserved and settled under import_match, and lands on the post", async () => {
    const id = await extracted("k", [move("the 90 90 switch")]);
    await matchPost(db, env(), userId, id, NOW, judge({ matches: [{ move: 0, id: HIP_SWITCH.id }] }).fetchImpl);
    const usage = await db.select().from(llmUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: IMPORT_KINDS.match, inputTokens: 400, outputTokens: 30, requestFingerprint: null });
    expect(usage[0]!.costMicros).toBeGreaterThan(0);
    expect((await postOf(id)).costMicros).toBe(usage[0]!.costMicros);
  });

  it("a judge's no makes the move new, unchecked", async () => {
    const id = await extracted("k", [move("the 90 90 switch")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({ matches: [{ move: 0, id: null }] }).fetchImpl)).toEqual({ newMoves: 1, linked: 0 });
    const [link] = await linksOf(id);
    const [pm] = await db.select().from(personalMoves);
    expect(link).toMatchObject({ moveKind: "personal", moveId: pm!.id, checkFlag: false });
    expect(pm).toMatchObject({ status: "pending", batchId: null, editedByOwner: false });
    expect((pm!.record as { name: string }).name).toBe("the 90 90 switch");
  });

  it("a later post's 'the zorbex switch' joins an earlier post's 'Zorbex hip switch' through the judge: one move, checked", async () => {
    const first = await extracted("a", [move("Zorbex hip switch")]);
    await matchPost(db, env(), userId, first, NOW, judge({}).fetchImpl);
    const [mine] = await db.select().from(personalMoves);
    const later = await extracted("b", [move("the zorbex switch")]);
    const gw = judge({ matches: [{ move: 0, id: mine!.id }] });
    expect(await matchPost(db, env(), userId, later, NOW, gw.fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    expect(await db.select().from(personalMoves)).toHaveLength(1);
    const [link] = await linksOf(later);
    expect(link).toMatchObject({ moveId: mine!.id, moveKind: "personal", checkFlag: true, confidence: 0.6 });
    // The owner's move name came from a model reading a post: it is asked about inside the data block, never beside the library's.
    const text: string = gw.calls[0].messages[1].content;
    const at = text.indexOf("Zorbex hip switch");
    expect(at).toBeGreaterThan(text.indexOf("<post-data>"));
    expect(at).toBeLessThan(text.indexOf("</post-data>"));
    expect(text.slice(text.indexOf("</post-data>"))).not.toContain(mine!.id);
  });

  it("a new move read as external load with no implement is stored as bodyweight and flagged to check — no retry", async () => {
    const id = await extracted("k", [move("Band pull apart hold", { load: "external", equipment: ["band"], confidence: "high" })]);
    const out = await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect(out.issues).toBeUndefined();
    const [pm] = await db.select().from(personalMoves);
    expect((pm!.record as { load: string }).load).toBe("bodyweight");
    expect((await linksOf(id)).map((l) => [l.moveKind, l.checkFlag])).toEqual([["personal", true]]);
  });

  it("stores a new move the extraction was unsure of flagged to check", async () => {
    const id = await extracted("k", [move("Zorbex quad shuffle", { confidence: "low" }), move("Zorbex neck nod")]);
    await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect((await linksOf(id)).map((l) => l.checkFlag)).toEqual([true, false]);
  });

  it("never takes an id the judge was not offered", async () => {
    const id = await extracted("k", [move("the 90 90 switch")]);
    await matchPost(db, env(), userId, id, NOW, judge({ matches: [{ move: 0, id: "squat" }] }).fetchImpl);
    expect((await linksOf(id))[0]).toMatchObject({ moveKind: "personal" });
  });

  it("without an answer (a gateway failure), a fuzzy move is new and flagged to check; the reservation settles to zero", async () => {
    const id = await extracted("k", [move("the 90 90 switch")]);
    await matchPost(db, env(), userId, id, NOW, judge({}, { status: 400 }).fetchImpl);
    expect((await linksOf(id))[0]).toMatchObject({ moveKind: "personal", checkFlag: true });
    const [usage] = await db.select().from(llmUsage);
    expect(usage).toMatchObject({ kind: IMPORT_KINDS.match, costMicros: 0, requestFingerprint: null });
    expect(await postOf(id)).toMatchObject({ status: "matched" });
  });

  it("in fixture mode never calls the gateway", async () => {
    const id = await extracted("k", [move("the 90 90 switch")]);
    const gw = judge({ matches: [{ move: 0, id: HIP_SWITCH.id }] });
    await matchPost(db, env({ FIXTURE_MODE: "1" }), userId, id, NOW, gw.fetchImpl);
    expect(gw.spy).not.toHaveBeenCalled();
    expect(await db.select().from(llmUsage)).toHaveLength(0);
    expect(await postOf(id)).toMatchObject({ status: "matched" });
  });

  it("makes no call when nothing is fuzzy", async () => {
    const id = await extracted("k", [move("90/90 Hip Switch"), move("Zorbex quad shuffle")]);
    const gw = judge({});
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 1, linked: 1 });
    expect(gw.spy).not.toHaveBeenCalled();
  });

  it("two posts with the same new move give one personal move and two links", async () => {
    const a = await extracted("a", [move("Zorbex quad shuffle")]);
    const b = await extracted("b", [move("Zorbex Quad Shuffles", { summary: "Another creator's take." })]);
    expect(await matchPost(db, env(), userId, a, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 1, linked: 0 });
    expect(await matchPost(db, env(), userId, b, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    const moves = await db.select().from(personalMoves);
    expect(moves).toHaveLength(1);
    const links = await db.select().from(savedPostMoves);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.moveId))).toEqual(new Set([moves[0]!.id]));
    expect(links.every((l) => l.moveKind === "personal" && l.status === "pending")).toBe(true);
  });

  it("one new move shown twice in one post is one personal move with two links", async () => {
    const id = await extracted("k", [move("Zorbex quad shuffle"), move("zorbex quad shuffles")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 1, linked: 1 });
    const [pm] = await db.select().from(personalMoves);
    expect((await linksOf(id)).map((l) => l.moveId)).toEqual([pm!.id, pm!.id]);
  });

  it("a re-submitted post changes nothing", async () => {
    const id = await extracted("k", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    const before = {
      post: await postOf(id), moves: await db.select().from(personalMoves), links: await db.select().from(savedPostMoves),
    };
    writes = 0;
    expect(await matchPost(db, env(), userId, id, "2026-10-24T10:00:00.000Z", judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 0 });
    expect(writes).toBe(0);
    expect({
      post: await postOf(id), moves: await db.select().from(personalMoves), links: await db.select().from(savedPostMoves),
    }).toEqual(before);
  });

  it("an owner-edited personal move keeps its record when a later post matches it, and gains a link", async () => {
    const mine = await personal("Zorbex shuffle", { editedByOwner: true });
    const before = (await db.select({ record: personalMoves.record }).from(personalMoves))[0]!.record;
    const id = await extracted("k", [move("zorbex shuffles", { summary: "Different words entirely.", steps: ["Other."] })]);
    expect(await matchPost(db, env(), userId, id, "2026-10-24T10:00:00.000Z", judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    const [row] = await db.select().from(personalMoves);
    expect(row).toMatchObject({ id: mine, editedByOwner: true, status: "active", updatedAt: NOW });
    expect(row!.record).toEqual(before);
    expect(await linksOf(id)).toEqual([expect.objectContaining({ moveId: mine, moveKind: "personal", status: "pending" })]);
  });

  it("a merged personal move links to its target", async () => {
    const kept = await personal("Kept move");
    await personal("Zorbex shuffle", { status: "merged", mergedInto: kept });
    const id = await extracted("k", [move("Zorbex shuffle")]);
    await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect((await linksOf(id))[0]).toMatchObject({ moveId: kept, moveKind: "personal" });
  });

  it("another account's personal moves are never matched", async () => {
    const other = await makeTestUser(db);
    await db.insert(personalMoves).values({
      id: "myZorbexShufflezzzzzz", userId: other.userId, status: "active",
      record: toPersonalRecord("myZorbexShufflezzzzzz", move("Zorbex shuffle")), createdAt: NOW, updatedAt: NOW,
    });
    const id = await extracted("k", [move("Zorbex shuffle")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 1, linked: 0 });
  });

  it("a draft whose record fails validation fails the post (model_failed, the issues) and stores nothing", async () => {
    const id = await extracted("k", [move("90/90 Hip Switch"), move("Zorbex quad shuffle", { steps: [] })]);
    const out = await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect(out.newMoves).toBe(0);
    expect(out.issues?.length).toBeGreaterThan(0);
    expect(out.issues!.every((i) => i.startsWith("moves.1: "))).toBe(true);
    // The issues name the position, never the model's own words (the id is built from the move's name).
    expect(out.issues!.join(" ")).not.toMatch(/zorbex/i);
    expect(await postOf(id)).toMatchObject({ status: "failed", lastErrorCode: "model_failed" });
    expect(await db.select().from(personalMoves)).toEqual([]);
    expect(await db.select().from(savedPostMoves)).toEqual([]);
  });

  it("never repeats a rating key the model made up in the issues", async () => {
    const odd = { ...ratings, tmj: { ...ratings.tmj, attrs: { ...ratings.tmj.attrs, zorbexKey: 1 } } } as ExtractedMove["conditions"];
    const id = await extracted("k", [move("Zorbex quad shuffle", { conditions: odd })]);
    const out = await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect(out.issues).toEqual(["moves.0: conditions.tmj: has a rating the profile does not have"]);
  });

  it("a stored extraction that no longer parses fails the post", async () => {
    const id = await extracted("k", [], { extraction: { kind: "routine", moves: [{ name: "x" }] } });
    const out = await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect(out.issues?.length).toBeGreaterThan(0);
    expect(await postOf(id)).toMatchObject({ status: "failed", lastErrorCode: "model_failed" });
  });

  it("a post with no moves is matched with no links", async () => {
    const id = await extracted("k", []);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 0 });
    expect(await postOf(id)).toMatchObject({ status: "matched" });
  });

  it("writes nothing usable: no provenance, every new move and link pending", async () => {
    const id = await extracted("k", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl);
    expect(await db.select().from(exerciseProvenance)).toEqual([]);
    expect((await db.select().from(personalMoves)).every((m) => m.status === "pending")).toBe(true);
    expect((await db.select().from(savedPostMoves)).every((l) => l.status === "pending")).toBe(true);
  });

  it("a new move one qualifying word from an active move of the owner's is created, flagged check this, like that move", async () => {
    const mine = await personal("Zorbex cobra hold");
    const id = await extracted("k", [move("Zorbex cobra chest lift"), move("Zorbex quad shuffle")]);
    const gw = judge({});
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 2, linked: 0 });
    // Too few shared words for the judge: the names alone flag it.
    expect(gw.spy).not.toHaveBeenCalled();
    const links = await linksOf(id);
    const created = (await db.select().from(personalMoves)).filter((m) => m.id !== mine);
    expect(created).toHaveLength(2);
    expect(links.map((l) => [l.moveKind, l.checkFlag, l.likeMoveId])).toEqual([
      ["personal", true, mine],
      ["personal", false, null],
    ]);
    expect(links[0]!.moveId).not.toBe(mine);
    expect(created.every((m) => m.status === "pending")).toBe(true);
  });

  it("a near move shown twice in one post is one move, and both links are like the owner's", async () => {
    const mine = await personal("Zorbex cobra hold");
    const id = await extracted("k", [move("Zorbex cobra chest lift"), move("zorbex cobra chest lifts")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 1, linked: 1 });
    const links = await linksOf(id);
    expect(links[1]!.moveId).toBe(links[0]!.moveId);
    expect(links.map((l) => [l.checkFlag, l.likeMoveId])).toEqual([[true, mine], [true, mine]]);
  });

  it("a judge's no leaves a near move new, and the names still flag it like the owner's move", async () => {
    const mine = await personal("Zorbex rotational swing");
    const id = await extracted("k", [move("Zorbex dynamic rotational swing")]);
    const gw = judge({ matches: [{ move: 0, id: null }] });
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 1, linked: 0 });
    expect(gw.spy).toHaveBeenCalledTimes(1);
    expect((await linksOf(id)).map((l) => [l.checkFlag, l.likeMoveId])).toEqual([[true, mine]]);
  });

  it("an equal name with a different load or dose type is never linked: a new move, flagged, like the owner's — the judge not asked", async () => {
    const shuffle = await personal("Zorbex shuffle");
    const hold = await personal("Zorbex hold");
    const id = await extracted("k", [
      move("Zorbex shuffles", { load: "external", equipment: ["kettlebell"] }),
      move("zorbex hold", { dose: { text: "30 s", type: "time", range: [20, 40] } }),
      // The same new move again in the post: one move, both links like the owner's.
      move("Zorbex shuffle", { load: "external", equipment: ["kettlebell"] }),
    ]);
    const gw = judge({ matches: [{ move: 0, id: shuffle }, { move: 1, id: hold }] });
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 2, linked: 1 });
    expect(gw.spy).not.toHaveBeenCalled();
    const links = await linksOf(id);
    expect(links.map((l) => [l.moveKind, l.checkFlag, l.likeMoveId])).toEqual([
      ["personal", true, shuffle],
      ["personal", true, hold],
      ["personal", true, shuffle],
    ]);
    expect(links.map((l) => l.moveId).filter((m) => m === shuffle || m === hold)).toEqual([]);
    expect(links[2]!.moveId).toBe(links[0]!.moveId);
    const created = (await db.select().from(personalMoves)).filter((m) => m.status === "pending");
    expect(created.map((m) => (m.record as { load: string }).load).sort()).toEqual(["external", "none"]);
  });

  it("an equal name with the same type links as before", async () => {
    const mine = await personal("Zorbex shuffle");
    const id = await extracted("k", [move("zorbex shuffles"), move("The Zorbex shuffle", { dose: { text: "a few" } })]);
    const gw = judge({});
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 0, linked: 2 });
    expect(gw.spy).not.toHaveBeenCalled();
    expect((await linksOf(id)).map((l) => [l.moveId, l.moveKind, l.checkFlag, l.likeMoveId, l.confidence])).toEqual([
      [mine, "personal", false, null, 1],
      [mine, "personal", false, null, 1],
    ]);
    expect(await db.select().from(personalMoves)).toHaveLength(1);
  });

  it("an active move of a different type and a pending move of the same type, one name: the post links to the pending one", async () => {
    await personal("Zorbex shuffle", {}, { load: "external", equipment: ["kettlebell"] });
    const pending = await personal("Zorbex shuffles", { status: "pending", batchId: "otherbatch" });
    const id = await extracted("k", [move("zorbex shuffle")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    expect((await linksOf(id)).map((l) => [l.moveId, l.moveKind, l.checkFlag, l.likeMoveId])).toEqual([[pending, "personal", false, null]]);
  });

  it("two active moves with one name and different types: each draft links to its own type", async () => {
    const plain = await personal("Zorbex shuffle");
    const loaded = await personal("Zorbex shuffles", {}, { load: "external", equipment: ["kettlebell"] });
    const a = await extracted("a", [move("Zorbex Shuffle", { load: "external", equipment: ["kettlebell"] })]);
    const b = await extracted("b", [move("zorbex shuffles")]);
    expect(await matchPost(db, env(), userId, a, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    expect(await matchPost(db, env(), userId, b, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    expect((await linksOf(a)).map((l) => [l.moveId, l.checkFlag, l.likeMoveId])).toEqual([[loaded, false, null]]);
    expect((await linksOf(b)).map((l) => [l.moveId, l.checkFlag, l.likeMoveId])).toEqual([[plain, false, null]]);
    expect(await db.select().from(personalMoves)).toHaveLength(2);
  });

  it("an equal name of a different type on a pending or archived move: a new move, flagged, like nothing", async () => {
    await personal("Zorbex shuffle", { status: "pending", batchId: "otherbatch" });
    await personal("Zorbex hold", { status: "archived" });
    const id = await extracted("k", [
      move("Zorbex shuffle", { load: "external", equipment: ["kettlebell"] }),
      move("zorbex hold", { dose: { text: "30 s", type: "time", range: [20, 40] } }),
    ]);
    const gw = judge({});
    expect(await matchPost(db, env(), userId, id, NOW, gw.fetchImpl)).toEqual({ newMoves: 2, linked: 0 });
    expect(gw.spy).not.toHaveBeenCalled();
    expect((await linksOf(id)).map((l) => [l.moveKind, l.checkFlag, l.likeMoveId])).toEqual([
      ["personal", true, null],
      ["personal", true, null],
    ]);
  });

  it("a band move read as external links to the owner's like-named move stored as bodyweight: the load its record would store", async () => {
    const mine = await personal("Zorbex band pull", {}, { load: "bodyweight", equipment: ["band"] });
    const id = await extracted("k", [move("Zorbex band pulls", { load: "external", equipment: ["band"] })]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 0, linked: 1 });
    expect((await linksOf(id)).map((l) => [l.moveId, l.checkFlag, l.likeMoveId])).toEqual([[mine, false, null]]);
  });

  it("a pending move (another batch's) is no like target at matching", async () => {
    await personal("Zorbex cobra hold", { status: "pending", batchId: "otherbatch" });
    const id = await extracted("k", [move("Zorbex cobra chest lift")]);
    expect(await matchPost(db, env(), userId, id, NOW, judge({}).fetchImpl)).toEqual({ newMoves: 1, linked: 0 });
    // The cut flags it, when the two land in one batch or the other is the owner's (saves-batches).
    expect((await linksOf(id)).map((l) => [l.checkFlag, l.likeMoveId])).toEqual([[false, null]]);
  });

  it("statements unchanged for a 12-move post", async () => {
    const nod = await personal("Zorbex neck nod");
    const cobra = await personal("Zorbex cobra hold");
    const moves = [
      move("Zorbex neck nod", { load: "bodyweight" }),
      move("Zorbex cobra chest lift"),
      ...Array.from({ length: 9 }, (_, i) => move(`Zorbex variant ${String.fromCharCode(98 + i)} shuffle`)),
      move("the 90 90 switch"),
    ];
    const id = await extracted("k", moves);
    statements = 0;
    const out = await matchPost(db, env(), userId, id, NOW, judge({ matches: [{ move: 11, id: HIP_SWITCH.id }] }).fetchImpl);
    expect(out).toEqual({ newMoves: 11, linked: 1 });
    // post 1, personal moves 1, judge (reserve 2, credits note 2, settle 1), writes: 2 move inserts + 2 link inserts + the post
    expect(statements).toBe(12);
    const links = await linksOf(id);
    expect(links.map((l) => l.likeMoveId)).toEqual([nod, cobra, ...Array(10).fill(null)]);
  });

  it("a 12-move post of new and fuzzy moves takes 12 statements, the judge included (the relay route adds 9: 21 of 45)", async () => {
    const moves = [
      ...Array.from({ length: 11 }, (_, i) => move(`Zorbex variant ${String.fromCharCode(97 + i)} shuffle`)),
      move("the 90 90 switch"),
    ];
    const id = await extracted("k", moves);
    statements = 0;
    const out = await matchPost(db, env(), userId, id, NOW, judge({ matches: [{ move: 11, id: HIP_SWITCH.id }] }).fetchImpl);
    expect(out).toEqual({ newMoves: 11, linked: 1 });
    // post 1, personal moves 1, judge (reserve 2, credits note 2, settle 1), writes: 2 move inserts + 2 link inserts + the post
    expect(statements).toBe(12);
  });
});
