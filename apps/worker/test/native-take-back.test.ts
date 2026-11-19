/**
 * TAKE-BACK AND SWITCH A AT THE GATE (R1; DESIGN-3 §3.5 pairs 6–7, §3.12; CALLS C1).
 *
 * Pinned: `POST /api/native/take-back` and `GET /api/native/receipts/:id` — a v4 phone 403, a v5 phone and the laptop's
 * cookie 200, a body outside its shape 403 at the gate (400 on the cookie path), the take-back 423 during a restore and the
 * receipt's read 503. Switch A: off for a new phone; set only by the phone itself (a cookie is 403 device_only), exactly its
 * keys, audited; a step-down from v5 turns it off in the same transaction, so a grant back starts off. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { nativeRoutes } from "../src/routes/native.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, auditEvents, nativeDeviceSharing, takeBackReceipts } = schema;

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld([
    ["/api/native", nativeTakeBackRoutes],
    ["/api/native", nativeRoutes],
  ]);
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() });
});
afterEach(() => vi.unstubAllGlobals());

const body = { receiptIds: ["tb_none"], requestId: "req-1" };

describe("take-back at the gate", () => {
  it("v4 403, v5 and the cookie 200; a body outside the shape 403 at the gate, 400 on the cookie path", async () => {
    const v4 = await seedDevice(w.db, w.userId, { scope: "training-v4", lastUsedAt: nowInstant() });
    expect((await w.call("POST", "/api/native/take-back", { bearer: v4.token, body })).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("GET", "/api/native/receipts/tb_none", { bearer: v4.token })).json).toEqual({ error: "out_of_scope" });
    for (const opts of [{ bearer: v5.token }, {}]) {
      const a = await w.call("POST", "/api/native/take-back", { ...opts, body });
      expect([a.status, a.json]).toEqual([200, { requestId: "req-1", outcomes: [{ receiptId: "tb_none", outcome: "not_found" }], remaining: [] }]);
      expect((await w.call("GET", "/api/native/receipts/tb_none", opts)).status).toBe(404);
    }
    expect((await w.call("POST", "/api/native/take-back", { bearer: v5.token, body: { ...body, all: true } })).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("POST", "/api/native/take-back", { body: { ...body, all: true } })).json.error).toBe("bad_take_back");
    expect((await w.call("POST", "/api/native/take-back", { body: { receiptIds: Array.from({ length: 13 }, (_, i) => `tb_${i}`), requestId: "r" } })).json.error).toBe("bad_take_back");
  });

  it("during a restore the take-back is 423 and the receipt's read 503; nothing written", async () => {
    await w.db.insert(takeBackReceipts).values({ id: "tb_1", userId: w.userId, source: "place", sourceKey: "k", madeBy: "session", workoutId: "w-1", op: "create", groupId: "tb_1", postState: "{}", createdAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const a = await w.call("POST", "/api/native/take-back", { bearer: v5.token, body: { receiptIds: ["tb_1"], requestId: "req-r" } });
    expect([a.status, a.json, a.writes]).toEqual([423, { error: "restore_in_progress" }, []]);
    expect((await w.call("GET", "/api/native/receipts/tb_1", { bearer: v5.token })).json).toEqual({ error: "restore_in_progress", retryable: true });
    expect((await w.db.select().from(takeBackReceipts))[0]!.status).toBe("open");
  });
});

describe("switch A: GET and PUT /api/native/sharing", () => {
  const get = (bearer = v5.token) => w.call("GET", "/api/native/sharing", { bearer });
  const put = (b: unknown, bearer = v5.token) => w.call("PUT", "/api/native/sharing", { bearer, body: b });

  it("off for a new phone; on and off again from the phone, each with its words' version and an audit row", async () => {
    expect((await get()).json).toEqual({ toTraining: false, disclosureVersion: null, setAt: null });
    expect((await get()).headers["cache-control"]).toBe("no-store");
    const on = await put({ toTraining: true, disclosureVersion: "2026-11-19.1" });
    expect([on.status, on.json]).toEqual([200, { toTraining: true, disclosureVersion: "2026-11-19.1", setAt: expect.any(String) }]);
    expect((await get()).json.toTraining).toBe(true);
    expect((await put({ toTraining: false, disclosureVersion: "2026-11-19.1" })).json.toTraining).toBe(false);
    const audits = await w.db.select().from(auditEvents).where(eq(auditEvents.kind, "native_device_sharing_set"));
    expect(audits.map((a) => a.detail)).toEqual([
      { deviceId: v5.id, toTraining: true, disclosureVersion: "2026-11-19.1" },
      { deviceId: v5.id, toTraining: false, disclosureVersion: "2026-11-19.1" },
    ]);
  });

  it("the phone's own: a cookie is 403 device_only; another phone's switch is its own; keys outside the shape are refused", async () => {
    expect((await w.call("GET", "/api/native/sharing")).json).toEqual({ error: "device_only" });
    expect((await w.call("PUT", "/api/native/sharing", { body: { toTraining: true, disclosureVersion: "1" } })).json).toEqual({ error: "device_only" });
    const other = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() });
    await put({ toTraining: true, disclosureVersion: "1" });
    expect((await get(other.token)).json.toTraining).toBe(false);
    for (const b of [{ toTraining: true }, { toTraining: "on", disclosureVersion: "1" }, { toTraining: true, disclosureVersion: "1", fromTraining: true }]) {
      expect((await put(b)).json).toEqual({ error: "out_of_scope" });
    }
    const v4 = await seedDevice(w.db, w.userId, { scope: "training-v4", lastUsedAt: nowInstant() });
    expect((await get(v4.token)).json).toEqual({ error: "out_of_scope" });
  });

  it("a step-down from v5 turns it off in the same transaction; granted v5 again, it is still off", async () => {
    await put({ toTraining: true, disclosureVersion: "1" });
    const down = await w.call("POST", `/api/native/devices/${v5.id}/reduce`, { body: { scope: "training-v4" } });
    expect(down.json).toEqual({ ok: true, scope: "training-v4", reduced: true });
    expect((await w.db.select().from(nativeDeviceSharing))[0]!.toTraining).toBe(false);
    await w.call("POST", `/api/native/devices/${v5.id}/grant`, { body: { scope: "training-v5" } });
    expect((await get()).json.toTraining).toBe(false);
  });
});
