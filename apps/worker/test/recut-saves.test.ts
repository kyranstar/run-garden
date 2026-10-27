/**
 * The re-cut script (saves-flow redesign, Task 15): its SQL dissolves held batches only, and the assembler then cuts them
 * afresh. Synthetic ids and moves only; the script itself prints SQL and is run by the lead, never here.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { PROFILES } from "@rg/exercise-library";
import { personalMoveId, type Extraction, type ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { assembleBatch } from "../src/services/saves-batches.js";
import { BATCH_ID_RE, checkStatements, recutStatements } from "../scripts/recut-saves-lib.mjs";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, saveBatches } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HELD = "aaaaaaaa-0000-4000-8000-000000000001";
const RELEASED = "bbbbbbbb-0000-4000-8000-000000000002";
const FITTED = "cccccccc-0000-4000-8000-000000000003";

let db: Db;
let userId: string;

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

async function matched(key: string, moves: ExtractedMove[], now: string) {
  const id = await savedPostId(userId, SRC, key);
  await db.insert(savedPosts).values({
    id, userId, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: "someone",
    firstSeenAt: now, status: "extracted", extraction: extraction(moves), extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, env(), userId, id, now, noFetch);
  return id;
}
const batchRow = (id: string, status: "held" | "released" | "saved", over: Record<string, unknown> = {}) =>
  db.insert(saveBatches).values({ id, userId, status, createdAt: T0, ...over });
const run = async (statements: string[]) => {
  for (const s of statements) await db.run(sql.raw(s));
};
const postBatches = async () => Object.fromEntries((await db.select().from(savedPosts)).map((p) => [p.sourceKey, p.batchId]));
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi"];

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db));
});

describe("recutStatements", () => {
  it("dissolves only held batches: their pending moves, links and posts unbatched, the batches superseded; a released or fitted batch named by mistake untouched", async () => {
    await batchRow(HELD, "held");
    await batchRow(RELEASED, "released", { releasedAt: T0 });
    await batchRow(FITTED, "saved", { releasedAt: T0, savedAt: T0, fittedAt: T0 });
    const batches = [HELD, RELEASED, FITTED];
    const posts = [await matched("h", [move("Zorbex held move")], at(0)), await matched("r", [move("Zorbex released move", { regions: ["neck"] })], at(1)), await matched("f", [move("Zorbex fitted move", { regions: ["calves"] })], at(2))];
    for (const [i, b] of batches.entries()) {
      await db.update(savedPosts).set({ batchId: b }).where(eq(savedPosts.id, posts[i]!));
      await db.update(savedPostMoves).set({ batchId: b }).where(eq(savedPostMoves.postId, posts[i]!));
    }
    const mine = (await db.select().from(personalMoves)).map((m) => m.id);
    for (const [i, id] of mine.entries()) await db.update(personalMoves).set({ batchId: batches[i]! }).where(eq(personalMoves.id, id));
    // An active move kept in a held batch stays: only the pending ones are unbatched.
    const keep = personalMoveId("Zorbex kept", `${userId}:kept`);
    await db.insert(personalMoves).values({
      id: keep, userId, status: "active", mergedInto: null, batchId: HELD, record: toPersonalRecord(keep, move("Zorbex kept")),
      editedByOwner: false, createdAt: T0, updatedAt: T0,
    });

    await run(recutStatements(batches));

    expect((await db.select().from(saveBatches)).map((b) => [b.id, b.status]).sort()).toEqual([[HELD, "superseded"], [RELEASED, "released"], [FITTED, "saved"]]);
    expect(await postBatches()).toEqual({ h: null, r: RELEASED, f: FITTED });
    const links = Object.fromEntries((await db.select().from(savedPostMoves)).map((l) => [l.postId, l.batchId]));
    expect(links).toEqual({ [posts[0]!]: null, [posts[1]!]: RELEASED, [posts[2]!]: FITTED });
    const moves = await db.select().from(personalMoves);
    expect(moves.filter((m) => m.status === "pending").map((m) => m.batchId).sort()).toEqual([FITTED, RELEASED, null].sort());
    expect(moves.find((m) => m.id === keep)!.batchId).toBe(HELD);
  });

  it("after the re-cut, assembleBatch cuts at most 12 new moves, oldest post first, and flags near-duplicates in the pool", async () => {
    await matched("p0", [move("Zorbex rotational swing")], at(0));
    await matched("p1", [move("Zorbex dynamic rotational swing")], at(1));
    for (const [i, w] of GREEK.slice(0, 10).entries()) await matched(`g${i}`, [move(`Zorbex ${w}`)], at(2 + i));
    for (const [i, w] of GREEK.slice(10, 13).entries()) await matched(`late${i}`, [move(`Zorbex ${w}`)], at(20 + i));
    const held = (await assembleBatch(db, env({ SAVES_HOLD_BATCHES: "1" }), userId, at(30)))!;
    expect((await db.select().from(saveBatches).where(eq(saveBatches.id, held)))[0]!.status).toBe("held");

    await run(recutStatements([held]));
    expect(await postBatches()).toEqual(Object.fromEntries((await db.select().from(savedPosts)).map((p) => [p.sourceKey, null])));

    const fresh = (await assembleBatch(db, env(), userId, at(32)))!;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(held);
    const batched = (await db.select().from(personalMoves)).filter((m) => m.batchId === fresh);
    expect(batched).toHaveLength(12);
    const stamped = await postBatches();
    expect(stamped.p0).toBe(fresh);
    expect(stamped.p1).toBe(fresh);
    expect(stamped.late2).toBeNull();
    const flagged = (await db.select().from(savedPostMoves)).filter((l) => l.checkFlag);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.postId).toBe(await savedPostId(userId, SRC, "p1"));
  });

  it("an id outside BATCH_ID_RE, or none, is refused before any SQL is made", () => {
    expect(BATCH_ID_RE.test(HELD)).toBe(true);
    for (const bad of ["x", "1'; DROP TABLE saved_posts; --", "ABCDEF12", "abc def12", ""]) {
      expect(() => recutStatements([bad])).toThrow();
      expect(() => checkStatements([bad])).toThrow();
    }
    expect(() => recutStatements([HELD, "bad"])).toThrow();
    expect(() => recutStatements([])).toThrow();
    expect(() => checkStatements([])).toThrow();
  });
});

describe("recut-saves-batches.mjs", () => {
  const SCRIPT = join(__dirname, "..", "scripts", "recut-saves-batches.mjs");
  type Main = (argv: string[], o: { log: (m: string) => void }) => number;
  const cli = async () => ((await import(pathToFileURL(SCRIPT).href)) as { main: Main }).main;

  it("--dry-run prints only SELECTs; without it, the four UPDATEs in order", async () => {
    const main = await cli();
    const out: string[] = [];
    expect(main(["--batch", HELD, "--batch", RELEASED, "--dry-run"], { log: (m) => out.push(m) })).toBe(0);
    const dry = out.join("\n").split(";\n");
    expect(dry).toHaveLength(4);
    expect(dry.every((s) => /^SELECT count\(\*\)/.test(s))).toBe(true);
    expect(out.join("\n")).not.toMatch(/UPDATE|DELETE|INSERT/);
    expect(out.join("\n")).toContain(`'${RELEASED}'`);

    const live: string[] = [];
    expect(main(["--batch", HELD], { log: (m) => live.push(m) })).toBe(0);
    const stmts = live.join("\n").split(";\n");
    expect(stmts.map((s) => s.split(" SET ")[0])).toEqual(["UPDATE personal_moves", "UPDATE saved_post_moves", "UPDATE saved_posts", "UPDATE save_batches"]);
    expect(stmts).toEqual(recutStatements([HELD]));
  });

  it("refuses a bad or missing id with exit 2 and prints no SQL", async () => {
    const main = await cli();
    const out: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--batch", "nope"], { log: (m) => out.push(m) })).toBe(2);
    expect(main([], { log: (m) => out.push(m) })).toBe(2);
    expect(out).toEqual([]);
    err.mockRestore();
  });
});
