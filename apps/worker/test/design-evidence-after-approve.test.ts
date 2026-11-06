/**
 * The coach's evidence after the card is approved (audit fixes, 2026-11-06, E1): once a batch is fitted in, read_saves
 * with no batch says none waits — so a challenge days later reads a move's evidence by the move (`moveIds`), from the
 * batch that brought it, fitted or not, its quote ids as the batch numbers them; correct_import on that evidence then
 * stands. The card's batch, its moves and posts reach later turns (the conversation block, read_proposals), and
 * get_exercise's saved links name their post and batch. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS, READ_TOOLS } from "../src/services/design-tools/index.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { saveBatch } from "../src/services/saves-batches.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { coachRuns } = schema;
const NOW = new Date("2026-10-28T08:00:00.000Z");
const SAVED_AT = "2026-10-20T17:00:00.000Z";
const FITTED_AT = "2026-10-21T09:00:00.000Z";
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;
const U = (text: string) => ({ untrusted: true, text });

let db: Db;
let userId: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

const LIFT = savedMoveDraft("Zorbex hip lift", {
  dose: { text: "6-10 reps", type: "reps", range: [6, 10] },
  quotes: [{ field: "dose", text: "two sets of thirty seconds", at: 192, from: "transcript", check: "verified" }],
});
const NOD = savedMoveDraft("Zorbex neck nod", {
  regions: ["neck"],
  quotes: [{ field: "purpose", text: "for a stiff neck at the desk", from: "caption", check: "verified" }],
});

/** A batch fitted in a week ago: one post, the hip lift and the neck nod. */
async function fitted(o: { fittedAt?: string | null; owner?: string } = {}) {
  const seeded = await seedSavedBatch(db, o.owner ?? userId, {
    savedAt: SAVED_AT,
    fittedAt: o.fittedAt === undefined ? FITTED_AT : o.fittedAt,
    posts: [{ moves: [{ draft: LIFT }, { draft: NOD }] }],
  });
  const [lift, nod] = seeded.moveIds[0]!;
  return { batchId: seeded.batchId, postId: seeded.postIds[0]!, lift: lift!, nod: nod! };
}

/** A later main run answering the athlete's challenge — no batch of its own. */
async function challengeRun(words = "Why did you put the hip lift in at that dose?"): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: words, status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false, conversationId: "conv-1" }, now: NOW, toolUseId: `toolu_${newId()}` };
}

const readSaves = () => READ_TOOLS.find((t) => t.name === "read_saves")!;
const correctImport = () => ACT_TOOLS.find((t) => t.name === "correct_import")!;
const ok = <T extends ToolOk | ToolErr>(r: T): ToolOk & { data: any } => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r as ToolOk & { data: any };
};

describe("evidence after Approve: read_saves by the move", () => {
  it("with no batch, a fitted batch waits no more — the answer says so", async () => {
    await fitted();
    const ctx = await challengeRun();
    const r = ok(await readSaves().run(ctx, {}));
    expect(r.data.batch).toBeNull();
    expect(r.missing?.join(" ")).toMatch(/no saved batch waiting/);
  });

  it("moveIds reads that move's evidence from its batch, fitted or not — its n and quote ids the batch's — in three statements, writing nothing", async () => {
    const b = await fitted();
    const ctx = await challengeRun();
    statements.length = 0;
    const r = ok(await readSaves().run(ctx, { moveIds: [b.nod] }));
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.length).toBeLessThanOrEqual(readSaves().statementCost);
    expect(r.data.batch).toMatchObject({ id: b.batchId, fitted: true });
    expect(r.data.moves.map((m: any) => [m.id, m.n])).toEqual([[b.nod, 2]]);
    expect(r.data.moves[0].links[0]).toMatchObject({ post: b.postId, at: 1 });
    expect(r.data.moves[0].links[0].reading.quotes).toEqual([["q2.1", "purpose", "in the caption", U("for a stiff neck at the desk")]]);
    // A fitted batch is closed already: no line asking to close it again.
    expect(r.data.next).toBeUndefined();
    // The receipt: what pin_moves and correct_import read back.
    expect(r.receipt).toMatchObject({ saves: { batch: b.batchId, moves: [[b.nod, b.postId, 1, 2, expect.any(Array)]], posts: [b.postId] } });
  });

  it("moveId alone reads the same; a move no saved batch of the athlete's names — another account's too — is not_found", async () => {
    const b = await fitted();
    const ctx = await challengeRun();
    expect(ok(await readSaves().run(ctx, { moveId: b.lift })).data.moves.map((m: any) => m.id)).toEqual([b.lift]);
    const { userId: other } = await makeTestUser(db, { timezone: "UTC" });
    const theirs = await fitted({ owner: other });
    for (const id of [theirs.lift, "myZorbexNobodyAbc123"]) {
      const r = await readSaves().run(ctx, { moveIds: [id] });
      expect(isToolErr(r) && r.error).toBe("not_found");
    }
  });

  it("a move two batches brought: by itself the newest batch's; with the card's batchId, that card's evidence", async () => {
    const older = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, fittedAt: FITTED_AT, posts: [{ moves: [{ draft: LIFT }, { library: "deadBug" }] }] });
    const newer = await seedSavedBatch(db, userId, { savedAt: "2026-10-25T17:00:00.000Z", posts: [{ moves: [{ library: "deadBug" }] }] });
    const ctx = await challengeRun();
    expect(ok(await readSaves().run(ctx, { moveIds: ["deadBug"] })).data.batch.id).toBe(newer.batchId);
    const byCard = ok(await readSaves().run(ctx, { moveIds: ["deadBug"], batchId: older.batchId }));
    expect(byCard.data.batch.id).toBe(older.batchId);
    expect(byCard.data.moves.map((m: any) => [m.id, m.n])).toEqual([["deadBug", 2]]);
  });

  it("a challenge after Approve: read the move's evidence, cite its quote — correct_import on the evidence stands", async () => {
    const b = await fitted();
    const ctx = await challengeRun("That hip lift dose is wrong — the video says thirty seconds.");
    const before = await correctImport().run(ctx, { target: "move", targetId: b.lift, field: "dose", after: { type: "time", range: [30, 30], sets: [2, 2] }, why: "The video says two sets of thirty seconds.", basis: "evidence", cites: ["q1.1"] });
    expect(isToolErr(before) && before.error).toBe("not_read");
    const read = await readSavesInRun(db, ctx, { moveIds: [b.lift] });
    expect(read.data.moves[0].links[0].reading.quotes[0]).toEqual(["q1.1", "dose", "said", U("two sets of thirty seconds")]);
    const stored = ok(
      await correctImport().run(ctx, { target: "move", targetId: b.lift, field: "dose", after: { type: "time", range: [30, 30], sets: [2, 2] }, why: "The video says two sets of thirty seconds.", basis: "evidence", cites: ["q1.1"] }),
    );
    expect(stored.data).toMatchObject({ stored: true, said: U("Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)") });
  });
});

describe("evidence after Approve: get_exercise's saved links name their post and batch", () => {
  it("a link Save wrote carries postId and batchId; a curated one neither", async () => {
    const seeded = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, status: "released", posts: [{ moves: [{ draft: LIFT }] }] });
    await saveBatch(db, userId, seeded.batchId, SAVED_AT);
    const lift = seeded.moveIds[0]![0]!;
    await db.insert(schema.exerciseProvenance).values({ id: `curated-${newId()}`, userId, exerciseId: lift, sourceType: "testsrc", url: null, creator: "Curated Coach", sourceKey: "c#9", createdAt: NOW.toISOString() });
    const ctx = await challengeRun();
    const r = ok(await READ_TOOLS.find((t) => t.name === "get_exercise")!.run(ctx, { id: lift }));
    const links = r.data.yours.links as Array<Record<string, unknown>>;
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.postId)).toMatchObject({ postId: seeded.postIds[0], batchId: seeded.batchId });
    expect(links.find((l) => !l.postId)).not.toHaveProperty("batchId");
  });
});
