/**
 * A YouTube video's reading (design 2026-11-05 §5.4): the Worker builds the body from the stored words (no media
 * bytes to relay), attaches the video by its link when it is 20 minutes or shorter (or the owner asked), sizes the
 * reservation and the timeout from the length, and checks from the billed tokens whether the video was seen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { EXTRACT_PROMPT_VERSION, extractSystemText, extractUserText, transcriptSegments } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { importHealth } from "../src/services/import-health.js";
import { messagesCostMicros } from "../src/services/llm-messages.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { callTimeoutMs, EXTRACT_MODEL_DEFAULT, relayVideoExtract } from "../src/services/saves-relay.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { savedPosts, importBlobs, importEvents, llmUsage } = schema;
const NOW = "2026-11-06T10:00:00.000Z";
const MODEL = EXTRACT_MODEL_DEFAULT;
// A fake video id and a made-up channel; the watch link assembled at runtime.
const vid = ["Zx", "9_-Qa", "B3cD"].join("");
const watch = ["ht", "tps://www.", "you", "tube.com/watch?v=", vid].join("");
const TRANSCRIPT = "0\tWelcome to the Zorbex hip flow\n12\tdo ten slow reps on each side\n30\tthen rest";

let db: Db;
let userId: string;
let statements = 0;

const conditions = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "ok" },
  ]),
);
const move = (quotes: unknown[] = []) => ({
  name: "Zorbex hip lift", aliases: [], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose: "hip mobility",
  dose: { text: "10 each side", type: "reps", range: [10, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: ["mat"],
  position: "seated", laterality: "alternating", load: "bodyweight", contraction: ["isotonic"], difficulty: 2, conditions,
  evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high", quotes,
});
const reading = (quotes: unknown[] = []) => ({ kind: "single_move", summary: "s", themes: [], moves: [move(quotes)] });

const env = (over: Partial<Env> = {}): Env =>
  ({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "k", AI_GATEWAY_BASE_URL: "https://gw.test/v1", ...over }) as unknown as Env;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  statements = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

async function seedVideo(over: { durationSec?: number; transcript?: string | null; watchVideo?: boolean } = {}) {
  const id = await savedPostId(userId, "youtube", vid);
  const transcript = over.transcript === undefined ? TRANSCRIPT : over.transcript;
  await db.insert(savedPosts).values({
    id, userId, source: "youtube", sourceKey: vid, url: watch, creatorHandle: "@zorbexcoach", creatorName: "Zorbex Coach",
    caption: "A Zorbex hip flow for runners.", hashtags: [], mediaType: "video", firstSeenAt: NOW, status: "queued", updatedAt: NOW,
    title: "Zorbex hip flow", durationSec: over.durationSec ?? 600, origin: "pasted", watchVideo: over.watchVideo ?? null,
    videoInfo: {
      chapters: [{ start: 0, title: "Intro" }, { start: 30, title: "Rest" }],
      captions: transcript ? { lang: "en", kind: "uploaded" } : null, live: false, transcriptChars: transcript?.length ?? 0, transcriptCut: false,
    },
  });
  if (transcript) await db.insert(importBlobs).values({ id: "blob-t", userId, postId: id, eventId: "ev-read", kind: "transcript", text: transcript, at: NOW });
  return id;
}
const words = (durationSec = 600, transcript: string | null = TRANSCRIPT) => ({
  source: "youtube", creator: { handle: "@zorbexcoach", name: "Zorbex Coach" }, caption: "A Zorbex hip flow for runners.", hashtags: [],
  mediaType: "video" as const, title: "Zorbex hip flow", durationSec,
  chapters: [{ start: 0, title: "Intro" }, { start: 30, title: "Rest" }],
  transcript: transcript ? { lang: "en", kind: "uploaded" as const, text: transcript, cut: false } : null,
});
const userText = (durationSec = 600, transcript: string | null = TRANSCRIPT) =>
  extractUserText({ post: words(durationSec, transcript), libraryNames: EXERCISES.map((e) => e.name) });
const textTokens = (text: string) => Math.ceil((extractSystemText().length + text.length) / 4);

function gateway(content: unknown, promptTokens: (sentUserText: string) => number) {
  const calls: { body: any; reservedMicros: number }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reservation = (await db.select().from(llmUsage)).find((r) => r.requestFingerprint !== null);
    calls.push({ body, reservedMicros: reservation?.costMicros ?? 0 });
    const sent = body.messages[1].content[0].text as string;
    return new Response(
      JSON.stringify({ model: MODEL, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: promptTokens(sent), completion_tokens: 900 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, spy: fetchImpl };
}
const request = (headers: Record<string, string> = {}) =>
  new Request(`https://app.test/api/saves/posts/${vid}/extract-video?source=youtube`, { method: "POST", headers: { "x-saves-model": MODEL, ...headers } });
const run = (id: string, gw: ReturnType<typeof gateway>, req = request()) => relayVideoExtract(db, env(), userId, { id }, req, new Date(NOW), gw.fetchImpl);
const row = async (id: string) => (await db.select().from(savedPosts).where(eq(savedPosts.id, id)))[0]!;
const extractEventOf = async (id: string) => (await db.select().from(importEvents).where(eq(importEvents.postId, id))).find((e) => e.stage === "extract")!;

describe("a video up to 20 minutes is watched", () => {
  it("the body is the stored words, the watch link attached, 32,000 output tokens; billed video tokens mean it was seen", async () => {
    const id = await seedVideo();
    const gw = gateway(reading(), (sent) => textTokens(sent) + 60_000);
    const out = await run(id, gw);
    expect(out.ok).toBe(true);
    const [call] = gw.calls;
    expect(call!.body.max_tokens).toBe(32_000);
    expect(call!.body.messages[1].content[0].text).toBe(userText());
    expect(call!.body.messages[1].content[1]).toEqual({ type: "file", file: { filename: "video.mp4", file_data: watch } });
    expect((await row(id)).videoSeen).toBe(true);
    const e = await extractEventOf(id);
    expect(e).toMatchObject({ status: "ok", promptVersion: EXTRACT_PROMPT_VERSION, summary: "Read 1 move (single move) — watched" });
    expect(e.detail).toMatchObject({ watched: true, videoSeen: true, asSent: true });
  });

  it("text-only billing means the reader couldn't watch it: a warning, and the Reader light goes yellow", async () => {
    const id = await seedVideo();
    await run(id, gateway(reading(), (sent) => textTokens(sent)));
    expect((await row(id)).videoSeen).toBe(false);
    const e = await extractEventOf(id);
    expect(e.status).toBe("warn");
    expect(e.summary).toBe("Read 1 move (single move) — the reader couldn't watch the video; it read the transcript only");
    const reader = (await importHealth(db, userId, new Date(NOW))).lights.find((l) => l.light === "reader")!;
    expect(reader.color).toBe("yellow");
  });

  it("reserves the worst case from the length (300 tokens a second watched), never from a body's bytes", async () => {
    const id = await seedVideo();
    const gw = gateway(reading(), (sent) => textTokens(sent) + 60_000);
    await run(id, gw);
    const floor = messagesCostMicros(MODEL, { inputTokens: 300 * 600, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 32_000 });
    expect(gw.calls[0]!.reservedMicros).toBeGreaterThanOrEqual(floor);
  });

  it("with no captions and the video not seen, there was nothing to read: it fails and says so", async () => {
    const id = await seedVideo({ transcript: null });
    const out = await run(id, gateway(reading(), (sent) => textTokens(sent)));
    expect(out).toMatchObject({ ok: false, code: "no_captions" });
    expect(await row(id)).toMatchObject({ status: "failed", lastErrorCode: "no_captions", videoSeen: false });
    expect((await extractEventOf(id)).summary).toBe("Nothing to read: no captions, and the video couldn't be watched");
  });
});

describe("a longer video is read from its words until the owner asks", () => {
  it("over 20 minutes: no video attached, read from the transcript, and the trail says so", async () => {
    const id = await seedVideo({ durationSec: 2_400 });
    const gw = gateway(reading(), (sent) => textTokens(sent));
    await run(id, gw);
    expect(gw.calls[0]!.body.messages[1].content).toHaveLength(1);
    expect(gw.calls[0]!.body.messages[1].content[0].text).toBe(userText(2_400));
    expect((await row(id)).videoSeen).toBeNull();
    const e = await extractEventOf(id);
    expect(e).toMatchObject({ status: "ok", summary: "Read 1 move (single move) — from the transcript (over 20 minutes)" });
    expect(e.detail).toMatchObject({ watched: false, videoSeen: null });
  });

  it("Watch it too: the owner's ask attaches a long video", async () => {
    const id = await seedVideo({ durationSec: 2_400, watchVideo: true });
    const gw = gateway(reading(), (sent) => textTokens(sent) + 240_000);
    await run(id, gw);
    expect(gw.calls[0]!.body.messages[1].content).toHaveLength(2);
    expect((await row(id)).videoSeen).toBe(true);
  });

  it("over 20 minutes with no captions: no call at all — Watch it too reads it from the video", async () => {
    const id = await seedVideo({ durationSec: 2_400, transcript: null });
    const gw = gateway(reading(), () => 0);
    const out = await run(id, gw);
    expect(gw.spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, code: "no_captions" });
    expect(await row(id)).toMatchObject({ status: "failed", lastErrorCode: "no_captions" });
    expect((await extractEventOf(id)).summary).toBe("No captions, and it's over 20 minutes — Watch it too reads it from the video");
    expect(await db.select().from(llmUsage)).toEqual([]);
  });

  it("the call's time grows with the minutes watched, at most 10 minutes", () => {
    expect(callTimeoutMs(null)).toBe(120_000);
    expect(callTimeoutMs(600)).toBe(140_000);
    expect(callTimeoutMs(2_400)).toBe(200_000);
    expect(callTimeoutMs(36_000)).toBe(600_000);
  });
});

describe("the reading's quotes are checked", () => {
  it("a quote in the transcript is verified with its time; one not in the words is not_found and counted", async () => {
    const id = await seedVideo();
    await run(id, gateway(reading([
      { field: "dose", text: "ten slow reps on each side", at: 12, from: "transcript" },
      { field: "why", text: "it cures everything", from: "transcript" },
    ]), (sent) => textTokens(sent) + 60_000));
    const stored = (await row(id)).extraction as { moves: { quotes: { check: string }[]; evidence: Record<string, string> }[] };
    expect(stored.moves[0]!.quotes.map((q) => q.check)).toEqual(["verified", "not_found"]);
    expect((await extractEventOf(id)).detail).toMatchObject({ quotes: { verified: 1, in_speech: 0, not_found: 1 } });
    expect(transcriptSegments(TRANSCRIPT)).toHaveLength(3);
  });
});

describe("the route", () => {
  it("POST /api/saves/posts/:key/extract-video reads the video, within the relay's statements and two more", async () => {
    const { savesRoutes } = await import("../src/routes/saves.js");
    const { mountRoutes } = await import("./helpers.js");
    const { sha256Hex } = await import("../src/auth/crypto.js");
    const id = await seedVideo();
    const gw = gateway(reading(), (sent) => textTokens(sent) + 60_000);
    vi.stubGlobal("fetch", gw.fetchImpl);
    try {
      const app = mountRoutes(db, "/api/saves", savesRoutes);
      const e = { ...env(), SAVES_IMPORT: "1", SAVES_TOKEN_SHA256: await sha256Hex("t".repeat(64)), ALLOWED_GOOGLE_EMAIL: `runner-${userId}@example.com` } as unknown as Env;
      statements = 0;
      const res = await app.request(`/api/saves/posts/${vid}/extract-video?source=youtube`, { method: "POST", headers: { Authorization: `Bearer ${"t".repeat(64)}`, "x-saves-model": MODEL } }, e);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "matched", moves: 1, kind: "single_move" });
      expect((await row(id)).status).toBe("matched");
      // 2 auth, the video read 1, its transcript 1, then the relay's (reserve 2, claim 1, credits 2, settle 1, outcome
      // and its trail) and matching's: within the Workers Free budget.
      expect(statements).toBe(23);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
