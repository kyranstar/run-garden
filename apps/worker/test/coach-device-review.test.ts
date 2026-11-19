/**
 * R1 REVIEW A'S MINORS AND NITS, AND ITS SURVIVING MUTANTS, PINNED:
 *  - MINOR-3: a told note is held to the words the owner accepted, as a frame is: `{kind, body, clientId, consent}`
 *    exactly, the consent the very version stored, else 409 `sharing_off`;
 *  - MINOR-5 (mutant B1): on staging, where the designer stays on whatever the QA env clears, the QA account's phone is
 *    still 404 `coach_off` on every coach route;
 *  - NIT 8 (mutant B10): a phone's run create with no model to call is 404 `coach_off`, and nothing starts;
 *  - NIT 7 (mutants G8, G9): a key the sharing or the told-note body doesn't take is refused at the gate (403);
 *  - NIT 6 (mutant S7): the first-ever choice stored as made — off is stored off — and answered as stored;
 *  - NIT 3: turning switch A off lands during a restore (turning it on waits: 423);
 *  - NIT 1: `bad_frame` never echoes what it was sent;
 *  - NIT 2: a saved workout's read names no condition (its derived `conditionMax`).
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { purgeExpiredNativeRows } from "../src/auth/native-devices.js";
import { QA_EMAIL } from "../src/auth/qa-identity.js";
import { coachRoutes } from "../src/routes/coach.js";
import { coachConversationRoutes } from "../src/routes/coach-conversation.js";
import { coachNudgesRoutes } from "../src/routes/coach-nudges.js";
import { coachRunRoutes } from "../src/routes/coach-runs.js";
import { nativeRoutes } from "../src/routes/native.js";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, coachMemory, coachRuns, llmUsage, nativeDeviceSharing, userConditions, users, workoutTemplates } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-19";
const NOW = DateTime.fromISO(`${T}T07:40`, { zone: LA }).toUTC().toISO()!;

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", (async () => {
    throw new Error("no model call");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/coach/runs", coachRunRoutes],
      ["/api/coach/conversation", coachConversationRoutes],
      ["/api/coach/nudges", coachNudgesRoutes],
      ["/api/coach", coachRoutes],
      ["/api/native", nativeRoutes],
      ["/api/native", nativeLibraryRoutes],
    ],
    { env: { COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sharing = (body: Record<string, unknown>, bearer = v5.token) => w.call("PUT", "/api/native/sharing", { bearer, body });
const tell = (body: Record<string, unknown>) => w.call("POST", "/api/coach/memory", { bearer: v5.token, body });

describe("a told note is held to the words the owner accepted (MINOR-3)", () => {
  it("the stored version: 201; another, or none, refused; nothing kept", async () => {
    expect((await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" })).status).toBe(200);
    const stale = await tell({ kind: "note", body: "Knees ache on stairs.", clientId: "c-1", consent: "2026-11-01.1" });
    expect([stale.status, stale.json.error]).toEqual([409, "sharing_off"]);
    expect((await tell({ kind: "note", body: "Knees ache on stairs.", clientId: "c-1" })).status).toBe(403);
    expect(await w.db.select().from(coachMemory)).toEqual([]);
    const ok = await tell({ kind: "note", body: "Knees ache on stairs.", clientId: "c-1", consent: "2026-11-19.1" });
    expect(ok.status, ok.text).toBe(201);
    expect(Object.keys(ok.json.item).sort()).toEqual(["body", "confidence", "expiresAt", "id", "kind", "learnedAt", "pinned", "source"]);
  });

  it("a key the body doesn't take is refused at the gate (G9)", async () => {
    await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" });
    const a = await tell({ kind: "note", body: "Knees ache.", clientId: "c-2", consent: "2026-11-19.1", pinned: true });
    expect([a.status, a.json.error]).toEqual([403, "out_of_scope"]);
  });
});

describe("switch A's writes (NIT 3, 6, 7)", () => {
  it("S7: the first-ever choice, off, is stored off — and answered as stored", async () => {
    const a = await sharing({ toTraining: false, disclosureVersion: "2026-11-19.1" });
    expect(a.status).toBe(200);
    const [row] = await w.db.select().from(nativeDeviceSharing).where(eq(nativeDeviceSharing.deviceId, v5.id));
    expect([Boolean(row!.toTraining), row!.disclosureVersion]).toEqual([false, "2026-11-19.1"]);
    expect(a.json).toEqual({ toTraining: false, disclosureVersion: "2026-11-19.1", setAt: row!.setAt });
    expect((await w.call("GET", "/api/native/sharing", { bearer: v5.token })).json.toTraining).toBe(false);
  });

  it("G8: a key the sharing body doesn't take is refused at the gate", async () => {
    const a = await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1", all: true });
    expect([a.status, a.json.error]).toEqual([403, "out_of_scope"]);
  });

  it("during a restore, off lands and on waits", async () => {
    await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" });
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const on = await sharing({ toTraining: true, disclosureVersion: "2026-11-19.2" });
    expect(on.status).toBe(423);
    const off = await sharing({ toTraining: false, disclosureVersion: "2026-11-19.1" });
    expect(off.status, off.text).toBe(200);
    expect((await w.call("GET", "/api/native/sharing", { bearer: v5.token })).json.toTraining).toBe(false);
  });
});

describe("switch A goes with its pairing (NIT 4)", () => {
  it("a revoke, a revoke-all and the expired-device purge take the phone's switch with it", async () => {
    await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" });
    const other = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" }, other.token);
    const rows = () => w.db.select({ deviceId: nativeDeviceSharing.deviceId }).from(nativeDeviceSharing);
    expect((await w.call("POST", `/api/native/devices/${v5.id}/revoke`, {})).status).toBe(200);
    expect(await rows()).toEqual([{ deviceId: other.id }]);
    expect((await w.call("POST", "/api/native/devices/revoke-all", {})).status).toBe(200);
    expect(await rows()).toEqual([]);
    // A switch whose phone is gone (expired and purged) goes too.
    const third = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    await sharing({ toTraining: false, disclosureVersion: "2026-11-19.1" }, third.token);
    await w.db.update(schema.nativeDevices).set({ expiresAt: "2026-01-01T00:00:00.000Z" }).where(eq(schema.nativeDevices.id, third.id));
    await purgeExpiredNativeRows(w.db);
    expect(await rows()).toEqual([]);
  });
});

describe("the coach's gates on a phone (MINOR-5, NIT 8)", () => {
  it("B1: on staging the QA account's phone is still 404 coach_off on every coach route", async () => {
    const [qa] = await w.db.insert(users).values({ id: `qa-${newId()}`, email: QA_EMAIL, name: null, googleSub: null, createdAt: nowInstant() }).returning();
    const phone = await seedDevice(w.db, qa!.id, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const staging = { STAGING: "1", COACH_DESIGNER: undefined };
    for (const [method, path, body] of [
      ["POST", "/api/coach/runs", { scope: { kind: "later_today" }, request: "Design one" }],
      ["GET", "/api/coach/runs/current", undefined],
      ["GET", "/api/coach/conversation", undefined],
      ["GET", "/api/coach/nudges", undefined],
      ["GET", "/api/coach/memory", undefined],
      ["GET", "/api/coach/spend", undefined],
      ["GET", "/api/coach/proposals/p-1", undefined],
    ] as const) {
      const a = await w.call(method, path, { bearer: phone.token, env: staging, ...(body ? { body } : {}) });
      expect([path, a.status, a.json.error]).toEqual([path, 404, "coach_off"]);
    }
    // The owner's phone on the same staging config reaches the coach.
    expect((await w.call("GET", "/api/coach/runs/current", { bearer: v5.token, env: staging })).status).toBe(200);
    expect(await w.db.select().from(coachRuns)).toEqual([]);
  });

  it("B10: a phone's create with no model to call is 404 coach_off, and nothing starts", async () => {
    const a = await w.call("POST", "/api/coach/runs", { bearer: v5.token, env: { AI_GATEWAY_API_KEY: undefined }, body: { scope: { kind: "now" }, request: "Something calm." } });
    expect([a.status, a.json.error]).toEqual([404, "coach_off"]);
    expect(await w.db.select().from(coachRuns)).toEqual([]);
    expect(await w.db.select().from(llmUsage)).toEqual([]);
  });
});

describe("words a phone gets back (NIT 1, 2)", () => {
  it("bad_frame names where, never what it was sent", async () => {
    await sharing({ toTraining: true, disclosureVersion: "2026-11-19.1" });
    const a = await w.call("POST", "/api/coach/runs", {
      bearer: v5.token,
      body: { scope: { kind: "now" }, frame: { days: [T], energy: "seeing Sam", free: {}, dayEnd: "23:00", load: {}, coverage: {}, consent: "2026-11-19.1" } },
    });
    expect([a.status, a.json.error]).toEqual([400, "bad_frame"]);
    expect(a.text).not.toContain("seeing Sam");
    expect(a.json.issues[0].path).toBe("energy");
  });

  it("a saved workout's read names no condition", async () => {
    await w.db.insert(userConditions).values({ id: `${w.userId}:tmj`, userId: w.userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    await w.db.insert(workoutTemplates).values({ id: "t-1", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: NOW, updatedAt: NOW });
    const a = await w.call("GET", "/api/native/templates/t-1", { bearer: v5.token });
    expect(a.status).toBe(200);
    expect(a.json.derived).not.toHaveProperty("conditionMax");
    expect(a.text).not.toMatch(/tmj/i);
  });
});
