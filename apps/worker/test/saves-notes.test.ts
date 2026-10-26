/**
 * NOTES FROM THE SAVES (saved-posts import, Task 18b; spec §17): what a post teaches about when, why or how often to do
 * something is kept where the coach learns from it later.
 *  - Global: on Save (never before), each insight of a post with at least one kept row becomes one of the athlete's
 *    memory items — an observation, inferred, from a saved post, its evidence the post's link — never twice the same
 *    words while one is live, at most 5 a post and 20 a batch, in one set-based statement however big the batch.
 *  - Per move: each link Save writes carries the move's purpose as its note; the library's reads and get_exercise carry
 *    it (the coach's marked). A curated link keeps none.
 *  - The coach finds the items with recall_memory; they are never in the pinned core unless the athlete pins one.
 *  - The batch page lists the insights the coach will learn.
 * Synthetic data only (example.com, made-up names).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import type { ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import { insertBatches, type Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { libraryRoutes } from "../src/routes/library.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch, saveBatch } from "../src/services/saves-batches.js";
import { memoryCore } from "../src/services/memory-core.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import type { ReadOk } from "../src/services/design-tools/read-common.js";
import type { ToolContext } from "../src/services/design-tools/types.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, savedPostMoves, saveBatches, exerciseProvenance, coachMemory } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const NOW = "2026-10-24T12:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;
const U = (text: string) => ({ untrusted: true, text });

let db: Db;
let userId: string;
let cookie: string;
let statements: string[];

const ratings = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "Fine." },
  ]),
) as ExtractedMove["conditions"];
const move = (name: string, purpose: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name, aliases: [], summary: `${name}, slow and even.`, steps: ["Start.", "Finish."], cues: [], mistakes: [], purpose,
  dose: { text: "8 each side", type: "reps", range: [6, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "seated",
  laterality: "alternating", load: "none", contraction: ["isotonic"], difficulty: 2, conditions: ratings,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high", ...over,
});

const matchEnv = { FIXTURE_MODE: "1" } as unknown as Env;
const env = { SAVES_IMPORT: "1" } as unknown as Env;
const noFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

/** An extracted post with `insights`, matched (fixture mode: no judge); its id. */
async function matched(key: string, moves: ExtractedMove[], insights: unknown[], now = T0): Promise<string> {
  const id = await savedPostId(userId, SRC, key);
  await db.insert(savedPosts).values({
    id, userId, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: `coach_${key}`,
    firstSeenAt: now, status: "extracted", extraction: { kind: "routine", summary: "s", themes: [], moves, insights }, extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, matchEnv, userId, id, now, noFetch);
  return id;
}

const linkAt = async (postId: string, position: number) =>
  (await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, postId), eq(savedPostMoves.position, position))))[0]!;
const memory = async () => (await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).sort((x, y) => x.learnedAt.localeCompare(y.learnedAt) || x.id.localeCompare(y.id));
const bodies = async () => (await memory()).map((m) => m.body);

const QUAD_PURPOSE = "Wakes the quads up before a run.";
const HIP_PURPOSE = "Opens the hips after a day of sitting.";
const A_INSIGHTS = ["Do the quad shuffle before a run, not after.", "Twice a week is plenty for the hips."];

/**
 * Post a: Zorbex quad shuffle (new) and the library's 90/90 hip switches, two insights. Post b: Zorbex neck nod (new),
 * one insight. One released batch.
 */
async function seed(): Promise<{ batchId: string; a: string; b: string }> {
  const a = await matched("a", [move("Zorbex quad shuffle", QUAD_PURPOSE), move("90/90 Hip Switch", HIP_PURPOSE)], A_INSIGHTS);
  const b = await matched("b", [move("Zorbex neck nod", "Eases a stiff neck.", { regions: ["neck"] })], ["Stop if the jaw clenches."], at(0.5));
  const batchId = (await assembleBatch(db, matchEnv, userId, at(1)))!;
  return { batchId, a, b };
}

async function call(method: string, path: string): Promise<{ status: number; body: any }> {
  const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
  statements.length = 0;
  const res = await app.request(`/api/my-saves${path}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json" } }, env);
  return { status: res.status, body: await res.json() };
}
async function library(path: string): Promise<{ status: number; body: any }> {
  const app = mountRoutes(db, "/api/library", libraryRoutes);
  const res = await app.request(`/api/library${path}`, { headers: { Cookie: cookie } }, env);
  return { status: res.status, body: await res.json() };
}
const toolCtx = (): ToolContext => ({
  db, env: {} as Env, userId, now: new Date(NOW), toolUseId: "toolu_notes",
  run: { id: "run-notes", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false },
});
const readTool = async (name: string, input: unknown) => (await READ_TOOLS.find((t) => t.name === name)!.run(toolCtx(), input)) as ReadOk & { data: any };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Insights into the coach's memory ─────────────────────────────────────────────────────────────────────────────────

describe("Save keeps a post's insights in the coach's memory", () => {
  it("one observation an insight of a post with a kept row — inferred, from a saved post, its evidence the post's link; nothing before Save", async () => {
    const { batchId, a, b } = await seed();
    // b's only row is removed: b teaches the coach nothing.
    expect((await call("POST", `/post-moves/${(await linkAt(b, 0)).id}/remove`)).status).toBe(200);
    // Nothing from a batch is used before Save: the review's reads and writes keep no memory.
    expect((await call("GET", `/batches/${batchId}`)).status).toBe(200);
    expect(await memory()).toEqual([]);

    expect((await call("POST", `/batches/${batchId}/save`)).status).toBe(200);
    const rows = await memory();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => ({ ...r, id: undefined }))).toEqual(
      A_INSIGHTS.map((body) => ({
        id: undefined, userId, kind: "observation", body, confidence: "inferred", pinned: false, active: true, supersededBy: null, expiresAt: null,
        provenance: { source: "saved post", postId: a, url: "https://example.com/p/a", at: NOW },
        evidence: JSON.stringify(["https://example.com/p/a"]), learnedAt: NOW, updatedAt: NOW,
      })),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    // Saved again: nothing new.
    expect((await call("POST", `/batches/${batchId}/save`)).body).toEqual({ moves: 0, links: 0 });
    expect(await memory()).toEqual(rows);
  });

  it("the same words are never written twice while one is live — already the athlete's, or twice in the batch; a deleted, superseded or lapsed one is no bar", async () => {
    const live = (id: string, body: string, over: Partial<typeof coachMemory.$inferInsert> = {}) =>
      db.insert(coachMemory).values({ id, userId, kind: "observation", body, provenance: { source: "coach_inference", at: T0 }, learnedAt: T0, ...over });
    await live("m-live", "Twice a week is plenty for the hips.");
    await live("m-gone", "Do the quad shuffle before a run, not after.", { active: false });
    await live("m-old", "Breathe out on the way up.", { supersededBy: "m-live" });
    await live("m-lapsed", "Keep the neck long.", { kind: "note", expiresAt: "2026-10-01" });
    // Another athlete's item is theirs: no bar to this one's.
    const other = (await makeTestUser(db)).userId;
    await db.insert(coachMemory).values({ id: "m-other", userId: other, kind: "fact", body: "Hips first, then the quads.", provenance: { source: "message", at: T0 }, learnedAt: T0 });

    await matched("a", [move("Zorbex quad shuffle", QUAD_PURPOSE)], [...A_INSIGHTS, "Breathe out on the way up."]);
    await matched("b", [move("Zorbex neck nod", "Eases a stiff neck.")], ["Breathe out on the way up.", "Keep the neck long.", "Hips first, then the quads."], at(0.5));
    const batchId = (await assembleBatch(db, matchEnv, userId, at(1)))!;
    await saveBatch(db, userId, batchId, NOW);

    const written = (await memory()).filter((r) => r.learnedAt === NOW);
    expect(written.map((r) => r.body).sort()).toEqual(
      ["Do the quad shuffle before a run, not after.", "Breathe out on the way up.", "Keep the neck long.", "Hips first, then the quads."].sort(),
    );
    // A body both posts give is kept once, from the earlier post.
    expect(written.find((r) => r.body === "Breathe out on the way up.")!.evidence).toBe(JSON.stringify(["https://example.com/p/a"]));
    expect((await bodies()).filter((x) => x === "Twice a week is plenty for the hips.")).toHaveLength(1);
  });

  it("at most 5 a post and 20 a batch, in the posts' order and each post's own; only words — never a blank or a number", async () => {
    // Stored past the schema's 5 (an extraction is read as stored): the first 5 places count.
    const a = await matched("a", [move("Zorbex quad shuffle", QUAD_PURPOSE)], ["a0"]);
    await db.update(savedPosts).set({
      extraction: { kind: "routine", summary: "s", themes: [], moves: [move("Zorbex quad shuffle", QUAD_PURPOSE)], insights: ["a0", 7, "  ", "a3", "a4", "a5", "a6", "a7"] },
    }).where(eq(savedPosts.id, a));
    for (let p = 1; p <= 5; p++) {
      await matched(`p${p}`, [move("Zorbex quad shuffle", QUAD_PURPOSE)], [0, 1, 2, 3, 4].map((i) => `p${p}-${i}`), at(p / 10));
    }
    const batchId = (await assembleBatch(db, matchEnv, userId, at(1)))!;
    await saveBatch(db, userId, batchId, NOW);
    const written = await bodies();
    expect(written).toHaveLength(20);
    // Post a's: index 0, 3 and 4 (1 is a number, 2 blank; 5 and on past the cap).
    expect(written.filter((x) => x.startsWith("a")).sort()).toEqual(["a0", "a3", "a4"]);
    // Then the posts in order: p1 to p3 whole, p4 two (the twentieth), p5 none.
    const per = (lead: string) => written.filter((x) => x.startsWith(`${lead}-`)).length;
    expect([per("p1"), per("p2"), per("p3"), per("p4"), per("p5")]).toEqual([5, 5, 5, 2, 0]);
  });

  it("set-based: saving a 600-row batch of 60 posts with 5 insights each takes the statements a 3-row one does — 6 — and keeps 20", async () => {
    const { batchId } = await seed();
    statements.length = 0;
    await saveBatch(db, userId, batchId, NOW);
    const few = statements.length;
    // The batch and its counts, then one transaction of 5: the moves, the links, the memory, the links marked, the batch.
    expect(few).toBe(6);

    const big = "batch-600";
    await db.insert(saveBatches).values({ id: big, userId, status: "released", createdAt: T0, releasedAt: T0 });
    const posts = Array.from({ length: 60 }, (_, i) => ({
      id: `p600-${i}`, userId, source: SRC, sourceKey: `k600-${i}`, url: `https://example.com/p/600-${i}`, creatorHandle: "coach_big",
      firstSeenAt: at(i / 100), status: "matched", batchId: big, updatedAt: T0,
      extraction: { kind: "routine", summary: "s", themes: [], moves: [], insights: [0, 1, 2, 3, 4].map((n) => `Insight ${i}-${n}.`) },
    }));
    for (let i = 0; i < posts.length; i += 5) await db.insert(savedPosts).values(posts.slice(i, i + 5));
    const links = Array.from({ length: 600 }, (_, i) => ({
      id: `l600-${i}`, userId, postId: `p600-${Math.floor(i / 10)}`, position: i % 10, moveId: EXERCISES[i % 50]!.id, moveKind: "library" as const,
      batchId: big, confidence: 1, checkFlag: false, status: "pending" as const, createdAt: T0,
    }));
    for (const chunk of insertBatches(links)) await db.insert(savedPostMoves).values(chunk);
    statements.length = 0;
    expect(await saveBatch(db, userId, big, NOW)).toEqual({ moves: 0, links: 600 });
    expect(statements.length).toBe(few);
    expect(statements.filter(isWrite).length).toBe(5);
    const fresh = (await bodies()).filter((x) => x.startsWith("Insight "));
    expect(fresh).toHaveLength(20);
    expect(fresh.sort()).toEqual(
      Array.from({ length: 4 }, (_, i) => [0, 1, 2, 3, 4].map((n) => `Insight ${i}-${n}.`)).flat().sort(),
    );
  });
});

// ── The coach finds them; the core holds them only when pinned ───────────────────────────────────────────────────────

describe("the coach reads them as memory", () => {
  it("recall_memory finds a saved-post observation, its words marked; it is in the pinned core only once the athlete pins it", async () => {
    const { batchId } = await seed();
    await saveBatch(db, userId, batchId, NOW);
    const today = "2026-10-24";
    const recalled = await readTool("recall_memory", { query: "quad shuffle" });
    expect(recalled.data.memories).toEqual([
      expect.objectContaining({
        kind: "observation", confidence: "inferred", source: "saved post", learned: today,
        evidence: U(JSON.stringify(["https://example.com/p/a"])), body: U("Do the quad shuffle before a run, not after."),
      }),
    ]);
    expect((await memoryCore(db, userId, today)).map((m) => m.body)).toEqual([]);

    const [item] = await db.select().from(coachMemory).where(and(eq(coachMemory.userId, userId), eq(coachMemory.body, A_INSIGHTS[0]!)));
    await db.update(coachMemory).set({ pinned: true }).where(eq(coachMemory.id, item!.id));
    expect((await memoryCore(db, userId, today)).map((m) => m.body)).toEqual([A_INSIGHTS[0]]);
    // In the core now: recall_memory reads what lies beyond it.
    expect((await readTool("recall_memory", { query: "quad shuffle" })).data.memories).toEqual([]);
    // Its core line names its source — a creator's tip, not the coach's inference — and marks its words as a saved post's
    // (coach-context audit I3).
    const { system } = await buildDesignContext(db, {} as Env, userId, { id: "run-mem", role: "main", scope: { kind: "now" }, request: "Something easy.", parentId: null }, new Date(NOW));
    const line = system[3]!.text.split("\n").find((l) => l.includes(A_INSIGHTS[0]!))!;
    expect(line).toBe(
      `- [${item!.id}] observation, from a saved post — a creator's tip as a model read it, not the athlete's words or the coach's inference, pinned: <untrusted from="saved post">${A_INSIGHTS[0]}</untrusted>`,
    );
    expect(line).not.toContain("the coach's inference, not yet confirmed");
  });
});

// ── A move's note on its link ────────────────────────────────────────────────────────────────────────────────────────

describe("a move's note on its link", () => {
  it("Save writes each link's note from the move's purpose; a curated link keeps none, and a blank purpose is no note", async () => {
    await db.insert(exerciseProvenance).values({
      id: "curated", userId, exerciseId: HIP_SWITCH.id, sourceType: SRC, url: "https://example.com/curated", creator: "Curated Coach", sourceKey: "c#0", createdAt: T0,
    });
    const { batchId, a, b } = await seed();
    await db.update(savedPosts).set({
      extraction: { kind: "single_move", summary: "s", themes: [], moves: [move("Zorbex neck nod", "   ", { regions: ["neck"] })], insights: [] },
    }).where(eq(savedPosts.id, b));
    await saveBatch(db, userId, batchId, NOW);
    const quad = (await linkAt(a, 0)).moveId;
    const neck = (await linkAt(b, 0)).moveId;
    const rows = await db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId));
    const noteOf = (exerciseId: string, url: string) => rows.find((r) => r.exerciseId === exerciseId && r.url === url)!.note;
    expect(noteOf(quad, "https://example.com/p/a")).toBe(QUAD_PURPOSE);
    expect(noteOf(HIP_SWITCH.id, "https://example.com/p/a")).toBe(HIP_PURPOSE);
    expect(noteOf(neck, "https://example.com/p/b")).toBeNull();
    expect(noteOf(HIP_SWITCH.id, "https://example.com/curated")).toBeNull();

    // The owner's reads carry it: the move's own page, and their moves.
    const item = await library(`/${HIP_SWITCH.id}`);
    expect(item.body.provenance).toEqual([
      { sourceType: SRC, url: "https://example.com/curated", creator: "Curated Coach", note: null },
      { sourceType: SRC, url: "https://example.com/p/a", creator: "coach_a", note: HIP_PURPOSE },
    ]);
    const mine = await library("/personal");
    expect(mine.body.moves.find((m: any) => m.record.id === quad).links).toEqual([{ url: "https://example.com/p/a", creator: "coach_a", note: QUAD_PURPOSE }]);
    expect(mine.body.moves.find((m: any) => m.record.id === neck).links).toEqual([{ url: "https://example.com/p/b", creator: "coach_b", note: null }]);

    // The coach's: get_exercise, the note marked as text from outside.
    const ex = await readTool("get_exercise", { id: quad });
    expect(ex.data.yours.links).toEqual([{ url: U("https://example.com/p/a"), creator: U("coach_a"), note: U(QUAD_PURPOSE) }]);
    statements.length = 0;
    const hip = await readTool("get_exercise", { id: HIP_SWITCH.id });
    const hipStatements = statements.length;
    expect(hip.data.yours.saved).toBe(true);
    // A library move's links too (final review I5; the ruling: the curated links and the ones Save wrote), each marked —
    // in the statements it had (the links ride in its second read).
    expect(hip.data.yours.own).toBeUndefined();
    expect(hip.data.yours.links).toEqual([
      { url: U("https://example.com/curated"), creator: U("Curated Coach"), note: null },
      { url: U("https://example.com/p/a"), creator: U("coach_a"), note: U(HIP_PURPOSE) },
    ]);
    expect(hipStatements).toBeLessThanOrEqual(READ_TOOLS.find((t) => t.name === "get_exercise")!.statementCost);
  });
});

// ── The batch page ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("the batch page lists the insights", () => {
  it("each insight of a post with a kept row, with the post and its creator, in the posts' order — in the statements it had", async () => {
    const { batchId, a, b } = await seed();
    const page = await call("GET", `/batches/${batchId}`);
    expect(page.status).toBe(200);
    // The session, the batch (its insights ride in it), its rows.
    expect(statements.length).toBe(3);
    expect(page.body.insights).toEqual([
      { postId: a, url: "https://example.com/p/a", creator: "coach_a", text: A_INSIGHTS[0] },
      { postId: a, url: "https://example.com/p/a", creator: "coach_a", text: A_INSIGHTS[1] },
      { postId: b, url: "https://example.com/p/b", creator: "coach_b", text: "Stop if the jaw clenches." },
    ]);
    // A post whose rows are all removed teaches nothing: its insights leave the page.
    await call("POST", `/post-moves/${(await linkAt(b, 0)).id}/remove`);
    expect((await call("GET", `/batches/${batchId}`)).body.insights.map((i: { postId: string }) => i.postId)).toEqual([a, a]);
    // Saved, the page still lists what was kept.
    await call("POST", `/batches/${batchId}/save`);
    expect((await call("GET", `/batches/${batchId}`)).body.insights).toHaveLength(2);
  });
});
