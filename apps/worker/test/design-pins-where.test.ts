/**
 * A review line's `where` is what Approve does (audit fixes, 2026-11-06, E7; design 2026-11-05 §14.1): the tool writes
 * it — a move in a workout of this suggestion reads that workout's day, title and part; a pin "joins your rotation"; a
 * move left in rotation "already in rotation"; out, none. The coach's own `where` prose is ignored (its reasons belong in
 * the line's text), so the card can never say "Thu post-run mobility" while Approve only pins. And a line whose workout
 * moved since says so to finish. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { doseSummary, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { stalePinsLines } from "../src/services/design-tools/pin-moves.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { pinsCardLinesOf, type MovePinsOp } from "../src/services/proposal-kinds.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { coachProposals, coachRuns } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const SAVED_AT = "2026-10-20T17:00:00.000Z";
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;
const WORDS = { title: "Three saved moves", why: "The lift fills the hip work your plan lacks." };

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

const LIFT = savedMoveDraft("Zorbex hip lift");
const NOD = savedMoveDraft("Zorbex neck nod", { regions: ["neck"] });
const ROCK = savedMoveDraft("Zorbex calf rock", { regions: ["calves"] });

async function setUp(o: { pinned?: string[] } = {}) {
  const seeded = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ draft: LIFT }, { draft: NOD }, { draft: ROCK }, { library: "deadBug" }] }], ...(o.pinned ? { pinned: o.pinned } : {}) });
  const [lift, nod, rock] = seeded.moveIds[0]!;
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Fit the new moves from my saves.", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  const ctx: ToolContext = { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${newId()}` };
  await readSavesInRun(db, ctx);
  return { ctx, batchId: seeded.batchId, lift: lift!, nod: nod!, rock: rock! };
}

/** A revised workout of this suggestion holding `moveId` in its cool-down: Thu 22 Oct, "Post-run mobility". */
const workoutOp = (runId: string, moveId: string, over: Record<string, unknown> = {}) => ({
  kind: "doc_workout", by: { runId, role: "main" }, date: "2026-10-22",
  doc: { title: "Post-run mobility", intent: { summary: "Open the hips after the run." }, parts: [{ purpose: "cooldown", items: [{ kind: "exercise", libraryId: moveId, dose: { sets: 2, reps: 6, perSide: true } }] }] },
  ...over,
});

const pinMoves = () => ACT_TOOLS.find((t) => t.name === "pin_moves")!;
const stored = async (ctx: ToolContext) =>
  ((await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id))))[0]!.ops as unknown[]).find((o) => (o as { kind?: string }).kind === "move_pins") as MovePinsOp;

describe("pin_moves: a line's where is the tool's", () => {
  it("a workout of this suggestion: its day, title and part; a pin: joins your rotation; in rotation already: already in rotation; out: none — the coach's where ignored", async () => {
    const s = await setUp({ pinned: ["deadBug"] });
    await db.insert(coachProposals).values({
      id: designProposalId(s.ctx.run.id), userId, title: "Fit", evidence: "", rationale: "", flags: [], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: "2026-10-24",
      ops: [workoutOp(s.ctx.run.id, s.lift)],
    } as never);
    const res = await pinMoves().run(s.ctx, {
      ...WORDS,
      batchId: s.batchId,
      pin: [s.rock],
      lines: [
        // The coach's where names a slot the card doesn't place it in: ignored.
        { moveId: s.lift, where: "Sat long-run warm-up", text: "Opens the hips after the easy run.", cites: ["history"] },
        { moveId: s.rock, where: "Thu post-run mobility", text: "Your calves are what the week lacks.", cites: ["history"] },
        { moveId: "deadBug", text: "Stays: it already serves your core.", cites: ["history"] },
        { moveId: s.nod, where: "nowhere", text: "Your neck care covers it.", cites: ["history"] },
      ],
    });
    if (isToolErr(res)) throw new Error(`${res.error}: ${res.why}`);
    const [lift, rock, bug, nod] = pinsCardLinesOf((await stored(s.ctx)).lines);
    expect(lift).toMatchObject({ decision: "in", via: "workout", where: "Thu 22 Oct, in Post-run mobility (cool-down)" });
    expect(rock).toMatchObject({ decision: "in", via: "pin", where: "joins your rotation" });
    expect(bug).toMatchObject({ decision: "in", via: "rotation", where: "already in rotation" });
    expect(nod).toMatchObject({ decision: "out" });
    expect(nod).not.toHaveProperty("where");
  });

  it("the tool's schema no longer asks the coach for where", () => {
    const props = (pinMoves().inputSchema as { properties: { lines: { items: { properties: Record<string, unknown> } } } }).properties.lines.items.properties;
    expect(props).not.toHaveProperty("where");
  });

  it("a workout line whose workout moved to another day since is stale: finish asks pin_moves again", () => {
    const dose = doseSummary({ sets: 2, reps: 6, perSide: true } as never);
    const line = { moveId: "myZorbexA", name: "Zorbex A", text: "t", decision: "in" as const, via: "workout" as const, where: "Thu 22 Oct, in Post-run mobility (cool-down)", dose };
    const pins = { kind: "move_pins", id: "pins-r", pin: [], unpin: [], why: "w", title: "t", summary: "s", lines: [line], date: "2026-10-21", toolUseId: "x", at: NOW.toISOString() };
    expect(stalePinsLines([pins, workoutOp("r", "myZorbexA")])).toEqual([]);
    expect(stalePinsLines([pins, workoutOp("r", "myZorbexA", { date: "2026-10-23" })]).map((l) => l.moveId)).toEqual(["myZorbexA"]);
  });
});
