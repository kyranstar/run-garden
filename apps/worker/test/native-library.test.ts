/**
 * THE PHONE'S MOVE LIBRARY (R1, 3a; DESIGN-3 §3.5 pairs 3–4, §5.3): `GET /api/native/library` and `/library/:id`, trimmed.
 *
 * Pinned: the row's and the page's EXACT key sets — one verdict for the switched-on profiles together, never a profile's
 * name, its notes, the account's saved-post links or its corrections; a move a switched-on profile rules out reads `never`;
 * the query rule (limit 1, 100 and 101; keys outside it); pages by `cursor`; the account's own say (pins) and nobody else's;
 * nothing written; 503 during a restore. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { EXERCISES, profileById } from "@rg/exercise-library";
import { nativeLibraryRoutes, verdictOf } from "../src/routes/native-library.js";
import { safetyFor } from "../src/services/library-view.js";
import { activateTmj } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, exercisePrefs } = schema;

const ROW_KEYS = ["difficulty", "equipment", "excluded", "family", "id", "lastDoneOn", "name", "pinned", "regions", "summary", "verdict"];
const ITEM_KEYS = ["difficulty", "dose", "easier", "equipment", "excluded", "family", "harder", "id", "laterality", "load", "name", "pinned", "position", "regions", "text", "verdict"];
const TEXT_KEYS = ["breathing", "focus", "mistakes", "setup", "steps", "summary", "why"];

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

const list = (query = "") => w.call("GET", `/api/native/library${query}`, { bearer: v5 });

describe("GET /api/native/library", () => {
  it("rows carry exactly their keys and one verdict; never a profile's name, a note or a link", async () => {
    await activateTmj(w.db, w.userId);
    const a = await list("?limit=100");
    expect(a.status, a.text).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.json.items).toHaveLength(100);
    for (const r of a.json.items) {
      expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
      expect(["ok", "caution", "never"]).toContain(r.verdict);
    }
    const tmj = profileById("tmj");
    // The words that would name the condition are never on the wire: no profile id, label, or per-profile safety map.
    expect(a.text).not.toContain(tmj.label);
    expect(a.text).not.toMatch(/"tmj"|safety|profiles|wishlist|unlocksWith|provenance/);
    expect(a.writes).toEqual([]);
  });

  it("one verdict for every switched-on profile together: never if any rules the move out, caution if any limits it", () => {
    expect([verdictOf({}), verdictOf({ tmj: "safe" }), verdictOf({ tmj: "care" }), verdictOf({ tmj: "never" }), verdictOf({ a: "safe", b: "never", c: "care" }), verdictOf({ a: "care", b: "safe" })]).toEqual([
      "ok", "ok", "caution", "never", "never", "caution",
    ]);
  });

  it("a move the switched-on profile limits reads caution, the rest ok — the row's verdict is the profile's own safety", async () => {
    await activateTmj(w.db, w.userId);
    const tmj = profileById("tmj");
    const care = EXERCISES.find((ex) => safetyFor(tmj, ex) === "care");
    const safe = EXERCISES.find((ex) => safetyFor(tmj, ex) === "safe");
    expect([!!care, !!safe]).toEqual([true, true]);
    const verdicts = new Map<string, string>();
    for (let cursor = 0; cursor !== -1; ) {
      const page = await list(`?limit=100&cursor=${cursor}`);
      for (const r of page.json.items) verdicts.set(r.id, r.verdict);
      cursor = page.json.next === null ? -1 : Number(page.json.next);
    }
    expect([verdicts.get(care!.id), verdicts.get(safe!.id)]).toEqual(["caution", "ok"]);
    for (const ex of EXERCISES) if (verdicts.has(ex.id)) expect([ex.id, verdicts.get(ex.id)]).toEqual([ex.id, { safe: "ok", care: "caution", never: "never" }[safetyFor(tmj, ex)]]);
    // With no profile on, nothing is ruled out.
    await w.db.delete(schema.userConditions);
    expect((await list("?limit=100")).json.items.every((r: { verdict: string }) => r.verdict === "ok")).toBe(true);
  });

  it("the query rule: limit 1 and 100 answer, 101 and keys outside the rule are 403 at the gate; the route checks values", async () => {
    expect((await list("?limit=1")).json.items).toHaveLength(1);
    expect((await list("?limit=100")).json.items).toHaveLength(100);
    for (const bad of ["?limit=101", "?limit=0", "?location=home", "?safe=1", "?q=a&q=b", "?family=Mobility"]) {
      const a = await list(bad);
      expect([bad, a.status, a.json]).toEqual([bad, 403, { error: "out_of_scope" }]);
    }
    // The cookie path has no gate: the route's own rule refuses what the gate would.
    expect((await w.call("GET", "/api/native/library?limit=101")).json).toEqual({ error: "bad_query" });
  });

  it("filters by text, family and body area; pages with cursor until next is null", async () => {
    const region = (await list("?limit=1")).json.items[0].regions[0] as string;
    const hips = await list(`?region=${region}&limit=100`);
    expect(hips.json.items.length).toBeGreaterThan(0);
    expect(hips.json.items.every((r: { regions: string[] }) => r.regions.includes(region))).toBe(true);
    const family = hips.json.items[0].family as string;
    const fam = await list(`?family=${family}&limit=100`);
    expect(fam.json.items.every((r: { family: string }) => r.family === family)).toBe(true);
    const first = await list("?limit=10");
    const second = await list(`?limit=10&cursor=${first.json.next}`);
    expect(first.json.next).toBe("10");
    expect(second.json.items[0].id).not.toBe(first.json.items[0].id);
    const last = await list(`?limit=100&cursor=${first.json.matched - 1}`);
    expect([last.json.items.length, last.json.next]).toEqual([1, null]);
  });

  it("the account's own pins only, and nothing of another account's", async () => {
    const other = await makeTestUser(w.db);
    const id = EXERCISES[0]!.id;
    await w.db.insert(exercisePrefs).values({ id: `${other.userId}:${id}`, userId: other.userId, exerciseId: id, pinned: true, excluded: true, rating: 1, updatedAt: nowInstant() } as typeof exercisePrefs.$inferInsert);
    const row = (await list("?limit=100")).json.items.find((r: { id: string }) => r.id === id);
    expect([row.pinned, row.excluded]).toEqual([false, false]);
    await w.db.insert(exercisePrefs).values({ id: `${w.userId}:${id}`, userId: w.userId, exerciseId: id, pinned: true, excluded: false, rating: null, updatedAt: nowInstant() } as typeof exercisePrefs.$inferInsert);
    expect((await list("?limit=100")).json.items.find((r: { id: string }) => r.id === id).pinned).toBe(true);
  });

  it("503 during a restore, before any of the account's rows is read", async () => {
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    for (const path of ["/api/native/library", `/api/native/library/${EXERCISES[0]!.id}`]) {
      const a = await w.call("GET", path, { bearer: v5 });
      expect([path, a.status, a.json]).toEqual([path, 503, { error: "restore_in_progress", retryable: true }]);
    }
  });
});

describe("GET /api/native/library/:id", () => {
  it("a move's page: exactly its keys — the how-to without the per-profile notes, one verdict, the steps either side", async () => {
    await activateTmj(w.db, w.userId);
    const tmj = profileById("tmj");
    const withNote = EXERCISES.find((ex) => ex.text.conditions.tmj && ex.harder.length > 0) ?? EXERCISES.find((ex) => ex.text.conditions.tmj)!;
    const a = await w.call("GET", `/api/native/library/${withNote.id}`, { bearer: v5 });
    expect(a.status, a.text).toBe(200);
    expect(Object.keys(a.json).sort()).toEqual(ITEM_KEYS);
    expect(Object.keys(a.json.text).sort()).toEqual(TEXT_KEYS);
    expect(a.json.verdict).toBe({ safe: "ok", care: "caution", never: "never" }[safetyFor(tmj, withNote)]);
    expect(a.text).not.toContain(withNote.text.conditions.tmj!);
    expect(a.text).not.toContain(tmj.label);
    expect(a.writes).toEqual([]);
    expect((await w.call("GET", "/api/native/library/no-such-move", { bearer: v5 })).json).toEqual({ error: "not_found" });
  });
});
