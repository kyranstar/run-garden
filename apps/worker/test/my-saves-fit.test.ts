/**
 * The owner's one path through a batch (the saves flow redesigned, 2026-10-26; spec §3.2, §4, §12.1, §12.3):
 * `GET /open` (the open batch the card and the chip are about — the next one cut when none is open and new moves wait),
 * `POST /batches/:id/fit` (Save with the owner's choices, and the fit started), `/dismiss` ("not now": nothing is saved)
 * and `/fit/cancel` (a run that could not start). Another account's batch is 404 everywhere. Every route's statements
 * are pinned (Workers Free: ≤45 a request). Synthetic data only (example.com, made-up names).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { FIT_SAVES_REQUEST, personalMoveId, type Extraction, type ExtractedMove } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch, FIT_STARTED_TTL_MS } from "../src/services/saves-batches.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, saveBatches, coachMemory, exerciseProvenance } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const NOW = "2026-10-24T12:00:00.000Z";
const LATER = "2026-10-24T13:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;
const CARD_LINE = "Two new moves came in from your saves: 1 hip and 1 neck. Want me to fit them into the week, or choose first?";

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
  evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high", ...over,
});
const extraction = (key: string, moves: ExtractedMove[]): Extraction => ({
  kind: "routine", summary: "s", themes: [], moves, insights: [`Zorbex ${key} work goes best before a run.`],
});

const matchEnv = { FIXTURE_MODE: "1" } as unknown as Env;
const env = { SAVES_IMPORT: "1" } as unknown as Env;
const noFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

/** An extracted post (with one insight), matched (fixture mode: no judge); its id. */
async function matched(key: string, moves: ExtractedMove[], owner = userId, now = T0): Promise<string> {
  const id = await savedPostId(owner, SRC, key);
  await db.insert(savedPosts).values({
    id, userId: owner, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: `coach_${key}`,
    firstSeenAt: now, status: "extracted", extraction: extraction(key, moves), extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, matchEnv, owner, id, now, noFetch);
  return id;
}

const linkAt = async (postId: string, position: number) =>
  (await db.select().from(savedPostMoves).where(and(eq(savedPostMoves.postId, postId), eq(savedPostMoves.position, position))))[0]!;
const moveRow = async (id: string) => (await db.select().from(personalMoves).where(eq(personalMoves.id, id)))[0]!;
const batchRow = async (id: string) => (await db.select().from(saveBatches).where(eq(saveBatches.id, id)))[0]!;
const memory = async (owner = userId) => db.select().from(coachMemory).where(eq(coachMemory.userId, owner));

interface Seeded {
  batchId: string;
  p1: string;
  p2: string;
  p3?: string;
  /** p1's new move, "Zorbex hip circle" (hip). */
  a: string;
  /** p2's new move, "Zorbex neck nod" (neck). */
  b: string;
  /** p3's new move, "Zorbex calf rock" (leg), with `third`. */
  c?: string;
}

/**
 * One released batch: p1 = [Zorbex hip circle (new), 90/90 Hip Switch (the library's)], p2 = [Zorbex neck nod (new)] —
 * two new moves and one the owner had, three links; with `third`, p3 = [Zorbex calf rock (new)] too.
 */
async function seed(opts: { owner?: string; third?: boolean } = {}): Promise<Seeded> {
  const owner = opts.owner ?? userId;
  const p1 = await matched("p1", [move("Zorbex hip circle"), move("90/90 Hip Switch")], owner, at(0));
  const p2 = await matched("p2", [move("Zorbex neck nod", { regions: ["neck"] })], owner, at(0.5));
  const p3 = opts.third ? await matched("p3", [move("Zorbex calf rock", { regions: ["calves"] })], owner, at(0.7)) : undefined;
  const batchId = (await assembleBatch(db, matchEnv, owner, at(1)))!;
  const a = (await linkAt(p1, 0)).moveId;
  const b = (await linkAt(p2, 0)).moveId;
  const c = p3 ? (await linkAt(p3, 0)).moveId : undefined;
  return { batchId, p1, p2, p3, a, b, c };
}

/** One of the account's own moves, stored as the import stores one; its id. */
async function ownMove(name: string, status: "active" | "pending", owner = userId): Promise<string> {
  const id = personalMoveId(name, `${owner}:${name}`);
  await db.insert(personalMoves).values({
    id, userId: owner, status, mergedInto: null, batchId: null, record: toPersonalRecord(id, move(name)), editedByOwner: false, createdAt: T0, updatedAt: T0,
  });
  return id;
}

interface Reply {
  status: number;
  body: any;
  cache: string | null;
}
async function call(method: string, path: string, body?: unknown, opts: { as?: string; env?: Env } = {}): Promise<Reply> {
  const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
  statements.length = 0;
  const res = await app.request(
    `/api/my-saves${path}`,
    {
      method,
      headers: { Cookie: opts.as ?? cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    opts.env ?? env,
  );
  return { status: res.status, body: await res.json(), cache: res.headers.get("Cache-Control") };
}
const fit = (batchId: string, choices: Record<string, string> = {}, as?: string) => call("POST", `/batches/${batchId}/fit`, { choices }, { as });
const writes = () => statements.filter(isWrite);

/** Another account, signed in: its id and cookie. */
async function otherAccount(): Promise<{ id: string; cookie: string }> {
  const { userId: id } = await makeTestUser(db);
  return { id, cookie: `${SESSION_COOKIE}=${await createSession(db, id, "test")}` };
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

// ── GET /open ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /open", () => {
  it("GET /open: none is { open: null } — 2 statements in all (the sign-in 1, the read 1)", async () => {
    const res = await call("GET", "/open");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: null });
    expect(res.cache).toBe("no-store");
    // The session, the read (saves-flow redesign: the open batch and what waits, one statement).
    expect(statements.length).toBe(2);
    expect(writes()).toEqual([]);
  });

  it("GET /open: the open batch — its id, counts, groups and the card's line, word for word; not fitting", async () => {
    const { batchId } = await seed();
    const res = await call("GET", "/open");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the read: an open batch answers in the one statement.
    expect(statements.length).toBe(2);
    expect(writes()).toEqual([]);
    expect(res.body).toEqual({
      open: {
        id: batchId,
        counts: { new: 2, linked: 1 },
        groups: [
          { group: "hip", count: 1 },
          { group: "neck", count: 1 },
        ],
        line: CARD_LINE,
        fitting: false,
      },
    });
    // Fitted in, it is open no more.
    await db.update(saveBatches).set({ status: "saved", fittedAt: at(5) }).where(eq(saveBatches.id, batchId));
    expect((await call("GET", "/open")).body).toEqual({ open: null });
  });

  it("GET /open: nothing open and new moves waiting — it assembles the next batch and answers it; never under SAVES_HOLD_BATCHES=1", async () => {
    // A post of only a move the owner has waits for a new one: nothing to cut, the read alone.
    await matched("p0", [move("90/90 Hip Switch")], userId, at(0));
    expect((await call("GET", "/open")).body).toEqual({ open: null });
    expect(statements.length).toBe(2);
    expect(writes()).toEqual([]);

    await matched("p1", [move("Zorbex hip circle")], userId, at(0.2));
    await matched("p2", [move("Zorbex neck nod", { regions: ["neck"] })], userId, at(0.5));
    const held = await call("GET", "/open", undefined, { env: { ...env, SAVES_HOLD_BATCHES: "1" } as Env });
    expect(held.body).toEqual({ open: null });
    // The session, the read: nothing is cut while batches are held (the bootstrap's curation).
    expect(statements.length).toBe(2);
    expect(await db.select().from(saveBatches)).toEqual([]);

    const res = await call("GET", "/open");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session, the read, the cut (gate 1, waiting 1, personal moves 1, the batch and its stamps 4), the read again
    // (saves-flow redesign).
    expect(statements.length).toBe(10);
    const all = await db.select().from(saveBatches);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "released", releasedAt: NOW });
    expect(res.body.open).toEqual({ id: all[0]!.id, counts: { new: 2, linked: 1 }, groups: expect.any(Array), line: CARD_LINE, fitting: false });
    // Open now: the next read cuts nothing.
    expect((await call("GET", "/open")).body.open.id).toBe(all[0]!.id);
    expect(statements.length).toBe(2);
  });
});

// ── POST /batches/:id/fit ────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /batches/:id/fit", () => {
  it("POST /fit with no choices saves the batch and starts the fit, within the save route's statements + 2", async () => {
    // The save route's own count, measured on another account's twin batch.
    const other = await otherAccount();
    const twin = await seed({ owner: other.id });
    const saved = await call("POST", `/batches/${twin.batchId}/save`, undefined, { as: other.cookie });
    expect(saved.body).toEqual({ moves: 2, links: 3 });
    const saveStatements = statements.length;
    expect(saveStatements).toBe(8);

    const { batchId, p1, p2, a, b } = await seed();
    const res = await fit(batchId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ batchId, request: FIT_SAVES_REQUEST, moves: 2, links: 3 });
    // The save route's 8 (the session, the restore guard, the batch and its counts, one transaction of 5) + 2 (saves-flow
    // redesign): the fit's read (the batch, and whether another is open) and the choices, inside the save's transaction.
    expect(statements.length).toBe(saveStatements + 2);
    expect(statements.length).toBe(10);
    for (const id of [a, b]) expect(await moveRow(id)).toMatchObject({ status: "active", batchId, fitChoice: null });
    for (const [post, position] of [[p1, 0], [p1, 1], [p2, 0]] as const) expect((await linkAt(post, position)).status).toBe("saved");
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: NOW, fitStartedAt: NOW, dismissedAt: null, fittedAt: null });
    // Save's own writes: the provenance of each kept link, and the posts' insights in the coach's memory (spec §17).
    expect(await db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId))).toHaveLength(3);
    expect((await memory()).map((m) => m.body).sort()).toEqual(["Zorbex p1 work goes best before a run.", "Zorbex p2 work goes best before a run."]);

    const open = await call("GET", "/open");
    expect(open.body.open).toMatchObject({ id: batchId, fitting: true, line: CARD_LINE });
  });

  it("a second POST /fit while fitting is 409 fitting; past FIT_STARTED_TTL_MS it fits again", async () => {
    const { batchId } = await seed();
    expect((await fit(batchId)).status).toBe(200);
    const second = await fit(batchId);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "fitting" });
    // The session, the restore guard, the fit's read: nothing written.
    expect(statements.length).toBe(3);
    expect(writes()).toEqual([]);
    // A millisecond short of the hour: still at work.
    vi.setSystemTime(new Date(Date.parse(NOW) + FIT_STARTED_TTL_MS - 1));
    expect((await fit(batchId)).body).toEqual({ error: "fitting" });
    // The hour is up: the card offers Fit them in again, and it fits.
    const later = new Date(Date.parse(NOW) + FIT_STARTED_TTL_MS).toISOString();
    vi.setSystemTime(new Date(later));
    const again = await fit(batchId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ batchId, request: FIT_SAVES_REQUEST, moves: 2, links: 3 });
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: NOW, fitStartedAt: later });
  });

  it("choices are stored per new move; a re-fit after a decline rewrites them", async () => {
    const { batchId, a, b } = await seed();
    expect((await fit(batchId, { [a]: "include", [b]: "skip" })).status).toBe(200);
    expect(await moveRow(a)).toMatchObject({ status: "active", fitChoice: "include" });
    expect(await moveRow(b)).toMatchObject({ status: "active", fitChoice: "skip" });
    const remembered = (await memory()).length;

    // The fit's card was declined (its fit_started_at cleared): the card offers Fit them in again.
    await db.update(saveBatches).set({ fitStartedAt: null }).where(eq(saveBatches.id, batchId));
    vi.setSystemTime(new Date(LATER));
    const again = await fit(batchId, { [a]: "skip" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ batchId, request: FIT_SAVES_REQUEST, moves: 2, links: 3 });
    // The session, the restore guard, the fit's read (with what the saved batch holds), one transaction of 2: the
    // choices, the fit's start (saves-flow redesign).
    expect(statements.length).toBe(5);
    expect(writes()).toHaveLength(2);
    expect(await moveRow(a)).toMatchObject({ fitChoice: "skip" });
    expect(await moveRow(b)).toMatchObject({ fitChoice: null });
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: NOW, fitStartedAt: LATER, dismissedAt: null });
    // Nothing is saved twice: the coach's memory holds what the first fit kept.
    expect(await memory()).toHaveLength(remembered);
  });

  it("choices that name a removed, merged or foreign move change nothing", async () => {
    const other = await otherAccount();
    const theirs = await seed({ owner: other.id });
    expect((await call("POST", `/batches/${theirs.batchId}/save`, undefined, { as: other.cookie })).status).toBe(200);
    const { batchId, p2, p3, a, b, c } = await seed({ third: true });
    // c's row is removed: its move stays pending, never used.
    expect((await call("POST", `/post-moves/${(await linkAt(p3!, 0)).id}/remove`)).status).toBe(200);
    // b carries a choice from before (a stale page on another device); Same as… merges it into a, and the merge clears it.
    await db.update(personalMoves).set({ fitChoice: "skip" }).where(eq(personalMoves.id, b));
    expect((await call("POST", `/post-moves/${(await linkAt(p2, 0)).id}/rematch`, { to: a })).status).toBe(200);
    expect(await moveRow(b)).toMatchObject({ status: "merged", mergedInto: a, fitChoice: null });

    const res = await fit(batchId, { [a]: "include", [b]: "skip", [c!]: "include", [theirs.a]: "skip", myZorbexElsewhere000000: "skip" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ batchId, request: FIT_SAVES_REQUEST, moves: 1, links: 3 });
    expect(await moveRow(a)).toMatchObject({ status: "active", fitChoice: "include" });
    expect(await moveRow(b)).toMatchObject({ status: "merged", fitChoice: null });
    expect(await moveRow(c!)).toMatchObject({ status: "pending", fitChoice: null });
    // No other account's row is touched.
    for (const id of [theirs.a, theirs.b]) expect(await moveRow(id)).toMatchObject({ status: "active", fitChoice: null });
    expect(await db.select().from(personalMoves).where(eq(personalMoves.id, "myZorbexElsewhere000000"))).toEqual([]);
  });

  it("a dismissed batch: POST /fit clears dismissed_at and fits when nothing else is open; 409 batch_open while another batch is open", async () => {
    const { batchId, a } = await seed();
    expect((await call("POST", `/batches/${batchId}/dismiss`)).status).toBe(200);
    // Another post waited; with nothing open, the next read cuts it, and it is the open batch.
    await matched("p9", [move("Zorbex calf rock", { regions: ["calves"] })], userId, at(2));
    const next = (await call("GET", "/open")).body.open.id as string;
    expect(next).not.toBe(batchId);

    const refused = await fit(batchId);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "batch_open" });
    // The session, the restore guard, the fit's read: nothing written.
    expect(statements.length).toBe(3);
    expect(writes()).toEqual([]);
    expect(await batchRow(batchId)).toMatchObject({ status: "released", dismissedAt: NOW, fitStartedAt: null });
    expect((await moveRow(a)).status).toBe("pending");

    // The other one put aside too: the dismissed batch fits, and is the open batch again.
    expect((await call("POST", `/batches/${next}/dismiss`)).status).toBe(200);
    vi.setSystemTime(new Date(LATER));
    const res = await fit(batchId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: LATER, dismissedAt: null, fitStartedAt: LATER });
    expect((await moveRow(a)).status).toBe("active");
    expect((await call("GET", "/open")).body.open).toMatchObject({ id: batchId, fitting: true });
  });

  it("409 already_fitted, 409 not_released (held), 404 for another account's batch, 422 for a body outside fitSchema", async () => {
    const { batchId, a } = await seed();
    await db.insert(saveBatches).values([
      { id: "held-batch", userId, status: "held", createdAt: T0 },
      { id: "superseded-batch", userId, status: "superseded", createdAt: T0 },
    ]);
    for (const [id, error] of [["held-batch", "not_released"], ["superseded-batch", "not_released"]] as const) {
      const res = await fit(id);
      expect(res.status, id).toBe(409);
      expect(res.body, id).toEqual({ error });
      expect(writes(), id).toEqual([]);
    }

    const other = await otherAccount();
    const theirs = await seed({ owner: other.id });
    for (const id of [theirs.batchId, "nope"]) {
      const res = await fit(id, { [theirs.a]: "include" });
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
      expect(writes(), id).toEqual([]);
    }
    expect(await batchRow(theirs.batchId)).toMatchObject({ status: "released", fitStartedAt: null });
    expect((await moveRow(theirs.a)).status).toBe("pending");

    const tooMany = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`myZorbexMove${i}abcdef`, "include"]));
    for (const body of [undefined, {}, { choices: { gobletSquat: "include" } }, { choices: { [a]: "maybe" } }, { choices: {}, extra: 1 }, { choices: tooMany }]) {
      const res = await call("POST", `/batches/${batchId}/fit`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toBe("invalid");
      expect(writes()).toEqual([]);
    }
    expect(await batchRow(batchId)).toMatchObject({ status: "released", fitStartedAt: null });

    expect((await fit(batchId)).status).toBe(200);
    await db.update(saveBatches).set({ fittedAt: at(40), fitStartedAt: null }).where(eq(saveBatches.id, batchId));
    const fitted = await fit(batchId);
    expect(fitted.status).toBe(409);
    expect(fitted.body).toEqual({ error: "already_fitted" });
    expect(writes()).toEqual([]);
  });
});

// ── POST /batches/:id/dismiss, /fit/cancel ───────────────────────────────────────────────────────────────────────────

describe("POST /batches/:id/dismiss and /fit/cancel", () => {
  it("POST /dismiss: dismissed_at set, moves still pending, nothing in the coach's memory; GET /open then opens the next waiting batch; dismissing while fitting is 409 not_open", async () => {
    const { batchId, p1, p2, a, b } = await seed();
    // A later post waits for the next batch.
    await matched("p3", [move("Zorbex calf rock", { regions: ["calves"] })], userId, at(2));
    const res = await call("POST", `/batches/${batchId}/dismiss`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The session, the restore guard, the write.
    expect(statements.length).toBe(3);
    expect(await batchRow(batchId)).toMatchObject({ status: "released", dismissedAt: NOW, savedAt: null, fitStartedAt: null });
    // Never saved: its moves and links stay pending, nothing reaches the library, the provenance or the coach's memory.
    for (const id of [a, b]) expect((await moveRow(id)).status).toBe("pending");
    for (const [post, position] of [[p1, 0], [p1, 1], [p2, 0]] as const) expect((await linkAt(post, position)).status).toBe("pending");
    expect(await memory()).toEqual([]);
    expect(await db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId))).toEqual([]);

    // Dismissed is not open: the next read cuts the waiting post into the next batch.
    const open = await call("GET", "/open");
    const next = open.body.open.id as string;
    expect(next).not.toBe(batchId);
    expect(open.body.open).toMatchObject({ counts: { new: 1, linked: 0 }, groups: [{ group: "leg", count: 1 }], fitting: false });

    // Dismissed already: 409 not_open — the write matched nothing, then the batch is read to say why.
    const again = await call("POST", `/batches/${batchId}/dismiss`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "not_open" });
    expect(statements.length).toBe(4);
    expect(await batchRow(batchId)).toMatchObject({ dismissedAt: NOW });

    // While the next one is fitting: 409 not_open, and it stays open.
    expect((await fit(next)).status).toBe(200);
    const fitting = await call("POST", `/batches/${next}/dismiss`);
    expect(fitting.status).toBe(409);
    expect(fitting.body).toEqual({ error: "not_open" });
    expect(await batchRow(next)).toMatchObject({ dismissedAt: null, fitStartedAt: NOW });
    // A millisecond short of the hour it is still fitting; once the hour is up, it can be put aside (`isFitting`, in SQL).
    vi.setSystemTime(new Date(Date.parse(NOW) + FIT_STARTED_TTL_MS - 1));
    expect((await call("POST", `/batches/${next}/dismiss`)).status).toBe(409);
    const stale = new Date(Date.parse(NOW) + FIT_STARTED_TTL_MS).toISOString();
    vi.setSystemTime(new Date(stale));
    expect((await call("POST", `/batches/${next}/dismiss`)).status).toBe(200);
    expect(await batchRow(next)).toMatchObject({ dismissedAt: stale, status: "saved" });

    // Another account's, or none: 404.
    const other = await otherAccount();
    const theirs = await seed({ owner: other.id });
    for (const id of [theirs.batchId, "nope"]) expect((await call("POST", `/batches/${id}/dismiss`)).status, id).toBe(404);
    expect(await batchRow(theirs.batchId)).toMatchObject({ dismissedAt: null });
  });

  it("fit/cancel clears the fit at once: GET /open says fitting false", async () => {
    const { batchId } = await seed();
    expect((await fit(batchId)).status).toBe(200);
    expect((await call("GET", "/open")).body.open).toMatchObject({ id: batchId, fitting: true });

    // The run could not start (a run already at work, the week's budget, offline).
    const res = await call("POST", `/batches/${batchId}/fit/cancel`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The session, the restore guard, the write.
    expect(statements.length).toBe(3);
    // The save stands; only the fit is cleared.
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", savedAt: NOW, fitStartedAt: null });
    expect((await call("GET", "/open")).body.open).toMatchObject({ id: batchId, fitting: false, line: CARD_LINE });

    // Not fitting, it can be put aside; Fit them in then brings the saved batch back (one transaction of 2).
    expect((await call("POST", `/batches/${batchId}/dismiss`)).status).toBe(200);
    expect((await call("GET", "/open")).body).toEqual({ open: null });
    vi.setSystemTime(new Date(LATER));
    expect((await fit(batchId)).status).toBe(200);
    expect(statements.length).toBe(5);
    expect(await batchRow(batchId)).toMatchObject({ status: "saved", dismissedAt: null, fitStartedAt: LATER });

    // A fitted batch keeps its fit: nothing to cancel.
    await db.update(saveBatches).set({ fittedAt: at(40) }).where(eq(saveBatches.id, batchId));
    expect((await call("POST", `/batches/${batchId}/fit/cancel`)).body).toEqual({ ok: true });
    expect(await batchRow(batchId)).toMatchObject({ fitStartedAt: LATER, fittedAt: at(40) });

    // Another account's, or none: 404 — the write matched nothing, then the batch is read.
    const other = await otherAccount();
    const theirs = await seed({ owner: other.id });
    await db.update(saveBatches).set({ fitStartedAt: NOW }).where(eq(saveBatches.id, theirs.batchId));
    for (const id of [theirs.batchId, "nope"]) {
      const out = await call("POST", `/batches/${id}/fit/cancel`);
      expect(out.status, id).toBe(404);
      expect(statements.length).toBe(4);
    }
    expect(await batchRow(theirs.batchId)).toMatchObject({ fitStartedAt: NOW });
  });
});

// ── The batch detail ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /batches/:id, the fit's fields", () => {
  it("each new row carries its purpose, its choice and the move it looks like; Check this says near_duplicate; the batch says when it was dismissed or fitted, and whether it is fitting — still 3 statements", async () => {
    const hold = await ownMove("Zorbex cobra hold", "active");
    // The owner chose for it in an earlier fit: a linked row never shows it (choices are the new rows').
    await db.update(personalMoves).set({ fitChoice: "include" }).where(eq(personalMoves.id, hold));
    const p1 = await matched("p1", [move("Zorbex cobra chest lift", { purpose: "Opens the chest before a run." }), move("90/90 Hip Switch", { purpose: "Hip mobility." })]);
    const p2 = await matched("p2", [move("Zorbex neck nod", { regions: ["neck"], purpose: "Eases the jaw." }), move("Zorbex cobra hold", { purpose: "Back strength." })], userId, at(0.5));
    const batchId = (await assembleBatch(db, matchEnv, userId, at(1)))!;
    const lift = (await linkAt(p1, 0)).moveId;
    const nod = (await linkAt(p2, 0)).moveId;
    expect((await linkAt(p2, 1)).moveId).toBe(hold);

    const before = await call("GET", `/batches/${batchId}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    // The session, the batch, its rows (no change: the purpose, the like and the choice ride in the rows' read).
    expect(statements.length).toBe(3);
    expect(before.body.batch).toMatchObject({ id: batchId, status: "released", dismissedAt: null, fitStartedAt: null, fitting: false });
    const rows = before.body.rows as any[];
    expect(rows.map((r) => [r.move.id, r.move.kind, r.move.purpose, r.move.choice])).toEqual([
      [lift, "new", "Opens the chest before a run.", null],
      [HIP_SWITCH.id, "linked", "Hip mobility.", null],
      [nod, "new", "Eases the jaw.", null],
      [hold, "linked", "Back strength.", null],
    ]);
    // The cut flagged the chest lift as like the owner's cobra hold: Check this, and why.
    expect(rows[0].move).toMatchObject({ check: true, like: { id: hold, name: "Zorbex cobra hold" } });
    expect(rows[0].move.checkWhy).toContain("near_duplicate");
    for (const r of rows.slice(1)) expect(r.move.like, r.move.id).toBeUndefined();

    expect((await fit(batchId, { [lift]: "skip", [nod]: "include" })).status).toBe(200);
    const after = await call("GET", `/batches/${batchId}`);
    expect(statements.length).toBe(3);
    expect(after.body.batch).toMatchObject({ status: "saved", dismissedAt: null, fitStartedAt: NOW, fitting: true });
    expect((after.body.rows as any[]).map((r) => [r.move.id, r.move.choice])).toEqual([
      [lift, "skip"],
      [HIP_SWITCH.id, null],
      [nod, "include"],
      [hold, null],
    ]);
    expect((await call("GET", "/batches")).body.batches[0]).toMatchObject({ id: batchId, fitStartedAt: NOW, fitting: true, dismissedAt: null });
  });

  it("Same as… settles a flagged row: the link names the move it looked like, its Check this and its like are gone", async () => {
    const hold = await ownMove("Zorbex cobra hold", "active");
    const p1 = await matched("p1", [move("Zorbex cobra chest lift")]);
    const batchId = (await assembleBatch(db, matchEnv, userId, at(1)))!;
    expect(await linkAt(p1, 0)).toMatchObject({ checkFlag: true, likeMoveId: hold });
    expect((await call("POST", `/post-moves/${(await linkAt(p1, 0)).id}/rematch`, { to: hold })).status).toBe(200);
    expect(await linkAt(p1, 0)).toMatchObject({ moveId: hold, checkFlag: false, likeMoveId: null });
    const row = ((await call("GET", `/batches/${batchId}`)).body.rows as any[])[0];
    expect(row.move).toMatchObject({ id: hold, kind: "linked", check: false, choice: null });
    expect(row.move.like).toBeUndefined();
  });
});
