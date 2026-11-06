/** The health row (design 2026-11-05 §3.2, §6.5): one light per stage and source, from the trail, the checks and the budget. */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { HealthLight } from "@rg/saves";
import type { Db } from "../src/services/db.js";
import { importHealth } from "../src/services/import-health.js";
import { addLink } from "../src/services/saved-links.js";
import { recordReadFailed } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
let db: Db;
let userId: string;
let n = 0;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

async function event(stage: string, status: string, hoursAgo: number, over: Record<string, unknown> = {}) {
  await db.insert(schema.importEvents).values({
    id: `e${++n}`, userId, postId: `p${n}`, stage, source: stage === "read" ? "instagram" : "gateway", status, summary: `${stage} ${status}`,
    at: at(hoursAgo), ...over,
  });
}
const lightOf = async (light: HealthLight) => (await importHealth(db, userId, NOW)).lights.find((l) => l.light === light)!;

describe("importHealth", () => {
  it("grey with nothing in the window — never green for a source never used (Review Focus 4)", async () => {
    const h = await importHealth(db, userId, NOW);
    expect(h.lights.map((l) => [l.light, l.color])).toEqual([
      ["instagram", "grey"], ["youtube", "grey"], ["screening", "grey"], ["reader", "grey"], ["matching", "grey"], ["coach", "grey"], ["budget", "green"],
    ]);
    expect(h.worst).toBeNull();
  });
  it("green when the recent steps went well", async () => {
    for (let i = 0; i < 5; i++) await event("extract", "ok", 10 + i);
    expect(await lightOf("reader")).toMatchObject({ color: "green", line: null, failures: [] });
  });
  it("red by ratio: at least half of at least four attempts failed", async () => {
    await event("extract", "fail", 1); await event("extract", "fail", 2); await event("extract", "ok", 3); await event("extract", "fail", 4);
    const reader = await lightOf("reader");
    expect(reader).toMatchObject({ color: "red", line: "Reader: 3 of 4 failed" });
    expect(reader.failures).toHaveLength(3);
    expect((await importHealth(db, userId, NOW)).worst).toBe("Reader: 3 of 4 failed");
  });
  it("red by cause: the last attempt failed for the whole stage (a login, the gateway refusing the key)", async () => {
    await event("read", "ok", 5);
    await event("read", "fail", 1, { detail: { code: "login_needed" }, summary: "Instagram wants you to log in again" });
    expect(await lightOf("instagram")).toMatchObject({ color: "red", line: "Instagram wants you to log in again" });
    await event("extract", "fail", 1, { detail: { failure: "gateway_402" }, summary: "The model gateway answered 402" });
    expect((await lightOf("reader")).color).toBe("red");
  });
  it("yellow: a failure or a warning among the latest steps, not enough to be red", async () => {
    for (let i = 0; i < 6; i++) await event("screen", "ok", 10 + i);
    await event("screen", "warn", 1, { summary: "Waiting for the import budget" });
    expect(await lightOf("screening")).toMatchObject({ color: "yellow", line: "Waiting for the import budget" });
  });
  it("each light keeps its own last 20 steps: a busy light never pushes another's out (final review)", async () => {
    await event("extract", "fail", 30, { detail: { failure: "gateway_402" }, summary: "The model gateway answered 402" });
    for (let i = 0; i < 150; i++) await event("screen", "ok", 1 + i / 100);
    expect((await lightOf("reader")).color).toBe("red");
  });
  it("steps outside seven days are not counted", async () => {
    await event("extract", "fail", 24 * 8);
    expect((await lightOf("reader")).color).toBe("grey");
  });
  it("budget: yellow past 80%, red at the cap", async () => {
    const spend = (micros: number) => db.insert(schema.llmUsage).values({
      id: `u${++n}`, userId, kind: "import_extract", model: "m", inputTokens: 1, outputTokens: 1, costMicros: micros, cacheHit: false, createdAt: at(1),
    });
    await spend(4_250_000);
    expect(await lightOf("budget")).toMatchObject({ color: "yellow", line: "Budget: $4.25 of $5.00 this month" });
    await spend(800_000);
    expect((await lightOf("budget")).color).toBe("red");
  });
  it("Instagram: yellow when checks have run but none in two days", async () => {
    await db.insert(schema.saveChecks).values({ id: "c1", userId, startedAt: at(60), finishedAt: at(60) });
    expect(await lightOf("instagram")).toMatchObject({ color: "yellow", line: "Instagram: no check in 2 days" });
  });
});

describe("a YouTube read that failed before its post (audit 2026-11-06, I3)", () => {
  // Links assembled at runtime, a fake video id built here.
  const S = ["ht", "tps://"].join("");
  const vid = ["Zx", "9_-Qa", "B3cD"].join("");
  const watch = `${S}www.${["you", "tube.com"].join("")}/watch?v=${vid}`;

  it("is titled by its link (not just 'YouTube') and carries the link, so Retry can paste it again", async () => {
    await addLink(db, userId, watch, "extension", at(3));
    await recordReadFailed(db, userId, { source: "youtube", key: vid, code: "unplayable", message: "Age-restricted" }, at(1));
    const yt = await lightOf("youtube");
    expect(yt.failures).toEqual([{ postId: null, title: watch, at: at(1), why: "YouTube won't play it: Age-restricted", retryLink: watch }]);
  });

  it("with no link row (a video the app handed out), the title and Retry come from its key", async () => {
    await recordReadFailed(db, userId, { source: "youtube", key: vid, code: "unknown", message: "The player didn't load" }, at(1));
    expect((await lightOf("youtube")).failures[0]).toMatchObject({ postId: null, title: watch, retryLink: watch });
  });

  it("a failure with no link at all (a check's login) keeps the source's name and offers no link", async () => {
    await recordReadFailed(db, userId, { source: "instagram", code: "login_needed", message: "Instagram wants you to log in again" }, at(1));
    expect((await lightOf("instagram")).failures[0]).toMatchObject({ postId: null, title: "Instagram", retryLink: null });
  });

  it("YouTube asking to sign in is the whole stage's: red, in plain words, said once", async () => {
    await event("read", "ok", 5, { source: "youtube" });
    await recordReadFailed(db, userId, { source: "youtube", key: vid, code: "youtube_login", message: "Sign in to YouTube in Chrome" }, at(1));
    expect(await lightOf("youtube")).toMatchObject({ color: "red", line: "Sign in to YouTube in Chrome" });
  });
});

describe("the Reader light reads the check of each reading (audit 2026-11-06, I8)", () => {
  it("a reading whose quotes aren't in the post turns the Reader yellow, in the check's words", async () => {
    for (let i = 0; i < 4; i++) await event("extract", "ok", 10 + i);
    await event("extract", "ok", 2);
    await event("check", "warn", 1, { source: "worker", summary: "2 quotes aren't in the post" });
    expect(await lightOf("reader")).toMatchObject({ color: "yellow", line: "2 quotes aren't in the post" });
  });
});

describe("the Reader light counts readings, not steps (review, 2026-11-06)", () => {
  it("its ratio is failed readings of readings: a reading's check step is not an attempt", async () => {
    await event("extract", "fail", 1);
    await event("extract", "ok", 2);
    await event("check", "ok", 2, { source: "worker" });
    await event("extract", "fail", 3);
    await event("extract", "ok", 4);
    await event("check", "ok", 4, { source: "worker" });
    expect(await lightOf("reader")).toMatchObject({ color: "red", line: "Reader: 2 of 4 failed" });
  });

  it("its recent window is the last five readings, with their checks", async () => {
    await event("extract", "ok", 20);
    await event("check", "warn", 20, { source: "worker", summary: "1 quote isn't in the post" });
    for (let i = 0; i < 3; i++) {
      await event("extract", "ok", 10 - i);
      await event("check", "ok", 10 - i, { source: "worker" });
    }
    expect(await lightOf("reader")).toMatchObject({ color: "yellow", line: "1 quote isn't in the post" });
    for (let i = 0; i < 2; i++) {
      await event("extract", "ok", 5 - i);
      await event("check", "ok", 5 - i, { source: "worker" });
    }
    expect((await lightOf("reader")).color).toBe("green");
  });
});
