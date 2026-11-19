/**
 * THE PHONE'S SAVED WORKOUTS (R1, 3a; DESIGN-3 §3.5 pairs 1–2, §5.3): `GET /api/native/templates` and `/templates/:id`.
 *
 * Pinned: the list carries no documents and exactly its keys, pinned first then by last use; the detail carries the document
 * and what it derives to; another account's template is not found; both are 503 during a restore and write nothing; a v4
 * phone is refused them and a v5 phone reads them. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, workoutTemplates } = schema;

let w: NativeWorld;
let v5: string;

beforeEach(async () => {
  vi.stubGlobal("fetch", (async () => {
    throw new Error("no external call from a read");
  }) as typeof fetch);
  w = await nativeWorld([["/api/native", nativeLibraryRoutes]]);
  v5 = (await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant() })).token;
});
afterEach(() => vi.unstubAllGlobals());

const template = (userId: string, id: string, over: Partial<typeof workoutTemplates.$inferInsert> = {}) =>
  w.db.insert(workoutTemplates).values({
    id, userId, name: `Saved ${id}`, doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over,
  });

describe("GET /api/native/templates", () => {
  it("lists the account's templates without documents, exactly these keys, pinned first then by last use", async () => {
    await template(w.userId, "t-old", { lastUsedAt: "2026-11-02T00:00:00.000Z" });
    await template(w.userId, "t-new", { lastUsedAt: "2026-11-10T00:00:00.000Z", doc: JSON.stringify(landingsDoc()) });
    await template(w.userId, "t-pin", { pinned: true });
    const other = await makeTestUser(w.db);
    await template(other.userId, "t-theirs", { pinned: true });
    const a = await w.call("GET", "/api/native/templates", { bearer: v5 });
    expect(a.status, a.text).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.json.templates.map((t: { id: string }) => t.id)).toEqual(["t-pin", "t-new", "t-old"]);
    for (const t of a.json.templates) expect(Object.keys(t).sort()).toEqual(["discipline", "id", "lastUsedAt", "minutes", "name", "pinned", "updatedAt", "uses"]);
    expect(a.text).not.toContain("libraryId");
    expect(a.writes).toEqual([]);
  });

  it("the detail is the document and what it derives to; another account's or none is 404", async () => {
    await template(w.userId, "t-1");
    const other = await makeTestUser(w.db);
    await template(other.userId, "t-theirs");
    const a = await w.call("GET", "/api/native/templates/t-1", { bearer: v5 });
    expect(a.status, a.text).toBe(200);
    expect(Object.keys(a.json).sort()).toEqual(["derived", "discipline", "doc", "id", "minutes", "name"]);
    expect(a.json.doc.title).toBe("Hips and back");
    expect(a.json.minutes).toBe(a.json.derived.estimatedMinutes);
    for (const id of ["t-theirs", "t-none"]) expect((await w.call("GET", `/api/native/templates/${id}`, { bearer: v5 })).json).toEqual({ error: "not_found" });
  });

  it("503 during a restore, before any read of the account's rows; nothing written", async () => {
    await template(w.userId, "t-1");
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    for (const path of ["/api/native/templates", "/api/native/templates/t-1"]) {
      const a = await w.call("GET", path, { bearer: v5 });
      expect([path, a.status, a.json]).toEqual([path, 503, { error: "restore_in_progress", retryable: true }]);
      expect(a.statements.some((s) => /workout_templates/.test(s))).toBe(false);
    }
  });

  it("the gate: a v4 phone is refused, a v5 phone and the laptop's cookie read", async () => {
    const v4 = (await seedDevice(w.db, w.userId, { scope: "training-v4", lastUsedAt: nowInstant() })).token;
    expect((await w.call("GET", "/api/native/templates", { bearer: v4 })).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("GET", "/api/native/templates?x=1", { bearer: v5 })).json).toEqual({ error: "out_of_scope" });
    expect((await w.call("GET", "/api/native/templates")).status).toBe(200);
  });
});
