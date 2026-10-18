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
import { promoteSetWithWhatItHas, supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import {
  acceptedLine,
  applyVerdict,
  designerResult,
  markedReview,
  meanScore,
  parseReview,
  promoteWithWhatItHas,
  resumeAfterReview,
  REVIEW_ITEM_MAX,
  REVIEW_NOTE_MAX,
  reviewLine,
  reviewPacket,
  STOPPED_NOTES,
  submitReview,
} from "../src/services/design-review.js";
import { EXERCISES } from "@rg/exercise-library";
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

// ── §2.10: the rubric ───────────────────────────────────────────────────

describe("the rubric (§2.10)", () => {
  it("keeps every id but time_fit and equipment_fit, which merge into fit; adds request and words", () => {
    expect(DIMS).toEqual(["intent", "request", "sequencing", "alignment", "balance", "progression", "diversity", "recovery", "condition_safety", "fit", "specificity", "honesty", "words"]);
    const label = (id: string) => REVIEW_DIMENSIONS.find((d) => d.id === id)?.label;
    expect([label("fit"), label("request"), label("words")]).toEqual(["Fits your time and place", "Answers what you asked", "Clear words"]);
  });

  it("a review stored before the change keeps its mean: averaged over its own dimensions, never the new ones it lacks", () => {
    const old = ["intent", "sequencing", "alignment", "balance", "progression", "diversity", "recovery", "condition_safety", "time_fit", "equipment_fit", "specificity", "honesty"];
    const review = { scores: Object.fromEntries(old.map((d) => [d, 4])), notes: {}, mustFix: [], improvements: [] };
    expect(meanScore(review)).toBe(4);
    expect(reviewLine(review)).toBe("Reviewed: 4.0 of 5");
  });
});

// ── §2.1: the review's prose caps ───────────────────────────────────────

describe("a review's prose is never refused for length up to four times its cap (§2.1, 13b I1)", () => {
  const long = (n: number) => "A steady sentence about the hips. ".repeat(Math.ceil(n / 34)).slice(0, n);

  it("a long note, must-fix item or improvement is kept whole — the designer reads it whole", () => {
    const v = verdict(4, { mustFix: [long(600)], improvements: [long(500)] });
    const r = parseReview({ ...v, notes: { ...v.notes, recovery: long(400) } });
    if ("error" in r) throw new Error(r.why);
    expect(r.notes.recovery).toBe(long(400).trim());
    expect(r.mustFix[0]).toBe(long(600).trim());
    expect(r.improvements[0]).toBe(long(500).trim());
    const forDesigner = markedReview(r) as { notes: Record<string, { text: string }>; mustFix: Array<{ text: string }> };
    expect(forDesigner.notes.recovery!.text).toBe(long(400).trim());
    expect(forDesigner.mustFix[0]!.text).toBe(long(600).trim());
  });

  it("past four times the cap, the refusal says the length and the cap in words", () => {
    const v = verdict(4);
    const note = parseReview({ ...v, notes: { ...v.notes, recovery: long(1000) } });
    expect(note).toMatchObject({ error: "invalid_review", why: expect.stringContaining("notes.recovery is 1,000 characters; at most 240 — about 35 words") });
    const item = parseReview({ ...v, mustFix: [long(1200)] });
    expect(item).toMatchObject({ why: expect.stringContaining("mustFix.0 is 1,200 characters; at most 240 — about 35 words") });
    const accepted = parseReview({ ...v, accepted: [{ dimension: "recovery", why: long(1100) }] });
    expect(accepted).toMatchObject({ why: expect.stringContaining("accepted.0.why is 1,100 characters; at most 240 — about 35 words") });
    expect(parseReview({ ...v, notes: { ...v.notes, recovery: long(REVIEW_NOTE_MAX * 4) } })).not.toHaveProperty("error");
    expect(parseReview({ ...v, improvements: [long(REVIEW_ITEM_MAX * 4)] })).not.toHaveProperty("error");
  });

  it("the tool's schema states each cap in words, and no length the model must count", () => {
    type Prop = { description?: string; maxLength?: number; items?: Prop; properties?: Record<string, Prop> };
    const schema = submitReview.inputSchema as { properties: Record<string, Prop> };
    for (const k of ["notes", "mustFix", "improvements"]) expect(schema.properties[k]!.description, k).toContain("at most about 35 words (240 characters)");
    expect(Object.values(schema.properties.notes!.properties!).every((p) => p.maxLength === undefined)).toBe(true);
    expect(schema.properties.mustFix!.items!.maxLength).toBeUndefined();
    expect(schema.properties.accepted!.items!.properties!.why!.description).toMatch(/in a few words to them/);
  });
});

// ── R15, I8: a cost the athlete chose ───────────────────────────────────

describe("a cost the athlete chose (13c R15, 13b I8)", () => {
  it("condition safety is never accepted: a condition's cost always shows beside Approve", () => {
    const v = verdict(4);
    const r = parseReview({ ...v, scores: { ...v.scores, condition_safety: 2 }, accepted: [{ dimension: "condition_safety", why: "They asked for it." }] });
    expect(r).toMatchObject({ error: "invalid_review", why: expect.stringContaining("accepted.0.dimension: condition safety is never accepted") });
    const schema = submitReview.inputSchema as { properties: { accepted: { items: { properties: { dimension: { enum: string[] } } } } } };
    // With a run's own dimensions (designed runs, §8 §3: design-review-run.test.ts).
    expect(schema.properties.accepted.items.properties.dimension.enum).toEqual([...DIMS, "structure", "pace"].filter((d) => d !== "condition_safety"));
  });

  it("its line is written to the athlete: '<Label> — kept as you asked: <why>', in the athlete's words", () => {
    expect(acceptedLine({ dimension: "recovery", why: "heavier legs for the athlete's long run" })).toBe("Recovery — kept as you asked: heavier legs for your long run");
    expect(acceptedLine({ dimension: "fit", why: "the full gobletSquat set you asked for" })).toBe("Fits your time and place — kept as you asked: the full Goblet squat set you asked for");
  });
});

// ── §2.5: what the designer is told after a review ──────────────────────

describe("what the designer is told after a review (§2.5; 13a A3, 13b I5, 13c R2)", () => {
  const MODE_LIMITS = { path: "parts.0", code: "mode_limits", message: "A Recover day doesn't use straight sets.", fix: "Hold each move instead." };
  /** An op holding one reviewed draft (`u1`), with the validator's notes and derived fields. */
  function held(review: ReturnType<typeof verdict>, o: { issues?: unknown[]; roundsUsed?: number } = {}): DocWorkoutOp {
    const used = o.roundsUsed ?? 1;
    const log = Array.from({ length: used }, (_, i) => ({ round: i + 1, toolUseId: `u${i + 1}`, reviewRunId: `rv-${i + 1}`, status: "reviewed", review, mean: meanScore(review), kept: i + 1 === used }));
    return {
      ...reviewedOp("run-x", "Calm hips", TODAY),
      toolUseId: `u${used}`,
      review: { ...review, rounds: used, changes: [] },
      issues: o.issues ?? [],
      derived: { minutes: 31, mode: "recover", category: "mobility", balance: { holdSec: 600 } },
      reviewLog: log,
    } as DocWorkoutOp;
  }

  it("carries the draft's minutes and effort mode and its open validator notes — code, path, message, fix", () => {
    const r = designerResult(held(verdict(4), { issues: [MODE_LIMITS] }), "u1")!;
    expect(r.derived).toEqual({ minutes: 31, mode: "recover" });
    expect(r.issues).toEqual([MODE_LIMITS]);
  });

  it("must-fix → revise; an improvement or a fixable note → amend (text only, no new review), then finish; nothing → finish", () => {
    expect(designerResult(held(verdict(4, { mustFix: ["Shorter rests."] })), "u1")!.next).toBe(
      "Revise against the must-fix items and call propose_workout again with a changeNote.",
    );
    const improved = designerResult(held(verdict(4, { improvements: ["The why says Monday: the day is Tuesday."] })), "u1")!.next as string;
    expect(improved).toContain("propose_workout({ amend: true, changeNote })");
    expect(improved).toContain("text only, no new review");
    expect(improved).toMatch(/then call finish\.$/);
    const noted = designerResult(held(verdict(4), { issues: [MODE_LIMITS] }), "u1")!.next as string;
    expect(noted).toContain("amend: true");
    expect(noted).toContain("a full revision instead, its code in changeNote");
    expect(designerResult(held(verdict(4)), "u1")!.next).toBe("Nothing must change: call finish.");
    // No rounds left: a text fix is still an amend (it uses none), never a full revision.
    const last = designerResult(held(verdict(4), { issues: [MODE_LIMITS], roundsUsed: 3 }), "u3")!.next as string;
    expect(last).toContain("amend: true");
    expect(last).not.toContain("full revision");
  });

  it("says which open suggestions this one would replace, by the supersede's own rule — on the step's one read", async () => {
    const a = await athlete();
    const older = (id: string, ops: unknown[], at: string) =>
      db.insert(schema.coachProposals).values({ id, userId: a.userId, title: "Older", evidence: "", rationale: "", flags: [], ops, status: "pending", createdAt: at, expiresAt: TODAY });
    const newOp = (title: string, time: string | null, runId = "other") => ({
      ...reviewedOp(runId, title, TODAY),
      ...(time ? { time, target: { kind: "new", date: TODAY, time } } : {}),
      toolUseId: `t-${title}`,
    });
    const before = new Date(NOW.getTime() - 3_600_000).toISOString();
    // 175 minutes before 14:00 is the same session; 185 is another; another day, or decided, is never replaced.
    await older(`old-a-${a.userId}`, [newOp("Near", "11:05"), newOp("Far", "10:55")], before);
    await older(`old-b-${a.userId}`, [{ ...newOp("Decided", "13:30"), outcome: { status: "declined", at: before } }, { ...newOp("Tomorrow", "14:00"), date: day(-1), target: { kind: "new", date: day(-1), time: "14:00" } }], before);
    const id = `dp-mine-${a.userId}`;
    const mine = { ...newOp("Mine", "14:00", "run-me"), toolUseId: "u1", reviewLog: [{ round: 1, toolUseId: "u1", reviewRunId: "rv-1", status: "reviewed", review: verdict(4), mean: 4, kept: true }] };
    // Another designer's workout in the same set covers "Far": it is that designer's to say, not this one's.
    const sibling = newOp("Sibling", "10:50", "run-sibling");
    await db.insert(schema.coachProposals).values({ id, userId: a.userId, title: "Mine", evidence: "", rationale: "", flags: [], ops: [sibling, mine], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: TODAY });
    const out = await resumeAfterReview(db, a.userId, { proposalId: id, designerRunId: "run-me", toolUseId: "u1", reviewerError: null, now: NOW });
    expect(out.result.data).toMatchObject({ willReplace: [{ title: { untrusted: true, text: "Near" }, date: TODAY, time: "11:05" }] });
  });

  it("the resume reads once: the proposal and what it would replace, in one statement", async () => {
    let statements = 0;
    const counted = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
    const b = await seedRichAthlete(counted);
    const id = `dp-one-${b.userId}`;
    const mine = { ...reviewedOp("run-one", "Mine", TODAY), toolUseId: "u1" };
    await counted.insert(schema.coachProposals).values({ id, userId: b.userId, title: "Mine", evidence: "", rationale: "", flags: [], ops: [mine], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: TODAY });
    statements = 0;
    const out = await resumeAfterReview(counted, b.userId, { proposalId: id, designerRunId: "run-one", toolUseId: `toolu-run-one`, reviewerError: null, now: NOW });
    expect(out.result.data).toMatchObject({ willReplace: [] });
    expect(statements).toBe(1);
  });
});

// ── I8: the reviewer reads moves by name ────────────────────────────────

describe("the reviewer's packet names each move (13b I8, I9)", () => {
  it("each move and each alternate carries its name beside its id, and a move its condition ratings — so notes name moves, and get_exercise is rarely needed", () => {
    const doc = calmDoc();
    const first = doc.parts[0]!.items[0]! as { libraryId: string; alternates?: Array<{ libraryId: string; why?: string }> };
    first.alternates = [{ libraryId: "gobletSquat", why: "More load than today wants." }];
    const packet = reviewPacket({ round: 1, draft: { proposalId: "dp-x", target: { kind: "new", date: TODAY }, date: TODAY, doc, issues: [], derived: { minutes: 20 } }, records: [] });
    const bridge = EXERCISES.find((e) => e.id === "bridge")!;
    expect(packet).toContain(`"libraryId":"bridge","name":"Glute bridge","ratings":${JSON.stringify(bridge.conditions)}`);
    expect(packet).toContain('"libraryId":"deadBug","name":"Dead bug"');
    expect(packet).toContain('"alternates":[{"libraryId":"gobletSquat","name":"Goblet squat","why":"More load than today wants."}]');
    // The draft as stored is untouched: names are the packet's.
    expect(JSON.stringify(doc)).not.toContain("Glute bridge");
  });
});

// ── Round 2 (the whole-wave review: I2, Minors 9 and 13) ────────────────

describe("round 2 — a now design covers its own session, not the day (review I2)", () => {
  /** An op as a proposal stores it: a new workout on `date`, with `time` and `notBefore` as given. */
  const opAt = (title: string, o: { time?: string; notBefore?: string; atNow?: boolean; runId?: string }) =>
    ({
      ...reviewedOp(o.runId ?? `r-${title}`, title, TODAY),
      ...(o.time ? { time: o.time } : {}),
      target: { kind: "new", date: TODAY, ...(o.time ? { time: o.time } : {}), ...(o.atNow ? { atNow: true } : {}), ...(o.notBefore ? { notBefore: o.notBefore } : {}) },
      toolUseId: `t-${title}`,
    }) as DocWorkoutOp;
  const insert = (userId: string, id: string, ops: unknown[], status: string, createdAt: string) =>
    db.insert(schema.coachProposals).values({ id, userId, title: "P", evidence: "", rationale: "", flags: [], ops, status, createdAt, expiresAt: TODAY });
  const before = new Date(NOW.getTime() - 3_600_000).toISOString();
  const outcomeOf = async (id: string) => {
    const [row] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    return (row!.ops as Array<{ outcome?: { status?: string } }>)[0]!.outcome?.status ?? "open";
  };

  it("an untimed now design whose floor is 07:00 leaves a 19:00 suggestion open; one with neither time nor floor (stored before) covers the day", async () => {
    const a = await athlete();
    await insert(a.userId, `ev1-${a.userId}`, [opAt("Evening", { time: "19:00" })], "pending", before);
    await insert(a.userId, `now1-${a.userId}`, [opAt("Now reset", { atNow: true, notBefore: "07:00" })], "pending", NOW.toISOString());
    expect(await supersedeOlderPlans(db, a.userId, `now1-${a.userId}`, NOW.toISOString())).toBe(0);
    expect(await outcomeOf(`ev1-${a.userId}`)).toBe("open");

    const b = await athlete();
    await insert(b.userId, `ev2-${b.userId}`, [opAt("Evening", { time: "19:00" })], "pending", before);
    await insert(b.userId, `now2-${b.userId}`, [opAt("Old now", { atNow: true })], "pending", NOW.toISOString());
    expect(await supersedeOlderPlans(db, b.userId, `now2-${b.userId}`, NOW.toISOString())).toBe(1);
    expect(await outcomeOf(`ev2-${b.userId}`)).toBe("superseded");
  });

  it("willReplace reads the floor the same way: a morning floor doesn't claim the evening, a near one does", async () => {
    const a = await athlete();
    await insert(a.userId, `ev3-${a.userId}`, [opAt("Evening", { time: "19:00" }), opAt("Late morning", { time: "09:30" })], "pending", before);
    const mine = { ...opAt("Now reset", { atNow: true, notBefore: "07:00", runId: "run-now" }), toolUseId: "u1", reviewLog: [{ round: 1, toolUseId: "u1", reviewRunId: "rv-1", status: "reviewed", review: verdict(4), mean: 4, kept: true }] };
    await insert(a.userId, `dp-now3-${a.userId}`, [mine], "unreviewed", NOW.toISOString());
    const out = await resumeAfterReview(db, a.userId, { proposalId: `dp-now3-${a.userId}`, designerRunId: "run-now", toolUseId: "u1", reviewerError: null, now: NOW });
    expect(out.result.data).toMatchObject({ willReplace: [{ title: { untrusted: true, text: "Late morning" }, date: TODAY, time: "09:30" }] });
  });

  it("an open now suggestion it would replace is said as now — never its floor as a clock time (round 2 re-review, R2-M3)", async () => {
    const a = await athlete();
    // An older now design: placed when approved; 09:40 is only its floor (kept as its time too when the coach gave one).
    await insert(a.userId, `on-${a.userId}`, [opAt("Older now", { atNow: true, notBefore: "09:40", time: "09:40" })], "pending", before);
    const mine = { ...opAt("Mine", { time: "10:30", runId: "run-m" }), toolUseId: "u1", reviewLog: [{ round: 1, toolUseId: "u1", reviewRunId: "rv-1", status: "reviewed", review: verdict(4), mean: 4, kept: true }] };
    await insert(a.userId, `dp-m-${a.userId}`, [mine], "unreviewed", NOW.toISOString());
    const out = await resumeAfterReview(db, a.userId, { proposalId: `dp-m-${a.userId}`, designerRunId: "run-m", toolUseId: "u1", reviewerError: null, now: NOW });
    expect((out.result.data as { willReplace: unknown[] }).willReplace).toEqual([{ title: { untrusted: true, text: "Older now" }, date: TODAY, time: null, atNow: true }]);
  });
});

describe("round 2 — a rehearsal designer is told it replaces nothing (review Minor 9)", () => {
  it("a rehearsal's draft gets willReplace [] — a rehearsal supersedes nothing — though the athlete has an open suggestion it would cover", async () => {
    const a = await athlete();
    const before = new Date(NOW.getTime() - 3_600_000).toISOString();
    const open = { ...reviewedOp("r-open", "Open one", TODAY), time: "14:00", target: { kind: "new", date: TODAY, time: "14:00" }, toolUseId: "t-open" };
    await db.insert(schema.coachProposals).values({ id: `open-${a.userId}`, userId: a.userId, title: "Open", evidence: "", rationale: "", flags: [], ops: [open], status: "pending", createdAt: before, expiresAt: TODAY });
    const mine = { ...reviewedOp("run-rh", "Mine", TODAY), time: "14:30", target: { kind: "new", date: TODAY, time: "14:30" }, toolUseId: "u1", reviewLog: [{ round: 1, toolUseId: "u1", reviewRunId: "rv-1", status: "reviewed", review: verdict(4), mean: 4, kept: true }] };
    for (const status of ["rehearsal", "unreviewed"] as const) {
      const id = `dp-${status}-${a.userId}`;
      await db.insert(schema.coachProposals).values({ id, userId: a.userId, title: "Mine", evidence: "", rationale: "", flags: [], ops: [mine], status, createdAt: NOW.toISOString(), expiresAt: TODAY });
      const out = await resumeAfterReview(db, a.userId, { proposalId: id, designerRunId: "run-rh", toolUseId: "u1", reviewerError: null, now: NOW });
      expect((out.result.data as { willReplace: unknown[] }).willReplace, status).toHaveLength(status === "rehearsal" ? 0 : 1);
    }
  });
});

describe("round 2 — an amend's change line goes with the version it described (review Minor 13)", () => {
  /** The held round 1 (reviewed 3.0), amended, with round 2 under review as the candidate. */
  function amendedThenRevised(): DocWorkoutOp {
    const held = reviewedOp("run-am", "One", TODAY);
    const r1 = { round: 1, toolUseId: "u1", reviewRunId: "rv-1", status: "reviewed", review: verdict(3), mean: 3, kept: true };
    const amend = { round: 1, toolUseId: "u-am", reviewRunId: "rv-1", status: "amended", changeNote: "Clearer cue on the bridge.", change: "Clearer cue on the bridge." };
    const r2 = { round: 2, toolUseId: "u2", reviewRunId: "rv-2", status: "reviewing", changeNote: "Slower tempo." };
    const { candidate: _c, ...rest } = held as DocWorkoutOp & { candidate?: unknown };
    return {
      ...rest,
      toolUseId: "u1",
      round: 1,
      review: { ...verdict(3), rounds: 1, changes: ["Clearer cue on the bridge."] },
      reviewLog: [r1, amend, r2],
      candidate: { round: 2, toolUseId: "u2", reviewRunId: "rv-2", target: held.target, date: TODAY, doc: calmDoc({ title: "Two" }), changeNote: "Slower tempo.", issues: [], derived: { minutes: 22 }, at: NOW.toISOString() },
    } as unknown as DocWorkoutOp;
  }

  it("a revision that wins takes the held version's amend line with it; one that loses leaves it", () => {
    const won = applyVerdict(amendedThenRevised(), "u2", { review: verdict(4) })!;
    expect(won.doc.title).toBe("Two");
    expect(won.review!.changes).toEqual(["Slower tempo."]);
    const lost = applyVerdict(amendedThenRevised(), "u2", { review: verdict(2) })!;
    expect(lost.doc.title).toBe("One");
    expect(lost.review!.changes).toEqual(["Clearer cue on the bridge.", "Slower tempo — not kept: it scored 2.0 against round 1's 3.0."]);
  });
});
