/**
 * A pins line cites its evidence (import trail phase 3, Task 3; design 2026-11-05 §8.3, §14.1–14.2). Each line about a
 * move says in or out, where, the dose it runs with (the tool's, never a guess), and its cites — quote ids the run read
 * (read_saves' receipt on the run's trail), `history`, `goal:<id>`, `inferred:<field>` — each stored as the chip the card
 * draws. Refused: a line about a batch move the run never read, a cite it never read, a claim about the post with no
 * quote, a dose the move won't run with, an in or out the card doesn't do. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { doseSummary, newId } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { pinsCardLinesOf, type MovePinsOp } from "../src/services/proposal-kinds.js";
import { doseWords } from "../src/services/saves-evidence.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { coachProposals, coachRuns } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const SAVED_AT = "2026-10-20T17:00:00.000Z";
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;
const GOBLET = EXERCISES.find((e) => e.id === "gobletSquat")!;
const WORDS = { title: "Two saved moves in", why: "The hip lift fills the hip work your plan lacks; the nod repeats your care." };

const tool = () => ACT_TOOLS.find((t) => t.name === "pin_moves")!;

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
  quotes: [
    { field: "purpose", text: "if your hips get stiff after easy runs", at: 72, from: "transcript", check: "verified" },
    { field: "useWhen", text: "do it right after the run", at: 12, from: "speech", check: "in_speech" },
  ],
});
const NOD = savedMoveDraft("Zorbex neck nod", { regions: ["neck"] });
const ROCK = savedMoveDraft("Zorbex calf rock", { regions: ["calves"] });

/** One routine post: the hip lift, the goblet squat, the neck nod, the calf rock. */
async function batch() {
  const seeded = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ draft: LIFT }, { library: "gobletSquat" }, { draft: NOD }, { draft: ROCK }] }] });
  const [lift, , nod, rock] = seeded.moveIds[0]!;
  return { batchId: seeded.batchId, postId: seeded.postIds[0]!, lift: lift!, nod: nod!, rock: rock! };
}

async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Fit the new moves from my saves.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${newId()}` };
}

async function pins(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await tool().run(ctx, { ...WORDS, ...input });
  return { res, count: statements };
}
const refusal = (res: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(res)) throw new Error(`stored: ${JSON.stringify(res.data)}`);
  return res;
};
const stored = async (ctx: ToolContext) =>
  ((await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id))))[0]!.ops as unknown[]).find((o) => (o as { kind?: string }).kind === "move_pins") as MovePinsOp;

/** The four moves each accounted for: the lift and the squat pinned, the nod and the rock left out. */
const fourLines = (b: Awaited<ReturnType<typeof batch>>): Array<Record<string, unknown>> => [
  { moveId: b.lift, where: "joins your mobility rotation", text: "She says it's for hips that stiffen after easy runs; it serves hip mobility.", cites: ["q1.1", "history"] },
  { moveId: "gobletSquat", text: "Your strength days lack a squat.", cites: ["history"] },
  { moveId: b.nod, decision: "out", text: "Your neck care already covers it.", cites: ["inferred:purpose"] },
  { moveId: b.rock, text: "Needs more ankle range than you have now.", cites: ["history"] },
];

describe("pin_moves: lines cite their evidence", () => {
  it("cites become chips; each line keeps its decision, where, the dose it runs with and its first post; the op keeps when each post was read — two statements", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx, {}, "2026-10-21T07:55:00.000Z");
    const { res, count } = await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: fourLines(b) });
    if (isToolErr(res)) throw new Error(`${res.error}: ${res.why}`);
    expect(count).toBe(2);
    const op = await stored(ctx);
    expect(op.read).toEqual([[b.postId, "2026-10-21T07:55:00.000Z"]]);
    const [lift, squat, nod, rock] = pinsCardLinesOf(op.lines);
    expect(lift).toEqual({
      moveId: b.lift, name: "Zorbex hip lift", text: "She says it's for hips that stiffen after easy runs; it serves hip mobility.",
      decision: "in", where: "joins your mobility rotation", dose: "6–10 reps",
      cites: [
        { id: "q1.1", kind: "quote", label: "said 1:12", postId: b.postId, position: 0, quote: 0 },
        { id: "history", kind: "history", label: "your history" },
      ],
      post: { id: b.postId, position: 0 },
    });
    expect(squat).toMatchObject({ moveId: "gobletSquat", decision: "in", dose: doseWords(GOBLET.dose), post: { id: b.postId, position: 1 } });
    // Left out: no dose (it runs with none), its cite the reader's guess at its first post.
    expect(nod).toEqual({
      moveId: b.nod, name: "Zorbex neck nod", text: "Your neck care already covers it.", decision: "out",
      cites: [{ id: "inferred:purpose", kind: "inferred", label: "reader's guess", field: "purpose", postId: b.postId, position: 2 }],
      post: { id: b.postId, position: 2 },
    });
    // No decision written: the tool's (nothing put it anywhere — out).
    expect(rock).toMatchObject({ decision: "out" });
  });

  it("a heard quote is never said: its chip reads heard, with its time", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const lines = fourLines(b);
    lines[0] = { ...lines[0]!, text: "In the video she says to do it right after the run.", cites: ["q1.2"] };
    const res = (await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res;
    if (isToolErr(res)) throw new Error(`${res.error}: ${res.why}`);
    expect(pinsCardLinesOf((await stored(ctx)).lines)[0]!.cites).toEqual([{ id: "q1.2", kind: "quote", label: "heard 0:12", postId: b.postId, position: 0, quote: 1 }]);
  });

  it("a line about a move of the batch the run never read is refused, naming it", async () => {
    const b = await batch();
    const ctx = await mainRun();
    const r = refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: fourLines(b) })).res);
    expect(r.error).toBe("not_read");
    expect(r.why).toContain(markUntrusted("saved post", "Zorbex hip lift"));
    expect(r.fix).toContain("read_saves");
    expect(await db.select().from(coachProposals)).toEqual([]);
  });

  it("two pages, one unread: a line about a move on the page never read is refused; one on the page read stands", async () => {
    const b = await batch();
    const ctx = await mainRun();
    // The first page holds the hip lift alone (new moves first: the lift, the nod, the rock, then the squat).
    await readSavesInRun(db, ctx, { limit: 1 });
    const r = refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: fourLines(b) })).res);
    expect(r.error).toBe("not_read");
    expect(r.why).toContain(markUntrusted("saved post", "Zorbex neck nod"));
    expect(r.why).not.toContain("Zorbex hip lift");
    await readSavesInRun(db, ctx, { offset: 1 });
    expect(isToolErr((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: fourLines(b) })).res)).toBe(false);
  });

  it("refuses a cite the run never read, and one that is no cite", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    for (const cite of ["q9.9", "q1.7", "the transcript", "goal:"]) {
      const lines = fourLines(b);
      lines[1] = { ...lines[1]!, cites: [cite] };
      const r = refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res);
      expect(r.error, cite).toBe("unknown_cite");
      expect(r.why, cite).toContain(JSON.stringify(cite));
    }
  });

  it("a line that says what the post or its creator says needs its quote — the reader's guess or history alone won't do", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const lines = fourLines(b);
    lines[0] = { ...lines[0]!, text: "The creator pitches it for runners.", cites: ["history", "inferred:purpose"] };
    const r = refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res);
    expect(r.error).toBe("uncited_claim");
    expect(r.why).toContain("The creator pitches it for runners.");
    expect(r.fix).toContain("inferred:");
    lines[0] = { ...lines[0]!, cites: ["q1.1"] };
    expect(isToolErr((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res)).toBe(false);
  });

  it("in means the card puts it somewhere and out means it doesn't: a decision the card contradicts is refused", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const inButNot = fourLines(b);
    inButNot[3] = { ...inButNot[3]!, decision: "in" };
    expect(refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: inButNot })).res).error).toBe("in_not_placed");
    const outButPinned = fourLines(b);
    outButPinned[0] = { ...outButPinned[0]!, decision: "out" };
    expect(refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines: outButPinned })).res).error).toBe("out_but_placed");
  });

  it("a dose the move won't run with is refused, naming the one it will; the same numbers in other words stand", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const lines = fourLines(b);
    lines[0] = { ...lines[0]!, dose: "3×10" };
    const r = refusal((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res);
    expect(r.error).toBe("dose_mismatch");
    expect(r.why).toContain("6–10 reps");
    expect(r.fix).toContain("correct_import");
    lines[0] = { ...lines[0]!, dose: "6 to 10 reps" };
    expect(isToolErr((await pins(ctx, { batchId: b.batchId, pin: [b.lift, "gobletSquat"], lines })).res)).toBe(false);
  });

  it("the dose a line shows: a workout of this suggestion's item, else a dose correction it holds, else the record's", async () => {
    const b = await batch();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    const itemDose = { sets: 2, reps: 6, perSide: true };
    // This suggestion already holds a revised workout with the lift in it, and a correction of the rock's dose.
    await db.insert(coachProposals).values({
      id: designProposalId(ctx.run.id), userId, title: "Fit", evidence: "", rationale: "", flags: [], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: "2026-10-24",
      ops: [
        { kind: "doc_workout", by: { runId: ctx.run.id, role: "main" }, date: "2026-10-22", doc: { title: "Thursday mobility", intent: { summary: "Open the hips after the run." }, parts: [{ purpose: "mobility", items: [{ kind: "exercise", libraryId: b.lift, dose: itemDose }] }] } },
        { kind: "import_correction", id: `fix-move-${b.rock}-dose`, target: "move", targetId: b.rock, field: "dose", after: { type: "time", range: [30, 30], sets: [2, 2] } },
      ],
    } as never);
    const lines = fourLines(b);
    lines[0] = { moveId: b.lift, where: "in Thursday's mobility, revised here", text: "It serves hip mobility.", cites: ["history"] };
    lines[3] = { moveId: b.rock, text: "Your calves are what the week lacks.", cites: ["history"] };
    const res = (await pins(ctx, { batchId: b.batchId, pin: ["gobletSquat", b.rock], lines })).res;
    if (isToolErr(res)) throw new Error(`${res.error}: ${res.why}`);
    const [lift, , , rock] = pinsCardLinesOf((await stored(ctx)).lines);
    expect(lift).toMatchObject({ decision: "in", dose: doseSummary(itemDose as never) });
    expect(rock).toMatchObject({ decision: "in", dose: "30 s, 2 sets" });
  });

  it("a card stored before lines cited keeps reading: plain strings, and lines with no decision", () => {
    expect(pinsCardLinesOf(["Zorbex hip lift — in rotation.", { moveId: "myZorbexA", name: "Zorbex A", text: "In." }, { text: "", moveId: "x" }])).toEqual([
      { text: "Zorbex hip lift — in rotation." },
      { moveId: "myZorbexA", name: "Zorbex A", text: "In." },
    ]);
    // A cite that doesn't read is dropped, never thrown on.
    expect(pinsCardLinesOf([{ text: "In.", decision: "sideways", cites: [{ id: 3 }, { id: "history", kind: "history", label: "your history" }] }])).toEqual([
      { text: "In.", cites: [{ id: "history", kind: "history", label: "your history" }] },
    ]);
  });
});
