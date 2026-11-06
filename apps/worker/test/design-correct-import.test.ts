/**
 * correct_import (import trail phase 3, Task 4; design 2026-11-05 §8.4, §3.5): the coach proposes a correction to
 * imported data — a personal move's field, a post's reading of a move, an insight, a link's match — with its evidence and
 * basis; the Worker reads `before` itself. Stored as one op in the run's proposal (applied on Approve: Task 5). Synthetic
 * data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { extractionSchema } from "@rg/saves";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { PROMPT_TOOL_NAMES } from "../src/services/design-prompt.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { CORRECTIONS_MAX, correctionId, isImportCorrectionOp, pinsCardLinesOf, type ImportCorrectionOp, type MovePinsOp } from "../src/services/proposal-kinds.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { accountState, coachProposals, coachRuns, personalMoves } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const TODAY = "2026-10-21";
const SAVED_AT = "2026-10-20T17:00:00.000Z";
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;
const DEAD_BUG = EXERCISES.find((e) => e.id === "deadBug")!;
const GOBLET = EXERCISES.find((e) => e.id === "gobletSquat")!;
const U = (text: string) => ({ untrusted: true, text });

const tool = () => ACT_TOOLS.find((t) => t.name === "correct_import")!;

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (statements += 1) });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

const LIFT = savedMoveDraft("Zorbex hip lift", {
  dose: { text: "6-10 reps", type: "reps", range: [6, 10] },
  useWhen: [{ text: "after an easy run", evidence: "stated" }],
  why: "Hips stiffen after easy runs",
  quotes: [{ field: "dose", text: "two sets of thirty seconds", at: 192, from: "transcript", check: "verified" }],
});
const NOD = savedMoveDraft("Zorbex neck nod", { regions: ["neck"] });

/** One routine post: the hip lift, the goblet squat, the neck nod — and two insights, one a creator's own split. */
async function batch(owner = userId) {
  const seeded = await seedSavedBatch(db, owner, {
    savedAt: SAVED_AT,
    posts: [{ moves: [{ draft: LIFT }, { library: "gobletSquat" }, { draft: NOD }], insights: [{ text: "Day one of the creator's three-day split.", scope: "general" }, "Twice a week is plenty."] }],
  });
  const [lift, , nod] = seeded.moveIds[0]!;
  return { batchId: seeded.batchId, postId: seeded.postIds[0]!, lift: lift!, nod: nod! };
}

async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "That dose is wrong.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${newId()}` };
}

const DOSE_FIX = { type: "time", range: [30, 30], sets: [2, 2] };
const WHY = "The transcript says two sets of thirty seconds.";

async function correct(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await tool().run(ctx, { why: WHY, basis: "evidence", cites: ["q1.1"], ...input });
  return { res, count: statements };
}
const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const refused = (r: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(r)) throw new Error(`stored: ${JSON.stringify(r.data)}`);
  return r;
};
const opsOf = async (ctx: ToolContext) => ((await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id))))[0]?.ops ?? []) as unknown[];
const fixes = async (ctx: ToolContext) => (await opsOf(ctx)).filter(isImportCorrectionOp) as ImportCorrectionOp[];

describe("correct_import: the registry", () => {
  it("is the main coach's act tool after pin_moves, two statements, named in the prompt", () => {
    const names = ACT_TOOLS.map((t) => t.name);
    expect(names.indexOf("correct_import")).toBe(names.indexOf("pin_moves") + 1);
    expect(tool().roles).toEqual(["main"]);
    expect(tool().statementCost).toBe(2);
    expect(PROMPT_TOOL_NAMES).toContain("correct_import");
    expect(correctionId("move", "myZorbexA", "dose")).toBe("fix-move-myZorbexA-dose");
    expect(CORRECTIONS_MAX).toBe(10);
  });

  it("an insight may name the move it is about (a correction attaches it): the reading's schema takes it", () => {
    const parsed = extractionSchema.safeParse({ kind: "tips", summary: "s", themes: [], moves: [], insights: [{ text: "Slow on the way down.", scope: "general", move: 0 }] });
    expect(parsed.success).toBe(true);
  });
});

describe("correct_import: a correction, proposed with its evidence", () => {
  it("a move's dose: the Worker reads before; the op holds the line the card shows, its cites, the posts it touches — two statements", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const { res, count } = await correct(ctx, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX });
    const out = ok(res);
    expect(count).toBe(2);
    expect(out.data).toMatchObject({ stored: true, opId: correctionId("move", b.lift, "dose"), said: U("Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)") });
    const [op] = await fixes(ctx);
    expect(op).toMatchObject({
      kind: "import_correction", id: correctionId("move", b.lift, "dose"), target: "move", targetId: b.lift, field: "dose",
      before: { type: "reps", range: [6, 10] }, after: DOSE_FIX, why: WHY, basis: "evidence",
      cites: [{ id: "q1.1", kind: "quote", label: "said 3:12", postId: b.postId, position: 0, quote: 0 }],
      name: "Zorbex hip lift", line: "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)", posts: [b.postId], moveId: b.lift, date: TODAY, toolUseId: ctx.toolUseId,
    });
  });

  it("each field of a personal move it may correct, its before read from the record", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const cases: Array<[string, unknown, string]> = [
      ["name", "Zorbex hip raise", "Name of Zorbex hip lift: Zorbex hip raise (was Zorbex hip lift)"],
      ["summary", "A slow hip raise.", "Summary of Zorbex hip lift: A slow hip raise. (was Zorbex hip lift, slow and even.)"],
      ["purpose", "Opens the hips after runs", "Purpose of Zorbex hip lift: Opens the hips after runs (was mobility)"],
      ["laterality", "unilateral", "Sides of Zorbex hip lift: unilateral (was bilateral)"],
      ["steps", ["Lie down.", "Lift slowly."], "Steps of Zorbex hip lift: Lie down.; Lift slowly. (was Start.; Finish.)"],
      ["cues", ["Ribs down."], "Cues of Zorbex hip lift: Ribs down. (was nothing)"],
    ];
    for (const [field, after, line] of cases) {
      const r = ok((await correct({ ...ctx, toolUseId: `toolu_${field}` }, { target: "move", targetId: b.lift, field, after })).res);
      expect((r.data as { said: { text: string } }).said.text, field).toBe(line);
    }
    expect((await fixes(ctx)).map((f) => f.field)).toEqual(cases.map(([f]) => f));
  });

  it("a post's reading of a move: when to use it, skip it, and why", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const use = ok((await correct(ctx, { target: "reading", targetId: `${b.postId}:0`, field: "useWhen", after: [{ text: "after a long run", evidence: "stated" }] })).res);
    expect((use.data as { said: { text: string } }).said.text).toBe("When to use it for Zorbex hip lift: after a long run (was after an easy run)");
    const why = ok((await correct({ ...ctx, toolUseId: "toolu_why" }, { target: "reading", targetId: `${b.postId}:0`, field: "why", after: "Hips stiffen after long runs" })).res);
    expect((why.data as { said: { text: string } }).said.text).toBe("Why for Zorbex hip lift: Hips stiffen after long runs (was Hips stiffen after easy runs)");
    const [first] = await fixes(ctx);
    expect(first).toMatchObject({ before: [{ text: "after an easy run", evidence: "stated" }], posts: [b.postId], moveId: b.lift });
  });

  it("an insight: dropped, reworded, its scope changed, attached to a move", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const lines: string[] = [];
    for (const [field, targetId, after] of [
      ["scope", `${b.postId}:0`, "creator_programme"],
      ["text", `${b.postId}:1`, "Twice a week is enough."],
      ["move", `${b.postId}:1`, 0],
      ["drop", `${b.postId}:0`, true],
    ] as const) {
      const r = ok((await correct({ ...ctx, toolUseId: `toolu_${field}` }, { target: "insight", targetId, field, after, basis: "owner", cites: [] })).res);
      lines.push((r.data as { said: { text: string } }).said.text);
    }
    expect(lines).toEqual([
      "Insight's scope: the creator's own programme (was general) — “Day one of the creator's three-day split.”",
      "Insight reworded: Twice a week is enough. (was Twice a week is plenty.)",
      "Insight about Zorbex hip lift — “Twice a week is plenty.”",
      "Insight dropped — “Day one of the creator's three-day split.”",
    ]);
  });

  it("a link's match: the same as another move, or — a library link — not the same", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const same = ok((await correct(ctx, { target: "link", targetId: `${b.postId}:2`, field: "same_as", after: "deadBug" })).res);
    expect((same.data as { said: { text: string } }).said.text).toBe(`Zorbex neck nod is the same as ${DEAD_BUG.name}`);
    const notSame = ok((await correct({ ...ctx, toolUseId: "toolu_not" }, { target: "link", targetId: `${b.postId}:1`, field: "not_same", after: null })).res);
    expect((notSame.data as { said: { text: string } }).said.text).toBe(`The post's move isn't the library's ${GOBLET.name} — a move of its own`);
    expect((await fixes(ctx)).map((f) => [f.field, f.before, f.after])).toEqual([["same_as", b.nod, "deadBug"], ["not_same", "gobletSquat", null]]);
    // Not the same on a link to a personal move: nothing of the library's to undo.
    expect(refused((await correct({ ...ctx, toolUseId: "toolu_x" }, { target: "link", targetId: `${b.postId}:2`, field: "not_same", after: null })).res).error).toBe("bad_field");
  });

  it("refuses what it can't correct: another role, a library or archived move, another account's post, a field or value it doesn't take, the same value", async () => {
    const b = await batch();
    const theirs = await batch((await makeTestUser(db, { timezone: "UTC" })).userId);
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const code = async (input: Record<string, unknown>, c: ToolContext = ctx) => refused((await correct(c, input)).res).error;
    expect(await code({ target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX }, { ...ctx, run: { ...ctx.run, role: "designer", parentId: ctx.run.id } })).toBe("not_for_role");
    expect(await code({ target: "move", targetId: "gobletSquat", field: "dose", after: DOSE_FIX })).toBe("not_a_target");
    expect(await code({ target: "reading", targetId: `${theirs.postId}:0`, field: "why", after: "x" })).toBe("not_a_target");
    expect(await code({ target: "reading", targetId: `${b.postId}:9`, field: "why", after: "x" })).toBe("not_a_target");
    expect(await code({ target: "move", targetId: b.lift, field: "colour", after: "red" })).toBe("bad_field");
    expect(await code({ target: "move", targetId: b.lift, field: "dose", after: { type: "reps", range: [10, 2] } })).toBe("bad_after");
    expect(await code({ target: "move", targetId: b.lift, field: "name", after: "" })).toBe("bad_after");
    expect(await code({ target: "insight", targetId: `${b.postId}:0`, field: "scope", after: "forever" })).toBe("bad_after");
    expect(await code({ target: "move", targetId: b.lift, field: "laterality", after: "bilateral" })).toBe("same_value");
    await db.update(personalMoves).set({ status: "archived" }).where(eq(personalMoves.id, b.nod));
    expect(await code({ target: "move", targetId: b.nod, field: "name", after: "Zorbex neck tuck" })).toBe("not_a_target");
    expect(await opsOf(ctx)).toEqual([]);
  });

  it("evidence needs a cite the run read, and a target it read; the athlete's insistence (basis owner) needs neither", async () => {
    const b = await batch();
    const unread = await mainRun();
    const base = { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX };
    expect(refused((await correct(unread, base)).res).error).toBe("not_read");
    ok((await correct(unread, { ...base, basis: "owner", cites: [], why: "You said so: two sets of thirty seconds." })).res);
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    expect(refused((await correct(ctx, { ...base, cites: [] })).res).error).toBe("uncited");
    const unknown = refused((await correct(ctx, { ...base, cites: ["q9.9"] })).res);
    expect(unknown.error).toBe("unknown_cite");
    expect(unknown.why).toContain('"q9.9"');
    ok((await correct(ctx, { ...base, cites: ["inferred:dose", "history"] })).res);
  });

  it("a second correction of the same field replaces the first; a replay answers what it stored; at most ten a suggestion", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    ok((await correct({ ...ctx, toolUseId: "toolu_first" }, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX })).res);
    ok((await correct({ ...ctx, toolUseId: "toolu_second" }, { target: "move", targetId: b.lift, field: "dose", after: { type: "time", range: [40, 40], sets: [2, 2] } })).res);
    const [op, ...rest] = await fixes(ctx);
    expect(rest).toEqual([]);
    expect(op).toMatchObject({ after: { range: [40, 40] }, replaces: ["toolu_first"] });
    const replay = ok((await correct({ ...ctx, toolUseId: "toolu_second" }, { target: "move", targetId: b.lift, field: "dose", after: { type: "time", range: [50, 50] } })).res);
    expect(replay.data).toMatchObject({ stored: true, said: U("Dose of Zorbex hip lift: 40 s, 2 sets (was 6–10 reps)") });
    // Nine more fields: the tenth fits, an eleventh is too many.
    const more = ["name", "summary", "purpose", "laterality", "steps", "cues", "load"] as const;
    const afterOf: Record<string, unknown> = { name: "Zorbex hip raise", summary: "Slow.", purpose: "Hips.", laterality: "unilateral", steps: ["Up."], cues: ["Slow."], load: "bodyweight" };
    for (const f of more) ok((await correct({ ...ctx, toolUseId: `toolu_${f}` }, { target: "move", targetId: b.lift, field: f, after: afterOf[f] })).res);
    ok((await correct({ ...ctx, toolUseId: "toolu_r1" }, { target: "reading", targetId: `${b.postId}:0`, field: "why", after: "Long runs." })).res);
    ok((await correct({ ...ctx, toolUseId: "toolu_r2" }, { target: "reading", targetId: `${b.postId}:0`, field: "skipWhen", after: [{ text: "on a race week", evidence: "inferred" }] })).res);
    expect(await fixes(ctx)).toHaveLength(10);
    expect(refused((await correct({ ...ctx, toolUseId: "toolu_r3" }, { target: "insight", targetId: `${b.postId}:1`, field: "text", after: "Twice." })).res).error).toBe("too_many");
  });

  it("a dose correction rewrites the dose its move's pins line shows", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const pins = ACT_TOOLS.find((t) => t.name === "pin_moves")!;
    ok(await pins.run(ctx, {
      batchId: b.batchId, pin: [b.lift], title: "One in", why: "The lift fills the hip work.",
      lines: [{ moveId: b.lift, text: "It serves hip mobility.", cites: ["history"] }, { moveId: b.nod, text: "Your care covers it.", cites: ["history"] }],
    }));
    ok((await correct(ctx, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX })).res);
    const op = (await opsOf(ctx)).find((o) => (o as { kind?: string }).kind === "move_pins") as MovePinsOp;
    expect(pinsCardLinesOf(op.lines)[0]).toMatchObject({ moveId: b.lift, dose: "30 s, 2 sets" });
  });

  it("refuses with the suggestion already with the athlete, and during a restore", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    ok((await correct(ctx, { target: "move", targetId: b.lift, field: "dose", after: DOSE_FIX })).res);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    expect(refused((await correct({ ...ctx, toolUseId: "toolu_late" }, { target: "move", targetId: b.lift, field: "name", after: "Zorbex hip raise" })).res).error).toBe("proposal_pending");
    const other = await mainRun();
    await readSavesInRun(db, other);
    await db.insert(accountState).values({ userId, restoreId: "restore-1", updatedAt: NOW.toISOString() });
    expect(refused((await correct(other, { target: "move", targetId: b.lift, field: "name", after: "Zorbex hip raise" })).res).error).toBe("restoring");
  });

  it("marks what a post or the reader wrote when it answers the model (the line is the card's)", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const r = ok((await correct(ctx, { target: "move", targetId: b.lift, field: "name", after: "Zorbex hip raise" })).res);
    expect((r.data as { said: unknown }).said).toEqual(U("Name of Zorbex hip lift: Zorbex hip raise (was Zorbex hip lift)"));
  });
});
