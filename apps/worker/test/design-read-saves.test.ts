/**
 * read_saves (saved-posts import, Task 17): what came in from the athlete's saves — the newest batch they saved in the
 * last 14 days and haven't had fitted in, or the saved batch a batchId names. Its moves, new ones first, each with its
 * name and summary (a personal move's marked: a model's reading of a creator's post), new or the athlete's already,
 * pinned, its group, the posts it came from (url plain, creator marked) and the first post's reading (marked); and the
 * routines among its posts, their moves in the post's order. Nothing to read is an answer that says so (`missing`);
 * another account's batch reads as one nobody has. Two statements at most. Synthetic data only (example.com, made-up
 * names).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES } from "@rg/exercise-library";
import { moveGroup, type ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { PROMPT_TOOL_NAMES, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { RESULT_BUDGET_BYTES, sharedAthlete, type ReadOk } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolContext, type ToolErr } from "../src/services/design-tools/types.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch, saveBatch } from "../src/services/saves-batches.js";
import { longBatchPosts, savedMoveDraft, seedSavedBatch, type SavedPostSpec } from "./saves-batch-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

/** Sat 24 Oct 2026, 11:00 in Los Angeles (PDT, UTC-7). */
const NOW = new Date("2026-10-24T18:00:00.000Z");
const ENV = {} as Env;
const daysAgo = (d: number, hhmm = "17:00") => new Date(Date.parse(`2026-10-24T${hhmm}:00.000Z`) - d * 86_400_000).toISOString();
const U = (text: string) => ({ untrusted: true, text });
const GOBLET = EXERCISES.find((e) => e.id === "gobletSquat")!;
const DEAD_BUG = EXERCISES.find((e) => e.id === "deadBug")!;

let db: Db;
let userId: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
});

const tool = () => READ_TOOLS.find((t) => t.name === "read_saves")!;
const ctxOf = (user = userId, over: Partial<ToolContext> = {}): ToolContext => ({
  db, env: ENV, userId: user, run: { id: "run-saves", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: "toolu_saves", ...over,
});

async function read(input: unknown = {}, user = userId, over: Partial<ToolContext> = {}): Promise<{ r: ReadOk | ToolErr; count: number }> {
  statements.length = 0;
  const r = (await tool().run(ctxOf(user, over), input)) as ReadOk | ToolErr;
  expect(statements.filter(isWrite)).toEqual([]);
  return { r, count: statements.length };
}

async function ok(input: unknown = {}, user = userId): Promise<ReadOk & { data: any }> {
  const { r } = await read(input, user);
  if (isToolErr(r as never)) throw new Error(`refused: ${(r as ToolErr).why}`);
  return r as ReadOk & { data: any };
}

const A = savedMoveDraft("Zorbex hip circle");
const B = savedMoveDraft("Zorbex neck nod", { regions: ["neck"], summary: "A small nod, chin tucked." });

/** Post 0, a routine: A, the library's goblet squat, B. Post 1, one move: A again. */
const twoPosts = (): SavedPostSpec[] => [
  { kind: "routine", summary: "Three moves for the hips, slow.", handle: "coach_zero", moves: [{ draft: A }, { library: "gobletSquat" }, { draft: B }] },
  { kind: "single_move", summary: "One hip circle, done well.", handle: "", name: "Coach One", moves: [{ draft: A }] },
];

describe("read_saves: the registry", () => {
  it("is a read tool for every role, two statements at most, a strict schema whose limit is at most 12", () => {
    const t = tool();
    expect(t.roles).toEqual(["main", "designer", "reviewer"]);
    expect(t.statementCost).toBe(2);
    expect(t.description.length).toBeLessThanOrEqual(240);
    expect(t.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { batchId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 } },
    });
    // The prompt names it, in one line of its own under "Reading", beside the library's tools.
    expect(PROMPT_TOOL_NAMES).toContain("read_saves");
    const reading = SHARED_PROMPT.slice(SHARED_PROMPT.indexOf("Reading:\n"), SHARED_PROMPT.indexOf("Acting:\n"));
    expect(reading.split("\n").filter((l) => l.startsWith("- read_saves:"))).toHaveLength(1);
    expect(READ_TOOLS.map((t) => t.name).indexOf("read_saves")).toBe(READ_TOOLS.map((t) => t.name).indexOf("get_exercise") + 1);
  });
});

describe("read_saves", () => {
  it("with no saved batch waiting, answers with nothing and says so in missing — two statements, nothing written", async () => {
    const { r, count } = await read({});
    expect(isToolErr(r as never)).toBe(false);
    const a = r as ReadOk;
    expect(a.data).toEqual({ batch: null, moves: [], routines: [] });
    expect(a.missing).toContain("no saved batch waiting to be fitted in: none saved in the last 14 days, or each one is fitted in already");
    expect(a.summary).toBe("Nothing new from your saves");
    expect(count).toBe(2);
  });

  it("never reads a batch not saved, one fitted in, or one saved more than 14 days ago, without its id", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), status: "released", posts: twoPosts() });
    await seedSavedBatch(db, userId, { savedAt: daysAgo(2), status: "dismissed", posts: twoPosts() });
    await seedSavedBatch(db, userId, { savedAt: daysAgo(3), fittedAt: daysAgo(1), posts: twoPosts() });
    const old = await seedSavedBatch(db, userId, { savedAt: daysAgo(15), posts: twoPosts() });
    expect((await ok({})).data.batch).toBeNull();
    // By its id, a saved batch reads whatever its age or fit.
    expect((await ok({ batchId: old.batchId })).data.batch.id).toBe(old.batchId);
  });

  it("a saved batch: its moves new first, each named, marked where a model wrote it, pinned, grouped, with its posts — creators marked", async () => {
    const { batchId, moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(2), posts: twoPosts(), pinned: ["gobletSquat"] });
    const [a, , b] = moveIds[0]!;
    const r = await ok({});
    expect(r.provenance!.source).toBe("the athlete's saves");
    // Saved Thu 22 Oct, 10:00 in Los Angeles.
    expect(r.data.batch).toEqual({ id: batchId, savedAt: "2026-10-22" });
    expect(r.data.moves).toEqual([
      {
        id: a, name: U("Zorbex hip circle"), summary: U("Zorbex hip circle, slow and even."), new: true, pinned: false, groups: "hip", posts: 2,
        links: [
          { url: expect.stringMatching(/^https:\/\/example\.com\/p\//), creator: U("coach_zero") },
          // No handle: the creator's name.
          { url: expect.stringMatching(/^https:\/\/example\.com\/p\//), creator: U("Coach One") },
        ],
        fromPost: U("Three moves for the hips, slow."),
      },
      {
        id: b, name: U("Zorbex neck nod"), summary: U("A small nod, chin tucked."), new: true, pinned: false, groups: "neck", posts: 1,
        links: [{ url: expect.any(String), creator: U("coach_zero") }], fromPost: U("Three moves for the hips, slow."),
      },
      {
        // The library's own words: code, not marked.
        id: "gobletSquat", name: GOBLET.name, summary: GOBLET.text.summary, new: false, pinned: true, groups: moveGroup(GOBLET), posts: 1,
        links: [{ url: expect.any(String), creator: U("coach_zero") }], fromPost: U("Three moves for the hips, slow."),
      },
    ]);
    // The routine post, its moves in the post's order; the single move's post is no routine.
    expect(r.data.routines).toEqual([{ post: U("Three moves for the hips, slow."), order: [a, "gobletSquat", b] }]);
    expect(r.summary).toBe("Read 3 moves from your saves, 2 new (saved Thu 22 Oct)");
  });

  it("reads what saving a real batch leaves: the post's new moves new, a library move it named yours already", async () => {
    const T0 = daysAgo(3);
    const env = { FIXTURE_MODE: "1" } as unknown as Env;
    const noFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const id = await savedPostId(userId, "testsrc", "real");
    await db.insert(schema.savedPosts).values({
      id, userId, source: "testsrc", sourceKey: "real", url: "https://example.com/p/real", creatorHandle: "coach_real", firstSeenAt: T0, status: "extracted",
      extraction: { kind: "routine", summary: "Hips, then the neck.", themes: [], moves: [savedMoveDraft("Zorbex quad shuffle"), savedMoveDraft("90/90 Hip Switch")] },
      extractAttempts: 1, updatedAt: T0,
    });
    await matchPost(db, env, userId, id, T0, noFetch);
    const batchId = (await assembleBatch(db, env, userId, T0))!;
    await saveBatch(db, userId, batchId, daysAgo(2));
    const r = await ok({});
    expect(r.data.batch.id).toBe(batchId);
    const hip = EXERCISES.find((e) => e.name === "90/90 hip switches")!;
    expect(r.data.moves.map((m: any) => [m.new, m.new ? m.name : m.id])).toEqual([[true, U("Zorbex quad shuffle")], [false, hip.id]]);
    expect(r.data.moves[0].links).toEqual([{ url: "https://example.com/p/real", creator: U("coach_real") }]);
    expect(r.data.routines).toEqual([{ post: U("Hips, then the neck."), order: [r.data.moves[0].id, hip.id] }]);
  });

  it("a link the owner removed is left out, and a move only it named is not listed", async () => {
    const posts = twoPosts();
    posts[0]!.removed = [2];
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts });
    const r = await ok({});
    expect(r.data.moves.map((m: any) => m.id)).toEqual([moveIds[0]![0], "gobletSquat"]);
    expect(r.data.routines[0].order).toEqual([moveIds[0]![0], "gobletSquat"]);
  });

  it("the newest of the waiting batches; a batchId of the athlete's reads that one", async () => {
    const older = await seedSavedBatch(db, userId, { savedAt: daysAgo(5), posts: [{ moves: [{ library: "deadBug" }] }] });
    const newer = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ moves: [{ library: "gobletSquat" }] }] });
    expect((await ok({})).data.batch.id).toBe(newer.batchId);
    const r = await ok({ batchId: older.batchId });
    expect(r.data.batch.id).toBe(older.batchId);
    expect(r.data.moves.map((m: any) => m.name)).toEqual([DEAD_BUG.name]);
  });

  it("another account's batch, or one of the athlete's not saved, is refused as an id nobody has — the same words", async () => {
    const other = (await makeTestUser(db)).userId;
    const theirs = await seedSavedBatch(db, other, { savedAt: daysAgo(1), posts: twoPosts() });
    const released = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), status: "released", posts: twoPosts() });
    const refusal = async (batchId: string) => {
      const { r, count } = await read({ batchId });
      expect(isToolErr(r as never), batchId).toBe(true);
      expect(count).toBeLessThanOrEqual(2);
      return r as ToolErr;
    };
    const nobody = await refusal("batch-nobody-has");
    expect(nobody.error).toBe("not_found");
    expect(nobody.why).toBe('No saved batch of the athlete\'s has id "batch-nobody-has".');
    for (const id of [theirs.batchId, released.batchId]) {
      const r = await refusal(id);
      expect({ ...r, why: r.why.replace(id, "X") }).toEqual({ ...nobody, why: nobody.why.replace("batch-nobody-has", "X") });
    }
    // Nothing of the other account's reaches this one, even when it is the only batch there is.
    expect(JSON.stringify(await ok({}))).not.toContain(theirs.batchId);
  });

  it("limit: 12 by default and at most; a batch with more says how many more it holds", async () => {
    const drafts = Array.from({ length: 15 }, (_, i) => ({ draft: savedMoveDraft(`Zorbex move ${String(i).padStart(2, "0")}`, { summary: "Short." }) }));
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "single_move", summary: "s", moves: drafts.slice(0, 8) }, { kind: "single_move", summary: "s", moves: drafts.slice(8) }] });
    const r = await ok({});
    expect(r.data.moves).toHaveLength(12);
    expect(r.missing).toContain("3 more moves in this batch, not listed (at most 12 a read)");
    expect((await ok({ limit: 4 })).data.moves).toHaveLength(4);
    const refused = (await read({ limit: 13 })).r as ToolErr;
    expect(refused.error).toBe("invalid_input");
    expect(refused.why).toMatch(/^limit:/);
  });

  it("twelve moves at their longest stay within the answer's budget, and every marked text has its marker first", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: longBatchPosts() });
    const r = await ok({});
    const { summary: _s, ...forModel } = r;
    const text = JSON.stringify(forModel);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    // What did not fit is said, never cut silently.
    const shown = r.data.moves.length;
    expect(shown).toBeGreaterThan(3);
    if (shown < 12) expect(r.missing!.some((m) => new RegExp(`^${12 - shown} more moves? not shown for room: `).test(m))).toBe(true);
    for (const lead of ["LONG-reading", "LONG-handle", "LONG move", "LONG-summary"]) {
      const at = [...text.matchAll(new RegExp(lead, "g"))];
      expect(at.length, lead).toBeGreaterThan(0);
      for (const m of at) expect(text.slice(m.index! - 26, m.index), lead).toBe('{"untrusted":true,"text":"');
    }
  });

  it("in a step, the athlete is the step's shared read: the batch is one statement more", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: twoPosts() });
    const athlete = sharedAthlete(db, userId, NOW);
    await athlete();
    const { r, count } = await read({}, userId, { athlete });
    expect((r as ReadOk & { data: any }).data.moves).toHaveLength(3);
    expect(count).toBe(1);
    // Outside a step it reads the athlete too: two, the most.
    expect((await read({})).count).toBe(2);
  });

  it("a move merged since into another reads as that move", async () => {
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ moves: [{ draft: A as ExtractedMove }, { library: "gobletSquat" }] }] });
    await db.update(schema.personalMoves).set({ status: "merged", mergedInto: "gobletSquat" }).where(and(eq(schema.personalMoves.userId, userId), eq(schema.personalMoves.id, moveIds[0]![0]!)));
    const r = await ok({});
    expect(r.data.moves.map((m: any) => [m.id, m.new, m.posts])).toEqual([["gobletSquat", false, 1]]);
    expect(r.data.routines[0].order).toEqual(["gobletSquat", "gobletSquat"]);
  });
});
