/**
 * D1 refuses a compound SELECT of more than five terms ("too many terms in compound SELECT", measured on wrangler's
 * local D1); better-sqlite3 allows 500. A test database made as strict as D1 about binds (`boundVariableCap`) refuses
 * the same, so a query that would fail in production fails here first.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { compoundTerms, D1_BIND_LIMIT, makeTestDb } from "./helpers.js";

const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i + 1} AS x`).join(" UNION ALL ");

describe("D1's compound SELECT limit in the test database", () => {
  it("counts the terms of each compound SELECT on its own: a subquery's, a CTE's, the outer one's", () => {
    expect(compoundTerms(union(6))).toBe(6);
    expect(compoundTerms(`WITH a AS (${union(5)}) SELECT * FROM (${union(4)}) UNION ALL SELECT * FROM a`)).toBe(5);
    // Words in strings and comments are not terms — and an apostrophe in a comment opens no string.
    expect(compoundTerms(`SELECT 'UNION UNION' -- UNION ALL\nUNION ALL SELECT 2`)).toBe(2);
    expect(compoundTerms(`-- the entry's first set\n${union(6)} -- it's`)).toBe(6);
  });

  it("refuses six terms and takes five, or more nested five at a time", async () => {
    const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
    expect(() => db.all(sql.raw(union(6)))).toThrow("too many terms in compound SELECT");
    expect(await db.all(sql.raw(union(5)))).toHaveLength(5);
    expect(await db.all(sql.raw(`SELECT * FROM (${union(4)}) UNION ALL SELECT * FROM (${union(4)})`))).toHaveLength(8);
  });
});
