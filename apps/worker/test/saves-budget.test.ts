/**
 * The import's budget: $5 per 30 days, reserved at the worst case then settled, kept apart from the coach's week
 * (llm.ts lanes). Synthetic data only; the clock is pinned.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { devBudgetStatus, llmBudgetStatus } from "../src/services/llm.js";
import { messagesCostMicros } from "../src/services/llm-messages.js";
import { IMPORT_BUDGET_MICROS, IMPORT_KINDS, importSpend, reserveImport, settleImport } from "../src/services/saves-budget.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { llmUsage } = schema;
const NOW = new Date("2026-10-23T12:00:00.000Z");
const MODEL = "google/gemini-3.6-flash";

let db: Db;
let userId: string;

async function row(kind: string, costMicros: number, at: Date, fingerprint: string | null = null, user = userId) {
  await db.insert(llmUsage).values({
    id: newId(),
    userId: user,
    kind,
    model: MODEL,
    inputTokens: 1,
    outputTokens: 1,
    costMicros,
    cacheHit: false,
    requestFingerprint: fingerprint,
    createdAt: at.toISOString(),
  });
}

beforeEach(async () => {
  db = makeTestDb();
  userId = (await makeTestUser(db)).userId;
});

describe("the import budget", () => {
  it("refuses a reservation that would pass the cap, and takes one that fits", async () => {
    await row(IMPORT_KINDS.extract, 4_990_000, NOW);
    expect(await importSpend(db, userId, NOW)).toEqual({ spentMicros: 4_990_000, capMicros: IMPORT_BUDGET_MICROS });
    expect(await reserveImport(db, userId, IMPORT_KINDS.match, MODEL, 20_000, NOW)).toEqual({ ok: false, reason: "budget_paused" });
    const ok = await reserveImport(db, userId, IMPORT_KINDS.match, MODEL, 10_000, NOW);
    expect(ok.ok).toBe(true);
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(5_000_000);
  });

  it("settles to the actual cost, and a null settle zeroes the row", async () => {
    const r = await reserveImport(db, userId, IMPORT_KINDS.filter, MODEL, 300_000, NOW);
    if (!r.ok) throw new Error("reserve");
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(300_000);
    await settleImport(db, r.usageId, { model: MODEL, inputTokens: 100, outputTokens: 50, costMicros: 1_234 });
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(1_234);
    const [settled] = await db.select().from(llmUsage).where(eq(llmUsage.id, r.usageId));
    expect(settled).toMatchObject({ inputTokens: 100, outputTokens: 50, costMicros: 1_234, requestFingerprint: null });
    const r2 = await reserveImport(db, userId, IMPORT_KINDS.filter, MODEL, 300_000, NOW);
    if (!r2.ok) throw new Error("reserve");
    await settleImport(db, r2.usageId, null);
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(1_234);
  });

  it("counts only 30 days, only this user, only import kinds", async () => {
    await row(IMPORT_KINDS.extract, 1_000_000, new Date(NOW.getTime() - 31 * 86_400_000));
    await row(IMPORT_KINDS.extract, 2_000_000, new Date(NOW.getTime() - 29 * 86_400_000));
    await row("coach_wake", 3_000_000, NOW);
    const other = (await makeTestUser(db)).userId;
    await row(IMPORT_KINDS.extract, 4_000_000, NOW, null, other);
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(2_000_000);
  });

  it("counts a reservation stale for 15 minutes at its estimate, a fresh one at its worst case", async () => {
    await row(IMPORT_KINDS.extract, 900_000, new Date(NOW.getTime() - 16 * 60_000), "import:x;est=40000");
    await row(IMPORT_KINDS.match, 700_000, new Date(NOW.getTime() - 5 * 60_000), "import:y;est=10000");
    expect((await importSpend(db, userId, NOW)).spentMicros).toBe(40_000 + 700_000);
  });
});

describe("the import lane is not the coach's", () => {
  it("llmBudgetStatus and the dev lane ignore import rows", async () => {
    await row(IMPORT_KINDS.extract, 19_000_000, new Date(Date.now()));
    await row(IMPORT_KINDS.match, 3_000_000, new Date(Date.now() - 60 * 60_000), "import:z;est=1");
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(0);
    expect((await devBudgetStatus(db, userId)).spentMicros).toBe(0);
    await row("coach_wake", 1_000_000, new Date(Date.now()));
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(1_000_000);
  });
});

describe("the Gemini prices", () => {
  it("are listed, not the ceiling", () => {
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 };
    expect(messagesCostMicros("google/gemini-3.6-flash", usage)).toBe(4_500_000);
    expect(messagesCostMicros("google/gemini-3.1-flash-lite", usage)).toBe(1_750_000);
  });
});
