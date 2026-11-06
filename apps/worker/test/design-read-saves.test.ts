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
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES } from "@rg/exercise-library";
import { moveGroup, type ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { PROMPT_TOOL_NAMES, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { savedBatchOf, savesBatchSql } from "../src/services/design-tools/read-saves.js";
import { plural, RESULT_BUDGET_BYTES, sharedAthlete, type ReadOk } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolContext, type ToolErr } from "../src/services/design-tools/types.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch, saveBatch } from "../src/services/saves-batches.js";
import { longBatchPosts, longText, savedMoveDraft, seedSavedBatch, typicalBatchPosts, widestMovePosts, type SavedPostSpec } from "./saves-batch-fixture.js";
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

/** A listed move as it read before phase 3 (its evidence, dose and corrections, and each link's post, match and reading,
 * are the phase-3 tests' below) — REBASED 2026-11-06 (the budgets review): no like and not pinned are left out, and a
 * link's post (its address, creator and reading) is the page's `posts`; only a move's first link carries its note. */
const oldShape = (m: any) => {
  const { n: _n, dose: _dose, corrections: _corrections, ...rest } = m;
  return { like: null, pinned: false, ...rest, links: rest.links.map((l: any) => ({ post: l.post, ...(l.note !== undefined ? { note: l.note } : {}) })) };
};
/** A page's post by id. */
const postOf = (r: { data: any }, id: string) => r.data.posts.find((p: any) => p.id === id);

const A = savedMoveDraft("Zorbex hip circle");
const B = savedMoveDraft("Zorbex neck nod", { regions: ["neck"], summary: "A small nod, chin tucked." });

/** Post 0, a routine: A, the library's goblet squat, B. Post 1, one move: A again. */
const twoPosts = (): SavedPostSpec[] => [
  { kind: "routine", summary: "Three moves for the hips, slow.", handle: "coach_zero", moves: [{ draft: A }, { library: "gobletSquat" }, { draft: B }] },
  { kind: "single_move", summary: "One hip circle, done well.", handle: "", name: "Coach One", moves: [{ draft: A }] },
];

describe("read_saves: the registry", () => {
  it("is a read tool for every role, three statements at most, a strict schema whose limit is at most 12", () => {
    const t = tool();
    expect(t.roles).toEqual(["main", "designer", "reviewer"]);
    // REBASED 2026-11-06 (coach review, phase 3): the page's evidence is one statement more (§8.1).
    expect(t.statementCost).toBe(3);
    expect(t.description.length).toBeLessThanOrEqual(240);
    expect(t.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { batchId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 12 }, offset: { type: "integer", minimum: 0 } },
    });
    // The prompt names it, in one line of its own under "Reading", beside the library's tools.
    expect(PROMPT_TOOL_NAMES).toContain("read_saves");
    const reading = SHARED_PROMPT.slice(SHARED_PROMPT.indexOf("Reading:\n"), SHARED_PROMPT.indexOf("Acting:\n"));
    expect(reading.split("\n").filter((l) => l.startsWith("- read_saves:"))).toHaveLength(1);
    expect(READ_TOOLS.map((t) => t.name).indexOf("read_saves")).toBe(READ_TOOLS.map((t) => t.name).indexOf("get_exercise") + 1);
  });

  it("its description names what a fit reads it for — the posts' notes, the insights, a saved move's own id (coach-context audit M5); get_exercise's takes that id", () => {
    expect(tool().description).toContain("notes");
    expect(tool().description).toContain("insights");
    expect(tool().description).toContain("a saved one by its own id");
    const get = READ_TOOLS.find((t) => t.name === "get_exercise")!;
    expect(get.description).toContain("a saved move's own");
    expect(get.description).toContain("saved-post links and notes");
    expect(get.description.length).toBeLessThanOrEqual(240);
    expect((get.inputSchema as { properties: { id: { description: string } } }).properties.id.description).toBe("A library id from search_library, or a saved move's from read_saves.");
  });
});

describe("read_saves", () => {
  it("with no saved batch waiting, answers with nothing and says so in missing — two statements, nothing written", async () => {
    const { r, count } = await read({});
    expect(isToolErr(r as never)).toBe(false);
    const a = r as ReadOk;
    expect(a.data).toEqual({ batch: null, moves: [], routines: [], insights: [] });
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
    const { batchId, postIds, moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(2), posts: twoPosts(), pinned: ["gobletSquat"] });
    const [a, , b] = moveIds[0]!;
    const [p0, p1] = postIds;
    const r = await ok({});
    expect(r.provenance!.source).toBe("the athlete's saves");
    // Saved Thu 22 Oct, 10:00 in Los Angeles.
    expect(r.data.batch).toEqual({ id: batchId, savedAt: "2026-10-22" });
    expect(r.data.moves.map(oldShape)).toEqual([
      {
        id: a, name: U("Zorbex hip circle"), new: true, choice: "coach", like: null, pinned: false, groups: "hip", posts: 2,
        // Its first link with its note: the post's reading of what the move is for (spec §17), marked; a later link by
        // its post (the budgets review, 2026-11-06).
        links: [{ post: p0, note: U("mobility") }, { post: p1 }],
      },
      { id: b, name: U("Zorbex neck nod"), new: true, choice: "coach", like: null, pinned: false, groups: "neck", posts: 1, links: [{ post: p0, note: U("mobility") }] },
      {
        // The library's own words: code, not marked.
        id: "gobletSquat", name: GOBLET.name, new: false, choice: "coach", like: null, pinned: true, groups: moveGroup(GOBLET), posts: 1,
        links: [{ post: p0, note: U("mobility") }],
      },
    ]);
    // Each post the page names, once: its address, its creator (no handle: the name) and its reading, marked — and a
    // routine's moves in the post's order, by their place in the batch; the single move's post is no routine.
    expect(r.data.posts).toEqual([
      { id: p0, url: expect.stringMatching(/^https:\/\/example\.com\/p\//), creator: U("coach_zero"), reading: U("Three moves for the hips, slow."), order: [1, 3, 2] },
      { id: p1, url: expect.stringMatching(/^https:\/\/example\.com\/p\//), creator: U("Coach One"), reading: U("One hip circle, done well.") },
    ]);
    // A move's summary is the full form's: every word.
    const whole = await ok({ full: true });
    expect(whole.data.moves.map((m: any) => m.summary)).toEqual([U("Zorbex hip circle, slow and even."), U("A small nod, chin tucked."), GOBLET.text.summary]);
    expect(r.summary).toBe("Read 3 moves from your saves, 2 new (saved Thu 22 Oct)");
    // How the coach closes it (coach-context audit I2): a pins card naming it, approved.
    expect(r.data.next).toBe(`pin_moves({ batchId: ${JSON.stringify(batchId)} }) closes this batch once approved — with the moves you pin, or none`);
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
    expect(oldShape(r.data.moves[0]).links).toEqual([{ post: id, note: U("mobility") }]);
    expect(r.data.posts).toEqual([{ id, url: "https://example.com/p/real", creator: U("coach_real"), reading: U("Hips, then the neck."), order: [1, 2] }]);
  });

  it("a link the owner removed is left out, and a move only it named is not listed", async () => {
    const posts = twoPosts();
    posts[0]!.removed = [2];
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts });
    const r = await ok({});
    expect(r.data.moves.map((m: any) => m.id)).toEqual([moveIds[0]![0], "gobletSquat"]);
    expect(r.data.posts[0].order).toEqual([1, 2]);
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

  it("limit: 12 by default and at most; a batch with more says how many more and the offset that reads them", async () => {
    const drafts = Array.from({ length: 15 }, (_, i) => ({ draft: savedMoveDraft(`Zorbex move ${String(i).padStart(2, "0")}`, { summary: "Short." }) }));
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "single_move", summary: "s", moves: drafts.slice(0, 8) }, { kind: "single_move", summary: "s", moves: drafts.slice(8) }] });
    const r = await ok({});
    // REBASED 2026-11-06 (coach review, phase 3): each move carries its evidence now (§8.1), so fifteen short moves fill
    // the page's bytes before the cap of 12 (9 measured) — the page says the offset that reads the rest either way.
    const shown = r.data.moves.length;
    expect(shown).toBeGreaterThan(4);
    expect(shown).toBeLessThanOrEqual(12);
    expect(r.missing).toContain(`${15 - shown} more moves — pass offset: ${shown}`);
    const four = await ok({ limit: 4 });
    expect(four.data.moves).toHaveLength(4);
    expect(four.missing).toContain("11 more moves — pass offset: 4");
    const refused = (await read({ limit: 13 })).r as ToolErr;
    expect(refused.error).toBe("invalid_input");
    expect(refused.why).toMatch(/^limit:/);
  });

  it("offset pages the moves in the same order: the page after the first starts where it ended, and says nothing more is left", async () => {
    const drafts = Array.from({ length: 15 }, (_, i) => ({ draft: savedMoveDraft(`Zorbex move ${String(i).padStart(2, "0")}`, { summary: "Short." }) }));
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "single_move", summary: "s", moves: drafts }] });
    // REBASED 2026-11-06 (coach review, phase 3): a page ends at its bytes or the cap; paged by the offsets each page
    // gives, the pages are the batch's one order, whole, and the last says nothing more is left.
    const whole: string[] = [];
    let last: any = null;
    for (let offset = 0, pages = 0; pages < 5; pages++) {
      last = await ok(offset ? { offset } : {});
      whole.push(...last.data.moves.map((m: any) => m.name.text));
      const next = (last.missing as string[]).map((m) => /pass offset: (\d+)/.exec(m)?.[1]).find(Boolean);
      if (!next) break;
      offset = Number(next);
    }
    expect(whole).toEqual(drafts.map((d) => d.draft.name));
    expect(last.missing.filter((m: string) => m.includes("pass offset"))).toEqual([]);
    // A page in the middle: four from the fifth.
    expect((await ok({ offset: 4, limit: 4 })).data.moves.map((m: any) => m.name.text)).toEqual(drafts.slice(4, 8).map((d) => d.draft.name));
    // Past the end: refused, saying how many there are; two statements still.
    const { r, count } = await read({ offset: 15 });
    expect((r as ToolErr).error).toBe("bad_offset");
    expect((r as ToolErr).why).toBe("The batch lists 15 moves; offset 15 is past them.");
    expect(count).toBe(2);
    expect(((await read({ offset: -1 })).r as ToolErr).error).toBe("invalid_input");
  });

  it("an archived move is never offered: left out of the moves and the routines, and named in missing — a move merged into it too", async () => {
    const C = savedMoveDraft("Zorbex calf raise", { regions: ["calves"] });
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "routine", moves: [{ draft: A }, { library: "gobletSquat" }, { draft: B }, { draft: C }] }] });
    const [a, , b, c] = moveIds[0]!;
    const pm = schema.personalMoves;
    // After saving, the owner archived A and merged C into it.
    await db.update(pm).set({ status: "archived" }).where(and(eq(pm.userId, userId), eq(pm.id, a!)));
    await db.update(pm).set({ status: "merged", mergedInto: a! }).where(and(eq(pm.userId, userId), eq(pm.id, c!)));
    const r = await ok({});
    expect(r.data.moves.map((m: any) => m.id)).toEqual([b, "gobletSquat"]);
    expect(r.data.moves.map((m: any) => [m.n, m.id])).toEqual([[1, b], [2, "gobletSquat"]]);
    expect(r.data.posts).toEqual([expect.objectContaining({ order: [2, 1] })]);
    expect(r.missing).toContain(`1 move of this batch archived since, not offered: ${a}`);
    expect(JSON.stringify(r.data)).not.toContain(a!);
  });

  it("routines: each routine post the page's moves name, once, its moves by their place in the batch — REBASED 2026-11-06 (the budgets review): no cap of its own, the posts ride with their moves", async () => {
    const posts: SavedPostSpec[] = Array.from({ length: 7 }, (_, i) => ({ kind: "routine", summary: `Routine ${i}.`, moves: [{ library: "gobletSquat" }, { library: "deadBug" }] }));
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts });
    const r = await ok({});
    // The goblet squat's posts are its first three (LINKS_MAX); the dead bug's the same.
    expect(r.data.posts.map((x: any) => [x.reading.text, x.order])).toEqual([["Routine 0.", [1, 2]], ["Routine 1.", [1, 2]], ["Routine 2.", [1, 2]]]);
    expect(r.missing!.some((m) => m.includes("routine"))).toBe(false);
  });

  it("twelve moves at their longest stay within the answer's budget, and every marked text has its marker first", async () => {
    // With five 200-character insights and a 160-character note on every link (spec §17). Measured 2026-10-25: 6,337 B,
    // 4 of the 12 moves on the first page. RE-PINNED 2026-10-26 (saves flow redesign: each move's choice and like,
    // +29 B a move at the least — 1,259 B a move here): 6,315 B, 3 of the 12 on the first page, routines in the rest.
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: longBatchPosts() });
    const r = await ok({});
    // What the model is given: never the line nor the receipt (coach-runs.ts `okResult`).
    const { summary: _s, receipt: _receipt, ...forModel } = r;
    const text = JSON.stringify(forModel);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    // What did not fit is said, never cut silently.
    const shown = r.data.moves.length;
    expect(shown).toBeGreaterThan(2);
    if (shown < 12) expect(r.missing).toContain(`${plural(12 - shown, "more move", "more moves")} — pass offset: ${shown}`);
    expect(r.data.insights).toHaveLength(5);
    // A move's summary is the full form's (the budgets review, 2026-11-06).
    for (const lead of ["LONG-reading", "LONG-handle", "LONG move", "LONG-purpose", "LONG-insight"]) {
      const at = [...text.matchAll(new RegExp(lead, "g"))];
      expect(at.length, lead).toBeGreaterThan(0);
      for (const m of at) expect(text.slice(m.index! - 26, m.index), lead).toBe('{"untrusted":true,"text":"');
    }
  });

  it("insights (spec §17): at most 5 of the kept posts', in the posts' order, marked; a post whose rows were all removed gives none — in the statements it had", async () => {
    const posts = twoPosts();
    posts[0]!.insights = ["Twice a week is plenty.", "Before a run, not after."];
    posts[1]!.insights = ["Keep the neck long.", "Breathe out on the way up.", "Stop if the jaw clenches."];
    const removed: SavedPostSpec = { kind: "single_move", insights: ["REMOVED-POST-INSIGHT"], removed: [0], moves: [{ library: "deadBug" }] };
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [posts[0]!, removed, posts[1]!, { kind: "single_move", insights: ["A sixth."], moves: [{ library: "deadBug" }] }] });
    const { r, count } = await read({});
    expect(count).toBe(3);
    const a = r as ReadOk & { data: any };
    expect(a.data.insights.map((i: any) => i.text)).toEqual([
      U("Twice a week is plenty."), U("Before a run, not after."), U("Keep the neck long."), U("Breathe out on the way up."), U("Stop if the jaw clenches."),
    ]);
    expect(a.data.insights.every((i: any) => i.scope === "general")).toBe(true);
    expect(JSON.stringify(a)).not.toContain("REMOVED-POST-INSIGHT");
    expect(JSON.stringify(a)).not.toContain("A sixth.");
  });

  it("a link's note is its post's reading of the move — null when the post gave none", async () => {
    const quiet = savedMoveDraft("Zorbex quiet move", { purpose: "" });
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "single_move", moves: [{ draft: quiet }] }] });
    const r = await ok({});
    expect(oldShape(r.data.moves[0]).links).toEqual([{ post: expect.any(String), note: null }]);
    expect(r.data.posts[0].creator).toEqual(U("coach_0"));
  });

  it("in a step, the athlete is the step's shared read: the batch and its page's evidence are two statements more", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: twoPosts() });
    const athlete = sharedAthlete(db, userId, NOW);
    await athlete();
    const { r, count } = await read({}, userId, { athlete });
    expect((r as ReadOk & { data: any }).data.moves).toHaveLength(3);
    expect(count).toBe(2);
    // Outside a step it reads the athlete too: three, the most.
    expect((await read({})).count).toBe(3);
  });

  it("with the run's batch and no batchId, read_saves reads it past the 14-day window; each move's choice and like (the like's name marked when personal)", async () => {
    const C = savedMoveDraft("Zorbex hip circle wide");
    const old = await seedSavedBatch(db, userId, {
      savedAt: daysAgo(30),
      posts: [
        { kind: "routine", moves: [{ draft: A, choice: "include" }, { draft: B, choice: "skip" }, { draft: C, like: 0 }, { library: "gobletSquat" }] },
        { kind: "single_move", moves: [{ draft: savedMoveDraft("Zorbex calf rock") }] },
      ],
    });
    const newer = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ moves: [{ library: "deadBug" }] }] });
    const [a, b, c] = old.moveIds[0]!;
    const [calf] = old.moveIds[1]!;
    // The calf rock is like the library's dead bug: a library move's name is its own words, plain.
    const pm = schema.savedPostMoves;
    await db.update(pm).set({ likeMoveId: "deadBug", checkFlag: true }).where(and(eq(pm.userId, userId), eq(pm.moveId, calf!)));
    const fitIn = { run: { id: "run-saves", role: "main" as const, scope: { kind: "now" as const }, parentId: null, rehearsal: false, savesBatchId: old.batchId, savesSkip: [{ id: b!, name: "Zorbex neck nod" }] } };

    const { r, count } = await read({}, userId, fitIn);
    expect(count).toBe(3);
    const data = (r as ReadOk & { data: any }).data;
    expect(data.batch).toEqual({ id: old.batchId, savedAt: "2026-09-24" });
    expect(data.moves.map((m: any) => [m.id, m.new, m.choice, m.like ?? null])).toEqual([
      [a, true, "include", null],
      [b, true, "skip", null],
      // A saved move's name is a model's reading of a post: marked.
      [c, true, "coach", { id: a, name: U("Zorbex hip circle") }],
      [calf, true, "coach", { id: "deadBug", name: DEAD_BUG.name }],
      // A move the athlete had already is the coach's call, whatever it is like.
      ["gobletSquat", false, "coach", null],
    ]);
    // A batchId still reads the batch it names; with neither, the newest waiting one in the window.
    expect((await read({ batchId: newer.batchId }, userId, fitIn)).r).toMatchObject({ data: { batch: { id: newer.batchId } } });
    expect((await ok({})).data.batch.id).toBe(newer.batchId);
  });

  it("a move merged since into another reads as that move", async () => {
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ moves: [{ draft: A as ExtractedMove }, { library: "gobletSquat" }] }] });
    await db.update(schema.personalMoves).set({ status: "merged", mergedInto: "gobletSquat" }).where(and(eq(schema.personalMoves.userId, userId), eq(schema.personalMoves.id, moveIds[0]![0]!)));
    const r = await ok({});
    expect(r.data.moves.map((m: any) => [m.id, m.new, m.posts])).toEqual([["gobletSquat", false, 1]]);
    expect(r.data.posts[0].order).toEqual([1, 1]);
  });
});

describe("read_saves: each claim's evidence (import trail phase 3, §8.1)", () => {
  const quoted = savedMoveDraft("Zorbex hip lift", {
    // No range: the record's numbers come from the post's words.
    dose: { text: "8-10 reps" },
    purpose: "Opens the hips after easy runs",
    evidence: { name: "stated", dose: "stated", steps: "inferred", purpose: "stated", useWhen: "stated" },
    why: "Hips stiffen after easy runs",
    useWhen: [{ text: "after an easy run", evidence: "stated" }],
    skipWhen: [{ text: "on a heavy leg day", evidence: "inferred" }],
    quotes: [
      { field: "purpose", text: "if your hips get stiff after easy runs", at: 72, from: "transcript", check: "verified" },
      { field: "useWhen", text: "do it right after the run", at: 12, from: "speech", check: "in_speech" },
    ],
  });
  // No dose at all: the record's is a default.
  const guessed = savedMoveDraft("Zorbex calf rock", {
    regions: ["calves"],
    dose: { text: "" },
    evidence: { name: "stated", dose: "inferred", steps: "inferred" },
    confidence: "low",
    quotes: [{ field: "name", text: "the calf rock", from: "caption", check: "verified" }],
  });
  /** Post 0: the hip lift, the goblet squat. Post 1: the calf rock, the hip lift again. */
  const evidencePosts = (): SavedPostSpec[] => [
    { kind: "routine", summary: "Hips after a run.", moves: [{ draft: quoted }, { library: "gobletSquat" }] },
    { kind: "routine", summary: "Calves, then hips.", moves: [{ draft: guessed }, { draft: quoted }] },
  ];

  it("each move carries its evidence: stated and inferred, quotes with ids and checks, why, use and skip when, the dose and where it came from", async () => {
    const { postIds, moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: evidencePosts() });
    const [lift] = moveIds[0]!;
    const [calf] = moveIds[1]!;
    const r = await ok({});
    const [m1, m2, m3] = r.data.moves;
    expect([m1.id, m2.id, m3.id]).toEqual([lift, calf, "gobletSquat"]);
    expect([m1.n, m2.n, m3.n]).toEqual([1, 2, 3]);
    expect(m1.dose).toEqual({ record: "8–10 reps", from: "post" });
    expect(m2.dose.from).toBe("default");
    expect(m3.dose).toEqual({ record: expect.stringMatching(/reps|s/), from: "library" });
    expect(m1.links.map((l: any) => [l.post, l.at])).toEqual([[postIds[0], 0], [postIds[1], 1]]);
    // No match step on its trail (seeded directly): no match word (how it came out is its id's and `new`'s).
    expect(m1.links[0].match).toBeUndefined();
    // The compact form (the budgets review, 2026-11-06): what it stated and inferred, the post's dose words, its own
    // skip-when cases (none stated here), and each quote's id, field, check and head — the rest is full: true's.
    // REBASED 2026-11-06 (the controller's ruling): the why and the use-when cases, stated or the reader's guess, are
    // what the coach decides in or out from — on the default page, as heads.
    expect(m1.links[0].reading).toEqual({
      confidence: "high",
      stated: ["name", "dose", "purpose", "useWhen"],
      inferred: ["steps"],
      dose: U("8-10 reps"),
      why: U("Hips stiffen after easy runs"),
      useWhen: [{ text: U("after an easy run"), said: true }],
      quotes: [
        ["q1.1", "purpose", "said", U("if your hips get stiff after easy runs")],
        ["q1.2", "useWhen", "heard", U("do it right after the run")],
      ],
    });
    // A later post's reading: its quotes' ids, fields and checks, going on from the first's.
    expect(m1.links[1].reading).toEqual({ stated: ["name", "dose", "purpose", "useWhen"], inferred: ["steps"], quotes: [["q1.3", "purpose", "said"], ["q1.4", "useWhen", "heard"]] });
    expect(m2.links[0].reading.quotes).toEqual([["q2.1", "name", "in the caption", U("the calf rock")]]);
    expect(m1.corrections).toBeUndefined();
    // Every word: full: true.
    const whole = await ok({ full: true });
    expect(whole.data.moves[0].links[0].reading).toEqual({
      confidence: "high",
      stated: ["name", "dose", "purpose", "useWhen"],
      inferred: ["steps"],
      dose: U("8-10 reps"),
      why: U("Hips stiffen after easy runs"),
      useWhen: [{ text: U("after an easy run"), said: true }],
      skipWhen: [{ text: U("on a heavy leg day"), said: false }],
      quotes: [
        { id: "q1.1", field: "purpose", text: U("if your hips get stiff after easy runs"), check: "said", at: "1:12" },
        { id: "q1.2", field: "useWhen", text: U("do it right after the run"), check: "heard", at: "0:12" },
      ],
    });
    expect(whole.data.moves[0].links[1].reading.quotes.map((q: any) => q.id)).toEqual(["q1.3", "q1.4"]);
    expect(whole.data.moves[1].links[0].reading.quotes).toEqual([{ id: "q2.1", field: "name", text: U("the calf rock"), check: "in the caption" }]);
    expect(m3.links[0].match).toBeUndefined();
  });

  it("the match as its trail recorded it: by name, by the judge, or new, with its confidence and check", async () => {
    const { postIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: evidencePosts() });
    await db.insert(schema.importEvents).values({
      id: "ev-match", userId, postId: postIds[0]!, stage: "match", source: "worker", status: "ok", summary: "2 moves",
      detail: { moves: [{ position: 0, by: "new", confidence: "high" }, { position: 1, by: "name", confidence: "medium" }] }, rebuilt: false, at: daysAgo(2),
    });
    const r = await ok({});
    expect(r.data.moves[0].links[0].match).toEqual({ by: "new", confidence: "high" });
    expect(r.data.moves[2].links[0].match).toEqual({ by: "name", confidence: "medium" });
  });

  it("corrections so far show on their move, newest first, three at most — and a corrected dose says so", async () => {
    const { moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: evidencePosts() });
    const [lift] = moveIds[0]!;
    for (const [i, why] of ["first", "second", "third", "fourth"].entries()) {
      await db.insert(schema.importCorrections).values({
        id: `fix-${i}`, userId, target: "move", targetId: lift!, field: i === 3 ? "dose" : "name", before: "x",
        after: i === 3 ? { type: "time", range: [30, 30], sets: [2, 2] } : `Zorbex hip lift ${i}`, why, basis: "evidence", by: i % 2 ? "owner" : "coach", at: daysAgo(1, `0${i}:00`),
      });
    }
    const r = await ok({});
    const m = r.data.moves[0];
    expect(m.corrections).toEqual([
      { field: "dose", after: U("30 s, 2 sets"), why: U("fourth"), by: "owner", basis: "evidence", at: expect.any(String) },
      { field: "name", after: U("Zorbex hip lift 2"), why: U("third"), by: "coach", basis: "evidence", at: expect.any(String) },
      { field: "name", after: U("Zorbex hip lift 1"), why: U("second"), by: "owner", basis: "evidence", at: expect.any(String) },
    ]);
    expect(m.dose.from).toBe("edited");
  });

  it("insights keep their post and scope — a creator's own split too; the opening context's section still reads only the general ones", async () => {
    const posts = evidencePosts();
    posts[0]!.insights = [
      { text: "Day one of the creator's three-day split.", scope: "creator_programme", quote: "this is day one" },
      "Twice a week is plenty.",
    ];
    const { postIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts });
    const r = await ok({});
    expect(r.data.insights).toEqual([
      { ref: `${postIds[0]}:0`, text: U("Day one of the creator's three-day split."), scope: "creator_programme", quote: U("this is day one") },
      { ref: `${postIds[0]}:1`, text: U("Twice a week is plenty."), scope: "general" },
    ]);
    const [row] = (await db.all(sql`select ${savesBatchSql(userId, { now: NOW })} as b`)) as Array<{ b: unknown }>;
    expect(savedBatchOf(row!.b)!.insights.map((i) => i.text)).toEqual(["Twice a week is plenty."]);
  });

  it("the receipt maps every quote id read to its post, position and check — and each move to its first post", async () => {
    const { batchId, postIds, moveIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: evidencePosts() });
    const r = await ok({});
    expect(r.receipt).toEqual({
      saves: {
        batch: batchId,
        // REBASED 2026-11-06 (the fix pass): each with its place in the batch (a quote cite must be its line's move's)
        // and the fields its posts stated (stated:<field> cites the reader's report of one).
        moves: [
          [moveIds[0]![0], postIds[0], 0, 1, ["name", "dose", "purpose", "useWhen"]],
          [moveIds[1]![0], postIds[1], 0, 2, ["name"]],
          ["gobletSquat", postIds[0], 1, 3, ["name", "steps"]],
        ],
        // Every post a shown move's links named: when the run read each (pin_moves keeps it for the trail).
        posts: [postIds[0], postIds[1]],
        quotes: {
          "q1.1": [postIds[0], 0, 0, "verified", "transcript", 72],
          "q1.2": [postIds[0], 0, 1, "in_speech", "speech", 12],
          "q1.3": [postIds[1], 1, 0, "verified", "transcript", 72],
          "q1.4": [postIds[1], 1, 1, "in_speech", "speech", 12],
          "q2.1": [postIds[1], 0, 0, "verified", "caption", null],
        },
      },
    });
  });

  it("ids are the batch's, stable across pages: the second move read alone is still q2", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: evidencePosts() });
    const r = await ok({ offset: 1, limit: 1 });
    expect(r.data.moves[0].n).toBe(2);
    expect(r.data.moves[0].links[0].reading.quotes[0][0]).toBe("q2.1");
    expect(Object.keys((r.receipt as any).saves.quotes)).toEqual(["q2.1"]);
  });

  it("twelve moves each quoted eight times at length: the page shrinks to fit, and says the offset that reads the rest", async () => {
    const long = (i: number) =>
      savedMoveDraft(`Zorbex quoted move ${String(i).padStart(2, "0")}`, {
        quotes: Array.from({ length: 8 }, (_, k) => ({ field: "purpose" as const, text: `${"slow and even ".repeat(14)}${i}-${k}`.slice(0, 200), at: 10 * k, from: "transcript" as const, check: "verified" as const })),
      });
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "routine", moves: Array.from({ length: 12 }, (_, i) => ({ draft: long(i) })) }] });
    const r = await ok({});
    const { summary: _s, receipt: _r, ...forModel } = r;
    expect(new TextEncoder().encode(JSON.stringify(forModel)).length).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    const shown = r.data.moves.length;
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(12);
    expect(r.missing).toContain(`${plural(12 - shown, "more move", "more moves")} — pass offset: ${shown}`);
  });
});

describe("read_saves: pages a fit can read (the budgets review, 2026-11-06)", () => {
  /** What the model is given of an answer: never the line nor the receipt (coach-runs.ts `okResult`). */
  const forModel = (r: ReadOk & { data: any }) => {
    const { summary: _s, receipt: _r, ...rest } = r;
    return JSON.stringify(rest);
  };
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  /** Every page of the batch, as a fit reads it: from offset 0 on, each at the offset the last one's missing gave. */
  async function everyPage(): Promise<Array<ReadOk & { data: any }>> {
    const pages: Array<ReadOk & { data: any }> = [];
    let offset: number | undefined;
    for (let i = 0; i < 12; i++) {
      const r = await ok(offset === undefined ? {} : { offset });
      pages.push(r);
      const next = r.missing!.map((m: string) => /pass offset: (\d+)/.exec(m)?.[1]).find(Boolean);
      if (!next) return pages;
      offset = Number(next);
    }
    throw new Error("the pages never ended");
  }

  // REBASED 2026-11-06 (the controller's ruling: the why and two use-when cases on the default page): measured 1,462 B a
  // typical move, three a page — four reads (it was three, at 3, 5 and 4, without them).
  it("a typical extract-6 batch of twelve moves is covered in four reads at most, each within the budget", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: typicalBatchPosts() });
    const pages = await everyPage();
    expect(pages.map((p) => p.data.moves.length).reduce((a, b) => a + b, 0)).toBe(12);
    expect(new Set(pages.flatMap((p) => p.data.moves.map((m: any) => m.n)))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(pages.length).toBeLessThanOrEqual(4);
    for (const p of pages) expect(bytes(forModel(p))).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    // Every quote it read is one it was shown, and every one shown is in the receipt.
    for (const p of pages) {
      const sent = [...forModel(p).matchAll(/"(q\d+\.\d+)"/g)].map((m) => m[1]);
      expect(Object.keys((p.receipt as any).saves.quotes).sort()).toEqual([...new Set(sent)].sort());
    }
  });

  it("the insights come on the first page only — a later page says where they are", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: typicalBatchPosts() });
    const [first, ...rest] = await everyPage();
    expect(first!.data.insights).toHaveLength(5);
    expect(rest.length).toBeGreaterThan(0);
    for (const p of rest) {
      expect(p.data.insights).toEqual([]);
      expect(p.missing).toContain("insights: on the first page (offset 0, not full)");
    }
  });

  it("the widest move — three posts, each reading at extract-6's widest — with five quoted insights stays within the budget, and says what it shortened", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: widestMovePosts() });
    const r = await ok({});
    expect(r.data.moves).toHaveLength(1);
    expect(r.data.insights).toHaveLength(5);
    const text = forModel(r);
    expect(bytes(text)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    const m = r.data.moves[0];
    expect(m.links).toHaveLength(3);
    // Every link's quotes keep their ids and checks; the receipt holds just those.
    // A quote in the compact form: [id, field, check] — and its head on the move's first post.
    const ids = m.links.flatMap((l: any) => l.reading.quotes.map((q: any) => q[0]));
    expect(ids).toHaveLength(24);
    for (const l of m.links) for (const q of l.reading.quotes) expect(q[2]).toEqual(expect.any(String));
    expect(Object.keys((r.receipt as any).saves.quotes).sort()).toEqual([...ids].sort());
    // Every marked text still has its marker first.
    for (const lead of ["WIDE-reading", "WIDE-handle", "WIDE move", "WIDE-quote", "WIDE-insight", "WIDE-iquote"]) {
      const at = [...text.matchAll(new RegExp(lead, "g"))];
      expect(at.length, lead).toBeGreaterThan(0);
      for (const x of at) expect(text.slice(x.index! - 26, x.index), lead).toBe('{"untrusted":true,"text":"');
    }
    // Whole words are one call away.
    expect(r.missing!.some((l: string) => l.includes("full: true"))).toBe(true);
  });

  it("full: true reads a move's whole words — every quote whole, no insights — within the budget", async () => {
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: typicalBatchPosts() });
    const r = await ok({ offset: 4, limit: 1, full: true });
    expect(r.data.moves.map((m: any) => m.n)).toEqual([5]);
    const quotes = r.data.moves[0].links[0].reading.quotes;
    expect(quotes).toHaveLength(5);
    for (const q of quotes) {
      expect(q.text.text).toHaveLength(100);
      expect(q.cut).toBeUndefined();
    }
    expect(r.data.insights).toEqual([]);
    expect(bytes(forModel(r))).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });
});

describe("read_saves: a dropped insight stays dropped (the controller's fix pass, D8)", () => {
  it("another post with the same words never brings it back — whichever copy the coach let go", async () => {
    for (const which of [0, 1]) {
      const { userId: uid } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
      const same = "Twice a week is plenty.";
      const posts: SavedPostSpec[] = [
        { moves: [{ draft: A }], insights: [same, "Keep the neck long."] },
        { moves: [{ draft: B }], insights: [same] },
      ];
      const { postIds } = await seedSavedBatch(db, uid, { savedAt: daysAgo(1), posts });
      // An approved correction let go of one copy (import-corrections.ts: the insight kept, marked dropped).
      const p = schema.savedPosts;
      const [row] = await db.select().from(p).where(eq(p.id, postIds[which]!));
      const extraction = row!.extraction as { insights: unknown[] };
      extraction.insights[0] = { text: same, scope: "general", dropped: true };
      await db.update(p).set({ extraction }).where(eq(p.id, postIds[which]!));
      const r = await ok({}, uid);
      expect(r.data.insights.map((i: any) => i.text.text), `dropped on post ${which}`).toEqual(["Keep the neck long."]);
      const [ctxRow] = (await db.all(sql`select ${savesBatchSql(uid, { now: NOW })} as b`)) as Array<{ b: unknown }>;
      expect(savedBatchOf(ctxRow!.b)!.insights.map((i) => i.text), `the opening context, dropped on post ${which}`).toEqual(["Keep the neck long."]);
    }
  });
});

describe("read_saves: a malformed stored reading (the controller's fix pass, D12)", () => {
  it("a reading whose fields aren't the shapes they should be reads as no evidence, never failing the page", async () => {
    const { postIds } = await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: twoPosts() });
    const p = schema.savedPosts;
    const [row] = await db.select().from(p).where(eq(p.id, postIds[0]!));
    const extraction = row!.extraction as { moves: Array<Record<string, unknown>> };
    // Words where a list, an object or a quote list belongs.
    extraction.moves[0] = { ...extraction.moves[0]!, evidence: "stated", dose: "8 reps", useWhen: "after runs", skipWhen: "never", quotes: "she says so", patterns: "mobility", contraction: "iso" };
    await db.update(p).set({ extraction }).where(eq(p.id, postIds[0]!));
    const r = await ok({});
    expect(r.data.moves.map((m: any) => m.n)).toEqual([1, 2, 3]);
    expect(r.data.moves[0].links[0].reading).toMatchObject({ stated: [], inferred: [], quotes: [] });
  });
});

describe("read_saves: the compact page keeps what the coach decides from (the controller's ruling, 2026-11-06)", () => {
  it("a move's first post keeps its why (a head of about 100) and two use-when cases, stated or guessed (heads of about 60)", async () => {
    const wide = savedMoveDraft("Zorbex wide reading", {
      why: longText("WHY-head", 200),
      useWhen: [0, 1, 2].map((k) => ({ text: longText(`USE-${k}`, 160), evidence: k === 1 ? ("inferred" as const) : ("stated" as const) })),
    });
    await seedSavedBatch(db, userId, { savedAt: daysAgo(1), posts: [{ kind: "single_move", moves: [{ draft: wide }] }] });
    const reading = (await ok({})).data.moves[0].links[0].reading;
    expect(reading.why.untrusted).toBe(true);
    expect(reading.why.text.startsWith("WHY-head")).toBe(true);
    expect(reading.why.text.length).toBeLessThanOrEqual(100);
    expect(reading.why.text.endsWith("…")).toBe(true);
    expect(reading.useWhen.map((c: any) => [c.text.text.slice(0, 5), c.said, c.text.text.length <= 60])).toEqual([["USE-0", true, true], ["USE-1", false, true]]);
  });
});
