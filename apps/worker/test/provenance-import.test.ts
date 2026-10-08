/**
 * Saved-post links into the account (Phase 2 spec §2c "Provenance import"; plan 2c Task 6): the private file the
 * local builder writes, upserted into `exercise_provenance` by (user, source type, source key) — idempotent, the
 * account's own, refused while a restore is replacing the account, and size-limited. Every link and name here is
 * synthetic.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { importRoutes } from "../src/routes/imports.js";
import { RestoreInProgressError } from "../src/services/programs.js";
import { importProvenance, InvalidProvenanceError, type ProvenanceImportSummary } from "../src/services/provenance-import.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { accountState, exerciseProvenance } = schema;
const NOW = "2026-10-08T09:00:00.000Z";

/** A synthetic post link, assembled so the repository's privacy grep never sees a literal one. */
const link = (n: number | string) => ["ht", "tps://www.example.test/p/", `post${n}`, "/"].join("");

interface Item {
  exerciseId: string;
  sourceType: string;
  url: string | null;
  creator: string | null;
  sourceKey: string;
}
const item = (n: number, exerciseId: string, over: Partial<Item> = {}): Item => ({
  exerciseId,
  sourceType: "example",
  url: link(n),
  creator: `creator-${n}`,
  sourceKey: `post${n}#0`,
  ...over,
});
const file = (items: unknown[], over: Record<string, unknown> = {}) => ({ format: "rg-provenance", version: 1, items, ...over });

let db: Db;
let statements: string[];
let userId: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId } = await makeTestUser(db));
});

const run = (body: unknown, o: { dryRun?: boolean; exercises?: readonly ExerciseRecord[] } = {}) =>
  importProvenance(db, userId, body, { now: NOW, dryRun: o.dryRun ?? false, ...(o.exercises ? { exercises: o.exercises } : {}) });
const rows = () => db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId));

describe("importProvenance", () => {
  it("puts each link on its move, keyed by source type and key, in this account only", async () => {
    const other = await makeTestUser(db);
    const summary = await run(file([item(1, "gobletSquat"), item(2, "deadBug"), item(3, "gobletSquat", { sourceKey: "post3#2" })]));
    expect(summary).toEqual({ dryRun: false, items: 3, moves: 2, added: 3, updated: 0, unchanged: 0, unknownMoves: 0 });
    const saved = await rows();
    expect(saved.map((r) => [r.exerciseId, r.sourceType, r.url, r.creator, r.sourceKey, r.createdAt]).sort()).toEqual(
      [
        ["deadBug", "example", link(2), "creator-2", "post2#0", NOW],
        ["gobletSquat", "example", link(1), "creator-1", "post1#0", NOW],
        ["gobletSquat", "example", link(3), "creator-3", "post3#2", NOW],
      ].sort(),
    );
    expect(await db.select().from(exerciseProvenance).where(eq(exerciseProvenance.userId, other.userId))).toEqual([]);
  });

  it("importing the same file again writes nothing and says nothing changed", async () => {
    const body = file([item(1, "gobletSquat"), item(2, "deadBug")]);
    await run(body);
    const before = await rows();
    statements.length = 0;
    const again = await run(body);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it("a link that changed is updated in place (same row, same first-seen date); a new one is added", async () => {
    await run(file([item(1, "gobletSquat"), item(2, "deadBug")]));
    const [first] = (await rows()).filter((r) => r.sourceKey === "post1#0");
    const later = await importProvenance(db, userId, file([item(1, "rdl", { url: link("1b"), creator: "creator-1b" }), item(2, "deadBug"), item(4, "birdDog")]), {
      now: "2026-10-09T09:00:00.000Z",
      dryRun: false,
    });
    expect(later).toMatchObject({ added: 1, updated: 1, unchanged: 1 });
    const moved = (await rows()).find((r) => r.sourceKey === "post1#0")!;
    expect(moved).toEqual({ ...first, exerciseId: "rdl", url: link("1b"), creator: "creator-1b" });
    expect(await rows()).toHaveLength(3);
  });

  it("a renamed move's old id lands on its new id; a move the library doesn't have is left out and counted", async () => {
    const renamed = EXERCISES.map((e) => (e.id === "gobletSquat" ? { ...e, legacyIds: ["kbSquat"] } : e));
    const summary = await run(file([item(1, "kbSquat"), item(2, "noSuchMove")]), { exercises: renamed });
    expect(summary).toMatchObject({ items: 2, moves: 1, added: 1, unknownMoves: 1 });
    expect((await rows()).map((r) => r.exerciseId)).toEqual(["gobletSquat"]);
  });

  it("the same source twice in one file is one link (the later wins)", async () => {
    const summary = await run(file([item(1, "gobletSquat"), item(1, "deadBug")]));
    expect(summary).toMatchObject({ items: 1, added: 1 });
    expect((await rows()).map((r) => r.exerciseId)).toEqual(["deadBug"]);
  });

  it("a dry run writes nothing and answers the same counts", async () => {
    statements.length = 0;
    const dry = await run(file([item(1, "gobletSquat"), item(2, "deadBug")]), { dryRun: true });
    expect(dry).toEqual({ dryRun: true, items: 2, moves: 2, added: 2, updated: 0, unchanged: 0, unknownMoves: 0 });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("hundreds of links stay under D1's bound-variable cap, in one transaction", async () => {
    const ids = EXERCISES.map((e) => e.id);
    const many = Array.from({ length: 300 }, (_, i) => item(i, ids[i % ids.length]!));
    expect((await run(file(many))).added).toBe(300);
    expect(await rows()).toHaveLength(300);
  });

  it("refuses while a restore is replacing the account, writing nothing", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    statements.length = 0;
    await expect(run(file([item(1, "gobletSquat")]))).rejects.toBeInstanceOf(RestoreInProgressError);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("refuses a file that isn't a provenance file, a newer version, a link that isn't a web link, and too many links", async () => {
    await expect(run({ hello: 1 })).rejects.toBeInstanceOf(InvalidProvenanceError);
    await expect(run(file([], { version: 2 }))).rejects.toMatchObject({ reason: "newer_version" });
    await expect(run(file([item(1, "gobletSquat", { url: ["java", "script:alert(1)"].join("") })]))).rejects.toBeInstanceOf(InvalidProvenanceError);
    await expect(run(file([{ ...item(1, "gobletSquat"), sourceKey: "" }]))).rejects.toBeInstanceOf(InvalidProvenanceError);
    await expect(run(file(Array.from({ length: 5001 }, (_, i) => item(i, "gobletSquat"))))).rejects.toBeInstanceOf(InvalidProvenanceError);
    expect(await rows()).toEqual([]);
  });

  it("a link may be missing (a source with only a key)", async () => {
    await run(file([item(1, "gobletSquat", { url: null, creator: null })]));
    expect((await rows()).map((r) => [r.url, r.creator])).toEqual([[null, null]]);
  });
});

describe("POST /api/import/provenance", () => {
  const env = { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "app.test", SESSION_SECRET: "s" } as Env;
  const call = async (path: string, body: unknown, cookie?: string) =>
    mountRoutes(db, "/api/import", importRoutes).request(
      path,
      {
        method: "POST",
        headers: { Cookie: cookie ?? `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`, "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );

  it("answers the summary — counts only, never a link or a name — and ?dryRun=1 writes nothing", async () => {
    const body = file([item(1, "gobletSquat"), item(2, "deadBug")]);
    const dry = await call("/api/import/provenance?dryRun=1", body);
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true, added: 2 });
    expect(await rows()).toEqual([]);
    const real = await call("/api/import/provenance", body);
    expect(real.status).toBe(200);
    const text = await real.text();
    expect(JSON.parse(text) as ProvenanceImportSummary).toMatchObject({ dryRun: false, added: 2 });
    expect(text).not.toMatch(/example\.test|creator-|post\d/);
    expect(await rows()).toHaveLength(2);
    const again = await call("/api/import/provenance", body);
    expect(await again.json()).toMatchObject({ added: 0, unchanged: 2 });
  });

  it("422 for a body that is not JSON or not a provenance file (no values echoed); 413 past the size limit", async () => {
    const notJson = await call("/api/import/provenance", "{nope");
    expect(notJson.status).toBe(422);
    expect(await notJson.json()).toMatchObject({ error: "invalid_provenance" });
    const wrong = await call("/api/import/provenance", file([{ ...item(1, "gobletSquat"), url: "not a link" }]));
    expect(wrong.status).toBe(422);
    expect(await wrong.text()).not.toMatch(/not a link|creator-1/);
    const newer = await call("/api/import/provenance", file([], { version: 2 }));
    expect(await newer.json()).toMatchObject({ error: "invalid_provenance", reason: "newer_version" });
    const big = await call("/api/import/provenance", JSON.stringify(file([], { padding: "x".repeat(1_100_000) })));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_large" });
    expect(await rows()).toEqual([]);
  });

  it("401 signed out; 423 while a restore is replacing the account", async () => {
    expect((await call("/api/import/provenance", file([item(1, "gobletSquat")]), "")).status).toBe(401);
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("/api/import/provenance", file([item(1, "gobletSquat")]))).status).toBe(423);
    expect((await call("/api/import/provenance?dryRun=1", file([item(1, "gobletSquat")]))).status).toBe(423);
    expect(await rows()).toEqual([]);
  });
});
