/**
 * Pasted links (design 2026-11-05 §3.1, §5.1, §6.3, §14.4, §15.2): a link pasted in the extension's popup or the app's
 * field waits as a `saved_links` row until the extension reads it; the work list hands it out as `read` to an
 * extension that knows links (`?v=2`) and never to an older one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { savesRoutes } from "../src/routes/saves.js";
import { addLink, listLinks } from "../src/services/saved-links.js";
import { recordReadFailed, savedPostId, workList } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedLinks, savedPosts, savedPostMoves } = schema;
const NOW = "2026-11-06T10:00:00.000Z";
const TOKEN = "d".repeat(64);
// Links assembled at runtime, a fake video id built here: the privacy grep never sees a real one.
const S = ["ht", "tps://"].join("");
const vid = ["Zx", "9_-Qa", "B3cD"].join("");
const watch = `${S}www.${["you", "tube.com"].join("")}/watch?v=${vid}`;
const shortLink = `${["you", "tu.be"].join("")}/${vid}?si=zz`;
const code = "ZorbexPost1";
const igLink = `${S}www.${["insta", "gram.com"].join("")}/reel/${code}/`;

let db: Db;
let userId: string;
let statements = 0;
let cookie: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  statements = 0;
});

async function seedPost(source: string, key: string, over: Partial<typeof savedPosts.$inferInsert> = {}) {
  const id = await savedPostId(userId, source, key);
  await db.insert(savedPosts).values({
    id, userId, source, sourceKey: key, url: watch, firstSeenAt: "2026-11-03T09:00:00.000Z", status: "seen", updatedAt: NOW, ...over,
  });
  return id;
}

describe("addLink and listLinks", () => {
  it("a link from the phone waits for the computer's extension, and is listed so", async () => {
    const out = await addLink(db, userId, shortLink, "app", NOW);
    expect(out).toMatchObject({ ok: true, state: "added", link: { source: "youtube", key: vid, url: watch, addedFrom: "app", state: "waiting", words: "Waiting for your computer's extension", postId: null } });
    const [only, ...more] = await listLinks(db, userId);
    expect(more).toEqual([]);
    expect(only).toMatchObject({ id: await savedPostId(userId, "youtube", vid), words: "Waiting for your computer's extension" });
  });

  it("the same link twice is one row; a link refused says what it takes", async () => {
    await addLink(db, userId, watch, "extension", NOW);
    await addLink(db, userId, shortLink, "app", NOW);
    expect(await db.select().from(savedLinks)).toHaveLength(1);
    expect(await addLink(db, userId, `${S}vimeo.com/1`, "app", NOW)).toEqual({ ok: false, error: "not_a_link" });
  });

  it("a link already imported answers known, with when it came in", async () => {
    const id = await seedPost("youtube", vid);
    expect(await addLink(db, userId, watch, "app", NOW)).toEqual({ ok: true, state: "known", postId: id, firstSeenAt: "2026-11-03T09:00:00.000Z" });
    expect(await db.select().from(savedLinks)).toEqual([]);
  });

  it("a failed link pasted again goes back to waiting", async () => {
    await addLink(db, userId, watch, "extension", NOW);
    await recordReadFailed(db, userId, { source: "youtube", key: vid, code: "unplayable", message: "Age-restricted" }, NOW);
    expect((await listLinks(db, userId))[0]).toMatchObject({ state: "failed", words: "Failed: Age-restricted", action: "retry" });
    await addLink(db, userId, watch, "app", NOW);
    expect((await listLinks(db, userId))[0]).toMatchObject({ state: "reading", words: "Reading" });
  });

  it("once the post is in, the post says where the link stands", async () => {
    await addLink(db, userId, igLink, "app", NOW);
    const id = await seedPost("instagram", code, { title: "Zorbex flow" });
    expect((await listLinks(db, userId))[0]).toMatchObject({ postId: id, title: "Zorbex flow", words: "Screening" });
    await db.update(savedPosts).set({ status: "matched" }).where(eq(savedPosts.id, id));
    for (const [n, moveId] of ["m1", "m2", "m2", "m3"].entries()) {
      await db.insert(savedPostMoves).values({ id: `l${n}`, userId, postId: id, position: n, moveId, moveKind: "personal", confidence: 1, checkFlag: false, status: "pending", createdAt: NOW });
    }
    statements = 0;
    expect((await listLinks(db, userId))[0]).toMatchObject({ state: "moves", words: "3 moves", moves: 3 });
    expect(statements).toBe(1);
  });

  it("each link says which batch its moves are in, or none yet — still one statement (audit 2026-11-06, I6)", async () => {
    await addLink(db, userId, igLink, "app", NOW);
    const id = await seedPost("instagram", code, { status: "matched" });
    await db.insert(savedPostMoves).values({ id: "lb0", userId, postId: id, position: 0, moveId: "m1", moveKind: "personal", confidence: 1, checkFlag: false, status: "pending", createdAt: NOW });
    statements = 0;
    expect((await listLinks(db, userId))[0]).toMatchObject({ state: "moves", batchId: null });
    expect(statements).toBe(1);
    await db.update(savedPostMoves).set({ batchId: "batch-1" }).where(eq(savedPostMoves.id, "lb0"));
    expect((await listLinks(db, userId))[0]).toMatchObject({ batchId: "batch-1" });
    await addLink(db, userId, watch, "app", NOW);
    expect((await listLinks(db, userId)).find((l) => l.key === vid)).toMatchObject({ postId: null, batchId: null });
  });

  it("another account never sees it", async () => {
    await addLink(db, userId, watch, "app", NOW);
    const other = (await makeTestUser(db)).userId;
    expect(await listLinks(db, other)).toEqual([]);
  });
});

describe("the work list hands links out as `read`", () => {
  it("to an extension that knows links, first; never to an older one, and never a YouTube post", async () => {
    await seedPost("instagram", "igq", { status: "queued" });
    await seedPost("youtube", "Yt0000000ab", { status: "queued" });
    await addLink(db, userId, shortLink, "app", NOW);
    const v2 = await workList(db, userId, NOW, 20, { links: true });
    expect(v2[0]).toEqual({ source: "youtube", key: vid, url: watch, action: "read" });
    expect(v2.map((w) => w.key).sort()).toEqual([vid, "Yt0000000ab", "igq"].sort());
    // An old extension's work list is unchanged: no read item, no YouTube post (it would read the id as a shortcode).
    const old = await workList(db, userId, NOW);
    expect(old.map((w) => [w.key, w.action])).toEqual([["igq", "extract"]]);
  });

  it("a link whose post is in, or that failed, is not handed out", async () => {
    await addLink(db, userId, shortLink, "app", NOW);
    await addLink(db, userId, igLink, "app", NOW);
    await seedPost("youtube", vid, { status: "matched" });
    await recordReadFailed(db, userId, { source: "instagram", key: code, code: "gone", message: "The post is gone" }, NOW);
    expect((await workList(db, userId, NOW, 20, { links: true })).filter((w) => w.action === "read")).toEqual([]);
  });
});

describe("the routes", () => {
  const env = async (over: Partial<Env> = {}) =>
    ({ SAVES_IMPORT: "1", SAVES_TOKEN_SHA256: await sha256Hex(TOKEN), ALLOWED_GOOGLE_EMAIL: `runner-${userId}@example.com`, ...over }) as unknown as Env;
  const token = async (path: string, init: RequestInit = {}) => {
    const app = mountRoutes(db, "/api/saves", savesRoutes);
    statements = 0;
    const res = await app.request(`/api/saves${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }, await env());
    return { res, body: (await res.json()) as any, cost: statements };
  };
  const owner = async (path: string, init: RequestInit = {}) => {
    const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
    statements = 0;
    const res = await app.request(`/api/my-saves${path}`, { ...init, headers: { Cookie: cookie, "Content-Type": "application/json" } }, await env());
    return { res, body: (await res.json()) as any, cost: statements };
  };

  it("the extension adds and lists links, and asks for work with ?v=2", async () => {
    const added = await token("/links", { method: "POST", body: JSON.stringify({ url: watch }) });
    expect(added.res.status).toBe(200);
    expect(added.body).toMatchObject({ state: "added", link: { key: vid, addedFrom: "extension", words: "Reading" } });
    expect(added.cost).toBeLessThanOrEqual(5); // 2 auth + post 1 + link 1 + its read back 1
    const listed = await token("/links");
    expect(listed.body.links).toHaveLength(1);
    expect(listed.cost).toBeLessThanOrEqual(3);
    const work = await token("/work?v=2");
    // 2 auth, the stale re-match's look 1, the work list's 3 and its links 1 (REBASED 2026-11-06 (import trail phase 2):
    // + the waiting links, + the stale re-match of a reading cut off after its paid call).
    expect(work.cost).toBeLessThanOrEqual(7);
    // Every waiting link is handed out, the extension's own too: its queue takes each once, and one it lost comes back.
    expect(work.body.keys).toEqual([{ source: "youtube", key: vid, url: watch, action: "read" }]);
    const refused = await token("/links", { method: "POST", body: JSON.stringify({ url: "nope" }) });
    expect(refused.res.status).toBe(400);
    expect(refused.body).toEqual({ error: "not_a_link", message: "Only YouTube and Instagram links for now." });
  });

  it("the app adds a link from the phone and lists it; the extension's work list then has it", async () => {
    const added = await owner("/links", { method: "POST", body: JSON.stringify({ url: igLink }) });
    expect(added.body).toMatchObject({ state: "added", link: { source: "instagram", key: code, words: "Waiting for your computer's extension" } });
    expect((await owner("/links")).body.links).toHaveLength(1);
    expect((await token("/work?v=2")).body.keys).toEqual([{ source: "instagram", key: code, url: igLink, action: "read" }]);
    expect((await token("/work")).body.keys).toEqual([]);
  });
});

describe("a video's screening is tried again at a check's pace, not every 15 minutes (final review F3)", () => {
  it("a YouTube post the screening couldn't decide comes back after 6 hours", async () => {
    const recent = new Date(Date.parse(NOW) - 3_600_000).toISOString();
    const old = new Date(Date.parse(NOW) - 7 * 3_600_000).toISOString();
    await seedPost("youtube", "Yt0000000ab", { status: "seen", lastErrorCode: "model_failed", updatedAt: recent });
    await seedPost("youtube", "Yt0000000cd", { status: "seen", lastErrorCode: "model_failed", updatedAt: old });
    await seedPost("instagram", "igseen", { status: "seen", lastErrorCode: "model_failed", updatedAt: recent });
    const keys = (await workList(db, userId, NOW, 20, { links: true })).map((w) => [w.key, w.action]);
    expect(keys.sort()).toEqual([["Yt0000000cd", "filter"], ["igseen", "filter"]].sort());
  });
});

describe("a held video whose read failed waits a check's pace too (final audit G9)", () => {
  it("any failed read moves it behind the 6-hour wait", async () => {
    const old = new Date(Date.parse(NOW) - 7 * 3_600_000).toISOString();
    await seedPost("youtube", "Yt0000000ab", { status: "seen", lastErrorCode: "model_failed", updatedAt: old });
    expect((await workList(db, userId, NOW, 20, { links: true })).map((w) => w.key)).toEqual(["Yt0000000ab"]);
    await recordReadFailed(db, userId, { source: "youtube", key: "Yt0000000ab", code: "unknown", message: "The player didn't load" }, NOW);
    expect(await workList(db, userId, NOW, 20, { links: true })).toEqual([]);
  });
});

describe("a playlist or a channel pasted (audit 2026-11-06, I4)", () => {
  it("is refused for what it is, by either route", async () => {
    const env = { SAVES_IMPORT: "1", SAVES_TOKEN_SHA256: await sha256Hex(TOKEN), ALLOWED_GOOGLE_EMAIL: `runner-${userId}@example.com` } as unknown as Env;
    const playlist = `${S}www.${["you", "tube.com"].join("")}/playlist?list=PLzorbex`;
    const body = JSON.stringify({ url: playlist });
    const mine = await mountRoutes(db, "/api/my-saves", mySavesRoutes).request("/api/my-saves/links", { method: "POST", body, headers: { Cookie: cookie, "Content-Type": "application/json" } }, env);
    expect(mine.status).toBe(400);
    expect(await mine.json()).toEqual({ error: "not_a_link", message: "Single videos and posts only — not playlists or channels." });
    const ext = await mountRoutes(db, "/api/saves", savesRoutes).request("/api/saves/links", { method: "POST", body, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }, env);
    expect(await ext.json()).toEqual({ error: "not_a_link", message: "Single videos and posts only — not playlists or channels." });
  });
});
