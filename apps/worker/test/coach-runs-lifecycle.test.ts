/**
 * A RUN'S LIFECYCLE AT ITS EDGES (Stage 3 fix wave 3A: A10, A11, A14, A15, A17).
 *
 *  - A10: the expiry sweep closes a design's unreviewed proposal only once its run is over — a set designed across the
 *    athlete's local midnight keeps it, and its next designer proposes into it.
 *  - A11: a finish makes its proposal pending only while its run is still live and held by its step, in one statement
 *    (a cancel that landed meanwhile wins); a step of queued calls runs them only while it holds its claim.
 *  - A14: a run whose dead step is taken back again and again, never getting further, fails on the third takeover with
 *    a plain line, and proposes what was reviewed.
 *  - A15: a rehearsal never takes, and is never offered as, the athlete's one live main run — nor the other way round.
 *  - A17: a finish that made its proposal pending and died before its run's write is finished by the next step, with
 *    no model call.
 *
 * The real registry and opening context, a scripted model. No key, no network. Synthetic data only: the made-up athlete
 * of design-read-fixture.ts, on its fixed clock.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { cancelRun, createRun, EXPIRE_TREE_STATEMENTS, LINES, MAX_TAKEOVERS, runStep, sweepCoachRuns, type RunDeps } from "../src/services/coach-runs.js";
import { COACH_RUN_STEP_STALE_MINUTES } from "../src/services/cron-limits.js";
import { sweepExpiredProposals } from "../src/routes/coach.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { STOPPED_NOTES } from "../src/services/design-review.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { DesignTool } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_lc${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

function scripted(turns: MessagesResult[], tools: DesignTool[] = allTools()) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools,
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
  mustFix: [],
  improvements: [],
});
const propose = (title: string, date = TODAY) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date } });
const submit = (v: unknown) => use("submit_review", v);
const finish = (summary: string) => use("finish", { summary });

async function drive(db: Db, userId: string, runId: string, deps: RunDeps, o: { start?: Date; max?: number } = {}) {
  const start = (o.start ?? NOW).getTime();
  const all: Array<{ status: string }> = [];
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(start + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: o.max ?? 60, what: "drive" },
  );
  return all;
}

async function proposal(db: Db, runId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p;
}
async function run(db: Db, id: string) {
  const [r] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return r!;
}
async function lines(db: Db, runId: string) {
  return (await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq)).map((e) => e.summary);
}
const nowRun = async (db: Db, userId: string, o: { rehearsal?: boolean; at?: Date } = {}) =>
  (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips.", rehearsal: o.rehearsal }, o.at ?? NOW)).run.id;

/** A step's own write to its run, its end (the steps counted): failing it kills the step holding its claim. */
const RUN_WRITE = /^update "coach_runs" set "status" = \?.*"steps" = "coach_runs"\."steps" \+ 1/;

const staleLater = (from: Date, n: number) => new Date(from.getTime() + n * (COACH_RUN_STEP_STALE_MINUTES + 1) * 60_000);

// ── A10 ────────────────────────────────────────────────────────────────

describe("the expiry sweep and a live design (A10)", () => {
  it("leaves a live run's unreviewed proposal past its day alone, and expires it once the run is over", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const { deps } = scripted([t(propose("Calm hips"))]);
    await runStep(db, env, runId, a.userId, NOW, deps); // context
    await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 1000), deps); // draft, reviewer started
    expect((await proposal(db, runId))!.status).toBe("unreviewed");
    // A day later in the athlete's zone: the proposal's day is behind, but its run is still live.
    await sweepExpiredProposals(db, a.userId, day(-1));
    expect((await proposal(db, runId))!.status).toBe("unreviewed");
    // Over (here, failed), the proposal goes.
    await db.update(schema.coachRuns).set({ status: "failed" }).where(eq(schema.coachRuns.id, runId));
    expect(await sweepExpiredProposals(db, a.userId, day(-1))).toBe(1);
    expect((await proposal(db, runId))!.status).toBe("expired");
  });

  it("a set designed across local midnight: the first designer's proposal survives the sweep, and the second proposes into it", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    // 23:30 in the athlete's zone (America/Los_Angeles) on TODAY.
    const lateEvening = new Date(`${TODAY}T06:30:00Z`);
    lateEvening.setUTCDate(lateEvening.getUTCDate() + 1);
    const mainId = (await createRun(db, a.userId, { scope: { kind: "week" }, request: "Plan my week." }, lateEvening)).run.id;
    const tomorrow = day(-1);
    const brief = (key: string, date: string) => ({ key, date, purpose: "Hips, steady.", emphasis: "Control.", constraints: "30 minutes.", why: "Away from the runs.", sameDayWhy: "A short one beside the day's plan." });
    const second = propose("Tomorrow's hips", tomorrow);
    const { deps, requests } = scripted([
      t(use("plan_set", { briefs: [brief("today", TODAY), brief("tomorrow", tomorrow)] })),
      t(propose("Tonight's hips", TODAY)),
      t(submit(verdict(4))),
      t(finish("Tonight's hips.")),
      t(second),
      t(submit(verdict(4))),
      t(finish("Tomorrow's hips.")),
      t(finish("Two sessions.")),
    ]);
    // The plan, then the first designer to its finish: eight steps before midnight.
    for (let i = 0; i < 8; i++) await runStep(db, env, mainId, a.userId, new Date(lateEvening.getTime() + i * 1000), deps);
    expect(requests).toHaveLength(4);
    expect((await proposal(db, mainId))!).toMatchObject({ status: "unreviewed", expiresAt: TODAY });
    // Past local midnight, the athlete opens the coach: /state's sweep runs for the new day.
    const afterMidnight = new Date(lateEvening.getTime() + 60 * 60_000);
    await sweepExpiredProposals(db, a.userId, tomorrow);
    expect((await proposal(db, mainId))!.status).toBe("unreviewed");
    await drive(db, a.userId, mainId, deps, { start: afterMidnight });
    const sent = requests.flatMap((r) => r.messages).flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const result = sent.find((b) => b.type === "tool_result" && (b as { tool_use_id: string }).tool_use_id === (second as { id: string }).id) as { content: string; is_error?: boolean };
    expect(result.is_error).toBeFalsy();
    expect(result.content).not.toContain("proposal_closed");
    expect((await proposal(db, mainId))!.status).toBe("pending");
  });
});

// ── A11 ────────────────────────────────────────────────────────────────

describe("a finish and a cancel racing (A11)", () => {
  it("a cancel that lands between the claim and the finish's promotion wins: nothing is made pending", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const real = allTools();
    const realFinish = real.find((x) => x.name === "finish")!;
    // The cancel's own first write — the run cancelled — lands while the finish runs (its proposal's close comes after).
    const racingFinish: DesignTool = {
      ...realFinish,
      async run(ctx, input) {
        await ctx.db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, runId));
        return realFinish.run(ctx, input);
      },
    };
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(finish("A calm half hour."))], real.map((x) => (x.name === "finish" ? racingFinish : x)));
    const steps = await drive(db, a.userId, runId, deps);
    expect(steps.at(-1)!.status).toBe("cancelled");
    expect((await proposal(db, runId))!.status).toBe("unreviewed");
    expect((await run(db, runId)).status).toBe("cancelled");
  });

  it("a step of queued calls runs none of them when a cancel took its claim first", async () => {
    let armed = false;
    let cancelId = "";
    const db: Db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (!armed || !text.includes("restore_id")) return;
        armed = false;
        // Another request's cancel, landing between this step's claim and its standing read.
        (db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
          .prepare("UPDATE coach_runs SET status = 'cancelled' WHERE id = ?")
          .run(cancelId);
      },
    });
    const a = await seedRichAthlete(db);
    cancelId = await nowRun(db, a.userId);
    let ran = 0;
    const heavy = (name: string): DesignTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      statementCost: 20,
      roles: ["main"],
      async run() {
        ran += 1;
        return { data: {}, summary: name };
      },
    });
    const { deps } = scripted([t(use("heavy_a", {}), use("heavy_b", {}))], [heavy("heavy_a"), heavy("heavy_b")]);
    await runStep(db, env, cancelId, a.userId, NOW, deps); // context
    await runStep(db, env, cancelId, a.userId, new Date(NOW.getTime() + 1000), deps); // the call: heavy_a runs, heavy_b is queued
    expect(ran).toBe(1);
    armed = true;
    const out = await runStep(db, env, cancelId, a.userId, new Date(NOW.getTime() + 2000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("cancelled");
    expect(ran).toBe(1);
  });
});

// ── A14 ────────────────────────────────────────────────────────────────

describe("a step that dies the same way every time (A14)", () => {
  /** A database whose run write — the end of a step — fails while armed: the step dies holding its claim. */
  function dyingDb() {
    const box = { armed: false };
    const db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (box.armed && RUN_WRITE.test(text)) throw new Error("the invocation was killed");
      },
    });
    return { db, box };
  }

  it("two takeovers go on; the third fails the run with a plain line, and it proposes what was reviewed", async () => {
    const { db, box } = dyingDb();
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), ...[1, 2, 3].map(() => t(use("read_day", {})))]);
    for (let i = 0; i < 5; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps); // to the resume
    expect((await proposal(db, runId))!.status).toBe("unreviewed");
    const calls = requests.length;
    // The next step dies; it is taken back twice, and each time dies again.
    box.armed = true;
    const died = new Date(NOW.getTime() + 10_000);
    await expect(runStep(db, env, runId, a.userId, died, deps)).rejects.toThrow();
    for (const n of [1, 2]) {
      await expect(runStep(db, env, runId, a.userId, staleLater(died, n), deps)).rejects.toThrow();
      expect(JSON.parse((await run(db, runId)).state!).takeovers).toBe(n);
    }
    expect(requests.length).toBe(calls + 3);
    // The third takeover: no model call, the run fails, and what was reviewed is proposed.
    box.armed = false;
    const out = await runStep(db, env, runId, a.userId, staleLater(died, 3), deps);
    expect(out.kind === "ok" && out.result.status).toBe("failed");
    expect(requests.length).toBe(calls + 3);
    expect(MAX_TAKEOVERS).toBe(3);
    expect(await run(db, runId)).toMatchObject({ status: "failed", error: "kept_stopping" });
    expect((await lines(db, runId)).slice(-2)).toEqual(["The coach kept stopping partway through; it's been stopped.", LINES.proposed]);
    const p = (await proposal(db, runId))!;
    expect(p.status).toBe("pending");
    expect(p.flags).toEqual([STOPPED_NOTES.kept_stopping]);
  });

  it("a takeover whose step gets as far as writing starts the count again; the sweep's takeover counts too", async () => {
    const { db, box } = dyingDb();
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const { deps } = scripted([...[1, 2, 3, 4, 5].map(() => t(use("read_day", {})))]);
    await runStep(db, env, runId, a.userId, NOW, deps); // context
    box.armed = true;
    await expect(runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 1000), deps)).rejects.toThrow();
    // The sweep takes the dead claim back: one takeover.
    const swept = staleLater(new Date(NOW.getTime() + 1000), 1);
    expect((await sweepCoachRuns(db, env, a.userId, swept, deps, { maxSteps: 0 })).reclaimed).toBe(1);
    expect(JSON.parse((await run(db, runId)).state!).takeovers).toBe(1);
    // The next step gets as far as its write: no takeover is left on the run.
    box.armed = false;
    const ok = await runStep(db, env, runId, a.userId, new Date(swept.getTime() + 1000), deps);
    expect(ok.kind === "ok" && ok.result.status).toBe("active");
    expect(JSON.parse((await run(db, runId)).state!).takeovers).toBeUndefined();
  });
});

// ── A15 ────────────────────────────────────────────────────────────────

describe("a rehearsal and the athlete's own run (A15)", () => {
  it("a live rehearsal never blocks the athlete's run, nor is offered as it", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const rehearsal = await nowRun(db, a.userId, { rehearsal: true });
    const created = await createRun(db, a.userId, { scope: { kind: "now" }, request: "Mine." }, NOW);
    expect(created.existing).toBe(false);
    expect(created.run.id).not.toBe(rehearsal);
    expect(created.run.request).toBe("Mine.");
    // A second of the athlete's own is answered with theirs, never the rehearsal.
    const again = await createRun(db, a.userId, { scope: { kind: "now" }, request: "Again." }, NOW);
    expect(again).toMatchObject({ existing: true, run: { id: created.run.id } });
  });

  it("a rehearsal create never answers with the athlete's live run: it starts its own, one at a time", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const mine = await nowRun(db, a.userId);
    const rehearsal = await createRun(db, a.userId, { scope: { kind: "now" }, request: "A scenario.", rehearsal: true }, NOW);
    expect(rehearsal.existing).toBe(false);
    expect(rehearsal.run.id).not.toBe(mine);
    const second = await createRun(db, a.userId, { scope: { kind: "now" }, request: "Another.", rehearsal: true }, NOW);
    expect(second).toMatchObject({ existing: true, run: { id: rehearsal.run.id } });
    // The athlete's own create is answered with their run — never the rehearsal, the newer of the two.
    const mineAgain = await createRun(db, a.userId, { scope: { kind: "now" }, request: "Mine again." }, NOW);
    expect(mineAgain).toMatchObject({ existing: true, run: { id: mine } });
    await cancelRun(db, a.userId, rehearsal.run.id, NOW);
    expect((await run(db, mine)).status).toBe("active");
  });
});

// ── A17 ────────────────────────────────────────────────────────────────

describe("a finish that died after making its proposal pending (A17)", () => {
  it("the next step finishes the run with the finish's line — no model call, the proposal as it was", async () => {
    let armed = false;
    const db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (armed && RUN_WRITE.test(text)) throw new Error("the invocation was killed");
      },
    });
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(finish("A calm half hour."))]);
    for (let i = 0; i < 5; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps); // to the resume
    armed = true;
    const died = new Date(NOW.getTime() + 10_000);
    await expect(runStep(db, env, runId, a.userId, died, deps)).rejects.toThrow();
    armed = false;
    expect((await proposal(db, runId))!.status).toBe("pending");
    expect((await run(db, runId)).status).toBe("stepping");
    const calls = requests.length;
    const out = await runStep(db, env, runId, a.userId, staleLater(died, 1), deps);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    expect(requests.length).toBe(calls);
    expect(await run(db, runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    expect((await lines(db, runId)).at(-1)).toBe(LINES.finished);
    expect((await proposal(db, runId))!.status).toBe("pending");
    const [reviewers] = await db
      .select()
      .from(schema.coachRuns)
      .where(and(eq(schema.coachRuns.parentId, runId), eq(schema.coachRuns.role, "reviewer")));
    expect(reviewers!.status).toBe("finished");
  });

  it("a proposal the athlete already approved counts as promoted too (round 2, A-M4): finished, no model call, the approval as it was", async () => {
    let armed = false;
    const db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (armed && RUN_WRITE.test(text)) throw new Error("the invocation was killed");
      },
    });
    const a = await seedRichAthlete(db);
    const runId = await nowRun(db, a.userId);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(finish("A calm half hour."))]);
    for (let i = 0; i < 5; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps); // to the resume
    armed = true;
    const died = new Date(NOW.getTime() + 10_000);
    await expect(runStep(db, env, runId, a.userId, died, deps)).rejects.toThrow();
    armed = false;
    // The athlete saw it pending and approved it before the dead step's claim went stale.
    await db.update(schema.coachProposals).set({ status: "approved" }).where(eq(schema.coachProposals.id, designProposalId(runId)));
    const calls = requests.length;
    const out = await runStep(db, env, runId, a.userId, staleLater(died, 1), deps);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    expect(requests.length).toBe(calls);
    expect(await run(db, runId)).toMatchObject({ status: "finished", error: null });
    expect((await lines(db, runId)).at(-1)).toBe(LINES.finished);
    expect((await proposal(db, runId))!.status).toBe("approved");
  });
});

// ── Round 2, A-M8: the sweep's expiries, counted ──────────────────────────

describe("the sweep expiring an athlete's two live trees (round 2, A-M8)", () => {
  it("their own and a rehearsal's, both past their window: one read, then each tree at most its declared cost — the athlete's at it exactly", async () => {
    let statements = 0;
    let injecting = false;
    let race: string | null = null;
    const db: Db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (injecting) return;
        statements += 1;
        if (race && text.includes("SET status = 'pending', ops =")) {
          // A late verdict lands between the promote's read and its write: the promote reads again (A-M3).
          injecting = true;
          (db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
            .prepare("UPDATE coach_proposals SET ops = json_set(ops, '$[0].review.note', 'late') WHERE id = ?")
            .run(race);
          injecting = false;
          race = null;
        }
      },
    });
    const a = await seedRichAthlete(db);
    const ask = () => use("ask_athlete", { questions: [{ text: "Gym or home?", chips: ["Gym", "Home"], why: "Sets the gear." }] });
    // Each: a reviewed workout for tomorrow, then a question the athlete never answers.
    const mine = await nowRun(db, a.userId);
    const rehearsal = await nowRun(db, a.userId, { rehearsal: true });
    for (const id of [mine, rehearsal]) {
      const { deps } = scripted([t(propose("Calm hips", day(-1))), t(submit(verdict(4))), t(ask())]);
      for (let i = 0; i < 6; i++) await runStep(db, env, id, a.userId, new Date(NOW.getTime() + i * 1000), deps);
      expect((await run(db, id)).status).toBe("waiting_athlete");
    }
    race = designProposalId(mine);
    statements = 0;
    const swept = await sweepCoachRuns(db, env, a.userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps, { maxSteps: 0 });
    expect(swept).toMatchObject({ expired: 2 });
    expect(race).toBeNull();
    // The sweep's read; the athlete's tree — the expiry, the proposal read, the write that lost, the read again, the
    // write, the older plans superseded, the line — at its declared cost; the rehearsal's — the expiry, the proposal read
    // (a rehearsal's is never proposed), the close, the line.
    expect(EXPIRE_TREE_STATEMENTS).toBe(7);
    expect(statements).toBe(1 + EXPIRE_TREE_STATEMENTS + 4);
    expect((await proposal(db, mine))!).toMatchObject({ status: "pending" });
    expect((await proposal(db, rehearsal))!.status).toBe("rehearsal");
    for (const id of [mine, rehearsal]) expect((await run(db, id)).status).toBe("expired");
  });
});
