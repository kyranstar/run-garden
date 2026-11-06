/**
 * READ IT AGAIN (design 2026-11-05 §6.6; phase 5a plan Tasks 6–7): an old post's trail offers a re-read under the
 * current prompt, at a cost said before the tap. The tap puts the post back in the queue keeping its reading; the
 * computer's extension finds it on its work list (`/work`) and reads it as any `extract` work. The re-read is lined up
 * with the post's links before it is stored, and never rewrites a move, a link, or an approved correction. Synthetic
 * data: Zorbex names, a made-up creator, the link assembled at runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { markFetchFailed, overridePost, savedPostId, workList } from "../src/services/saves-ledger.js";
import { correctionsReadSql, correctionStateOf, currentValue, judgeCorrection } from "../src/services/import-corrections.js";
import { runAtomicallyClaim } from "../src/services/db.js";
import type { ImportCorrectionOp } from "../src/services/proposal-kinds.js";
import { PROFILES } from "@rg/exercise-library";
import { EXTRACT_PROMPT_VERSION } from "@rg/saves";
import { assembleBatch } from "../src/services/saves-batches.js";
import { EXTRACT_MODEL_DEFAULT, matchStale, relayExtract, typicalReadingMicros } from "../src/services/saves-relay.js";
import { readAgain } from "../src/services/saves-reread.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, importEvents, importCorrections } = schema;
const NOW = "2026-11-06T10:00:00.000Z";
const CAPTURED = "2026-10-24T09:15:00.000Z";
const MODEL = EXTRACT_MODEL_DEFAULT;
const KEY = ["Zx", "Old", "Post2"].join("");
const link = ["ht", "tps://www.", ["insta", "gram.com"].join(""), "/p/", KEY, "/"].join("");
const fixture = { FIXTURE_MODE: "1", SAVES_IMPORT: "1" } as unknown as Env;

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => { statements += 1; } });
  ({ userId } = await makeTestUser(db));
  statements = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

/** The earlier reading as it was kept (extract-4: no quotes, no reasons), its first note dropped by an approved correction. */
const EARLIER = {
  kind: "routine", summary: "Two slow hip moves.", themes: ["mobility"],
  moves: [
    { name: "Zorbex hip lift", aliases: [], dose: { text: "2x30s" }, purpose: "Opens the hips", useWhen: [{ text: "after easy runs", evidence: "stated" }] },
    { name: "Zorbex knee sways", aliases: [], dose: { text: "10 each side" }, purpose: "Loosens the knees" },
  ],
  insights: [{ text: "Old note", scope: "general", dropped: true }, "Second note"],
};
const EDITED = { name: "Zorbex hip lift (mine)", dose: { type: "time", range: [30, 30], sets: [3, 3] } };

/**
 * A typical old Instagram post, read and matched before the trail, its batch saved and fitted in — and since then: the
 * owner edited its first move, the coach corrected that move's dose, its second link ("same as": now the owner's own
 * swing), the reading's use-when, and dropped a note.
 */
async function oldSaved(over: { status?: string; batch?: Partial<typeof saveBatches.$inferInsert>; linkStatus?: "saved" | "pending" } = {}) {
  const id = await savedPostId(userId, "instagram", KEY);
  await db.insert(saveBatches).values({
    id: "batch-old", userId, status: "saved", createdAt: CAPTURED, releasedAt: CAPTURED, savedAt: CAPTURED, fittedAt: CAPTURED, notice: null, ...(over.batch ?? {}),
  });
  await db.insert(savedPosts).values({
    id, userId, source: "instagram", sourceKey: KEY, url: link, creatorHandle: "zorbex.coach", creatorName: "Zorbex Coach",
    caption: "Two slow hip moves for after a run.", hashtags: [], mediaType: "video", firstSeenAt: CAPTURED, status: over.status ?? "matched",
    filterVerdict: "training", filterReason: "a hip routine", filterStage: "model", extraction: EARLIER, batchId: "batch-old",
    extractAttempts: 1, updatedAt: CAPTURED,
  });
  await db.insert(personalMoves).values([
    { id: "myZorbexHipLift0001", userId, status: "active", record: EDITED, editedByOwner: true, batchId: "batch-old", createdAt: CAPTURED, updatedAt: CAPTURED },
    { id: "myZorbexKneeSway002", userId, status: "merged", mergedInto: "myZorbexKneeSwing03", record: { name: "Zorbex knee sway" }, batchId: "batch-old", createdAt: CAPTURED, updatedAt: CAPTURED },
    { id: "myZorbexKneeSwing03", userId, status: "active", record: { name: "Zorbex knee swing" }, createdAt: CAPTURED, updatedAt: CAPTURED },
  ]);
  await db.insert(savedPostMoves).values([
    { id: "lk0", userId, postId: id, position: 0, moveId: "myZorbexHipLift0001", moveKind: "personal", batchId: "batch-old", confidence: 1, status: over.linkStatus ?? "saved", createdAt: CAPTURED },
    { id: "lk1", userId, postId: id, position: 1, moveId: "myZorbexKneeSwing03", moveKind: "personal", batchId: "batch-old", confidence: 1, status: over.linkStatus ?? "saved", createdAt: CAPTURED },
  ]);
  const fix = (n: string, target: "move" | "link" | "reading" | "insight", targetId: string, field: string, before: unknown, after: unknown) => ({
    id: n, userId, target, targetId, field, before, after, why: "the post says so", basis: "evidence" as const, by: "coach" as const, at: CAPTURED,
  });
  await db.insert(importCorrections).values([
    fix("fx1", "move", "myZorbexHipLift0001", "dose", { text: "8-12 reps" }, EDITED.dose),
    fix("fx2", "link", `${id}:1`, "same_as", "myZorbexKneeSway002", "myZorbexKneeSwing03"),
    fix("fx3", "reading", `${id}:0`, "useWhen", null, [{ text: "after easy runs", evidence: "stated" }]),
    fix("fx4", "insight", `${id}:0`, "drop", null, true),
  ]);
  return id;
}
const post = async (id: string) => (await db.select().from(savedPosts).where(eq(savedPosts.id, id)))[0]!;
const linksOf = async (id: string) =>
  (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, id))).map((l) => [l.position, l.moveId, l.status, l.batchId]).sort();

describe("what a reading costs, said before the tap", () => {
  it("a reel: a typical one's words and a minute of video; a video page: its words, and its length when it's watched", () => {
    const reel = typicalReadingMicros(MODEL, { source: "instagram", mediaType: "video", durationSec: null, textChars: 200 });
    const photo = typicalReadingMicros(MODEL, { source: "instagram", mediaType: "image", durationSec: null, textChars: 200 });
    const short = typicalReadingMicros(MODEL, { source: "youtube", mediaType: "video", durationSec: 600, textChars: 20_000 });
    const long = typicalReadingMicros(MODEL, { source: "youtube", mediaType: "video", durationSec: 2_400, textChars: 20_000 });
    expect(reel).toBeGreaterThan(photo);
    expect(short).toBeGreaterThan(long); // a long one is read from its words unless the owner asks
    expect(reel).toBeGreaterThan(0);
  });
});

describe("Read it again: the ask", () => {
  it("puts the post back in the queue keeping its reading, says so on its trail with the cost, and /work hands it out", async () => {
    const id = await oldSaved();
    statements = 0;
    expect(await readAgain(db, userId, id, NOW)).toBe("ok");
    expect(statements).toBeLessThanOrEqual(3); // the post 1, then the event and the post's update in one batch (2)
    expect(await post(id)).toMatchObject({ status: "queued", extraction: EARLIER, extractAttempts: 0, lastErrorCode: null, batchId: "batch-old" });
    expect(await linksOf(id)).toEqual([[0, "myZorbexHipLift0001", "saved", "batch-old"], [1, "myZorbexKneeSwing03", "saved", "batch-old"]]);
    const asked = (await db.select().from(importEvents).where(eq(importEvents.postId, id)))[0]!;
    expect(asked).toMatchObject({ stage: "choice", source: "owner", status: "info", detail: { action: "reread" } });
    expect(asked.summary).toMatch(/^You asked for it to be read again \((about \$0\.\d\d|under \$0\.01)\)$/);
    // The computer's extension picks it up as any reading (old and new extensions alike: an Instagram post).
    expect((await workList(db, userId, NOW)).map((w) => [w.key, w.action])).toEqual([[KEY, "extract"]]);
    expect((await workList(db, userId, NOW, 20, { links: true })).map((w) => [w.key, w.action])).toEqual([[KEY, "extract"]]);
  });

  it("the trail offers it on an old post, with its cost; asked, it waits for the extension", async () => {
    const id = await oldSaved();
    const before = (await readPostTrail(db, userId, id, NOW))!;
    expect(before.post.readAgain).toEqual({
      offer: true, asked: false,
      costMicros: typicalReadingMicros(MODEL, { source: "instagram", mediaType: "video", durationSec: null, textChars: "Two slow hip moves for after a run.".length }),
    });
    await readAgain(db, userId, id, NOW);
    const after = (await readPostTrail(db, userId, id, NOW))!;
    expect(after.post.readAgain).toMatchObject({ offer: false, asked: true });
    expect(after.rebuilt).toBe(true); // still its kept steps until the new reading is in
  });

  it("refused — and not offered — for a post with a reading of its own, one being fitted in, one with moves waiting in an open batch, one the owner skipped or kept as a reference, or filtered out", async () => {
    const cases: [string, () => Promise<string>][] = [
      ["own reading", async () => {
        const id = await oldSaved();
        await db.insert(importEvents).values({ id: "x1", userId, postId: id, stage: "extract", source: "gateway", status: "ok", summary: "Read 2 moves", detail: { kind: "routine", moves: 2 }, at: CAPTURED });
        return id;
      }],
      ["fitting", () => oldSaved({ batch: { fittedAt: null, fitStartedAt: "2026-11-06T09:50:00.000Z" } })],
      ["waiting", () => oldSaved({ batch: { status: "released", savedAt: null, fittedAt: null }, linkStatus: "pending" })],
      // Review I1: a batch put aside ("Not now") still holds the post's moves waiting: they would never reach a batch.
      ["put aside", () => oldSaved({ batch: { status: "released", savedAt: null, fittedAt: null, dismissedAt: CAPTURED }, linkStatus: "pending" })],
      ["skipped", () => oldSaved({ status: "skipped_by_owner" })],
      ["reference", () => oldSaved({ status: "reference_only" })],
      ["filtered", () => oldSaved({ status: "filtered_out" })],
    ];
    for (const [name, make] of cases) {
      for (const t of [importEvents, importCorrections, savedPostMoves, personalMoves, savedPosts, saveBatches]) await db.delete(t);
      const id = await make();
      expect([name, await readAgain(db, userId, id, NOW)]).toEqual([name, "conflict"]);
      expect([name, (await readPostTrail(db, userId, id, NOW))!.post.readAgain?.offer ?? false]).toEqual([name, false]);
      expect([name, (await post(id)).status]).not.toEqual([name, "queued"]);
    }
  });

  it("asked once, a second tap is refused; another account's post isn't found", async () => {
    const id = await oldSaved();
    expect(await readAgain(db, userId, id, NOW)).toBe("ok");
    expect(await readAgain(db, userId, id, NOW)).toBe("conflict");
    expect(await readAgain(db, (await makeTestUser(db)).userId, id, NOW)).toBe("not_found");
  });

  it("the route: 200, 409 when it can't be, 404 for another's", async () => {
    const id = await oldSaved();
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
    const tap = (pid: string) => app.request(`/api/my-saves/posts/${pid}/read-again`, { method: "POST", headers: { Cookie: cookie } }, fixture);
    expect((await tap(id)).status).toBe(200);
    const again = await tap(id);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_readable" });
    expect((await tap("nope")).status).toBe(404);
  });
});

describe("Retry on a post that has links keeps its reading (phase 5a)", () => {
  it("a re-read that failed and is retried still has the reading its links are lined up with", async () => {
    const id = await oldSaved({ status: "failed" });
    await db.update(savedPosts).set({ lastErrorCode: "media_failed" }).where(eq(savedPosts.id, id));
    expect(await overridePost(db, userId, { id }, "process", NOW)).toBe("ok");
    expect(await post(id)).toMatchObject({ status: "queued", extraction: EARLIER });
  });
});

// ── The re-read itself (Task 7) ─────────────────────────────────────────────────────────────────────────────────────

const conditions = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "ok" },
  ]),
);
/** A move as extract-6 reads it, with its reason and a quote. No library name is near it: no judge is asked. */
const full = (name: string, why: string) => ({
  name, aliases: [], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose: `${name} purpose`,
  dose: { text: "10 each side", type: "reps", range: [10, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: ["mat"],
  position: "seated", laterality: "alternating", load: "bodyweight", contraction: ["isotonic"], difficulty: 2, conditions,
  evidence: { name: "stated", dose: "stated", steps: "stated", purpose: "stated" }, confidence: "high", why,
  quotes: [{ field: "why", text: why, from: "caption" }],
});
/** The re-read under extract-6: the moves in another order, and one the earlier reading never had. */
const FRESH = {
  kind: "routine", summary: "Two slow hip moves, then a calf drift.", themes: ["mobility"],
  moves: [full("Zorbex knee sways", "loosens the knees"), full("Zorbex hip lift", "opens the hips"), full("Zorbex quux drift", "calms the calves")],
  insights: [{ text: "A new note", scope: "general" }],
};
const env = { FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "k", AI_GATEWAY_BASE_URL: "https://gw.test/v1" } as unknown as Env;
function gateway(content: unknown, status = 200) {
  const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
    await new Response(init?.body as BodyInit).arrayBuffer();
    if (status !== 200) return new Response("nope", { status });
    return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 20_000, completion_tokens: 900 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, spy: fetchImpl };
}
const extractRequest = () => {
  const text = JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(2_000) }] }] });
  return new Request(`https://app.test/api/saves/posts/${KEY}/extract?source=instagram`, {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(text.length), "x-saves-prompt-version": EXTRACT_PROMPT_VERSION }, body: text,
  });
};
const reread = (id: string, gw: ReturnType<typeof gateway>) => relayExtract(db, env, userId, { id }, extractRequest(), new Date(NOW), gw.fetchImpl);
const snapshot = async () => ({
  moves: await db.select().from(personalMoves).orderBy(personalMoves.id),
  links: await db.select().from(savedPostMoves).orderBy(savedPostMoves.id),
  corrections: await db.select().from(importCorrections).orderBy(importCorrections.id),
});

describe("the re-read never rewrites what the owner has (the proof the controller asked for)", () => {
  it("every move (edited, corrected, merged), every link (corrected) and every approved correction is as it was; the new words sit at their links' places with the reading's correction on top; saved notes kept", async () => {
    const id = await oldSaved();
    const before = await snapshot();
    await readAgain(db, userId, id, NOW);
    const gw = gateway(FRESH);
    expect(await reread(id, gw)).toMatchObject({ ok: true });
    expect(gw.spy).toHaveBeenCalledTimes(1); // the reading only: no judge asked about a move the post already links

    const after = await snapshot();
    // Not one existing row rewritten: the owner's edit and the coach's corrections stand.
    expect(after.corrections).toEqual(before.corrections);
    for (const m of before.moves) expect(after.moves.find((x) => x.id === m.id)).toEqual(m);
    for (const l of before.links) expect(after.links.find((x) => x.id === l.id)).toEqual(l);

    const p = await post(id);
    expect(p.status).toBe("matched");
    const stored = p.extraction as typeof FRESH & { moves: (ReturnType<typeof full> & { useWhen?: unknown })[]; insights: unknown };
    expect(stored.moves.map((m) => m.name)).toEqual(["Zorbex hip lift", "Zorbex knee sways", "Zorbex quux drift"]);
    expect(stored.moves[0]!.why).toBe("opens the hips");
    expect(stored.moves[0]!.useWhen).toEqual([{ text: "after easy runs", evidence: "stated" }]); // the approved correction, again
    expect(stored.insights).toEqual(EARLIER.insights); // the dropped note stays dropped

    // The move the earlier reading never had is linked as new, and waits for the next batch.
    const added = after.links.filter((l) => !before.links.some((b) => b.id === l.id));
    expect(added.map((l) => [l.position, l.status, l.batchId])).toEqual([[2, "pending", null]]);
    expect(after.moves.filter((m) => !before.moves.some((b) => b.id === m.id)).map((m) => [m.id, m.status])).toEqual([[added[0]!.moveId, "pending"]]);
    expect(p.batchId).toBeNull();
    const next = await assembleBatch(db, env, userId, NOW);
    expect(next).not.toBeNull();
    expect((await db.select().from(savedPostMoves).where(eq(savedPostMoves.id, added[0]!.id)))[0]!.batchId).toBe(next);
    expect(await linksOf(id)).toEqual(expect.arrayContaining([[0, "myZorbexHipLift0001", "saved", "batch-old"], [1, "myZorbexKneeSwing03", "saved", "batch-old"]]));
  });

  it("the trail then tells the new reading: its own steps replace the rebuilt reading, the post's history stays, the moves keep their names", async () => {
    const id = await oldSaved();
    await readAgain(db, userId, id, NOW);
    await reread(id, gateway(FRESH));
    const trail = (await readPostTrail(db, userId, id, NOW))!;
    // Review I3: only the rebuilt reading gives way; where it came from, its screening, its batch, the owner's choices
    // and what was saved are still its history (and still marked rebuilt).
    expect(trail.rebuilt).toBe(true);
    expect(trail.events.map((e) => [e.stage, e.rebuilt])).toEqual([
      ["submit", true], ["screen", true], ["batch", true], ["choice", true], ["save", true],
      ["choice", false], ["extract", false], ["check", false], ["match", false],
    ]);
    const extract = trail.events.find((e) => e.stage === "extract")!;
    expect(extract).toMatchObject({ promptVersion: EXTRACT_PROMPT_VERSION, status: "ok" });
    expect(extract.summary).toBe("Read 3 moves (a routine) — read again, lined up with the 2 moves it had");
    const match = trail.events.find((e) => e.stage === "match")!.detail as { moves: { position: number; by: string; moveId: string }[] };
    expect(match.moves.map((m) => [m.position, m.by, m.moveId])).toEqual([
      [0, "kept", "myZorbexHipLift0001"], [1, "kept", "myZorbexKneeSwing03"], [2, "new", expect.any(String)],
    ]);
    expect(trail.account.moves.map((m) => [m.name, m.outcome, m.why])).toEqual([
      ["Zorbex hip lift (mine)", "yours", "opens the hips"], ["Zorbex knee swing", "yours", "loosens the knees"], ["Zorbex quux drift", "new", "calms the calves"],
    ]);
    expect(trail.post.readAgain).toBeNull();
  });

  it("a linked move the new reading doesn't hold: the earlier reading stays whole, the reply is on the trail, and it can be asked again", async () => {
    const id = await oldSaved();
    await readAgain(db, userId, id, NOW);
    const before = await snapshot();
    const out = await reread(id, gateway({ ...FRESH, moves: [FRESH.moves[1], FRESH.moves[2]] }));
    expect(out).toMatchObject({ ok: true });
    expect(await post(id)).toMatchObject({ status: "matched", extraction: EARLIER });
    expect(await snapshot()).toEqual(before);
    const trail = (await readPostTrail(db, userId, id, NOW))!;
    const extract = trail.events.find((e) => e.stage === "extract" && !e.rebuilt)!;
    expect(extract.status).toBe("warn");
    expect(extract.summary).toBe("Read 2 moves again, but Zorbex knee sways isn't among them — the earlier reading stays");
    expect(extract.blobs.map((b) => b.kind)).toContain("raw_reply");
    expect(trail.rebuilt).toBe(true); // still the kept steps: the earlier reading is still the post's
    expect(trail.post.readAgain).toMatchObject({ offer: true });
  });

  it("a re-read that fails keeps the earlier reading and its rebuilt steps; the failure is on the trail once", async () => {
    const id = await oldSaved();
    await readAgain(db, userId, id, NOW);
    await reread(id, gateway(null, 500));
    // Review I5: its moves are still the owner's — the post stays matched, the failure kept as its code, and the work
    // list tries it again as it tries any failed reading.
    expect(await post(id)).toMatchObject({ status: "matched", lastErrorCode: "model_failed", extraction: EARLIER });
    expect((await workList(db, userId, NOW)).map((w) => [w.key, w.action])).toEqual([[KEY, "extract"]]);
    const trail = (await readPostTrail(db, userId, id, NOW))!;
    expect(trail.rebuilt).toBe(true);
    expect(trail.events.map((e) => [e.stage, e.rebuilt, e.status])).toEqual([
      ["submit", true, "ok"], ["screen", true, "ok"], ["extract", true, "ok"], ["match", true, "ok"], ["batch", true, "info"], ["choice", true, "info"], ["save", true, "ok"],
      ["choice", false, "info"], ["extract", false, "fail"],
    ]);
  });

  it("an old failed post with nothing kept: one failed step, never a rebuilt copy of the same failure", async () => {
    const id = await savedPostId(userId, "instagram", KEY);
    await db.insert(savedPosts).values({
      id, userId, source: "instagram", sourceKey: KEY, url: link, firstSeenAt: CAPTURED, status: "failed", filterVerdict: "training",
      filterReason: "a hip routine", filterStage: "model", lastErrorCode: "media_failed", mediaType: "video", updatedAt: CAPTURED,
    });
    await readAgain(db, userId, id, NOW);
    await reread(id, gateway(null, 500));
    expect((await post(id)).status).toBe("failed"); // nothing kept: a failed post as before
    const trail = (await readPostTrail(db, userId, id, NOW))!;
    expect(trail.events.filter((e) => e.stage === "extract").map((e) => [e.rebuilt, e.status])).toEqual([[false, "fail"]]);
  });

  it("a re-read cut off after its paid reading is matched later the same way: nothing linked twice, nothing left behind", async () => {
    const id = await oldSaved();
    // The aligned reading was stored (paid and kept first); the request died before matching.
    await db.update(savedPosts).set({
      status: "extracted", updatedAt: "2026-11-06T09:00:00.000Z",
      extraction: { ...FRESH, moves: [FRESH.moves[1], FRESH.moves[0], FRESH.moves[2]], insights: EARLIER.insights },
    }).where(eq(savedPosts.id, id));
    const before = await snapshot();
    const gw = gateway({ matches: [] });
    expect(await matchStale(db, env, userId, new Date(NOW), gw.fetchImpl)).toBe(true);
    expect(gw.spy).not.toHaveBeenCalled();
    const after = await snapshot();
    expect(after.links.length).toBe(before.links.length + 1);
    expect(after.moves.length).toBe(before.moves.length + 1);
    for (const m of before.moves) expect(after.moves.find((x) => x.id === m.id)).toEqual(m);
  });
});

describe("the final review's fix pass (phase 5a)", () => {
  it("I1: a fit started after the ask — the re-read's new moves still reach the next batch", async () => {
    const id = await oldSaved({ batch: { fittedAt: null } }); // saved, not yet fitted in: its moves are kept
    expect(await readAgain(db, userId, id, NOW)).toBe("ok");
    await db.update(saveBatches).set({ fitStartedAt: NOW }).where(eq(saveBatches.id, "batch-old")); // the owner taps Fit them in
    await reread(id, gateway(FRESH));
    expect((await post(id)).batchId).toBeNull();
    const added = (await db.select().from(savedPostMoves).where(eq(savedPostMoves.postId, id))).filter((l) => l.position === 2);
    expect(added.map((l) => [l.status, l.batchId])).toEqual([["pending", null]]);
  });

  it("I2: a correction to the reading approved while the post is being read is refused — so the re-read can never undo it", async () => {
    const id = await oldSaved();
    const op = (field: "why"): ImportCorrectionOp => ({
      kind: "import_correction", id: "c1", target: "reading", targetId: `${id}:1`, field, before: null, after: "loosens the knees after runs",
      why: "the post says so", basis: "evidence", cites: [], name: "Zorbex knee swing", line: "Why fixed", posts: [id], date: "2026-11-06",
      toolUseId: "t1", at: NOW,
    });
    const tryApprove = async () => {
      const [states] = (await db.all(correctionsReadSql(userId, [op("why")], "2026-11-06"))) as Array<Record<string, unknown>>;
      const state = correctionStateOf(states?.s0);
      const now = currentValue("reading", `${id}:1`, "why", state);
      const verdict = judgeCorrection(db, userId, { ...op("why"), before: "value" in now ? now.value : null }, state, { proposalId: "p1", runId: null, now: NOW, asRead: sql`1`, today: "2026-11-06" });
      if (verdict.status !== "apply") return verdict.status;
      return (await runAtomicallyClaim(db, verdict.statements)) > 0 ? "applied" : "refused";
    };
    await db.update(savedPosts).set({ status: "extracting" }).where(eq(savedPosts.id, id)); // the re-read's call is out
    expect(await tryApprove()).toBe("refused");
    expect((await post(id)).extraction).toEqual(EARLIER);
    expect(await db.select().from(importCorrections).where(eq(importCorrections.id, "c1"))).toEqual([]);
    await db.update(savedPosts).set({ status: "matched" }).where(eq(savedPosts.id, id)); // and once it isn't, it applies
    expect(await tryApprove()).toBe("applied");
  });

  it("I5: a re-read whose post is gone ends matched with the earlier reading, says so, and isn't handed out again", async () => {
    const id = await oldSaved();
    await readAgain(db, userId, id, NOW);
    expect(await markFetchFailed(db, userId, id, "gone", NOW)).toBe("ok");
    expect(await post(id)).toMatchObject({ status: "matched", lastErrorCode: "gone", extraction: EARLIER });
    expect(await linksOf(id)).toEqual([[0, "myZorbexHipLift0001", "saved", "batch-old"], [1, "myZorbexKneeSwing03", "saved", "batch-old"]]);
    expect(await workList(db, userId, NOW)).toEqual([]);
    const trail = (await readPostTrail(db, userId, id, NOW))!;
    expect(trail.events.at(-1)).toMatchObject({ stage: "read", status: "fail", summary: "The post is gone" });
  });
});
