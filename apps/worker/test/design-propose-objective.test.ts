/**
 * propose_objective (audit fixes, 2026-11-06, E6; the owner: "the coach always needs to be aware of my overall goals …
 * It should be able to manage all of these"): the main coach proposes a change to the athlete's objectives — a key
 * result retargeted or re-dated, a key result added, an objective or a key result retired, an objective added — with a
 * reason that cites where the athlete stands. The Worker reads `before` itself; the change is one `objective_change` op
 * in the run's proposal, shown before → after, applied only on Approve (design-approve-objectives.test.ts). Synthetic
 * data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { dayLabel, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { PROMPT_TOOL_NAMES } from "../src/services/design-prompt.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { createObjective, getObjective } from "../src/services/objectives.js";
import { isObjectiveChangeOp, OBJECTIVE_CHANGES_MAX, objectiveChangeId, type ObjectiveChangeOp } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { accountState, coachProposals, coachRuns } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const TODAY = "2026-10-21";
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;
const U = (text: string) => ({ untrusted: true, text });
const WALL_SIT = { label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" };
const WHY = "Your wall sit is at 45 s of 120 s with half the time gone: 90 s by 1 Dec is the honest target.";

const tool = () => ACT_TOOLS.find((t) => t.name === "propose_objective")!;

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => void (statements += 1) });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

async function objective(owner = userId, krs: unknown[] = [WALL_SIT]) {
  const o = await createObjective(db, owner, { title: "Strong legs for the ski trip", keyResults: krs }, NOW.toISOString());
  return { objectiveId: o.id, krId: o.keyResults[0]?.id ?? "" };
}

/** A main run answering the athlete's words — or (request null) one they didn't ask in words. */
async function mainRun(o: { request?: string | null; role?: "main" | "designer" } = {}): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: o.request === undefined ? "My legs goal feels out of reach." : o.request, status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  const role = o.role ?? "main";
  return { db, env: ENV, userId, run: { id: role === "main" ? id : `${id}-d`, role, scope: { kind: "auto" }, parentId: role === "main" ? null : id, rehearsal: false }, now: NOW, toolUseId: `toolu_${newId()}` };
}

async function propose(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await tool().run(ctx, { why: WHY, basis: "stand", ...input });
  return { res, count: statements };
}
const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const refusal = (r: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(r)) throw new Error(`stored: ${JSON.stringify(r.data)}`);
  return r;
};
const changes = async (ctx: ToolContext) =>
  (((await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id))))[0]?.ops ?? []) as unknown[]).filter(isObjectiveChangeOp) as ObjectiveChangeOp[];

describe("propose_objective: the registry", () => {
  it("is the main coach's act tool after correct_import, two statements, named in the prompt", () => {
    const names = ACT_TOOLS.map((t) => t.name);
    expect(names.indexOf("propose_objective")).toBe(names.indexOf("correct_import") + 1);
    expect(tool().roles).toEqual(["main"]);
    expect(tool().statementCost).toBe(2);
    expect(PROMPT_TOOL_NAMES).toContain("propose_objective");
    expect(OBJECTIVE_CHANGES_MAX).toBe(6);
    expect(objectiveChangeId("retarget", "kr-1")).toBe("obj-retarget-kr-1");
  });
});

describe("propose_objective: a change, before → after, its reason citing where they stand", () => {
  it("retarget a key result: the Worker reads its target; the op holds the line the card shows — two statements, nothing changed yet", async () => {
    const { objectiveId, krId } = await objective();
    const ctx = await mainRun();
    const { res, count } = await propose(ctx, { change: "retarget", keyResultId: krId, target: 90 });
    const out = ok(res);
    expect(count).toBe(2);
    expect(out.data).toMatchObject({ stored: true, opId: objectiveChangeId("retarget", krId), said: U("Zorbex wall sit: target 120 s → 90 s") });
    const [op] = await changes(ctx);
    expect(op).toMatchObject({
      kind: "objective_change", id: objectiveChangeId("retarget", krId), change: "retarget", objectiveId, keyResultId: krId, before: 120, after: 90,
      why: WHY, basis: "stand", title: "Strong legs for the ski trip", line: "Zorbex wall sit: target 120 s → 90 s", date: TODAY, toolUseId: ctx.toolUseId,
    });
    // Never applied without the athlete's tap.
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
  });

  it("re-date a key result (an objective's dates are its key results'): a past day is refused", async () => {
    const { krId } = await objective();
    const ctx = await mainRun();
    ok((await propose(ctx, { change: "redate", keyResultId: krId, dueDate: "2027-01-15" })).res);
    const [op] = await changes(ctx);
    expect(op).toMatchObject({ change: "redate", before: "2026-12-01", after: "2027-01-15", line: `Zorbex wall sit: due ${dayLabel("2026-12-01")} → ${dayLabel("2027-01-15")}` });
    expect(refusal((await propose({ ...ctx, toolUseId: "toolu_past" }, { change: "redate", keyResultId: krId, dueDate: "2026-10-01" })).res).error).toBe("bad_after");
  });

  it("add a key result: checked as the board's own save, its unit and direction resolved, a new id", async () => {
    const { objectiveId } = await objective();
    const ctx = await mainRun();
    ok((await propose(ctx, { change: "add_key_result", objectiveId, keyResult: { label: "Zorbex side plank", measure: { kind: "hold_max", libraryIds: ["sidePlank"] }, target: 60 } })).res);
    const [op] = await changes(ctx);
    expect(op).toMatchObject({
      change: "add_key_result", objectiveId, before: null, line: "Strong legs for the ski trip: new key result — Zorbex side plank, target 60 s",
      after: { label: "Zorbex side plank", measure: { kind: "hold_max", libraryIds: ["sidePlank"], windowDays: 90 }, direction: "up", baseline: null, target: 60, unit: "s", dueDate: null },
    });
    expect(op!.keyResultId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    // A move the library doesn't hold: refused, as the board refuses it.
    const bad = refusal((await propose({ ...ctx, toolUseId: "toolu_bad" }, { change: "add_key_result", objectiveId, keyResult: { label: "x", measure: { kind: "hold_max", libraryIds: ["zorbexNothing"] } } })).res);
    expect(bad.error).toBe("bad_after");
  });

  it("retire an objective (done or let go) or a key result", async () => {
    const { objectiveId, krId } = await objective();
    const ctx = await mainRun();
    ok((await propose(ctx, { change: "retire", objectiveId, status: "done" })).res);
    ok((await propose({ ...ctx, toolUseId: "toolu_kr" }, { change: "retire", keyResultId: krId })).res);
    const [obj, kr] = await changes(ctx);
    expect(obj).toMatchObject({ change: "retire", objectiveId, before: "active", after: "done", line: "Strong legs for the ski trip: active → done" });
    expect(kr).toMatchObject({
      change: "retire", keyResultId: krId, before: { label: "Zorbex wall sit", target: 120, dueDate: "2026-12-01" }, after: null,
      line: `Strong legs for the ski trip: retire Zorbex wall sit (target 120 s by ${dayLabel("2026-12-01")})`,
    });
  });

  it("add an objective with its key results, checked as the board's create", async () => {
    const ctx = await mainRun();
    ok((await propose(ctx, { change: "add_objective", objective: { title: "Zorbex balance", keyResults: [{ label: "Zorbex single-leg stand", measure: { kind: "hold_max", libraryIds: ["sidePlank"] }, target: 45 }] } })).res);
    const [op] = await changes(ctx);
    expect(op).toMatchObject({ change: "add_objective", before: null, title: "Zorbex balance", line: "New objective: Zorbex balance — 1 key result" });
    expect(op!.after).toMatchObject({ title: "Zorbex balance", status: "active", keyResults: [{ label: "Zorbex single-leg stand", unit: "s", target: 45 }] });
  });

  it("a second call for the same change replaces the first; a replay answers what it stored", async () => {
    const { krId } = await objective();
    const ctx = await mainRun();
    ok((await propose({ ...ctx, toolUseId: "toolu_one" }, { change: "retarget", keyResultId: krId, target: 90 })).res);
    ok((await propose({ ...ctx, toolUseId: "toolu_two" }, { change: "retarget", keyResultId: krId, target: 100 })).res);
    const ops = await changes(ctx);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ after: 100, replaces: ["toolu_one"] });
    const replay = ok((await propose({ ...ctx, toolUseId: "toolu_two" }, { change: "retarget", keyResultId: krId, target: 100 })).res);
    expect(replay.data).toMatchObject({ stored: true });
  });
});

describe("propose_objective: refused, teachably, nothing stored", () => {
  it("another account's, the same value, no figure on the stand, the owner's word with no words of theirs, another role, too many, a restore", async () => {
    const { objectiveId, krId } = await objective();
    const theirs = await objective((await makeTestUser(db, { timezone: "UTC" })).userId);
    const ctx = await mainRun();
    expect(refusal((await propose(ctx, { change: "retarget", keyResultId: theirs.krId, target: 90 })).res).error).toBe("not_found");
    expect(refusal((await propose(ctx, { change: "retire", objectiveId: theirs.objectiveId, status: "dropped" })).res).error).toBe("not_found");
    expect(refusal((await propose(ctx, { change: "retarget", keyResultId: krId, target: 120 })).res).error).toBe("same_value");
    // A reason on where they stand names the figure it rests on.
    const uncited = refusal((await propose(ctx, { change: "retarget", keyResultId: krId, target: 90, why: "It feels too hard." })).res);
    expect(uncited.error).toBe("uncited");
    // The athlete's word is theirs: a run they asked nothing in words can't claim it.
    const silent = await mainRun({ request: null });
    expect(refusal((await propose(silent, { change: "retarget", keyResultId: krId, target: 90, basis: "owner", why: "They said so." })).res).error).toBe("not_their_word");
    ok((await propose({ ...ctx, toolUseId: "toolu_owner" }, { change: "retarget", keyResultId: krId, target: 90, basis: "owner", why: "They want an easier target." })).res);
    const designer = await mainRun({ role: "designer" });
    expect(refusal((await propose(designer, { change: "retarget", keyResultId: krId, target: 90 })).res).error).toBe("not_for_role");
    // A finished objective can't be retired again; a full one takes no more key results.
    await db.update(schema.objectives).set({ status: "done" }).where(eq(schema.objectives.id, objectiveId));
    expect(refusal((await propose({ ...ctx, toolUseId: "toolu_done" }, { change: "retire", objectiveId, status: "dropped" })).res).error).toBe("not_a_target");
    await db.update(schema.objectives).set({ status: "active" }).where(eq(schema.objectives.id, objectiveId));
    const full = await objective(userId, Array.from({ length: 10 }, (_, i) => ({ ...WALL_SIT, label: `Zorbex hold ${i}` })));
    expect(refusal((await propose(ctx, { change: "add_key_result", objectiveId: full.objectiveId, keyResult: { label: "y", measure: { kind: "hold_max", libraryIds: ["wallSit"] } } })).res).error).toBe("full");
    // At most OBJECTIVE_CHANGES_MAX in one suggestion.
    const many = await mainRun();
    for (let i = 0; i < OBJECTIVE_CHANGES_MAX; i++) {
      ok((await propose({ ...many, toolUseId: `toolu_m${i}` }, { change: "add_objective", objective: { title: `Zorbex aim ${i}` } })).res);
    }
    expect(refusal((await propose({ ...many, toolUseId: "toolu_mx" }, { change: "add_objective", objective: { title: "Zorbex one more" } })).res).error).toBe("too_many");
    // A restore under way.
    await db.insert(accountState).values({ userId, restoreId: "restore-1", updatedAt: NOW.toISOString() } as never).onConflictDoUpdate({ target: accountState.userId, set: { restoreId: "restore-1" } });
    const during = await mainRun();
    expect(refusal((await propose(during, { change: "retarget", keyResultId: krId, target: 95 })).res).error).toBe("restoring");
  });
});
