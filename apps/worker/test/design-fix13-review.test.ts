/**
 * TASK 13'S FIX WAVE, THE REVIEW STREAM (fix13-brief.md, S2): what the review says, to whom, and how a stop ends.
 *
 *  - A rehearsal's stop proposes as production's does (13b I3, 13d D5): its proposal stays `rehearsal` — never one the
 *    athlete could act on — but gets the stop's note, and the trail says "Suggested what had been reviewed…"; a set's too.
 *  - A revision that scores the same as the version it was judged against says so plainly (13c's run view).
 *
 * The real registry, the real opening context and the real loop, driven by one scripted model shared by every run of
 * the tree. No key, no network, no billed call. Synthetic data only: the made-up athlete of design-read-fixture.ts, on
 * its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, LINES, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { promoteSetWithWhatItHas } from "../src/services/design-orchestrate.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { promoteWithWhatItHas, STOPPED_NOTES } from "../src/services/design-review.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesResult } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;

beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

const athlete = () => seedRichAthlete(db);

// ── One scripted model for the whole tree ───────────────────────────────

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_f13r${++seq}`, name, input });

function turn(uses: ContentBlock[], o: { cost?: number; text?: string } = {}): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: o.text ?? "Working on it." }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: o.cost ?? 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

function scripted(turns: Array<MessagesResult | (() => MessagesResult)>) {
  const deps: RunDeps = {
    callModel: async () => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return typeof next === "function" ? next() : next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps };
}

async function drive(userId: string, runId: string, deps: RunDeps, o: { max?: number } = {}) {
  const all: Array<{ status: string }> = [];
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: o.max ?? 60, what: "drive" },
  );
  return all;
}

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[], flags: p.flags as string[] } : undefined;
}
async function events(runId: string) {
  return db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq);
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
function verdict(score: number, o: { mustFix?: string[]; improvements?: string[] } = {}) {
  return {
    scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
    notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
    mustFix: o.mustFix ?? [],
    improvements: o.improvements ?? [],
  };
}
const propose = (title: string, changeNote?: string) =>
  use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date: TODAY }, ...(changeNote ? { changeNote } : {}) });
const submit = (v: unknown) => use("submit_review", v);
const finish = (summary = "A calm half hour for the hips.") => use("finish", { summary });

const newRun = async (userId: string, o: { rehearsal?: boolean } = {}) =>
  (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips.", rehearsal: o.rehearsal }, NOW)).run.id;

/** A reviewed op as a stored proposal holds it. */
function reviewedOp(runId: string, title: string, date: string): DocWorkoutOp {
  return {
    kind: "doc_workout",
    target: { kind: "new", date },
    date,
    doc: calmDoc({ title }),
    review: { ...verdict(4), rounds: 1, changes: [] },
    issues: [],
    derived: { minutes: 20, mode: "consistent" },
    by: { runId, role: "designer" },
    toolUseId: `toolu-${runId}`,
    at: NOW.toISOString(),
    reviewLog: [{ round: 1, toolUseId: `toolu-${runId}`, reviewRunId: `rv-${runId}`, status: "reviewed", review: verdict(4), mean: 4, kept: true }],
  } as DocWorkoutOp;
}

// ── D5 / I3: a rehearsal's stop ends as production's does ───────────────

describe("a rehearsal's stop proposes what was reviewed, as production's does (13b I3, 13d D5)", () => {
  it("the state cap after a clean review: the proposal stays a rehearsal, carries the stop's note, and the trail says it was suggested", async () => {
    const a = await athlete();
    const runId = await newRun(a.userId, { rehearsal: true });
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), turn([], { text: "x".repeat(70_000) })]);
    expect((await drive(a.userId, runId, deps)).at(-1)!.status).toBe("stopped_cap");
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("rehearsal");
    expect(p.flags).toEqual([STOPPED_NOTES.state_cap]);
    const trail = await events(runId);
    expect(trail.slice(-2).map((e) => e.summary)).toEqual([LINES.stateCap, LINES.proposed]);
    expect(trail.at(-1)!.payload).toMatchObject({ proposalId: designProposalId(runId) });
  });

  it("a rehearsal promoted twice gets its note once — and an athlete's proposal is still made pending", async () => {
    const a = await athlete();
    const id = `dp-f13-${a.userId}`;
    await db.insert(schema.coachProposals).values({
      id, userId: a.userId, title: "Calm hips", evidence: "", rationale: "", flags: [], ops: [reviewedOp("r1", "Calm hips", TODAY)],
      status: "rehearsal", createdAt: NOW.toISOString(), expiresAt: TODAY,
    });
    expect(await promoteWithWhatItHas(db, a.userId, id, STOPPED_NOTES.step_cap!)).toBe(true);
    expect(await promoteWithWhatItHas(db, a.userId, id, STOPPED_NOTES.step_cap!)).toBe(true);
    const [row] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    expect(row).toMatchObject({ status: "rehearsal", flags: [STOPPED_NOTES.step_cap] });

    const real = `dp-f13b-${a.userId}`;
    await db.insert(schema.coachProposals).values({
      id: real, userId: a.userId, title: "Calm hips", evidence: "", rationale: "", flags: [], ops: [reviewedOp("r2", "Calm hips", TODAY)],
      status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: TODAY,
    });
    expect(await promoteWithWhatItHas(db, a.userId, real, STOPPED_NOTES.step_cap!)).toBe(true);
    const [made] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, real));
    expect(made).toMatchObject({ status: "pending", flags: [STOPPED_NOTES.step_cap] });
  });

  it("a set's rehearsal stop proposes its reviewed workouts and stays a rehearsal; an unreviewed one is left out with its line", async () => {
    const a = await athlete();
    const id = `dp-f13set-${a.userId}`;
    const unreviewed = { ...reviewedOp("d3", "Day three", day(-2)), review: null, reviewLog: [] } as DocWorkoutOp;
    await db.insert(schema.coachProposals).values({
      id, userId: a.userId, title: "3 workouts", evidence: "", rationale: "", flags: [],
      ops: [reviewedOp("d1", "Day one", TODAY), reviewedOp("d2", "Day two", day(-1)), unreviewed],
      status: "rehearsal", createdAt: NOW.toISOString(), expiresAt: day(-2),
    });
    expect(await promoteSetWithWhatItHas(db, a.userId, id, STOPPED_NOTES.run_ceiling!, { mainRunId: "main-f13" })).toBe(true);
    const [row] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    expect(row!.status).toBe("rehearsal");
    expect((row!.ops as DocWorkoutOp[]).map((o) => o.doc.title)).toEqual(["Day one", "Day two"]);
    expect(row!.flags).toEqual([STOPPED_NOTES.run_ceiling, expect.stringMatching(/^Not reviewed before the stop, so left out: “Day three”/)]);
    // Once is enough: the same stop's note is never written twice.
    expect(await promoteSetWithWhatItHas(db, a.userId, id, STOPPED_NOTES.run_ceiling!, { mainRunId: "main-f13" })).toBe(true);
    const [again] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    expect(again!.flags).toEqual(row!.flags);
  });
});

// ── The trail's words ───────────────────────────────────────────────────

describe("the trail's words after a revision's review", () => {
  it("a revision that scores the same as the version it was judged against: 'Kept the revision — it scored the same, 4.0.'", async () => {
    const a = await athlete();
    const runId = await newRun(a.userId);
    const { deps } = scripted([
      t(propose("One")),
      t(submit(verdict(4, { mustFix: ["Shorter rests."] }))),
      t(propose("Two", "Shorter rests.")),
      t(submit(verdict(4))),
      t(finish()),
    ]);
    expect((await drive(a.userId, runId, deps)).at(-1)!.status).toBe("finished");
    const kept = (await events(runId)).map((e) => e.summary).filter((s) => s.startsWith("Kept"));
    expect(kept).toEqual(["Kept the revision — it scored the same, 4.0."]);
    expect((await proposalOf(runId))!.ops[0]!.doc.title).toBe("Two");
  });
});
