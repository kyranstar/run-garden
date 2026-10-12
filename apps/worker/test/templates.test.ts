/**
 * Saved templates (Stage 2 spec §9–§10): `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`,
 * `POST /api/templates/:id/use`. A template's document is checked with no day (does it fit at all); using one bumps
 * its uses and hands back the document stamped `basedOn: template`, which makes a template row when scheduled. Every
 * route user-scoped and counted. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { MAX_TEMPLATES } from "../src/services/workout-templates.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, type Reply } from "./doc-workout-fixture.js";

const { workoutTemplates } = schema;

// Scheduling a used template hands the calendar a sync step (doc-workouts.test.ts counts it); none runs here.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  call = await clientFor(db, userId);
});

async function save(name: string, doc: WorkoutDoc = calmDoc(), pinned?: boolean): Promise<Reply> {
  return call("POST", "/api/templates", { name, doc, ...(pinned === undefined ? {} : { pinned }) });
}

describe("templates", () => {
  it("saves one and lists it with its minutes and discipline", async () => {
    const doc = calmDoc();
    const res = await save("Morning reset", doc);
    expect(res.status).toBe(201);
    const derived = deriveDoc(doc, EXERCISES);
    expect(res.body.template).toMatchObject({
      name: "Morning reset",
      doc,
      pinned: false,
      uses: 0,
      lastUsedAt: null,
      minutes: derived.estimatedMinutes,
      discipline: derived.discipline,
    });
    expect(res.body.warnings).toEqual([]);
    const list = await call("GET", "/api/templates");
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t: { name: string }) => t.name)).toEqual(["Morning reset"]);
  });

  it("lists pinned first, then the most recently used, then by name", async () => {
    const a = (await save("Alpha")).body.template.id;
    await save("Bravo");
    await save("Charlie", calmDoc(), true);
    await call("POST", `/api/templates/${a}/use`);
    const names = (await call("GET", "/api/templates")).body.templates.map((t: { name: string }) => t.name);
    expect(names).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("422 for a document with a fatal issue (checked with no day) or a bad name; nothing saved", async () => {
    await activateTmj(db, userId);
    // A superset of three moves is wrong on any day.
    const three = calmDoc().parts[0]!.items.concat({ kind: "exercise", libraryId: "birdDog", dose: { sets: 2, reps: 6 } });
    const bad = await save("Three", { ...calmDoc(), parts: [{ purpose: "main", format: "superset", items: three }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid_doc");
    expect(bad.body.issues).toContainEqual(expect.objectContaining({ path: "parts[0].format", code: "format_mismatch", severity: "error" }));
    // A jump is no error in a template: the day decides, and a template has no day.
    expect((await save("Landings", landingsDoc({ alternates: false }))).status).toBe(201);
    for (const name of ["", "   ", "x".repeat(81)]) expect((await save(name)).status).toBe(422);
    expect((await call("POST", "/api/templates", { name: "Extra", doc: calmDoc(), extra: true })).status).toBe(422);
    expect((await db.select().from(workoutTemplates).where(eq(workoutTemplates.userId, userId))).map((t) => t.name)).toEqual(["Landings"]);
  });

  it("renames, re-pins and replaces the document; 404 for another user's", async () => {
    const id = (await save("Old name")).body.template.id;
    const next = calmDoc({ title: "Changed" });
    const res = await call("PUT", `/api/templates/${id}`, { name: "New name", pinned: true, doc: next });
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ id, name: "New name", pinned: true, doc: next });
    expect((await call("PUT", `/api/templates/${id}`, { name: "Only the name" })).body.template).toMatchObject({ name: "Only the name", pinned: true, doc: next });
    expect((await call("PUT", `/api/templates/${id}`, { doc: { title: "junk" } })).status).toBe(422);

    const other = await makeTestUser(db);
    const theirs = (await (await clientFor(db, other.userId))("POST", "/api/templates", { name: "Theirs", doc: calmDoc() })).body.template.id;
    expect((await call("PUT", `/api/templates/${theirs}`, { name: "Mine" })).status).toBe(404);
    expect((await call("DELETE", `/api/templates/${theirs}`)).status).toBe(404);
    expect((await call("POST", `/api/templates/${theirs}/use`)).status).toBe(404);
    expect((await call("GET", "/api/templates")).body.templates.map((t: { id: string }) => t.id)).toEqual([id]);
    const [kept] = await db.select().from(workoutTemplates).where(eq(workoutTemplates.id, theirs));
    expect(kept).toMatchObject({ name: "Theirs", uses: 0 });
  });

  /**
   * A whole-document write builds on a copy (the Add sheet's fresh read, the builder's opened template — either can be
   * the service worker's cached answer). With the copy's `baseUpdatedAt`, a template changed since is refused, 409
   * `stale_revision` with the template's own `updatedAt`, as a workout's stale `baseRev` is; nothing changes.
   */
  it("a write with a stale base is 409 stale_revision and changes nothing; the current base writes", async () => {
    const saved = (await save("Base", calmDoc())).body.template as { id: string; updatedAt: string };
    // Renamed elsewhere, a minute later.
    vi.setSystemTime(new Date(Date.now() + 60_000));
    let renamed: Reply;
    try {
      renamed = await call("PUT", `/api/templates/${saved.id}`, { name: "Renamed elsewhere" });
    } finally {
      vi.useRealTimers();
    }
    const current = renamed.body.template.updatedAt as string;
    expect(current).not.toBe(saved.updatedAt);

    const stale = await call("PUT", `/api/templates/${saved.id}`, { doc: landingsDoc(), baseUpdatedAt: saved.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "stale_revision", updatedAt: current });
    const [row] = await db.select().from(workoutTemplates).where(eq(workoutTemplates.id, saved.id));
    expect(JSON.parse(row!.doc)).toEqual(calmDoc());
    expect(row!.updatedAt).toBe(current);

    const ok = await call("PUT", `/api/templates/${saved.id}`, { doc: landingsDoc(), baseUpdatedAt: current });
    expect(ok.status).toBe(200);
    expect(ok.body.template.doc).toEqual(landingsDoc());
  });

  it("deletes one", async () => {
    const id = (await save("Gone soon")).body.template.id;
    expect(await call("DELETE", `/api/templates/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET", "/api/templates")).body.templates).toEqual([]);
    expect((await call("DELETE", `/api/templates/${id}`)).status).toBe(404);
  });

  it("use bumps the count and hands back the document based on the template; scheduled, it is a template row", async () => {
    const id = (await save("Reusable")).body.template.id;
    const used = await call("POST", `/api/templates/${id}/use`);
    expect(used.status).toBe(200);
    expect(used.body.template).toMatchObject({ id, uses: 1 });
    expect(used.body.template.lastUsedAt).toEqual(expect.any(String));
    expect(used.body.doc).toEqual({ ...calmDoc(), basedOn: { kind: "template", id } });
    expect((await call("POST", `/api/templates/${id}/use`)).body.template.uses).toBe(2);

    const today = todayInZone(prefs.timezone);
    const scheduled = await call("POST", "/api/workouts", { date: addDays(today, 1), doc: used.body.doc });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.workout.origin).toBe("template");
  });

  it("keeps at most 200 an account: the save past the cap is 409 too_many and writes nothing", async () => {
    for (let i = 0; i < MAX_TEMPLATES - 1; i++) {
      await db.insert(workoutTemplates).values({
        id: `cap-${i}`, userId, name: `T${i}`, doc: JSON.stringify(calmDoc()), pinned: false, uses: 0,
        lastUsedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    expect((await save("The last one")).status).toBe(201);
    expect(await save("One too many")).toEqual({ status: 409, body: { error: "too_many" } });
    const mine = await db.select().from(workoutTemplates).where(eq(workoutTemplates.userId, userId));
    expect(mine).toHaveLength(MAX_TEMPLATES);
    expect(mine.map((t) => t.name)).not.toContain("One too many");
    // Another account has its own room.
    const other = await makeTestUser(db);
    expect((await (await clientFor(db, other.userId))("POST", "/api/templates", { name: "Theirs", doc: calmDoc() })).status).toBe(201);
  });

  it("a stored document that no longer reads is listed without it, never a 500", async () => {
    const id = (await save("Damaged")).body.template.id;
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;
    sqlite.prepare("update workout_templates set doc = ? where id = ?").run("{not json", id);
    const list = await call("GET", "/api/templates");
    expect(list.status).toBe(200);
    expect(list.body.templates[0]).toMatchObject({ id, name: "Damaged", doc: null, minutes: null, discipline: null });
  });

  it("every route stays within the statement budget (≤ 45), with a full list", async () => {
    await activateTmj(db, userId);
    for (let i = 0; i < 30; i++) {
      await db.insert(workoutTemplates).values({
        id: `t-${i}`, userId, name: `Template ${i}`, doc: JSON.stringify(landingsDoc()), pinned: i % 5 === 0,
        uses: i, lastUsedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    const runs: Array<[string, () => Promise<Reply>]> = [
      ["GET", () => call("GET", "/api/templates")],
      ["POST", () => save("Counted", landingsDoc())],
      ["PUT", () => call("PUT", "/api/templates/t-1", { name: "Renamed", doc: landingsDoc({ reps: 10 }) })],
      ["use", () => call("POST", "/api/templates/t-2/use")],
      ["DELETE", () => call("DELETE", "/api/templates/t-3")],
    ];
    for (const [name, run] of runs) {
      statements.length = 0;
      const res = await run();
      expect(res.status, name).toBeLessThan(300);
      expect(statements.length, name).toBeLessThanOrEqual(45);
    }
  });
});
