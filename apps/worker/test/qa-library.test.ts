/**
 * THE QA ACCOUNT'S LIBRARY (R1.4; the lead's v0.23: "Extend isolated QA with synthetic templates for take-back timing, Do it
 * now and background egress; never attach the owner's provider accounts"). The seed gives the fixtures-only QA account two
 * saved templates, QA-named as its sessions are, so LifeOS QA can run *Put it on…*, *Do it now*, *Take back* and the
 * receipt reads on its own phone:
 *  - `QA Quick reset`, under ten minutes; `QA Hold series`, timed-hold mobility;
 *  - no provider is ever attached: nothing fetched, no watch job, no calendar link, and every receipt's compensation an
 *    empty list (there is no provider work to wait for), so take-back timing here is the phone's and the server's only;
 *  - the harness's state names them (and the account's receipts), and the purge leaves zero rows.
 * Synthetic data only; the owner's account is checked untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays } from "@rg/domain";
import { sha256Hex } from "../src/auth/crypto.js";
import { nativeRoutes } from "../src/routes/native.js";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { qaRoutes } from "../src/routes/qa.js";
import { QA_TEMPLATES } from "../src/services/qa-account.js";
import { tableHashes } from "../src/services/parity.js";
import { pinMiddayToday } from "./helpers.js";
import { nativeWorld, type NativeWorld } from "./native-fixture.js";

const { calendarEventLinks, corosWriteJobs, syncIntents, workoutTemplates } = schema;
const STATEMENT_BUDGET = 45;

let today: string;
let w: NativeWorld;
let fetched: string[];

beforeEach(async () => {
  today = pinMiddayToday();
  fetched = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    throw new Error("no external call in the QA account's tests");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/qa", qaRoutes],
      ["/api/native", nativeRoutes],
      ["/api/native", nativeLibraryRoutes],
      ["/api/native", nativeTakeBackRoutes],
    ],
    { env: { LIFEOS_TOKEN_SHA256: await sha256Hex("a".repeat(64)), WATCH_PUSH_ENABLED: "1" } },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The QA account made and seeded, and its phone paired (the owner's QA code): its device token and the harness token. */
async function qaPhone(): Promise<{ token: string; harness: string; userId: string }> {
  expect((await w.call("POST", "/api/qa/user")).status).toBe(201);
  const seeded = await w.call("POST", "/api/qa/seed");
  expect(seeded.status, seeded.text).toBe(200);
  expect(seeded.statements.length, "the seed, its templates included").toBeLessThanOrEqual(STATEMENT_BUDGET);
  const minted = await w.call("POST", "/api/qa/pairings");
  const paired = await w.call("POST", "/api/native/pair", { cookie: false, body: { code: minted.json.code, label: "LifeOS QA" } });
  expect(paired.status, paired.text).toBe(200);
  const state = await w.call("GET", "/api/qa/state");
  return { token: paired.json.token as string, harness: minted.json.harnessToken as string, userId: state.json.userId as string };
}
const phone = (token: string, method: string, path: string, body?: unknown) =>
  w.call(method, `/api/native${path}`, { bearer: token, ...(body === undefined ? {} : { body }) });

describe("the QA account's library (R1.4)", () => {
  it("has two synthetic templates, QA-named: one under ten minutes, one of timed holds; the owner's has none", async () => {
    const before = await tableHashes(w.db, w.userId);
    const { token } = await qaPhone();
    const list = await phone(token, "GET", "/templates");
    expect(list.status, list.text).toBe(200);
    const templates = list.json.templates as Array<{ id: string; name: string; minutes: number; discipline: string }>;
    expect(templates.map((t) => t.name).sort()).toEqual(QA_TEMPLATES.map((t) => t.name).sort());
    expect(templates.every((t) => t.name.startsWith("QA "))).toBe(true);
    const quick = templates.find((t) => t.name === "QA Quick reset")!;
    expect(quick.minutes).toBeLessThan(10);
    const holds = await phone(token, "GET", `/templates/${templates.find((t) => t.name === "QA Hold series")!.id}`);
    expect(holds.status, holds.text).toBe(200);
    // Timed holds: every item's dose a hold in seconds (the device's *What's in it* says it in words).
    const items = (holds.json.doc.parts as Array<{ items: Array<{ dose: Record<string, unknown> }> }>).flatMap((p) => p.items);
    expect(items.length).toBe(2);
    expect(items.every((i) => typeof i.dose.holdSec === "number")).toBe(true);
    expect((holds.json.moves as unknown[]).length).toBe(2);
    // Mobility, in the library's own discipline word.
    expect(holds.json.discipline).toBe("yoga");
    // The owner's account is as it was, and has no template.
    expect(await tableHashes(w.db, w.userId)).toEqual(before);
    expect(await w.db.select().from(workoutTemplates).where(eq(workoutTemplates.userId, w.userId))).toEqual([]);
  });

  it("Put it on…, Do it now, Take back and the receipt reads: no provider, so no compensation and nothing fetched", async () => {
    const { token, userId } = await qaPhone();
    const listed = (await phone(token, "GET", "/templates")).json.templates as Array<{ id: string; name: string }>;
    const quick = listed.find((t) => t.name === "QA Quick reset");
    const holds = listed.find((t) => t.name === "QA Hold series");
    // Put it on… tomorrow at 18:00.
    const placed = await phone(token, "POST", `/templates/${quick!.id}/place`, { date: addDays(today, 1), time: "18:00", clientId: "qa-put-1" });
    expect(placed.status, placed.text).toBe(201);
    expect(placed.statements.length).toBeLessThanOrEqual(STATEMENT_BUDGET);
    const read = await phone(token, "GET", `/receipts/${placed.json.receiptId}`);
    expect([read.status, read.json.status, read.json.compensation], read.text).toEqual([200, "open", []]);
    // Take back: taken back at once, with nothing for a provider to do.
    const back = await phone(token, "POST", "/take-back", { receiptIds: [placed.json.receiptId], requestId: "qa-tb-1" });
    expect([back.status, back.json.outcomes?.[0]?.outcome, back.json.outcomes?.[0]?.compensation], back.text).toEqual([200, "taken_back", []]);
    const after = await phone(token, "GET", `/receipts/${placed.json.receiptId}`);
    expect([after.json.status, after.json.compensation]).toEqual(["taken_back", []]);
    // Do it now: today, untimed (the next quarter hour, pinned).
    const now = await phone(token, "POST", `/templates/${holds!.id}/place`, { date: today, clientId: "qa-now-1" });
    expect([now.status, now.json.date, typeof now.json.time], now.text).toEqual([201, today, "string"]);
    expect((await phone(token, "GET", `/receipts/${now.json.receiptId}`)).json.compensation).toEqual([]);
    // Nothing reached a provider.
    expect(fetched).toEqual([]);
    expect(await w.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).toEqual([]);
    expect(await w.db.select().from(calendarEventLinks)).toEqual([]);
    const state = await w.call("GET", "/api/qa/state");
    expect(state.json.providers).toMatchObject({ connections: 0, corosWriteJobs: 0, calendarEventLinks: 0, studioPlanPushes: 0, syncRuns: 0 });
    // Its sync intents are local records only — the mirror's owed marks (`mirror`, which nothing runs with COROS writes off)
    // and the take-back's record of its removal (`remove_local`) — none of which reached a provider (above).
    const kinds = new Set((await w.db.select().from(syncIntents).where(eq(syncIntents.userId, userId))).map((i) => i.kind));
    expect([...kinds].every((k) => k === "mirror" || k === "remove_local")).toBe(true);
  });

  it("the harness's state names the templates and the receipts; the purge leaves zero rows", async () => {
    const { token, harness } = await qaPhone();
    const quick = ((await phone(token, "GET", "/templates")).json.templates as Array<{ id: string; name: string }>).find((t) => t.name === "QA Quick reset");
    const placed = await phone(token, "POST", `/templates/${quick!.id}/place`, { date: addDays(today, 1), time: "18:00", clientId: "qa-put-2" });
    const state = await w.call("GET", `/api/qa/run/state`, { cookie: false, headers: { Authorization: `Bearer ${harness}` } });
    expect(state.status, state.text).toBe(200);
    expect(state.statements.length).toBeLessThanOrEqual(STATEMENT_BUDGET);
    expect((state.json.templates as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(QA_TEMPLATES.map((t) => t.name).sort());
    expect((state.json.templates as Array<{ name: string; uses: number }>).find((t) => t.name === "QA Quick reset")!.uses).toBe(1);
    expect(state.json.receipts).toEqual([
      expect.objectContaining({ id: placed.json.receiptId, source: "place", op: "create", status: "open", workoutId: placed.json.workoutId }),
    ]);
    // The purge, step by step, to zero.
    let done = false;
    for (let step = 0; step < 10 && !done; step++) {
      const a = await w.call("POST", "/api/qa/run/purge", { cookie: false, headers: { Authorization: `Bearer ${harness}` }, body: { confirm: "purge qa" } });
      expect(a.status, a.text).toBe(200);
      done = a.json.done === true;
    }
    expect(done).toBe(true);
    const verify = await w.call("GET", "/api/qa/run/verify", { cookie: false, headers: { Authorization: `Bearer ${harness}` } });
    expect(verify.json).toMatchObject({ exists: false, total: 0 });
    expect((verify.json.rows as Record<string, number>).workout_templates).toBe(0);
    expect((verify.json.rows as Record<string, number>).take_back_receipts).toBe(0);
  });
});
