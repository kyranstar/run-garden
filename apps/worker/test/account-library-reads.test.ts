/**
 * THE ACCOUNT'S LIBRARY, READ (saved-posts import, Task 13): every read, guard and pin that named the public library
 * alone now names the account's. An active personal move is found by search and pinnable; an archived one still reads by
 * id (an old workout, history, a pin made before — Review Focus 4) but is never offered, suggested or pinned; a pending
 * one is the review's alone, save for "Ask the coach" from the review screen. A session keeps a personal move's sets and
 * ratings; a converter keeps it a move; the watch gets it as free text by its own name; the owner lists their moves.
 * Synthetic data only (example.com links, made-up names).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, todayInZone, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { PROFILE_IDS } from "@rg/exercise-library";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import { deriveDoc, type BuildPayload } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { libraryRoutes } from "../src/routes/library.js";
import { forgetAccountLibrary, loadAccountLibrary } from "../src/services/account-library.js";
import { readExposure } from "../src/services/body-exposure.js";
import { createRun } from "../src/services/coach-runs.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { corosKeyOfName, libraryIdsByKey } from "../src/services/coros-exercise-map.js";
import { buildDesignContext, contextStatements } from "../src/services/design-context.js";
import { checkFocus, FocusError } from "../src/services/design-focus.js";
import { designedManifest } from "../src/routes/design-proposals.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import type { ToolContext, ToolOk } from "../src/services/design-tools/types.js";
import { loggedSetsByActivity } from "../src/services/logged-sets.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { buildSession, recordCheck } from "../src/services/session-build.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { watchPreview } from "../src/services/watch-push.js";
import { docForBuild } from "../src/services/workout-doc-store.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { clientFor, type Reply } from "./doc-workout-fixture.js";
import { DAY, NOON, seedCatalog, seedTmj, switchOn } from "./watch-push-fixture.js";

const { personalMoves, exercisePrefs, exerciseProvenance, performedSets, athleteAnswers, performedSessions } = schema;

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
let prefs: UserPreferences;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  today = todayInZone(prefs.timezone);
  call = await clientFor(db, userId);
  cookies.clear();
});

type Status = "pending" | "active" | "archived" | "merged";

/** A personal move of the account, stored as the import stores one; its id. */
async function addMove(name: string, status: Status, o: { mergedInto?: string; pinned?: boolean } = {}): Promise<string> {
  const id = personalMoveId(name, `${userId}:${name}`);
  const now = nowInstant();
  await db.insert(personalMoves).values({
    id, userId, status, mergedInto: o.mergedInto ?? null, batchId: null, record: toPersonalRecord(id, draft(name)), editedByOwner: false, createdAt: now, updatedAt: now,
  });
  if (o.pinned) await db.insert(exercisePrefs).values({ id: `${userId}:${id}`, userId, exerciseId: id, pinned: true, updatedAt: now });
  forgetAccountLibrary(db, userId);
  return id;
}

/** A saved post's link to a move, as saving a batch writes it. */
async function addLink(exerciseId: string, n: number): Promise<void> {
  await db.insert(exerciseProvenance).values({
    id: `prov-${exerciseId}-${n}`, userId, exerciseId, sourceType: "saves", url: `https://example.com/p/${n}`, creator: `Example Coach ${n}`,
    sourceKey: `post-${n}`, createdAt: `2026-10-0${n}T10:00:00.000Z`,
  });
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

let use = 0;
const toolCtx = (): ToolContext => ({
  db, env: {} as Env, userId, now: new Date(), toolUseId: `toolu_${++use}`,
  run: { id: "run-1", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false },
});
const readTool = (name: string) => READ_TOOLS.find((t) => t.name === name)!;
const U = (text: string) => ({ untrusted: true, text });

/** Each signed-in user's cookie, made once (its write is no request's). */
const cookies = new Map<string, string>();
async function cookieOf(who: string): Promise<string> {
  if (!cookies.has(who)) cookies.set(who, `${SESSION_COOKIE}=${await createSession(db, who, "test")}`);
  return cookies.get(who)!;
}

async function library(method: "GET" | "PUT", path: string, body?: unknown): Promise<Reply> {
  const cookie = await cookieOf(userId);
  const res = await mountRoutes(db, "/api/library", libraryRoutes).request(
    `/api/library${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    switchOn(),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function madeAndBuilt(doc: WorkoutDoc): Promise<{ workoutId: string; build: Record<string, any> }> {
  const made = await call("POST", "/api/workouts", { date: today, doc });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const built = await call("POST", `/api/sessions/${made.body.workout.id}/build`, {});
  expect(built.status, JSON.stringify(built.body)).toBe(200);
  return { workoutId: made.body.workout.id, build: built.body.build };
}

describe("the coach's library reads", () => {
  it("search_library finds an active personal move by name and marks it yours; an archived one is never found", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const archived = await addMove("Wall Angel Hold", "archived");
    statements.length = 0;
    const res = (await readTool("search_library").run(toolCtx(), { query: "wall angel", withSummary: true })) as ToolOk;
    expect(statements.length).toBeLessThanOrEqual(readTool("search_library").statementCost);
    const moves = (res.data as { moves: Array<Record<string, unknown>> }).moves;
    const mine = moves.find((m) => m.id === active);
    expect(mine).toMatchObject({ id: active, name: U("Wall Angel Slide"), yours: true, summary: U("Wall Angel Slide, slow and even.") });
    expect(moves.map((m) => m.id)).not.toContain(archived);
    // A public move is never marked so.
    expect(moves.filter((m) => m.id !== active).every((m) => m.yours === undefined)).toBe(true);
  });

  it("get_exercise reads an archived personal move by id (Review Focus 4): the athlete's own, with its links, said archived", async () => {
    const archived = await addMove("Prone Y Raise Hold", "archived");
    await addLink(archived, 1);
    await addLink(archived, 2);
    statements.length = 0;
    const res = (await readTool("get_exercise").run(toolCtx(), { id: archived, howTo: true })) as ToolOk;
    expect(statements.length).toBeLessThanOrEqual(readTool("get_exercise").statementCost);
    const data = res.data as Record<string, any>;
    expect(data).toMatchObject({ id: archived, name: U("Prone Y Raise Hold"), summary: U("Prone Y Raise Hold, slow and even.") });
    expect(data.yours).toMatchObject({ own: true, archived: true, saved: true });
    // No note on these links (each written without one).
    expect(data.yours.links).toEqual([
      { url: U("https://example.com/p/1"), creator: U("Example Coach 1"), note: null },
      { url: U("https://example.com/p/2"), creator: U("Example Coach 2"), note: null },
    ]);
    expect(data.howTo.steps).toEqual([U("Set up tall."), U("Move slowly through the range.")]);
    // A public move with no link stays as it was: no links, not its own.
    const goblet = ((await readTool("get_exercise").run(toolCtx(), { id: "gobletSquat" })) as ToolOk).data as Record<string, any>;
    expect(goblet.yours.own).toBeUndefined();
    expect(goblet.yours.links).toBeUndefined();
    // A pending move is the review's alone.
    const pending = await addMove("Band Pull Apart Hold", "pending");
    expect(await readTool("get_exercise").run(toolCtx(), { id: pending })).toMatchObject({ error: "not_found" });
  });
});

describe("get_exercise: ratings a model read from a post (coach-context audit I6)", () => {
  it("a saved move the athlete never edited says whose its ratings are, and its safety and fit words say rated from the post; edited, they are the athlete's", async () => {
    await seedTmj(db, userId);
    const id = await addMove("Zorbex Neck Nod", "active");
    const read = async () => ((await readTool("get_exercise").run(toolCtx(), { id })) as ToolOk).data as Record<string, any>;
    const unedited = await read();
    expect(unedited.ratings).toBe("from the post's reading, not checked by the athlete");
    expect(Object.values(unedited.safety).length).toBeGreaterThan(0);
    for (const v of Object.values(unedited.safety)) expect(v).toMatch(/ \(rated from the post\)$/);
    if (unedited.fitWhy !== undefined) expect(unedited.fitWhy).toMatch(/^Rated from the post: /);
    await db.update(personalMoves).set({ editedByOwner: true }).where(eq(personalMoves.id, id));
    forgetAccountLibrary(db);
    const edited = await read();
    expect(edited.ratings).toBeUndefined();
    for (const v of Object.values(edited.safety)) expect(v).not.toContain("rated from the post");
    if (edited.fitWhy !== undefined) expect(edited.fitWhy).not.toContain("Rated from the post");
    // A library move's ratings are the library's own.
    const goblet = ((await readTool("get_exercise").run(toolCtx(), { id: "gobletSquat" })) as ToolOk).data as Record<string, any>;
    expect(goblet.ratings).toBeUndefined();
    for (const v of Object.values(goblet.safety)) expect(v).not.toContain("rated from the post");
  });
});

describe("a run asked from a personal move", () => {
  it("a pending move: the run starts, and its context names the move as not yet saved; a document placing it is still unknown_exercise", async () => {
    const pending = await addMove("Band Pull Apart Hold", "pending");
    const focus = { kind: "move" as const, id: pending };
    statements.length = 0;
    await checkFocus(db, userId, focus);
    // A personal id costs one statement; a library id none.
    expect(statements.length).toBe(1);
    statements.length = 0;
    await checkFocus(db, userId, { kind: "move", id: "gobletSquat" });
    expect(statements.length).toBe(0);

    const created = await createRun(db, userId, { scope: { kind: "now" }, request: "Fit this in.", focus }, new Date());
    expect(created.existing).toBe(false);
    statements.length = 0;
    const ctx = await buildDesignContext(db, {} as Env, userId, { id: created.run.id, role: "main", scope: { kind: "now" }, request: "Fit this in.", parentId: null, focus }, new Date());
    expect(statements.length).toBe(contextStatements("main", focus));
    expect(contextStatements("main", focus)).toBe(contextStatements("main") + 1);
    expect(ctx.header).toContain(`(id ${pending})`);
    expect(ctx.header).toContain("Band Pull Apart Hold");
    expect(ctx.header).toContain("(from your saves, not yet saved)");
    // A model's reading of a creator's post: marked as a saved post's words, never as the athlete's own wish.
    expect(ctx.header).toContain(markUntrusted("saved post", "Band Pull Apart Hold"));
    expect(ctx.header).toContain(markUntrusted("saved post", "Band Pull Apart Hold, slow and even."));
    expect(ctx.header).not.toContain(markUntrusted("athlete", "Band Pull Apart Hold"));

    const placed = await call("POST", "/api/workouts", { date: today, doc: docOf(pending) });
    expect(placed.status).toBe(422);
    expect(placed.body.issues).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "unknown_exercise" }));
  });

  it("a pending move's focus sees what the owner is looking at (verbatim audit gap 4): ratings per profile, its first steps, the post, the match — in the statements it had", async () => {
    const pending = await addMove("Band Pull Apart Hold", "pending");
    // Three steps over the three shown, one long (each cut at 80 characters).
    const long = `Squeeze the shoulder blades together and hold, ${"slowly ".repeat(20)}`;
    const [row] = await db.select().from(personalMoves).where(eq(personalMoves.id, pending));
    const rec = row!.record as { text: { steps: string[] } };
    await db.update(personalMoves).set({ record: { ...rec, text: { ...rec.text, steps: ["Set up tall.", long, "Lower with control.", "A fourth, not shown."] } } }).where(eq(personalMoves.id, pending));
    await db.insert(schema.savedPosts).values({
      id: "post-p", userId, source: "testsrc", sourceKey: "p", url: "https://example.com/p/p", creatorHandle: "coach_pending",
      firstSeenAt: NOON, status: "matched", updatedAt: NOON,
    });
    await db.insert(schema.savedPostMoves).values({
      id: "link-p", userId, postId: "post-p", position: 0, moveId: pending, moveKind: "personal", batchId: null, confidence: 0.3, checkFlag: true, status: "pending", createdAt: NOON,
    });
    const focus = { kind: "move" as const, id: pending };
    statements.length = 0;
    const ctx = await buildDesignContext(db, {} as Env, userId, { id: "run-p", role: "main", scope: { kind: "now" }, request: "Is this one fine for me?", parentId: null, focus }, new Date());
    expect(statements.length).toBe(contextStatements("main", focus));
    const saved = (text: string) => markUntrusted("saved post", text);
    const cut = `${Array.from(long).slice(0, 79).join("").trimEnd()}…`;
    expect(ctx.header).toContain(`- Ratings, from the post's reading (not checked by the athlete): TMJ clench 0 of 3, neckLoad 1 of 3, faceDown no.`);
    expect(ctx.header).toContain(`- Its first steps: ${saved("Set up tall.")}; ${saved(cut)}; ${saved("Lower with control.")}`);
    expect(ctx.header).not.toContain("A fourth, not shown.");
    expect(ctx.header).toContain(`- From a post by ${saved("coach_pending")}: ${saved("https://example.com/p/p")}`);
    expect(ctx.header).toContain("- Its match: low confidence; flagged Check this.");
    // Edited by the owner in review: the ratings are theirs.
    await db.update(personalMoves).set({ editedByOwner: true }).where(eq(personalMoves.id, pending));
    const edited = await buildDesignContext(db, {} as Env, userId, { id: "run-p2", role: "main", scope: { kind: "now" }, request: "Is this one fine for me?", parentId: null, focus }, new Date());
    expect(edited.header).toContain("- Ratings, as the athlete edited them: TMJ clench 0 of 3, neckLoad 1 of 3, faceDown no.");
  });

  it("an active move reads from the account's library; an unknown personal id is focus_not_found", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const focus = { kind: "move" as const, id: active };
    await checkFocus(db, userId, focus);
    const ctx = await buildDesignContext(db, {} as Env, userId, { id: "run-a", role: "main", scope: { kind: "now" }, request: null, parentId: null, focus }, new Date());
    expect(ctx.header).toContain(`(id ${active})`);
    expect(ctx.header).not.toContain("not yet saved");
    await expect(checkFocus(db, userId, { kind: "move", id: "myNotAMove000000" })).rejects.toBeInstanceOf(FocusError);
  });
});

describe("a coach's card holding a personal move", () => {
  it("names it by its name and derives its minutes in the account's library, in the manifest's one statement", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const op = {
      kind: "doc_workout", target: { kind: "new", date: today }, date: today, doc: docOf("bridge", id), review: null, issues: [], derived: {},
      by: { runId: "run-card", role: "designer" }, toolUseId: "toolu_card", at: new Date().toISOString(),
    } as unknown as DesignedOp;
    statements.length = 0;
    const manifest = await designedManifest(db, userId, "dp-run-card", [op], new Date());
    expect(statements.length).toBe(1);
    const [line] = manifest.lines;
    expect(line!.detail[1]).toMatch(/^Wall Angel Slide /);
    const library = await loadAccountLibrary(db, userId);
    expect(line!.minutes).toBe(deriveDoc(docOf("bridge", id), library.all).estimatedMinutes);
  });
});

describe("suggestions come only from what is offered", () => {
  it("a document naming an archived move validates; an unknown move's suggested fix never names an archived move", async () => {
    const archived = await addMove("Prone Y Raise Hold", "archived");
    const active = await addMove("Wall Angel Slide", "active");
    expect((await call("POST", "/api/workouts", { date: today, doc: docOf("bridge", archived) })).status).toBe(201);
    // Spelled loosely, each would be guessed by its name: the active one is, the archived one is not.
    const res = await call("POST", "/api/workouts", { date: today, doc: docOf("prone-y-raise-hold", "wall-angel-slide") });
    expect(res.status).toBe(422);
    const fixOf = (i: number) => res.body.issues.find((x: { path: string; code: string }) => x.path === `parts[0].items[${i}].libraryId` && x.code === "unknown_exercise")?.fix;
    expect(fixOf(1)).toBe(active);
    expect(fixOf(0)).not.toBe(archived);
  });
});

describe("pins", () => {
  it("setExercisePrefs pins an active personal move (the engine's pool then holds it)", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    await cookieOf(userId);
    statements.length = 0;
    expect((await library("PUT", "/gobletSquat/prefs", { rating: 1 })).status).toBe(200);
    // A public id: the session, requireUser's restore check, the service's own, the write, the read back — no library read.
    expect(statements.length).toBe(5);
    statements.length = 0;
    const res = await library("PUT", `/${active}/prefs`, { pinned: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // A personal id: one more, the account's library (is it offered?).
    expect(statements.length).toBe(6);
    expect(res.body.prefs).toMatchObject({ exerciseId: active, pinned: true });
    forgetAccountLibrary(db, userId);
    expect((await loadAccountLibrary(db, userId)).engine.map((r) => r.id)).toContain(active);
  });

  it("refuses an unknown, a pending, an archived (never offered, so not pinnable) and a merged personal id with 404", async () => {
    const target = await addMove("Wall Angel Slide", "active");
    const pending = await addMove("Band Pull Apart Hold", "pending");
    const archived = await addMove("Prone Y Raise Hold", "archived");
    const merged = await addMove("Wall Angels", "merged", { mergedInto: target });
    for (const id of ["myNotAMove000000", pending, archived, merged]) {
      const res = await library("PUT", `/${id}/prefs`, { pinned: true });
      expect(res.status, id).toBe(404);
    }
    expect(await db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId))).toEqual([]);
  });
});

describe("the owner's own moves: GET /api/library/personal", () => {
  it("lists active and archived moves with their links, never pending or merged ones — in three statements", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const archived = await addMove("Prone Y Raise Hold", "archived");
    const pending = await addMove("Band Pull Apart Hold", "pending");
    const merged = await addMove("Wall Angels", "merged", { mergedInto: active });
    await addLink(active, 1);
    await addLink(merged, 2);
    await addLink(archived, 3);
    await cookieOf(userId);
    statements.length = 0;
    const res = await library("GET", "/personal");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The session's own read, the library, the links.
    expect(statements.length).toBe(3);
    const moves = res.body.moves as Array<{ record: { id: string; name: string }; status: string; links: Array<{ url: string | null; creator: string | null }> }>;
    expect(moves.map((m) => [m.record.id, m.status])).toEqual([
      [archived, "archived"],
      [active, "active"],
    ]);
    expect(moves.map((m) => m.record.id)).not.toContain(pending);
    expect(moves.map((m) => m.record.id)).not.toContain(merged);
    // A move merged into it brings its link along.
    expect(moves.find((m) => m.record.id === active)!.links).toEqual([
      { url: "https://example.com/p/1", creator: "Example Coach 1", note: null },
      { url: "https://example.com/p/2", creator: "Example Coach 2", note: null },
    ]);
    expect(moves.find((m) => m.record.id === archived)).toMatchObject({ record: { name: "Prone Y Raise Hold" }, links: [{ url: "https://example.com/p/3", creator: "Example Coach 3" }] });
    // The merged move, with the move that answers for it (Task 15: the device resolves it as the Worker does).
    expect(res.body.merged).toEqual([{ id: merged, into: active }]);
    // Nothing yet: none.
    const other = await makeTestUser(db);
    userId = other.userId;
    expect((await library("GET", "/personal")).body).toEqual({ moves: [], merged: [] });
  });

  it("the browse list offers an active move and never an archived one; the item reads either", async () => {
    const active = await addMove("Wall Angel Slide", "active");
    const archived = await addMove("Wall Angel Hold", "archived");
    const list = await library("GET", "?q=wall%20angel");
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(active);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(archived);
    await cookieOf(userId);
    statements.length = 0;
    const item = await library("GET", `/${archived}`);
    expect(item.status).toBe(200);
    // The session, the account's library, then its prefs, links and history beside the profiles, the athlete's
    // timezone and the scheduled workouts that hold the move — for any id.
    expect(statements.length).toBe(8);
    statements.length = 0;
    expect((await library("GET", "/gobletSquat")).status).toBe(200);
    expect(statements.length).toBe(8);
    expect(item.body).toMatchObject({ id: archived, name: "Wall Angel Hold" });
    expect((await library("GET", "/myNotAMove000000")).status).toBe(404);
  });
});

describe("sessions and history", () => {
  it("a session save keeps a personal move's logged sets, its rating and its feedback", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const { workoutId, build } = await madeAndBuilt(docOf("bridge", id));
    const started = await call("POST", `/api/sessions/${workoutId}/start`, { buildId: build.buildId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const b = started.body.build;
    const performedId = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const now = nowInstant();
    const saved = await savePerformedSession(
      db, userId, performedId,
      {
        id: performedId, source: "app", sourceRef: null, workoutId, buildId: b.buildId, localDate: today,
        startedAt: now, endedAt: now, seconds: 600, plannedSeconds: b.plannedSeconds, minutes: b.minutes, mode: b.mode,
        theme: null, locationId: b.locationId, blockRef: null, blockNumber: null, completed: true,
        stepsTotal: b.steps.length, stepsDone: b.steps.length, movesDone: [], note: null, newMove: null,
        entries: [{ exerciseId: id, implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 10, seconds: null, load: null }, { setIndex: 1, reps: 9, seconds: null, load: null }] }],
        checks: [], review: { ratings: { [id]: 1 } },
      },
      { now, prefs },
    );
    expect(saved.status).toBe("saved");
    const sets = await db.select().from(performedSets).where(eq(performedSets.performedSessionId, performedId));
    expect(sets.map((s) => [s.exerciseId, s.reps])).toEqual([[id, 10], [id, 9]]);
    const [pref] = await db.select().from(exercisePrefs).where(eq(exercisePrefs.id, `${userId}:${id}`));
    expect(pref).toMatchObject({ exerciseId: id, rating: 1 });
    const answers = await db.select().from(athleteAnswers).where(eq(athleteAnswers.userId, userId));
    expect(answers).toContainEqual(expect.objectContaining({ questionId: "exercise_feedback", subjectId: id, valueNum: 1 }));
    // The activity feed names it by its name.
    const [session] = await db.select().from(performedSessions).where(eq(performedSessions.id, performedId));
    const feed = await loggedSetsByActivity(db, userId, [session!.activityId!], "lb");
    expect(feed.get(session!.activityId!)).toContainEqual(expect.objectContaining({ exerciseId: id, name: "Wall Angel Slide" }));
    // And the body read counts its region.
    forgetAccountLibrary(db);
    const exposure = await readExposure(db, userId, new Date(), { from: today, to: today });
    expect(exposure.unknown).not.toContain(id);
    expect(exposure.regions.get("upper-back") ?? 0).toBeGreaterThan(0);
  });

  it("the doc store's converter keeps a personal move an exercise item, never free text", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const { build } = await madeAndBuilt(docOf("bridge", id));
    const doc = docForBuild(build as BuildPayload);
    expect(doc).not.toBeNull();
    const items = doc!.parts.flatMap((p) => p.items);
    expect(items).toContainEqual(expect.objectContaining({ kind: "exercise", libraryId: id }));
    expect(items.some((i) => i.kind === "free_exercise")).toBe(false);
  });

  it("a pushed strength session carries a personal move as free text with its name, even one named as a catalog move", async () => {
    // A strength catalog name no library move maps: a personal move by that very name still goes as free text (an
    // unreviewed name match is no catalog step).
    const key = Object.keys(COROS_EXERCISE_NAMES).find((k) => /^T1\d{3}$/.test(k) && !libraryIdsByKey().has(k) && corosKeyOfName(COROS_EXERCISE_NAMES[k]!) === k)!;
    const name = COROS_EXERCISE_NAMES[key]!;
    await connectTestCoros(db, userId);
    await seedCatalog(db);
    const id = await addMove(name, "active");
    const { workoutId } = await madeAndBuilt(docOf("bridge", id));
    const preview = await watchPreview(db, switchOn(), userId, workoutId, { today, now: nowInstant(), prefs });
    expect(preview.refusal).toBeNull();
    const steps = preview.steps.filter((s) => s.name.startsWith(name.slice(0, 10)));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.freeText)).toBe(true);
  });
});

describe("round 1: what reaches the coach and the athlete", () => {
  it("read_history and read_day read a personal move's logged sets with its name, marked — within their declared cost", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const sid = "7c1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const at = `${today}T18:00:00.000Z`;
    await db.insert(performedSessions).values({
      id: sid, userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: today, startedAt: at,
      endedAt: null, seconds: 1800, plannedSeconds: 1800, minutes: 30, mode: "build", theme: null, locationId: null, blockRef: null,
      blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [], note: null, newMove: null, payloadHash: "h", createdAt: at, updatedAt: at,
    });
    await db.insert(performedSets).values([0, 1].map((setIndex) => ({
      id: `${sid}-${setIndex}`, performedSessionId: sid, entryIndex: 0, exerciseId: id, implement: null, format: "straight", perSide: false,
      setIndex, side: null, reps: 10, seconds: null, loadValue: null, loadUnit: null, loadKg: null, done: true, flags: [],
    })));
    for (const [name, input] of [["read_history", { from: today, to: today }], ["read_day", { date: today }]] as const) {
      forgetAccountLibrary(db);
      statements.length = 0;
      const res = (await readTool(name).run(toolCtx(), input)) as ToolOk;
      expect(statements.length, name).toBeLessThanOrEqual(readTool(name).statementCost);
      const entries = (res.data as { entries?: unknown[]; done?: unknown[] }).entries ?? (res.data as { done: unknown[] }).done;
      const moves = (entries[0] as { moves: unknown[] }).moves;
      expect(moves, name).toEqual([U(`${id} (Wall Angel Slide, the athlete's own move) 2 × 10`)]);
    }
  });

  it("a validator message naming a personal move reaches the coach marked; the same message of a public move stays plain", async () => {
    const id = await addMove("Wall Angel Slide", "active");
    const validate = ACT_TOOLS.find((t) => t.name === "validate_workout")!;
    // Seconds for a move counted in reps: a dose note that names the move.
    const doc = workoutDocSchema.parse({
      version: 1, title: "Upper back", intent: { summary: "Wake the upper back.", goals: ["posture"], focus: [], effort: "maintain" },
      parts: [{ purpose: "main", format: "straight", items: [id, "gobletSquat"].map((libraryId) => ({ kind: "exercise", libraryId, dose: { sets: 2, holdSec: 30, restSec: 30 } })) }],
      source: { kind: "studio" },
    });
    const res = (await validate.run(toolCtx(), { doc, date: today })) as ToolOk;
    const data = res.data as { errors: Array<{ path: string; message: unknown }>; warnings: Array<{ path: string; message: unknown }> };
    const issues = [...data.errors, ...data.warnings];
    const mine = issues.filter((i) => i.path.startsWith("parts[0].items[0]"));
    const theirs = issues.filter((i) => i.path.startsWith("parts[0].items[1]"));
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    for (const i of mine) expect(i.message, i.path).toMatchObject({ untrusted: true, text: expect.any(String) });
    expect(mine.some((i) => (i.message as { text: string }).text.includes("Wall Angel Slide"))).toBe(true);
    for (const i of theirs) expect(typeof i.message, i.path).toBe("string");
  });
});

describe("round 1: a sent build's Start refusal", () => {
  const LATER = "2026-10-09T19:05:00.000Z";
  const ctx = () => ({ today: DAY, now: NOON, prefs });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOON));
    await connectTestCoros(db, userId);
    await seedTmj(db, userId);
    await seedCatalog(db);
  });
  afterEach(() => vi.useRealTimers());

  const sessions = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
      `/api/sessions/${path}`,
      { method, headers: { Cookie: await cookieOf(userId), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      switchOn(),
    );
    return { status: res.status, body: await res.json() };
  };

  it("never names an archived personal move among its fixes", async () => {
    // A jump with one of the athlete's own moves as its alternate, sent at a calm reading; the move is archived since.
    const own = await addMove("Wall Slide Hold", "active");
    const doc = workoutDocSchema.parse({
      version: 1, title: "Landings", intent: { summary: "Land softly.", goals: ["athleticism"], focus: [], effort: "maintain" },
      parts: [{ purpose: "power", format: "straight", items: [{ kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5, restSec: 45 }, alternates: [{ libraryId: own }] }] }],
      source: { kind: "studio" },
    });
    await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx());
    const { workout } = await createDocWorkout(db, userId, { date: DAY, time: "18:00", doc }, ctx());
    const built = await buildSession(db, userId, workout.id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
    const buildId = built.build!.buildId;
    const preview = await sessions("GET", `${workout.id}/watch-preview`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect((await sessions("POST", `${workout.id}/send-to-watch`, { buildId, digest: preview.body.digest })).status).toBe(200);
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, own));
    // The jaw rises and the athlete feels off: the day's latest reading closes the jump.
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: LATER });
    const refused = await sessions("POST", `${workout.id}/start`, { buildId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe("gated");
    expect(refused.body.issues.length).toBeGreaterThan(0);
    expect(refused.body.issues.map((i: { fix?: string }) => i.fix)).not.toContain(own);
  });
});
