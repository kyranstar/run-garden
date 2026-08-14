/**
 * POST /api/studio/plans/:id/repair-exercise-ids (studio-repair.ts + the route
 * in studio.ts).
 *
 * The fixture deliberately mirrors the real broken plan rather than inventing
 * a clean one: stored `name`s are raw COROS i18n keys (`T1046`, `T1004`), the
 * catalog rows carry those same keys as their names, and the mapping contains
 * a genuine SWAP PAIR — `T1046`'s id → `T1004`'s id and `T1004`'s id →
 * somewhere else — because the swap is the case a naive sequential rewrite
 * gets wrong (rule 1 moves the exercise onto `T1004`, rule 2 then re-reads it
 * and moves it again). Everything asserted here is asserted against the
 * ORIGINAL plan's content, never against an intermediate.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type LiftingPlan, type PlanBrief, type StudioExercise } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
import { applyExerciseRemap } from "../src/services/studio-repair.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { auditEvents, corosExercises, corosWriteJobs, studioPlans } = schema;

/** Real COROS ids/keys, so `resolveExerciseName` runs its real translation. */
const PUSHUPS = "425827704936513536"; // T1004 Push-ups
const LOW_CABLE_FLYS = "425831365053956096"; // T1046 Low Cable Flys
const DB_BENCH = "469656087885430784"; // T1302 Dumbbell Bench Press
const SEATED_FRONT_PRESS = "425828538697039873"; // T1015 Seated Front Press
const PLANKS = "425827856334110721"; // T1010 Planks
const GLUTE_STRETCH = "469654349765853184"; // T1244 Glute Stretch
const WARM_UP = "425898928110747648"; // T1120 Warm Up
const COOL_DOWN = "425898949585584128"; // T1122 Cool Down

const CATALOG: Array<[string, string]> = [
  [PUSHUPS, "T1004"],
  [LOW_CABLE_FLYS, "T1046"],
  [DB_BENCH, "T1302"],
  [SEATED_FRONT_PRESS, "T1015"],
  [PLANKS, "T1010"],
  [GLUTE_STRETCH, "T1244"],
  [WARM_UP, "T1120"],
  [COOL_DOWN, "T1122"],
];

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

function ex(over: Partial<StudioExercise> & { originId: string; name: string }): StudioExercise {
  return {
    sets: 3,
    reps: 10,
    weight: { type: "bodyweight" },
    restSeconds: 90,
    ...over,
  } as StudioExercise;
}

/**
 * Two weeks × one session. Week 1 carries the swap pair plus a cool-down slot
 * whose stored id is a loaded lift (the shape of the original bug); week 2
 * repeats two of them so instance counting has something to count.
 */
function brokenPlan(): LiftingPlan {
  const brief: PlanBrief = {
    goal: "general",
    durationWeeks: 2,
    sessionsPerWeek: 1,
    preferredDays: [2],
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "wrists",
    notes: "",
    startDate: "2026-09-07",
  } as PlanBrief;
  return {
    name: "Broken Block",
    brief,
    weeks: [
      {
        sessions: [
          {
            title: "W1 Tue - Upper",
            weekday: 2,
            exercises: [
              // SWAP PAIR, half one: stored as T1004 (Push-ups), is really a
              // dumbbell bench press at 12 kg.
              ex({
                originId: PUSHUPS,
                name: "T1004",
                sets: 4,
                reps: 8,
                weight: { type: "kg", value: 12 },
                restSeconds: 120,
                note: "DB bench. Elbows 45 degrees.",
              }),
              // SWAP PAIR, half two: stored as T1046 (Low Cable Flys), is
              // really the push-ups — and wants the id half one is vacating.
              ex({
                originId: LOW_CABLE_FLYS,
                name: "T1046",
                note: "Push-ups. Hands elevated if form breaks.",
              }),
              // A cool-down slot pointing at a loaded lift.
              ex({
                originId: SEATED_FRONT_PRESS,
                name: "T1015",
                sets: 1,
                reps: 1,
                restSeconds: 0,
                note: "COOL-DOWN: pigeon stretch, 60s per side.",
              }),
              // No catalog equivalent — becomes the generic Cool Down.
              ex({
                originId: PLANKS,
                name: "T1010",
                sets: 1,
                reps: 1,
                restSeconds: 0,
                note: "COOL-DOWN: 5 min diaphragmatic breathing downshift.",
              }),
            ],
          },
        ],
      },
      {
        sessions: [
          {
            title: "W2 Tue - Upper",
            weekday: 2,
            exercises: [
              ex({
                originId: PUSHUPS,
                name: "T1004",
                sets: 4,
                reps: 6,
                weight: { type: "kg", value: 14 },
                restSeconds: 120,
                note: "DB bench, heavier.",
              }),
              ex({
                originId: SEATED_FRONT_PRESS,
                name: "T1015",
                sets: 1,
                reps: 1,
                restSeconds: 0,
                note: "COOL-DOWN: figure-4 glute stretch, 60s per side.",
              }),
            ],
          },
        ],
      },
    ],
  } as LiftingPlan;
}

/** The approved remap for `brokenPlan`, in request-body shape. */
function mapping(): Array<{ from: string; to: string; toName: string }> {
  return [
    { from: PUSHUPS, to: DB_BENCH, toName: "Dumbbell Bench Press" },
    { from: LOW_CABLE_FLYS, to: PUSHUPS, toName: "Push-ups" },
    { from: SEATED_FRONT_PRESS, to: GLUTE_STRETCH, toName: "Glute Stretch" },
    { from: PLANKS, to: COOL_DOWN, toName: "Cool Down" },
  ];
}

let db: Db;
let userId: string;
let cookie: string;
let planId: string;

async function seedPlan(over?: LiftingPlan, owner = userId): Promise<string> {
  const id = newId();
  const p = over ?? brokenPlan();
  await db.insert(studioPlans).values({
    id,
    userId: owner,
    brief: p.brief as unknown as Record<string, unknown>,
    plan: p as unknown as Record<string, unknown>,
    version: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

function client() {
  const app = mountRoutes(db, "/api/studio", studioRoutes);
  const env = makeEnv();
  return {
    post: (path: string, body?: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        env,
      ),
  };
}

const repair = (id: string, body: unknown, headers?: Record<string, string>) =>
  client().post(`/api/studio/plans/${id}/repair-exercise-ids`, body, headers);

async function storedPlan(id: string): Promise<LiftingPlan> {
  const row = (await db.select().from(studioPlans).where(eq(studioPlans.id, id)).limit(1))[0]!;
  return row.plan as unknown as LiftingPlan;
}

beforeEach(async () => {
  db = makeTestDb();
  const user = await makeTestUser(db, { corosWritesEnabled: true });
  userId = user.userId;
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  await db.insert(corosExercises).values(
    CATALOG.map(([id, name]) => ({ id, name, raw: {}, updatedAt: nowInstant() })),
  );
  planId = await seedPlan();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("permutation correctness", () => {
  it("applies a simultaneous swap pair (A→B and B→A) in one pass", async () => {
    const res = await repair(planId, { dryRun: false, mapping: mapping() });
    expect(res.status).toBe(200);

    const after = await storedPlan(planId);
    const w1 = after.weeks[0]!.sessions[0]!.exercises;
    // A→B: the DB-bench row moved OFF the push-up id...
    expect(w1[0]!.originId).toBe(DB_BENCH);
    // ...and B→A: the real push-ups took the id it vacated — NOT chained on to
    // DB_BENCH, which is what a sequential rewrite would have produced.
    expect(w1[1]!.originId).toBe(PUSHUPS);
    expect(w1[1]!.name).toBe("Push-ups");
    // Nothing ended up double-mapped.
    expect(after.weeks[1]!.sessions[0]!.exercises[0]!.originId).toBe(DB_BENCH);
  });

  it("is order-independent: reversing the mapping array gives the same plan", () => {
    const forward = applyExerciseRemap(brokenPlan(), mapping(), new Map(CATALOG));
    const reversed = applyExerciseRemap(brokenPlan(), [...mapping()].reverse(), new Map(CATALOG));
    expect(JSON.stringify(reversed.plan)).toBe(JSON.stringify(forward.plan));
  });

  it("leaves the input plan object untouched (no in-place mutation)", () => {
    const original = brokenPlan();
    const snapshot = JSON.stringify(original);
    applyExerciseRemap(original, mapping(), new Map(CATALOG));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("handles a 3-cycle (A→B→C→A) without collapsing it", () => {
    const cycle = [
      { from: PUSHUPS, to: LOW_CABLE_FLYS, toName: "Low Cable Flys" },
      { from: LOW_CABLE_FLYS, to: SEATED_FRONT_PRESS, toName: "Seated Front Press" },
      { from: SEATED_FRONT_PRESS, to: PUSHUPS, toName: "Push-ups" },
    ];
    const { plan, summary } = applyExerciseRemap(brokenPlan(), cycle, new Map(CATALOG));
    const w1 = plan.weeks[0]!.sessions[0]!.exercises;
    expect(w1.map((e) => e.originId)).toEqual([
      LOW_CABLE_FLYS,
      SEATED_FRONT_PRESS,
      PUSHUPS,
      PLANKS, // unmapped, left alone
    ]);
    // Three distinct sources, three distinct targets — nothing collapsed.
    expect(summary.warnings.filter((w) => w.code === "collision")).toHaveLength(0);
  });
});

describe("content preservation", () => {
  it("preserves loads, sets, reps, rest and notes byte-for-byte", async () => {
    const before = await storedPlan(planId);
    await repair(planId, { dryRun: false, mapping: mapping() });
    const after = await storedPlan(planId);

    const strip = (p: LiftingPlan) => ({
      ...p,
      weeks: p.weeks.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => ({
          ...s,
          exercises: s.exercises.map(({ originId: _o, name: _n, ...rest }) => rest),
        })),
      })),
    });
    // Everything except the two identity fields is identical, including key
    // order — a plain string comparison, not a deep-equal that would tolerate
    // a reshuffle.
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
    // And the brief (start date, constraints, notes) is not in scope at all.
    expect(JSON.stringify(after.brief)).toBe(JSON.stringify(before.brief));
    expect(after.name).toBe(before.name);
  });

  it("keeps an absent optional note absent rather than writing undefined", () => {
    const p = brokenPlan();
    delete (p.weeks[0]!.sessions[0]!.exercises[1] as { note?: string }).note;
    const { plan } = applyExerciseRemap(p, mapping(), new Map(CATALOG));
    expect(Object.hasOwn(plan.weeks[0]!.sessions[0]!.exercises[1]!, "note")).toBe(false);
  });
});

describe("placeholder (NONE) rows", () => {
  it("maps an exercise with no catalog equivalent onto the generic Cool Down", async () => {
    const res = await repair(planId, { dryRun: false, mapping: mapping() });
    const body = (await res.json()) as { warnings: Array<{ code: string; to?: string }> };

    const after = await storedPlan(planId);
    const breathing = after.weeks[0]!.sessions[0]!.exercises[3]!;
    expect(breathing.originId).toBe(COOL_DOWN);
    expect(breathing.name).toBe("Cool Down");
    // The instruction survives in the note — that is the whole point of the
    // placeholder rather than dropping the row.
    expect(breathing.note).toBe("COOL-DOWN: 5 min diaphragmatic breathing downshift.");
    // And the loss of movement identity is reported, never silent.
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ code: "placeholder_target", to: COOL_DOWN }),
    );
  });

  it("flags a Warm Up placeholder the same way", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: PLANKS, to: WARM_UP, toName: "Warm Up" }],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({ code: "placeholder_target", to: WARM_UP, instances: 1 }),
    );
  });
});

describe("dryRun", () => {
  it("changes nothing: no plan write, no version bump, no backup, no jobs", async () => {
    const before = JSON.stringify(await storedPlan(planId));
    const res = await repair(planId, { dryRun: true, mapping: mapping() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, dryRun: true, planVersion: 1, newVersion: null, backup: null });
    expect(JSON.stringify(await storedPlan(planId))).toBe(before);

    const row = (await db.select().from(studioPlans).where(eq(studioPlans.id, planId)).limit(1))[0]!;
    expect(row.version).toBe(1);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
  });

  it("reports exactly the same summary a live run would", async () => {
    const dry = (await (await repair(planId, { dryRun: true, mapping: mapping() })).json()) as Record<
      string,
      unknown
    >;
    const live = (await (await repair(planId, { dryRun: false, mapping: mapping() })).json()) as Record<
      string,
      unknown
    >;
    expect(live.totals).toEqual(dry.totals);
    expect(live.changes).toEqual(dry.changes);
    expect(live.warnings).toEqual(dry.warnings);
  });
});

describe("persistence, backup and blast radius", () => {
  it("bumps the version and writes a restorable pre-change backup", async () => {
    const before = await storedPlan(planId);
    const res = await repair(planId, { dryRun: false, mapping: mapping() });
    const body = (await res.json()) as {
      newVersion: number;
      backup: { auditEventId: string; kind: string; table: string };
    };

    expect(body.newVersion).toBe(2);
    expect(body.backup.table).toBe("audit_events");

    const row = (await db.select().from(studioPlans).where(eq(studioPlans.id, planId)).limit(1))[0]!;
    expect(row.version).toBe(2);

    const audit = (
      await db.select().from(auditEvents).where(eq(auditEvents.id, body.backup.auditEventId)).limit(1)
    )[0]!;
    expect(audit.kind).toBe("studio_plan_exercise_ids_repaired");
    const detail = audit.detail as Record<string, unknown>;
    expect(detail.studioPlanId).toBe(planId);
    expect(detail.fromVersion).toBe(1);
    expect(detail.toVersion).toBe(2);
    // The backup IS the pre-change plan — restoring it is a plain write-back.
    expect(JSON.stringify(detail.previousPlan)).toBe(JSON.stringify(before));

    await db
      .update(studioPlans)
      .set({ plan: detail.previousPlan as Record<string, unknown> })
      .where(eq(studioPlans.id, planId));
    expect(JSON.stringify(await storedPlan(planId))).toBe(JSON.stringify(before));
  });

  it("never enqueues a COROS write", async () => {
    await repair(planId, { dryRun: false, mapping: mapping() });
    expect(await db.select().from(corosWriteJobs)).toHaveLength(0);
    // The only audit row is this route's own backup — no `studio_plan_pushed`.
    const kinds = (await db.select().from(auditEvents)).map((r) => r.kind);
    expect(kinds).toEqual(["studio_plan_exercise_ids_repaired"]);
  });
});

describe("validation", () => {
  it("401s without a session cookie", async () => {
    expect((await repair(planId, { dryRun: true, mapping: mapping() }, {})).status).toBe(401);
  });

  it("404s for a plan belonging to another user, without touching it", async () => {
    const other = await makeTestUser(db);
    const foreignId = await seedPlan(brokenPlan(), other.userId);
    const before = JSON.stringify(await storedPlan(foreignId));

    const res = await repair(foreignId, { dryRun: false, mapping: mapping() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "plan_not_found" });
    expect(JSON.stringify(await storedPlan(foreignId))).toBe(before);
  });

  it("404s for a plan id that does not exist", async () => {
    expect((await repair(newId(), { dryRun: true, mapping: mapping() })).status).toBe(404);
  });

  it("rejects a `to` that is not a known coros_exercises id", async () => {
    const res = await repair(planId, {
      dryRun: true,
      mapping: [{ from: PUSHUPS, to: "999999999999999999", toName: "Nope" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_exercise", details: ["999999999999999999"] });
  });

  it("rejects a `from` that is not present in the plan", async () => {
    const res = await repair(planId, {
      dryRun: true,
      mapping: [{ from: GLUTE_STRETCH, to: PUSHUPS, toName: "Push-ups" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_from", details: [GLUTE_STRETCH] });
  });

  it("rejects a mapping that names one `from` twice", async () => {
    const res = await repair(planId, {
      dryRun: true,
      mapping: [
        { from: PUSHUPS, to: DB_BENCH, toName: "Dumbbell Bench Press" },
        { from: PUSHUPS, to: PLANKS, toName: "Planks" },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "duplicate_from", details: [PUSHUPS] });
  });

  it("rejects a body with no dryRun, an empty mapping, or an unknown field", async () => {
    expect((await repair(planId, { mapping: mapping() })).status).toBe(400);
    expect((await repair(planId, { dryRun: true, mapping: [] })).status).toBe(400);
    expect((await repair(planId, { dryRun: true, mapping: mapping(), force: true })).status).toBe(400);
  });

  it("rejects a stored plan that no longer validates, rather than repairing it", async () => {
    const broken = brokenPlan();
    (broken as { name?: string }).name = "";
    const badId = await seedPlan(broken as LiftingPlan);
    const res = await repair(badId, { dryRun: true, mapping: mapping() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "invalid_plan" });
  });
});

describe("summary shape", () => {
  it("reports totals, per-distinct-exercise before/after, and instance counts", async () => {
    const res = await repair(planId, { dryRun: true, mapping: mapping() });
    const body = (await res.json()) as {
      ok: boolean;
      dryRun: boolean;
      planId: string;
      planVersion: number;
      totals: Record<string, number>;
      changes: Array<Record<string, unknown>>;
      unmapped: unknown[];
      warnings: Array<{ code: string }>;
    };

    expect(body.planId).toBe(planId);
    expect(body.totals).toEqual({
      exercises: 6,
      changed: 6,
      unchanged: 0,
      distinctBefore: 4,
      distinctAfter: 4, // four sources, four distinct targets — a clean permutation
      rules: 4,
      rulesApplied: 4,
    });
    expect(body.unmapped).toEqual([]);

    // Most-used distinct exercise first (ties broken by id, so the ordering is
    // stable), with BOTH identities spelled out: the movement the plan wrongly
    // claims today and the one it will claim after.
    expect(body.changes[0]).toEqual({
      from: PUSHUPS,
      fromName: "T1004",
      fromCatalogName: "Push-ups",
      to: DB_BENCH,
      toName: "Dumbbell Bench Press",
      toCatalogName: "Dumbbell Bench Press",
      instances: 2,
    });
    expect(body.changes).toContainEqual({
      from: SEATED_FRONT_PRESS,
      fromName: "T1015",
      fromCatalogName: "Seated Front Press",
      to: GLUTE_STRETCH,
      toName: "Glute Stretch",
      toCatalogName: "Glute Stretch",
      instances: 2,
    });
    expect(body.changes.map((c) => c.instances)).toEqual([2, 2, 1, 1]);
  });

  it("lists exercises no rule covers instead of silently leaving them out", async () => {
    const res = await repair(planId, {
      dryRun: true,
      mapping: [{ from: PUSHUPS, to: DB_BENCH, toName: "Dumbbell Bench Press" }],
    });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      unmapped: Array<Record<string, unknown>>;
      warnings: Array<{ code: string; from: string[] }>;
    };
    expect(body.totals.changed).toBe(2);
    expect(body.totals.unchanged).toBe(4);
    expect(body.unmapped).toContainEqual({
      originId: SEATED_FRONT_PRESS,
      name: "T1015",
      catalogName: "Seated Front Press",
      instances: 2,
    });
    expect(body.warnings.filter((w) => w.code === "unmapped_exercise")).toHaveLength(3);
  });
});

describe("warnings", () => {
  it("reports a collision when two sources land on one target", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [
        { from: SEATED_FRONT_PRESS, to: GLUTE_STRETCH, toName: "Glute Stretch" },
        { from: PLANKS, to: GLUTE_STRETCH, toName: "Glute Stretch" },
      ],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual({
      code: "collision",
      from: [SEATED_FRONT_PRESS, PLANKS],
      to: GLUTE_STRETCH,
      name: "Glute Stretch",
      instances: 3,
    });
  });

  it("names the session when a collision merges two movements inside one", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [
        { from: SEATED_FRONT_PRESS, to: GLUTE_STRETCH, toName: "Glute Stretch" },
        { from: PLANKS, to: GLUTE_STRETCH, toName: "Glute Stretch" },
      ],
      new Map(CATALOG),
    );
    // Week 1 holds both sources; week 2 holds only one, so only week 1 is news.
    const dupes = summary.warnings.filter((w) => w.code === "duplicate_in_session");
    expect(dupes).toEqual([
      {
        code: "duplicate_in_session",
        from: [SEATED_FRONT_PRESS, PLANKS],
        to: GLUTE_STRETCH,
        name: "Glute Stretch",
        where: { week: 1, sessionTitle: "W1 Tue - Upper" },
        instances: 2,
      },
    ]);
  });

  it("does not call a pre-existing repetition a new duplicate", () => {
    const p = brokenPlan();
    // The same movement twice in one session, before any repair.
    p.weeks[0]!.sessions[0]!.exercises.push(
      ex({ originId: LOW_CABLE_FLYS, name: "T1046", note: "Second push-up set." }),
    );
    // Renamed onto a target nothing else in the session maps to, so the pair
    // is the SAME repetition it already was — not a merge of two movements.
    const { summary } = applyExerciseRemap(
      p,
      [{ from: LOW_CABLE_FLYS, to: GLUTE_STRETCH, toName: "Glute Stretch" }],
      new Map(CATALOG),
    );
    expect(summary.warnings.filter((w) => w.code === "duplicate_in_session")).toHaveLength(0);
  });

  it("flags a toName that is not what the catalog calls the target", async () => {
    const res = await repair(planId, {
      dryRun: true,
      mapping: [{ from: PUSHUPS, to: DB_BENCH, toName: "Dumbbell Bench Press (T1302)" }],
    });
    const body = (await res.json()) as { warnings: Array<{ code: string; to?: string }> };
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ code: "name_not_catalog_name", to: DB_BENCH }),
    );
  });

  it("flags a bodyweight prescription landing on an implement movement", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: LOW_CABLE_FLYS, to: DB_BENCH, toName: "Dumbbell Bench Press" }],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({ code: "bodyweight_on_implement_target", instances: 1 }),
    );
  });

  it("flags a real kg load landing on a stretch", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: PUSHUPS, to: GLUTE_STRETCH, toName: "Glute Stretch" }],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({ code: "kg_load_on_mobility_target", instances: 2 }),
    );
  });

  it("flags a loaded implement landing in a WARM-UP/COOL-DOWN slot", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: SEATED_FRONT_PRESS, to: DB_BENCH, toName: "Dumbbell Bench Press" }],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({ code: "recovery_slot_loaded_target", instances: 2 }),
    );
  });

  it("does not fire the implement heuristic on movement words alone", () => {
    // "Push-ups" is a press and "Planks" is a hold — neither names an
    // implement, so a bodyweight prescription on them is not suspicious.
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: LOW_CABLE_FLYS, to: PUSHUPS, toName: "Push-ups" }],
      new Map(CATALOG),
    );
    expect(summary.warnings.filter((w) => w.code.endsWith("_target"))).toHaveLength(0);
  });

  it("flags a rule that would be a no-op", () => {
    const { summary } = applyExerciseRemap(
      brokenPlan(),
      [{ from: PUSHUPS, to: PUSHUPS, toName: "Push-ups" }],
      new Map(CATALOG),
    );
    expect(summary.warnings).toContainEqual(
      expect.objectContaining({ code: "identity_rule", from: [PUSHUPS] }),
    );
  });
});

describe("no cross-user leakage", () => {
  it("scopes the update so only the caller's own plan row moves", async () => {
    const other = await makeTestUser(db);
    const foreignId = await seedPlan(brokenPlan(), other.userId);
    await repair(planId, { dryRun: false, mapping: mapping() });

    const foreign = (
      await db
        .select()
        .from(studioPlans)
        .where(and(eq(studioPlans.id, foreignId), eq(studioPlans.userId, other.userId)))
        .limit(1)
    )[0]!;
    expect(foreign.version).toBe(1);
    expect((foreign.plan as unknown as LiftingPlan).weeks[0]!.sessions[0]!.exercises[0]!.originId).toBe(
      PUSHUPS,
    );
  });
});
