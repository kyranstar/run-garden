/**
 * INTENT CONSERVATION — five readers, one truth.
 *
 * A stored session is described back to a human by five different pieces of
 * code, and a person can see several of them within one tap:
 *
 *  1. `describeOps` — the manifest on the approval card ("what am I agreeing to");
 *  2. the plan DTO's rendered lines — Today's card, the week list, the session
 *     sheet (which re-derives its summary from the stage rows);
 *  3. the stored `planned_workouts.stage_summary` column;
 *  4. `summarizeStageRows` of that row's own stage rows;
 *  5. the coach dossier's `contains:` line — what the model is told the session
 *     holds, and therefore what it reasons about next week.
 *
 * They are compared IN PAIRS rather than all against one string, because they
 * legitimately render different amounts of detail; what they must never do is
 * describe a DIFFERENT SESSION. Every divergence is either declared by name in
 * `SURFACE_DIVERGENCES` or it fails here.
 *
 * The five declared divergences have two root causes — a third and fourth way
 * of rounding a distance, and a role label nobody wrote — and both are visible
 * to the athlete today, on screens that sit one tap apart.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { summarizeStageRows } from "@rg/scheduling";
import {
  coachOpSchema,
  describeOps,
  formatExercise,
  formatExerciseBlock,
  nowInstant,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import { applyOps } from "../src/services/coach-apply.js";
import { buildDossier } from "../src/services/coach-context.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import {
  FIXTURES,
  SURFACE_DIVERGENCES,
  THRESHOLD_SEC_PER_KM,
  type SurfaceDivergence,
  type SurfacePair,
} from "./intent-corpus.js";

const ENV = {
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
} as Env;

interface WorkoutDto {
  title: string;
  stageSummary: string | null;
  exercises?: Array<{ name: string; line: string; onWatch: boolean }>;
  exerciseRounds?: number;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let today: string;
/** Inside the dossier's UPCOMING 14 DAYS window, which is where the coach's
 * `contains:` line lives. */
let date: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  today = todayInZone(prefs.timezone);
  date = addDaysIso(today, 3);
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${today}`,
    userId,
    date: today,
    thresholdPaceSecPerKm: THRESHOLD_SEC_PER_KM,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
});

/** The UPCOMING 14 DAYS line for one workout — the only place the dossier says
 * what a session contains, and therefore the only line worth comparing. */
function upcomingLine(text: string, workoutId: string): string | undefined {
  return text
    .split("\n")
    .find((l) => l.includes(`[wo:${workoutId}]`) && l.includes(" · contains: "));
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every reader's account of one stored session. */
async function readEveryone(session: CoachSession) {
  const op = coachOpSchema.parse({ kind: "add", date, session }) as CoachOp;
  const out = await applyOps(db, userId, prefs, "surfaces", [op]);
  const workoutId = out.created[0]!;

  const [row] = await db
    .select()
    .from(schema.plannedWorkouts)
    .where(eq(schema.plannedWorkouts.id, workoutId));
  const stages = await db
    .select()
    .from(schema.plannedWorkoutStages)
    .where(eq(schema.plannedWorkoutStages.workoutId, workoutId))
    .orderBy(asc(schema.plannedWorkoutStages.ord));

  // 1 · the approval card's manifest, for exactly this op.
  const lines = describeOps([op]);
  expect(lines, "the manifest must name every date the op writes").toHaveLength(1);
  const manifest = lines[0]!;

  // 2 · the plan DTO, through the real route the session sheet calls.
  const app = mountRoutes(db, "/api/plan", planRoutes);
  const res = await app.request(
    `/api/plan/workouts/${workoutId}`,
    { headers: { Cookie: cookie } },
    ENV,
  );
  expect(res.status).toBe(200);
  const dto = ((await res.json()) as { workout: WorkoutDto }).workout;

  // 5 · what the coach is told this session contains.
  const dossier = await buildDossier(db, userId, prefs, today);
  // UPCOMING 14 DAYS is the only section that states what a session HOLDS; a
  // handle alone also appears in STRENGTH PLAN ("already prescribed …").
  const dossierLine = upcomingLine(dossier.text, workoutId);
  expect(dossierLine, "the dossier gave the coach no line for this session").toBeDefined();
  const contains = dossierLine!.split(" · contains: ")[1] ?? "";

  return {
    row: row!,
    stages,
    manifest,
    dto,
    stageRowSummary: stages.length > 0 ? summarizeStageRows(stages) : null,
    contains,
  };
}

describe("five readers describe the same session", () => {
  for (const f of FIXTURES) {
    it(`${f.name} — ${f.exercises}`, async () => {
      const s = f.session;
      const body = s.lift ?? s.mobility;
      const hasBody = (body?.exercises.length ?? 0) > 0 || (s.run?.blocks.length ?? 0) > 0;
      const seen = await readEveryone(s);
      const diverged = new Set<SurfacePair>();

      // Every reader agrees about the session's NAME and LENGTH, always. No
      // divergence may be declared for these: they are one number and one
      // string, and there is nothing to format differently about them.
      expect(seen.row.title).toBe(s.title);
      expect(seen.dto.title).toBe(s.title);
      expect(seen.manifest.summary).toBe(`${s.title} · ${s.durationMinutes} min`);
      expect(seen.row.calendarBlockDurationSeconds).toBe(s.durationMinutes * 60);

      // ── pair 1 · the manifest vs the stored summary ───────────────────────
      // With no body at all, the stored summary IS the title (stageSummary's
      // documented fallback) and the manifest has no detail to compare.
      const manifestDetail = seen.manifest.detail.join(" · ");
      if (!hasBody) {
        expect(seen.manifest.detail).toEqual([]);
        expect(seen.row.stageSummary).toBe(s.title);
      } else if (manifestDetail !== seen.row.stageSummary) {
        diverged.add("manifest_vs_stored");
      }

      // ── pair 2 · the stored summary vs the row's own stage rows ───────────
      // The session sheet prefers the derived one, so these two strings sit
      // one tap apart on the same screen.
      if (seen.stageRowSummary !== null && seen.stageRowSummary !== seen.row.stageSummary) {
        diverged.add("stored_vs_stage_rows");
      }

      // ── pair 3 · the card the athlete APPROVES vs the sheet they open ─────
      // Neither of these goes through the stored column, so they can disagree
      // while each agrees with something in between.
      if (hasBody && seen.stageRowSummary !== null && manifestDetail !== seen.stageRowSummary) {
        diverged.add("manifest_vs_stage_rows");
      }

      // ── pair 4 · the stored summary vs what the coach is told ─────────────
      if (seen.contains !== seen.row.stageSummary) diverged.add("stored_vs_dossier");

      // ── pair 5 · the manifest's detail vs the DTO's exercise lines ────────
      if (body && body.exercises.length > 0) {
        const dtoLines = (seen.dto.exercises ?? []).map((e) => e.line);
        const fromFormatter = body.exercises.map(formatExercise);
        expect(dtoLines, "the DTO renders exercises its own way").toEqual(fromFormatter);
        const expectedManifest = body.rounds
          ? [formatExerciseBlock(body)]
          : fromFormatter;
        if (JSON.stringify(seen.manifest.detail) !== JSON.stringify(expectedManifest)) {
          diverged.add("manifest_vs_dto_exercise_lines");
        }
        // A circuit must read as a circuit on every surface that can say so.
        expect(seen.dto.exerciseRounds ?? null).toBe(body.rounds ?? null);
        // `onWatch` is the one fact only the DTO carries: which movements the
        // watch's own library knows.
        expect((seen.dto.exercises ?? []).map((e) => e.onWatch)).toEqual(
          body.exercises.map((e) => !!e.originId),
        );
      }

      const declared = new Set(f.ledger.surfaces.map((d) => SURFACE_DIVERGENCES[d].pair));
      expect(
        [...diverged].sort(),
        `undeclared disagreement between readers of ${f.name}\n` +
          `  manifest:   ${manifestDetail}\n` +
          `  stored:     ${seen.row.stageSummary}\n` +
          `  stage rows: ${seen.stageRowSummary}\n` +
          `  dossier:    ${seen.contains}`,
      ).toEqual([...declared].sort());
    });
  }
});

describe("a multi-date add says how many days it is", () => {
  it("puts one manifest line, and one real row, on every date it names", async () => {
    const session = FIXTURES.find((f) => f.name === "mobility/flow")!.session;
    const dates = [date, addDaysIso(date, 1), addDaysIso(date, 2), addDaysIso(date, 3)];
    const op = coachOpSchema.parse({
      kind: "add",
      date: dates[0],
      dates: dates.slice(1),
      session,
    }) as CoachOp;

    const lines = describeOps([op]);
    expect(lines.map((l) => l.date)).toEqual(dates);

    const out = await applyOps(db, userId, prefs, "multi", [op]);
    expect(out.created).toHaveLength(dates.length);
    const rows = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.userId, userId));
    expect(rows.map((r) => r.effectiveDate).sort()).toEqual([...dates].sort());

    // The manifest, the rows and the dossier must all count the same days —
    // "on four days" is precisely the fact prose was getting wrong.
    const dossier = await buildDossier(db, userId, prefs, today);
    const dossierLines = dossier.text.split("\n").filter((l) => l.includes(session.title));
    expect(dossierLines).toHaveLength(dates.length);
    for (const line of lines) {
      expect(line.summary).toBe(`${session.title} · ${session.durationMinutes} min`);
      expect(line.detail).toEqual(session.mobility!.exercises.map(formatExercise));
    }
  });
});

describe("the readers still agree after the session is mutated", () => {
  it("add → ease: nothing anywhere still describes the session that was replaced", async () => {
    const from = FIXTURES.find((f) => f.name === "run/every-intensity-duration")!.session;
    const to = FIXTURES.find((f) => f.name === "lift/ski-prep")!.session;
    const seeded = await applyOps(db, userId, prefs, "s1", [
      coachOpSchema.parse({ kind: "add", date, session: from }),
    ]);
    const workoutId = seeded.created[0]!;
    await applyOps(db, userId, prefs, "s2", [
      coachOpSchema.parse({ kind: "ease", workoutId, session: to }),
    ]);

    const app = mountRoutes(db, "/api/plan", planRoutes);
    const dto = (
      (await (
        await app.request(`/api/plan/workouts/${workoutId}`, { headers: { Cookie: cookie } }, ENV)
      ).json()) as { workout: WorkoutDto; stages: unknown[] }
    ).workout;
    const [row] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, workoutId));
    const dossier = await buildDossier(db, userId, prefs, today);
    const line = upcomingLine(dossier.text, workoutId)!;

    // The prescription every surface shows is the NEW one…
    const expectedLines = to.lift!.exercises.map(formatExercise);
    expect((dto.exercises ?? []).map((e) => e.line)).toEqual(expectedLines);
    expect(row!.stageSummary).toBe(formatExerciseBlock(to.lift!));
    expect(line).toContain(formatExerciseBlock(to.lift!));
    // …and no surface still carries a trace of the run it replaced. The stage
    // rows are the ones that used to survive an ease and go on being rendered
    // by the sheet in preference to everything else.
    expect(dto.stageSummary).toBe(row!.stageSummary);
    expect(line).not.toContain(from.title);
    expect(
      await db
        .select()
        .from(schema.plannedWorkoutStages)
        .where(eq(schema.plannedWorkoutStages.workoutId, workoutId)),
    ).toEqual([]);
  });
});

describe("the surface ledger", () => {
  it("declares a pair for every named divergence, and no divergence twice per fixture", () => {
    for (const f of FIXTURES) {
      const pairs = f.ledger.surfaces.map((d: SurfaceDivergence) => SURFACE_DIVERGENCES[d].pair);
      expect(
        new Set(pairs).size,
        `${f.name} declares two causes for one pair — the test can only observe one`,
      ).toBe(pairs.length);
    }
  });
});
