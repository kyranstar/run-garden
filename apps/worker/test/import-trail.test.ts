/**
 * The import trail's collector (design 2026-11-05 §6.1–6.2): a stage's events and blobs become statements that run in
 * the stage's own batch, so a trail row is written with the state change it describes. Sizes are bounded, never failing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { runAtomically } from "../src/services/db.js";
import { BLOB_MAX, EVENT_DETAIL_MAX, promptVersionStatement, SUMMARY_MAX, trailStatements } from "../src/services/import-trail.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { importEvents, importBlobs, promptVersions } = schema;
const AT = "2026-11-05T10:00:00.000Z";
let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

describe("trailStatements", () => {
  it("two events and a blob are two statements: one multi-row insert of events, one of the blob", async () => {
    const stmts = trailStatements(db, userId, "post1", [
      { stage: "screen", source: "gateway", status: "ok", summary: "Kept: a mobility routine", detail: { verdict: "training" }, blobs: [{ kind: "raw_reply", text: '{"verdict":"training"}' }] },
      { stage: "extract", source: "gateway", status: "fail", summary: "The reply was cut off", attempt: 1, model: "m", promptVersion: "extract-4", costMicros: 12, latencyMs: 900, usageId: "u1" },
    ], AT);
    expect(stmts).toHaveLength(2);
    await runAtomically(db, stmts);
    const events = await db.select().from(importEvents);
    expect(events.map((e) => [e.stage, e.status, e.postId, e.userId, e.rebuilt])).toEqual([
      ["screen", "ok", "post1", userId, false],
      ["extract", "fail", "post1", userId, false],
    ]);
    expect(events[1]).toMatchObject({ attempt: 1, model: "m", promptVersion: "extract-4", costMicros: 12, latencyMs: 900, usageId: "u1", at: AT });
    const [blob] = await db.select().from(importBlobs);
    expect(blob).toMatchObject({ kind: "raw_reply", text: '{"verdict":"training"}', postId: "post1", eventId: events[0]!.id, cut: false });
  });

  it("a detail over 64,000 characters keeps a head in the event and its whole in a detail blob", async () => {
    const big = { text: "x".repeat(EVENT_DETAIL_MAX + 10) };
    await runAtomically(db, trailStatements(db, userId, "p", [{ stage: "match", source: "worker", status: "ok", summary: "s", detail: big }], AT));
    const [e] = await db.select().from(importEvents);
    expect(e!.detail).toMatchObject({ cut: true });
    expect(JSON.stringify(e!.detail).length).toBeLessThan(EVENT_DETAIL_MAX);
    const [b] = await db.select().from(importBlobs);
    expect(b!.kind).toBe("detail");
    expect(JSON.parse(b!.text)).toEqual(big);
  });

  it("a blob over 1,000,000 characters is cut there and says so", async () => {
    await runAtomically(db, trailStatements(db, userId, "p", [
      { stage: "extract", source: "gateway", status: "ok", summary: "s", blobs: [{ kind: "raw_reply", text: "y".repeat(BLOB_MAX + 5) }] },
    ], AT));
    const [b] = await db.select().from(importBlobs);
    expect(b!.text.length).toBe(BLOB_MAX);
    expect(b!.cut).toBe(true);
  });

  it("a summary is one line of at most 300 characters, cut at a word with an ellipsis", async () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    await runAtomically(db, trailStatements(db, userId, "p", [{ stage: "screen", source: "gateway", status: "ok", summary: `line one\n${long}` }], AT));
    const [e] = await db.select().from(importEvents);
    expect(e!.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(e!.summary.endsWith("…")).toBe(true);
    expect(e!.summary).not.toContain("\n");
    expect(e!.summary.slice(0, -1)).toMatch(/word\d+$/);
  });

  it("nine events chunk under the 100 bound parameters: three statements of at most four rows", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ stage: "check" as const, source: "worker" as const, status: "ok" as const, summary: `e${i}` }));
    const stmts = trailStatements(db, userId, "p", nine, AT);
    expect(stmts).toHaveLength(3);
    await runAtomically(db, stmts);
    expect(await db.select().from(importEvents)).toHaveLength(9);
  });

  it("nothing to write is no statement", () => {
    expect(trailStatements(db, userId, "p", [], AT)).toEqual([]);
  });
});

describe("promptVersionStatement", () => {
  it("writes a version's system text once; a second first-use changes nothing", async () => {
    await runAtomically(db, [promptVersionStatement(db, "filter-1", "filter", "system one", AT)]);
    await runAtomically(db, [promptVersionStatement(db, "filter-1", "filter", "system two", "2026-11-06T00:00:00.000Z")]);
    expect(await db.select().from(promptVersions)).toEqual([{ version: "filter-1", kind: "filter", systemText: "system one", firstUsedAt: AT }]);
  });
});
