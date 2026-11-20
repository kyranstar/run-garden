/**
 * THE PHONE'S SAVED WORKOUTS (R1, 3a; DESIGN-3 §3.5 pairs 1–2, §5.3): `GET /api/native/templates` and `/templates/:id`.
 *
 * Pinned: the list carries no documents and exactly its keys, pinned first then by last use; the detail carries the document
 * and what it derives to; another account's template is not found; both are 503 during a restore and write nothing; a v4
 * phone is refused them and a v5 phone reads them. R1.1: the detail's `moves` are *What's in it* in exactly the shape, and
 * the very values, `/sessions/:id/ahead` gives the same document's moves, each with exactly the allowlist's keys and none of
 * the document's other words. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { PROFILE_IDS } from "@rg/exercise-library";
import { addDays, nowInstant, todayInZone, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import type { ExtractedMove } from "@rg/saves";
import { DEVICE_MOVE_KEYS, nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeRoutes } from "../src/routes/native.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { accountState, personalMoves, plannedWorkouts, workoutTemplates } = schema;

let w: NativeWorld;
let v5: string;

beforeEach(async () => {
  vi.stubGlobal("fetch", (async () => {
    throw new Error("no external call from a read");
  }) as typeof fetch);
  w = await nativeWorld([
    ["/api/native", nativeLibraryRoutes],
    ["/api/native", nativeRoutes],
  ]);
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
    expect(Object.keys(a.json).sort()).toEqual(["derived", "discipline", "doc", "id", "minutes", "moves", "name"]);
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

describe("GET /api/native/templates/:id — What's in it (R1.1; 3a's review ARCHITECTURE 3)", () => {
  /** One of the account's own moves (an import's), so the library the moves are named in is the account's, not the catalog alone. */
  const OWN = "myZorbexHipLift0a1b2c";
  const ownMove: ExtractedMove = {
    name: "Zorbex hip lift", aliases: [], summary: "Lift the hips, slow and even.", steps: ["Lie down.", "Lift the hips."], cues: [], mistakes: [],
    purpose: "Opens the hips.", dose: { text: "2 x 8", range: [8, 8] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "supine",
    laterality: "bilateral", load: "none", contraction: ["isotonic"], difficulty: 2,
    conditions: Object.fromEntries(PROFILE_IDS.map((p) => [p, { attrs: { clench: 0, neckLoad: 1, faceDown: false }, note: "Easy on the jaw." }])) as unknown as ExtractedMove["conditions"],
    evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high",
  };

  /** Words the document holds beside its moves, which `moves` never carries. */
  const WORDS = ["SENTINEL-INTENT", "SENTINEL-WHY", "SENTINEL-CUE", "SENTINEL-PROGRESSION", "SENTINEL-ALT-WHY", "SENTINEL-PART-WHY", "SENTINEL-FREE-WHY", "SENTINEL-RUN-CUE", "SENTINEL-NOTES"];

  /** Every kind `docMoves` renders: a catalog move, the account's own, a free move with a load, holds each side, rounds, rests, runs. */
  const everythingDoc = (): WorkoutDoc =>
    workoutDocSchema.parse({
      version: 1,
      title: "Everything in it",
      intent: { summary: "SENTINEL-INTENT", goals: ["posture"], focus: [], effort: "maintain" },
      parts: [
        {
          purpose: "main",
          why: "SENTINEL-PART-WHY",
          format: "circuit",
          rounds: 3,
          items: [
            { kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12, restSec: 30 }, why: "SENTINEL-WHY", cue: "SENTINEL-CUE", progression: "SENTINEL-PROGRESSION", alternates: [{ libraryId: "deadBug", why: "SENTINEL-ALT-WHY" }] },
            { kind: "rest", seconds: 60 },
            { kind: "free_exercise", name: "Wall angels", dose: { sets: 2, reps: { min: 8, max: 10 }, load: { typed: "2 kg", kg: 2 } }, why: "SENTINEL-FREE-WHY" },
          ],
        },
        {
          purpose: "accessory",
          format: "straight",
          items: [
            { kind: "exercise", libraryId: OWN, dose: { sets: 2, reps: 8 } },
            { kind: "exercise", libraryId: "deadBug", dose: { sets: 1, holdSec: 30, perSide: true } },
          ],
        },
        {
          purpose: "run",
          format: "steady",
          items: [
            { kind: "run", target: { durationSec: 600 }, effort: "easy", cue: "SENTINEL-RUN-CUE" },
            { kind: "run", target: { distanceM: 1609, typed: "1 mi" }, effort: "strides" },
            { kind: "run", target: { open: true }, effort: "recovery" },
          ],
        },
      ],
      source: { kind: "studio" },
      notes: "SENTINEL-NOTES",
    });

  beforeEach(async () => {
    await w.db.insert(personalMoves).values({ id: OWN, userId: w.userId, status: "active", record: toPersonalRecord(OWN, ownMove), createdAt: nowInstant(), updatedAt: nowInstant() });
  });

  /** The same document as a session on a later day: what the phone already reads as `/sessions/:id/ahead`'s moves. */
  async function aheadMovesOf(doc: WorkoutDoc) {
    const day = addDays(todayInZone("America/Los_Angeles"), 3);
    const id = await seedSlot(w.db, w.userId, day);
    await w.db.update(plannedWorkouts).set({ workoutDoc: JSON.stringify(doc), workoutDocRev: 1 }).where(eq(plannedWorkouts.id, id));
    const a = await w.call("GET", `/api/native/sessions/${id}/ahead`, { bearer: v5 });
    expect([a.status, a.json.basis], a.text).toEqual([200, "document"]);
    return a.json.moves as unknown[];
  }

  it("its moves are the workout document's moves for the same content: the same shape and the very values", async () => {
    await template(w.userId, "t-all", { doc: JSON.stringify(everythingDoc()) });
    const a = await w.call("GET", "/api/native/templates/t-all", { bearer: v5 });
    expect(a.status, a.text).toBe(200);
    expect(a.json.moves).toEqual(await aheadMovesOf(everythingDoc()));
    // Every kind rendered, in the document's order, the rest left out: rounds, a load, the account's own move by its name,
    // holds each side, a run by time, by typed distance and open.
    expect(a.json.moves).toEqual([
      { exerciseId: "bridge", name: expect.any(String), dose: "3 rounds · 2 × 12" },
      { exerciseId: null, name: "Wall angels", dose: expect.stringMatching(/^3 rounds · 2 × 8.10 · 2 kg$/) },
      { exerciseId: OWN, name: "Zorbex hip lift", dose: "2 × 8" },
      { exerciseId: "deadBug", name: expect.any(String), dose: expect.stringContaining("each side") },
      { exerciseId: null, name: "Easy run", dose: expect.any(String) },
      { exerciseId: null, name: "Strides run", dose: "1 mi" },
      { exerciseId: null, name: "Recovery run", dose: "until the lap button" },
    ]);
    // The simple document too.
    await template(w.userId, "t-calm");
    expect((await w.call("GET", "/api/native/templates/t-calm", { bearer: v5 })).json.moves).toEqual(await aheadMovesOf(calmDoc()));
  });

  it("each move has exactly the allowlist's keys, and none of the document's other words", async () => {
    await template(w.userId, "t-all", { doc: JSON.stringify(everythingDoc()) });
    const a = await w.call("GET", "/api/native/templates/t-all", { bearer: v5 });
    expect(a.json.moves.length).toBeGreaterThan(0);
    for (const m of a.json.moves) expect(Object.keys(m).sort()).toEqual([...DEVICE_MOVE_KEYS].sort());
    const moves = JSON.stringify(a.json.moves);
    expect(WORDS.filter((word) => moves.includes(word))).toEqual([]);
    // Nothing of a move's how-to or the account's condition notes either.
    for (const word of ["Lift the hips", "Opens the hips", "Easy on the jaw", "Lie down"]) expect(moves).not.toContain(word);
    // The laptop's cookie reads the same: one projection.
    expect((await w.call("GET", "/api/native/templates/t-all")).json.moves).toEqual(a.json.moves);
    expect(a.writes).toEqual([]);
  });

  it("a document that no longer reads: moves null, as derived and minutes", async () => {
    await template(w.userId, "t-broken", { doc: "{not a document" });
    const a = await w.call("GET", "/api/native/templates/t-broken", { bearer: v5 });
    expect(a.status, a.text).toBe(200);
    expect([a.json.doc, a.json.derived, a.json.minutes, a.json.moves]).toEqual([null, null, null, null]);
  });

  it("costs no statement more than R1's detail: the library it derives in names the moves", async () => {
    await template(w.userId, "t-all", { doc: JSON.stringify(everythingDoc()) });
    const a = await w.call("GET", "/api/native/templates/t-all", { bearer: v5 });
    expect(a.statements.filter((s) => /personal_moves/.test(s))).toHaveLength(1);
  });
});
