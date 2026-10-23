/**
 * THE ACCOUNT'S LIBRARY on the Worker (saved-posts import, Task 12): the public library plus the account's personal moves
 * (`personal_moves`), wherever the Worker validates or builds a workout. An active move resolves and is offered; an
 * archived one still resolves (an old document holding it validates and builds, Review Focus 4), never offered; a merged
 * one's id resolves to its target; a pending one is nowhere. The engine plans only from active moves the athlete pinned.
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, todayInZone, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILE_IDS } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import {
  accountLibraryFrom,
  forgetAccountLibrary,
  loadAccountLibrary,
  personalMovesSql,
  PUBLIC_LIBRARY,
} from "../src/services/account-library.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import type { ToolContext, ToolOk } from "../src/services/design-tools/types.js";
import { loadEngineContext } from "../src/services/engine-inputs.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { engineDataFor } from "../src/services/session-build.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activateTmj, clientFor, type Reply } from "./doc-workout-fixture.js";

const { personalMoves, exercisePrefs } = schema;

vi.setConfig({ testTimeout: 30_000 });

// Making a workout hands the calendar a sync step; none runs here.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

const draft = (name: string): ExtractedMove => ({
  name,
  aliases: [],
  summary: `${name}, slow and even.`,
  steps: ["Set up tall.", "Move slowly through the range."],
  cues: ["Ribs down"],
  mistakes: ["Rushing"],
  purpose: "Wakes up the upper back.",
  dose: { text: "2 x 10" },
  patterns: ["pull-h"],
  regions: ["upper-back"],
  equipment: [],
  position: "standing",
  laterality: "bilateral",
  load: "bodyweight",
  contraction: ["isotonic"],
  difficulty: 2,
  conditions: Object.fromEntries(PROFILE_IDS.map((p) => [p, { attrs: { clench: 0, neckLoad: 1, faceDown: false }, note: "Easy on the jaw." }])) as unknown as ExtractedMove["conditions"],
  evidence: { name: "stated", dose: "inferred", steps: "stated" },
  confidence: "high",
});

let db: Db;
let statements: string[];
let userId: string;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  let prefs;
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  call = await clientFor(db, userId);
});

type Status = "pending" | "active" | "archived" | "merged";

/** A personal move of the account, stored as the import stores one; its id. */
async function addMove(
  name: string,
  status: Status,
  o: { mergedInto?: string; pinned?: boolean; owner?: string; draft?: Partial<ExtractedMove> } = {},
): Promise<string> {
  const owner = o.owner ?? userId;
  const id = personalMoveId(name, `${owner}:${name}`);
  const now = nowInstant();
  const record = toPersonalRecord(id, { ...draft(name), ...o.draft });
  await db.insert(personalMoves).values({
    id, userId: owner, status, mergedInto: o.mergedInto ?? null, batchId: null, record, editedByOwner: false, createdAt: now, updatedAt: now,
  });
  if (o.pinned) await pin(id, owner);
  return id;
}

async function pin(exerciseId: string, owner = userId): Promise<void> {
  await db.insert(exercisePrefs).values({ id: `${owner}:${exerciseId}`, userId: owner, exerciseId, pinned: true, updatedAt: nowInstant() });
}

/** A document of one strength part holding `ids`, two sets of ten each. */
const docOf = (...ids: string[]): WorkoutDoc =>
  workoutDocSchema.parse({
    version: 1,
    title: "Upper back",
    intent: { summary: "Wake the upper back.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [{ purpose: "main", format: "straight", items: ids.map((libraryId) => ({ kind: "exercise", libraryId, dose: { sets: 2, reps: 10, restSec: 30 } })) }],
    source: { kind: "studio" },
  });

async function create(doc: WorkoutDoc): Promise<Reply> {
  return call("POST", "/api/workouts", { date: today, doc });
}

describe("loadAccountLibrary", () => {
  it("with no personal moves, every view is the public library itself, read in one statement and once a request", async () => {
    statements.length = 0;
    const library = await loadAccountLibrary(db, userId);
    expect(library.all).toBe(EXERCISES);
    expect(library.offered).toBe(EXERCISES);
    expect(library.engine).toBe(EXERCISES);
    expect(library.personalHash).toBe("");
    expect(statements.length).toBe(1);
    // The same request asks again: the same library, no statement.
    expect(await loadAccountLibrary(db, userId)).toBe(library);
    expect(statements.length).toBe(1);
  });

  it("an active move resolves and is offered; an archived one resolves, never offered; a pending one is nowhere; another account's is not this one's", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const archived = await addMove("Prone Y Raise", "archived");
    const pending = await addMove("Band Pull Apart Hold", "pending");
    const theirs = await addMove("Scap Push Up", "active", { owner: (await makeTestUser(db)).userId });
    statements.length = 0;
    const library = await loadAccountLibrary(db, userId);
    expect(statements.length).toBeLessThanOrEqual(2);
    const ids = (list: readonly { id: string }[]) => list.slice(EXERCISES.length).map((r) => r.id).sort();
    expect(ids(library.all)).toEqual([active, archived].sort());
    expect(ids(library.offered)).toEqual([active]);
    expect(library.engine).toBe(EXERCISES);
    expect(library.all.slice(0, EXERCISES.length)).toEqual(EXERCISES);
    for (const id of [pending, theirs]) expect(makeLibraryIndex(library.all)(id)).toBeUndefined();
    expect(library.personalHash).toMatch(/^[0-9a-f]{16}$/);
    // Asked again in the same request: the same arrays (every index made per array is found again).
    expect(await loadAccountLibrary(db, userId)).toBe(library);
  });

  it("the engine pool holds a pinned active personal move but not an unpinned one (nor a pinned archived one)", async () => {
    const pinned = await addMove("Wall Angel Slide", "active", { pinned: true });
    const unpinned = await addMove("Prone Y Raise", "active");
    const archived = await addMove("Band Pull Apart Hold", "archived", { pinned: true });
    const library = await loadAccountLibrary(db, userId);
    const engineIds = library.engine.map((r) => r.id);
    expect(engineIds).toContain(pinned);
    expect(engineIds).not.toContain(unpinned);
    expect(engineIds).not.toContain(archived);
    expect(library.engine.length).toBe(EXERCISES.length + 1);
    // The build's context carries it, and the engine plans from it.
    const context = await loadEngineContext(db, userId, null, {});
    expect(context.library).toBe(library);
    expect(engineDataFor(context.activeProfiles, context.careProfiles, context.library).exercises.map((r) => r.id)).toContain(pinned);
  });

  it("a merged move's id resolves to its target, a personal move's or the public library's", async () => {
    const target = await addMove("Wall Angel Slide", "active");
    const merged = await addMove("Wall Angels", "merged", { mergedInto: target });
    const twice = await addMove("Wall Angel", "merged", { mergedInto: merged });
    const intoPublic = await addMove("Glute Bridge Pulse", "merged", { mergedInto: "bridge" });
    const library = await loadAccountLibrary(db, userId);
    const find = makeLibraryIndex(library.all);
    expect(find(merged)?.id).toBe(target);
    expect(find(twice)?.id).toBe(target);
    expect(find(intoPublic)?.id).toBe("bridge");
    // A merged move is never offered itself: its id names its target there too.
    expect(library.offered.map((r) => r.id)).not.toContain(merged);
    expect(library.all.map((r) => r.id)).not.toContain(merged);
    expect(makeLibraryIndex(library.offered)(merged)?.id).toBe(target);
    // The public move it went into answers for it in `all` alone; the views offered keep the public record itself.
    expect(library.offered).toEqual(expect.arrayContaining([EXERCISES.find((e) => e.id === "bridge")]));
    expect(makeLibraryIndex(library.offered)(intoPublic)).toBeUndefined();
  });

  it("the personal hash follows the moves: an edit, a pin, an archive each change it", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const first = (await loadAccountLibrary(db, userId)).personalHash;
    const record = toPersonalRecord(id, { ...draft("Wall Angel Slide"), summary: "Slide the arms up the wall." });
    await db.update(personalMoves).set({ record }).where(eq(personalMoves.id, id));
    forgetAccountLibrary(db, userId);
    const edited = (await loadAccountLibrary(db, userId)).personalHash;
    expect(edited).not.toBe(first);
    await pin(id);
    forgetAccountLibrary(db, userId);
    const pinned = (await loadAccountLibrary(db, userId)).personalHash;
    expect(pinned).not.toBe(edited);
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, id));
    forgetAccountLibrary(db, userId);
    expect((await loadAccountLibrary(db, userId)).personalHash).not.toBe(pinned);
  });
});

describe("the library carried by a read that spends its statement anyway", () => {
  it("personalMovesSql read back is the same library loadAccountLibrary reads — the same arrays", async () => {
    const target = await addMove("Wall Angel Slide", "active", { pinned: true });
    await addMove("Prone Y Raise", "archived");
    await addMove("Wall Angels", "merged", { mergedInto: target });
    await addMove("Band Pull Apart Hold", "pending");
    const loaded = await loadAccountLibrary(db, userId);
    const [row] = (await db.all(sql`select ${personalMovesSql(userId)} as library`)) as Array<{ library: unknown }>;
    const carried = await accountLibraryFrom(db, userId, row!.library);
    expect(carried).toBe(loaded);
    // And it is the request's: a later read costs nothing.
    statements.length = 0;
    expect(await loadAccountLibrary(db, userId)).toBe(carried);
    expect(statements.length).toBe(0);
    // None: the public library itself.
    const other = (await makeTestUser(db)).userId;
    const [none] = (await db.all(sql`select ${personalMovesSql(other)} as library`)) as Array<{ library: unknown }>;
    expect(await accountLibraryFrom(db, other, none!.library)).toBe(PUBLIC_LIBRARY);
  });

  it("the coach's validate_workout judges a document's personal moves in the account's library, at its declared cost", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const pending = await addMove("Prone Y Raise", "pending");
    const validate = ACT_TOOLS.find((t) => t.name === "validate_workout")!;
    let use = 0;
    const ctx = (): ToolContext => ({
      db, env: {} as Env, userId, now: new Date(), toolUseId: `toolu_${++use}`,
      run: { id: "run-1", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false },
    });
    forgetAccountLibrary(db);
    statements.length = 0;
    const good = (await validate.run(ctx(), { doc: docOf("bridge", active), date: today })) as ToolOk;
    expect(statements.length).toBeLessThanOrEqual(validate.statementCost);
    expect((good.data as { errors: unknown[] }).errors).toEqual([]);
    const bad = (await validate.run(ctx(), { doc: docOf("bridge", pending), date: today })) as ToolOk;
    expect((bad.data as { errors: unknown[] }).errors).toContainEqual(expect.objectContaining({ path: "parts[0].items[1].libraryId", code: "unknown_exercise" }));
  });
});

describe("engineDataFor", () => {
  it("returns different data for two personal sets with the same profiles; the same set, the same data", async () => {
    const a = await addMove("Wall Angel Slide", "active", { pinned: true });
    const libraryA = await loadAccountLibrary(db, userId);
    const other = (await makeTestUser(db)).userId;
    const b = await addMove("Prone Y Raise", "active", { pinned: true, owner: other });
    const libraryB = await loadAccountLibrary(db, other);
    const dataA = engineDataFor(["tmj"], [], libraryA);
    const dataB = engineDataFor(["tmj"], [], libraryB);
    expect(dataA).not.toBe(dataB);
    expect(dataA.exercises.map((r) => r.id)).toContain(a);
    expect(dataA.exercises.map((r) => r.id)).not.toContain(b);
    expect(dataB.exercises.map((r) => r.id)).toContain(b);
    expect(engineDataFor(["tmj"], [], libraryA)).toBe(dataA);
    // No personal pool: the public library's data, shared by every account.
    expect(engineDataFor(["tmj"], [], await loadAccountLibrary(db, (await makeTestUser(db)).userId))).toBe(engineDataFor(["tmj"], []));
    expect(engineDataFor(["tmj"], []).exercises).toBe(EXERCISES);
  });
});

describe("documents holding personal moves", () => {
  it("a document holding an active personal move validates", async () => {
    await activateTmj(db, userId);
    const id = await addMove("Wall Angel Slide", "active");
    const res = await create(docOf("bridge", id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings.filter((w: { code: string }) => w.code === "unknown_exercise")).toEqual([]);
  });

  it("an unknown id is still unknown_exercise", async () => {
    await addMove("Wall Angel Slide", "active");
    const res = await create(docOf("bridge", "myNotAMove000000"));
    expect(res.status).toBe(422);
    expect(res.body.issues).toContainEqual(expect.objectContaining({ path: "parts[0].items[1].libraryId", code: "unknown_exercise", severity: "error" }));
  });

  it("a pending personal move is unknown_exercise", async () => {
    const id = await addMove("Wall Angel Slide", "pending");
    const res = await create(docOf(id));
    expect(res.status).toBe(422);
    expect(res.body.issues).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "unknown_exercise", severity: "error" }));
  });

  it("a document holding an archived personal move still validates and builds (Review Focus 4)", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const made = await create(docOf("bridge", id));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const workoutId = made.body.workout.id;
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, id));

    const built = await call("POST", `/api/sessions/${workoutId}/build`, {});
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    const build = built.body.build;
    expect(build.fromDoc.blocked).toEqual([]);
    expect(build.items.map((i: { exerciseId: string }) => i.exerciseId)).toEqual(["bridge", id]);
    expect(build.exercises[id]).toMatchObject({ id, name: "Wall Angel Slide" });
    expect(build.steps.some((s: { exerciseId: string | null }) => s.exerciseId === id)).toBe(true);
    // Never offered by ⇄: an archived move is only resolved.
    const offered = Object.values(build.fromDoc.slots ?? {}).flatMap((s: any) => [...(s.offers ?? []), ...(s.alternates ?? [])].map((c: { id: string }) => c.id));
    expect(offered).not.toContain(id);
    // Saved again as it stands, it still validates.
    const again = await call("PUT", `/api/workouts/${workoutId}/doc`, { doc: docOf("bridge", id), baseRev: made.body.workout.docRev });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it("⇄ offers an active personal move in a slot's place, never an archived one", async () => {
    // A pattern the public library has one move of, so the account's own moves are among the candidates.
    const press = { patterns: ["push-v"], regions: ["shoulders"] } as Partial<ExtractedMove>;
    const own = await addMove("Pike Press Hold", "active", { draft: press });
    const active = await addMove("Wall Press Slide", "active", { draft: press });
    const archived = await addMove("Wall Press Hold", "archived", { draft: press });
    const made = await create(docOf(own));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const build = (await call("POST", `/api/sessions/${made.body.workout.id}/build`, {})).body.build;
    const offers = Object.values(build.fromDoc.slots ?? {}).flatMap((s: any) => (s.offers ?? []).map((c: { id: string }) => c.id));
    expect(offers).toContain(active);
    expect(offers).not.toContain(archived);
  });

  it("a document holding a merged move's id builds as its target", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const made = await create(docOf(id));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const target = await addMove("Wall Slide", "active");
    await db.update(personalMoves).set({ status: "merged", mergedInto: target }).where(eq(personalMoves.id, id));
    const built = await call("POST", `/api/sessions/${made.body.workout.id}/build`, {});
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect(built.body.build.fromDoc.blocked).toEqual([]);
    expect(built.body.build.exercises[target]).toMatchObject({ id: target, name: "Wall Slide" });
  });

  it("editing a personal move changes the document build's inputsHash, and the build plays the edit", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const made = await create(docOf("bridge", id));
    const workoutId = made.body.workout.id;
    const first = (await call("POST", `/api/sessions/${workoutId}/build`, {})).body.build;
    // Built again with nothing changed: the stored build stands.
    expect((await call("POST", `/api/sessions/${workoutId}/build`, {})).body.build.buildId).toBe(first.buildId);
    const record = toPersonalRecord(id, { ...draft("Wall Angel Slide"), name: "Wall Angel Glide" });
    await db.update(personalMoves).set({ record, updatedAt: nowInstant() }).where(eq(personalMoves.id, id));
    const again = (await call("POST", `/api/sessions/${workoutId}/build`, {})).body.build;
    expect(again.inputsHash).not.toBe(first.inputsHash);
    expect(again.buildId).not.toBe(first.buildId);
    expect(again.exercises[id].name).toBe("Wall Angel Glide");
  });
});
