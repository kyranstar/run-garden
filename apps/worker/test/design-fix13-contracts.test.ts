/**
 * TASK 13'S FIX WAVE, THE TOOL CONTRACTS (stream S1): what the coach's act tools take and refuse after the live suite.
 *
 *  - §2.2 AN AMEND: propose_workout({ amend: true }) fixes the text of a reviewed draft — no reviewer, no round, the
 *    review kept with the change note among its changes; any other difference refused, naming the first path.
 *  - §2.3 NO EMPTY REVISIONS: a full revision of a reviewed draft whose review asked for nothing is refused, unless its
 *    change note names an open validator note's code.
 *  - §2.4 OVER-LENGTH DRAFTS: a draft well past its own target minutes is refused before any review, using no round.
 *  - §2.1 SOFT CAPS: free text is accepted whole up to four times its cap, and refused past that in words.
 *
 * Called directly with the loop's context and its review hooks (design-tools/types.ts). Synthetic data only: the
 * made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, workoutDocSchema } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { applyVerdict, countedRounds } from "../src/services/design-review.js";
import { capInWords, capWords, proseTooLong } from "../src/services/design-tools/act-common.js";
import { designProposalId, firstNonTextDiff, proposeWorkout, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { isToolErr, type DesignReview, type ReviewHooks, type ReviewStart, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const ENV = {} as Env;

let db: Db;
let userId: string;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await seedRichAthlete(db));
});

let seq = 0;
async function mainRun(scope: ToolContext["run"]["scope"] = { kind: "now" }): Promise<ToolContext["run"]> {
  const id = `run-${++seq}-${newId().slice(0, 8)}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { ...scope }, request: "a short session at home",
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: "main", scope, parentId: null, rehearsal: false };
}

/** The loop's review hooks, recording each reviewer started. */
function hooks(): { review: ReviewHooks; started: ReviewStart[] } {
  const started: ReviewStart[] = [];
  return { started, review: { start: async (req) => (started.push(req), true), ended: () => null } };
}

const ctxOf = (run: ToolContext["run"], review?: ReviewHooks): ToolContext => ({ db, env: ENV, userId, run, now: NOW, toolUseId: `toolu_c${++seq}`, ...(review ? { review } : {}) });

const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const err = (r: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.data).slice(0, 300)}`);
  return r;
};

/** A plain document: two parts, the text an amend may change and the rest it may not. */
function doc(over: { title?: string; whys?: [string, string]; reps?: number; sets?: number; targetMinutes?: number; notes?: string } = {}) {
  return {
    version: 1,
    title: over.title ?? "Hips and back",
    intent: { summary: "Wake the glutes and brace the trunk.", goals: ["posture"], focus: [], effort: "maintain" },
    ...(over.targetMinutes !== undefined ? { setting: { targetMinutes: over.targetMinutes } } : {}),
    parts: [
      {
        purpose: "main",
        format: "straight",
        why: "The day's main work.",
        items: [
          { kind: "exercise", libraryId: "bridge", dose: { sets: over.sets ?? 2, reps: over.reps ?? 12, restSec: 30 }, why: over.whys?.[0] ?? "Glutes on.", cue: "Ribs down." },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: over.sets ?? 2, reps: 8, restSec: 30 }, why: over.whys?.[1] ?? "Trunk on." },
        ],
      },
    ],
    ...(over.notes ? { notes: over.notes } : {}),
  };
}

const minutesOf = (d: unknown): number => deriveDoc(workoutDocSchema.parse({ ...(d as object), source: { kind: "coach" } }), EXERCISES).estimatedMinutes;

const review = (o: { mustFix?: string[] } = {}): DesignReview => ({
  scores: { intent: 4, sequencing: 4 },
  notes: { intent: "Clear.", sequencing: "Fine." },
  mustFix: o.mustFix ?? [],
  improvements: ["Say why the dead bug comes second."],
});

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return { ...p!, ops: p!.ops as DocWorkoutOp[] };
}

/** A main run holding one draft with its review in (the verdict applied as the loop applies it), and issues if given. */
async function reviewed(o: { mustFix?: string[]; issues?: DocWorkoutOp["issues"] } = {}) {
  const run = await mainRun();
  const h = hooks();
  const c = ctxOf(run, h.review);
  ok(await proposeWorkout.run(c, { doc: doc(), target: { kind: "new", date: TODAY } }));
  const p = await proposalOf(run.id);
  const op = applyVerdict(p.ops[0]!, c.toolUseId!, { review: review(o) })!;
  await db.update(schema.coachProposals).set({ ops: [{ ...op, ...(o.issues ? { issues: o.issues } : {}) }] }).where(eq(schema.coachProposals.id, p.id));
  h.started.length = 0;
  return { run, h };
}

// ── §2.2 The amend ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("an amend (§2.2): the reviewed draft's text fixed, no reviewer, no round", () => {
  it("title, summary, notes, a part's and a move's why and cue: stored, the review kept, the note among its changes", async () => {
    const { run, h } = await reviewed();
    const before = (await proposalOf(run.id)).ops[0]!;
    const amended = doc({ title: "Hips and trunk", whys: ["Glutes first, before the trunk.", "The trunk, once the hips are on."], notes: "Slow and even." });
    (amended.intent as { summary: string }).summary = "Glutes on, then the trunk.";
    const out = ok(await proposeWorkout.run(ctxOf(run, h.review), { doc: amended, target: { kind: "new", date: TODAY }, amend: true, changeNote: "Clearer whys" }));
    expect(out.data).toEqual({ stored: true, amended: true, proposalId: designProposalId(run.id), derived: expect.objectContaining({ minutes: expect.any(Number) }), issues: expect.any(Array) });
    expect(out).not.toHaveProperty("control");
    expect(h.started).toEqual([]);
    const op = (await proposalOf(run.id)).ops[0]!;
    expect(op.doc.title).toBe("Hips and trunk");
    expect(op.doc.notes).toBe("Slow and even.");
    expect(op.review!.scores).toEqual(before.review!.scores);
    expect(op.review!.changes).toEqual(["Clearer whys."]);
    expect(op.reviewLog!.map((r) => r.status)).toEqual(["reviewed", "amended"]);
    expect(countedRounds(op.reviewLog!)).toBe(1);
    expect(op.toolUseId).toBe(before.toolUseId);
  });

  it("a dose, a move or the target changed is no amend: refused, naming the first path that differs", async () => {
    const { run, h } = await reviewed();
    const dose = err(await proposeWorkout.run(ctxOf(run, h.review), { doc: doc({ reps: 10 }), target: { kind: "new", date: TODAY }, amend: true }));
    expect(dose.error).toBe("amend_not_text");
    expect(dose.why).toMatch(/^parts\[0\]\.items\[0\]\.dose\.reps differs/);
    const target = err(await proposeWorkout.run(ctxOf(run, h.review), { doc: doc(), target: { kind: "new", date: "2026-05-20" }, amend: true }));
    expect(target.error).toBe("amend_not_text");
    expect(h.started).toEqual([]);
    expect((await proposalOf(run.id)).ops[0]!.reviewLog!.map((r) => r.status)).toEqual(["reviewed"]);
  });

  it("nothing reviewed yet: nothing to amend", async () => {
    const run = await mainRun();
    const h = hooks();
    const e = err(await proposeWorkout.run(ctxOf(run, h.review), { doc: doc(), target: { kind: "new", date: TODAY }, amend: true }));
    expect(e.error).toBe("nothing_to_amend");
    expect(h.started).toEqual([]);
  });

  it("a replay of the amend answers what it stored, and writes nothing twice", async () => {
    const { run, h } = await reviewed();
    const c = ctxOf(run, h.review);
    const input = { doc: doc({ whys: ["Glutes first.", "Trunk second."] }), target: { kind: "new", date: TODAY }, amend: true, changeNote: "Plainer whys." };
    const first = ok(await proposeWorkout.run(c, input));
    const again = ok(await proposeWorkout.run(c, input));
    expect(again.data).toEqual(first.data);
    expect((await proposalOf(run.id)).ops[0]!.review!.changes).toEqual(["Plainer whys."]);
  });

  it("the text paths an amend may change, and nothing else", () => {
    expect(firstNonTextDiff(doc(), doc({ title: "Other", whys: ["a", "b"], notes: "n" }))).toBeNull();
    expect(firstNonTextDiff(doc(), doc({ sets: 3 }))).toBe("parts[0].items[0].dose.sets");
    const fewer = doc();
    fewer.parts[0]!.items.pop();
    expect(firstNonTextDiff(doc(), fewer)).toBe("parts[0].items[1]");
  });
});

// ── §2.3 No empty revisions ─────────────────────────────────────────────────────────────────────────────────────────

describe("no empty revisions (§2.3)", () => {
  it("a full revision of a reviewed draft that asked for nothing is refused, no reviewer started, no round used", async () => {
    const { run, h } = await reviewed();
    const e = err(await proposeWorkout.run(ctxOf(run, h.review), { doc: doc({ reps: 10 }), target: { kind: "new", date: TODAY }, changeNote: "Fewer reps." }));
    expect(e.error).toBe("nothing_to_fix");
    expect(e.why).toContain("Nothing must change in the reviewed draft: call finish — or propose_workout with amend: true for text-only fixes.");
    expect(h.started).toEqual([]);
    expect((await proposalOf(run.id)).ops[0]!.reviewLog).toHaveLength(1);
  });

  it("allowed when the change note names an open validator note's code, or the review has a must-fix", async () => {
    const issue = { path: "parts[0].format", code: "mode_limits" as const, message: "A Recover day doesn't use straight sets." };
    const named = await reviewed({ issues: [issue] });
    const fixed = await proposeWorkout.run(ctxOf(named.run, named.h.review), { doc: doc({ reps: 10 }), target: { kind: "new", date: TODAY }, changeNote: "Holds, for mode_limits." });
    expect(ok(fixed).control).toBe("review");
    expect(named.h.started).toHaveLength(1);
    const unnamed = await reviewed({ issues: [issue] });
    const e = err(await proposeWorkout.run(ctxOf(unnamed.run, unnamed.h.review), { doc: doc({ reps: 10 }), target: { kind: "new", date: TODAY }, changeNote: "Tweaks." }));
    expect(e.fix).toContain("open: mode_limits");
    const must = await reviewed({ mustFix: ["Fewer reps on the bridge."] });
    expect(ok(await proposeWorkout.run(ctxOf(must.run, must.h.review), { doc: doc({ reps: 10 }), target: { kind: "new", date: TODAY }, changeNote: "Fewer reps." })).control).toBe("review");
  });
});

// ── §2.4 Over-length drafts ─────────────────────────────────────────────────────────────────────────────────────────

describe("over-length drafts (§2.4): refused before any review, using no round", () => {
  it("past its own target by more than max(5 min, 15%): refused with both figures; within it, reviewed", async () => {
    const long = doc({ sets: 6, reps: 15 });
    const minutes = minutesOf(long);
    expect(minutes).toBeGreaterThan(12);
    const over = Math.max(1, minutes - 7);
    const run = await mainRun();
    const h = hooks();
    const e = err(await proposeWorkout.run(ctxOf(run, h.review), { doc: { ...long, setting: { targetMinutes: over } }, target: { kind: "new", date: TODAY } }));
    expect(e.error).toBe("too_long");
    expect(e.why).toBe(`${Math.round(minutes)} min against its target ${over}: trim it, or raise the target and say why in notes.`);
    expect(h.started).toEqual([]);
    expect(await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(run.id)))).toEqual([]);
    const near = Math.ceil(minutes - 5);
    expect(ok(await proposeWorkout.run(ctxOf(run, h.review), { doc: { ...long, setting: { targetMinutes: near } }, target: { kind: "new", date: TODAY } })).control).toBe("review");
  });
});

// ── §2.1 Soft caps ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("soft caps (§2.1): a change note is kept whole up to four times its cap, refused past it in words", () => {
  it("600 characters: kept whole; 900: refused with its length and the cap in words", async () => {
    const run = await mainRun();
    const note = `${"Shorter rests between the sets. ".repeat(18)}Done.`.slice(0, 600);
    ok(await proposeWorkout.run(ctxOf(run), { doc: doc(), target: { kind: "new", date: TODAY }, changeNote: note }));
    expect((await proposalOf(run.id)).ops[0]!.changeNote).toBe(note.trim());
    const e = err(await proposeWorkout.run(ctxOf(run), { doc: doc(), target: { kind: "new", date: TODAY }, changeNote: "x".repeat(900) }));
    expect(e.error).toBe("invalid_input");
    expect(e.why).toContain("changeNote is 900 characters; at most 200 — about 30 words");
    expect(e.fix).toMatch(/fewer words/);
  });

  it("caps in words", () => {
    expect(capWords(300)).toBe(45);
    expect(capWords(200)).toBe(30);
    expect(capInWords(300)).toBe("at most about 45 words (300 characters)");
    expect(proseTooLong("summary", 1410, 300)).toBe("summary is 1,410 characters; at most 300 — about 45 words");
    expect(JSON.stringify(proposeWorkout.inputSchema)).toContain(capInWords(200));
  });
});
