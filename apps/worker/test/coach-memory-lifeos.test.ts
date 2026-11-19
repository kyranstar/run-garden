/**
 * *TELL YOUR TRAINING COACH* (R1, 3c; DESIGN-3 §3.7, §3.5 pair 24; extends coach-memory-v2): `POST /api/coach/memory`.
 *
 * Pinned: the phone's own (a cookie is 403 device_only) and only with switch A on (409 sharing_off); one line of at most
 * 140 characters, of kind note, fact or rule; kept `stated`, provenance `lifeos` with the phone; a resent clientId is the
 * same item and the same words already kept are answered as they are (nothing written); a note lasts 30 days; nothing the
 * owner confirmed is superseded; DELETE takes it back. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { coachRoutes } from "../src/routes/coach.js";
import { nativeRoutes } from "../src/routes/native.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { coachMemory } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-19";

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(DateTime.fromISO(`${T}T09:00`, { zone: LA }).toUTC().toISO()!));
  w = await nativeWorld(
    [
      ["/api/coach", coachRoutes],
      ["/api/native", nativeRoutes],
    ],
    { env: { COACH_DESIGNER: "1" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
});
afterEach(() => vi.useRealTimers());

const tell = (body: unknown, bearer: string | null = v5.token) => w.call("POST", "/api/coach/memory", { ...(bearer ? { bearer } : {}), body });
const on = () => w.call("PUT", "/api/native/sharing", { bearer: v5.token, body: { toTraining: true, disclosureVersion: "1" } });
const items = () => w.db.select().from(coachMemory);

describe("POST /api/coach/memory", () => {
  it("the phone's own, and only with switch A on", async () => {
    const said = { kind: "rule", body: "Mornings work better on busy days.", clientId: "c-1" };
    expect((await tell(said, null)).json).toEqual({ error: "device_only" });
    const off = await tell(said);
    expect([off.status, off.json.error]).toEqual([409, "sharing_off"]);
    expect(await items()).toEqual([]);
  });

  it("kept stated, from LifeOS, with the phone; a resend is the same item; the same words already kept are answered as they are", async () => {
    await on();
    const a = await tell({ kind: "rule", body: "Mornings work better on busy days.", clientId: "c-1" });
    expect(a.status, a.text).toBe(201);
    expect(a.json.item).toMatchObject({ kind: "rule", body: "Mornings work better on busy days.", confidence: "stated", active: true, expiresAt: null });
    expect(a.json.item.provenance).toEqual({ source: "lifeos", deviceId: v5.id, at: nowInstant() });
    const again = await tell({ kind: "rule", body: "Mornings work better on busy days.", clientId: "c-1" });
    expect([again.status, again.json.repeated, again.json.item.id]).toEqual([200, true, a.json.item.id]);
    const same = await tell({ kind: "rule", body: "  mornings work better   on busy days. ", clientId: "c-2" });
    expect([same.status, same.json.existing, same.json.item.id]).toEqual([200, true, a.json.item.id]);
    expect(await items()).toHaveLength(1);
  });

  it("one line of at most 140 characters, of kind note, fact or rule; a note lasts 30 days", async () => {
    await on();
    for (const body of [
      { kind: "rule", body: "x".repeat(141), clientId: "c" },
      { kind: "rule", body: "two\nlines", clientId: "c" },
      { kind: "rule", body: "   ", clientId: "c" },
      { kind: "observation", body: "Clenches on heavy days.", clientId: "c" },
    ]) {
      expect([JSON.stringify(body), (await tell(body)).json]).toEqual([JSON.stringify(body), { error: "bad_request" }]);
    }
    expect((await tell({ kind: "rule", body: "x", clientId: "c", extra: 1 })).json).toEqual({ error: "out_of_scope" });
    const note = await tell({ kind: "note", body: "Travelling until Sunday.", clientId: "c-note" });
    expect(note.json.item.expiresAt).toBe(addDays(T, 30));
    expect((await tell({ kind: "fact", body: "y".repeat(140), clientId: "c-max" })).status).toBe(201);
  });

  it("never supersedes what the owner confirmed; DELETE takes a told item back", async () => {
    await on();
    await w.db.insert(coachMemory).values({ id: "m-confirmed", userId: w.userId, kind: "rule", body: "Evenings only on weekdays.", provenance: { source: "athlete_words", runId: "r", role: "main", at: nowInstant() } as never, learnedAt: nowInstant(), expiresAt: null, active: true, pinned: true, confidence: "confirmed", supersededBy: null, evidence: null, updatedAt: nowInstant() });
    const a = await tell({ kind: "rule", body: "Mornings work better on busy days.", clientId: "c-3" });
    const [kept] = await w.db.select().from(coachMemory).where(eq(coachMemory.id, "m-confirmed"));
    expect([kept!.supersededBy, kept!.active, kept!.confidence]).toEqual([null, true, "confirmed"]);
    expect((await w.call("DELETE", `/api/coach/memory/${a.json.item.id}`, { bearer: v5.token })).json).toEqual({ ok: true });
    expect((await w.db.select().from(coachMemory).where(eq(coachMemory.id, a.json.item.id)))[0]!.active).toBe(false);
  });
});
