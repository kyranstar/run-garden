/**
 * TASK 13'S FIX WAVE, THE REVIEW STREAM (fix13-brief.md, S2): THE SUGGESTION'S LINES SPEAK TO THE ATHLETE.
 *
 *  - Every review string the athlete can see — each dimension's note, the must-fix items, the improvements, what changed,
 *    the costs they chose, the note — passes through `athleteText` (a move's id becomes its name, a tool or "validator"
 *    plain words) and is clipped to its cap at a sentence end (§2.1, §2.8; 13b I8, 13c R5, 13d D2). The designer read it
 *    whole; the card shows it fitted.
 *  - A retired rubric id keeps a plain label (LEGACY_LABELS); an id no one knows is put in words — never shown raw
 *    (§2.10).
 *
 * Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { DEFAULT_USER_PREFERENCES, workoutDocSchema } from "@rg/domain";
import { designedManifest } from "../src/routes/design-proposals.js";
import type { Db } from "../src/services/db.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { docWorkoutLines, LEGACY_LABELS } from "../src/services/design-manifest.js";
import { REVIEW_ITEM_MAX, REVIEW_NOTE_MAX } from "../src/services/design-review.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb } from "./helpers.js";

let db: Db;
let statements = 0;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
});

const place = () => "Home";
const CLOCK = { now: new Date("2026-10-14T08:00:00.000Z"), prefs: DEFAULT_USER_PREFERENCES };

function op(over: Partial<DesignedOp> = {}): DesignedOp {
  return {
    kind: "doc_workout",
    target: { kind: "new", date: "2026-10-16" },
    date: "2026-10-16",
    doc: calmDoc(),
    review: null,
    issues: [],
    derived: {},
    by: { runId: "run-d1", role: "designer" },
    toolUseId: "toolu_1",
    at: "2026-10-14T08:00:00.000Z",
    ...over,
  } as DesignedOp;
}

const sentences = (n: number) => "The hips get a long easy hold here. ".repeat(Math.ceil(n / 36)).slice(0, n);

describe("the review as the athlete reads it (§2.1, §2.8)", () => {
  it("every string in their words — moves by name, no tool or app words — and fitted to its cap at a sentence end", () => {
    const [line] = docWorkoutLines(
      [
        op({
          review: {
            scores: { intent: 4, recovery: 3 },
            notes: {
              intent: "Swap gobletSquat ahead of deadBug: the validator wants the hinge fresh.",
              recovery: `${sentences(400)}`,
            },
            mustFix: ["read_balance shows no hamstring work: add some."],
            improvements: [`Cue the athlete's jaw on deadBug. ${sentences(300)}`],
            rounds: 2,
            changes: ["Moved gobletSquat earlier."],
            accepted: [{ dimension: "recovery", why: "heavier legs for the athlete's long run" }],
          } as DesignedOp["review"],
        }),
      ],
      place,
      CLOCK,
    );
    const r = line!.review!;
    expect(r.dimensions.find((d) => d.id === "intent")!.note).toBe("Swap Goblet squat ahead of Dead bug: the app's checks wants the hinge fresh.");
    const recovery = r.dimensions.find((d) => d.id === "recovery")!.note!;
    expect(recovery.length).toBeLessThanOrEqual(REVIEW_NOTE_MAX);
    expect(recovery.endsWith(".")).toBe(true);
    expect(r.mustFix).toEqual(["Your recent balance shows no hamstring work: add some."]);
    expect(r.improvements[0]!.startsWith("Cue your jaw on Dead bug.")).toBe(true);
    expect(r.improvements[0]!.length).toBeLessThanOrEqual(REVIEW_ITEM_MAX);
    expect(r.changes).toEqual(["Moved Goblet squat earlier."]);
    expect(r.accepted).toEqual(["Recovery — kept as you asked: heavier legs for your long run"]);
    for (const s of [...r.dimensions.map((d) => d.note ?? ""), ...r.mustFix, ...r.improvements, ...r.changes, ...r.accepted]) {
      expect(s, s).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+_[a-z_]+\b|validator/);
    }
  });

  it("a retired id keeps a plain label; an id no one knows is put in words — never its raw id (§2.10)", () => {
    expect(LEGACY_LABELS).toMatchObject({ time_fit: expect.any(String), equipment_fit: expect.any(String) });
    const [line] = docWorkoutLines(
      [op({ review: { scores: { intent: 5, time_fit: 4, equipment_fit: 3, pace_feel: 2 }, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [], accepted: [{ dimension: "time_fit", why: "the long version" }] } as DesignedOp["review"] })],
      place,
      CLOCK,
    );
    expect(line!.review!.dimensions).toEqual([
      { id: "intent", label: "Intent clarity", score: 5, note: null },
      { id: "time_fit", label: LEGACY_LABELS.time_fit, score: 4, note: null },
      { id: "equipment_fit", label: LEGACY_LABELS.equipment_fit, score: 3, note: null },
      { id: "pace_feel", label: "Pace feel", score: 2, note: null },
    ]);
    expect(line!.review!.accepted).toEqual([`${LEGACY_LABELS.time_fit} — kept as you asked: the long version`]);
    // An old review's mean is over its own dimensions.
    expect(line!.reviewMean).toBe(3.5);
  });
});

// ── §2.8: what the workout is for, and why each move ────────────────────

/** A document with whys, a rest and a move weighed against another. */
const whyDoc = () =>
  workoutDocSchema.parse({
    version: 1,
    title: "Hips, steady",
    intent: { summary: "Open the athlete's hips, then load them gently.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "main",
        format: "straight",
        items: [
          { kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12 }, why: "Glutes on before loading." },
          { kind: "rest", seconds: 30 },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8 }, alternates: [{ libraryId: "gobletSquat", why: "More load than the athlete's back wants today." }] },
        ],
      },
    ],
    source: { kind: "studio" },
  });

describe("a line says what the workout is for and why each move (§2.8; 13d D1, D3)", () => {
  it("the intent in the athlete's words; each move's why and the moves weighed instead, parallel to the detail", () => {
    const [line] = docWorkoutLines([op({ doc: whyDoc() })], place, CLOCK);
    expect(line!.intent).toBe("Open your hips, then load them gently.");
    expect(line!.detail).toHaveLength(3);
    expect(line!.whys).toEqual(["Glutes on before loading.", null, null]);
    expect(line!.alternates).toEqual([[], [], [{ name: "Goblet squat", why: "More load than your back wants today." }]]);
  });

  it("a now design says so (§2.6): the card reads it as now", () => {
    const [now, timed] = docWorkoutLines(
      [op({ target: { kind: "new", date: "2026-10-16", atNow: true } as DesignedOp["target"] }), op({ toolUseId: "toolu_2", by: { runId: "run-d2", role: "designer" } })],
      place,
      CLOCK,
    );
    expect(now!.atNow).toBe(true);
    expect(timed!.atNow).toBeUndefined();
  });
});

// ── §2.9: a set's card shows the plan's other days ──────────────────────

describe("a set's suggestion carries the plan's other sessions in its days (§2.9; 13d D7)", () => {
  async function proposal(userId: string, scope: "week" | "now", ops: unknown[]) {
    const runId = `run-${scope}-${userId}`;
    await db.insert(schema.coachRuns).values({
      id: runId, userId, parentId: null, role: "main", scope: { kind: scope }, request: "Plan my week.", status: "finished", state: null, steps: 1, costUsd: 0,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const id = designProposalId(runId);
    await db.insert(schema.coachProposals).values({ id, userId, title: "Set", evidence: "", rationale: "", flags: [], ops, status: "pending", createdAt: NOW.toISOString(), expiresAt: day(-3) });
    return id;
  }

  it("runs, programme sessions and other workouts in the set's span, in day order — never its own — in the manifest's one statement", async () => {
    const a = await seedRichAthlete(db);
    const ops = [
      op({ date: TODAY, target: { kind: "new", date: TODAY, time: "10:00" }, time: "10:00", by: { runId: "d1", role: "designer" }, toolUseId: "t1" } as Partial<DesignedOp>),
      // A revision of today's Studio workout: that session is the suggestion's own.
      op({ date: TODAY, target: { kind: "revise", workoutId: a.todayDocId, baseRev: 2 }, by: { runId: "d2", role: "designer" }, toolUseId: "t2" } as Partial<DesignedOp>),
      op({ date: day(-3), target: { kind: "new", date: day(-3) }, by: { runId: "d3", role: "designer" }, toolUseId: "t3" } as Partial<DesignedOp>),
    ];
    const id = await proposal(a.userId, "week", ops);
    statements = 0;
    const m = await designedManifest(db, a.userId, id, ops, NOW);
    expect(statements).toBe(1);
    expect(m.context).toEqual([
      { date: TODAY, time: "07:00", kind: "programme", title: "Strength", minutes: 35 },
      { date: day(-2), time: "07:00", kind: "programme", title: "Strength", minutes: 35 },
      { date: day(-3), time: "18:00", kind: "run", title: "Easy run", minutes: 45 },
    ]);
  });

  it("a suggestion of one workout for now has none", async () => {
    const a = await seedRichAthlete(db);
    const ops = [op({ date: TODAY, target: { kind: "new", date: TODAY }, by: { runId: "m1", role: "main" }, toolUseId: "t1" } as Partial<DesignedOp>)];
    const id = await proposal(a.userId, "now", ops);
    statements = 0;
    const m = await designedManifest(db, a.userId, id, ops, NOW);
    expect(statements).toBe(1);
    expect(m).not.toHaveProperty("context");
  });
});
