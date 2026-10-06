/**
 * Heavy rows: a session build carries 107–142 KB of JSON (Phase 2a ledger), so a page sized in ROWS — 500 for the
 * export, 200 for a restore request, 200 for a copier step, 500 for a table hash — holds tens of megabytes and
 * blows the Worker's CPU and memory (audit 2a-model I3). Ruling 2a-R9: pages are budgeted in BYTES on every path,
 * and a table hash is digested incrementally.
 *
 * The ceiling asserted here: no page carries more than 256 KB of rows unless it is a single row (a row cannot be
 * split).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { canonicalJson, hashTable, wipeAccountData } from "../src/services/account-tables.js";
import { exportTablePage } from "../src/services/account-export.js";
import { checkRestorePage, openCheckSession } from "../src/services/account-restore.js";
import { copyFinished, copyStep, initialCopyState, verifyCopy } from "../src/copier/copy.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { heavyPayload, seedHeavyBuilds } from "./heavy-payload.js";
import { exportAll, manifestOf, restoreAll, TEST_SECRET } from "./restore-driver.js";

const CEILING = 256 * 1024;
/** What the restore client sends per request (`RESTORE_PAGE_BYTES` in @rg/api-client). */
const CLIENT_RESTORE_BYTES = 192 * 1024;

type Row = Record<string, unknown>;

/** A page is within the ceiling, or a single row. */
function withinCeiling(rows: Row[]): boolean {
  return rows.length === 1 || canonicalJson(rows).length <= CEILING;
}

async function exportPages(db: Db, userId: string, table: string): Promise<Row[][]> {
  const pages: Row[][] = [];
  let cursor: string | null = null;
  do {
    const page = await exportTablePage(db, userId, table, cursor);
    pages.push(page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

describe("heavy rows are paged by bytes (Ruling 2a-R9)", () => {
  it("the export pages session_builds within the byte ceiling, and export → restore → export is identical", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const ids = await seedHeavyBuilds(db, userId, 9);

    const pages = await exportPages(db, userId, "session_builds");
    expect(pages.flat().map((r) => r.id)).toEqual(ids);
    expect(pages.length).toBeGreaterThanOrEqual(5);
    for (const page of pages) expect(withinCeiling(page), `${page.length} rows, ${canonicalJson(page).length} bytes`).toBe(true);

    const before = await exportAll(db, userId);
    await wipeAccountData(db, userId, { keep: ["users", "sessions", "provider_connections"] });
    expect(await db.select().from(schema.sessionBuilds)).toEqual([]);

    const sent: Row[][] = [];
    const outcome = await restoreAll(db, userId, before, { maxBytes: CLIENT_RESTORE_BYTES, onPage: (_t, rows) => sent.push(rows) });
    expect(outcome.counts.session_builds).toBe(9);
    expect(outcome.short).toEqual([]);
    for (const page of sent) expect(withinCeiling(page)).toBe(true);
    expect(sent.filter((p) => p.some((r) => typeof r.payload === "object")).length).toBeGreaterThanOrEqual(5);

    const after = await exportAll(db, userId);
    expect(after.tables.session_builds).toEqual(before.tables.session_builds);
  });

  it("the restore check refuses a page of many heavy rows (a client from before the budget), and takes one alone", async () => {
    // The server's ceiling (1 MB) sits above the client's 192 KB so an older client's 200-row pages of ordinary
    // rows still restore; nine build payloads in one page do not.
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await seedHeavyBuilds(db, userId, 9);
    const file = await exportAll(db, userId);
    const ctx = { userId, secret: TEST_SECRET };
    const opened = await openCheckSession(
      { schemaVersion: file.schemaVersion, manifest: manifestOf(file), sourceUserId: userId, exportedAt: file.exportedAt },
      ctx,
    );
    if (!opened.ok) throw new Error("check session refused");
    const rows = file.tables.session_builds!;
    expect(rows).toHaveLength(9);

    const whole = await checkRestorePage({ session: opened.session, table: "session_builds", rows, offset: 0 }, ctx);
    expect(whole).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "page_too_large" })] });
    const one = await checkRestorePage({ session: opened.session, table: "session_builds", rows: rows.slice(0, 1), offset: 0 }, ctx);
    expect(one).toMatchObject({ ok: true, rows: 1 });
  });

  it("a copier step stops at the byte budget, and verify agrees on the heavy table", async () => {
    const src = makeTestDb({ boundVariableCap: 100 });
    const dst = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(src);
    await seedHeavyBuilds(src, userId, 7);

    let state = initialCopyState();
    const perStep: number[] = [];
    let copied = 0;
    for (let i = 0; i < 200 && !copyFinished(state); i++) {
      state = await copyStep(src, dst, state, { maxRows: 200 });
      const n = (await dst.select({ id: schema.sessionBuilds.id }).from(schema.sessionBuilds)).length;
      perStep.push(n - copied);
      copied = n;
    }
    expect(copyFinished(state)).toBe(true);
    expect(copied).toBe(7);
    expect(Math.max(...perStep)).toBeLessThanOrEqual(2);

    const [check] = await verifyCopy(src, dst, { tables: ["session_builds"] });
    expect(check).toMatchObject({ ok: true, srcRows: 7, dstRows: 7 });
  });

  it("a table hash reads a heavy table in byte-sized pages; equal tables hash equal, one changed payload does not", async () => {
    const reads: string[] = [];
    const a = makeTestDb({ boundVariableCap: 100, onStatement: (s) => /from "session_builds"/.test(s) && /"locked_at"/.test(s) && reads.push(s) });
    const b = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(a);
    await seedHeavyBuilds(a, userId, 7);
    for (const row of await a.select().from(schema.sessionBuilds)) await b.insert(schema.sessionBuilds).values(row);

    reads.length = 0;
    const ha = await hashTable(a, schema.sessionBuilds);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    const hb = await hashTable(b, schema.sessionBuilds);
    expect(ha).toEqual(hb);
    expect(ha.rows).toBe(7);
    // The digest depends on the rows only, never on how they were paged in.
    expect(await hashTable(b, schema.sessionBuilds, { pageSize: 1 })).toEqual(ha);
    expect(await hashTable(b, schema.sessionBuilds, { pageSize: 3 })).toEqual(ha);

    const [first] = await b.select({ id: schema.sessionBuilds.id }).from(schema.sessionBuilds).limit(1);
    await b.update(schema.sessionBuilds).set({ payload: heavyPayload(99) }).where(eq(schema.sessionBuilds.id, first!.id));
    expect((await hashTable(b, schema.sessionBuilds)).sha256).not.toBe(ha.sha256);
  });
});
