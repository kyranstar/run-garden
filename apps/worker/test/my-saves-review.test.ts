/**
 * "From your saves", the owner's review of a batch (saved-posts import, Task 15; `/api/my-saves/*`): the batches, a
 * batch's rows (New / Linked to … / Check this, with the dose as the post gave it), an edit held to the library's own
 * validation, "Not this move" and "Same as…" (a re-match that repoints the link, merging a pending move it leaves),
 * Remove, Save (only the rows left, set-based), and the bootstrap's held batch and its release. Another account's batch,
 * row or move is 404 everywhere. Every route's statements are pinned. Synthetic data only (example.com, made-up names).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES, type ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId, personalMoveId, type Extraction, type ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import { insertBatches, type Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { libraryRoutes } from "../src/routes/library.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch } from "../src/services/saves-batches.js";
import { editPersonalMove } from "../src/services/saves-review.js";
import { forgetAccountLibrary, loadAccountLibrary } from "../src/services/account-library.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, saveBatches, exerciseProvenance } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const NOW = "2026-10-24T12:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;

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
const move = (name: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name, aliases: [], summary: `${name}, slow and even.`, steps: ["Start.", "Finish."], cues: [], mistakes: [], purpose: "mobility",
  dose: { text: "8 each side", type: "reps", range: [6, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "seated",
  laterality: "alternating", load: "none", contraction: ["isotonic"], difficulty: 2, conditions: ratings,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high", ...over,
});
const extraction = (moves: ExtractedMove[]): Extraction => ({ kind: "routine", summary: "s", themes: [], moves });

const matchEnv = { FIXTURE_MODE: "1" } as unknown as Env;
const env = { SAVES_IMPORT: "1" } as unknown as Env;
const noFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

/** An extracted post, matched (fixture mode: no judge); its id. */
async function matched(key: string, moves: ExtractedMove[], owner = userId, now = T0): Promise<string> {
  const id = await savedPostId(owner, SRC, key);
  await db.insert(savedPosts).values({
    id, userId: owner, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: `coach_${key}`,
    firstSeenAt: now, status: "extracted", extraction: extraction(moves), extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, matchEnv, owner, id, now, noFetch);
  return id;
}

interface Seeded {
  batchId: string;
  a: string;
  b: string;
  /** The new move posts a and b share ("Zorbex quad shuffle"). */
  quad: string;
  /** Post b's other new move, flagged "check this" (the reading was unsure). */
  neck: string;
}

/**
 * Two posts in one released batch: a = [Zorbex quad shuffle (new), 90/90 Hip Switch (the library's)], b = [Zorbex quad
 * shuffles (the same new move), Zorbex neck nod (new, check this)].
 */
async function seed(owner = userId): Promise<Seeded> {
  const a = await matched("a", [move("Zorbex quad shuffle", { dose: { text: "3 x 10", type: "reps", range: [10, 10], sets: [3, 3] } }), move("90/90 Hip Switch")], owner);
  const b = await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"], confidence: "low" })], owner, at(0.5));
  const batchId = (await assembleBatch(db, matchEnv, owner, at(1)))!;
  const quad = (await linkAt(a, 0)).moveId;
  const neck = (await linkAt(b, 1)).moveId;
  return { batchId, a, b, quad, neck };
}

const linkAt = async (postId: string, position: number) =>
  (await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, postId), eq(savedPostMoves.position, position))))[0]!;
const moveRow = async (id: string) => (await db.select().from(personalMoves).where(eq(personalMoves.id, id)))[0];
const batchRow = async (id: string) => (await db.select().from(saveBatches).where(eq(saveBatches.id, id)))[0]!;

/** One of the account's own moves, stored as the import stores one; its id. */
async function ownMove(name: string, status: "active" | "archived" | "pending" | "merged", owner = userId): Promise<string> {
  const id = personalMoveId(name, `${owner}:${name}`);
  await db.insert(personalMoves).values({
    id, userId: owner, status, mergedInto: null, batchId: null, record: toPersonalRecord(id, move(name)), editedByOwner: false, createdAt: T0, updatedAt: T0,
  });
  return id;
}

interface Reply {
  status: number;
  body: any;
}
async function call(method: string, path: string, body?: unknown, as: string = cookie): Promise<Reply> {
  const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
  statements.length = 0;
  const res = await app.request(
    `/api/my-saves${path}`,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  return { status: res.status, body: await res.json() };
}
async function library(path: string): Promise<Reply> {
  const app = mountRoutes(db, "/api/library", libraryRoutes);
  statements.length = 0;
  const res = await app.request(`/api/library${path}`, { headers: { Cookie: cookie } }, env);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The batches ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /batches", () => {
  it("lists released and saved batches, newest first; held ones only with ?held=1; each with its counts — 2 statements", async () => {
    const { batchId } = await seed();
    await matched("c", [move("Zorbex hip circle")], userId, at(2));
    const held = (await assembleBatch(db, { ...matchEnv, SAVES_HOLD_BATCHES: "1" } as Env, userId, at(30)))!;

    const res = await call("GET", "/batches");
    expect(res.status).toBe(200);
    // The session, the batches with their counts.
    expect(statements.length).toBe(2);
    expect(res.body.batches).toEqual([
      {
        id: batchId, status: "released", notice: "From your saves: 2 new moves (1 hip, 1 neck), 1 you already had.", theme: null,
        createdAt: at(1), releasedAt: at(1), savedAt: null, counts: { new: 2, linked: 1, removed: 0 },
      },
    ]);
    const all = await call("GET", "/batches?held=1");
    expect(all.body.batches.map((b: { id: string; status: string }) => [b.id, b.status])).toEqual([
      [held, "held"],
      [batchId, "released"],
    ]);
  });

  it("a saved batch keeps its counts, and its page still shows the moves it brought as New — the list and the page agree", async () => {
    const { batchId, b, quad } = await seed();
    expect((await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/remove`)).status).toBe(200);
    expect((await call("POST", `/batches/${batchId}/save`)).status).toBe(200);
    const res = await call("GET", "/batches");
    expect(res.body.batches[0]).toMatchObject({ id: batchId, status: "saved", savedAt: NOW, counts: { new: 1, linked: 1, removed: 1 } });
    const page = await call("GET", `/batches/${batchId}`);
    expect(page.body.batch.counts).toEqual(res.body.batches[0].counts);
    const kept = (page.body.rows as any[]).filter((r) => r.status !== "removed");
    expect(kept.map((r) => [r.move.id, r.move.kind, r.status])).toEqual([
      [quad, "new", "saved"],
      [HIP_SWITCH.id, "linked", "saved"],
      [quad, "new", "saved"],
    ]);
    expect(kept[0].move.linkedName).toBeUndefined();
    const distinct = (kind: string) => new Set(kept.filter((r) => r.move.kind === kind).map((r) => r.move.id)).size;
    expect({ new: distinct("new"), linked: distinct("linked") }).toEqual({ new: 1, linked: 1 });
  });

  it("a pending move another batch brought reads as linked here, on the page and in the counts alike", async () => {
    const { batchId, neck } = await seed();
    await db.update(personalMoves).set({ batchId: "an-earlier-batch" }).where(eq(personalMoves.id, neck));
    const page = await call("GET", `/batches/${batchId}`);
    expect((page.body.rows as any[]).find((r) => r.move.id === neck).move).toMatchObject({ kind: "linked", linkedName: "Zorbex neck nod" });
    expect(page.body.batch.counts).toEqual({ new: 1, linked: 2, removed: 0 });
  });
});

describe("GET /batches/:id", () => {
  it("rows: New / Linked to {name} / Check this, the post's creator and kind, the dose as posted, a new move's record — 3 statements", async () => {
    const { batchId, a, b, quad, neck } = await seed();
    const res = await call("GET", `/batches/${batchId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the batch, its rows (no move of the rows is merged: the account's library is not read).
    expect(statements.length).toBe(3);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(res.body.batch).toMatchObject({ id: batchId, status: "released", counts: { new: 2, linked: 1, removed: 0 } });
    const rows = res.body.rows as any[];
    expect(rows.map((r) => [r.postMoveId, r.move.kind, r.move.id, r.move.check])).toEqual([
      [(await linkAt(a, 0)).id, "new", quad, false],
      [(await linkAt(a, 1)).id, "linked", HIP_SWITCH.id, false],
      [(await linkAt(b, 0)).id, "new", quad, false],
      [(await linkAt(b, 1)).id, "new", neck, true],
    ]);
    expect(rows[0]).toMatchObject({
      position: 0, status: "pending",
      post: { url: "https://example.com/p/a", creator: "coach_a", kind: "routine" },
      move: { name: "Zorbex quad shuffle", summary: "Zorbex quad shuffle, slow and even.", seenDose: "3 x 10" },
      record: { id: quad, name: "Zorbex quad shuffle", dose: { type: "reps", range: [10, 10], sets: [3, 3] } },
    });
    expect(rows[0].move.linkedName).toBeUndefined();
    // A linked row: the name as the post gave it, the library's name, no record.
    expect(rows[1]).toMatchObject({ move: { name: "90/90 Hip Switch", linkedName: "90/90 hip switches", seenDose: "8 each side" } });
    expect(rows[1].record).toBeUndefined();
  });

  it("a row linked to one of the owner's own moves names it and carries its record", async () => {
    const { batchId, b } = await seed();
    const lantern = await ownMove("Lantern reach", "active");
    expect((await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/rematch`, { to: lantern })).status).toBe(200);
    const rows = (await call("GET", `/batches/${batchId}`)).body.rows as any[];
    expect(rows[3]).toMatchObject({ move: { id: lantern, kind: "linked", linkedName: "Lantern reach", name: "Zorbex neck nod", check: false }, record: { id: lantern } });
  });

  it("a row naming a move merged since reads its target's name — 4 statements (the account's library)", async () => {
    const { batchId, b, neck } = await seed();
    const lantern = await ownMove("Lantern reach", "active");
    // Merged by another batch's review, while this batch's row still names it.
    await db.update(personalMoves).set({ status: "merged", mergedInto: lantern }).where(eq(personalMoves.id, neck));
    const res = await call("GET", `/batches/${batchId}`);
    expect(statements.length).toBe(4);
    const row = (res.body.rows as any[]).find((r) => r.move.id === neck);
    expect(row).toMatchObject({ postMoveId: (await linkAt(b, 1)).id, move: { kind: "linked", linkedName: "Lantern reach", name: "Zorbex neck nod" } });
    expect(row.record).toBeUndefined();
  });

  it("another user's batch is 404", async () => {
    const other = (await makeTestUser(db)).userId;
    const theirs = await seed(other);
    expect((await call("GET", `/batches/${theirs.batchId}`)).status).toBe(404);
    expect((await call("GET", "/batches")).body.batches).toEqual([]);
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("PUT /moves/:id", () => {
  it("An edit keeps validation, so removing a rating is a 422 — and nothing is written", async () => {
    const { quad } = await seed();
    const before = await moveRow(quad);
    const profile = Object.values(PROFILES)[0]!;
    const [dropped, ...kept] = Object.keys(profile.attributes);
    const attrs = Object.fromEntries(kept.map((k) => [k, (before!.record as ExerciseRecord).conditions[profile.id]![k]!]));
    const res = await call("PUT", `/moves/${quad}`, { conditions: { [profile.id]: attrs } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_record");
    expect(res.body.issues).toEqual([expect.stringContaining(`conditions.${profile.id}.${dropped}`)]);
    // The issues are the owner's to read: no id in front.
    expect(res.body.issues[0].startsWith(quad)).toBe(false);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await moveRow(quad)).toEqual(before);
  });

  it("changes only what is sent, keeps the id, marks the move edited — 4 statements", async () => {
    const { quad } = await seed();
    const before = (await moveRow(quad))!.record as ExerciseRecord;
    const profile = Object.values(PROFILES)[0]!;
    const res = await call("PUT", `/moves/${quad}`, {
      name: "Zorbex quad walk",
      text: { summary: "Walk it slowly.", steps: ["Stand tall.", "Walk."], conditions: { [profile.id]: "Keep the jaw soft." } },
      dose: { type: "reps", range: [8, 12], sets: [2, 3] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the restore guard, the move, its write.
    expect(statements.length).toBe(4);
    const row = (await moveRow(quad))!;
    const rec = row.record as ExerciseRecord;
    expect(row).toMatchObject({ editedByOwner: true, updatedAt: NOW, status: "pending" });
    expect(rec).toMatchObject({
      id: quad, name: "Zorbex quad walk", dose: { type: "reps", range: [8, 12], sets: [2, 3] },
      text: { summary: "Walk it slowly.", steps: ["Stand tall.", "Walk."], focus: before.text.focus, why: before.text.why },
    });
    expect(rec.text.conditions[profile.id]).toBe("Keep the jaw soft.");
    expect(rec.conditions).toEqual(before.conditions);
    expect(res.body.record).toEqual(rec);
  });

  it("edits a pending or active move only: archived, merged, another account's or none at all is 404", async () => {
    await seed();
    const active = await ownMove("Lantern reach", "active");
    expect((await call("PUT", `/moves/${active}`, { name: "Lantern reach long" })).status).toBe(200);
    const archived = await ownMove("Windmill switch", "archived");
    const merged = await ownMove("Wall angel", "merged");
    const theirs = await ownMove("Prone Y raise", "active", (await makeTestUser(db)).userId);
    for (const id of [archived, merged, theirs, "myNotAMove000000", "gobletSquat"]) {
      const res = await call("PUT", `/moves/${id}`, { name: "Renamed" });
      expect(res.status, id).toBe(404);
      expect(statements.filter(isWrite), id).toEqual([]);
    }
  });

  it("a body outside the shape is 422 and writes nothing", async () => {
    const { quad } = await seed();
    for (const body of [{}, { id: "myOther000000" }, { name: "" }, { text: { why: "x" } }, { conditions: { nope: {} } }, { dose: { type: "laps", range: [1, 2] } }]) {
      const res = await call("PUT", `/moves/${quad}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(statements.filter(isWrite)).toEqual([]);
    }
  });

  it("an edit of an active move is read by the rest of the request (the account's library is forgotten)", async () => {
    const active = await ownMove("Lantern reach", "active");
    expect((await loadAccountLibrary(db, userId)).offered.find((r) => r.id === active)?.name).toBe("Lantern reach");
    const out = await editPersonalMove(db, userId, active, { name: "Lantern reach long" }, NOW);
    expect(out.kind).toBe("ok");
    expect((await loadAccountLibrary(db, userId)).offered.find((r) => r.id === active)?.name).toBe("Lantern reach long");
  });
});

// ── Re-match ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /post-moves/:id/rematch", () => {
  it("Rematch to a library id moves the link — and the pending move it leaves is merged into it", async () => {
    const { b, neck } = await seed();
    const link = await linkAt(b, 1);
    const res = await call("POST", `/post-moves/${link.id}/rematch`, { to: "gobletSquat" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the restore guard, the link with all it needs, then one transaction: the link and the merge.
    expect(statements.length).toBe(5);
    expect(await linkAt(b, 1)).toMatchObject({ moveId: "gobletSquat", moveKind: "library", checkFlag: false, status: "pending" });
    expect(await moveRow(neck)).toMatchObject({ status: "merged", mergedInto: "gobletSquat", updatedAt: NOW });
  });

  it("Rematch null creates a personal move from the post's own reading of it", async () => {
    const { batchId, a } = await seed();
    const link = await linkAt(a, 1);
    const res = await call("POST", `/post-moves/${link.id}/rematch`, { to: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the restore guard, the link with the post's reading, then one transaction: the move and the link.
    expect(statements.length).toBe(5);
    const now = await linkAt(a, 1);
    expect(res.body).toEqual({ ok: true, move: { id: now.moveId, kind: "personal" } });
    expect(isPersonalId(now.moveId)).toBe(true);
    expect(now).toMatchObject({ moveKind: "personal", status: "pending" });
    const made = (await moveRow(now.moveId))!;
    expect(made).toMatchObject({ status: "pending", batchId, mergedInto: null, editedByOwner: false, createdAt: NOW });
    expect(made.record as ExerciseRecord).toMatchObject({ id: now.moveId, name: "90/90 Hip Switch", text: { summary: "90/90 Hip Switch, slow and even." } });
    const row = ((await call("GET", `/batches/${batchId}`)).body.rows as any[])[1];
    expect(row.move).toMatchObject({ id: now.moveId, kind: "new", name: "90/90 Hip Switch" });
  });

  it("Not this move always makes the post's own move from its reading; a new move it leaves stays pending, never used", async () => {
    const { batchId, a, b, quad, neck } = await seed();
    // A new move that is the post's own already: another, from the reading; the one it leaves stays pending.
    expect((await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/rematch`, { to: null })).status).toBe(200);
    const again = (await linkAt(b, 1)).moveId;
    expect(again).not.toBe(neck);
    expect((await moveRow(again))!.record as ExerciseRecord).toMatchObject({ name: "Zorbex neck nod" });
    expect(await moveRow(neck)).toMatchObject({ status: "pending", mergedInto: null });
    // A shared new move: this post's own; the other post still names the shared one.
    expect((await call("POST", `/post-moves/${(await linkAt(b, 0)).id}/rematch`, { to: null })).status).toBe(200);
    const own = (await linkAt(b, 0)).moveId;
    expect(own).not.toBe(quad);
    expect((await moveRow(own))!.record as ExerciseRecord).toMatchObject({ name: "Zorbex quad shuffles" });
    expect((await linkAt(a, 0)).moveId).toBe(quad);
    expect((await moveRow(quad))!.status).toBe("pending");
    // Saved: the moves the rows name are the owner's; the one left behind is never used.
    expect((await call("POST", `/batches/${batchId}/save`)).body).toEqual({ moves: 3, links: 4 });
    expect((await moveRow(again))!.status).toBe("active");
    expect((await moveRow(neck))!.status).toBe("pending");
    expect((await library("/personal")).body.moves.map((m: { record: { id: string } }) => m.record.id)).not.toContain(neck);
  });

  it("Not this move is 409 when the post's reading has no move at that position", async () => {
    const { b } = await seed();
    await db.update(savedPosts).set({ extraction: extraction([move("Zorbex quad shuffles")]) }).where(eq(savedPosts.id, b));
    const res = await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/rematch`, { to: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_reading");
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("'Same as' another personal move merges it", async () => {
    const { b, neck } = await seed();
    const lantern = await ownMove("Lantern reach", "active");
    const res = await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/rematch`, { to: lantern });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await linkAt(b, 1)).toMatchObject({ moveId: lantern, moveKind: "personal" });
    expect(await moveRow(neck)).toMatchObject({ status: "merged", mergedInto: lantern });
    // The account's library reads the merged id as its target.
    const lib = await library("/personal");
    expect(lib.body.merged).toEqual([{ id: neck, into: lantern }]);
  });

  it("'Same as' on a shared new move leaves the move pending while another row still names it", async () => {
    const { a, b, quad } = await seed();
    expect((await call("POST", `/post-moves/${(await linkAt(a, 0)).id}/rematch`, { to: "gobletSquat" })).status).toBe(200);
    // No merge: the session, the restore guard, the link, its write.
    expect(statements.length).toBe(4);
    expect((await linkAt(a, 0)).moveId).toBe("gobletSquat");
    expect((await linkAt(b, 0)).moveId).toBe(quad);
    expect(await moveRow(quad)).toMatchObject({ status: "pending", mergedInto: null });
  });

  it("the target is a library move or an active move of the account's: anything else is 404; the same move is 409", async () => {
    const { a, b, quad } = await seed();
    const link = (await linkAt(b, 1)).id;
    const archived = await ownMove("Windmill switch", "archived");
    const theirs = await ownMove("Prone Y raise", "active", (await makeTestUser(db)).userId);
    for (const to of ["notAMove", quad, archived, theirs, "myNotAMove000000"]) {
      const res = await call("POST", `/post-moves/${link}/rematch`, { to });
      expect(res.status, to).toBe(404);
      expect(statements.filter(isWrite), to).toEqual([]);
    }
    // The move the row already names.
    expect((await call("POST", `/post-moves/${(await linkAt(a, 1)).id}/rematch`, { to: HIP_SWITCH.id })).status).toBe(409);
    expect((await call("POST", `/post-moves/${link}/rematch`, { to: 3 })).status).toBe(422);
    expect((await call("POST", `/post-moves/nope/rematch`, { to: null })).status).toBe(404);
  });

  it("a saved or removed row is 409", async () => {
    const { batchId, a, b } = await seed();
    const removed = (await linkAt(b, 1)).id;
    expect((await call("POST", `/post-moves/${removed}/remove`)).status).toBe(200);
    expect((await call("POST", `/post-moves/${removed}/rematch`, { to: "gobletSquat" })).status).toBe(409);
    expect((await call("POST", `/batches/${batchId}/save`)).status).toBe(200);
    const saved = (await linkAt(a, 1)).id;
    expect((await call("POST", `/post-moves/${saved}/rematch`, { to: "gobletSquat" })).status).toBe(409);
    expect((await call("POST", `/post-moves/${saved}/rematch`, { to: null })).status).toBe(409);
    expect((await call("POST", `/post-moves/${saved}/remove`)).status).toBe(409);
  });
});

// ── Remove, save ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("remove and save", () => {
  it("Remove excludes the row from save; Save writes links for the remaining rows only", async () => {
    const { batchId, a, b, quad, neck } = await seed();
    const gone = (await linkAt(b, 1)).id;
    const res = await call("POST", `/post-moves/${gone}/remove`);
    expect(res.status).toBe(200);
    // The session, the restore guard, the write.
    expect(statements.length).toBe(3);
    expect((await linkAt(b, 1)).status).toBe("removed");
    expect((await call("POST", `/post-moves/${gone}/remove`)).status).toBe(409);
    // Refused: the write matched nothing, then the row is read to say why.
    expect(statements.length).toBe(4);
    // "Not this move" on the library row: its own new move.
    expect((await call("POST", `/post-moves/${(await linkAt(a, 1)).id}/rematch`, { to: null })).status).toBe(200);
    const own = (await linkAt(a, 1)).moveId;

    const saved = await call("POST", `/batches/${batchId}/save`);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ moves: 2, links: 3 });
    const prov = await db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId));
    expect(prov.map((p) => [p.exerciseId, p.url]).sort()).toEqual(
      [
        [quad, "https://example.com/p/a"],
        [own, "https://example.com/p/a"],
        [quad, "https://example.com/p/b"],
      ].sort(),
    );
    expect((await moveRow(quad))!.status).toBe("active");
    expect((await moveRow(own))!.status).toBe("active");
    // The removed row's move is never used.
    expect((await moveRow(neck))!.status).toBe("pending");
    expect((await linkAt(b, 1)).status).toBe("removed");
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: NOW });
    const mine = (await library("/personal")).body.moves.map((m: { record: { id: string } }) => m.record.id);
    expect(mine.sort()).toEqual([quad, own].sort());
  });

  it("Save is set-based: a 600-row batch takes the statements a 4-row one does", async () => {
    const { batchId } = await seed();
    const small = await call("POST", `/batches/${batchId}/save`);
    expect(small.status).toBe(200);
    const few = statements.length;
    // The session, the restore guard, the batch and its counts, one transaction of 4.
    expect(few).toBe(7);

    const big = "batch-600";
    await db.insert(saveBatches).values({ id: big, userId, status: "released", createdAt: T0, releasedAt: T0 });
    const posts = Array.from({ length: 60 }, (_, i) => ({
      id: `p600-${i}`, userId, source: SRC, sourceKey: `k600-${i}`, url: `https://example.com/p/600-${i}`, creatorHandle: "coach_big",
      firstSeenAt: T0, status: "matched", batchId: big, updatedAt: T0,
    }));
    // Every column is bound (14 a row): 5 rows an insert stays under the cap.
    for (let i = 0; i < posts.length; i += 5) await db.insert(savedPosts).values(posts.slice(i, i + 5));
    const links = Array.from({ length: 600 }, (_, i) => ({
      id: `l600-${i}`, userId, postId: `p600-${Math.floor(i / 10)}`, position: i % 10, moveId: EXERCISES[i % 50]!.id, moveKind: "library" as const,
      batchId: big, confidence: 1, checkFlag: false, status: "pending" as const, createdAt: T0,
    }));
    for (const chunk of insertBatches(links)) await db.insert(savedPostMoves).values(chunk);
    const large = await call("POST", `/batches/${big}/save`);
    expect(large.body).toEqual({ moves: 0, links: 600 });
    expect(statements.length).toBe(few);
  });

  it("Another user's batch is 404 — read, save, release, and their rows and moves too", async () => {
    const other = (await makeTestUser(db)).userId;
    const theirs = await seed(other);
    const link = (await linkAt(theirs.b, 1)).id;
    for (const [method, path, body] of [
      ["GET", `/batches/${theirs.batchId}`],
      ["POST", `/batches/${theirs.batchId}/save`],
      ["POST", `/batches/${theirs.batchId}/release`],
      ["POST", `/post-moves/${link}/remove`],
      ["POST", `/post-moves/${link}/rematch`, { to: "gobletSquat" }],
      ["POST", `/post-moves/${link}/rematch`, { to: null }],
      ["PUT", `/moves/${theirs.neck}`, { name: "Mine now" }],
    ] as Array<[string, string, unknown?]>) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      // Remove is one conditional write, of the account's own pending row: here it matches none (the rows below).
      if (!path.endsWith("/remove")) expect(statements.filter(isWrite), `${method} ${path}`).toEqual([]);
    }
    expect((await batchRow(theirs.batchId)).status).toBe("released");
    expect((await linkAt(theirs.b, 1))).toMatchObject({ status: "pending", moveId: theirs.neck });
    expect((await moveRow(theirs.neck))).toMatchObject({ status: "pending", editedByOwner: false });
  });
});

// ── The bootstrap: a held batch, then its release ────────────────────────────────────────────────────────────────────

describe("POST /batches and /batches/:id/release", () => {
  it("makes a held batch of the posts' unbatched moves; release words its notice; a second release is 409", async () => {
    const c = await matched("c", [move("Zorbex hip circle"), move("90/90 Hip Switch")]);
    const d = await matched("d", [move("Zorbex neck nod", { regions: ["neck"] })]);
    const e = await matched("e", [move("Zorbex calf rock", { regions: ["calves"] })]);
    const made = await call("POST", "/batches", { theme: "Hips and neck", postIds: [c, d] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // The session, the restore guard, the waiting rows, one transaction of 6, the batch with its counts.
    expect(statements.length).toBe(10);
    const id = made.body.batch.id as string;
    expect(made.body.batch).toMatchObject({ status: "held", theme: "Hips and neck", notice: null, releasedAt: null, counts: { new: 2, linked: 1, removed: 0 } });
    expect((await linkAt(c, 0)).batchId).toBe(id);
    expect((await linkAt(c, 1)).batchId).toBe(id);
    expect((await linkAt(d, 0)).batchId).toBe(id);
    expect((await linkAt(e, 0)).batchId).toBeNull();
    expect((await moveRow((await linkAt(d, 0)).moveId))!.batchId).toBe(id);
    expect((await db.select().from(savedPosts).where(eq(savedPosts.id, c)))[0]!.batchId).toBe(id);
    expect((await call("GET", "/batches")).body.batches).toEqual([]);
    expect((await call("GET", "/batches?held=1")).body.batches.map((b: { id: string }) => b.id)).toEqual([id]);

    const released = await call("POST", `/batches/${id}/release`);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    // The session, the restore guard, the batch with its moves, the write.
    expect(statements.length).toBe(4);
    expect(released.body.batch).toMatchObject({ id, status: "released", releasedAt: NOW, notice: "From your saves: 2 new moves (1 hip, 1 neck), 1 you already had." });
    expect(await batchRow(id)).toMatchObject({ status: "released", releasedAt: NOW, notice: released.body.batch.notice });
    expect((await call("POST", `/batches/${id}/release`)).status).toBe(409);
    expect((await call("POST", "/batches/nope/release")).status).toBe(404);
  });

  it("gathers the posts' moves out of the held batch a check made (hold mode), and drops a held batch left empty", async () => {
    const hold = { ...matchEnv, SAVES_HOLD_BATCHES: "1" } as Env;
    const c = await matched("c", [move("Zorbex hip circle"), move("90/90 Hip Switch")]);
    const d = await matched("d", [move("Zorbex neck nod", { regions: ["neck"] })]);
    const e = await matched("e", [move("Zorbex calf rock", { regions: ["calves"] })]);
    const held = (await assembleBatch(db, hold, userId, at(1)))!;
    expect((await batchRow(held)).status).toBe("held");
    expect((await linkAt(c, 0)).batchId).toBe(held);

    const made = await call("POST", "/batches", { theme: "Hips and neck", postIds: [c, d] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // The session, the restore guard, the waiting rows, one transaction of 6, the batch with its counts.
    expect(statements.length).toBe(10);
    const id = made.body.batch.id as string;
    expect(made.body.batch).toMatchObject({ status: "held", theme: "Hips and neck", counts: { new: 2, linked: 1, removed: 0 } });
    for (const [post, position] of [[c, 0], [c, 1], [d, 0]] as const) expect((await linkAt(post, position)).batchId).toBe(id);
    expect((await moveRow((await linkAt(c, 0)).moveId))!.batchId).toBe(id);
    expect((await moveRow((await linkAt(d, 0)).moveId))!.batchId).toBe(id);
    expect((await db.select().from(savedPosts).where(eq(savedPosts.id, d)))[0]!.batchId).toBe(id);
    // The check's held batch keeps the third post.
    expect((await linkAt(e, 0)).batchId).toBe(held);
    expect((await moveRow((await linkAt(e, 0)).moveId))!.batchId).toBe(held);
    expect((await batchRow(held)).status).toBe("held");

    // The last post out: the check's held batch is left with nothing, and goes.
    const last = await call("POST", "/batches", { theme: "Calves", postIds: [e] });
    expect(last.status).toBe(201);
    expect((await linkAt(e, 0)).batchId).toBe(last.body.batch.id);
    expect((await db.select().from(saveBatches).where(eq(saveBatches.id, held)))).toEqual([]);
    expect((await call("GET", "/batches?held=1")).body.batches.map((b: { id: string }) => b.id).sort()).toEqual([id, last.body.batch.id].sort());
  });

  it("never takes rows out of a released batch: a batch of those posts is 409, and nothing is written", async () => {
    const { a } = await seed();
    const res = await call("POST", "/batches", { theme: null, postIds: [a, "nope"] });
    expect(res.status).toBe(409);
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await call("POST", "/batches", { theme: null, postIds: [] })).status).toBe(422);
    // At most 100 posts a batch (the bootstrap's are 20–60).
    const many = Array.from({ length: 101 }, (_, i) => `post-${i}`);
    expect((await call("POST", "/batches", { theme: null, postIds: many })).status).toBe(422);
    expect((await call("POST", "/batches", { theme: null, postIds: many.slice(0, 100) })).status).toBe(409);
  });

  it("a release within 20 h of the last is 409 too_soon, and the batch stays held", async () => {
    await db.insert(saveBatches).values({ id: "recent", userId, status: "released", createdAt: at(0), releasedAt: new Date(Date.parse(NOW) - 2 * 3_600_000).toISOString() });
    const c = await matched("c", [move("Zorbex hip circle")]);
    const id = (await call("POST", "/batches", { theme: null, postIds: [c] })).body.batch.id as string;
    const res = await call("POST", `/batches/${id}/release`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "too_soon" });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await batchRow(id)).toMatchObject({ status: "held", releasedAt: null, notice: null });
  });
});

// ── The account's merged moves, for the device ──────────────────────────────────────────────────────────────────────

describe("GET /api/library/personal: merged moves", () => {
  it("lists each merged move with its final target, a public move's too — and none for an account without", async () => {
    expect((await library("/personal")).body).toEqual({ moves: [], merged: [] });
    const { b, neck } = await seed();
    expect((await call("POST", `/post-moves/${(await linkAt(b, 1)).id}/rematch`, { to: "gobletSquat" })).status).toBe(200);
    forgetAccountLibrary(db, userId);
    const res = await library("/personal");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moves: [], merged: [{ id: neck, into: "gobletSquat" }] });
    // The session, the library: no active or archived move, so no links to read.
    expect(statements.length).toBe(2);
  });
});

