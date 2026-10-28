/**
 * A FIT ENDS WHEN ITS RUN ENDS (workout editability §7). "Fit them in" stamps the batch's `fit_started_at` before the app
 * creates the fit's run; the run's card of the moves in rotation naming the batch ends the fit with it (approved: fitted
 * in; any other ending: released). A fit run that ends without such a card open — it answered in words, proposed
 * workouts alone, stopped, was cancelled, or expired — hands its batch back at once, in one statement, rather than
 * reading "Fitting in…" for FIT_STARTED_TTL_MS:
 *
 *  - in the run's own end write (finished; failed; stopped), after "propose what it has" had its chance;
 *  - in `cancelRun`, for the main run it cancelled;
 *  - in the expiry (`expireTree`: the sweep's, a step's, an answer's, a create's), proposed or not — within
 *    EXPIRE_TREE_STATEMENTS, counted.
 *
 * Never a newer fit's (one stamped after the run was made), never a batch a plain run never named, never a batch fitted
 * in. The real registry and opening context, a scripted model. No key, no network. Synthetic data only: the made-up
 * athlete of design-read-fixture.ts, on its fixed clock.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { cancelRun, createRun, EXPIRE_TREE_STATEMENTS, runStep, sweepCoachRuns, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_fr${++seq}`, name, input });
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

function scripted(turns: MessagesResult[]) {
  const deps: RunDeps = {
    callModel: async (_env, _req: MessagesRequest) => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps };
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
const ask = () => use("ask_athlete", { questions: [{ text: "Gym or home?", chips: ["Gym", "Home"], why: "Sets the gear." }] });
/** A card of the moves in rotation for the fit's own batch (pin_moves names none: the run's), its lines alone. */
const pinsCard = () => use("pin_moves", { title: "Your saved moves", lines: [{ text: "Nothing new to add this week." }], why: "They are already in what you do." });

/** When "Fit them in" stamped the batch: a moment before the app made the run (`fitBatch` answers first). */
const FIT_AT = new Date(NOW.getTime() - 2_000).toISOString();
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

/** A saved batch of the athlete's, its fit begun at FIT_AT. */
async function savedBatch(db: Db, userId: string) {
  const id = "batch-fr-1";
  await db.insert(schema.saveBatches).values({ id, userId, status: "saved", createdAt: at(-3 * 86_400).toISOString(), savedAt: FIT_AT, fitStartedAt: FIT_AT });
  return id;
}
const fitOf = async (db: Db, id: string) => (await db.select().from(schema.saveBatches).where(eq(schema.saveBatches.id, id)))[0]!.fitStartedAt;
const runOf = async (db: Db, id: string) => (await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id)))[0]!;
const proposalOf = async (db: Db, runId: string) =>
  (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId))))[0];

/** The fit's run, as the app creates it once `/fit` answered: the request with the batch. */
const fitRun = async (db: Db, userId: string, savesBatchId?: string) =>
  (await createRun(db, userId, { scope: { kind: "now" }, request: "Fit my saved moves in.", ...(savesBatchId ? { savesBatchId } : {}) }, NOW)).run.id;

/** Step the run from `from` seconds on until it is over (or `max` steps). */
async function drive(db: Db, userId: string, runId: string, deps: RunDeps, from = 0, max = 12) {
  for (let i = 0; i < max; i++) {
    const out = await runStep(db, env, runId, userId, at(from + i), deps);
    if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
    if (!["active", "stepping", "waiting_review", "waiting_set"].includes(out.result.status)) return out.result.status;
  }
  throw new Error("the run never stopped");
}

describe("a fit run that ends hands its batch back unless its card naming the batch is open (§7)", () => {
  it("a fit run ending in words releases the batch (fit_started_at null)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(finish("Those moves are already in your week — nothing to add today."))]);
    expect(await drive(db, a.userId, runId, deps)).toBe("finished");
    expect(await runOf(db, runId)).toMatchObject({ status: "finished", proposalId: null });
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("one ending with a pending proposal of workouts alone (no card naming the batch) releases it too: nothing of it marks the batch", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(finish("A calm half hour with two of your moves."))]);
    expect(await drive(db, a.userId, runId, deps)).toBe("finished");
    expect(await runOf(db, runId)).toMatchObject({ status: "finished", proposalId: designProposalId(runId) });
    expect((await proposalOf(db, runId))!.status).toBe("pending");
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("one ending with a pending card of the moves in rotation naming the batch does not: the card holds the fit", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(pinsCard()), t(finish("Your saved moves, as a card."))]);
    expect(await drive(db, a.userId, runId, deps)).toBe("finished");
    const p = (await proposalOf(db, runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops).toEqual([expect.objectContaining({ kind: "move_pins", batchId })]);
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
  });

  it("a fit run that fails (no proposal to make of it) releases the batch", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    // The model refuses: the run fails with nothing reviewed to propose.
    const { deps } = scripted([{ ...turn([], "I can't help with that."), stopReason: "refusal" }]);
    expect(await drive(db, a.userId, runId, deps)).toBe("failed");
    expect(await proposalOf(db, runId)).toBeUndefined();
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("cancelled: released", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(ask())]);
    expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
    await cancelRun(db, a.userId, runId, at(30));
    expect((await runOf(db, runId)).status).toBe("cancelled");
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("a cancel of what was left live under a main run already over hands nothing back: the main run's own end did", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    // A draft, its reviewer at work under the main run.
    const { deps } = scripted([t(propose("Calm hips"))]);
    await runStep(db, env, runId, a.userId, at(0), deps); // context
    await runStep(db, env, runId, a.userId, at(1), deps); // draft, reviewer started
    const [reviewer] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.parentId, runId));
    expect(reviewer!.status).toBe("active");
    // The main run over already, set here directly (its own end, which hands a fit back, is not what is under test): the
    // batch still holds the run's fit, and a cancel of what was left live under it must not hand that back.
    await db.update(schema.coachRuns).set({ status: "finished", finishedAt: at(2).toISOString() }).where(eq(schema.coachRuns.id, runId));
    await cancelRun(db, a.userId, runId, at(30));
    expect((await runOf(db, reviewer!.id)).status).toBe("cancelled");
    expect((await runOf(db, runId)).status).toBe("finished");
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
  });

  it("cancelled while its card naming the batch is open (a finish made it pending, then died before the run's write): not released; a proposal of workouts alone: released", async () => {
    for (const [script, kept] of [
      [() => [t(pinsCard()), t(ask())], true],
      [() => [t(propose("Calm hips")), t(submit(verdict(4))), t(ask())], false],
    ] as const) {
      const db = makeTestDb({ boundVariableCap: 100 });
      const a = await seedRichAthlete(db);
      const batchId = await savedBatch(db, a.userId);
      const runId = await fitRun(db, a.userId, batchId);
      const { deps } = scripted(script());
      expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
      await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, designProposalId(runId)));
      await cancelRun(db, a.userId, runId, at(30));
      expect((await runOf(db, runId)).status).toBe("cancelled");
      expect(await fitOf(db, batchId)).toBe(kept ? FIT_AT : null);
    }
  });

  it("expired by the sweep: released", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(ask())]);
    expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
    const swept = await sweepCoachRuns(db, env, a.userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps, { maxSteps: 0 });
    expect(swept).toMatchObject({ expired: 1 });
    expect((await runOf(db, runId)).status).toBe("expired");
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("expired by the sweep proposing workouts alone: released — nothing of that card marks the batch", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    // A reviewed workout for tomorrow, then a question the athlete never answers.
    const { deps } = scripted([t(propose("Calm hips", day(-1))), t(submit(verdict(4))), t(ask())]);
    expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
    await sweepCoachRuns(db, env, a.userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps, { maxSteps: 0 });
    expect((await runOf(db, runId)).status).toBe("expired");
    expect((await proposalOf(db, runId))!.status).toBe("pending");
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("expired by the sweep proposing a card naming the batch, its first write lost and an older card superseded: kept — the tree at exactly EXPIRE_TREE_STATEMENTS (9)", async () => {
    let statements = 0;
    let injecting = false;
    let raceOn: string | null = null;
    const db: Db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (injecting) return;
        statements += 1;
        if (raceOn && text.includes("SET status = 'pending', ops =")) {
          // A late verdict lands between the promote's read and its write: it reads again (A-M3).
          injecting = true;
          (db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
            .prepare("UPDATE coach_proposals SET ops = json_set(ops, '$[0].review.note', 'late') WHERE id = ?")
            .run(raceOn);
          injecting = false;
          raceOn = null;
        }
      },
    });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(propose("Calm hips", day(-1))), t(submit(verdict(4))), t(ask())]);
    expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
    // Beside its reviewed workout, the run's card of the moves in rotation naming its batch (a day still ahead) — and an
    // older card, pending, pinning the same move for another batch whose fit began before it: superseded, its fit
    // released (supersedeOlderPlans). Synthetic ids.
    const pins = (id: string, batch: string) => ({
      kind: "move_pins", id, pin: ["gobletSquat"], unpin: [], batchId: batch, why: "w", title: "t", summary: "s", lines: [],
      date: "2999-01-01", toolUseId: `u-${id}`, at: at(-30).toISOString(),
    });
    const [row] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
    await db
      .update(schema.coachProposals)
      .set({ ops: [...(row!.ops as unknown[]), pins(`pins-${runId}`, batchId)] })
      .where(eq(schema.coachProposals.id, designProposalId(runId)));
    const other = "batch-fr-older";
    await db.insert(schema.saveBatches).values({ id: other, userId: a.userId, status: "saved", createdAt: at(-90).toISOString(), savedAt: at(-90).toISOString(), fitStartedAt: at(-60).toISOString() });
    await db.insert(schema.coachProposals).values({
      id: "older-card", userId: a.userId, title: "t", evidence: "", rationale: "", flags: [], ops: [pins("pins-older", other)],
      status: "pending", expiresAt: "2999-01-01", createdAt: at(-30).toISOString(),
    });
    raceOn = designProposalId(runId);
    statements = 0;
    const swept = await sweepCoachRuns(db, env, a.userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps, { maxSteps: 0 });
    expect(swept).toMatchObject({ expired: 1 });
    expect(raceOn).toBeNull();
    // The read; the expiry, the proposal read, the write that lost, the read again, the write, the older plans
    // superseded, the superseded card's fit released, the fit's own release (its card open: nothing written), the lines.
    expect(EXPIRE_TREE_STATEMENTS).toBe(9);
    expect(statements).toBe(1 + EXPIRE_TREE_STATEMENTS);
    expect((await proposalOf(db, runId))!.status).toBe("pending");
    expect(await fitOf(db, other)).toBeNull();
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
  });

  it("expired with nothing proposed, its promote losing both tries: the close and the release — the sweep's read, then EXPIRE_TREE_STATEMENTS less the supersede's fit release it never reaches", async () => {
    let statements = 0;
    let injecting = false;
    let races = 0;
    let raceOn: string | null = null;
    const db: Db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (injecting) return;
        statements += 1;
        if (raceOn && races < 2 && text.includes("SET status = 'pending', ops =")) {
          // A late verdict lands between each of the promote's reads and its write: both tries lose (A-M3), so the
          // expiry proposes nothing — and closes, releases, and says so.
          races += 1;
          injecting = true;
          (db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
            .prepare("UPDATE coach_proposals SET ops = json_set(ops, '$[0].review.note', ?) WHERE id = ?")
            .run(`late ${races}`, raceOn);
          injecting = false;
        }
      },
    });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    const { deps } = scripted([t(propose("Calm hips", day(-1))), t(submit(verdict(4))), t(ask())]);
    expect(await drive(db, a.userId, runId, deps)).toBe("waiting_athlete");
    raceOn = designProposalId(runId);
    statements = 0;
    const swept = await sweepCoachRuns(db, env, a.userId, new Date(NOW.getTime() + 25 * 3_600_000), scripted([]).deps, { maxSteps: 0 });
    expect(swept).toMatchObject({ expired: 1 });
    expect(races).toBe(2);
    // The read; the expiry, the proposal read, the write that lost, the read again, the write that lost, the close, the
    // release, the lines.
    expect(statements).toBe(1 + EXPIRE_TREE_STATEMENTS - 1);
    expect((await proposalOf(db, runId))!.status).toBe("expired");
    expect(await fitOf(db, batchId)).toBeNull();
  });

  it("a fit started after the run (a newer fit) is not released", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    // The batch's fit begun again after the run was made: a newer fit's, never this run's to end.
    const newer = at(1).toISOString();
    await db.update(schema.saveBatches).set({ fitStartedAt: newer }).where(eq(schema.saveBatches.id, batchId));
    const { deps } = scripted([t(finish("Nothing to add today."))]);
    expect(await drive(db, a.userId, runId, deps, 2)).toBe("finished");
    expect(await fitOf(db, batchId)).toBe(newer);
  });

  it("a run that fits no batch touches none: a plain run ending in words leaves a fitting batch as it is", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId);
    const { deps } = scripted([t(finish("Rest today."))]);
    expect(await drive(db, a.userId, runId, deps)).toBe("finished");
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
  });

  it("a batch fitted in meanwhile keeps its stamps", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const a = await seedRichAthlete(db);
    const batchId = await savedBatch(db, a.userId);
    const runId = await fitRun(db, a.userId, batchId);
    // Fitted in (an earlier card approved) while the run was at work: its stamps are the approve's.
    await db.update(schema.saveBatches).set({ fittedAt: at(1).toISOString() }).where(eq(schema.saveBatches.id, batchId));
    const { deps } = scripted([t(finish("Already done."))]);
    expect(await drive(db, a.userId, runId, deps, 2)).toBe("finished");
    expect(await fitOf(db, batchId)).toBe(FIT_AT);
  });
});
