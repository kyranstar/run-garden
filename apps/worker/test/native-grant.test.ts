/**
 * THE LAPTOP'S GRANT OF A DEVICE'S NEXT SCOPE, IN PLACE (the lead's v0.15 ruling; stage 2b RG-NOTES §3). The signed-in
 * owner's laptop moves one ACTIVE device of the account from its scope to the next named one — v1 → v2 → v3, one step a
 * grant, never a downgrade — through `POST /api/native/devices/:id/grant {scope}`, cookie only:
 *
 *  - it keeps the device's id (so its token), account, label, state, expiry and every other column exactly, and writes
 *    only that row's scope and one audit row, in one transaction; a resend is 200 `granted: false` and writes nothing;
 *  - it refuses revoked, expired and pending devices, another account's, a scope that isn't the next one (skipping one,
 *    any downgrade, an unknown name), a malformed body, a device token, the switch off and a restore;
 *  - THE SCOPE IS READ PER REQUEST: the same token that a v3 route refused under v2 reaches it right after the grant,
 *    privileged save fields included, and `/me` says the scope as stored now;
 *  - the phone's saves are untouched: one saved before the grant answers its resend `same_payload` after it.
 *
 * Through the real route modules on the repo's migrations, under a faked `Date`. Synthetic data only; `fetch` stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, performedSessionSaveSchema } from "@rg/domain";

/** Hold a grant between its read of the device and its one transaction (the next `runAtomicallyClaim`), once. */
const gates = vi.hoisted(() => ({ claim: null as null | (() => Promise<void>) }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/db.js")>();
  return {
    ...real,
    runAtomicallyClaim: async (...args: Parameters<typeof real.runAtomicallyClaim>) => {
      const hold = gates.claim;
      gates.claim = null;
      if (hold) await hold();
      return real.runAtomicallyClaim(...args);
    },
  };
});

import type { Env } from "../src/env.js";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { makeTestUser } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { accountState, auditEvents, nativeDevices } = schema;

const LA = "America/Los_Angeles";
const V1 = "training-slice-v1";
const V2 = "training-v2";
const V3 = "training-v3";
const D = "2026-11-18";
const instant = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const EXPIRES = "2026-12-10T08:00:00.000Z";

let w: NativeWorld;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  gates.claim = null;
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant(D, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
    ["/api/workouts", workoutRoutes],
  ]);
});

const client = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[] } } }).$client;
const q = (sql: string, ...args: unknown[]): any[] => client().prepare(sql).all(...args);
const deviceRow = (id: string) => q(`select * from native_devices where id = ?`, id)[0];
const audits = () => q(`select user_id as userId, kind, detail from audit_events where kind = 'native_device_scope_granted' order by rowid`).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
/** Every table but the cookie's own session row (a signed-in request may slide it): "nothing written" is this, unchanged. */
function everything(): Record<string, unknown[]> {
  const tables = q(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('sessions') order by name`).map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, q(`select * from "${t}" order by rowid`)]));
}
const grant = (id: string, body: unknown = { scope: V3 }, opts: { bearer?: string; env?: Partial<Env>; raw?: string } = {}) =>
  w.call("POST", `/api/native/devices/${id}/grant`, { ...(opts.raw !== undefined ? { raw: opts.raw } : { body }), ...(opts.bearer ? { bearer: opts.bearer } : {}), ...(opts.env ? { env: opts.env } : {}) });
/** A device of the owner's, active, last used just now (so its requests write no last use). */
const phone = (over: Partial<typeof nativeDevices.$inferInsert> = {}) =>
  seedDevice(w.db, w.userId, { scope: V2, label: "Running phone", expiresAt: EXPIRES, lastUsedAt: nowInstant(), ...over });
/** The writes a request made, outside the cookie's own session row. */
const writesOf = (a: { writes: string[] }) => a.writes.filter((s) => !/^update "sessions"/i.test(s));

describe("a grant moves an active device to its next scope, in place", () => {
  it("v2 → v3: 200 granted, the row identical but its scope, one audit, and the token reaches v3 at once", async () => {
    const d = await phone();
    const before = deviceRow(d.id);
    const a = await grant(d.id);
    expect([a.status, a.json], a.text).toEqual([200, { ok: true, scope: V3, granted: true }]);
    // Exactly one column changed: the token, account, label, state, expiry, confirmation, last use and tries are kept.
    expect(deviceRow(d.id)).toEqual({ ...before, scope: V3 });
    expect(audits()).toEqual([{ userId: w.userId, kind: "native_device_scope_granted", detail: { deviceId: d.id, label: "Running phone", from: V2, to: V3 } }]);
    // It writes that device's row and the audit, and no other table.
    expect(writesOf(a).map((s) => /^(insert into|update) "?(\w+)"?/i.exec(s)?.[2]).sort()).toEqual(["audit_events", "native_devices"]);
    expect((await w.call("GET", "/api/native/me", { bearer: d.token })).json.device).toEqual({ label: "Running phone", expiresAt: EXPIRES, scope: V3 });
  });

  it("the same grant again (a resend, a double click): 200 granted false, and nothing written — no second audit", async () => {
    const d = await phone();
    expect((await grant(d.id)).json.granted).toBe(true);
    const held = everything();
    const again = await grant(d.id);
    expect([again.status, again.json]).toEqual([200, { ok: true, scope: V3, granted: false }]);
    expect(writesOf(again)).toEqual([]);
    expect(everything()).toEqual(held);
    expect(audits()).toHaveLength(1);
  });

  it("two grants at once: one granted, one not, one audit", async () => {
    const d = await phone();
    const both = await Promise.all([grant(d.id), grant(d.id)]);
    expect(both.map((a) => [a.status, a.json.granted]).sort()).toEqual([[200, false], [200, true]]);
    expect(deviceRow(d.id).scope).toBe(V3);
    expect(audits()).toHaveLength(1);
  });

  it("a grant that lands between another's read and its write: the other grants nothing, and writes no audit", async () => {
    const d = await phone();
    let inner: Awaited<ReturnType<typeof grant>> | null = null;
    gates.claim = async () => void (inner = await grant(d.id));
    const outer = await grant(d.id);
    expect([inner!.json, outer.json]).toEqual([
      { ok: true, scope: V3, granted: true },
      { ok: true, scope: V3, granted: false },
    ]);
    expect(audits()).toHaveLength(1);
  });

  it("a device revoked between the grant's read and its write: nothing granted, no audit, and it stays revoked", async () => {
    const d = await phone();
    gates.claim = async () => {
      expect((await w.call("POST", `/api/native/devices/${d.id}/revoke`, { body: {} })).json).toEqual({ ok: true, revoked: true });
    };
    const a = await grant(d.id);
    expect([a.status, a.json]).toEqual([409, { error: "device_revoked" }]);
    expect([deviceRow(d.id).state, deviceRow(d.id).scope]).toEqual(["revoked", V2]);
    expect(audits()).toEqual([]);
  });

  it("the ladder is one step a grant: v1 → v2, then v2 → v3", async () => {
    const d = await phone({ scope: V1 });
    expect((await grant(d.id, { scope: V3 })).json).toEqual({ error: "not_next_scope", scope: V1, next: V2 });
    expect((await grant(d.id, { scope: V2 })).json).toEqual({ ok: true, scope: V2, granted: true });
    expect((await grant(d.id, { scope: V3 })).json).toEqual({ ok: true, scope: V3, granted: true });
    expect(audits().map((a) => [a.detail.from, a.detail.to])).toEqual([[V1, V2], [V2, V3]]);
    // At the top there is no next: v3 asking v3 is the idempotent answer, never a refusal.
    expect((await grant(d.id, { scope: V3 })).json).toEqual({ ok: true, scope: V3, granted: false });
  });

  it("the laptop's list says each device's scope and the grant it can offer (none while pending, none at the top)", async () => {
    await phone({ scope: V1, label: "Old phone" });
    await phone({ scope: V2, label: "Running phone" });
    await phone({ scope: V3, label: "New phone" });
    await phone({ scope: V2, label: "Pending phone", state: "pending", confirmedAt: null });
    await phone({ scope: "training-v0", label: "Odd phone" });
    const listed = (await w.call("GET", "/api/native/devices")).json.devices as Array<{ label: string; scope: string; nextScope: string | null }>;
    expect(Object.fromEntries(listed.map((d) => [d.label, [d.scope, d.nextScope]]))).toEqual({
      "Old phone": [V1, V2],
      "Running phone": [V2, V3],
      "New phone": [V3, null],
      "Pending phone": [V2, null],
      "Odd phone": ["training-v0", null],
    });
  });

  it("a new pairing's code says what a phone paired now can do: the mint answers the scope a redeem writes (still v2)", async () => {
    const minted = await w.call("POST", "/api/native/pairings", { body: {} });
    expect([minted.status, minted.json.scope]).toEqual([200, V2]);
    const paired = await w.call("POST", "/api/native/pair", { body: { code: minted.json.code, label: "Fresh phone" }, cookie: false });
    expect(paired.status, paired.text).toBe(200);
    expect(q(`select scope from native_devices where label = 'Fresh phone'`)).toEqual([{ scope: V2 }]);
  });
});

describe("the scope is read on every request: refused under v2, then the same token succeeds after the grant", () => {
  it("the document read and edit, Build's choices and the save's feedback, before and after", async () => {
    const d = await phone();
    const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: D, time: "18:00", clientId: `grant-${newId()}` } });
    expect(made.status, made.text).toBeLessThan(300);
    const id = made.json.workout.id as string;
    const slot = await seedSlot(w.db, w.userId, D);
    const asked = {
      read: () => w.call("GET", `/api/workouts/${id}/doc`, { bearer: d.token }),
      edit: (baseRev: number) => w.call("PUT", `/api/workouts/${id}/doc`, { bearer: d.token, body: { doc: calmDoc({ title: "Hips, back and a bit more" }), baseRev } }),
      fit: () => w.call("POST", `/api/sessions/${slot}/build`, { bearer: d.token, body: { overrides: { minutes: 20 } } }),
    };
    const held = everything();
    for (const a of [await asked.read(), await asked.edit(1), await asked.fit()]) expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
    expect(everything()).toEqual(held);

    expect((await grant(d.id)).json.granted).toBe(true);

    const read = await asked.read();
    expect([read.status, read.json.rev], read.text).toEqual([200, 1]);
    const edited = await asked.edit(1);
    expect([edited.status, edited.json.rev], edited.text).toEqual([200, 2]);
    const fitted = await asked.fit();
    expect([fitted.status, fitted.json.build?.minutes], fitted.text).toEqual([200, 20]);
  });

  it("a save's Not for me: 403 before the grant, saved after it — the privileged field judged by the scope stored now", async () => {
    const d = await phone();
    const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: D, time: "18:00", clientId: `grant-${newId()}` } });
    const id = made.json.workout.id as string;
    const built = await w.call("POST", `/api/sessions/${id}/build`, { bearer: d.token, body: {} });
    const build = built.json.build;
    expect((await w.call("POST", `/api/sessions/${id}/start`, { bearer: d.token, body: { buildId: build.buildId } })).status).toBe(200);
    const body = performedSessionSaveSchema.parse({
      id: `p-${id}`, source: "app", sourceRef: null, workoutId: id, buildId: build.buildId, localDate: D,
      startedAt: instant(D, "09:00"), endedAt: instant(D, "09:30"), seconds: 1800, plannedSeconds: build.plannedSeconds, minutes: build.minutes,
      mode: build.mode ?? null, theme: build.theme ?? null, locationId: build.locationId ?? null, blockRef: null, blockNumber: null,
      completed: true, stepsTotal: build.steps.length, stepsDone: build.steps.length,
      movesDone: build.items.map((i: { exerciseId: string }) => ({ exerciseId: i.exerciseId, seconds: 120 })),
      note: null, newMove: null,
      entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 12, seconds: null, load: null }] }],
      checks: [], review: { excluded: { bridge: true } },
    });
    const held = everything();
    const refused = await w.call("PUT", `/api/sessions/performed/${body.id}`, { bearer: d.token, body });
    expect([refused.status, refused.json]).toEqual([403, { error: "out_of_scope" }]);
    expect(everything()).toEqual(held);

    await grant(d.id);
    const saved = await w.call("PUT", `/api/sessions/performed/${body.id}`, { bearer: d.token, body });
    expect([saved.status, saved.json.status], saved.text).toEqual([200, "saved"]);
    expect(q(`select exercise_id as id, excluded from exercise_prefs where user_id = ?`, w.userId)).toEqual([{ id: "bridge", excluded: 1 }]);
  });

  it("the phone's saves are kept: one saved under v2 answers its resend same_payload after the grant", async () => {
    const d = await phone();
    const made = await w.call("POST", "/api/workouts", { body: { doc: calmDoc(), date: D, time: "18:00", clientId: `grant-${newId()}` } });
    const id = made.json.workout.id as string;
    const build = (await w.call("POST", `/api/sessions/${id}/build`, { bearer: d.token, body: {} })).json.build;
    await w.call("POST", `/api/sessions/${id}/start`, { bearer: d.token, body: { buildId: build.buildId } });
    const raw = JSON.stringify(
      performedSessionSaveSchema.parse({
        id: `p-${id}`, source: "app", sourceRef: null, workoutId: id, buildId: build.buildId, localDate: D,
        startedAt: instant(D, "09:00"), endedAt: instant(D, "09:30"), seconds: 1800, plannedSeconds: build.plannedSeconds, minutes: build.minutes,
        mode: build.mode ?? null, theme: build.theme ?? null, locationId: build.locationId ?? null, blockRef: null, blockNumber: null,
        completed: true, stepsTotal: build.steps.length, stepsDone: build.steps.length, movesDone: [], note: null, newMove: null,
        entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 12, seconds: null, load: null }] }],
        checks: [], review: {},
      }),
    );
    expect((await w.call("PUT", `/api/sessions/performed/p-${id}`, { bearer: d.token, raw })).json.status).toBe("saved");
    const saves = q(`select * from performed_sessions`);
    await grant(d.id);
    expect(q(`select * from performed_sessions`)).toEqual(saves);
    expect((await w.call("PUT", `/api/sessions/performed/p-${id}`, { bearer: d.token, raw })).json).toEqual({ status: "same_payload" });
  });
});

describe("what a grant refuses, writing nothing", () => {
  it("revoked, expired and pending devices: 409 with the state, and a revoked one stays revoked", async () => {
    const revoked = await phone({ state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" });
    const expired = await phone({ expiresAt: instant(D, "08:00") });
    const pending = await phone({ state: "pending", confirmedAt: null });
    const held = everything();
    expect((await grant(revoked.id)).json).toEqual({ error: "device_revoked" });
    expect((await grant(expired.id)).json).toEqual({ error: "device_expired" });
    expect((await grant(pending.id)).json).toEqual({ error: "device_pending" });
    for (const id of [revoked.id, expired.id, pending.id]) expect((await grant(id)).status).toBe(409);
    expect(everything()).toEqual(held);
    expect((await w.call("GET", "/api/native/me", { bearer: revoked.token })).json).toEqual({ error: "device_revoked" });
  });

  it("another account's device, or none: 404 not_found, and theirs is untouched", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirs = await seedDevice(w.db, other.userId, { scope: V2, expiresAt: EXPIRES });
    const held = everything();
    expect([(await grant(theirs.id)).status, (await grant(theirs.id)).json]).toEqual([404, { error: "not_found" }]);
    expect([(await grant("f".repeat(64))).status, (await grant("f".repeat(64))).json]).toEqual([404, { error: "not_found" }]);
    expect(everything()).toEqual(held);
  });

  it("never a downgrade, never a skip, never an unknown name: 409 not_next_scope with the device's scope and its next", async () => {
    const v3 = await phone({ scope: V3 });
    const v2 = await phone({ scope: V2 });
    const odd = await phone({ scope: "training-v0" });
    const held = everything();
    expect((await grant(v3.id, { scope: V2 })).json).toEqual({ error: "not_next_scope", scope: V3, next: null });
    expect((await grant(v3.id, { scope: V1 })).json).toEqual({ error: "not_next_scope", scope: V3, next: null });
    expect((await grant(v2.id, { scope: V1 })).json).toEqual({ error: "not_next_scope", scope: V2, next: V3 });
    for (const name of ["training-v4", "__proto__", "constructor", "toString", "", "TRAINING-V3"]) {
      const a = await grant(v2.id, { scope: name });
      expect([name, a.status, a.json]).toEqual([name, 409, { error: "not_next_scope", scope: V2, next: V3 }]);
    }
    expect((await grant(odd.id, { scope: V3 })).json).toEqual({ error: "not_next_scope", scope: "training-v0", next: null });
    expect(everything()).toEqual(held);
  });

  it("a body that isn't exactly {scope}: 400 invalid_grant", async () => {
    const d = await phone();
    const held = everything();
    for (const opts of [{ body: {} }, { body: { scope: 3 } }, { body: { scope: V3, extra: true } }, { body: [V3] }, { body: null }, { raw: "not json" }, { raw: "" }]) {
      const a = "raw" in opts ? await grant(d.id, undefined, { raw: opts.raw }) : await grant(d.id, opts.body);
      expect([JSON.stringify(opts), a.status, a.json]).toEqual([JSON.stringify(opts), 400, { error: "invalid_grant" }]);
    }
    expect(everything()).toEqual(held);
  });

  it("a device token can't grant anything, to itself or another: 403 out_of_scope; no cookie is 401", async () => {
    const d = await phone();
    const top = await phone({ scope: V3 });
    const held = everything();
    for (const bearer of [d.token, top.token]) {
      expect((await grant(d.id, { scope: V3 }, { bearer })).json).toEqual({ error: "out_of_scope" });
    }
    expect((await w.call("POST", `/api/native/devices/${d.id}/grant`, { body: { scope: V3 }, cookie: false })).status).toBe(401);
    expect(everything()).toEqual(held);
  });

  it("device sign-in off: 404, nothing changes (the switch stays the owner's); a restore: 423", async () => {
    const d = await phone();
    const held = everything();
    expect([(await grant(d.id, { scope: V3 }, { env: { NATIVE_DEVICES: "0" } })).status]).toEqual([404]);
    expect(everything()).toEqual(held);
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await grant(d.id)).json).toEqual({ error: "restore_in_progress" });
    expect(deviceRow(d.id).scope).toBe(V2);
    expect(await w.db.select().from(auditEvents).where(eq(auditEvents.kind, "native_device_scope_granted"))).toEqual([]);
  });
});
